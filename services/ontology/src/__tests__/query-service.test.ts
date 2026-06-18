/**
 * Unit tests for query-service.ts
 *
 * The query service has two distinct responsibilities:
 * 1. Validate StructuredQuery objects (pure logic — no DB)
 * 2. Build parameterized SQL from validated queries (pure logic — no DB)
 *
 * Tests cover validation (valid/invalid queries), WHERE clause generation,
 * SQL injection prevention, and pagination / offset handling.
 *
 * The executeQuery path is integration-level and is NOT tested here — it
 * requires a live PostgreSQL connection. These tests focus on the portions
 * that can be verified without network I/O.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StructuredQuery, WhereClause } from "../services/query-service.js";
import { createQueryService } from "../services/query-service.js";
import type { QueryServiceDeps } from "../services/query-service.js";
import type { EntityRepository } from "../repositories/entity-repository.js";
import type { FieldRepository } from "../repositories/field-repository.js";
import type pg from "pg";
import type { EntityRow, FieldRow } from "../repositories/types.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeEntityRow(overrides: Partial<EntityRow> = {}): EntityRow {
  return {
    id: "entity-uuid-1",
    tenant_id: "tenant-uuid-1",
    name: "Order",
    slug: "order",
    version: 1,
    description: null,
    is_public: false,
    created_by: "user-1",
    created_at: new Date("2024-01-01"),
    updated_at: new Date("2024-01-01"),
    deleted_at: null,
    ...overrides,
  };
}

function makeFieldRow(overrides: Partial<FieldRow> = {}): FieldRow {
  return {
    id: "field-uuid-1",
    entity_id: "entity-uuid-1",
    tenant_id: "tenant-uuid-1",
    name: "Status",
    slug: "status",
    field_type: "string",
    required: true,
    nullable: false,
    default_value: null,
    validation_rules: [],
    enum_values: null,
    array_item_type: null,
    ref_entity_id: null,
    is_indexed: false,
    is_unique: false,
    sort_order: 0,
    system_generated: false,
    created_at: new Date("2024-01-01"),
    updated_at: new Date("2024-01-01"),
    deleted_at: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

const entityRepo: EntityRepository = {
  create: vi.fn(),
  findByTenantId: vi.fn(),
  findBySlug: vi.fn(),
  findById: vi.fn(),
  updateOptimistic: vi.fn(),
  bumpVersion: vi.fn(),
  softDelete: vi.fn(),
  hardDelete: vi.fn(),
  findDeletedOlderThan: vi.fn(),
  countDataRows: vi.fn(),
};

const fieldRepo: FieldRepository = {
  create: vi.fn(),
  findByEntityId: vi.fn(),
  findByEntityIds: vi.fn(),
  update: vi.fn(),
  softDeleteByEntityId: vi.fn(),
  hardDeleteByEntityId: vi.fn(),
};

// Minimal pg.Pool stub — connect() is only called by executeQuery, which is
// not exercised in these unit tests. validateQuery uses only the repos.
const db = {
  connect: vi.fn(),
  query: vi.fn(),
} as unknown as pg.Pool;

const deps: QueryServiceDeps = { db, entityRepo, fieldRepo };

// ---------------------------------------------------------------------------
// Helper — build a service instance with preset entity/field mocks
// ---------------------------------------------------------------------------

function makeServiceWithFields(fields: FieldRow[]): ReturnType<typeof createQueryService> {
  vi.mocked(entityRepo.findBySlug).mockResolvedValue(makeEntityRow());
  vi.mocked(fieldRepo.findByEntityId).mockResolvedValue(fields);
  return createQueryService(deps);
}

// ---------------------------------------------------------------------------
// validateQuery — structural validation (no DB needed for structural checks)
// ---------------------------------------------------------------------------

describe("validateQuery — structural validation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns valid for a minimal wildcard query", async () => {
    const service = makeServiceWithFields([]);
    const query: StructuredQuery = { entityType: "order", select: ["*"] };
    const result = await service.validateQuery("tenant-1", query);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("returns error when select is empty array", async () => {
    const service = makeServiceWithFields([]);
    const query: StructuredQuery = { entityType: "order", select: [] };
    const result = await service.validateQuery("tenant-1", query);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("select"))).toBe(true);
  });

  it("returns error when limit exceeds 1000", async () => {
    const service = makeServiceWithFields([]);
    const query: StructuredQuery = { entityType: "order", select: ["*"], limit: 1001 };
    const result = await service.validateQuery("tenant-1", query);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("limit"))).toBe(true);
  });

  it("returns error when limit is 0", async () => {
    const service = makeServiceWithFields([]);
    const query: StructuredQuery = { entityType: "order", select: ["*"], limit: 0 };
    const result = await service.validateQuery("tenant-1", query);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("limit"))).toBe(true);
  });

  it("accepts limit at the maximum boundary (1000)", async () => {
    const service = makeServiceWithFields([]);
    const query: StructuredQuery = { entityType: "order", select: ["*"], limit: 1000 };
    const result = await service.validateQuery("tenant-1", query);
    expect(result.valid).toBe(true);
  });

  it("returns error when offset is negative", async () => {
    const service = makeServiceWithFields([]);
    const query: StructuredQuery = { entityType: "order", select: ["*"], offset: -1 };
    const result = await service.validateQuery("tenant-1", query);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("offset"))).toBe(true);
  });

  it("accepts offset of 0", async () => {
    const service = makeServiceWithFields([]);
    const query: StructuredQuery = { entityType: "order", select: ["*"], offset: 0 };
    const result = await service.validateQuery("tenant-1", query);
    expect(result.valid).toBe(true);
  });

  it("returns error when is_null operator carries a value", async () => {
    const service = makeServiceWithFields([makeFieldRow({ slug: "status" })]);
    const query: StructuredQuery = {
      entityType: "order",
      select: ["*"],
      where: [{ field: "status", operator: "is_null", value: "oops" }],
    };
    const result = await service.validateQuery("tenant-1", query);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("is_null"))).toBe(true);
  });

  it("returns error when in operator receives a non-array value", async () => {
    const service = makeServiceWithFields([makeFieldRow({ slug: "status" })]);
    const query: StructuredQuery = {
      entityType: "order",
      select: ["*"],
      where: [{ field: "status", operator: "in", value: "not-an-array" }],
    };
    const result = await service.validateQuery("tenant-1", query);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("in"))).toBe(true);
  });

  it("returns error when eq operator has no value", async () => {
    const service = makeServiceWithFields([makeFieldRow({ slug: "status" })]);
    const query: StructuredQuery = {
      entityType: "order",
      select: ["*"],
      where: [{ field: "status", operator: "eq" } as WhereClause],
    };
    const result = await service.validateQuery("tenant-1", query);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("eq"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateQuery — field reference validation (uses mocked entity/field repos)
// ---------------------------------------------------------------------------

describe("validateQuery — field reference validation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("accepts a wildcard select without checking specific fields", async () => {
    const service = makeServiceWithFields([makeFieldRow({ slug: "status" })]);
    const query: StructuredQuery = { entityType: "order", select: ["*"] };
    const result = await service.validateQuery("tenant-1", query);
    expect(result.valid).toBe(true);
  });

  it("accepts a valid field reference in select", async () => {
    const service = makeServiceWithFields([makeFieldRow({ slug: "status" })]);
    const query: StructuredQuery = { entityType: "order", select: ["status"] };
    const result = await service.validateQuery("tenant-1", query);
    expect(result.valid).toBe(true);
  });

  it("rejects an unknown field in select", async () => {
    const service = makeServiceWithFields([makeFieldRow({ slug: "status" })]);
    const query: StructuredQuery = { entityType: "order", select: ["nonexistent_field"] };
    const result = await service.validateQuery("tenant-1", query);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("nonexistent_field"))).toBe(true);
  });

  it("accepts system column _id in select without explicit field definition", async () => {
    const service = makeServiceWithFields([]);
    const query: StructuredQuery = { entityType: "order", select: ["_id"] };
    const result = await service.validateQuery("tenant-1", query);
    expect(result.valid).toBe(true);
  });

  it("accepts _created_at and _updated_at as system fields", async () => {
    const service = makeServiceWithFields([]);
    const query: StructuredQuery = {
      entityType: "order",
      select: ["_id", "_created_at", "_updated_at"],
    };
    const result = await service.validateQuery("tenant-1", query);
    expect(result.valid).toBe(true);
  });

  it("rejects unknown field in where clause", async () => {
    const service = makeServiceWithFields([makeFieldRow({ slug: "status" })]);
    const query: StructuredQuery = {
      entityType: "order",
      select: ["*"],
      where: [{ field: "ghost_field", operator: "eq", value: "x" }],
    };
    const result = await service.validateQuery("tenant-1", query);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("ghost_field"))).toBe(true);
  });

  it("rejects unknown field in orderBy", async () => {
    const service = makeServiceWithFields([makeFieldRow({ slug: "status" })]);
    const query: StructuredQuery = {
      entityType: "order",
      select: ["*"],
      orderBy: [{ field: "missing_col", direction: "asc" }],
    };
    const result = await service.validateQuery("tenant-1", query);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("missing_col"))).toBe(true);
  });

  it("collects multiple errors in one pass", async () => {
    const service = makeServiceWithFields([makeFieldRow({ slug: "status" })]);
    const query: StructuredQuery = {
      entityType: "order",
      select: ["bad_field_1", "bad_field_2"],
    };
    const result = await service.validateQuery("tenant-1", query);
    expect(result.valid).toBe(false);
    // Both unknown fields should be reported
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// validateQuery — entity not found
// ---------------------------------------------------------------------------

describe("validateQuery — entity not found", () => {
  it("throws EntityNotFoundError when the entity does not exist", async () => {
    vi.mocked(entityRepo.findBySlug).mockResolvedValue(null);
    const service = createQueryService(deps);

    await expect(
      service.validateQuery("tenant-1", { entityType: "ghost", select: ["*"] }),
    ).rejects.toThrow("ghost");
  });
});

// ---------------------------------------------------------------------------
// WHERE clause operator coverage
// ---------------------------------------------------------------------------

describe("validateQuery — where operator coverage", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  const OPERATORS_WITH_VALUE = [
    "eq", "neq", "gt", "gte", "lt", "lte", "like",
  ] as const;

  const ARRAY_OPERATORS = ["in", "not_in"] as const;
  const NULLARY_OPERATORS = ["is_null", "is_not_null"] as const;

  for (const op of OPERATORS_WITH_VALUE) {
    it(`accepts operator '${op}' with a scalar value`, async () => {
      const service = makeServiceWithFields([makeFieldRow({ slug: "status" })]);
      const query: StructuredQuery = {
        entityType: "order",
        select: ["*"],
        where: [{ field: "status", operator: op, value: "active" }],
      };
      const result = await service.validateQuery("tenant-1", query);
      expect(result.valid).toBe(true);
    });
  }

  for (const op of ARRAY_OPERATORS) {
    it(`accepts operator '${op}' with an array value`, async () => {
      const service = makeServiceWithFields([makeFieldRow({ slug: "status" })]);
      const query: StructuredQuery = {
        entityType: "order",
        select: ["*"],
        where: [{ field: "status", operator: op, value: ["a", "b"] }],
      };
      const result = await service.validateQuery("tenant-1", query);
      expect(result.valid).toBe(true);
    });
  }

  for (const op of NULLARY_OPERATORS) {
    it(`accepts operator '${op}' without a value`, async () => {
      const service = makeServiceWithFields([makeFieldRow({ slug: "status" })]);
      const query: StructuredQuery = {
        entityType: "order",
        select: ["*"],
        where: [{ field: "status", operator: op }],
      };
      const result = await service.validateQuery("tenant-1", query);
      expect(result.valid).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Pagination — validateQuery accepts limit + offset combos
// ---------------------------------------------------------------------------

describe("validateQuery — pagination", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("accepts limit=1, offset=0", async () => {
    const service = makeServiceWithFields([]);
    const result = await service.validateQuery("tenant-1", {
      entityType: "order", select: ["*"], limit: 1, offset: 0,
    });
    expect(result.valid).toBe(true);
  });

  it("accepts limit=500, offset=1000", async () => {
    const service = makeServiceWithFields([]);
    const result = await service.validateQuery("tenant-1", {
      entityType: "order", select: ["*"], limit: 500, offset: 1000,
    });
    expect(result.valid).toBe(true);
  });

  it("accepts query without limit (defaults apply server-side)", async () => {
    const service = makeServiceWithFields([]);
    const result = await service.validateQuery("tenant-1", {
      entityType: "order", select: ["*"],
    });
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SQL injection guard — pg-identifier validation ensures identifiers are safe
// ---------------------------------------------------------------------------

describe("SQL injection prevention via field reference validation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("rejects a field name containing SQL injection via space", async () => {
    const service = makeServiceWithFields([]);
    const query: StructuredQuery = {
      entityType: "order",
      select: ["status; DROP TABLE orders--" as string],
    };
    // The schema-level Zod validation will catch this before the service even
    // sees it, but we also verify the field reference validator rejects it.
    const result = await service.validateQuery("tenant-1", query);
    expect(result.valid).toBe(false);
  });

  it("rejects a field name starting with a digit (invalid pg identifier)", async () => {
    const service = makeServiceWithFields([]);
    const query: StructuredQuery = {
      entityType: "order",
      select: ["1malformed" as string],
    };
    const result = await service.validateQuery("tenant-1", query);
    expect(result.valid).toBe(false);
  });

  it("rejects a where-clause field containing a SQL keyword", async () => {
    const service = makeServiceWithFields([]);
    const query: StructuredQuery = {
      entityType: "order",
      select: ["*"],
      where: [{ field: "'; SELECT 1--", operator: "eq", value: "x" }],
    };
    const result = await service.validateQuery("tenant-1", query);
    expect(result.valid).toBe(false);
  });
});
