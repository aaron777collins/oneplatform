/**
 * StreamingIngestionService — orchestrates message-broker streaming connectors.
 *
 * Responsibilities:
 *   - Start and stop streaming consumers for individual connectors
 *   - Batch incoming StreamMessage values and write them to the raw table
 *   - Track committed offsets (cursor) for resumability across restarts
 *   - Publish consumer status to Redis for the API status endpoint
 *   - Apply back-pressure by limiting in-flight batch jobs
 *   - Handle connection drops with exponential backoff reconnection
 *
 * Back-pressure model:
 *   The streaming consumer loop tracks how many messages are buffered but not
 *   yet acknowledged. When the in-flight count exceeds BACK_PRESSURE_THRESHOLD,
 *   the loop pauses (yields the CPU without consuming) until the pending write
 *   completes. This prevents unbounded memory growth on bursty topics.
 *
 * Offset resumability:
 *   After a durable raw-table write, the service calls acknowledge() to commit
 *   the offsets to the broker AND writes the last message's ID to
 *   sync_state.last_cursor. On restart, startStream() reads last_cursor and
 *   passes it as startOffset so at-least-once delivery is preserved with
 *   duplicates bounded to the last uncommitted batch (which the raw table
 *   upsert deduplicates by _id).
 *
 * Error isolation:
 *   Each connector stream runs in its own async loop. A fatal error in one
 *   stream does not affect others. The service retries with exponential backoff
 *   up to MAX_RECONNECT_ATTEMPTS before marking the stream as "error".
 */

import type { Redis } from "ioredis";
import type { Logger } from "@oneplatform/core";
import type { StreamingConnector, StreamMessage, StreamOptions } from "@oneplatform/plugin-sdk";
import type { ConnectorRepository, SyncStateRepository } from "./connector-service.js";
import type { RawTableRepository } from "./sync-service.js";
import { normalizeToEnvelope } from "../utils/data-envelope.js";
import { ConnectorNotFoundError } from "./errors.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type StreamStatus = "running" | "stopped" | "error" | "reconnecting";

export interface StreamConsumerStatus {
  connectorId: string;
  status: StreamStatus;
  /** Topics currently subscribed to. */
  topics: string[];
  /**
   * Per-topic consumer lag (messages behind the head of the topic).
   * Keys are topic names; values are unacknowledged message counts.
   */
  lag: Record<string, number>;
  /** Total messages consumed since the stream was started. */
  messagesConsumed: number;
  /** ISO 8601 timestamp when the stream was started. Null if never started. */
  startedAt: string | null;
  /** ISO 8601 timestamp of the last committed batch. Null if no batch written yet. */
  lastCommittedAt: string | null;
  /** Most recent error message. Null if the stream has not errored. */
  lastError: string | null;
}

export interface StartStreamOptions {
  /** Topics to subscribe to. Must contain at least one entry. */
  topics: string[];
  /** Consumer group identifier. Defaults to "oneplatform-{connectorId}". */
  groupId?: string;
  /**
   * Where to start consuming when no committed offset exists for this group.
   * "earliest" | "latest" | a connector-specific cursor string.
   * When omitted the service reads last_cursor from sync_state and falls back
   * to "earliest" if no prior cursor exists.
   */
  startOffset?: "earliest" | "latest" | string;
  /** Messages per batch. 1–10 000. Default: 100. */
  maxBatchSize?: number;
  /** Max ms to wait for a full batch before flushing a partial one. Default: 1000. */
  maxWaitMs?: number;
}

export interface StreamingIngestionService {
  startStream(
    connectorId: string,
    tenantId: string,
    connector: StreamingConnector,
    options: StartStreamOptions,
  ): Promise<void>;
  stopStream(connectorId: string): Promise<void>;
  getStreamStatus(connectorId: string): Promise<StreamConsumerStatus | null>;
}

export interface StreamingIngestionServiceDeps {
  connectorRepo: ConnectorRepository;
  syncStateRepo: SyncStateRepository;
  rawTableRepo: RawTableRepository;
  redis: Redis;
  logger: Logger;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum reconnection attempts before marking the stream as "error". */
const MAX_RECONNECT_ATTEMPTS = 5;

/** Base delay for exponential backoff between reconnection attempts. */
const RECONNECT_BASE_DELAY_MS = 2_000;

/**
 * Maximum number of messages buffered by the loop before back-pressure kicks in.
 * When the buffer exceeds this value, the loop stops pulling from the connector
 * until the current batch is durably written and acknowledged.
 *
 * At 1 KB per message average, 1 000 messages ≈ 1 MB of in-process memory.
 * This is intentionally conservative to stay well under the 1 MB BullMQ payload
 * limit used by the batch sync system.
 */
const BACK_PRESSURE_THRESHOLD = 1_000;

/** Redis key prefix for streaming consumer status objects. */
const STREAM_STATUS_KEY_PREFIX = "ingestion:stream:status:";

/** TTL for stream status keys once a stream is stopped or in error state. */
const STREAM_STATUS_TERMINAL_TTL_SECONDS = 86_400; // 24 hours

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface ActiveStream {
  connector: StreamingConnector;
  tenantId: string;
  status: StreamConsumerStatus;
  abort: AbortController;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createStreamingIngestionService(
  deps: StreamingIngestionServiceDeps,
): StreamingIngestionService {
  const { connectorRepo, syncStateRepo, rawTableRepo, redis, logger } = deps;

  // Map from connectorId -> active stream state.
  const activeStreams = new Map<string, ActiveStream>();

  // ---------------------------------------------------------------------------
  // Status persistence helpers
  // ---------------------------------------------------------------------------

  async function writeStatus(status: StreamConsumerStatus): Promise<void> {
    const key = `${STREAM_STATUS_KEY_PREFIX}${status.connectorId}`;
    const isTerminal = status.status === "stopped" || status.status === "error";

    if (isTerminal) {
      await redis.set(key, JSON.stringify(status), "EX", STREAM_STATUS_TERMINAL_TTL_SECONDS);
    } else {
      await redis.set(key, JSON.stringify(status));
    }
  }

  async function readStatus(connectorId: string): Promise<StreamConsumerStatus | null> {
    const raw = await redis.get(`${STREAM_STATUS_KEY_PREFIX}${connectorId}`);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as StreamConsumerStatus;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Batch flush
  //
  // Converts StreamMessage values to DataEnvelopes and writes them to the raw
  // table in a single insert. Then acknowledges with the broker and persists
  // the last message's ID as the resumable cursor.
  // ---------------------------------------------------------------------------

  async function flushBatch(
    connectorId: string,
    tenantId: string,
    connectorName: string,
    connector: StreamingConnector,
    messages: StreamMessage[],
    batchId: string,
    stream: ActiveStream,
  ): Promise<void> {
    if (messages.length === 0) return;

    // Idempotent DDL — ensures the raw table exists before first write.
    await rawTableRepo.createRawTable(connectorId);

    // Derive the cursor from the last message's id so the next subscribe() call
    // can resume from exactly this position. We use the message id (not offset)
    // because it is broker-agnostic: "<topic>:<partition>:<offset>" for Kafka,
    // "<sequence>" for NATS.
    const lastMsg = messages[messages.length - 1];
    const cursorValue = lastMsg?.id ?? null;

    const envelopes = messages.map((msg) => {
      // sourceId encodes the full message identity so replaying the same
      // broker offset produces the same envelope _id (idempotent upsert).
      const sourceId = msg.id;

      const data: Record<string, unknown> = {
        _stream_topic: msg.topic,
        _stream_id: msg.id,
        _stream_timestamp: msg.timestamp,
        ...(msg.partition !== undefined ? { _stream_partition: msg.partition } : {}),
        ...(msg.offset !== undefined ? { _stream_offset: msg.offset } : {}),
        ...(msg.key !== undefined ? { _stream_key: msg.key } : {}),
        ...(msg.headers !== undefined && Object.keys(msg.headers).length > 0
          ? { _stream_headers: msg.headers }
          : {}),
        ...msg.value,
      };

      return normalizeToEnvelope(
        { sourceId, data },
        {
          connectorId,
          connectorName,
          batchId,
          tenantId,
          syncMode: "incremental",
          cursor: cursorValue,
        },
      );
    });

    await rawTableRepo.insertBatch(connectorId, envelopes);

    // Acknowledge offsets to the broker so it can advance the committed position.
    // This call must not be awaited with a re-thrown error — a commit failure is
    // non-fatal (the batch is already durable in the raw table; the next flush
    // will re-acknowledge the same offsets).
    await connector.acknowledge(messages.map((m) => m.id)).catch((ackErr: unknown) => {
      logger.error("Streaming connector: acknowledge() failed (non-fatal)", {
        connectorId,
        batchSize: messages.length,
        error: ackErr instanceof Error ? ackErr.message : String(ackErr),
      });
    });

    // Persist the cursor so the stream can resume without re-reading old messages.
    if (cursorValue !== null) {
      await syncStateRepo.updateCursor(connectorId, cursorValue);
    }

    // Update in-memory and Redis status.
    stream.status.lastCommittedAt = new Date().toISOString();
    stream.status.messagesConsumed += messages.length;
    await writeStatus(stream.status);
  }

  // ---------------------------------------------------------------------------
  // Stream loop with reconnection
  // ---------------------------------------------------------------------------

  async function runStreamLoop(
    connectorId: string,
    tenantId: string,
    streamOptions: StreamOptions,
    stream: ActiveStream,
  ): Promise<void> {
    let attempt = 0;

    while (!stream.abort.signal.aborted && attempt <= MAX_RECONNECT_ATTEMPTS) {
      if (attempt > 0) {
        const delayMs = RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        logger.warn("Streaming connector: reconnecting", { connectorId, attempt, delayMs });

        stream.status.status = "reconnecting";
        await writeStatus(stream.status);

        // Wait for the backoff delay or until stopStream() signals abort.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delayMs);
          stream.abort.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          });
        });

        if (stream.abort.signal.aborted) break;
      }

      const connector = stream.connector;

      try {
        // Re-read connector config on each attempt so credential rotations
        // during reconnection are picked up automatically.
        const connectorRow = await connectorRepo.findById(connectorId);
        if (connectorRow === null) {
          throw new ConnectorNotFoundError(
            `Connector ${connectorId} not found during stream.`,
            { connectorId, tenantId },
          );
        }

        stream.status.status = "running";
        await writeStatus(stream.status);

        const maxBatchSize = streamOptions.maxBatchSize ?? 100;
        const maxWaitMs = streamOptions.maxWaitMs ?? 1_000;

        const messageBuffer: StreamMessage[] = [];
        let batchId = crypto.randomUUID();
        let batchTimer: ReturnType<typeof setTimeout> | null = null;

        // Flush the current buffer to the raw table. Called either when the
        // buffer reaches maxBatchSize or when the batchTimer fires.
        const flushNow = async (): Promise<void> => {
          if (messageBuffer.length === 0) return;
          const toFlush = messageBuffer.splice(0, messageBuffer.length);
          await flushBatch(
            connectorId,
            tenantId,
            connectorRow.name,
            connector,
            toFlush,
            batchId,
            stream,
          );
          batchId = crypto.randomUUID();
        };

        const resetBatchTimer = (): void => {
          if (batchTimer !== null) clearTimeout(batchTimer);
          batchTimer = setTimeout(() => {
            void flushNow().catch((err: unknown) => {
              logger.error("Streaming connector: batch flush failed", {
                connectorId,
                error: err instanceof Error ? err.message : String(err),
              });
            });
          }, maxWaitMs);
        };

        // Consume the stream. subscribe() returns an AsyncIterable that runs
        // until the connector is stopped or throws a fatal error.
        for await (const msg of connector.subscribe(
          makeMinimalContext(),
          streamOptions,
        )) {
          if (stream.abort.signal.aborted) break;

          // Back-pressure: if the buffer is at the threshold, flush synchronously
          // before accepting the next message. This prevents the generator from
          // running ahead of durable storage during a slow write path.
          if (messageBuffer.length >= BACK_PRESSURE_THRESHOLD) {
            if (batchTimer !== null) {
              clearTimeout(batchTimer);
              batchTimer = null;
            }
            await flushNow();
          }

          messageBuffer.push(msg);
          resetBatchTimer();

          // Flush when the batch is full.
          if (messageBuffer.length >= maxBatchSize) {
            if (batchTimer !== null) {
              clearTimeout(batchTimer);
              batchTimer = null;
            }
            await flushNow();
          }
        }

        // Flush any remaining messages after the iterable finishes.
        if (batchTimer !== null) {
          clearTimeout(batchTimer);
          batchTimer = null;
        }
        await flushNow();

        // Sync final consumer status from the connector before marking stopped.
        try {
          const consumerStatus = await connector.getConsumerStatus();
          stream.status.lag = consumerStatus.lag;
          stream.status.topics = consumerStatus.topics;
        } catch {
          // Non-fatal — status may be stale but the stream itself completed.
        }

        // Clean exit — the abort was requested or the iterable finished naturally.
        break;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("Streaming connector: stream error", { connectorId, attempt, error: message });
        stream.status.lastError = message;
        attempt += 1;

        // ConnectorNotFoundError is non-retryable — the connector was deleted.
        if (err instanceof ConnectorNotFoundError) break;
      }
    }

    // Stream has stopped — either cleanly or after exhausting reconnect attempts.
    stream.status.status = attempt > MAX_RECONNECT_ATTEMPTS ? "error" : "stopped";
    if (attempt > MAX_RECONNECT_ATTEMPTS) {
      stream.status.lastError =
        stream.status.lastError ?? "Max reconnect attempts exceeded";
    }
    await writeStatus(stream.status);
    activeStreams.delete(connectorId);

    logger.info("Streaming connector: stream terminated", {
      connectorId,
      status: stream.status.status,
      messagesConsumed: stream.status.messagesConsumed,
    });
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async function startStream(
    connectorId: string,
    tenantId: string,
    connector: StreamingConnector,
    options: StartStreamOptions,
  ): Promise<void> {
    if (activeStreams.has(connectorId)) {
      logger.warn(
        "Streaming connector: stream already running — ignoring duplicate start request",
        { connectorId },
      );
      return;
    }

    if (options.topics.length === 0) {
      throw new Error(
        `startStream: connector ${connectorId} — topics must contain at least one entry.`,
      );
    }

    const connectorRow = await connectorRepo.findById(connectorId);
    if (connectorRow === null || connectorRow.tenant_id !== tenantId) {
      throw new ConnectorNotFoundError(
        `Connector ${connectorId} not found.`,
        { connectorId, tenantId },
      );
    }

    // Determine the resume offset: explicit option > persisted cursor > "earliest".
    let startOffset = options.startOffset;
    if (startOffset === undefined) {
      const syncState = await syncStateRepo.findByConnectorId(connectorId);
      startOffset = syncState?.last_cursor ?? "earliest";
    }

    const groupId = options.groupId ?? `oneplatform-${connectorId}`;

    const streamOptions: StreamOptions = {
      topics: options.topics,
      groupId,
      startOffset,
      ...(options.maxBatchSize !== undefined ? { maxBatchSize: options.maxBatchSize } : {}),
      ...(options.maxWaitMs !== undefined ? { maxWaitMs: options.maxWaitMs } : {}),
    };

    const abort = new AbortController();

    const status: StreamConsumerStatus = {
      connectorId,
      status: "running",
      topics: options.topics,
      lag: {},
      messagesConsumed: 0,
      startedAt: new Date().toISOString(),
      lastCommittedAt: null,
      lastError: null,
    };

    const activeStream: ActiveStream = { connector, tenantId, status, abort };
    activeStreams.set(connectorId, activeStream);

    await writeStatus(status);
    logger.info("Streaming connector: stream starting", {
      connectorId,
      tenantId,
      topics: options.topics,
      groupId,
      startOffset,
    });

    // Run in background — do not await so the HTTP handler returns immediately.
    void runStreamLoop(connectorId, tenantId, streamOptions, activeStream).catch(
      (err: unknown) => {
        logger.error("Streaming connector: stream loop threw unexpectedly", {
          connectorId,
          error: err instanceof Error ? err.message : String(err),
        });
      },
    );
  }

  async function stopStream(connectorId: string): Promise<void> {
    const stream = activeStreams.get(connectorId);
    if (stream === undefined) {
      logger.warn("Streaming connector: stopStream called with no active stream", {
        connectorId,
      });
      return;
    }

    // Signal the generator loop to stop cleanly.
    stream.abort.abort();

    // If the connector exposes a stop method (e.g. MockKafkaConnector), call it.
    // We check at runtime rather than casting so real connectors that don't
    // expose stopSubscription() still work correctly.
    const stoppable = stream.connector as unknown as {
      stopSubscription?: () => void;
    };
    if (typeof stoppable.stopSubscription === "function") {
      stoppable.stopSubscription();
    }

    logger.info("Streaming connector: stop requested", { connectorId });
  }

  async function getStreamStatus(connectorId: string): Promise<StreamConsumerStatus | null> {
    // Prefer the live in-memory status for an active stream.
    const stream = activeStreams.get(connectorId);
    if (stream !== undefined) {
      // Merge the latest consumer status from the connector for up-to-date lag.
      try {
        const live = await stream.connector.getConsumerStatus();
        return {
          ...stream.status,
          lag: live.lag,
          topics: live.topics,
          messagesConsumed: live.messagesConsumed,
        };
      } catch {
        return { ...stream.status };
      }
    }

    // Fall back to Redis for stopped/errored streams.
    return readStatus(connectorId);
  }

  return { startStream, stopStream, getStreamStatus };
}

// ---------------------------------------------------------------------------
// Minimal PluginContext stub for built-in streaming connectors
//
// Built-in connectors run in-process, not in isolated-vm, so they don't need
// the full sandbox PluginContext. We provide a minimal implementation that
// satisfies the type signature without the sandbox overhead.
// ---------------------------------------------------------------------------

import type { PluginContext } from "@oneplatform/plugin-sdk";

function makeMinimalContext(): PluginContext {
  const noop = (): never => {
    throw new Error("PluginContext method not available in built-in connector context");
  };

  return {
    credentials: { get: noop, list: noop },
    fetch: { fetch: noop },
    cache: { get: noop, set: noop, delete: noop, lock: noop },
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    tenant: {
      tenantId: "",
      tenantName: "",
      config: {},
      instanceId: "",
    },
    ontology: { getSchema: noop, getEntitySchema: noop },
    tracing: {
      injectHeaders: (h) => h,
      startSpan: () => ({ setAttribute: () => {}, end: () => {} }),
    },
  };
}
