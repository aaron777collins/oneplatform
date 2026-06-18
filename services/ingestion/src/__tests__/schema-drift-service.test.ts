// Unit tests for the schema drift detection service.
//
// compareSchemasForDrift and inferSchema are pure functions that can be
// exercised without any I/O. The captureAndDetect integration test uses a
// mock SchemaSnapshotRepository and mock Logger to stay lightweight.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Logger } from "@oneplatform/core";
import {
  compareSchemasForDrift,
  inferSchema,
  createSchemaDriftService,
} from "../services/schema-drift-service.js";
import type { FieldSchema } from "../services/schema-drift-service.js";
import type { SchemaSnapshotRepository, SchemaSnapshotRow } from "../repositories/schema-snapshot-repository.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeField(name: string, type: string, nullable = false): FieldSchema {
  return { name, type, nullable };
}

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

type MockSnapshotRepo = {
  [K in keyof SchemaSnapshotRepository]: ReturnType<typeof vi.fn>;
};

function makeSnapshotRepo(): MockSnapshotRepo {
  return {
    save: vi.fn(),
    findLatest: vi.fn().mockResolvedValue(null),
    findRecent: vi.fn().mockResolvedValue([]),
  };
}

const CONNECTOR_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function makeSnapshotRow(fields: FieldSchema[]): SchemaSnapshotRow {
  return {
    id: "snap-0000-0000-0000-000000000000",
    connector_id: CONNECTOR_ID,
    captured_at: new Date("2026-01-01T00:00:00Z"),
    fields,
  };
}

// ---------------------------------------------------------------------------
// inferSchema — basic cases
// ---------------------------------------------------------------------------

describe("inferSchema — empty input", () => {
  it("returns an empty array when records is empty", () => {
    expect(inferSchema([])).toEqual([]);
  });
});

describe("inferSchema — single record", () => {
  it("infers string type for text values", () => {
    const result = inferSchema([{ name: "Alice" }]);
    expect(result).toEqual([makeField("name", "string", false)]);
  });

  it("infers number type for numeric values", () => {
    const result = inferSchema([{ age: 30 }]);
    expect(result).toEqual([makeField("age", "number", false)]);
  });

  it("infers boolean type", () => {
    const result = inferSchema([{ active: true }]);
    expect(result).toEqual([makeField("active", "boolean", false)]);
  });

  it("infers object type for nested objects", () => {
    const result = inferSchema([{ meta: { key: "val" } }]);
    expect(result).toEqual([makeField("meta", "object", false)]);
  });

  it("infers array type for array values", () => {
    const result = inferSchema([{ tags: ["a", "b"] }]);
    expect(result).toEqual([makeField("tags", "array", false)]);
  });

  it("marks a field as null type when value is always null", () => {
    const result = inferSchema([{ missing: null }]);
    expect(result).toEqual([makeField("missing", "null", true)]);
  });
});

describe("inferSchema — multiple records", () => {
  it("marks a field nullable when absent from at least one record", () => {
    const records = [{ id: "1", name: "Alice" }, { id: "2" }];
    const result = inferSchema(records);
    const nameField = result.find((f) => f.name === "name");
    expect(nameField?.nullable).toBe(true);
  });

  it("does not mark a field nullable when present in every record", () => {
    const records = [{ id: "1" }, { id: "2" }];
    const result = inferSchema(records);
    const idField = result.find((f) => f.name === "id");
    expect(idField?.nullable).toBe(false);
  });

  it("uses the first non-null observation to set the type", () => {
    // First record has null, second has a string — type should be "string".
    const records = [{ val: null }, { val: "hello" }];
    const result = inferSchema(records);
    const field = result.find((f) => f.name === "val");
    expect(field?.type).toBe("string");
    expect(field?.nullable).toBe(true);
  });

  it("returns fields sorted by name for deterministic output", () => {
    const records = [{ z: 1, a: 2, m: 3 }];
    const result = inferSchema(records);
    const names = result.map((f) => f.name);
    expect(names).toEqual([...names].sort());
  });

  it("collects field names from all records, not just the first", () => {
    const records = [{ a: 1 }, { b: 2 }];
    const result = inferSchema(records);
    const names = result.map((f) => f.name);
    expect(names).toContain("a");
    expect(names).toContain("b");
  });
});

// ---------------------------------------------------------------------------
// compareSchemasForDrift — no drift
// ---------------------------------------------------------------------------

describe("compareSchemasForDrift — no drift", () => {
  it("returns empty diff when schemas are identical", () => {
    const schema = [makeField("id", "string"), makeField("name", "string")];
    const result = compareSchemasForDrift(schema, schema);
    expect(result.added).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
    expect(result.changed).toHaveLength(0);
    expect(result.hasDrift).toBe(false);
  });

  it("hasDrift is false when previous and incoming are both empty", () => {
    const result = compareSchemasForDrift([], []);
    expect(result.hasDrift).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// compareSchemasForDrift — added fields
// ---------------------------------------------------------------------------

describe("compareSchemasForDrift — added fields", () => {
  it("detects a single added field", () => {
    const previous = [makeField("id", "string")];
    const incoming = [makeField("id", "string"), makeField("email", "string")];
    const result = compareSchemasForDrift(previous, incoming);
    expect(result.added).toHaveLength(1);
    expect(result.added[0]?.name).toBe("email");
    expect(result.hasDrift).toBe(true);
  });

  it("detects multiple added fields", () => {
    const previous: FieldSchema[] = [];
    const incoming = [makeField("a", "string"), makeField("b", "number")];
    const result = compareSchemasForDrift(previous, incoming);
    expect(result.added).toHaveLength(2);
  });

  it("does not report added fields as removed", () => {
    const previous = [makeField("id", "string")];
    const incoming = [makeField("id", "string"), makeField("new", "string")];
    const result = compareSchemasForDrift(previous, incoming);
    expect(result.removed).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// compareSchemasForDrift — removed fields
// ---------------------------------------------------------------------------

describe("compareSchemasForDrift — removed fields", () => {
  it("detects a single removed field", () => {
    const previous = [makeField("id", "string"), makeField("email", "string")];
    const incoming = [makeField("id", "string")];
    const result = compareSchemasForDrift(previous, incoming);
    expect(result.removed).toHaveLength(1);
    expect(result.removed[0]?.name).toBe("email");
    expect(result.hasDrift).toBe(true);
  });

  it("detects multiple removed fields", () => {
    const previous = [makeField("a", "string"), makeField("b", "number"), makeField("c", "boolean")];
    const incoming: FieldSchema[] = [];
    const result = compareSchemasForDrift(previous, incoming);
    expect(result.removed).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// compareSchemasForDrift — changed fields
// ---------------------------------------------------------------------------

describe("compareSchemasForDrift — type changes", () => {
  it("detects a type change on a field", () => {
    const previous = [makeField("amount", "string")];
    const incoming = [makeField("amount", "number")];
    const result = compareSchemasForDrift(previous, incoming);
    expect(result.changed).toHaveLength(1);
    const change = result.changed[0];
    expect(change?.name).toBe("amount");
    expect(change?.previousType).toBe("string");
    expect(change?.currentType).toBe("number");
    expect(result.hasDrift).toBe(true);
  });

  it("does not flag a change when the type is unchanged", () => {
    const previous = [makeField("amount", "number")];
    const incoming = [makeField("amount", "number")];
    const result = compareSchemasForDrift(previous, incoming);
    expect(result.changed).toHaveLength(0);
  });
});

describe("compareSchemasForDrift — nullability changes", () => {
  it("detects a nullable change (non-nullable → nullable)", () => {
    const previous = [makeField("name", "string", false)];
    const incoming = [makeField("name", "string", true)];
    const result = compareSchemasForDrift(previous, incoming);
    expect(result.changed).toHaveLength(1);
    expect(result.changed[0]?.nullabilityChanged).toBe(true);
    expect(result.hasDrift).toBe(true);
  });

  it("detects a nullable change (nullable → non-nullable)", () => {
    const previous = [makeField("status", "string", true)];
    const incoming = [makeField("status", "string", false)];
    const result = compareSchemasForDrift(previous, incoming);
    expect(result.changed).toHaveLength(1);
    expect(result.changed[0]?.nullabilityChanged).toBe(true);
  });

  it("does not flag nullabilityChanged when nullability is unchanged", () => {
    const previous = [makeField("status", "string", true)];
    const incoming = [makeField("status", "string", true)];
    const result = compareSchemasForDrift(previous, incoming);
    expect(result.changed).toHaveLength(0);
  });
});

describe("compareSchemasForDrift — combined changes", () => {
  it("reports all categories simultaneously", () => {
    const previous = [
      makeField("id", "string"),
      makeField("amount", "string"),   // will change type
      makeField("obsolete", "string"), // will be removed
    ];
    const incoming = [
      makeField("id", "string"),
      makeField("amount", "number"),   // type changed
      makeField("newField", "boolean"), // added
    ];
    const result = compareSchemasForDrift(previous, incoming);
    expect(result.added).toHaveLength(1);
    expect(result.removed).toHaveLength(1);
    expect(result.changed).toHaveLength(1);
    expect(result.hasDrift).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// captureAndDetect — integration via mock deps
// ---------------------------------------------------------------------------

describe("captureAndDetect — first sync (no prior snapshot)", () => {
  let snapshotRepo: MockSnapshotRepo;
  let logger: Logger;

  beforeEach(() => {
    snapshotRepo = makeSnapshotRepo();
    logger = makeLogger();
    snapshotRepo.findLatest.mockResolvedValue(null);
    snapshotRepo.save.mockResolvedValue(makeSnapshotRow([]));
  });

  it("returns empty diff when there is no prior snapshot", async () => {
    const service = createSchemaDriftService({
      snapshotRepo: snapshotRepo as unknown as SchemaSnapshotRepository,
      logger,
    });
    const drift = await service.captureAndDetect(CONNECTOR_ID, [{ id: "1", name: "Alice" }]);
    expect(drift.hasDrift).toBe(false);
    expect(drift.added).toHaveLength(0);
    expect(drift.removed).toHaveLength(0);
  });

  it("saves the inferred schema as the new baseline", async () => {
    const service = createSchemaDriftService({
      snapshotRepo: snapshotRepo as unknown as SchemaSnapshotRepository,
      logger,
    });
    await service.captureAndDetect(CONNECTOR_ID, [{ id: "1", name: "Alice" }]);
    expect(snapshotRepo.save.mock.calls).toHaveLength(1);
    const savedFields = snapshotRepo.save.mock.calls[0]?.[1] as FieldSchema[];
    const names = savedFields.map((f) => f.name);
    expect(names).toContain("id");
    expect(names).toContain("name");
  });
});

describe("captureAndDetect — subsequent sync with drift", () => {
  let snapshotRepo: MockSnapshotRepo;
  let logger: Logger;

  beforeEach(() => {
    snapshotRepo = makeSnapshotRepo();
    logger = makeLogger();
    // Simulate a previously captured snapshot with two fields.
    snapshotRepo.findLatest.mockResolvedValue(
      makeSnapshotRow([makeField("id", "string"), makeField("name", "string")]),
    );
    snapshotRepo.save.mockResolvedValue(makeSnapshotRow([]));
  });

  it("detects a new field added to the source", async () => {
    const service = createSchemaDriftService({
      snapshotRepo: snapshotRepo as unknown as SchemaSnapshotRepository,
      logger,
    });
    // email is new — wasn't in the snapshot.
    const drift = await service.captureAndDetect(CONNECTOR_ID, [
      { id: "1", name: "Alice", email: "alice@example.com" },
    ]);
    expect(drift.hasDrift).toBe(true);
    expect(drift.added.map((f) => f.name)).toContain("email");
  });

  it("detects a removed field", async () => {
    const service = createSchemaDriftService({
      snapshotRepo: snapshotRepo as unknown as SchemaSnapshotRepository,
      logger,
    });
    // name is missing from the new batch.
    const drift = await service.captureAndDetect(CONNECTOR_ID, [{ id: "1" }]);
    expect(drift.hasDrift).toBe(true);
    expect(drift.removed.map((f) => f.name)).toContain("name");
  });

  it("emits a warning log when drift is detected", async () => {
    const service = createSchemaDriftService({
      snapshotRepo: snapshotRepo as unknown as SchemaSnapshotRepository,
      logger,
    });
    await service.captureAndDetect(CONNECTOR_ID, [{ id: "1", name: "Alice", email: "x@x.com" }]);
    const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    expect(warnCalls.length).toBeGreaterThan(0);
  });

  it("does not emit a warning log when there is no drift", async () => {
    const service = createSchemaDriftService({
      snapshotRepo: snapshotRepo as unknown as SchemaSnapshotRepository,
      logger,
    });
    // Exact same fields as the snapshot — no drift.
    const drift = await service.captureAndDetect(CONNECTOR_ID, [
      { id: "1", name: "Alice" },
    ]);
    expect(drift.hasDrift).toBe(false);
    const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    expect(warnCalls).toHaveLength(0);
  });
});

describe("captureAndDetect — empty records batch", () => {
  it("returns no-drift and skips snapshot save when records is empty", async () => {
    const snapshotRepo = makeSnapshotRepo();
    const service = createSchemaDriftService({
      snapshotRepo: snapshotRepo as unknown as SchemaSnapshotRepository,
      logger: makeLogger(),
    });
    const drift = await service.captureAndDetect(CONNECTOR_ID, []);
    expect(drift.hasDrift).toBe(false);
    expect(snapshotRepo.save.mock.calls).toHaveLength(0);
  });
});

describe("captureAndDetect — crash safety", () => {
  it("returns empty drift and does not throw when findLatest rejects", async () => {
    const snapshotRepo = makeSnapshotRepo();
    snapshotRepo.findLatest.mockRejectedValue(new Error("DB timeout"));
    const service = createSchemaDriftService({
      snapshotRepo: snapshotRepo as unknown as SchemaSnapshotRepository,
      logger: makeLogger(),
    });
    const drift = await service.captureAndDetect(CONNECTOR_ID, [{ id: "1" }]);
    expect(drift.hasDrift).toBe(false);
  });

  it("returns empty drift and does not throw when save rejects", async () => {
    const snapshotRepo = makeSnapshotRepo();
    snapshotRepo.findLatest.mockResolvedValue(null);
    snapshotRepo.save.mockRejectedValue(new Error("write failed"));
    const service = createSchemaDriftService({
      snapshotRepo: snapshotRepo as unknown as SchemaSnapshotRepository,
      logger: makeLogger(),
    });
    const drift = await service.captureAndDetect(CONNECTOR_ID, [{ id: "1" }]);
    expect(drift.hasDrift).toBe(false);
  });

  it("logs an error when an exception occurs", async () => {
    const snapshotRepo = makeSnapshotRepo();
    snapshotRepo.findLatest.mockRejectedValue(new Error("oops"));
    const logger = makeLogger();
    const service = createSchemaDriftService({
      snapshotRepo: snapshotRepo as unknown as SchemaSnapshotRepository,
      logger,
    });
    await service.captureAndDetect(CONNECTOR_ID, [{ id: "1" }]);
    const errorCalls = (logger.error as ReturnType<typeof vi.fn>).mock.calls;
    expect(errorCalls.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// detectDrift — delegates to compareSchemasForDrift (public surface test)
// ---------------------------------------------------------------------------

describe("detectDrift (SchemaDriftService.detectDrift)", () => {
  it("returns hasDrift=false for identical schemas", () => {
    const service = createSchemaDriftService({
      snapshotRepo: makeSnapshotRepo() as unknown as SchemaSnapshotRepository,
      logger: makeLogger(),
    });
    const schema = [makeField("id", "string")];
    expect(service.detectDrift(schema, schema).hasDrift).toBe(false);
  });

  it("returns hasDrift=true when a field is added", () => {
    const service = createSchemaDriftService({
      snapshotRepo: makeSnapshotRepo() as unknown as SchemaSnapshotRepository,
      logger: makeLogger(),
    });
    const result = service.detectDrift([], [makeField("newField", "string")]);
    expect(result.hasDrift).toBe(true);
    expect(result.added).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// getHistory
// ---------------------------------------------------------------------------

describe("getHistory", () => {
  it("maps snapshot rows to DriftHistoryEntry objects", async () => {
    const snapshotRepo = makeSnapshotRepo();
    const fields = [makeField("id", "string")];
    const capturedAt = new Date("2026-01-15T12:00:00Z");
    snapshotRepo.findRecent.mockResolvedValue([
      {
        id: "snap-id-1",
        connector_id: CONNECTOR_ID,
        captured_at: capturedAt,
        fields,
      },
    ]);

    const service = createSchemaDriftService({
      snapshotRepo: snapshotRepo as unknown as SchemaSnapshotRepository,
      logger: makeLogger(),
    });

    const history = await service.getHistory(CONNECTOR_ID);
    expect(history).toHaveLength(1);
    expect(history[0]?.snapshotId).toBe("snap-id-1");
    expect(history[0]?.capturedAt).toBe(capturedAt.toISOString());
    expect(history[0]?.fields).toEqual(fields);
  });

  it("returns an empty array when no snapshots exist", async () => {
    const snapshotRepo = makeSnapshotRepo();
    snapshotRepo.findRecent.mockResolvedValue([]);

    const service = createSchemaDriftService({
      snapshotRepo: snapshotRepo as unknown as SchemaSnapshotRepository,
      logger: makeLogger(),
    });

    const history = await service.getHistory(CONNECTOR_ID);
    expect(history).toHaveLength(0);
  });
});
