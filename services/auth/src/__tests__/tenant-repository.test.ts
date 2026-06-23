// Unit tests for TenantRepository's new methods: list, update, delete.
//
// The pool is mocked at the query level — no real database is required.
// Each test asserts both the SQL parameters (parameterized queries) and the
// return value shape.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type pg from "pg";
import { TenantRepository } from "../repositories/tenant-repository.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTenantRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "tenant-1",
    name: "Acme Corp",
    slug: "acme-corp",
    settings: {},
    created_at: new Date("2024-01-01T00:00:00Z"),
    updated_at: new Date("2024-01-01T00:00:00Z"),
    deleted_at: null,
    ...overrides,
  };
}

/**
 * Build a mock pg.Pool whose query() method returns queued results in order.
 * Each call to query() pops from the front of the results queue.
 */
function makePool(
  ...queryResults: Array<{ rows: unknown[]; rowCount?: number }>
): pg.Pool {
  const queue = [...queryResults];
  return {
    query: vi.fn().mockImplementation(() => {
      const next = queue.shift();
      if (next === undefined) {
        throw new Error("Unexpected extra pool.query() call");
      }
      return Promise.resolve({ rows: next.rows, rowCount: next.rowCount ?? next.rows.length });
    }),
  } as unknown as pg.Pool;
}

// ---------------------------------------------------------------------------
// list()
// ---------------------------------------------------------------------------

describe("TenantRepository.list()", () => {
  it("returns tenants, total, and nextCursor from paginated query", async () => {
    const tenant = makeTenantRow();
    const pool = makePool(
      { rows: [{ count: "5" }] },     // COUNT query
      { rows: [tenant] }               // SELECT query
    );
    const repo = new TenantRepository(pool);

    const result = await repo.list({ limit: 20 });

    expect(result.total).toBe(5);
    expect(result.tenants).toHaveLength(1);
    expect(result.tenants[0]).toMatchObject({ id: "tenant-1", name: "Acme Corp" });
    // Only 1 row returned but limit is 20 — no next page
    expect(result.nextCursor).toBeNull();
  });

  it("returns nextCursor when results fill the page", async () => {
    // Return exactly `limit` rows to trigger nextCursor generation
    const tenant = makeTenantRow();
    const pool = makePool(
      { rows: [{ count: "10" }] },
      { rows: [tenant] }
    );
    const repo = new TenantRepository(pool);

    const result = await repo.list({ limit: 1 });
    // Exactly limit rows returned → nextCursor should be set
    expect(result.nextCursor).not.toBeNull();
  });

  it("returns empty list and zero total when no tenants exist", async () => {
    const pool = makePool(
      { rows: [{ count: "0" }] },
      { rows: [] }
    );
    const repo = new TenantRepository(pool);

    const result = await repo.list({ limit: 20 });
    expect(result.total).toBe(0);
    expect(result.tenants).toHaveLength(0);
    expect(result.nextCursor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// update()
// ---------------------------------------------------------------------------

describe("TenantRepository.update()", () => {
  it("returns updated tenant when both name and settings are provided", async () => {
    const updated = makeTenantRow({ name: "New Name", settings: { maxUsers: 10 } });
    const pool = makePool({ rows: [updated] });
    const repo = new TenantRepository(pool);

    const result = await repo.update("tenant-1", {
      name: "New Name",
      settings: { maxUsers: 10 },
    });

    expect(result).toMatchObject({ name: "New Name" });
    // Verify parameterized — never string-interpolated values
    const call = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    const params = call[1] as unknown[];
    expect(params[0]).toBe("tenant-1"); // $1 = id
    expect(params[1]).toBe("New Name"); // $2 = name
    expect(params[2]).toBe(JSON.stringify({ maxUsers: 10 })); // $3 = settings
  });

  it("returns updated tenant when only name is provided", async () => {
    const updated = makeTenantRow({ name: "Renamed" });
    const pool = makePool({ rows: [updated] });
    const repo = new TenantRepository(pool);

    const result = await repo.update("tenant-1", { name: "Renamed" });
    expect(result?.name).toBe("Renamed");
  });

  it("returns updated tenant when only settings are provided", async () => {
    const updated = makeTenantRow({ settings: { rateLimitTier: "premium" } });
    const pool = makePool({ rows: [updated] });
    const repo = new TenantRepository(pool);

    const result = await repo.update("tenant-1", {
      settings: { rateLimitTier: "premium" },
    });
    expect(result?.settings).toEqual({ rateLimitTier: "premium" });
  });

  it("returns null when tenant does not exist or is deleted", async () => {
    const pool = makePool({ rows: [] });
    const repo = new TenantRepository(pool);

    const result = await repo.update("missing-id", { name: "Anything" });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// delete()
// ---------------------------------------------------------------------------

describe("TenantRepository.delete()", () => {
  it("returns true and passes tenant id as parameterized value", async () => {
    const pool = makePool({ rows: [{ id: "tenant-1" }], rowCount: 1 });
    const repo = new TenantRepository(pool);

    const result = await repo.delete("tenant-1");

    expect(result).toBe(true);
    const call = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    const params = call[1] as unknown[];
    expect(params[0]).toBe("tenant-1");
  });

  it("returns false when no rows were updated (already deleted or never existed)", async () => {
    const pool = makePool({ rows: [], rowCount: 0 });
    const repo = new TenantRepository(pool);

    const result = await repo.delete("ghost-id");
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// findById() — regression: deleted tenants must not be returned
// ---------------------------------------------------------------------------

describe("TenantRepository.findById() — soft-delete filter", () => {
  it("returns null for soft-deleted tenants (deleted_at IS NOT NULL excludes them)", async () => {
    // Pool returns no rows because the SQL includes AND deleted_at IS NULL
    const pool = makePool({ rows: [] });
    const repo = new TenantRepository(pool);

    const result = await repo.findById("deleted-tenant");
    expect(result).toBeNull();

    // Verify the query contains the deleted_at filter
    const call = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    const sql = call[0] as string;
    expect(sql).toContain("deleted_at IS NULL");
  });
});
