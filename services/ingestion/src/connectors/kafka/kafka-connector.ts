/**
 * Kafka streaming connector — built-in, NOT an isolated-vm plugin.
 *
 * This module contains:
 *   - parseKafkaConfig()     — validates raw config and produces KafkaConnectorConfig
 *   - MockKafkaConnector     — in-process mock that simulates message production
 *                             for unit tests and CI without a real Kafka broker
 *
 * Production integration note:
 *   A real Kafka connector would import kafkajs (or a similar client) and
 *   implement subscribe() by calling consumer.run(). We deliberately exclude
 *   external Kafka libraries to avoid infrastructure dependencies in the
 *   ingestion service. When adding real Kafka support, replace MockKafkaConnector
 *   with a concrete implementation; parseKafkaConfig() and the types remain stable.
 *
 * Mock message simulation:
 *   MockKafkaConnector.subscribe() yields synthetic StreamMessage values at a
 *   configurable rate. The mock tracks acknowledged offsets so the consumer lag
 *   returned by getConsumerStatus() reflects unacknowledged messages accurately.
 *   This lets the streaming ingestion service and its tests exercise the full
 *   batching, offset-tracking, and back-pressure logic without broker access.
 */

import type {
  StreamingConnector,
  StreamOptions,
  StreamMessage,
  ConsumerStatus,
} from "@oneplatform/plugin-sdk";
import type { PluginContext } from "@oneplatform/plugin-sdk";
import type { KafkaConnectorConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

/**
 * Validate and coerce the connector config record into a typed KafkaConnectorConfig.
 * Throws with a human-readable message identifying the first invalid field.
 */
export function parseKafkaConfig(config: Record<string, unknown>): KafkaConnectorConfig {
  // brokers may arrive as a comma-separated string or as an array
  let brokers: string[];
  if (typeof config["brokers"] === "string" && config["brokers"].trim() !== "") {
    brokers = config["brokers"].split(",").map((b) => b.trim()).filter((b) => b.length > 0);
  } else if (Array.isArray(config["brokers"]) && config["brokers"].length > 0) {
    brokers = (config["brokers"] as unknown[]).map((b) => String(b).trim());
  } else {
    throw new Error(
      'Kafka connector: required config field "brokers" must be a non-empty comma-separated ' +
      'string or an array of "host:port" addresses.',
    );
  }

  if (brokers.length === 0) {
    throw new Error('Kafka connector: "brokers" must contain at least one broker address.');
  }

  const clientId =
    typeof config["clientId"] === "string" && config["clientId"].trim() !== ""
      ? config["clientId"]
      : "oneplatform-ingestion";

  const connectionTimeoutMs =
    typeof config["connectionTimeoutMs"] === "number" && config["connectionTimeoutMs"] > 0
      ? config["connectionTimeoutMs"]
      : 10_000;

  const requestTimeoutMs =
    typeof config["requestTimeoutMs"] === "number" && config["requestTimeoutMs"] > 0
      ? config["requestTimeoutMs"]
      : 30_000;

  const parsed: KafkaConnectorConfig = {
    brokers,
    clientId,
    connectionTimeoutMs,
    requestTimeoutMs,
  };

  // SASL validation — only attach if the raw config includes the block
  if (config["sasl"] !== undefined && config["sasl"] !== null) {
    const saslRaw = config["sasl"] as Record<string, unknown>;
    const mechanism = saslRaw["mechanism"];

    if (
      mechanism !== "PLAIN" &&
      mechanism !== "SCRAM-SHA-256" &&
      mechanism !== "SCRAM-SHA-512"
    ) {
      throw new Error(
        'Kafka connector: sasl.mechanism must be one of "PLAIN", "SCRAM-SHA-256", or "SCRAM-SHA-512".',
      );
    }

    if (typeof saslRaw["username"] !== "string" || saslRaw["username"] === "") {
      throw new Error('Kafka connector: sasl.username is required when sasl is configured.');
    }
    if (typeof saslRaw["password"] !== "string" || saslRaw["password"] === "") {
      throw new Error('Kafka connector: sasl.password is required when sasl is configured.');
    }

    parsed.sasl = {
      mechanism: mechanism as KafkaConnectorConfig["sasl"] extends { mechanism: infer M } ? M : never,
      username: saslRaw["username"] as string,
      password: saslRaw["password"] as string,
    };
  }

  // TLS validation
  if (config["tls"] !== undefined && config["tls"] !== null) {
    const tlsRaw = config["tls"] as Record<string, unknown>;
    parsed.tls = {
      ...(typeof tlsRaw["rejectUnauthorized"] === "boolean"
        ? { rejectUnauthorized: tlsRaw["rejectUnauthorized"] }
        : {}),
      ...(typeof tlsRaw["ca"] === "string" ? { ca: tlsRaw["ca"] } : {}),
      ...(typeof tlsRaw["cert"] === "string" ? { cert: tlsRaw["cert"] } : {}),
      ...(typeof tlsRaw["key"] === "string" ? { key: tlsRaw["key"] } : {}),
    };
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// MockKafkaConnector
//
// Simulates Kafka message production for unit tests and development environments.
// subscribe() yields messages from a pre-configured generator function so tests
// can inject arbitrary event sequences without a real broker.
//
// Offset model:
//   Each message gets an offset = messagesProduced counter value, formatted as
//   a decimal string to mirror Kafka's actual offset encoding. The connector
//   tracks the highest acknowledged offset per topic-partition for lag reporting.
// ---------------------------------------------------------------------------

/** Minimum interface for the message generator injected by tests. */
export type MockMessageGenerator = (
  topics: string[],
  signal: AbortSignal,
) => AsyncIterable<StreamMessage>;

/**
 * Default generator — emits a finite sequence of synthetic messages, one per
 * topic, then returns. Used when MockKafkaConnector is constructed without an
 * explicit generator (e.g. in registry-level integration tests that just need
 * the connector to be runnable without hanging forever).
 */
async function* defaultGenerator(
  topics: string[],
  _signal: AbortSignal,
): AsyncIterable<StreamMessage> {
  let seq = 0;
  for (const topic of topics) {
    seq += 1;
    yield {
      id: `${topic}:0:${seq}`,
      topic,
      partition: 0,
      offset: String(seq),
      key: `key-${seq}`,
      value: { _mock: true, seq, topic },
      timestamp: new Date().toISOString(),
      headers: { "x-mock": "true" },
    };
  }
}

export class MockKafkaConnector implements StreamingConnector {
  readonly type = "streaming" as const;

  private readonly config: KafkaConnectorConfig;
  private readonly generator: MockMessageGenerator;

  // Per-message-id acknowledged set, keyed by messageId.
  // Used to compute per-topic lag in getConsumerStatus().
  private acknowledged = new Set<string>();

  // Running count of messages produced by the generator since subscribe() was called.
  private messagesProduced = 0;
  private messagesConsumed = 0;

  // AbortController that signals the subscriber loop to stop.
  private stopController: AbortController | null = null;

  // Topics from the most recent subscribe() call, retained for status reporting.
  private activeTopics: string[] = [];

  constructor(config: KafkaConnectorConfig, generator?: MockMessageGenerator) {
    this.config = config;
    this.generator = generator ?? defaultGenerator;
  }

  /**
   * Open a mock consumer subscription.
   *
   * Yields StreamMessage values from the injected generator. The caller's
   * batching loop controls consumption pace; back-pressure is inherent in the
   * async generator protocol (the next value is only produced when the caller
   * calls next(), so the generator never runs ahead of the consumer).
   */
  subscribe(
    _context: PluginContext,
    options: StreamOptions,
  ): AsyncIterable<StreamMessage> {
    if (options.topics.length === 0) {
      throw new Error("Kafka connector: subscribe() requires at least one topic.");
    }
    if (options.groupId.trim() === "") {
      throw new Error("Kafka connector: subscribe() requires a non-empty groupId.");
    }

    this.activeTopics = options.topics;
    this.stopController = new AbortController();
    const { signal } = this.stopController;

    // Capture `this` refs so the generator closure can update them.
    const connector = this;
    const underlyingGenerator = this.generator;

    async function* streamIterator(): AsyncIterable<StreamMessage> {
      for await (const msg of underlyingGenerator(options.topics, signal)) {
        if (signal.aborted) return;
        connector.messagesProduced += 1;
        connector.messagesConsumed += 1;
        yield msg;
      }
    }

    return streamIterator();
  }

  /**
   * Acknowledge a batch of message IDs. Updates the internal acknowledged set
   * so lag is computed correctly by getConsumerStatus().
   *
   * This method never throws — a real Kafka commit failure would be logged and
   * retried via the next batch; the service must not crash on an ack failure.
   */
  async acknowledge(messageIds: string[]): Promise<void> {
    for (const id of messageIds) {
      this.acknowledged.add(id);
    }
  }

  /**
   * Return current consumer state. Lag is the count of produced-but-unacknowledged
   * messages per topic, derived from the difference between messagesProduced and
   * acknowledged.size.
   *
   * A real Kafka implementation would query the broker for the topic high-water
   * mark and subtract the committed offset to compute lag.
   */
  async getConsumerStatus(): Promise<ConsumerStatus> {
    const unacknowledged = this.messagesProduced - this.acknowledged.size;

    // Distribute lag evenly across subscribed topics for mock purposes.
    // A real implementation would report per-partition lag from the broker.
    const lagPerTopic = this.activeTopics.length > 0
      ? Math.floor(unacknowledged / this.activeTopics.length)
      : 0;

    const lag: Record<string, number> = {};
    for (const topic of this.activeTopics) {
      lag[topic] = lagPerTopic;
    }

    return {
      connected: this.stopController !== null && !this.stopController.signal.aborted,
      topics: [...this.activeTopics],
      lag,
      messagesConsumed: this.messagesConsumed,
    };
  }

  /**
   * Stop the subscriber loop by aborting the AbortController that was handed
   * to the generator. The generator checks signal.aborted between yields and
   * returns cleanly when it is set.
   */
  stopSubscription(): void {
    if (this.stopController !== null) {
      this.stopController.abort();
      this.stopController = null;
    }
  }

  /** Expose config for testing assertions. */
  getConfig(): KafkaConnectorConfig {
    return this.config;
  }
}
