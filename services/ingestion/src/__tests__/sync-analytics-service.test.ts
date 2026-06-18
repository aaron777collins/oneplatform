// Unit tests for the sync analytics service.
//
// All tests are fully in-process: SyncService and ConnectorRepository are
// mocked so no Redis or Postgres connection is required. Each test group
// focuses on a single observable behaviour of the analytics service.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createSyncAnalyticsService,
} from "../services/sync-analytics-service.js";
import type {
  SyncAnalyticsService,
} from "../services/sync-analytics-service.js";
import type { SyncService, SyncJobSummary, ListSyncsResult } from "../services/sync-service.js";
import type { ConnectorRepository } from "../services/connector-service.js";
import type { ConnectorRow } from "../repositories/types.js";

// ---------------------------------------------------------------------------
// Test fixture factories
// ---------------------------------------------------------------------------

const CONNECTOR_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CONNECTOR_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const TENANT = "tttttttt-tttt-tttt-tttt-tttttttttttt";

type MockFn = ReturnType<typeof vi.fn>;

interface MockSyncService {
  listSyncs: MockFn;
  triggerSync: MockFn;
  getSyncProgress: MockFn;
  cancelSync: MockFn;
  processSyncJob: MockFn;
  processBatchJob: MockFn;
  runWatchdog: MockFn;
}

function makeSyncService(): MockSyncService {
  return {
    listSyncs: vi.fn(),
    triggerSync: vi.fn(),
    getSyncProgress: vi.fn(),
    cancelSync: vi.fn(),
    processSyncJob: vi.fn(),
    processBatchJob: vi.fn(),
    runWatchdog: vi.fn(),
  };
}

interface MockConnectorRepo {
  findByTenantId: MockFn;
  create: MockFn;
  findById: MockFn;
  findByPluginId: MockFn;
  countByTenantId: MockFn;
  update: MockFn;
  softDelete: MockFn;
}

function makeConnectorRepo(): MockConnectorRepo {
  return {
    findByTenantId: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    findById: vi.fn(),
    findByPluginId: vi.fn(),
    countByTenantId: vi.fn(),
    update: vi.fn(),
    softDelete: vi.fn(),
  };
}

function makeJob(overrides: Partial<SyncJobSummary> = {}): SyncJobSummary {
  return {
    syncJobId: "job-" + Math.random().toString(36).slice(2),
    connectorId: CONNECTOR_A,
    status: "success",
    syncMode: "incremental",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: 1_000,
    rowsIngested: 100,
    rowsFailed: 0,
    error: null,
    ...overrides,
  };
}

function makeEmptyListResult(): ListSyncsResult {
  return { items: [], nextCursor: null, total: 0 };
}

function makeListResult(items: SyncJobSummary[]): ListSyncsResult {
  return { items, nextCursor: null, total: items.length };
}

function makeConnectorRow(id: string, name: string): ConnectorRow {
  return {
    id,
    tenant_id: TENANT,
    plugin_id: "plugin-1",
    instance_id: "inst-1",
    name,
    description: null,
    config: {},
    sync_mode: "incremental",
    schedule_cron: null,
    is_enabled: true,
    created_by: "user-1",
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
  };
}

interface Bundle {
  syncService: MockSyncService;
  connectorRepo: MockConnectorRepo;
  service: SyncAnalyticsService;
}

function makeBundle(): Bundle {
  const syncService = makeSyncService();
  const connectorRepo = makeConnectorRepo();
  const service = createSyncAnalyticsService({
    syncService: syncService as unknown as SyncService,
    connectorRepo: connectorRepo as unknown as ConnectorRepository,
  });
  return { syncService, connectorRepo, service };
}

// ---------------------------------------------------------------------------
// getSyncHistory — basic filtering and pagination
// ---------------------------------------------------------------------------

describe("getSyncHistory — basic usage", () => {
  let bundle: Bundle;

  beforeEach(() => {
    bundle = makeBundle();
  });

  it("returns all items when no date filter is supplied", async () => {
    const jobs = [makeJob(), makeJob(), makeJob()];
    bundle.syncService.listSyncs.mockResolvedValue(makeListResult(jobs));

    const result = await bundle.service.getSyncHistory(CONNECTOR_A, { limit: 10 });
    expect(result.items).toHaveLength(3);
    expect(result.total).toBe(3);
  });

  it("returns empty result when there are no jobs", async () => {
    bundle.syncService.listSyncs.mockResolvedValue(makeEmptyListResult());

    const result = await bundle.service.getSyncHistory(CONNECTOR_A, {});
    expect(result.items).toHaveLength(0);
    expect(result.nextCursor).toBeNull();
    expect(result.total).toBe(0);
  });

  it("filters jobs before the from boundary", async () => {
    const old = makeJob({ startedAt: new Date("2024-01-01T00:00:00Z").toISOString() });
    const recent = makeJob({ startedAt: new Date("2024-06-01T00:00:00Z").toISOString() });
    bundle.syncService.listSyncs.mockResolvedValue(makeListResult([old, recent]));

    const result = await bundle.service.getSyncHistory(CONNECTOR_A, {
      from: new Date("2024-03-01T00:00:00Z"),
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.startedAt).toBe(recent.startedAt);
  });

  it("filters jobs after the to boundary", async () => {
    const early = makeJob({ startedAt: new Date("2024-01-01T00:00:00Z").toISOString() });
    const late = makeJob({ startedAt: new Date("2024-12-01T00:00:00Z").toISOString() });
    bundle.syncService.listSyncs.mockResolvedValue(makeListResult([early, late]));

    const result = await bundle.service.getSyncHistory(CONNECTOR_A, {
      to: new Date("2024-06-01T00:00:00Z"),
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.startedAt).toBe(early.startedAt);
  });

  it("respects the limit option", async () => {
    const jobs = [makeJob(), makeJob(), makeJob(), makeJob(), makeJob()];
    bundle.syncService.listSyncs.mockResolvedValue(makeListResult(jobs));

    const result = await bundle.service.getSyncHistory(CONNECTOR_A, { limit: 2 });
    expect(result.items).toHaveLength(2);
    expect(result.nextCursor).not.toBeNull();
  });

  it("sets nextCursor to null when fewer items than limit are returned", async () => {
    const jobs = [makeJob()];
    bundle.syncService.listSyncs.mockResolvedValue(makeListResult(jobs));

    const result = await bundle.service.getSyncHistory(CONNECTOR_A, { limit: 10 });
    expect(result.nextCursor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getSyncHistory — input validation
// ---------------------------------------------------------------------------

describe("getSyncHistory — input validation", () => {
  let bundle: Bundle;

  beforeEach(() => {
    bundle = makeBundle();
    bundle.syncService.listSyncs.mockResolvedValue(makeEmptyListResult());
  });

  it("throws when connectorId is empty", async () => {
    await expect(
      bundle.service.getSyncHistory("", {}),
    ).rejects.toThrow(/connectorId/);
  });

  it("throws when limit is below 1", async () => {
    await expect(
      bundle.service.getSyncHistory(CONNECTOR_A, { limit: 0 }),
    ).rejects.toThrow(/limit/);
  });

  it("throws when limit exceeds 200", async () => {
    await expect(
      bundle.service.getSyncHistory(CONNECTOR_A, { limit: 201 }),
    ).rejects.toThrow(/limit/);
  });
});

// ---------------------------------------------------------------------------
// getSyncTrends — empty data
// ---------------------------------------------------------------------------

describe("getSyncTrends — empty data", () => {
  let bundle: Bundle;

  beforeEach(() => {
    bundle = makeBundle();
    bundle.syncService.listSyncs.mockResolvedValue(makeEmptyListResult());
  });

  it("returns an empty array when there are no sync jobs", async () => {
    const trends = await bundle.service.getSyncTrends(CONNECTOR_A, "daily");
    expect(trends).toEqual([]);
  });

  it("returns an empty array for hourly period with no jobs", async () => {
    const trends = await bundle.service.getSyncTrends(CONNECTOR_A, "hourly");
    expect(trends).toEqual([]);
  });

  it("throws when connectorId is empty", async () => {
    await expect(
      bundle.service.getSyncTrends("", "daily"),
    ).rejects.toThrow(/connectorId/);
  });
});

// ---------------------------------------------------------------------------
// getSyncTrends — daily aggregation
// ---------------------------------------------------------------------------

describe("getSyncTrends — daily aggregation", () => {
  let bundle: Bundle;

  beforeEach(() => {
    bundle = makeBundle();
  });

  it("groups jobs from the same UTC day into one trend point", async () => {
    // Three jobs in the same UTC day.
    const day = "2024-06-15";
    const jobs = [
      makeJob({ startedAt: `${day}T08:00:00Z`, durationMs: 1_000, rowsIngested: 50 }),
      makeJob({ startedAt: `${day}T12:00:00Z`, durationMs: 2_000, rowsIngested: 100 }),
      makeJob({ startedAt: `${day}T18:00:00Z`, durationMs: 3_000, rowsIngested: 200 }),
    ];
    bundle.syncService.listSyncs.mockResolvedValue(makeListResult(jobs));

    const trends = await bundle.service.getSyncTrends(CONNECTOR_A, "daily");
    expect(trends).toHaveLength(1);
    const point = trends[0]!;
    expect(point.syncCount).toBe(3);
    expect(point.successCount).toBe(3);
    expect(point.failureCount).toBe(0);
    expect(point.totalRecords).toBe(350);
    // avg = (1000 + 2000 + 3000) / 3 = 2000
    expect(point.avgDurationMs).toBe(2_000);
  });

  it("separates jobs on different UTC days into different trend points", async () => {
    const jobs = [
      makeJob({ startedAt: "2024-06-14T23:59:00Z" }),
      makeJob({ startedAt: "2024-06-15T00:01:00Z" }),
    ];
    bundle.syncService.listSyncs.mockResolvedValue(makeListResult(jobs));

    const trends = await bundle.service.getSyncTrends(CONNECTOR_A, "daily");
    expect(trends).toHaveLength(2);
  });

  it("returns trend points in ascending chronological order", async () => {
    const jobs = [
      makeJob({ startedAt: "2024-06-17T12:00:00Z" }),
      makeJob({ startedAt: "2024-06-15T12:00:00Z" }),
      makeJob({ startedAt: "2024-06-16T12:00:00Z" }),
    ];
    bundle.syncService.listSyncs.mockResolvedValue(makeListResult(jobs));

    const trends = await bundle.service.getSyncTrends(CONNECTOR_A, "daily");
    expect(trends).toHaveLength(3);
    const periods = trends.map((t) => t.period);
    expect(periods[0]! < periods[1]!).toBe(true);
    expect(periods[1]! < periods[2]!).toBe(true);
  });

  it("counts successes and failures accurately", async () => {
    const jobs = [
      makeJob({ status: "success" }),
      makeJob({ status: "success" }),
      makeJob({ status: "failed" }),
      makeJob({ status: "cancelled" }),
    ];
    bundle.syncService.listSyncs.mockResolvedValue(makeListResult(jobs));

    const trends = await bundle.service.getSyncTrends(CONNECTOR_A, "daily");
    const point = trends[0]!;
    expect(point.successCount).toBe(2);
    expect(point.failureCount).toBe(1);
    // cancelled is neither success nor failure
    expect(point.syncCount).toBe(4);
  });

  it("excludes in-flight jobs (durationMs=null) from duration stats", async () => {
    const day = "2024-06-15";
    const jobs = [
      makeJob({ startedAt: `${day}T08:00:00Z`, durationMs: 1_000 }),
      makeJob({ startedAt: `${day}T09:00:00Z`, durationMs: null, completedAt: null, status: "running" }),
    ];
    bundle.syncService.listSyncs.mockResolvedValue(makeListResult(jobs));

    const trends = await bundle.service.getSyncTrends(CONNECTOR_A, "daily");
    const point = trends[0]!;
    // Only the completed job contributes to duration stats.
    expect(point.avgDurationMs).toBe(1_000);
    expect(point.p95DurationMs).toBe(1_000);
  });

  it("reports avgDurationMs=0 when all jobs are still running", async () => {
    const jobs = [
      makeJob({ durationMs: null, completedAt: null, status: "running" }),
    ];
    bundle.syncService.listSyncs.mockResolvedValue(makeListResult(jobs));

    const trends = await bundle.service.getSyncTrends(CONNECTOR_A, "daily");
    expect(trends[0]!.avgDurationMs).toBe(0);
    expect(trends[0]!.p95DurationMs).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getSyncTrends — hourly and weekly periods
// ---------------------------------------------------------------------------

describe("getSyncTrends — hourly period", () => {
  let bundle: Bundle;

  beforeEach(() => {
    bundle = makeBundle();
  });

  it("groups jobs by hour when period=hourly", async () => {
    const jobs = [
      makeJob({ startedAt: "2024-06-15T08:10:00Z" }),
      makeJob({ startedAt: "2024-06-15T08:50:00Z" }),
      makeJob({ startedAt: "2024-06-15T09:05:00Z" }),
    ];
    bundle.syncService.listSyncs.mockResolvedValue(makeListResult(jobs));

    const trends = await bundle.service.getSyncTrends(CONNECTOR_A, "hourly");
    expect(trends).toHaveLength(2);
    expect(trends[0]!.syncCount).toBe(2);
    expect(trends[1]!.syncCount).toBe(1);
  });

  it("aligns hourly period to the top of the hour", async () => {
    const jobs = [makeJob({ startedAt: "2024-06-15T08:45:00Z" })];
    bundle.syncService.listSyncs.mockResolvedValue(makeListResult(jobs));

    const trends = await bundle.service.getSyncTrends(CONNECTOR_A, "hourly");
    // Period should be 08:00:00, not 08:45:00
    expect(trends[0]!.period).toBe(new Date("2024-06-15T08:00:00.000Z").toISOString());
  });
});

describe("getSyncTrends — weekly period", () => {
  let bundle: Bundle;

  beforeEach(() => {
    bundle = makeBundle();
  });

  it("groups jobs in the same ISO week into one trend point", async () => {
    // 2024-06-10 (Monday) and 2024-06-14 (Friday) are in the same ISO week.
    const jobs = [
      makeJob({ startedAt: "2024-06-10T12:00:00Z" }),
      makeJob({ startedAt: "2024-06-14T12:00:00Z" }),
    ];
    bundle.syncService.listSyncs.mockResolvedValue(makeListResult(jobs));

    const trends = await bundle.service.getSyncTrends(CONNECTOR_A, "weekly");
    expect(trends).toHaveLength(1);
    expect(trends[0]!.syncCount).toBe(2);
  });

  it("aligns weekly period to Monday 00:00 UTC", async () => {
    // 2024-06-12 is a Wednesday; its ISO week starts on 2024-06-10 (Monday).
    const jobs = [makeJob({ startedAt: "2024-06-12T15:00:00Z" })];
    bundle.syncService.listSyncs.mockResolvedValue(makeListResult(jobs));

    const trends = await bundle.service.getSyncTrends(CONNECTOR_A, "weekly");
    expect(trends[0]!.period).toBe(new Date("2024-06-10T00:00:00.000Z").toISOString());
  });

  it("places Sunday into the previous week (ISO week convention)", async () => {
    // 2024-06-09 is a Sunday — belongs to the week starting 2024-06-03.
    // 2024-06-10 is a Monday — belongs to the week starting 2024-06-10.
    const jobs = [
      makeJob({ startedAt: "2024-06-09T12:00:00Z" }),
      makeJob({ startedAt: "2024-06-10T12:00:00Z" }),
    ];
    bundle.syncService.listSyncs.mockResolvedValue(makeListResult(jobs));

    const trends = await bundle.service.getSyncTrends(CONNECTOR_A, "weekly");
    expect(trends).toHaveLength(2);
    expect(trends[0]!.period).toBe(new Date("2024-06-03T00:00:00.000Z").toISOString());
    expect(trends[1]!.period).toBe(new Date("2024-06-10T00:00:00.000Z").toISOString());
  });
});

// ---------------------------------------------------------------------------
// getSyncTrends — percentile calculations
// ---------------------------------------------------------------------------

describe("getSyncTrends — percentile calculations", () => {
  let bundle: Bundle;

  beforeEach(() => {
    bundle = makeBundle();
  });

  it("computes p95 as the 95th-nearest-rank value of completed durations", async () => {
    // 20 jobs with durations 100, 200, ..., 2000 ms — p95 = 1900 ms
    // nearest-rank: ceil(0.95 * 20) = 19th element = 1900
    const jobs = Array.from({ length: 20 }, (_, i) =>
      makeJob({ durationMs: (i + 1) * 100 }),
    );
    bundle.syncService.listSyncs.mockResolvedValue(makeListResult(jobs));

    const trends = await bundle.service.getSyncTrends(CONNECTOR_A, "daily");
    expect(trends[0]!.p95DurationMs).toBe(1_900);
  });

  it("returns p95 equal to the single value when only one completed job exists", async () => {
    const jobs = [makeJob({ durationMs: 500 })];
    bundle.syncService.listSyncs.mockResolvedValue(makeListResult(jobs));

    const trends = await bundle.service.getSyncTrends(CONNECTOR_A, "daily");
    expect(trends[0]!.p95DurationMs).toBe(500);
  });

  it("computes p95 correctly for two jobs", async () => {
    // Two jobs: 100 and 200. p95 = ceil(0.95*2)=2nd = 200.
    const jobs = [
      makeJob({ durationMs: 100 }),
      makeJob({ durationMs: 200 }),
    ];
    bundle.syncService.listSyncs.mockResolvedValue(makeListResult(jobs));

    const trends = await bundle.service.getSyncTrends(CONNECTOR_A, "daily");
    expect(trends[0]!.p95DurationMs).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// getTenantOverview — empty tenant
// ---------------------------------------------------------------------------

describe("getTenantOverview — empty tenant", () => {
  let bundle: Bundle;

  beforeEach(() => {
    bundle = makeBundle();
    bundle.connectorRepo.findByTenantId.mockResolvedValue([]);
  });

  it("returns zero counts when tenant has no connectors", async () => {
    const overview = await bundle.service.getTenantOverview(TENANT);
    expect(overview.totalSyncs24h).toBe(0);
    expect(overview.totalSyncs7d).toBe(0);
    expect(overview.totalSyncs30d).toBe(0);
    expect(overview.totalRecords).toBe(0);
  });

  it("returns empty arrays for top/failing connectors", async () => {
    const overview = await bundle.service.getTenantOverview(TENANT);
    expect(overview.topConnectors).toEqual([]);
    expect(overview.failingConnectors).toEqual([]);
  });

  it("returns avgDurationMs=0 with no data", async () => {
    const overview = await bundle.service.getTenantOverview(TENANT);
    expect(overview.avgDurationMs).toBe(0);
  });

  it("throws when tenantId is empty", async () => {
    await expect(
      bundle.service.getTenantOverview(""),
    ).rejects.toThrow(/tenantId/);
  });
});

// ---------------------------------------------------------------------------
// getTenantOverview — time window counts
// ---------------------------------------------------------------------------

describe("getTenantOverview — time window counts", () => {
  let bundle: Bundle;

  beforeEach(() => {
    bundle = makeBundle();
    bundle.connectorRepo.findByTenantId.mockResolvedValue([
      makeConnectorRow(CONNECTOR_A, "connector-a"),
    ]);
  });

  it("counts syncs within 24h correctly", async () => {
    const now = Date.now();
    const jobs = [
      makeJob({ startedAt: new Date(now - 1 * 60 * 60 * 1_000).toISOString() }),   // 1 hour ago
      makeJob({ startedAt: new Date(now - 25 * 60 * 60 * 1_000).toISOString() }),  // 25 hours ago (outside 24h)
    ];
    bundle.syncService.listSyncs.mockResolvedValue(makeListResult(jobs));

    const overview = await bundle.service.getTenantOverview(TENANT);
    expect(overview.totalSyncs24h).toBe(1);
    expect(overview.totalSyncs7d).toBe(2);
    expect(overview.totalSyncs30d).toBe(2);
  });

  it("counts syncs within 7d correctly", async () => {
    const now = Date.now();
    const jobs = [
      makeJob({ startedAt: new Date(now - 2 * 24 * 60 * 60 * 1_000).toISOString() }),   // 2 days ago
      makeJob({ startedAt: new Date(now - 8 * 24 * 60 * 60 * 1_000).toISOString() }),   // 8 days ago
    ];
    bundle.syncService.listSyncs.mockResolvedValue(makeListResult(jobs));

    const overview = await bundle.service.getTenantOverview(TENANT);
    expect(overview.totalSyncs7d).toBe(1);
    expect(overview.totalSyncs30d).toBe(2);
  });

  it("excludes syncs older than 30 days from all counters", async () => {
    const now = Date.now();
    const jobs = [
      makeJob({ startedAt: new Date(now - 31 * 24 * 60 * 60 * 1_000).toISOString() }),
    ];
    bundle.syncService.listSyncs.mockResolvedValue(makeListResult(jobs));

    const overview = await bundle.service.getTenantOverview(TENANT);
    expect(overview.totalSyncs30d).toBe(0);
    expect(overview.totalSyncs7d).toBe(0);
    expect(overview.totalSyncs24h).toBe(0);
  });

  it("sums totalRecords across all connectors in the 30-day window", async () => {
    bundle.connectorRepo.findByTenantId.mockResolvedValue([
      makeConnectorRow(CONNECTOR_A, "connector-a"),
      makeConnectorRow(CONNECTOR_B, "connector-b"),
    ]);

    const now = Date.now();
    const recentTs = new Date(now - 1 * 60 * 60 * 1_000).toISOString();

    bundle.syncService.listSyncs
      .mockResolvedValueOnce(makeListResult([makeJob({ rowsIngested: 300, startedAt: recentTs })]))
      .mockResolvedValueOnce(makeListResult([makeJob({ rowsIngested: 200, startedAt: recentTs })]));

    const overview = await bundle.service.getTenantOverview(TENANT);
    expect(overview.totalRecords).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// getTenantOverview — top and failing connectors
// ---------------------------------------------------------------------------

describe("getTenantOverview — top connectors", () => {
  let bundle: Bundle;

  beforeEach(() => {
    bundle = makeBundle();
  });

  it("returns up to 5 top connectors by sync count", async () => {
    const connectors = Array.from({ length: 7 }, (_, i) =>
      makeConnectorRow(`conn-${i}`, `Connector ${i}`),
    );
    bundle.connectorRepo.findByTenantId.mockResolvedValue(connectors);

    const now = Date.now();
    const recentTs = new Date(now - 60 * 60 * 1_000).toISOString();

    // Give each connector a different number of syncs so ranking is deterministic.
    connectors.forEach((_, i) => {
      const jobs = Array.from({ length: i + 1 }, () =>
        makeJob({ startedAt: recentTs }),
      );
      bundle.syncService.listSyncs.mockResolvedValueOnce(makeListResult(jobs));
    });

    const overview = await bundle.service.getTenantOverview(TENANT);
    expect(overview.topConnectors.length).toBeLessThanOrEqual(5);
    // Top connector should have the highest sync count.
    const counts = overview.topConnectors.map((c) => c.syncCount);
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i - 1]!).toBeGreaterThanOrEqual(counts[i]!);
    }
  });
});

describe("getTenantOverview — failing connectors", () => {
  let bundle: Bundle;

  beforeEach(() => {
    bundle = makeBundle();
  });

  it("includes connectors whose failure rate exceeds 25% and have ≥3 runs", async () => {
    bundle.connectorRepo.findByTenantId.mockResolvedValue([
      makeConnectorRow(CONNECTOR_A, "connector-a"),
    ]);

    const now = Date.now();
    const recentTs = new Date(now - 60 * 60 * 1_000).toISOString();

    // 2 failures out of 4 runs = 50% failure rate.
    const jobs = [
      makeJob({ status: "failed", startedAt: recentTs }),
      makeJob({ status: "failed", startedAt: recentTs }),
      makeJob({ status: "success", startedAt: recentTs }),
      makeJob({ status: "success", startedAt: recentTs }),
    ];
    bundle.syncService.listSyncs.mockResolvedValue(makeListResult(jobs));

    const overview = await bundle.service.getTenantOverview(TENANT);
    expect(overview.failingConnectors).toHaveLength(1);
    expect(overview.failingConnectors[0]!.failureRate).toBeCloseTo(0.5);
    expect(overview.failingConnectors[0]!.id).toBe(CONNECTOR_A);
  });

  it("excludes connectors below the 3-run minimum", async () => {
    bundle.connectorRepo.findByTenantId.mockResolvedValue([
      makeConnectorRow(CONNECTOR_A, "connector-a"),
    ]);

    const now = Date.now();
    const recentTs = new Date(now - 60 * 60 * 1_000).toISOString();

    // 1 failure out of 2 runs — below the 3-run minimum.
    const jobs = [
      makeJob({ status: "failed", startedAt: recentTs }),
      makeJob({ status: "success", startedAt: recentTs }),
    ];
    bundle.syncService.listSyncs.mockResolvedValue(makeListResult(jobs));

    const overview = await bundle.service.getTenantOverview(TENANT);
    expect(overview.failingConnectors).toHaveLength(0);
  });

  it("excludes connectors whose failure rate is below 25%", async () => {
    bundle.connectorRepo.findByTenantId.mockResolvedValue([
      makeConnectorRow(CONNECTOR_A, "connector-a"),
    ]);

    const now = Date.now();
    const recentTs = new Date(now - 60 * 60 * 1_000).toISOString();

    // 1 failure out of 5 runs = 20% failure rate.
    const jobs = [
      makeJob({ status: "failed", startedAt: recentTs }),
      makeJob({ status: "success", startedAt: recentTs }),
      makeJob({ status: "success", startedAt: recentTs }),
      makeJob({ status: "success", startedAt: recentTs }),
      makeJob({ status: "success", startedAt: recentTs }),
    ];
    bundle.syncService.listSyncs.mockResolvedValue(makeListResult(jobs));

    const overview = await bundle.service.getTenantOverview(TENANT);
    expect(overview.failingConnectors).toHaveLength(0);
  });

  it("handles mixed success/failure connectors across the tenant", async () => {
    bundle.connectorRepo.findByTenantId.mockResolvedValue([
      makeConnectorRow(CONNECTOR_A, "healthy-connector"),
      makeConnectorRow(CONNECTOR_B, "failing-connector"),
    ]);

    const now = Date.now();
    const recentTs = new Date(now - 60 * 60 * 1_000).toISOString();

    // Connector A: 0% failure rate (healthy).
    bundle.syncService.listSyncs
      .mockResolvedValueOnce(makeListResult([
        makeJob({ connectorId: CONNECTOR_A, status: "success", startedAt: recentTs }),
        makeJob({ connectorId: CONNECTOR_A, status: "success", startedAt: recentTs }),
        makeJob({ connectorId: CONNECTOR_A, status: "success", startedAt: recentTs }),
      ]))
      // Connector B: 75% failure rate (failing).
      .mockResolvedValueOnce(makeListResult([
        makeJob({ connectorId: CONNECTOR_B, status: "failed", startedAt: recentTs }),
        makeJob({ connectorId: CONNECTOR_B, status: "failed", startedAt: recentTs }),
        makeJob({ connectorId: CONNECTOR_B, status: "failed", startedAt: recentTs }),
        makeJob({ connectorId: CONNECTOR_B, status: "success", startedAt: recentTs }),
      ]));

    const overview = await bundle.service.getTenantOverview(TENANT);
    expect(overview.failingConnectors).toHaveLength(1);
    expect(overview.failingConnectors[0]!.name).toBe("failing-connector");
  });
});

// ---------------------------------------------------------------------------
// getTenantOverview — error resilience
// ---------------------------------------------------------------------------

describe("getTenantOverview — error resilience", () => {
  let bundle: Bundle;

  beforeEach(() => {
    bundle = makeBundle();
    bundle.connectorRepo.findByTenantId.mockResolvedValue([
      makeConnectorRow(CONNECTOR_A, "connector-a"),
    ]);
  });

  it("gracefully skips a connector when listSyncs fails for it", async () => {
    // listSyncs rejects — the overview should still complete with 0 for that connector.
    bundle.syncService.listSyncs.mockRejectedValue(new Error("Redis connection lost"));

    // Should not throw.
    const overview = await bundle.service.getTenantOverview(TENANT);
    expect(overview.totalSyncs30d).toBe(0);
  });
});
