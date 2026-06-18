// Unit tests for MeteringService.
//
// All external I/O (Redis, repositories) is mocked so tests run without a
// real database or Redis instance.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMeteringService } from "../services/metering-service.js";
import type { MeteringServiceDeps } from "../services/metering-service.js";
import type { UsageEventRow, UsageSummaryRow } from "../repositories/types.js";

// ---------------------------------------------------------------------------
// Fixture factories
// ---------------------------------------------------------------------------

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    audit: vi.fn().mockResolvedValue(undefined),
    withTraceId: vi.fn().mockReturnThis(),
  };
}

function makeRedis() {
  const pipelineMock = {
    hincrbyfloat: vi.fn().mockReturnThis(),
    expire: vi.fn().mockReturnThis(),
    sadd: vi.fn().mockReturnThis(),
    hset: vi.fn().mockReturnThis(),
    hgetall: vi.fn().mockReturnThis(),
    del: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([
      [null, {}], // hgetall result
      [null, {}], // hgetall meta result
      [null, 1],  // del result
      [null, 1],  // del result
    ]),
  };

  return {
    pipeline: vi.fn().mockReturnValue(pipelineMock),
    smembers: vi.fn().mockResolvedValue([]),
    del: vi.fn().mockResolvedValue(1),
    _pipeline: pipelineMock,
  };
}

function makeUsageEventRepo() {
  return {
    insertBatch: vi.fn().mockResolvedValue(undefined),
    findByTenantIdAndPeriod: vi.fn().mockResolvedValue([]),
    aggregateByTenantAndPeriod: vi.fn().mockResolvedValue([]),
  };
}

function makeUsageSummaryRepo() {
  return {
    upsertBucket: vi.fn().mockResolvedValue(undefined),
    findByTenantAndPeriodType: vi.fn().mockResolvedValue([]),
  };
}

function makeBillingWebhookConfigRepo() {
  return {
    upsert: vi.fn().mockResolvedValue({}),
    findByTenantId: vi.fn().mockResolvedValue(null),
    delete: vi.fn().mockResolvedValue(true),
  };
}

function makeDeps(overrides: Partial<MeteringServiceDeps> = {}): MeteringServiceDeps {
  return {
    redis: makeRedis() as unknown as MeteringServiceDeps["redis"],
    usageEventRepo: makeUsageEventRepo() as unknown as MeteringServiceDeps["usageEventRepo"],
    usageSummaryRepo: makeUsageSummaryRepo() as unknown as MeteringServiceDeps["usageSummaryRepo"],
    billingWebhookConfigRepo: makeBillingWebhookConfigRepo() as unknown as MeteringServiceDeps["billingWebhookConfigRepo"],
    logger: makeLogger() as unknown as MeteringServiceDeps["logger"],
    ...overrides,
  };
}

// Drains the microtask queue for fire-and-forget Promises in vitest 1.x.
// In vitest 2.x one could use vi.runAllMicroTasksAsync(); here we chain a
// resolved Promise so that all queued microtasks execute before the assertion.
async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// recordApiCall / recordRowsIngested / recordStorageUsage
// ---------------------------------------------------------------------------

describe("MeteringService — recording methods", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("recordApiCall increments Redis counter via pipeline", async () => {
    const deps = makeDeps();
    const svc = createMeteringService(deps);

    svc.recordApiCall("tenant-1", "/api/v1/data", "GET");

    await flushPromises();

    const redis = deps.redis as unknown as ReturnType<typeof makeRedis>;
    expect(redis.pipeline).toHaveBeenCalled();
    expect(redis._pipeline.hincrbyfloat).toHaveBeenCalledWith(
      expect.stringContaining("tenant-1"),
      "api_call",
      1,
    );
  });

  it("recordRowsIngested skips zero-count batches", async () => {
    const deps = makeDeps();
    const svc = createMeteringService(deps);

    svc.recordRowsIngested("tenant-1", "conn-123", 0);

    await flushPromises();

    const redis = deps.redis as unknown as ReturnType<typeof makeRedis>;
    // pipeline should NOT have been called for a zero-count batch
    expect(redis.pipeline).not.toHaveBeenCalled();
  });

  it("recordRowsIngested increments for positive counts", async () => {
    const deps = makeDeps();
    const svc = createMeteringService(deps);

    svc.recordRowsIngested("tenant-1", "conn-123", 500);

    await flushPromises();

    const redis = deps.redis as unknown as ReturnType<typeof makeRedis>;
    expect(redis._pipeline.hincrbyfloat).toHaveBeenCalledWith(
      expect.stringContaining("tenant-1"),
      "rows_ingested",
      500,
    );
  });

  it("recordStorageUsage skips zero-byte deltas", async () => {
    const deps = makeDeps();
    const svc = createMeteringService(deps);

    svc.recordStorageUsage("tenant-1", 0);

    await flushPromises();

    const redis = deps.redis as unknown as ReturnType<typeof makeRedis>;
    expect(redis.pipeline).not.toHaveBeenCalled();
  });

  it("Redis errors are swallowed and logged, not re-thrown", async () => {
    const redisBase = makeRedis();
    const pipelineInstance = {
      ...redisBase._pipeline,
      exec: vi.fn().mockRejectedValue(new Error("Redis connection lost")),
    };
    redisBase.pipeline = vi.fn().mockReturnValue(pipelineInstance);

    const deps = makeDeps({
      redis: redisBase as unknown as MeteringServiceDeps["redis"],
    });
    const svc = createMeteringService(deps);

    // Must not throw even if Redis is down
    expect(() => {
      svc.recordApiCall("tenant-1", "/api/v1/data", "POST");
    }).not.toThrow();

    await flushPromises();

    expect(deps.logger.warn).toHaveBeenCalledWith(
      "Failed to increment metering counter in Redis",
      expect.objectContaining({ tenantId: "tenant-1", type: "api_call" }),
    );
  });
});

// ---------------------------------------------------------------------------
// getUsageSummary
// ---------------------------------------------------------------------------

describe("MeteringService.getUsageSummary()", () => {
  it("returns zeros when there are no events or summaries", async () => {
    const deps = makeDeps();
    const svc = createMeteringService(deps);

    const summary = await svc.getUsageSummary("tenant-1", "monthly");

    expect(summary.tenantId).toBe("tenant-1");
    expect(summary.apiCalls).toBe(0);
    expect(summary.rowsIngested).toBe(0);
    expect(summary.storageBytes).toBe(0);
    expect(summary.pipelineExecutions).toBe(0);
    expect(summary.period).toMatch(/^\d{4}-\d{2}$/); // "YYYY-MM"
  });

  it("uses pre-aggregated summaries when available", async () => {
    const summaryRows: UsageSummaryRow[] = [
      {
        id: "s-1",
        tenant_id: "tenant-1",
        period_type: "monthly",
        period_start: new Date(),
        event_type: "api_call",
        total_value: 1500n,
        event_count: 1n,
        updated_at: new Date(),
      },
      {
        id: "s-2",
        tenant_id: "tenant-1",
        period_type: "monthly",
        period_start: new Date(),
        event_type: "rows_ingested",
        total_value: 25000n,
        event_count: 1n,
        updated_at: new Date(),
      },
    ];

    const usageSummaryRepo = makeUsageSummaryRepo();
    usageSummaryRepo.findByTenantAndPeriodType = vi.fn().mockResolvedValue(summaryRows);

    const deps = makeDeps({
      usageSummaryRepo: usageSummaryRepo as unknown as MeteringServiceDeps["usageSummaryRepo"],
    });
    const svc = createMeteringService(deps);

    const summary = await svc.getUsageSummary("tenant-1", "monthly");

    expect(summary.apiCalls).toBe(1500);
    expect(summary.rowsIngested).toBe(25000);
    // Falls back to aggregateByTenantAndPeriod is NOT called when summaries exist
    expect(deps.usageEventRepo.aggregateByTenantAndPeriod).not.toHaveBeenCalled();
  });

  it("falls back to event aggregation when no summaries exist", async () => {
    const aggregateResult = [
      { type: "api_call" as const, total: 99n },
      { type: "pipeline_execution" as const, total: 3n },
    ];

    const usageEventRepo = makeUsageEventRepo();
    usageEventRepo.aggregateByTenantAndPeriod = vi.fn().mockResolvedValue(aggregateResult);

    const deps = makeDeps({
      usageEventRepo: usageEventRepo as unknown as MeteringServiceDeps["usageEventRepo"],
    });
    const svc = createMeteringService(deps);

    const summary = await svc.getUsageSummary("tenant-1", "daily");

    expect(summary.apiCalls).toBe(99);
    expect(summary.pipelineExecutions).toBe(3);
  });

  it("returns correct period label for hourly period", async () => {
    const deps = makeDeps();
    const svc = createMeteringService(deps);

    const summary = await svc.getUsageSummary("tenant-1", "hourly");

    // Hourly label format: "YYYY-MM-DDTHH"
    expect(summary.period).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}$/);
  });
});

// ---------------------------------------------------------------------------
// getUsageByTenant
// ---------------------------------------------------------------------------

describe("MeteringService.getUsageByTenant()", () => {
  it("maps DB rows to UsageEvent shape", async () => {
    const now = new Date();
    const rows: UsageEventRow[] = [
      {
        id: "e-1",
        tenant_id: "tenant-1",
        type: "api_call",
        value: 1n,
        metadata: { endpoint: "/api/v1/data", method: "GET" },
        timestamp: now,
      },
    ];

    const usageEventRepo = makeUsageEventRepo();
    usageEventRepo.findByTenantIdAndPeriod = vi.fn().mockResolvedValue(rows);

    const deps = makeDeps({
      usageEventRepo: usageEventRepo as unknown as MeteringServiceDeps["usageEventRepo"],
    });
    const svc = createMeteringService(deps);

    const from = new Date(now.getTime() - 3600_000);
    const events = await svc.getUsageByTenant("tenant-1", from, now);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tenantId: "tenant-1",
      type: "api_call",
      value: 1,
      metadata: { endpoint: "/api/v1/data", method: "GET" },
    });
    expect(typeof events[0]?.timestamp).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// flushPendingEvents — event recording and aggregation
// ---------------------------------------------------------------------------

describe("MeteringService.flushPendingEvents()", () => {
  it("does nothing when there are no pending tenants", async () => {
    const redisBase = makeRedis();
    redisBase.smembers = vi.fn().mockResolvedValue([]);

    const deps = makeDeps({
      redis: redisBase as unknown as MeteringServiceDeps["redis"],
    });
    const svc = createMeteringService(deps);

    await svc.flushPendingEvents();

    expect(deps.usageEventRepo.insertBatch).not.toHaveBeenCalled();
  });

  it("inserts events and upserts summary buckets for pending tenants", async () => {
    const redisBase = makeRedis();
    redisBase.smembers = vi.fn().mockResolvedValue(["tenant-A"]);

    // Simulate a counter hash with two event types
    const pipelineMock = {
      hgetall: vi.fn().mockReturnThis(),
      del: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([
        [null, { api_call: "42", rows_ingested: "1000" }], // counters
        [null, {}],                                         // meta
        [null, 1],                                          // del
        [null, 1],                                          // del
      ]),
    };
    redisBase.pipeline = vi.fn().mockReturnValue(pipelineMock);

    const deps = makeDeps({
      redis: redisBase as unknown as MeteringServiceDeps["redis"],
    });
    const svc = createMeteringService(deps);

    await svc.flushPendingEvents();

    expect(deps.usageEventRepo.insertBatch).toHaveBeenCalledOnce();
    const firstCall = (
      deps.usageEventRepo.insertBatch as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    const insertedEvents = (firstCall?.[0] ?? []) as Array<{ type: string; value: number; tenant_id: string }>;
    expect(insertedEvents).toHaveLength(2);

    const apiCall = insertedEvents.find((e) => e.type === "api_call");
    expect(apiCall?.value).toBe(42);
    expect(apiCall?.tenant_id).toBe("tenant-A");

    const rowsIngested = insertedEvents.find((e) => e.type === "rows_ingested");
    expect(rowsIngested?.value).toBe(1000);

    // Summary buckets: 2 event types × 3 period granularities = 6 upserts
    expect(deps.usageSummaryRepo.upsertBucket).toHaveBeenCalledTimes(6);
  });

  it("continues flushing other tenants if one fails", async () => {
    const redisBase = makeRedis();
    redisBase.smembers = vi.fn().mockResolvedValue(["tenant-fail", "tenant-ok"]);

    const pipelineMock = {
      hgetall: vi.fn().mockReturnThis(),
      del: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([
        [null, { api_call: "10" }],
        [null, {}],
        [null, 1],
        [null, 1],
      ]),
    };
    redisBase.pipeline = vi.fn().mockReturnValue(pipelineMock);

    const usageEventRepo = makeUsageEventRepo();
    let insertCallCount = 0;
    usageEventRepo.insertBatch = vi.fn().mockImplementation(() => {
      insertCallCount++;
      // Fail only the first call (tenant-fail)
      if (insertCallCount === 1) {
        return Promise.reject(new Error("DB connection failed"));
      }
      return Promise.resolve();
    });

    const deps = makeDeps({
      redis: redisBase as unknown as MeteringServiceDeps["redis"],
      usageEventRepo: usageEventRepo as unknown as MeteringServiceDeps["usageEventRepo"],
    });
    const svc = createMeteringService(deps);

    // Must not throw even with a partial failure
    await expect(svc.flushPendingEvents()).resolves.not.toThrow();

    // Both tenants were attempted
    expect(usageEventRepo.insertBatch).toHaveBeenCalledTimes(2);
    // The failure was logged
    expect(deps.logger.error).toHaveBeenCalledWith(
      "Failed to flush usage events to DB",
      expect.objectContaining({ tenantId: "tenant-fail" }),
    );
  });

  it("skips zero-value counters without inserting rows", async () => {
    const redisBase = makeRedis();
    redisBase.smembers = vi.fn().mockResolvedValue(["tenant-B"]);

    const pipelineMock = {
      hgetall: vi.fn().mockReturnThis(),
      del: vi.fn().mockReturnThis(),
      // All counters are zero
      exec: vi.fn().mockResolvedValue([
        [null, { api_call: "0", rows_ingested: "0" }],
        [null, {}],
        [null, 1],
        [null, 1],
      ]),
    };
    redisBase.pipeline = vi.fn().mockReturnValue(pipelineMock);

    const deps = makeDeps({
      redis: redisBase as unknown as MeteringServiceDeps["redis"],
    });
    const svc = createMeteringService(deps);

    await svc.flushPendingEvents();

    // No rows should be inserted for all-zero counters
    expect(deps.usageEventRepo.insertBatch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Period boundaries — hourly / daily / monthly rollover
// ---------------------------------------------------------------------------

describe("MeteringService — period boundary correctness", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("monthly period start is always the first of the month at midnight UTC", async () => {
    const usageSummaryRepo = makeUsageSummaryRepo();
    let capturedPeriodStart: Date | undefined;
    usageSummaryRepo.upsertBucket = vi.fn().mockImplementation(
      (_tid: string, periodType: string, periodStart: Date) => {
        if (periodType === "monthly") capturedPeriodStart = periodStart;
        return Promise.resolve();
      },
    );

    // Simulate a flush that happens mid-month
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-03-15T14:32:00Z"));

    const redisBase = makeRedis();
    redisBase.smembers = vi.fn().mockResolvedValue(["t1"]);
    const pipelineMock = {
      hgetall: vi.fn().mockReturnThis(),
      del: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([
        [null, { api_call: "5" }],
        [null, {}],
        [null, 1],
        [null, 1],
      ]),
    };
    redisBase.pipeline = vi.fn().mockReturnValue(pipelineMock);

    const deps = makeDeps({
      redis: redisBase as unknown as MeteringServiceDeps["redis"],
      usageSummaryRepo: usageSummaryRepo as unknown as MeteringServiceDeps["usageSummaryRepo"],
    });
    const svc = createMeteringService(deps);

    await svc.flushPendingEvents();

    vi.useRealTimers();

    expect(capturedPeriodStart?.toISOString()).toBe("2024-03-01T00:00:00.000Z");
  });

  it("hourly period start truncates minutes and seconds", async () => {
    const usageSummaryRepo = makeUsageSummaryRepo();
    let capturedHourlyStart: Date | undefined;
    usageSummaryRepo.upsertBucket = vi.fn().mockImplementation(
      (_tid: string, periodType: string, periodStart: Date) => {
        if (periodType === "hourly") capturedHourlyStart = periodStart;
        return Promise.resolve();
      },
    );

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-03-15T14:47:55Z"));

    const redisBase = makeRedis();
    redisBase.smembers = vi.fn().mockResolvedValue(["t1"]);
    const pipelineMock = {
      hgetall: vi.fn().mockReturnThis(),
      del: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([
        [null, { api_call: "1" }],
        [null, {}],
        [null, 1],
        [null, 1],
      ]),
    };
    redisBase.pipeline = vi.fn().mockReturnValue(pipelineMock);

    const deps = makeDeps({
      redis: redisBase as unknown as MeteringServiceDeps["redis"],
      usageSummaryRepo: usageSummaryRepo as unknown as MeteringServiceDeps["usageSummaryRepo"],
    });
    const svc = createMeteringService(deps);

    await svc.flushPendingEvents();

    vi.useRealTimers();

    expect(capturedHourlyStart?.toISOString()).toBe("2024-03-15T14:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// Billing webhook delivery
// ---------------------------------------------------------------------------

describe("MeteringService — billing webhook threshold checks", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("does not attempt delivery when no billing config is registered", async () => {
    const redisBase = makeRedis();
    redisBase.smembers = vi.fn().mockResolvedValue(["tenant-1"]);
    const pipelineMock = {
      hgetall: vi.fn().mockReturnThis(),
      del: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([
        [null, { api_call: "100" }],
        [null, {}],
        [null, 1],
        [null, 1],
      ]),
    };
    redisBase.pipeline = vi.fn().mockReturnValue(pipelineMock);

    const billingWebhookConfigRepo = makeBillingWebhookConfigRepo();
    billingWebhookConfigRepo.findByTenantId = vi.fn().mockResolvedValue(null);

    const deps = makeDeps({
      redis: redisBase as unknown as MeteringServiceDeps["redis"],
      billingWebhookConfigRepo: billingWebhookConfigRepo as unknown as MeteringServiceDeps["billingWebhookConfigRepo"],
    });
    const svc = createMeteringService(deps);

    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await svc.flushPendingEvents();

    // No HTTP call should be made when there is no config
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("logs a warning but does not throw when webhook delivery fails", async () => {
    const redisBase = makeRedis();
    redisBase.smembers = vi.fn().mockResolvedValue(["tenant-1"]);
    const pipelineMock = {
      hgetall: vi.fn().mockReturnThis(),
      del: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([
        [null, { api_call: "10" }],
        [null, {}],
        [null, 1],
        [null, 1],
      ]),
    };
    redisBase.pipeline = vi.fn().mockReturnValue(pipelineMock);

    const billingWebhookConfigRepo = makeBillingWebhookConfigRepo();
    billingWebhookConfigRepo.findByTenantId = vi.fn().mockResolvedValue({
      id: "config-1",
      tenant_id: "tenant-1",
      url: "https://billing.example.com/webhook",
      provider: "custom",
      api_call_threshold: 5n,  // threshold exceeded (10 > 5)
      rows_ingested_threshold: null,
      storage_bytes_threshold: null,
      secret_encrypted: null,
      enabled: true,
      created_at: new Date(),
      updated_at: new Date(),
    });

    const usageSummaryRepo = makeUsageSummaryRepo();
    usageSummaryRepo.findByTenantAndPeriodType = vi.fn().mockResolvedValue([
      {
        id: "s-1",
        tenant_id: "tenant-1",
        period_type: "monthly",
        period_start: new Date(),
        event_type: "api_call",
        total_value: 10n,
        event_count: 1n,
        updated_at: new Date(),
      },
    ]);

    // Simulate fetch failure (non-2xx response)
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
    }));

    const deps = makeDeps({
      redis: redisBase as unknown as MeteringServiceDeps["redis"],
      billingWebhookConfigRepo: billingWebhookConfigRepo as unknown as MeteringServiceDeps["billingWebhookConfigRepo"],
      usageSummaryRepo: usageSummaryRepo as unknown as MeteringServiceDeps["usageSummaryRepo"],
    });
    const svc = createMeteringService(deps);

    // Must not throw
    await expect(svc.flushPendingEvents()).resolves.not.toThrow();

    // Warning must be logged
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/billing webhook/i),
      expect.objectContaining({ tenantId: "tenant-1" }),
    );
  });
});

// ---------------------------------------------------------------------------
// Redis counter → DB flush atomicity
// ---------------------------------------------------------------------------

describe("MeteringService — Redis counter to DB flush", () => {
  it("clears the pending tenants set before processing so new increments land in the next flush", async () => {
    const redisBase = makeRedis();
    const delCallOrder: string[] = [];
    redisBase.smembers = vi.fn().mockResolvedValue(["t1"]);
    redisBase.del = vi.fn().mockImplementation((key: string) => {
      delCallOrder.push(key);
      return Promise.resolve(1);
    });

    const pipelineMock = {
      hgetall: vi.fn().mockReturnThis(),
      del: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([
        [null, { api_call: "5" }],
        [null, {}],
        [null, 1],
        [null, 1],
      ]),
    };
    redisBase.pipeline = vi.fn().mockReturnValue(pipelineMock);

    const deps = makeDeps({
      redis: redisBase as unknown as MeteringServiceDeps["redis"],
    });
    const svc = createMeteringService(deps);

    await svc.flushPendingEvents();

    // The pending tenants key must be deleted before per-tenant processing
    expect(redisBase.del).toHaveBeenCalledWith("metering:pending_tenants");
    expect(delCallOrder[0]).toBe("metering:pending_tenants");
  });
});
