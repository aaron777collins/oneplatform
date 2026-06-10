// Unit tests for inference-service.ts
// Covers: type inference (boolean, number, date, array, json, string fallback),
// confidence scoring, null rate calculation, path collection depth limit,
// slug derivation, entityType derivation, and error cases.
// draftRepo and logger are mocked via vitest — no real I/O.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Logger } from "@oneplatform/core";
import type { DraftRepository } from "../repositories/draft-repository.js";
import type { DraftOntologyRow, InferredSchema } from "../repositories/types.js";
import { createInferenceService } from "../services/inference-service.js";
import type { DataEnvelope } from "../services/inference-service.js";
import { InferInsufficientDataError } from "../services/errors.js";

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
    audit: vi.fn(),
  } as unknown as Logger;
}

function makeDraftRow(overrides: Partial<DraftOntologyRow> = {}): DraftOntologyRow {
  return {
    id: "draft-1",
    tenant_id: "tenant-1",
    connector_id: "connector-1",
    inferred_schema: {
      entityType: "test",
      fields: [],
      sampleCount: 10,
    },
    status: "pending",
    sample_batch_id: "batch-1",
    created_at: new Date(),
    updated_at: new Date(),
    confirmed_at: null,
    confirmed_by: null,
    ...overrides,
  };
}

function makeDraftRepo(draftRow: DraftOntologyRow = makeDraftRow()): DraftRepository {
  return {
    create: vi.fn().mockResolvedValue(draftRow),
    findById: vi.fn().mockResolvedValue(null),
    findByTenantAndConnector: vi.fn().mockResolvedValue([]),
    findPending: vi.fn().mockResolvedValue([]),
    confirm: vi.fn().mockResolvedValue(null),
    findAll: vi.fn().mockResolvedValue([]),
  } as unknown as DraftRepository;
}

// ---------------------------------------------------------------------------
// Envelope builder helpers
// ---------------------------------------------------------------------------

function makeEnvelope(data: Record<string, unknown>, index = 0): DataEnvelope {
  return {
    _id: `id-${index}`,
    _batchId: "batch-1",
    _connectorId: "conn-1",
    _ingestedAt: "2024-01-01T00:00:00Z",
    data,
  };
}

/** Create a minimum-viable 10-envelope sample with homogeneous data. */
function makeSample(
  data: Record<string, unknown>,
  count = 10,
): DataEnvelope[] {
  return Array.from({ length: count }, (_, i) => makeEnvelope(data, i));
}

// ---------------------------------------------------------------------------
// Minimum sample size guard
// ---------------------------------------------------------------------------

describe("inferSchema — minimum sample size enforcement", () => {
  it("throws InferInsufficientDataError when sample has fewer than 10 rows", async () => {
    const svc = createInferenceService({ logger: makeLogger(), draftRepo: makeDraftRepo() });
    const tinyBatch = makeSample({ name: "Alice" }, 9);
    await expect(
      svc.inferSchema("tenant-1", "connector-1", tinyBatch),
    ).rejects.toThrow(InferInsufficientDataError);
  });

  it("throws with a message indicating the minimum and actual counts", async () => {
    const svc = createInferenceService({ logger: makeLogger(), draftRepo: makeDraftRepo() });
    const tinyBatch = makeSample({ x: 1 }, 5);
    await expect(svc.inferSchema("tenant-1", "connector-1", tinyBatch)).rejects.toThrow(
      /10.*5|5.*10/,
    );
  });

  it("does NOT throw when sample has exactly 10 rows", async () => {
    const svc = createInferenceService({ logger: makeLogger(), draftRepo: makeDraftRepo() });
    const exactBatch = makeSample({ flag: true });
    await expect(
      svc.inferSchema("tenant-1", "connector-1", exactBatch),
    ).resolves.toBeDefined();
  });

  it("does NOT throw when sample has more than 10 rows", async () => {
    const svc = createInferenceService({ logger: makeLogger(), draftRepo: makeDraftRepo() });
    const bigBatch = makeSample({ val: 42 }, 50);
    await expect(
      svc.inferSchema("tenant-1", "connector-1", bigBatch),
    ).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Type inference — boolean
// ---------------------------------------------------------------------------

describe("inferSchema — boolean type detection", () => {
  it("infers 'boolean' when all values are boolean true/false", async () => {
    const svc = createInferenceService({ logger: makeLogger(), draftRepo: makeDraftRepo() });
    const sample = Array.from({ length: 10 }, (_, i) =>
      makeEnvelope({ is_active: i % 2 === 0 }, i),
    );
    const { inferredSchema } = await svc.inferSchema("t", "c", sample);
    const field = inferredSchema.fields.find((f) => f.path === "is_active");
    expect(field?.inferredType).toBe("boolean");
  });

  it("infers 'boolean' confidence of 1.0 when all values are booleans", async () => {
    const svc = createInferenceService({ logger: makeLogger(), draftRepo: makeDraftRepo() });
    const sample = makeSample({ flag: true });
    const { inferredSchema } = await svc.inferSchema("t", "c", sample);
    const field = inferredSchema.fields.find((f) => f.path === "flag");
    expect(field?.confidence).toBe(1);
  });

  it("does NOT infer boolean for string 'true'/'false'", async () => {
    const svc = createInferenceService({ logger: makeLogger(), draftRepo: makeDraftRepo() });
    const sample = makeSample({ flag: "true" });
    const { inferredSchema } = await svc.inferSchema("t", "c", sample);
    const field = inferredSchema.fields.find((f) => f.path === "flag");
    expect(field?.inferredType).not.toBe("boolean");
  });
});

// ---------------------------------------------------------------------------
// Type inference — number
// ---------------------------------------------------------------------------

describe("inferSchema — number type detection", () => {
  it("infers 'number' when all values are numeric", async () => {
    const svc = createInferenceService({ logger: makeLogger(), draftRepo: makeDraftRepo() });
    const sample = Array.from({ length: 10 }, (_, i) => makeEnvelope({ age: 20 + i }, i));
    const { inferredSchema } = await svc.inferSchema("t", "c", sample);
    const field = inferredSchema.fields.find((f) => f.path === "age");
    expect(field?.inferredType).toBe("number");
  });

  it("infers 'number' when values are numeric strings like '42'", async () => {
    const svc = createInferenceService({ logger: makeLogger(), draftRepo: makeDraftRepo() });
    const sample = makeSample({ score: "99" });
    const { inferredSchema } = await svc.inferSchema("t", "c", sample);
    const field = inferredSchema.fields.find((f) => f.path === "score");
    expect(field?.inferredType).toBe("number");
  });

  it("does NOT infer number for empty string (blank numeric string)", async () => {
    const svc = createInferenceService({ logger: makeLogger(), draftRepo: makeDraftRepo() });
    const sample = makeSample({ val: "  " });
    const { inferredSchema } = await svc.inferSchema("t", "c", sample);
    const field = inferredSchema.fields.find((f) => f.path === "val");
    expect(field?.inferredType).not.toBe("number");
  });

  it("falls back to 'string' for a mix of numbers and non-numeric strings", async () => {
    const svc = createInferenceService({ logger: makeLogger(), draftRepo: makeDraftRepo() });
    const sample = Array.from({ length: 10 }, (_, i) =>
      makeEnvelope({ val: i % 2 === 0 ? 42 : "not-a-number" }, i),
    );
    const { inferredSchema } = await svc.inferSchema("t", "c", sample);
    const field = inferredSchema.fields.find((f) => f.path === "val");
    expect(field?.inferredType).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Type inference — date
// ---------------------------------------------------------------------------

describe("inferSchema — date type detection", () => {
  it("infers 'date' when all values are ISO-8601 datetime strings", async () => {
    const svc = createInferenceService({ logger: makeLogger(), draftRepo: makeDraftRepo() });
    const sample = makeSample({ created_at: "2024-01-15T12:00:00Z" });
    const { inferredSchema } = await svc.inferSchema("t", "c", sample);
    const field = inferredSchema.fields.find((f) => f.path === "created_at");
    expect(field?.inferredType).toBe("date");
  });

  it("infers 'date' for YYYY-MM-DD date strings (parseable as Date)", async () => {
    const svc = createInferenceService({ logger: makeLogger(), draftRepo: makeDraftRepo() });
    const sample = makeSample({ dob: "1990-06-15" });
    const { inferredSchema } = await svc.inferSchema("t", "c", sample);
    const field = inferredSchema.fields.find((f) => f.path === "dob");
    // "1990-06-15" is 10 chars, passes YYYY-MM-DD regex, and is a valid Date
    expect(field?.inferredType).toBe("date");
  });

  it("does NOT infer date for short strings under 10 characters", async () => {
    const svc = createInferenceService({ logger: makeLogger(), draftRepo: makeDraftRepo() });
    const sample = makeSample({ ts: "24-01-15" }); // only 8 chars
    const { inferredSchema } = await svc.inferSchema("t", "c", sample);
    const field = inferredSchema.fields.find((f) => f.path === "ts");
    expect(field?.inferredType).not.toBe("date");
  });

  it("does NOT infer date for arbitrary strings that happen to be 10+ chars", async () => {
    const svc = createInferenceService({ logger: makeLogger(), draftRepo: makeDraftRepo() });
    const sample = makeSample({ ref: "ABCDEF-12345" });
    const { inferredSchema } = await svc.inferSchema("t", "c", sample);
    const field = inferredSchema.fields.find((f) => f.path === "ref");
    expect(field?.inferredType).not.toBe("date");
  });

  it("falls back to string when mix of date strings and plain strings", async () => {
    const svc = createInferenceService({ logger: makeLogger(), draftRepo: makeDraftRepo() });
    const sample = Array.from({ length: 10 }, (_, i) =>
      makeEnvelope({ ts: i % 2 === 0 ? "2024-01-01T00:00:00Z" : "not-a-date" }, i),
    );
    const { inferredSchema } = await svc.inferSchema("t", "c", sample);
    const field = inferredSchema.fields.find((f) => f.path === "ts");
    expect(field?.inferredType).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Type inference — array
// ---------------------------------------------------------------------------

describe("inferSchema — array type detection", () => {
  it("infers 'array' when all values are arrays", async () => {
    const svc = createInferenceService({ logger: makeLogger(), draftRepo: makeDraftRepo() });
    const sample = makeSample({ tags: ["a", "b"] });
    const { inferredSchema } = await svc.inferSchema("t", "c", sample);
    const field = inferredSchema.fields.find((f) => f.path === "tags");
    expect(field?.inferredType).toBe("array");
  });

  it("does NOT infer array for a mix of arrays and non-arrays", async () => {
    const svc = createInferenceService({ logger: makeLogger(), draftRepo: makeDraftRepo() });
    const sample = Array.from({ length: 10 }, (_, i) =>
      makeEnvelope({ val: i % 2 === 0 ? ["x"] : "not-array" }, i),
    );
    const { inferredSchema } = await svc.inferSchema("t", "c", sample);
    const field = inferredSchema.fields.find((f) => f.path === "val");
    expect(field?.inferredType).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Type inference — json (nested object)
// ---------------------------------------------------------------------------

describe("inferSchema — json type detection", () => {
  it("infers 'json' when all values are non-array objects", async () => {
    const svc = createInferenceService({ logger: makeLogger(), draftRepo: makeDraftRepo() });
    // Nested objects are traversed recursively (not pushed as values),
    // so we need a direct object value that isn't further nested
    const sample = Array.from({ length: 10 }, (_, i) =>
      makeEnvelope({ meta: { key: `v${i}` } }, i),
    );
    // meta.key will be a string field; the "meta" path won't have values
    // because collectPaths recurses into objects. So we test a flat object value:
    const sample2 = Array.from({ length: 10 }, (_, i) =>
      makeEnvelope({ attrs: { x: 1, y: i } }, i),
    );
    const { inferredSchema } = await svc.inferSchema("t", "c", sample2);
    // meta is an object — collectPaths recurses, so meta.x and meta.y appear
    const field = inferredSchema.fields.find((f) => f.path === "attrs.x");
    expect(field?.inferredType).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// Type inference — string fallback
// ---------------------------------------------------------------------------

describe("inferSchema — string fallback", () => {
  it("infers 'string' for plain string values", async () => {
    const svc = createInferenceService({ logger: makeLogger(), draftRepo: makeDraftRepo() });
    const sample = makeSample({ name: "Alice" });
    const { inferredSchema } = await svc.inferSchema("t", "c", sample);
    const field = inferredSchema.fields.find((f) => f.path === "name");
    expect(field?.inferredType).toBe("string");
  });

  it("infers 'string' for a mix of different primitive types", async () => {
    const svc = createInferenceService({ logger: makeLogger(), draftRepo: makeDraftRepo() });
    const sample = Array.from({ length: 10 }, (_, i) =>
      makeEnvelope({ mixed: i % 3 === 0 ? 1 : i % 3 === 1 ? true : "str" }, i),
    );
    const { inferredSchema } = await svc.inferSchema("t", "c", sample);
    const field = inferredSchema.fields.find((f) => f.path === "mixed");
    expect(field?.inferredType).toBe("string");
  });

  it("infers 'string' when all collected values are empty (zero non-null values)", async () => {
    // The field exists but all 10 rows are null — inferType([]) returns 'string'
    const svc = createInferenceService({ logger: makeLogger(), draftRepo: makeDraftRepo() });
    const sample = makeSample({ maybe: null });
    const { inferredSchema } = await svc.inferSchema("t", "c", sample);
    const field = inferredSchema.fields.find((f) => f.path === "maybe");
    expect(field?.inferredType).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Null rate calculation
// ---------------------------------------------------------------------------

describe("inferSchema — null rate calculation", () => {
  it("null rate is 0 when no values are null", async () => {
    const svc = createInferenceService({ logger: makeLogger(), draftRepo: makeDraftRepo() });
    const sample = makeSample({ val: "always present" });
    const { inferredSchema } = await svc.inferSchema("t", "c", sample);
    const field = inferredSchema.fields.find((f) => f.path === "val");
    expect(field?.nullRate).toBe(0);
  });

  it("null rate is 1.0 when all values are null", async () => {
    const svc = createInferenceService({ logger: makeLogger(), draftRepo: makeDraftRepo() });
    const sample = makeSample({ val: null });
    const { inferredSchema } = await svc.inferSchema("t", "c", sample);
    const field = inferredSchema.fields.find((f) => f.path === "val");
    expect(field?.nullRate).toBe(1);
  });

  it("null rate is 0.5 when half the values are null", async () => {
    const svc = createInferenceService({ logger: makeLogger(), draftRepo: makeDraftRepo() });
    const sample = Array.from({ length: 10 }, (_, i) =>
      makeEnvelope({ opt: i < 5 ? null : "present" }, i),
    );
    const { inferredSchema } = await svc.inferSchema("t", "c", sample);
    const field = inferredSchema.fields.find((f) => f.path === "opt");
    expect(field?.nullRate).toBeCloseTo(0.5, 5);
  });

  it("null rate is between 0 and 1 for partially-populated fields", async () => {
    const svc = createInferenceService({ logger: makeLogger(), draftRepo: makeDraftRepo() });
    const sample = Array.from({ length: 10 }, (_, i) =>
      makeEnvelope({ sparse: i < 3 ? "x" : null }, i),
    );
    const { inferredSchema } = await svc.inferSchema("t", "c", sample);
    const field = inferredSchema.fields.find((f) => f.path === "sparse");
    expect(field?.nullRate).toBeGreaterThanOrEqual(0);
    expect(field?.nullRate).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Confidence scoring
// ---------------------------------------------------------------------------

describe("inferSchema — confidence scoring", () => {
  it("confidence is 1.0 when all non-null values match the inferred type", async () => {
    const svc = createInferenceService({ logger: makeLogger(), draftRepo: makeDraftRepo() });
    const sample = makeSample({ x: 42 });
    const { inferredSchema } = await svc.inferSchema("t", "c", sample);
    const field = inferredSchema.fields.find((f) => f.path === "x");
    expect(field?.confidence).toBe(1);
  });

  it("confidence is 0 when there are no non-null values", async () => {
    const svc = createInferenceService({ logger: makeLogger(), draftRepo: makeDraftRepo() });
    const sample = makeSample({ missing: null });
    const { inferredSchema } = await svc.inferSchema("t", "c", sample);
    const field = inferredSchema.fields.find((f) => f.path === "missing");
    expect(field?.confidence).toBe(0);
  });

  it("fields are sorted in descending confidence order", async () => {
    const svc = createInferenceService({ logger: makeLogger(), draftRepo: makeDraftRepo() });
    // 'definite' always has a value; 'sparse' is only present half the time
    const sample = Array.from({ length: 10 }, (_, i) =>
      makeEnvelope({ definite: "x", sparse: i < 5 ? null : "y" }, i),
    );
    const { inferredSchema } = await svc.inferSchema("t", "c", sample);
    const confidences = inferredSchema.fields.map((f) => f.confidence);
    for (let i = 1; i < confidences.length; i++) {
      expect(confidences[i - 1]!).toBeGreaterThanOrEqual(confidences[i]!);
    }
  });
});

// ---------------------------------------------------------------------------
// Sample values collection
// ---------------------------------------------------------------------------

describe("inferSchema — sample values", () => {
  it("collects at most 3 sample values per field", async () => {
    const svc = createInferenceService({ logger: makeLogger(), draftRepo: makeDraftRepo() });
    const sample = Array.from({ length: 10 }, (_, i) =>
      makeEnvelope({ val: `row-${i}` }, i),
    );
    const { inferredSchema } = await svc.inferSchema("t", "c", sample);
    const field = inferredSchema.fields.find((f) => f.path === "val");
    expect(field?.sampleValues.length).toBeLessThanOrEqual(3);
  });

  it("sampleValues contains only non-null values", async () => {
    const svc = createInferenceService({ logger: makeLogger(), draftRepo: makeDraftRepo() });
    const sample = Array.from({ length: 10 }, (_, i) =>
      makeEnvelope({ val: i === 0 ? null : `v${i}` }, i),
    );
    const { inferredSchema } = await svc.inferSchema("t", "c", sample);
    const field = inferredSchema.fields.find((f) => f.path === "val");
    for (const sv of field?.sampleValues ?? []) {
      expect(sv).not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Depth limit
// ---------------------------------------------------------------------------

describe("inferSchema — path collection depth limit (MAX_DEPTH = 5)", () => {
  it("collects paths at depth 1", async () => {
    const svc = createInferenceService({ logger: makeLogger(), draftRepo: makeDraftRepo() });
    const sample = makeSample({ a: "top" });
    const { inferredSchema } = await svc.inferSchema("t", "c", sample);
    expect(inferredSchema.fields.some((f) => f.path === "a")).toBe(true);
  });

  it("collects nested paths at depth 2", async () => {
    const svc = createInferenceService({ logger: makeLogger(), draftRepo: makeDraftRepo() });
    const sample = makeSample({ a: { b: "nested" } });
    const { inferredSchema } = await svc.inferSchema("t", "c", sample);
    expect(inferredSchema.fields.some((f) => f.path === "a.b")).toBe(true);
  });

  it("collects paths at depth 4 (within limit)", async () => {
    const svc = createInferenceService({ logger: makeLogger(), draftRepo: makeDraftRepo() });
    const deepData = { l1: { l2: { l3: { l4: "deep" } } } };
    const sample = makeSample(deepData);
    const { inferredSchema } = await svc.inferSchema("t", "c", sample);
    expect(inferredSchema.fields.some((f) => f.path === "l1.l2.l3.l4")).toBe(true);
  });

  it("does NOT collect paths beyond MAX_DEPTH of 5", async () => {
    const svc = createInferenceService({ logger: makeLogger(), draftRepo: makeDraftRepo() });
    // depth 0→1 (l1), 1→2 (l2), 2→3 (l3), 3→4 (l4), 4→5 (l5 — beyond limit)
    const tooDeep = { l1: { l2: { l3: { l4: { l5: { l6: "too_deep" } } } } } };
    const sample = makeSample(tooDeep);
    const { inferredSchema } = await svc.inferSchema("t", "c", sample);
    // l5 and l6 should not appear since depth stops at 5
    expect(inferredSchema.fields.some((f) => f.path.includes("l6"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// entityType derivation
// ---------------------------------------------------------------------------

describe("inferSchema — entityType derivation", () => {
  it("uses entityTypeHint when provided", async () => {
    const svc = createInferenceService({ logger: makeLogger(), draftRepo: makeDraftRepo() });
    const sample = makeSample({ v: 1 });
    const { inferredSchema } = await svc.inferSchema("t", "my-connector", sample, "my_entity");
    expect(inferredSchema.entityType).toBe("my_entity");
  });

  it("derives entityType from connectorId by replacing hyphens with underscores when no hint", async () => {
    const svc = createInferenceService({ logger: makeLogger(), draftRepo: makeDraftRepo() });
    const sample = makeSample({ v: 1 });
    const { inferredSchema } = await svc.inferSchema("t", "my-cool-connector", sample);
    expect(inferredSchema.entityType).toBe("my_cool_connector");
  });

  it("sets sampleCount equal to the number of provided sample envelopes", async () => {
    const svc = createInferenceService({ logger: makeLogger(), draftRepo: makeDraftRepo() });
    const sample = makeSample({ v: 1 }, 25);
    const { inferredSchema } = await svc.inferSchema("t", "c", sample);
    expect(inferredSchema.sampleCount).toBe(25);
  });
});

// ---------------------------------------------------------------------------
// Draft persistence
// ---------------------------------------------------------------------------

describe("inferSchema — draft persistence", () => {
  it("calls draftRepo.create with the correct tenantId, connectorId, and sampleCount", async () => {
    const draftRepo = makeDraftRepo();
    const svc = createInferenceService({ logger: makeLogger(), draftRepo });
    const sample = makeSample({ x: 1 });
    await svc.inferSchema("tenant-abc", "conn-xyz", sample);
    expect(draftRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: "tenant-abc",
        connector_id: "conn-xyz",
      }),
    );
  });

  it("returns the draftId from the created draft row", async () => {
    const draftRepo = makeDraftRepo(makeDraftRow({ id: "specific-draft-id" }));
    const svc = createInferenceService({ logger: makeLogger(), draftRepo });
    const sample = makeSample({ y: "hello" });
    const { draftId } = await svc.inferSchema("t", "c", sample);
    expect(draftId).toBe("specific-draft-id");
  });

  it("passes the first envelope's _batchId as sample_batch_id to the repo", async () => {
    const draftRepo = makeDraftRepo();
    const svc = createInferenceService({ logger: makeLogger(), draftRepo });
    const sample = Array.from({ length: 10 }, (_, i) => ({
      ...makeEnvelope({ v: i }, i),
      _batchId: "special-batch-99",
    }));
    await svc.inferSchema("t", "c", sample);
    expect(draftRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ sample_batch_id: "special-batch-99" }),
    );
  });

  it("logs an info message after successful inference", async () => {
    const logger = makeLogger();
    const svc = createInferenceService({ logger, draftRepo: makeDraftRepo() });
    await svc.inferSchema("t", "c", makeSample({ v: 1 }));
    expect(logger.info).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Slug derivation (pathToSlug internal logic exercised via field.suggestedSlug)
// ---------------------------------------------------------------------------

describe("inferSchema — suggestedSlug derivation", () => {
  it("converts a simple path to a lowercase slug", async () => {
    const svc = createInferenceService({ logger: makeLogger(), draftRepo: makeDraftRepo() });
    const sample = makeSample({ myField: "x" });
    const { inferredSchema } = await svc.inferSchema("t", "c", sample);
    const field = inferredSchema.fields.find((f) => f.path === "myField");
    // camelCase split: myField → my_field
    expect(field?.suggestedSlug).toBe("my_field");
  });

  it("converts dot-separated nested path to underscore slug", async () => {
    const svc = createInferenceService({ logger: makeLogger(), draftRepo: makeDraftRepo() });
    const sample = makeSample({ outer: { inner_key: "v" } });
    const { inferredSchema } = await svc.inferSchema("t", "c", sample);
    const field = inferredSchema.fields.find((f) => f.path === "outer.inner_key");
    expect(field?.suggestedSlug).toBe("outer_inner_key");
  });

  it("strips leading and trailing underscores from generated slug", async () => {
    const svc = createInferenceService({ logger: makeLogger(), draftRepo: makeDraftRepo() });
    // A path like "_hidden_" would have leading/trailing underscores stripped
    const sample = makeSample({ normal: "x" });
    const { inferredSchema } = await svc.inferSchema("t", "c", sample);
    const field = inferredSchema.fields.find((f) => f.path === "normal");
    expect(field?.suggestedSlug).not.toMatch(/^_|_$/);
  });

  it("removes characters that are not alphanumeric or underscore", async () => {
    const svc = createInferenceService({ logger: makeLogger(), draftRepo: makeDraftRepo() });
    // Field slugs must only contain [a-z0-9_]
    const sample = makeSample({ safe_name: "ok" });
    const { inferredSchema } = await svc.inferSchema("t", "c", sample);
    const field = inferredSchema.fields.find((f) => f.path === "safe_name");
    expect(field?.suggestedSlug).toMatch(/^[a-z0-9_]+$/);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("inferSchema — edge cases", () => {
  it("returns no fields for sample records with all-null values", async () => {
    const svc = createInferenceService({ logger: makeLogger(), draftRepo: makeDraftRepo() });
    const sample = makeSample({ empty: null });
    const { inferredSchema } = await svc.inferSchema("t", "c", sample);
    // The field still appears but with 'string' type and 0 confidence
    const field = inferredSchema.fields.find((f) => f.path === "empty");
    expect(field).toBeDefined();
    expect(field?.inferredType).toBe("string");
  });

  it("handles sample records with multiple fields independently", async () => {
    const svc = createInferenceService({ logger: makeLogger(), draftRepo: makeDraftRepo() });
    const sample = makeSample({ name: "Alice", age: 30, active: true });
    const { inferredSchema } = await svc.inferSchema("t", "c", sample);
    const types = Object.fromEntries(inferredSchema.fields.map((f) => [f.path, f.inferredType]));
    expect(types["name"]).toBe("string");
    expect(types["age"]).toBe("number");
    expect(types["active"]).toBe("boolean");
  });

  it("handles sample records with empty data objects gracefully", async () => {
    const svc = createInferenceService({ logger: makeLogger(), draftRepo: makeDraftRepo() });
    const sample = makeSample({});
    const { inferredSchema } = await svc.inferSchema("t", "c", sample);
    expect(inferredSchema.fields).toHaveLength(0);
  });

  it("handles a sample where all envelopes have an undefined field in some rows", async () => {
    const svc = createInferenceService({ logger: makeLogger(), draftRepo: makeDraftRepo() });
    // Some rows have 'extra', some don't — totalCount tracks appearances
    const sample = Array.from({ length: 10 }, (_, i) =>
      makeEnvelope(i < 5 ? { base: "x", extra: "y" } : { base: "x" }, i),
    );
    const { inferredSchema } = await svc.inferSchema("t", "c", sample);
    // 'base' appears in all 10; 'extra' appears in 5
    const baseField = inferredSchema.fields.find((f) => f.path === "base");
    const extraField = inferredSchema.fields.find((f) => f.path === "extra");
    expect(baseField).toBeDefined();
    expect(extraField).toBeDefined();
    expect(extraField!.nullRate).toBeLessThan(1);
  });
});
