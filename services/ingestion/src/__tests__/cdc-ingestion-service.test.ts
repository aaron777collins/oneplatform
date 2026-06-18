/**
 * Unit tests for CdcIngestionService.
 *
 * Tests exercise:
 *   - CDC event transformation to raw envelopes (insert / update / delete)
 *   - Batch accumulation flush at configured batchSize
 *   - Position tracking: LSN persisted to sync_state after each flush
 *   - Resume: startPosition derived from persisted last_cursor
 *   - Status reporting: running / stopped / no-stream null
 *   - Idempotent start: duplicate start() calls are ignored
 *   - Stop on an inactive stream: no-op with a log warning
 *
 * The PostgresCdcConnector is injected via the `connectorFactory` dependency
 * parameter, which avoids module-level vi.mock patching and keeps each test
 * isolated from module caching side-effects.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Redis } from "ioredis";
import type { Logger } from "@oneplatform/core";
import { createCdcIngestionService } from "../services/cdc-ingestion-service.js";
import type { CdcIngestionService, CdcIngestionServiceDeps } from "../services/cdc-ingestion-service.js";
import type { ConnectorRepository, SyncStateRepository } from "../services/connector-service.js";
import type { RawTableRepository } from "../services/sync-service.js";
import type { ConnectorRow, SyncStateRow } from "../repositories/types.js";
import type { CdcEvent, CdcOptions } from "@oneplatform/plugin-sdk";
import type { PostgresCdcConnector } from "../connectors/postgres-cdc/index.js";

// ---------------------------------------------------------------------------
// Test constants
//
// UUIDs must be valid v4 UUIDs (version nibble = 4, variant nibble = 8|9|a|b)
// because deriveEnvelopeId uses uuid.v5(sourceId, connectorId) which validates
// the namespace parameter strictly.
// ---------------------------------------------------------------------------

const CONNECTOR_ID = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
const TENANT_ID = "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22";

// ---------------------------------------------------------------------------
// Row factories
// ---------------------------------------------------------------------------

function makeConnectorRow(overrides: Partial<ConnectorRow> = {}): ConnectorRow {
  return {
    id: CONNECTOR_ID,
    tenant_id: TENANT_ID,
    plugin_id: "oneplatform.postgres-cdc",
    instance_id: "inst-1",
    name: "My PG Source",
    description: null,
    config: {
      host: "localhost",
      port: 5432,
      database: "testdb",
      user: "replicator",
      password: "secret",
      slotName: "op_slot",
      publicationName: "op_pub",
    },
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
    set: vi.fn(async (key: string, value: string, ..._args: unknown[]) => {
      store.set(key, value);
      return "OK";
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    publish: vi.fn(async () => 0),
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
    findByConnectorId: vi.fn(async () => makeSyncStateRow({ last_cursor: lastCursor ?? null })),
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
// CDC event factories
// ---------------------------------------------------------------------------

function insertEvent(table = "public.orders", lsn = "00000001/00000001"): CdcEvent {
  return {
    type: "insert",
    table,
    timestamp: new Date().toISOString(),
    lsn,
    after: { id: 1, name: "Widget" },
  };
}

function updateEvent(table = "public.orders", lsn = "00000001/00000002"): CdcEvent {
  return {
    type: "update",
    table,
    timestamp: new Date().toISOString(),
    lsn,
    before: { id: 1, name: "Widget" },
    after: { id: 1, name: "Widget Pro" },
  };
}

function deleteEvent(table = "public.orders", lsn = "00000001/00000003"): CdcEvent {
  return {
    type: "delete",
    table,
    timestamp: new Date().toISOString(),
    lsn,
    before: { id: 1, name: "Widget Pro" },
  };
}

// ---------------------------------------------------------------------------
// Mock PostgresCdcConnector
//
// makeMockConnector returns a function that builds a connector instance that
// emits the given events then stops. Conforms to the PostgresCdcConnector
// type via a structural cast so it satisfies the `connectorFactory` parameter.
// ---------------------------------------------------------------------------

interface CapturedStreamOptions {
  startPosition?: string;
}

function makeMockConnector(
  events: CdcEvent[],
  captureOptions?: CapturedStreamOptions,
): () => PostgresCdcConnector {
  function* makeStream(opts: CdcOptions): Generator<CdcEvent> {
    if (captureOptions !== undefined && opts.startPosition !== undefined) {
      captureOptions.startPosition = opts.startPosition;
    }
    yield* events;
  }

  const instance = {
    supportsRealtime: true as const,
    metadata: vi.fn(),
    connect: vi.fn(async () => ({ connectionId: "mock", metadata: {} })),
    fetchBatch: vi.fn(async () => ({
      records: [],
      nextCursor: null,
      hasMore: false,
      fetchedAt: new Date().toISOString(),
    })),
    disconnect: vi.fn(async () => {}),
    startCdcStream: vi.fn((_ctx: unknown, opts: CdcOptions) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (async function* () { yield* makeStream(opts); })() as any;
    }),
    stopCdcStream: vi.fn(async () => {}),
    getReplicationSlotInfo: vi.fn(async () => ({
      slotName: "op_slot",
      confirmedFlushLsn: "00000001/00000001",
      lagBytes: 0,
      active: true,
    })),
  };

  return () => instance as unknown as PostgresCdcConnector;
}

// ---------------------------------------------------------------------------
// Service builder
// ---------------------------------------------------------------------------

function buildService(
  events: CdcEvent[],
  opts: {
    syncStateLastCursor?: string;
    captureOptions?: CapturedStreamOptions;
    customSyncStateRepo?: SyncStateRepository;
    rawTableRepo?: RawTableRepository;
    logger?: Logger;
  } = {},
): {
  service: CdcIngestionService;
  rawTableRepo: RawTableRepository;
  syncStateRepo: SyncStateRepository;
  connectorRepo: ConnectorRepository;
  redis: Redis;
  logger: Logger;
} {
  const rawTableRepo = opts.rawTableRepo ?? makeRawTableRepo();
  const syncStateRepo = opts.customSyncStateRepo ?? makeSyncStateRepo(opts.syncStateLastCursor);
  const connectorRepo = makeConnectorRepo();
  const redis = makeRedis();
  const logger = opts.logger ?? makeLogger();

  const connectorFactory = makeMockConnector(events, opts.captureOptions);

  const service = createCdcIngestionService({
    connectorRepo,
    syncStateRepo,
    rawTableRepo,
    redis,
    logger,
    connectorFactory,
  } satisfies CdcIngestionServiceDeps);

  return { service, rawTableRepo, syncStateRepo, connectorRepo, redis, logger };
}

// ---------------------------------------------------------------------------
// Async helpers
// ---------------------------------------------------------------------------

/**
 * Poll the service status until it reports "stopped" or the timeout elapses.
 * The service runs the stream loop in a background void promise, so we need
 * to yield control to the event loop to let it complete.
 */
async function waitUntilStopped(
  service: CdcIngestionService,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await service.getCdcStatus(CONNECTOR_ID);
    if (s?.status === "stopped") return;
    await new Promise<void>((r) => setTimeout(r, 5));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CdcIngestionService", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // getCdcStatus — no stream
  // -------------------------------------------------------------------------
  describe("getCdcStatus", () => {
    it("returns null when no stream has ever run for the connector", async () => {
      const { service } = buildService([]);
      const status = await service.getCdcStatus(CONNECTOR_ID);
      expect(status).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // stopCdcIngestion — no-op on inactive stream
  // -------------------------------------------------------------------------
  describe("stopCdcIngestion", () => {
    it("is a no-op when no stream is active and logs a warning", async () => {
      const logger = makeLogger();
      const { service } = buildService([], { logger });
      await expect(service.stopCdcIngestion(CONNECTOR_ID)).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("no active stream"),
        expect.objectContaining({ connectorId: CONNECTOR_ID }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Event parsing — INSERT
  // -------------------------------------------------------------------------
  describe("INSERT event", () => {
    it("writes a raw envelope with _cdc_type=insert and _cdc_after", async () => {
      const ev = insertEvent();
      const { service, rawTableRepo } = buildService([ev]);

      await service.startCdcIngestion(CONNECTOR_ID, TENANT_ID, { batchSize: 100 });
      await waitUntilStopped(service);

      expect(rawTableRepo.insertBatch).toHaveBeenCalledWith(
        CONNECTOR_ID,
        expect.arrayContaining([
          expect.objectContaining({
            data: expect.objectContaining({
              _cdc_type: "insert",
              _cdc_table: "public.orders",
              _cdc_after: ev.after,
            }),
          }),
        ]),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Event parsing — UPDATE
  // -------------------------------------------------------------------------
  describe("UPDATE event", () => {
    it("writes a raw envelope with _cdc_before and _cdc_after", async () => {
      const ev = updateEvent();
      const { service, rawTableRepo } = buildService([ev]);

      await service.startCdcIngestion(CONNECTOR_ID, TENANT_ID, { batchSize: 100 });
      await waitUntilStopped(service);

      expect(rawTableRepo.insertBatch).toHaveBeenCalledWith(
        CONNECTOR_ID,
        expect.arrayContaining([
          expect.objectContaining({
            data: expect.objectContaining({
              _cdc_type: "update",
              _cdc_before: ev.before,
              _cdc_after: ev.after,
            }),
          }),
        ]),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Event parsing — DELETE
  // -------------------------------------------------------------------------
  describe("DELETE event", () => {
    it("writes a raw envelope with _cdc_type=delete and _cdc_before", async () => {
      const ev = deleteEvent();
      const { service, rawTableRepo } = buildService([ev]);

      await service.startCdcIngestion(CONNECTOR_ID, TENANT_ID, { batchSize: 100 });
      await waitUntilStopped(service);

      expect(rawTableRepo.insertBatch).toHaveBeenCalledWith(
        CONNECTOR_ID,
        expect.arrayContaining([
          expect.objectContaining({
            data: expect.objectContaining({
              _cdc_type: "delete",
              _cdc_before: ev.before,
            }),
          }),
        ]),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Position tracking
  // -------------------------------------------------------------------------
  describe("position tracking", () => {
    it("persists the last LSN via syncStateRepo.updateCursor after a flush", async () => {
      const events = [
        insertEvent("public.orders", "00000001/00000001"),
        insertEvent("public.orders", "00000001/00000002"),
      ];
      const { service, syncStateRepo } = buildService(events);

      await service.startCdcIngestion(CONNECTOR_ID, TENANT_ID, { batchSize: 100 });
      await waitUntilStopped(service);

      // The cursor should have been updated with the last LSN in the batch.
      expect(syncStateRepo.updateCursor).toHaveBeenCalledWith(
        CONNECTOR_ID,
        "00000001/00000002",
      );
    });

    it("uses the persisted last_cursor as startPosition when resuming", async () => {
      const LAST_LSN = "00000005/00000005";
      const captureOptions: CapturedStreamOptions = {};
      const { service } = buildService([], {
        syncStateLastCursor: LAST_LSN,
        captureOptions,
      });

      await service.startCdcIngestion(CONNECTOR_ID, TENANT_ID);
      await waitUntilStopped(service);

      expect(captureOptions.startPosition).toBe(LAST_LSN);
    });

    it("explicit startPosition overrides the persisted cursor", async () => {
      const LAST_LSN = "00000005/00000005";
      const EXPLICIT_LSN = "0000000A/0000000A";
      const captureOptions: CapturedStreamOptions = {};
      const { service } = buildService([], {
        syncStateLastCursor: LAST_LSN,
        captureOptions,
      });

      await service.startCdcIngestion(CONNECTOR_ID, TENANT_ID, { startPosition: EXPLICIT_LSN });
      await waitUntilStopped(service);

      expect(captureOptions.startPosition).toBe(EXPLICIT_LSN);
    });
  });

  // -------------------------------------------------------------------------
  // Batch accumulation
  // -------------------------------------------------------------------------
  describe("batch accumulation", () => {
    it("flushes exactly once when all events fit in one batch", async () => {
      const BATCH_SIZE = 3;
      const events = [
        insertEvent("public.orders", "00000001/00000001"),
        updateEvent("public.orders", "00000001/00000002"),
        deleteEvent("public.orders", "00000001/00000003"),
      ];
      const { service, rawTableRepo } = buildService(events);

      await service.startCdcIngestion(CONNECTOR_ID, TENANT_ID, { batchSize: BATCH_SIZE });
      await waitUntilStopped(service);

      // All 3 events should be in a single insertBatch call (flushed at end).
      const calls = (rawTableRepo.insertBatch as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.length).toBe(1);
      expect(calls[0]?.[1]).toHaveLength(BATCH_SIZE);
    });

    it("flushes in two batches when events exceed batchSize", async () => {
      const BATCH_SIZE = 2;
      const events = [
        insertEvent("public.orders", "00000001/00000001"),
        insertEvent("public.orders", "00000001/00000002"),
        insertEvent("public.orders", "00000001/00000003"),
      ];
      const { service, rawTableRepo } = buildService(events);

      await service.startCdcIngestion(CONNECTOR_ID, TENANT_ID, { batchSize: BATCH_SIZE });
      await waitUntilStopped(service);

      const calls = (rawTableRepo.insertBatch as ReturnType<typeof vi.fn>).mock.calls;
      // 3 events with batchSize=2 → first batch when buffer hits 2, final flush for 1
      expect(calls.length).toBe(2);
      expect(calls[0]?.[1]).toHaveLength(2);
      expect(calls[1]?.[1]).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Status reporting
  // -------------------------------------------------------------------------
  describe("status reporting", () => {
    it("reports status=stopped after the stream completes cleanly", async () => {
      const { service } = buildService([]);

      await service.startCdcIngestion(CONNECTOR_ID, TENANT_ID, { batchSize: 100 });
      await waitUntilStopped(service);

      const status = await service.getCdcStatus(CONNECTOR_ID);
      expect(status?.status).toBe("stopped");
    });

    it("reports connectorId and a non-null startedAt", async () => {
      const { service } = buildService([]);
      await service.startCdcIngestion(CONNECTOR_ID, TENANT_ID, { batchSize: 100 });

      // Status should be present before stream finishes.
      const status = await service.getCdcStatus(CONNECTOR_ID);
      expect(status?.connectorId).toBe(CONNECTOR_ID);
      expect(status?.startedAt).not.toBeNull();

      await waitUntilStopped(service);
    });

    it("counts eventsProcessed=3 after processing three events", async () => {
      const events = [insertEvent(), updateEvent(), deleteEvent()];
      const { service } = buildService(events);

      await service.startCdcIngestion(CONNECTOR_ID, TENANT_ID, { batchSize: 100 });
      await waitUntilStopped(service);

      const status = await service.getCdcStatus(CONNECTOR_ID);
      expect(status?.eventsProcessed).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // Idempotent start
  // -------------------------------------------------------------------------
  describe("idempotent start", () => {
    it("ignores a second startCdcIngestion call while a stream is active", async () => {
      const logger = makeLogger();
      const { service } = buildService([], { logger });

      await service.startCdcIngestion(CONNECTOR_ID, TENANT_ID);
      await service.startCdcIngestion(CONNECTOR_ID, TENANT_ID);

      // The second call should be short-circuited with a warning.
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("already running"),
        expect.objectContaining({ connectorId: CONNECTOR_ID }),
      );

      await waitUntilStopped(service);
    });
  });
});
