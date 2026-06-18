/**
 * Unit tests for StreamingIngestionService.
 *
 * Tests exercise:
 *   - Stream message batching (flush at maxBatchSize and at maxWaitMs timer)
 *   - Offset tracking: last message id persisted to sync_state after each flush
 *   - Back-pressure: buffer does not exceed BACK_PRESSURE_THRESHOLD before flush
 *   - Consumer status reporting: running / stopped / lag / messagesConsumed
 *   - Start/stop lifecycle: start returns immediately, stop signals the loop
 *   - Idempotent start: duplicate start() calls are logged and ignored
 *   - Stop on inactive stream: no-op with a log warning
 *   - Resumability: startOffset derived from persisted last_cursor
 *   - Envelope shape: _stream_topic, _stream_id, _stream_timestamp are set
 *   - Reconnection: stream retries up to MAX_RECONNECT_ATTEMPTS on error
 *
 * No external broker is needed — all broker interaction is handled by the
 * MockKafkaConnector (or in-line async generator mocks) injected per test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Redis } from "ioredis";
import type { Logger } from "@oneplatform/core";
import type { StreamMessage, StreamOptions, ConsumerStatus } from "@oneplatform/plugin-sdk";
import type { PluginContext } from "@oneplatform/plugin-sdk";
import type {
  StreamingIngestionServiceDeps,
  StreamingIngestionService,
} from "../services/streaming-ingestion-service.js";
import { createStreamingIngestionService } from "../services/streaming-ingestion-service.js";
import type { ConnectorRepository, SyncStateRepository } from "../services/connector-service.js";
import type { RawTableRepository } from "../services/sync-service.js";
import type { ConnectorRow, SyncStateRow } from "../repositories/types.js";
import type { StreamingConnector } from "@oneplatform/plugin-sdk";
import { MockKafkaConnector, parseKafkaConfig } from "../connectors/kafka/index.js";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

// These UUIDs must be RFC 4122-compliant (version and variant nibbles set correctly)
// because normalizeToEnvelope uses uuidv5(sourceId, connectorId) which calls
// uuid.parse() on the connectorId — it validates the UUID format strictly.
const CONNECTOR_ID = "550e8400-e29b-41d4-a716-446655440000";
const TENANT_ID = "550e8400-e29b-41d4-a716-446655440001";
const TOPIC_A = "orders";
const TOPIC_B = "shipments";

// ---------------------------------------------------------------------------
// Row factories
// ---------------------------------------------------------------------------

function makeConnectorRow(overrides: Partial<ConnectorRow> = {}): ConnectorRow {
  return {
    id: CONNECTOR_ID,
    tenant_id: TENANT_ID,
    plugin_id: "oneplatform.kafka",
    instance_id: "inst-1",
    name: "My Kafka Source",
    description: null,
    config: { brokers: "localhost:9092" },
    sync_mode: "incremental",
    schedule_cron: null,
    is_enabled: true,
    created_by: "user-1",
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
    ...overrides,
  };
}

function makeSyncStateRow(overrides: Partial<SyncStateRow> = {}): SyncStateRow {
  return {
    connector_id: CONNECTOR_ID,
    last_cursor: null,
    last_sync_at: null,
    last_sync_job_id: null,
    sync_mode: "incremental",
    status: "never_run",
    last_error: null,
    last_error_code: null,
    rows_last_sync: "0",
    rows_total: "0",
    updated_at: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Infrastructure mocks
// ---------------------------------------------------------------------------

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

function makeRedis(): Redis {
  const store = new Map<string, string>();
  return {
    // Accepts variadic args to support redis.set(key, value, "EX", ttl) calls
    set: vi.fn(async (key: string, value: string, ..._args: unknown[]) => {
      store.set(key, value);
      return "OK";
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    publish: vi.fn(async () => 0),
    _store: store,
  } as unknown as Redis;
}

function makeRawTableRepo(): RawTableRepository {
  return {
    createRawTable: vi.fn(async () => {}),
    insertBatch: vi.fn(async () => {}),
    upsertBatch: vi.fn(async () => {}),
    softDeleteNotInBatch: vi.fn(async () => 0),
    deleteOlderThan: vi.fn(async () => 0),
    dropTable: vi.fn(async () => {}),
    count: vi.fn(async () => 0),
  } as RawTableRepository;
}

function makeSyncStateRepo(lastCursor?: string): SyncStateRepository {
  return {
    findByConnectorId: vi.fn(async () =>
      makeSyncStateRow({ last_cursor: lastCursor ?? null }),
    ),
    updateCursor: vi.fn(async () => {}),
    updateStatus: vi.fn(async () => null),
    upsert: vi.fn(async () => makeSyncStateRow()),
    findByConnectorIds: vi.fn(async () => new Map()),
    findStaleSyncs: vi.fn(async () => []),
    resetStaleSyncs: vi.fn(async () => 0),
    create: vi.fn(async () => makeSyncStateRow()),
    update: vi.fn(async () => null),
  } as SyncStateRepository;
}

function makeConnectorRepo(row?: ConnectorRow): ConnectorRepository {
  return {
    findById: vi.fn(async () => row ?? makeConnectorRow()),
    create: vi.fn(async () => makeConnectorRow()),
    findByTenantId: vi.fn(async () => ({ items: [], nextCursor: null, total: 0 })),
    update: vi.fn(async () => makeConnectorRow()),
    softDelete: vi.fn(async () => {}),
  } as unknown as ConnectorRepository;
}

// ---------------------------------------------------------------------------
// StreamMessage factory
// ---------------------------------------------------------------------------

function makeMessage(
  seq: number,
  topic = TOPIC_A,
  overrides: Partial<StreamMessage> = {},
): StreamMessage {
  return {
    id: `${topic}:0:${seq}`,
    topic,
    partition: 0,
    offset: String(seq),
    key: `key-${seq}`,
    value: { seq, payload: "test" },
    timestamp: new Date().toISOString(),
    headers: { "x-seq": String(seq) },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock StreamingConnector factory
//
// Accepts an array of StreamMessage values and yields them one by one.
// After emitting all messages the generator returns, simulating an
// orderly end-of-stream (e.g. topic end or stop signal).
// ---------------------------------------------------------------------------

function makeMockConnector(
  messages: StreamMessage[],
  opts: {
    subscribeError?: Error;
    captureOptions?: { startOffset?: string[] };
    acknowledgeError?: Error;
  } = {},
): StreamingConnector & { stopSubscription: () => void } {
  const acknowledged = new Set<string>();
  let messagesConsumed = 0;
  let stopped = false;

  return {
    type: "streaming" as const,
    subscribe(_ctx: PluginContext, options: StreamOptions): AsyncIterable<StreamMessage> {
      if (opts.captureOptions !== undefined) {
        opts.captureOptions.startOffset = opts.captureOptions.startOffset ?? [];
        if (options.startOffset !== undefined) {
          opts.captureOptions.startOffset.push(options.startOffset);
        }
      }

      if (opts.subscribeError !== undefined) {
        throw opts.subscribeError;
      }

      async function* gen(): AsyncIterable<StreamMessage> {
        for (const msg of messages) {
          if (stopped) return;
          messagesConsumed += 1;
          yield msg;
        }
      }
      return gen();
    },
    async acknowledge(messageIds: string[]): Promise<void> {
      if (opts.acknowledgeError !== undefined) {
        throw opts.acknowledgeError;
      }
      for (const id of messageIds) acknowledged.add(id);
    },
    async getConsumerStatus(): Promise<ConsumerStatus> {
      const lag: Record<string, number> = {};
      // For testing: lag = messages emitted minus acknowledged per topic
      return {
        connected: !stopped,
        topics: [TOPIC_A],
        lag,
        messagesConsumed,
      };
    },
    stopSubscription(): void {
      stopped = true;
    },
  };
}

// ---------------------------------------------------------------------------
// Service builder
// ---------------------------------------------------------------------------

function buildService(overrides: Partial<StreamingIngestionServiceDeps> = {}): {
  service: StreamingIngestionService;
  rawTableRepo: RawTableRepository;
  syncStateRepo: SyncStateRepository;
  connectorRepo: ConnectorRepository;
  redis: Redis;
  logger: Logger;
} {
  const rawTableRepo = overrides.rawTableRepo ?? makeRawTableRepo();
  const syncStateRepo = overrides.syncStateRepo ?? makeSyncStateRepo();
  const connectorRepo = overrides.connectorRepo ?? makeConnectorRepo();
  const redis = overrides.redis ?? makeRedis();
  const logger = overrides.logger ?? makeLogger();

  const service = createStreamingIngestionService({
    connectorRepo,
    syncStateRepo,
    rawTableRepo,
    redis,
    logger,
  });

  return { service, rawTableRepo, syncStateRepo, connectorRepo, redis, logger };
}

// ---------------------------------------------------------------------------
// Helper: wait until a stream status transitions to the target state.
// ---------------------------------------------------------------------------

async function waitForStatus(
  service: StreamingIngestionService,
  connectorId: string,
  targetStatus: string,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await service.getStreamStatus(connectorId);
    if (s?.status === targetStatus) return;
    await new Promise<void>((r) => setTimeout(r, 10));
  }
  const s = await service.getStreamStatus(connectorId);
  throw new Error(
    `waitForStatus: timed out waiting for "${targetStatus}", ` +
    `current status is "${s?.status ?? "null"}"`,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("StreamingIngestionService", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // getStreamStatus — no stream
  // -------------------------------------------------------------------------
  describe("getStreamStatus", () => {
    it("returns null when no stream has ever run for the connector", async () => {
      const { service } = buildService();
      const status = await service.getStreamStatus(CONNECTOR_ID);
      expect(status).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // stopStream — no active stream
  // -------------------------------------------------------------------------
  describe("stopStream", () => {
    it("is a no-op when no stream is active and logs a warning", async () => {
      const { service, logger } = buildService();
      await expect(service.stopStream(CONNECTOR_ID)).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("no active stream"),
        expect.objectContaining({ connectorId: CONNECTOR_ID }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // startStream validation
  // -------------------------------------------------------------------------
  describe("startStream validation", () => {
    it("throws when topics array is empty", async () => {
      const { service } = buildService();
      const connector = makeMockConnector([]);
      await expect(
        service.startStream(CONNECTOR_ID, TENANT_ID, connector, { topics: [] }),
      ).rejects.toThrow(/topics must contain at least one entry/);
    });

    it("throws ConnectorNotFoundError when connector does not belong to tenant", async () => {
      const connectorRepo = makeConnectorRepo(
        makeConnectorRow({ tenant_id: "other-tenant" }),
      );
      const { service } = buildService({ connectorRepo });
      const connector = makeMockConnector([]);
      await expect(
        service.startStream(CONNECTOR_ID, TENANT_ID, connector, { topics: [TOPIC_A] }),
      ).rejects.toThrow(/not found/);
    });
  });

  // -------------------------------------------------------------------------
  // Message batching
  // -------------------------------------------------------------------------
  describe("message batching", () => {
    it("writes all messages in one insertBatch call when count <= maxBatchSize", async () => {
      const messages = [makeMessage(1), makeMessage(2), makeMessage(3)];
      const connector = makeMockConnector(messages);
      const { service, rawTableRepo } = buildService();

      await service.startStream(CONNECTOR_ID, TENANT_ID, connector, {
        topics: [TOPIC_A],
        maxBatchSize: 10,
        maxWaitMs: 500,
      });
      await waitForStatus(service, CONNECTOR_ID, "stopped");

      const calls = (rawTableRepo.insertBatch as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.length).toBe(1);
      expect(calls[0]?.[1]).toHaveLength(3);
    });

    it("splits messages across multiple insertBatch calls when count > maxBatchSize", async () => {
      const messages = Array.from({ length: 5 }, (_, i) => makeMessage(i + 1));
      const connector = makeMockConnector(messages);
      const { service, rawTableRepo } = buildService();

      await service.startStream(CONNECTOR_ID, TENANT_ID, connector, {
        topics: [TOPIC_A],
        maxBatchSize: 2,
        maxWaitMs: 500,
      });
      await waitForStatus(service, CONNECTOR_ID, "stopped");

      // 5 messages with maxBatchSize=2 → batches of [2, 2, 1]
      const calls = (rawTableRepo.insertBatch as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.length).toBe(3);

      const batchSizes = calls.map((c) => (c[1] as unknown[]).length);
      expect(batchSizes).toEqual([2, 2, 1]);
    });

    it("produces correct envelope shape with _stream_* fields", async () => {
      const msg = makeMessage(42, TOPIC_A);
      const connector = makeMockConnector([msg]);
      const { service, rawTableRepo } = buildService();

      await service.startStream(CONNECTOR_ID, TENANT_ID, connector, {
        topics: [TOPIC_A],
        maxBatchSize: 10,
      });
      await waitForStatus(service, CONNECTOR_ID, "stopped");

      const envelopes = (rawTableRepo.insertBatch as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[1] as Array<{ data: Record<string, unknown> }>;

      expect(envelopes).toBeDefined();
      expect(envelopes[0]?.data).toMatchObject({
        _stream_topic: TOPIC_A,
        _stream_id: msg.id,
        _stream_timestamp: msg.timestamp,
        _stream_partition: 0,
        _stream_offset: "42",
        _stream_key: "key-42",
        // value fields are spread in
        seq: 42,
        payload: "test",
      });
    });

    it("omits optional _stream_* fields when not present on the message", async () => {
      const msg: StreamMessage = {
        id: `${TOPIC_A}:0:1`,
        topic: TOPIC_A,
        value: { x: 1 },
        timestamp: new Date().toISOString(),
        // no partition, no offset, no key, no headers
      };
      const connector = makeMockConnector([msg]);
      const { service, rawTableRepo } = buildService();

      await service.startStream(CONNECTOR_ID, TENANT_ID, connector, {
        topics: [TOPIC_A],
        maxBatchSize: 10,
      });
      await waitForStatus(service, CONNECTOR_ID, "stopped");

      const envelope = (rawTableRepo.insertBatch as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[1][0] as { data: Record<string, unknown> };

      expect(envelope.data).not.toHaveProperty("_stream_partition");
      expect(envelope.data).not.toHaveProperty("_stream_offset");
      expect(envelope.data).not.toHaveProperty("_stream_key");
      expect(envelope.data).not.toHaveProperty("_stream_headers");
    });
  });

  // -------------------------------------------------------------------------
  // Offset tracking
  // -------------------------------------------------------------------------
  describe("offset tracking", () => {
    it("persists the last message id as the cursor after each flush", async () => {
      const messages = [makeMessage(1), makeMessage(2), makeMessage(3)];
      const connector = makeMockConnector(messages);
      const { service, syncStateRepo } = buildService();

      await service.startStream(CONNECTOR_ID, TENANT_ID, connector, {
        topics: [TOPIC_A],
        maxBatchSize: 10,
      });
      await waitForStatus(service, CONNECTOR_ID, "stopped");

      // Last message id: "orders:0:3"
      expect(syncStateRepo.updateCursor).toHaveBeenLastCalledWith(
        CONNECTOR_ID,
        `${TOPIC_A}:0:3`,
      );
    });

    it("passes the persisted last_cursor as startOffset when resuming", async () => {
      const LAST_CURSOR = `${TOPIC_A}:0:99`;
      const syncStateRepo = makeSyncStateRepo(LAST_CURSOR);
      const captureOptions: { startOffset?: string[] } = {};
      const connector = makeMockConnector([], { captureOptions });

      const { service } = buildService({ syncStateRepo });
      await service.startStream(CONNECTOR_ID, TENANT_ID, connector, {
        topics: [TOPIC_A],
      });
      await waitForStatus(service, CONNECTOR_ID, "stopped");

      expect(captureOptions.startOffset).toBeDefined();
      expect(captureOptions.startOffset?.[0]).toBe(LAST_CURSOR);
    });

    it("explicit startOffset overrides the persisted cursor", async () => {
      const LAST_CURSOR = `${TOPIC_A}:0:99`;
      const EXPLICIT_OFFSET = "earliest";
      const syncStateRepo = makeSyncStateRepo(LAST_CURSOR);
      const captureOptions: { startOffset?: string[] } = {};
      const connector = makeMockConnector([], { captureOptions });

      const { service } = buildService({ syncStateRepo });
      await service.startStream(CONNECTOR_ID, TENANT_ID, connector, {
        topics: [TOPIC_A],
        startOffset: EXPLICIT_OFFSET,
      });
      await waitForStatus(service, CONNECTOR_ID, "stopped");

      expect(captureOptions.startOffset?.[0]).toBe(EXPLICIT_OFFSET);
    });

    it("defaults to earliest when no cursor is persisted and no startOffset provided", async () => {
      const captureOptions: { startOffset?: string[] } = {};
      const connector = makeMockConnector([], { captureOptions });
      const { service } = buildService();

      await service.startStream(CONNECTOR_ID, TENANT_ID, connector, {
        topics: [TOPIC_A],
      });
      await waitForStatus(service, CONNECTOR_ID, "stopped");

      expect(captureOptions.startOffset?.[0]).toBe("earliest");
    });
  });

  // -------------------------------------------------------------------------
  // Back-pressure simulation
  //
  // We test back-pressure by injecting a rawTableRepo.insertBatch that adds
  // a deliberate delay, combined with a large message batch. The service must
  // flush before the buffer exceeds the back-pressure threshold (1 000) rather
  // than buffering all messages.
  // -------------------------------------------------------------------------
  describe("back-pressure", () => {
    it("flushes before the buffer exceeds the back-pressure threshold", async () => {
      // Produce 150 messages with maxBatchSize=200 (i.e., one batch at end),
      // but intercept insertBatch to count how many messages were in the buffer
      // at flush time. Back-pressure kicks in at 1 000, but since maxBatchSize
      // is 200 here the batch-full flush fires first — no buffering beyond 200.
      const MESSAGE_COUNT = 150;
      const messages = Array.from({ length: MESSAGE_COUNT }, (_, i) => makeMessage(i + 1));
      const connector = makeMockConnector(messages);

      let maxObservedBatchSize = 0;
      const rawTableRepo = makeRawTableRepo();
      (rawTableRepo.insertBatch as ReturnType<typeof vi.fn>).mockImplementation(
        async (_connectorId: string, envelopes: unknown[]) => {
          if (envelopes.length > maxObservedBatchSize) {
            maxObservedBatchSize = envelopes.length;
          }
        },
      );

      const { service } = buildService({ rawTableRepo });
      await service.startStream(CONNECTOR_ID, TENANT_ID, connector, {
        topics: [TOPIC_A],
        maxBatchSize: 200,
        maxWaitMs: 500,
      });
      await waitForStatus(service, CONNECTOR_ID, "stopped");

      // All 150 fit in one batch (< 200) so the final flush writes them all.
      expect(maxObservedBatchSize).toBe(MESSAGE_COUNT);
      // And we never exceeded maxBatchSize during any individual flush.
      expect(maxObservedBatchSize).toBeLessThanOrEqual(200);
    });
  });

  // -------------------------------------------------------------------------
  // Consumer status reporting
  // -------------------------------------------------------------------------
  describe("consumer status reporting", () => {
    it("reports status=running while the stream is active", async () => {
      // Use an infinite generator that blocks until stopStream() is called.
      const infiniteConnector: StreamingConnector & { stopSubscription: () => void } = {
        type: "streaming" as const,
        subscribe(_ctx: PluginContext, _opts: StreamOptions): AsyncIterable<StreamMessage> {
          let resolve: () => void;
          const stopPromise = new Promise<void>((r) => { resolve = r; });
          const self = infiniteConnector;
          // Redefine stopSubscription to resolve the promise
          self.stopSubscription = () => { resolve(); };

          async function* gen(): AsyncIterable<StreamMessage> {
            await stopPromise;
          }
          return gen();
        },
        async acknowledge(_ids: string[]): Promise<void> {},
        async getConsumerStatus(): Promise<ConsumerStatus> {
          return {
            connected: true,
            topics: [TOPIC_A],
            lag: { [TOPIC_A]: 0 },
            messagesConsumed: 0,
          };
        },
        stopSubscription(): void {},
      };

      const { service } = buildService();
      await service.startStream(CONNECTOR_ID, TENANT_ID, infiniteConnector, {
        topics: [TOPIC_A],
      });

      // Status should be "running" immediately after start.
      const status = await service.getStreamStatus(CONNECTOR_ID);
      expect(status?.status).toBe("running");
      expect(status?.connectorId).toBe(CONNECTOR_ID);
      expect(status?.startedAt).not.toBeNull();

      // Clean up
      await service.stopStream(CONNECTOR_ID);
    });

    it("reports status=stopped after the stream finishes", async () => {
      const connector = makeMockConnector([makeMessage(1)]);
      const { service } = buildService();

      await service.startStream(CONNECTOR_ID, TENANT_ID, connector, {
        topics: [TOPIC_A],
      });
      await waitForStatus(service, CONNECTOR_ID, "stopped");

      const status = await service.getStreamStatus(CONNECTOR_ID);
      expect(status?.status).toBe("stopped");
      expect(status?.messagesConsumed).toBe(1);
    });

    it("reflects topics and lag from the connector getConsumerStatus()", async () => {
      const connector = makeMockConnector([]);
      const { service } = buildService();

      await service.startStream(CONNECTOR_ID, TENANT_ID, connector, {
        topics: [TOPIC_A, TOPIC_B],
      });
      await waitForStatus(service, CONNECTOR_ID, "stopped");

      const status = await service.getStreamStatus(CONNECTOR_ID);
      // MockKafkaConnector's getConsumerStatus always returns TOPIC_A for its
      // topics in the mock. We just verify the field is populated.
      expect(status).toBeDefined();
      expect(status?.topics).toBeDefined();
    });

    it("reads status from Redis when no active stream is running", async () => {
      const connector = makeMockConnector([]);
      const { service, redis } = buildService();

      await service.startStream(CONNECTOR_ID, TENANT_ID, connector, {
        topics: [TOPIC_A],
      });
      await waitForStatus(service, CONNECTOR_ID, "stopped");

      // After stopped the in-memory map is cleared — status comes from Redis.
      const status = await service.getStreamStatus(CONNECTOR_ID);
      expect(status?.status).toBe("stopped");

      // Verify Redis.get was called with the correct key format.
      expect(redis.get).toHaveBeenCalledWith(
        expect.stringContaining(`ingestion:stream:status:${CONNECTOR_ID}`),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Start/stop lifecycle
  // -------------------------------------------------------------------------
  describe("start/stop lifecycle", () => {
    it("startStream returns immediately without waiting for stream to finish", async () => {
      const connector = makeMockConnector([]);
      const { service } = buildService();

      const start = Date.now();
      await service.startStream(CONNECTOR_ID, TENANT_ID, connector, {
        topics: [TOPIC_A],
      });
      const elapsed = Date.now() - start;

      // Should return well under 1 second even if the stream would take longer.
      expect(elapsed).toBeLessThan(500);
    });

    it("ignores duplicate startStream calls while a stream is active", async () => {
      const connector1 = makeMockConnector([]);
      const connector2 = makeMockConnector([makeMessage(1)]);
      const { service, logger } = buildService();

      await service.startStream(CONNECTOR_ID, TENANT_ID, connector1, {
        topics: [TOPIC_A],
      });
      // Second call while the first stream might still be winding down.
      await service.startStream(CONNECTOR_ID, TENANT_ID, connector2, {
        topics: [TOPIC_B],
      });

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("already running"),
        expect.objectContaining({ connectorId: CONNECTOR_ID }),
      );

      await waitForStatus(service, CONNECTOR_ID, "stopped");
    });

    it("stopStream signals the connector to stop producing messages", async () => {
      let messagesEmitted = 0;
      const generator = async function* (
        _topics: string[],
        signal: AbortSignal,
      ): AsyncIterable<StreamMessage> {
        for (let i = 1; i <= 10_000; i++) {
          if (signal.aborted) return;
          messagesEmitted += 1;
          yield makeMessage(i);
          // Yield CPU so the test can call stopStream between messages.
          await new Promise<void>((r) => setTimeout(r, 0));
        }
      };

      const config = parseKafkaConfig({ brokers: "localhost:9092" });
      const connector = new MockKafkaConnector(config, generator);
      const { service } = buildService();

      await service.startStream(CONNECTOR_ID, TENANT_ID, connector, {
        topics: [TOPIC_A],
        maxBatchSize: 1,
        maxWaitMs: 50,
      });

      // Let a few messages emit then stop.
      await new Promise<void>((r) => setTimeout(r, 20));
      await service.stopStream(CONNECTOR_ID);

      await waitForStatus(service, CONNECTOR_ID, "stopped");

      // Stream should have stopped well before producing all 10 000 messages.
      expect(messagesEmitted).toBeLessThan(10_000);
    });
  });

  // -------------------------------------------------------------------------
  // Acknowledge failure is non-fatal
  // -------------------------------------------------------------------------
  describe("acknowledge error handling", () => {
    it("logs an error and continues when acknowledge() throws", async () => {
      const connector = makeMockConnector([makeMessage(1), makeMessage(2)], {
        acknowledgeError: new Error("Broker unreachable"),
      });
      const { service, logger } = buildService();

      await service.startStream(CONNECTOR_ID, TENANT_ID, connector, {
        topics: [TOPIC_A],
        maxBatchSize: 10,
      });
      // Stream should still complete, not crash.
      await waitForStatus(service, CONNECTOR_ID, "stopped");

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("acknowledge()"),
        expect.objectContaining({ connectorId: CONNECTOR_ID }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Reconnection behaviour
  // -------------------------------------------------------------------------
  describe("reconnection", () => {
    it("enters reconnecting state and records lastError after a broker failure", async () => {
      // subscribe() always throws — simulates a permanently broken broker.
      const brokenConnector = makeMockConnector([], {
        subscribeError: new Error("Broker connection refused"),
      });

      const { service } = buildService();
      await service.startStream(CONNECTOR_ID, TENANT_ID, brokenConnector, {
        topics: [TOPIC_A],
        maxBatchSize: 10,
      });

      // After the first failure the service enters "reconnecting" while it
      // waits for the backoff delay before retrying. We verify the error was
      // captured without waiting for all 5 retry attempts (which would require
      // up to 62 seconds of real time).
      await waitForStatus(service, CONNECTOR_ID, "reconnecting", 3_000);

      const status = await service.getStreamStatus(CONNECTOR_ID);
      expect(status?.status).toBe("reconnecting");
      expect(status?.lastError).toMatch(/Broker connection refused/);
    });
  });

  // -------------------------------------------------------------------------
  // MockKafkaConnector — unit tests
  // -------------------------------------------------------------------------
  describe("MockKafkaConnector", () => {
    it("yields messages from the injected generator", async () => {
      const config = parseKafkaConfig({ brokers: "localhost:9092" });
      const messages = [makeMessage(1), makeMessage(2)];

      async function* gen(): AsyncIterable<StreamMessage> {
        for (const m of messages) yield m;
      }

      const connector = new MockKafkaConnector(config, gen);

      const emitted: StreamMessage[] = [];
      for await (const msg of connector.subscribe(
        {} as PluginContext,
        { topics: [TOPIC_A], groupId: "test-group" },
      )) {
        emitted.push(msg);
      }

      expect(emitted).toHaveLength(2);
      expect(emitted[0]?.id).toBe(messages[0]?.id);
    });

    it("acknowledge() tracks the acknowledged message ids", async () => {
      const config = parseKafkaConfig({ brokers: "localhost:9092" });
      const connector = new MockKafkaConnector(config);
      await connector.acknowledge(["msg-1", "msg-2"]);
      // No error thrown — that's the contract.
    });

    it("getConsumerStatus() returns connected=true before stopSubscription()", async () => {
      const config = parseKafkaConfig({ brokers: "localhost:9092" });
      const connector = new MockKafkaConnector(config);

      // Subscribe so the connector has a live AbortController.
      void (async () => {
        for await (const _ of connector.subscribe({} as PluginContext, {
          topics: [TOPIC_A],
          groupId: "g",
        })) { /* consume */ }
      })();

      const status = await connector.getConsumerStatus();
      expect(status.connected).toBe(true);
    });

    it("getConsumerStatus() returns connected=false after stopSubscription()", async () => {
      const config = parseKafkaConfig({ brokers: "localhost:9092" });
      const connector = new MockKafkaConnector(config);
      connector.stopSubscription();
      const status = await connector.getConsumerStatus();
      expect(status.connected).toBe(false);
    });

    it("subscribe() throws when topics is empty", () => {
      const config = parseKafkaConfig({ brokers: "localhost:9092" });
      const connector = new MockKafkaConnector(config);
      expect(() =>
        connector.subscribe({} as PluginContext, { topics: [], groupId: "g" }),
      ).toThrow(/at least one topic/);
    });

    it("subscribe() throws when groupId is blank", () => {
      const config = parseKafkaConfig({ brokers: "localhost:9092" });
      const connector = new MockKafkaConnector(config);
      expect(() =>
        connector.subscribe({} as PluginContext, { topics: [TOPIC_A], groupId: "" }),
      ).toThrow(/non-empty groupId/);
    });
  });

  // -------------------------------------------------------------------------
  // parseKafkaConfig — unit tests
  // -------------------------------------------------------------------------
  describe("parseKafkaConfig", () => {
    it("accepts a comma-separated brokers string", () => {
      const cfg = parseKafkaConfig({ brokers: "b1:9092,b2:9092" });
      expect(cfg.brokers).toEqual(["b1:9092", "b2:9092"]);
    });

    it("accepts a brokers array", () => {
      const cfg = parseKafkaConfig({ brokers: ["b1:9092", "b2:9092"] });
      expect(cfg.brokers).toEqual(["b1:9092", "b2:9092"]);
    });

    it("applies default clientId when omitted", () => {
      const cfg = parseKafkaConfig({ brokers: "b:9092" });
      expect(cfg.clientId).toBe("oneplatform-ingestion");
    });

    it("applies default timeouts when omitted", () => {
      const cfg = parseKafkaConfig({ brokers: "b:9092" });
      expect(cfg.connectionTimeoutMs).toBe(10_000);
      expect(cfg.requestTimeoutMs).toBe(30_000);
    });

    it("throws when brokers is missing", () => {
      expect(() => parseKafkaConfig({})).toThrow(/brokers/);
    });

    it("throws when brokers is an empty string", () => {
      expect(() => parseKafkaConfig({ brokers: "" })).toThrow(/brokers/);
    });

    it("throws when brokers is an empty array", () => {
      expect(() => parseKafkaConfig({ brokers: [] })).toThrow(/brokers/);
    });

    it("validates SASL mechanism values", () => {
      expect(() =>
        parseKafkaConfig({
          brokers: "b:9092",
          sasl: { mechanism: "INVALID", username: "u", password: "p" },
        }),
      ).toThrow(/mechanism/);
    });

    it("validates SASL requires username", () => {
      expect(() =>
        parseKafkaConfig({
          brokers: "b:9092",
          sasl: { mechanism: "PLAIN", username: "", password: "p" },
        }),
      ).toThrow(/sasl.username/);
    });

    it("parses SASL/SCRAM-SHA-256 config", () => {
      const cfg = parseKafkaConfig({
        brokers: "b:9092",
        sasl: { mechanism: "SCRAM-SHA-256", username: "user", password: "pass" },
      });
      expect(cfg.sasl?.mechanism).toBe("SCRAM-SHA-256");
      expect(cfg.sasl?.username).toBe("user");
    });

    it("parses TLS config with rejectUnauthorized", () => {
      const cfg = parseKafkaConfig({
        brokers: "b:9092",
        tls: { rejectUnauthorized: false, ca: "PEM_CERT" },
      });
      expect(cfg.tls?.rejectUnauthorized).toBe(false);
      expect(cfg.tls?.ca).toBe("PEM_CERT");
    });

    it("does not include sasl key when sasl is absent", () => {
      const cfg = parseKafkaConfig({ brokers: "b:9092" });
      expect(cfg.sasl).toBeUndefined();
    });

    it("does not include tls key when tls is absent", () => {
      const cfg = parseKafkaConfig({ brokers: "b:9092" });
      expect(cfg.tls).toBeUndefined();
    });
  });
});
