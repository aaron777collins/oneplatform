// Unit tests for data-quality-service.ts
//
// Tests cover every quality rule independently, edge cases (empty batches,
// first batch with no history, exact threshold boundaries), the EMA helper,
// the score calculation, and the updateStats persistence logic.
//
// All tests are pure unit tests — no DB, no Redis, no BullMQ. The
// QualityStatsRepository is mocked at the interface boundary.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Logger } from "@oneplatform/core";
import {
  createDataQualityService,
  analyzeBatch,
  computeFieldNullRates,
  computeFieldNullCounts,
  computeFieldTypes,
  dominantType,
  updateEma,
  type ConnectorQualityStats,
  type QualityStatsRepository,
} from "../services/data-quality-service.js";
import type { DataRecord } from "../utils/data-envelope.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const CONNECTOR_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";

function makeRecord(data: Record<string, unknown>): DataRecord {
  return { sourceId: `src-${Math.random()}`, data };
}

function makeStats(overrides: Partial<ConnectorQualityStats> = {}): ConnectorQualityStats {
  return {
    connectorId: CONNECTOR_ID,
    avgBatchSize: 100,
    fieldNullRates: {},
    fieldTypes: {},
    knownFields: [],
    batchCount: 5,
    updatedAt: new Date().toISOString(),
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

function makeStatsRepo(stats: ConnectorQualityStats | null = null): QualityStatsRepository {
  return {
    findByConnectorId: vi.fn().mockResolvedValue(stats),
    upsert: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// computeFieldNullCounts
// ---------------------------------------------------------------------------

describe("computeFieldNullCounts", () => {
  it("returns empty object for empty records", () => {
    expect(computeFieldNullCounts([])).toEqual({});
  });

  it("counts null values", () => {
    const records = [
      makeRecord({ name: null, age: 25 }),
      makeRecord({ name: null, age: null }),
    ];
    const counts = computeFieldNullCounts(records);
    expect(counts["name"]).toBe(2);
    expect(counts["age"]).toBe(1);
  });

  it("counts undefined values as null", () => {
    const records = [makeRecord({ name: undefined })];
    const counts = computeFieldNullCounts(records);
    expect(counts["name"]).toBe(1);
  });

  it("does not count zero or empty string as null", () => {
    const records = [makeRecord({ count: 0, label: "" })];
    const counts = computeFieldNullCounts(records);
    expect(counts["count"]).toBeUndefined();
    expect(counts["label"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// computeFieldNullRates
// ---------------------------------------------------------------------------

describe("computeFieldNullRates", () => {
  it("returns empty object for empty records", () => {
    expect(computeFieldNullRates([])).toEqual({});
  });

  it("computes 0.0 null rate for fully present field", () => {
    const records = [makeRecord({ name: "Alice" }), makeRecord({ name: "Bob" })];
    expect(computeFieldNullRates(records)["name"]).toBe(0);
  });

  it("computes 1.0 null rate for fully null field", () => {
    const records = [makeRecord({ name: null }), makeRecord({ name: null })];
    expect(computeFieldNullRates(records)["name"]).toBe(1);
  });

  it("computes 0.5 null rate for half-null field", () => {
    const records = [makeRecord({ name: "Alice" }), makeRecord({ name: null })];
    expect(computeFieldNullRates(records)["name"]).toBe(0.5);
  });

  it("includes fields present in only some records", () => {
    const records = [makeRecord({ a: 1, b: "x" }), makeRecord({ a: 2 })];
    const rates = computeFieldNullRates(records);
    // "b" appears in 1 of 2 records, absent (undefined) in the other
    expect(rates["b"]).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// computeFieldTypes
// ---------------------------------------------------------------------------

describe("computeFieldTypes", () => {
  it("returns empty object for empty records", () => {
    expect(computeFieldTypes([])).toEqual({});
  });

  it("skips null and undefined values", () => {
    const records = [makeRecord({ name: null }), makeRecord({ name: undefined })];
    expect(computeFieldTypes(records)["name"]).toBeUndefined();
  });

  it("counts string type correctly", () => {
    const records = [makeRecord({ name: "Alice" }), makeRecord({ name: "Bob" })];
    expect(computeFieldTypes(records)["name"]).toEqual({ string: 2 });
  });

  it("counts mixed types correctly", () => {
    const records = [
      makeRecord({ value: "text" }),
      makeRecord({ value: 42 }),
      makeRecord({ value: true }),
    ];
    const dist = computeFieldTypes(records)["value"];
    expect(dist?.["string"]).toBe(1);
    expect(dist?.["number"]).toBe(1);
    expect(dist?.["boolean"]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// dominantType
// ---------------------------------------------------------------------------

describe("dominantType", () => {
  it("returns null for empty distribution", () => {
    expect(dominantType({})).toBeNull();
  });

  it("returns the single type for a pure distribution", () => {
    expect(dominantType({ string: 10 })).toBe("string");
  });

  it("returns the type with the highest count", () => {
    expect(dominantType({ string: 8, number: 2 })).toBe("string");
  });

  it("handles tie by returning one of the tied types", () => {
    const result = dominantType({ string: 5, number: 5 });
    expect(["string", "number"]).toContain(result);
  });
});

// ---------------------------------------------------------------------------
// updateEma
// ---------------------------------------------------------------------------

describe("updateEma", () => {
  it("returns current value on first batch (batchCount=1)", () => {
    expect(updateEma(0, 100, 1)).toBe(100);
  });

  it("uses equal-weight average for batchCount=2", () => {
    // alpha = 1/2; result = 0.5 * 200 + 0.5 * 100 = 150
    expect(updateEma(100, 200, 2)).toBe(150);
  });

  it("uses EMA_ALPHA=0.2 once batchCount >= MIN_BATCHES (3)", () => {
    // alpha = 0.2; result = 0.2 * 200 + 0.8 * 100 = 120
    expect(updateEma(100, 200, 3)).toBe(120);
    expect(updateEma(100, 200, 10)).toBe(120);
  });
});

// ---------------------------------------------------------------------------
// analyzeBatch — null rate spike
// ---------------------------------------------------------------------------

describe("analyzeBatch — null rate spike", () => {
  it("emits null_rate_spike warning when previously non-null field exceeds 50% null", () => {
    const records = [
      makeRecord({ name: null }),
      makeRecord({ name: null }),
      makeRecord({ name: "Alice" }),
    ]; // 66% null
    const stats = makeStats({
      fieldNullRates: { name: 0.02 }, // historically 2% null → non-null
      knownFields: ["name"],
      batchCount: 5,
    });

    const report = analyzeBatch(CONNECTOR_ID, records, stats);
    const issue = report.issues.find((i) => i.type === "null_rate_spike" && i.field === "name");
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("warning");
  });

  it("does not emit when null rate is exactly at threshold (50%)", () => {
    // Exactly 50% — threshold is >, not >=
    const records = [makeRecord({ name: null }), makeRecord({ name: "Bob" })];
    const stats = makeStats({ fieldNullRates: { name: 0.02 }, knownFields: ["name"], batchCount: 5 });
    const report = analyzeBatch(CONNECTOR_ID, records, stats);
    const issue = report.issues.find((i) => i.type === "null_rate_spike");
    expect(issue).toBeUndefined();
  });

  it("does not emit when field was already mostly null historically", () => {
    // Historical null rate = 0.15 — above the 0.10 previously-non-null threshold
    const records = [makeRecord({ name: null }), makeRecord({ name: null }), makeRecord({ name: "x" })];
    const stats = makeStats({ fieldNullRates: { name: 0.15 }, knownFields: ["name"], batchCount: 5 });
    const report = analyzeBatch(CONNECTOR_ID, records, stats);
    const issue = report.issues.find((i) => i.type === "null_rate_spike");
    expect(issue).toBeUndefined();
  });

  it("does not emit on first batch (no history)", () => {
    const records = [makeRecord({ name: null }), makeRecord({ name: null })];
    const report = analyzeBatch(CONNECTOR_ID, records, null);
    expect(report.issues.find((i) => i.type === "null_rate_spike")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// analyzeBatch — volume drop
// ---------------------------------------------------------------------------

describe("analyzeBatch — volume drop", () => {
  it("emits critical volume_drop when count drops >80% below average", () => {
    // avg = 100; drop threshold = 100 * 0.2 = 20; 10 records < 20
    const records = Array.from({ length: 10 }, () => makeRecord({ id: 1 }));
    const stats = makeStats({ avgBatchSize: 100, batchCount: 5 });
    const report = analyzeBatch(CONNECTOR_ID, records, stats);
    const issue = report.issues.find((i) => i.type === "volume_drop");
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("critical");
  });

  it("does not emit when volume is exactly at threshold (20% of 100 = 20 records)", () => {
    // exactly 20 records — threshold is <, not <=
    const records = Array.from({ length: 20 }, () => makeRecord({ id: 1 }));
    const stats = makeStats({ avgBatchSize: 100, batchCount: 5 });
    const report = analyzeBatch(CONNECTOR_ID, records, stats);
    expect(report.issues.find((i) => i.type === "volume_drop")).toBeUndefined();
  });

  it("does not emit volume_drop before MIN_BATCHES_FOR_VOLUME_CHECK (3) historical batches", () => {
    const records = Array.from({ length: 1 }, () => makeRecord({ id: 1 }));
    const stats = makeStats({ avgBatchSize: 100, batchCount: 2 }); // only 2 batches
    const report = analyzeBatch(CONNECTOR_ID, records, stats);
    expect(report.issues.find((i) => i.type === "volume_drop")).toBeUndefined();
  });

  it("does not emit when no history exists", () => {
    const records = Array.from({ length: 1 }, () => makeRecord({ id: 1 }));
    const report = analyzeBatch(CONNECTOR_ID, records, null);
    expect(report.issues.find((i) => i.type === "volume_drop")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// analyzeBatch — volume spike
// ---------------------------------------------------------------------------

describe("analyzeBatch — volume spike", () => {
  it("emits volume_spike warning when count exceeds 500% of average", () => {
    // avg = 100; spike threshold = 500; 600 records > 500
    const records = Array.from({ length: 600 }, () => makeRecord({ id: 1 }));
    const stats = makeStats({ avgBatchSize: 100, batchCount: 5 });
    const report = analyzeBatch(CONNECTOR_ID, records, stats);
    const issue = report.issues.find((i) => i.type === "volume_spike");
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("warning");
  });

  it("does not emit when count is exactly at threshold (500 records)", () => {
    // exactly 500 — threshold is >, not >=
    const records = Array.from({ length: 500 }, () => makeRecord({ id: 1 }));
    const stats = makeStats({ avgBatchSize: 100, batchCount: 5 });
    const report = analyzeBatch(CONNECTOR_ID, records, stats);
    expect(report.issues.find((i) => i.type === "volume_spike")).toBeUndefined();
  });

  it("does not emit both volume_drop and volume_spike for the same batch", () => {
    // 50 records against avg=100 — drop threshold is 20, not spike
    const records = Array.from({ length: 50 }, () => makeRecord({ id: 1 }));
    const stats = makeStats({ avgBatchSize: 100, batchCount: 5 });
    const report = analyzeBatch(CONNECTOR_ID, records, stats);
    expect(report.issues.filter((i) => i.type === "volume_drop" || i.type === "volume_spike")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// analyzeBatch — type mismatch
// ---------------------------------------------------------------------------

describe("analyzeBatch — type mismatch", () => {
  it("emits type_mismatch warning when >10% of non-null values deviate from historical type", () => {
    // Historical dominant: string. Current batch: 8 strings, 2 numbers = 20% mismatch
    const records = [
      ...Array.from({ length: 8 }, () => makeRecord({ score: "high" })),
      ...Array.from({ length: 2 }, () => makeRecord({ score: 99 })),
    ];
    const stats = makeStats({
      fieldTypes: { score: { string: 100 } },
      knownFields: ["score"],
      batchCount: 5,
    });
    const report = analyzeBatch(CONNECTOR_ID, records, stats);
    const issue = report.issues.find((i) => i.type === "type_mismatch" && i.field === "score");
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("warning");
  });

  it("does not emit when mismatch rate is exactly at threshold (10%)", () => {
    // 9 strings, 1 number = 10% mismatch — threshold is >, not >=
    const records = [
      ...Array.from({ length: 9 }, () => makeRecord({ score: "high" })),
      makeRecord({ score: 99 }),
    ];
    const stats = makeStats({
      fieldTypes: { score: { string: 100 } },
      knownFields: ["score"],
      batchCount: 5,
    });
    const report = analyzeBatch(CONNECTOR_ID, records, stats);
    expect(report.issues.find((i) => i.type === "type_mismatch")).toBeUndefined();
  });

  it("does not emit when field has no historical type data", () => {
    const records = [makeRecord({ newfield: 42 }), makeRecord({ newfield: "string" })];
    const stats = makeStats({ fieldTypes: {}, knownFields: [], batchCount: 5 });
    const report = analyzeBatch(CONNECTOR_ID, records, stats);
    expect(report.issues.find((i) => i.type === "type_mismatch")).toBeUndefined();
  });

  it("does not emit for all-null field (no non-null values to compare)", () => {
    const records = [makeRecord({ name: null }), makeRecord({ name: null })];
    const stats = makeStats({
      fieldTypes: { name: { string: 50 } },
      knownFields: ["name"],
      batchCount: 5,
    });
    const report = analyzeBatch(CONNECTOR_ID, records, stats);
    expect(report.issues.find((i) => i.type === "type_mismatch")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// analyzeBatch — missing field
// ---------------------------------------------------------------------------

describe("analyzeBatch — missing field", () => {
  it("emits missing_field warning for a historically known field absent from batch", () => {
    const records = [makeRecord({ age: 25 })]; // name is absent
    const stats = makeStats({ knownFields: ["name", "age"], batchCount: 5 });
    const report = analyzeBatch(CONNECTOR_ID, records, stats);
    const issue = report.issues.find((i) => i.type === "missing_field" && i.field === "name");
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("warning");
  });

  it("does not emit missing_field on first batch", () => {
    const records = [makeRecord({ age: 25 })];
    const report = analyzeBatch(CONNECTOR_ID, records, null);
    expect(report.issues.find((i) => i.type === "missing_field")).toBeUndefined();
  });

  it("does not emit missing_field when field is present but null", () => {
    // Field appears with null value — it's present in fieldNullRates
    const records = [makeRecord({ name: null, age: 25 })];
    const stats = makeStats({ knownFields: ["name", "age"], batchCount: 5 });
    const report = analyzeBatch(CONNECTOR_ID, records, stats);
    expect(report.issues.find((i) => i.type === "missing_field")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// analyzeBatch — new field
// ---------------------------------------------------------------------------

describe("analyzeBatch — new field", () => {
  it("emits new_field info issue for a field not in known history", () => {
    const records = [makeRecord({ name: "Alice", newcolumn: "value" })];
    const stats = makeStats({ knownFields: ["name"], batchCount: 5 });
    const report = analyzeBatch(CONNECTOR_ID, records, stats);
    const issue = report.issues.find((i) => i.type === "new_field" && i.field === "newcolumn");
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("info");
  });

  it("does not emit new_field on first batch (no history to compare against)", () => {
    const records = [makeRecord({ name: "Alice" })];
    const report = analyzeBatch(CONNECTOR_ID, records, null);
    expect(report.issues.find((i) => i.type === "new_field")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// analyzeBatch — score calculation
// ---------------------------------------------------------------------------

describe("analyzeBatch — score calculation", () => {
  it("returns score 1.0 when no issues are found", () => {
    // avgBatchSize must be close to recordCount to avoid triggering volume checks.
    // 1 record, avg=1 → no volume drop (1 >= 1*0.2=0.2) and no spike (1 <= 1*5=5).
    const records = [makeRecord({ name: "Alice" })];
    const stats = makeStats({
      knownFields: ["name"],
      fieldNullRates: { name: 0 },
      avgBatchSize: 1,
      batchCount: 5,
    });
    const report = analyzeBatch(CONNECTOR_ID, records, stats);
    expect(report.score).toBe(1);
  });

  it("deducts 0.4 per critical issue", () => {
    // Trigger exactly one critical volume_drop with no other issues.
    // 5 records vs avg=100: drop threshold = 20, 5 < 20 → critical.
    // Use only numeric fields with consistent types and no nulls to avoid warnings.
    const records = Array.from({ length: 5 }, () => makeRecord({ id: 1 }));
    const stats = makeStats({
      avgBatchSize: 100,
      knownFields: ["id"],
      fieldNullRates: { id: 0 },
      fieldTypes: { id: { number: 100 } },
      batchCount: 5,
    });
    const report = analyzeBatch(CONNECTOR_ID, records, stats);
    const criticalCount = report.issues.filter((i) => i.severity === "critical").length;
    expect(criticalCount).toBeGreaterThan(0);
    // Score should be reduced by 0.4 per critical and 0.15 per warning
    const expectedPenalty =
      criticalCount * 0.4 +
      report.issues.filter((i) => i.severity === "warning").length * 0.15 +
      report.issues.filter((i) => i.severity === "info").length * 0.05;
    expect(report.score).toBeCloseTo(Math.max(0, 1 - expectedPenalty), 5);
  });

  it("floors score at 0 when penalties exceed 1", () => {
    // Create a situation with many critical + warning issues
    const records = Array.from({ length: 2 }, () => makeRecord({ a: null, b: null, c: null }));
    const stats = makeStats({
      avgBatchSize: 100,
      knownFields: ["a", "b", "c", "d", "e"],
      fieldNullRates: { a: 0.01, b: 0.01, c: 0.01 },
      batchCount: 5,
    });
    const report = analyzeBatch(CONNECTOR_ID, records, stats);
    expect(report.score).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// analyzeBatch — empty batch
// ---------------------------------------------------------------------------

describe("analyzeBatch — empty batch", () => {
  it("handles empty records gracefully with no issues", () => {
    const report = analyzeBatch(CONNECTOR_ID, [], null);
    expect(report.issues).toEqual([]);
    expect(report.recordCount).toBe(0);
    expect(report.score).toBe(1);
  });

  it("does not emit volume_drop for empty batch when no history", () => {
    const report = analyzeBatch(CONNECTOR_ID, [], null);
    expect(report.issues.find((i) => i.type === "volume_drop")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createDataQualityService — getStats
// ---------------------------------------------------------------------------

describe("createDataQualityService — getStats", () => {
  it("delegates to statsRepo.findByConnectorId", async () => {
    const stats = makeStats();
    const repo = makeStatsRepo(stats);
    const svc = createDataQualityService({ statsRepo: repo, logger: makeLogger() });

    const result = await svc.getStats(CONNECTOR_ID);
    expect(result).toBe(stats);
    expect(repo.findByConnectorId).toHaveBeenCalledWith(CONNECTOR_ID);
  });

  it("returns null when no stats exist", async () => {
    const repo = makeStatsRepo(null);
    const svc = createDataQualityService({ statsRepo: repo, logger: makeLogger() });
    const result = await svc.getStats(CONNECTOR_ID);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createDataQualityService — analyzeBatch (method wrapper)
// ---------------------------------------------------------------------------

describe("createDataQualityService — analyzeBatch method", () => {
  it("returns a neutral report and logs error when analysis throws unexpectedly", () => {
    const logger = makeLogger();
    const repo = makeStatsRepo(null);
    const svc = createDataQualityService({ statsRepo: repo, logger });

    // Inject a broken record to force an unexpected path (non-data object)
    const badRecord = { sourceId: "x", data: null } as unknown as DataRecord;

    // analyzeBatch should not throw even with bad input
    let report!: ReturnType<typeof svc.analyzeBatch>;
    expect(() => {
      report = svc.analyzeBatch(CONNECTOR_ID, [badRecord], null);
    }).not.toThrow();

    // On error, it returns neutral
    expect(report.score).toBe(1);
    expect(report.issues).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// createDataQualityService — updateStats
// ---------------------------------------------------------------------------

describe("createDataQualityService — updateStats", () => {
  it("calls statsRepo.upsert with incremented batchCount", async () => {
    const repo = makeStatsRepo(null);
    const svc = createDataQualityService({ statsRepo: repo, logger: makeLogger() });

    const report = {
      score: 1,
      issues: [],
      fieldNullRates: { name: 0.1 },
      fieldTypes: { name: { string: 5 } },
      recordCount: 50,
    };

    await svc.updateStats(CONNECTOR_ID, report, null);

    expect(repo.upsert).toHaveBeenCalledOnce();
    const saved = (repo.upsert as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as ConnectorQualityStats;
    expect(saved.connectorId).toBe(CONNECTOR_ID);
    expect(saved.batchCount).toBe(1);
    expect(saved.avgBatchSize).toBe(50);
    expect(saved.knownFields).toContain("name");
  });

  it("merges existing known fields with new ones", async () => {
    const previous = makeStats({
      knownFields: ["age", "name"],
      fieldNullRates: { age: 0.0, name: 0.0 },
      batchCount: 4,
    });
    const repo = makeStatsRepo(previous);
    const svc = createDataQualityService({ statsRepo: repo, logger: makeLogger() });

    const report = {
      score: 1,
      issues: [],
      fieldNullRates: { name: 0.0, email: 0.0 },
      fieldTypes: { name: { string: 10 }, email: { string: 10 } },
      recordCount: 10,
    };

    await svc.updateStats(CONNECTOR_ID, report, previous);

    const saved = (repo.upsert as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as ConnectorQualityStats;
    expect(saved.knownFields).toContain("age");
    expect(saved.knownFields).toContain("name");
    expect(saved.knownFields).toContain("email");
  });

  it("accumulates type distribution counts across batches", async () => {
    const previous = makeStats({
      fieldTypes: { score: { string: 50 } },
      knownFields: ["score"],
      batchCount: 4,
    });
    const repo = makeStatsRepo(previous);
    const svc = createDataQualityService({ statsRepo: repo, logger: makeLogger() });

    const report = {
      score: 1,
      issues: [],
      fieldNullRates: { score: 0 },
      fieldTypes: { score: { string: 10, number: 2 } },
      recordCount: 12,
    };

    await svc.updateStats(CONNECTOR_ID, report, previous);

    const saved = (repo.upsert as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as ConnectorQualityStats;
    // string: 50 + 10 = 60; number: 0 + 2 = 2
    expect(saved.fieldTypes["score"]?.["string"]).toBe(60);
    expect(saved.fieldTypes["score"]?.["number"]).toBe(2);
  });

  it("applies EMA to null rate across batches", async () => {
    const previous = makeStats({
      fieldNullRates: { name: 0.0 },
      knownFields: ["name"],
      batchCount: 5, // >= MIN_BATCHES, so EMA_ALPHA = 0.2
    });
    const repo = makeStatsRepo(previous);
    const svc = createDataQualityService({ statsRepo: repo, logger: makeLogger() });

    const report = {
      score: 1,
      issues: [],
      fieldNullRates: { name: 1.0 }, // sudden 100% null
      fieldTypes: {},
      recordCount: 10,
    };

    await svc.updateStats(CONNECTOR_ID, report, previous);

    const saved = (repo.upsert as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as ConnectorQualityStats;
    // EMA: 0.2 * 1.0 + 0.8 * 0.0 = 0.2
    expect(saved.fieldNullRates["name"]).toBeCloseTo(0.2);
  });
});

// ---------------------------------------------------------------------------
// Multiple issues in a single batch
// ---------------------------------------------------------------------------

describe("analyzeBatch — multiple simultaneous issues", () => {
  it("can emit both volume_drop and null_rate_spike in the same batch", () => {
    const records = [
      makeRecord({ name: null }),
      makeRecord({ name: null }),
      makeRecord({ name: null }),
    ]; // 100% null and only 3 records
    const stats = makeStats({
      avgBatchSize: 100,
      fieldNullRates: { name: 0.01 },
      knownFields: ["name"],
      batchCount: 5,
    });

    const report = analyzeBatch(CONNECTOR_ID, records, stats);

    const hasVolumeDrop = report.issues.some((i) => i.type === "volume_drop");
    const hasNullSpike = report.issues.some((i) => i.type === "null_rate_spike");
    expect(hasVolumeDrop).toBe(true);
    expect(hasNullSpike).toBe(true);
  });
});
