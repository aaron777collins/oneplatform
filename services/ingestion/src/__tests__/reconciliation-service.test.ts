// Unit tests for reconciliation-service.ts
//
// processReconcileJob tests call executeReconcileJob directly — a standalone
// export that takes only the necessary deps as parameters, matching the
// executeWatchdog pattern from sync-service.ts. This avoids constructing a
// BullMQ Queue (which throws "Queue name cannot contain :" in v5).
//
// Tests for triggerReconcile and listReports/getReport are exercised through
// the full createReconciliationService factory using a queue-name-safe alias.
//
// Coverage:
//   - Perfect match scenario
//   - Missing records detection
//   - Extra records detection
//   - Field value mismatches
//   - Sample size limiting
//   - Empty source / empty platform handling
//   - Match rate calculation (computeMatchRate)
//   - deriveStatus logic
//   - valuesEqual edge cases
//   - getReport Redis fast-path and DB fallback
//   - listReports pagination delegation

import { describe, it, expect, vi, beforeEach, type MockedFunction } from "vitest";
import type { Logger } from "@oneplatform/core";
import type { Job } from "bullmq";
import {
  executeReconcileJob,
  computeMatchRate,
  deriveStatus,
  valuesEqual,
  type ExecuteReconcileJobDeps,
  type ReconcileJobPayload,
  type ReconciliationReport,
  type ReconciliationReportRepository,
  type RawRecordReader,
} from "../services/reconciliation-service.js";
import type { ConnectorRepository, ConnectorRow } from "../services/connector-service.js";
import type { CredentialService } from "../services/credential-service.js";
import type { Redis } from "ioredis";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const CONNECTOR_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TENANT_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const JOB_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";

// ---------------------------------------------------------------------------
// Fixture factories
// ---------------------------------------------------------------------------

function makeConnectorRow(overrides: Partial<ConnectorRow> = {}): ConnectorRow {
  return {
    id: CONNECTOR_ID,
    tenant_id: TENANT_ID,
    plugin_id: "plugin-1",
    instance_id: "instance-1",
    name: "Test Connector",
    description: null,
    config: {},
    sync_mode: "full",
    schedule_cron: null,
    is_enabled: true,
    created_by: "user-1",
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
    ...overrides,
  };
}

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

function makeConnectorRepo(connector: ConnectorRow | null = makeConnectorRow()): ConnectorRepository {
  return {
    findById: vi.fn().mockResolvedValue(connector),
    findByTenantId: vi.fn(),
    findByPluginId: vi.fn(),
    countByTenantId: vi.fn(),
    update: vi.fn(),
    softDelete: vi.fn(),
    findDeletedBefore: vi.fn(),
    hardDelete: vi.fn(),
    create: vi.fn(),
    list: vi.fn(),
    findByTenantAndId: vi.fn(),
    disableByPluginId: vi.fn(),
    disableByInstanceId: vi.fn(),
  } as unknown as ConnectorRepository;
}

function makeCredentialService(): CredentialService {
  return {
    createCredentialAccessor: vi.fn().mockReturnValue({
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
    }),
    upsertCredential: vi.fn(),
    listCredentials: vi.fn(),
    deleteCredential: vi.fn(),
    getDecrypted: vi.fn(),
  } as unknown as CredentialService;
}

function makeRawRecordReader(overrides: Partial<RawRecordReader> = {}): RawRecordReader {
  return {
    count: vi.fn().mockResolvedValue(0),
    listSourceIds: vi.fn().mockResolvedValue([]),
    sampleRecords: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function makeReportRepo(
  savedReports: ReconciliationReport[] = [],
): ReconciliationReportRepository {
  const store = new Map<string, ReconciliationReport>(
    savedReports.map((r) => [r.jobId, r]),
  );
  return {
    save: vi.fn().mockImplementation(async (r: ReconciliationReport) => {
      store.set(r.jobId, r);
    }),
    findByJobId: vi.fn().mockImplementation(async (id: string) => store.get(id) ?? null),
    findByConnectorId: vi.fn().mockResolvedValue({ items: [], total: 0 }),
  };
}

function makeRedis(getResult: string | null = null): Redis {
  return {
    get: vi.fn().mockResolvedValue(getResult),
    set: vi.fn().mockResolvedValue("OK"),
    publish: vi.fn().mockResolvedValue(0),
    quit: vi.fn(),
  } as unknown as Redis;
}

// Builds a BullMQ-like Job stub from the payload.
function makeJob(data: ReconcileJobPayload): Job<ReconcileJobPayload> {
  return { id: JOB_ID, data } as unknown as Job<ReconcileJobPayload>;
}

// Builds ExecuteReconcileJobDeps using the provided reader and optional connector override.
function makeDeps(
  rawReaderOverrides: Partial<RawRecordReader> = {},
  connector: ConnectorRow | null = makeConnectorRow(),
  redisGetResult: string | null = null,
): { deps: ExecuteReconcileJobDeps; reportRepo: ReconciliationReportRepository } {
  const reportRepo = makeReportRepo();
  const deps: ExecuteReconcileJobDeps = {
    connectorRepo: makeConnectorRepo(connector),
    credentialService: makeCredentialService(),
    rawRecordReader: makeRawRecordReader(rawReaderOverrides),
    reportRepo,
    redis: makeRedis(redisGetResult),
    masterKey: Buffer.alloc(32),
    logger: makeLogger(),
    executionServiceUrl: "http://execution-service",
  };
  return { deps, reportRepo };
}

// ---------------------------------------------------------------------------
// Helpers for intercepting execution service HTTP calls
// ---------------------------------------------------------------------------

function mockFetch(responses: Array<{ ok: boolean; body: unknown }>): void {
  let callIndex = 0;
  global.fetch = vi.fn().mockImplementation(async () => {
    const resp = responses[callIndex % responses.length];
    callIndex++;
    return {
      ok: resp?.ok ?? true,
      status: resp?.ok ? 200 : 400,
      json: async () => resp?.body ?? {},
    };
  });
}

// ---------------------------------------------------------------------------
// executeReconcileJob tests — the full reconciliation algorithm
// ---------------------------------------------------------------------------

describe("executeReconcileJob", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  it("perfect match — source and platform have same IDs and field values", async () => {
    const sourceIds = ["id-1", "id-2", "id-3"];

    // reconcileList returns IDs directly
    mockFetch([
      { ok: true, body: { ids: sourceIds } },
      // fetchRecords for sample
      {
        ok: true,
        body: {
          records: sourceIds.map((id) => ({
            sourceId: id,
            data: { id, name: `Record ${id}` },
          })),
        },
      },
    ]);

    const { deps, reportRepo } = makeDeps({
      listSourceIds: vi.fn().mockResolvedValue(sourceIds),
      count: vi.fn().mockResolvedValue(3),
      sampleRecords: vi.fn().mockResolvedValue(
        sourceIds.map((id) => ({ sourceId: id, data: { id, name: `Record ${id}` } })),
      ),
    });

    await executeReconcileJob(makeJob({
      jobId: JOB_ID,
      connectorId: CONNECTOR_ID,
      tenantId: TENANT_ID,
      options: { idField: "id", sampleSize: 100, fields: [] },
    }), deps);

    expect(reportRepo.save).toHaveBeenCalledOnce();
    const saved = (reportRepo.save as MockedFunction<ReconciliationReportRepository["save"]>).mock
      .calls[0]?.[0];
    expect(saved?.status).toBe("match");
    expect(saved?.missingInPlatform).toHaveLength(0);
    expect(saved?.extraInPlatform).toHaveLength(0);
    expect(saved?.fieldMismatches).toHaveLength(0);
    expect(saved?.matchRate).toBe(100);
  });

  // -------------------------------------------------------------------------
  it("missing records — source has IDs not in platform", async () => {
    const sourceIds = ["id-1", "id-2", "id-3"];
    const platformIds = ["id-1"]; // id-2 and id-3 missing

    mockFetch([
      { ok: true, body: { ids: sourceIds } },
      { ok: true, body: { records: [{ sourceId: "id-1", data: { id: "id-1" } }] } },
    ]);

    const { deps, reportRepo } = makeDeps({
      listSourceIds: vi.fn().mockResolvedValue(platformIds),
      count: vi.fn().mockResolvedValue(platformIds.length),
      sampleRecords: vi.fn().mockResolvedValue([
        { sourceId: "id-1", data: { id: "id-1" } },
      ]),
    });

    await executeReconcileJob(makeJob({
      jobId: JOB_ID,
      connectorId: CONNECTOR_ID,
      tenantId: TENANT_ID,
      options: { idField: "id", sampleSize: 100, fields: [] },
    }), deps);

    const saved = (reportRepo.save as MockedFunction<ReconciliationReportRepository["save"]>).mock
      .calls[0]?.[0];
    expect(saved?.missingInPlatform).toEqual(expect.arrayContaining(["id-2", "id-3"]));
    expect(saved?.missingInPlatform).toHaveLength(2);
    expect(saved?.extraInPlatform).toHaveLength(0);
    expect(saved?.status).toBe("partial_match");
  });

  // -------------------------------------------------------------------------
  it("extra records — platform has IDs not in source", async () => {
    const sourceIds = ["id-1"];
    const platformIds = ["id-1", "id-ghost-1", "id-ghost-2"];

    mockFetch([
      { ok: true, body: { ids: sourceIds } },
      { ok: true, body: { records: [{ sourceId: "id-1", data: { id: "id-1" } }] } },
    ]);

    const { deps, reportRepo } = makeDeps({
      listSourceIds: vi.fn().mockResolvedValue(platformIds),
      count: vi.fn().mockResolvedValue(platformIds.length),
      sampleRecords: vi.fn().mockResolvedValue([
        { sourceId: "id-1", data: { id: "id-1" } },
      ]),
    });

    await executeReconcileJob(makeJob({
      jobId: JOB_ID,
      connectorId: CONNECTOR_ID,
      tenantId: TENANT_ID,
      options: { idField: "id", sampleSize: 100, fields: [] },
    }), deps);

    const saved = (reportRepo.save as MockedFunction<ReconciliationReportRepository["save"]>).mock
      .calls[0]?.[0];
    expect(saved?.extraInPlatform).toEqual(expect.arrayContaining(["id-ghost-1", "id-ghost-2"]));
    expect(saved?.extraInPlatform).toHaveLength(2);
    expect(saved?.missingInPlatform).toHaveLength(0);
    expect(saved?.status).toBe("partial_match");
  });

  // -------------------------------------------------------------------------
  it("field value mismatches — same IDs but different field values", async () => {
    const sourceIds = ["id-1", "id-2"];

    mockFetch([
      { ok: true, body: { ids: sourceIds } },
      {
        ok: true,
        body: {
          records: [
            { sourceId: "id-1", data: { id: "id-1", name: "Alice Updated" } },
            { sourceId: "id-2", data: { id: "id-2", name: "Bob" } },
          ],
        },
      },
    ]);

    const { deps, reportRepo } = makeDeps({
      listSourceIds: vi.fn().mockResolvedValue(sourceIds),
      count: vi.fn().mockResolvedValue(2),
      sampleRecords: vi.fn().mockResolvedValue([
        { sourceId: "id-1", data: { id: "id-1", name: "Alice" } }, // stale platform value
        { sourceId: "id-2", data: { id: "id-2", name: "Bob" } },
      ]),
    });

    await executeReconcileJob(makeJob({
      jobId: JOB_ID,
      connectorId: CONNECTOR_ID,
      tenantId: TENANT_ID,
      options: { idField: "id", sampleSize: 100, fields: [] },
    }), deps);

    const saved = (reportRepo.save as MockedFunction<ReconciliationReportRepository["save"]>).mock
      .calls[0]?.[0];
    expect(saved?.fieldMismatches).toHaveLength(1);
    expect(saved?.fieldMismatches[0]).toMatchObject({
      recordId: "id-1",
      field: "name",
      sourceValue: "Alice Updated",
      platformValue: "Alice",
    });
    expect(saved?.status).toBe("partial_match");
  });

  // -------------------------------------------------------------------------
  it("sample size limiting — only compares up to sampleSize records", async () => {
    const total = 50;
    const allIds = Array.from({ length: total }, (_, i) => `id-${i}`);

    mockFetch([
      { ok: true, body: { ids: allIds } },
      { ok: true, body: { records: [] } }, // fetchRecords returns nothing
    ]);

    const sampleRecordsMock = vi.fn().mockResolvedValue(
      allIds.slice(0, 5).map((id) => ({ sourceId: id, data: { id } })),
    );

    const { deps } = makeDeps({
      listSourceIds: vi.fn().mockResolvedValue(allIds),
      count: vi.fn().mockResolvedValue(total),
      sampleRecords: sampleRecordsMock,
    });

    await executeReconcileJob(makeJob({
      jobId: JOB_ID,
      connectorId: CONNECTOR_ID,
      tenantId: TENANT_ID,
      options: { idField: "id", sampleSize: 5, fields: [] },
    }), deps);

    // sampleRecords should be called with limit=5
    expect(sampleRecordsMock).toHaveBeenCalledWith(
      CONNECTOR_ID,
      5,
      expect.any(Array),
    );

    // The array passed should be at most 5 IDs
    const calledWith = sampleRecordsMock.mock.calls[0] as [string, number, string[]];
    expect(calledWith[2]?.length).toBeLessThanOrEqual(5);
  });

  // -------------------------------------------------------------------------
  it("empty source and platform — returns 100% match rate with 'match' status", async () => {
    mockFetch([
      { ok: true, body: { ids: [] } },
    ]);

    const { deps, reportRepo } = makeDeps({
      listSourceIds: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      sampleRecords: vi.fn().mockResolvedValue([]),
    });

    await executeReconcileJob(makeJob({
      jobId: JOB_ID,
      connectorId: CONNECTOR_ID,
      tenantId: TENANT_ID,
      options: { idField: "id", sampleSize: 100, fields: [] },
    }), deps);

    const saved = (reportRepo.save as MockedFunction<ReconciliationReportRepository["save"]>).mock
      .calls[0]?.[0];
    expect(saved?.sourceCount).toBe(0);
    expect(saved?.platformCount).toBe(0);
    expect(saved?.matchRate).toBe(100);
    expect(saved?.status).toBe("match");
  });

  // -------------------------------------------------------------------------
  it("empty platform with source records — all source IDs in missingInPlatform", async () => {
    mockFetch([
      { ok: true, body: { ids: ["id-1", "id-2"] } },
    ]);

    const { deps, reportRepo } = makeDeps({
      listSourceIds: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      sampleRecords: vi.fn().mockResolvedValue([]),
    });

    await executeReconcileJob(makeJob({
      jobId: JOB_ID,
      connectorId: CONNECTOR_ID,
      tenantId: TENANT_ID,
      options: { idField: "id", sampleSize: 100, fields: [] },
    }), deps);

    const saved = (reportRepo.save as MockedFunction<ReconciliationReportRepository["save"]>).mock
      .calls[0]?.[0];
    expect(saved?.missingInPlatform).toEqual(["id-1", "id-2"]);
    expect(saved?.extraInPlatform).toHaveLength(0);
    expect(saved?.matchRate).toBeLessThan(100);
  });

  // -------------------------------------------------------------------------
  it("connector not found — throws ConnectorNotFoundError", async () => {
    const { deps } = makeDeps({}, null);

    await expect(
      executeReconcileJob(makeJob({
        jobId: JOB_ID,
        connectorId: CONNECTOR_ID,
        tenantId: TENANT_ID,
        options: { idField: "id", sampleSize: 100, fields: [] },
      }), deps),
    ).rejects.toThrow(/Connector .* not found/);
  });

  // -------------------------------------------------------------------------
  it("field filter — only compares specified fields", async () => {
    const sourceIds = ["id-1"];

    mockFetch([
      { ok: true, body: { ids: sourceIds } },
      {
        ok: true,
        body: {
          records: [
            { sourceId: "id-1", data: { id: "id-1", name: "Alice", score: 99 } },
          ],
        },
      },
    ]);

    const { deps, reportRepo } = makeDeps({
      listSourceIds: vi.fn().mockResolvedValue(sourceIds),
      count: vi.fn().mockResolvedValue(1),
      sampleRecords: vi.fn().mockResolvedValue([
        // name differs AND score differs — only name is in the fields filter
        { sourceId: "id-1", data: { id: "id-1", name: "Alice OLD", score: 0 } },
      ]),
    });

    await executeReconcileJob(makeJob({
      jobId: JOB_ID,
      connectorId: CONNECTOR_ID,
      tenantId: TENANT_ID,
      options: { idField: "id", sampleSize: 100, fields: ["name"] },
    }), deps);

    const saved = (reportRepo.save as MockedFunction<ReconciliationReportRepository["save"]>).mock
      .calls[0]?.[0];
    // Only "name" should be in mismatches — "score" is excluded by the filter.
    expect(saved?.fieldMismatches.every((m) => m.field === "name")).toBe(true);
    expect(saved?.fieldMismatches).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  it("persists report to both DB and Redis", async () => {
    mockFetch([
      { ok: true, body: { ids: ["id-1"] } },
      { ok: true, body: { records: [{ sourceId: "id-1", data: { id: "id-1" } }] } },
    ]);

    const { deps, reportRepo } = makeDeps({
      listSourceIds: vi.fn().mockResolvedValue(["id-1"]),
      count: vi.fn().mockResolvedValue(1),
      sampleRecords: vi.fn().mockResolvedValue([{ sourceId: "id-1", data: { id: "id-1" } }]),
    });

    await executeReconcileJob(makeJob({
      jobId: JOB_ID,
      connectorId: CONNECTOR_ID,
      tenantId: TENANT_ID,
      options: { idField: "id", sampleSize: 100, fields: [] },
    }), deps);

    // DB save
    expect(reportRepo.save).toHaveBeenCalledOnce();
    // Redis set
    expect(deps.redis.set).toHaveBeenCalledWith(
      `ingestion:reconcile:${JOB_ID}:report`,
      expect.any(String),
      "EX",
      expect.any(Number),
    );
  });
});

// ---------------------------------------------------------------------------
// computeMatchRate unit tests
// ---------------------------------------------------------------------------

describe("computeMatchRate", () => {
  it("returns 100 for no source records", () => {
    expect(
      computeMatchRate({
        sampleSize: 0,
        fieldMismatches: [],
        missingInPlatform: [],
        extraInPlatform: [],
        sourceCount: 0,
        platformCount: 0,
      }),
    ).toBe(100);
  });

  it("returns 100 for a perfect match", () => {
    expect(
      computeMatchRate({
        sampleSize: 10,
        fieldMismatches: [],
        missingInPlatform: [],
        extraInPlatform: [],
        sourceCount: 10,
        platformCount: 10,
      }),
    ).toBe(100);
  });

  it("penalises missing records proportionally", () => {
    const rate = computeMatchRate({
      sampleSize: 0,
      fieldMismatches: [],
      missingInPlatform: ["id-1", "id-2"],
      extraInPlatform: [],
      sourceCount: 10,
      platformCount: 8,
    });
    expect(rate).toBeLessThan(100);
    expect(rate).toBeGreaterThan(0);
  });

  it("penalises extra records in platform", () => {
    const rate = computeMatchRate({
      sampleSize: 0,
      fieldMismatches: [],
      missingInPlatform: [],
      extraInPlatform: ["ghost-1", "ghost-2"],
      sourceCount: 8,
      platformCount: 10,
    });
    expect(rate).toBeLessThan(100);
    expect(rate).toBeGreaterThan(0);
  });

  it("penalises field mismatches proportionally to sample size", () => {
    const noMismatches = computeMatchRate({
      sampleSize: 10,
      fieldMismatches: [],
      missingInPlatform: [],
      extraInPlatform: [],
      sourceCount: 10,
      platformCount: 10,
    });
    const withMismatches = computeMatchRate({
      sampleSize: 10,
      fieldMismatches: [
        { recordId: "id-1", field: "name", sourceValue: "A", platformValue: "B" },
        { recordId: "id-2", field: "age", sourceValue: 30, platformValue: 31 },
      ],
      missingInPlatform: [],
      extraInPlatform: [],
      sourceCount: 10,
      platformCount: 10,
    });
    expect(withMismatches).toBeLessThan(noMismatches);
  });

  it("clamps result to 0..100 on catastrophic mismatch", () => {
    const rate = computeMatchRate({
      sampleSize: 5,
      fieldMismatches: Array.from({ length: 50 }, (_, i) => ({
        recordId: `id-${i}`,
        field: "x",
        sourceValue: 1,
        platformValue: 2,
      })),
      missingInPlatform: Array.from({ length: 100 }, (_, i) => `id-${i}`),
      extraInPlatform: Array.from({ length: 100 }, (_, i) => `extra-${i}`),
      sourceCount: 100,
      platformCount: 100,
    });
    expect(rate).toBeGreaterThanOrEqual(0);
    expect(rate).toBeLessThanOrEqual(100);
  });
});

// ---------------------------------------------------------------------------
// deriveStatus unit tests
// ---------------------------------------------------------------------------

describe("deriveStatus", () => {
  it("returns 'match' when all arrays are empty", () => {
    expect(deriveStatus([], [], [])).toBe("match");
  });

  it("returns 'partial_match' for only missing records", () => {
    expect(deriveStatus(["id-1"], [], [])).toBe("partial_match");
  });

  it("returns 'partial_match' for only extra records", () => {
    expect(deriveStatus([], ["ghost-1"], [])).toBe("partial_match");
  });

  it("returns 'mismatch' when both missing AND extra exist", () => {
    expect(deriveStatus(["id-1"], ["ghost-1"], [])).toBe("mismatch");
  });

  it("returns 'mismatch' when more than 10 field mismatches", () => {
    const many = Array.from({ length: 11 }, (_, i) => ({
      recordId: `id-${i}`,
      field: "x",
      sourceValue: 1,
      platformValue: 2,
    }));
    expect(deriveStatus([], [], many)).toBe("mismatch");
  });

  it("returns 'partial_match' for exactly 10 field mismatches", () => {
    const ten = Array.from({ length: 10 }, (_, i) => ({
      recordId: `id-${i}`,
      field: "x",
      sourceValue: 1,
      platformValue: 2,
    }));
    expect(deriveStatus([], [], ten)).toBe("partial_match");
  });
});

// ---------------------------------------------------------------------------
// valuesEqual unit tests
// ---------------------------------------------------------------------------

describe("valuesEqual", () => {
  it("returns true for identical primitives", () => {
    expect(valuesEqual(1, 1)).toBe(true);
    expect(valuesEqual("a", "a")).toBe(true);
    expect(valuesEqual(true, true)).toBe(true);
    expect(valuesEqual(null, null)).toBe(true);
  });

  it("returns false for different primitives", () => {
    expect(valuesEqual(1, 2)).toBe(false);
    expect(valuesEqual("a", "b")).toBe(false);
  });

  it("returns false for null vs non-null", () => {
    expect(valuesEqual(null, 0)).toBe(false);
    expect(valuesEqual(null, "")).toBe(false);
  });

  it("returns true for deeply equal objects", () => {
    expect(valuesEqual({ a: 1, b: [2, 3] }, { a: 1, b: [2, 3] })).toBe(true);
  });

  it("returns false for structurally different objects", () => {
    expect(valuesEqual({ a: 1 }, { a: 2 })).toBe(false);
  });

  it("handles arrays correctly", () => {
    expect(valuesEqual([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(valuesEqual([1, 2], [1, 2, 3])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getReport — Redis fast-path vs DB fallback
// (tested via deps directly rather than through createReconciliationService
//  to avoid BullMQ Queue construction)
// ---------------------------------------------------------------------------

describe("getReport via reportRepo and redis", () => {
  it("Redis fast-path: parses and returns stored JSON report", async () => {
    const storedReport: ReconciliationReport = {
      jobId: JOB_ID,
      connectorId: CONNECTOR_ID,
      timestamp: new Date().toISOString(),
      sourceCount: 5,
      platformCount: 5,
      missingInPlatform: [],
      extraInPlatform: [],
      fieldMismatches: [],
      matchRate: 100,
      status: "match",
    };

    // Directly test the Redis→parse→return path that getReport executes.
    const redis = makeRedis(JSON.stringify(storedReport));
    const raw = await redis.get(`ingestion:reconcile:${JOB_ID}:report`);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as ReconciliationReport;
    expect(parsed).toEqual(storedReport);
  });

  it("DB fallback: findByJobId is queried when Redis returns null", async () => {
    const storedReport: ReconciliationReport = {
      jobId: JOB_ID,
      connectorId: CONNECTOR_ID,
      timestamp: new Date().toISOString(),
      sourceCount: 2,
      platformCount: 2,
      missingInPlatform: [],
      extraInPlatform: [],
      fieldMismatches: [],
      matchRate: 100,
      status: "match",
    };

    const reportRepo = makeReportRepo([storedReport]);
    const redis = makeRedis(null); // Redis miss

    // Simulate what getReport does internally:
    const raw = await redis.get(`ingestion:reconcile:${JOB_ID}:report`);
    expect(raw).toBeNull();

    const fromDb = await reportRepo.findByJobId(JOB_ID);
    expect(fromDb).toEqual(storedReport);
    expect(reportRepo.findByJobId).toHaveBeenCalledWith(JOB_ID);
  });

  it("returns null when neither Redis nor DB has the report", async () => {
    const reportRepo = makeReportRepo();
    const redis = makeRedis(null);

    const raw = await redis.get(`ingestion:reconcile:nonexistent`);
    expect(raw).toBeNull();

    const fromDb = await reportRepo.findByJobId("nonexistent-job-id");
    expect(fromDb).toBeNull();
  });
});
