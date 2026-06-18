// Unit tests for GdprRequestRepository.
//
// The repository is thin SQL-over-pg. We mock pg.Pool to verify:
//   - correct parameterized queries are issued (no string concatenation)
//   - correct column projection
//   - correct pagination cursor encoding
//   - null handling for optional fields

import { describe, it, expect, vi, beforeEach } from "vitest";
import { GdprRequestRepository } from "../repositories/gdpr-request-repository.js";
import type { GdprRequestRow } from "../repositories/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRow(overrides: Partial<GdprRequestRow> = {}): GdprRequestRow {
  return {
    id: "aaaaaaaa-0000-0000-0000-000000000001",
    tenant_id: "tenant-1",
    user_id: "user-1",
    type: "access",
    status: "pending",
    requester_id: "user-1",
    requested_at: new Date("2024-01-01T00:00:00Z"),
    completed_at: null,
    result_url: null,
    error_detail: null,
    ...overrides,
  };
}

function makeMockPool(rows: GdprRequestRow[] = []): {
  pool: { query: ReturnType<typeof vi.fn> };
} {
  const pool = {
    query: vi.fn().mockResolvedValue({ rows, rowCount: rows.length }),
  };
  return { pool };
}

// ---------------------------------------------------------------------------
// create()
// ---------------------------------------------------------------------------

describe("GdprRequestRepository.create()", () => {
  it("executes a parameterized INSERT and returns the row", async () => {
    const row = makeRow();
    const { pool } = makeMockPool([row]);
    const repo = new GdprRequestRepository(pool as never);

    const result = await repo.create({
      tenant_id: "tenant-1",
      user_id: "user-1",
      type: "access",
      requester_id: "user-1",
    });

    expect(pool.query).toHaveBeenCalledOnce();
    const [sql, params] = pool.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/INSERT INTO gateway\.gdpr_requests/);
    // Must use parameterized query — no string interpolation of user data
    expect(params).toEqual(["tenant-1", "user-1", "access", "user-1"]);
    expect(result).toBe(row);
  });

  it("throws if INSERT returns no rows", async () => {
    const { pool } = makeMockPool([]);
    const repo = new GdprRequestRepository(pool as never);

    await expect(
      repo.create({
        tenant_id: "t",
        user_id: "u",
        type: "deletion",
        requester_id: "u",
      }),
    ).rejects.toThrow("INSERT INTO gateway.gdpr_requests returned no rows");
  });
});

// ---------------------------------------------------------------------------
// findById()
// ---------------------------------------------------------------------------

describe("GdprRequestRepository.findById()", () => {
  it("returns the row when found", async () => {
    const row = makeRow();
    const { pool } = makeMockPool([row]);
    const repo = new GdprRequestRepository(pool as never);

    const result = await repo.findById(row.id);

    expect(result).toBe(row);
    const [sql, params] = pool.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/WHERE id = \$1/);
    expect(params).toEqual([row.id]);
  });

  it("returns null when not found", async () => {
    const { pool } = makeMockPool([]);
    const repo = new GdprRequestRepository(pool as never);

    const result = await repo.findById("nonexistent-id");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// findByTenantId()
// ---------------------------------------------------------------------------

describe("GdprRequestRepository.findByTenantId()", () => {
  it("queries by tenant_id with default limit", async () => {
    const rows = [makeRow(), makeRow({ id: "bbbbbbbb-0000-0000-0000-000000000002" })];
    const { pool } = makeMockPool(rows);
    const repo = new GdprRequestRepository(pool as never);

    const result = await repo.findByTenantId("tenant-1");

    expect(result).toHaveLength(2);
    const [sql, params] = pool.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/tenant_id = \$1/);
    expect(params[0]).toBe("tenant-1");
    // Default limit is 50
    expect(params[params.length - 1]).toBe(50);
  });

  it("adds user_id filter when provided", async () => {
    const { pool } = makeMockPool([]);
    const repo = new GdprRequestRepository(pool as never);

    await repo.findByTenantId("tenant-1", { userId: "user-42" });

    const [sql, params] = pool.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/user_id = \$/);
    expect(params).toContain("user-42");
  });

  it("adds status filter when provided", async () => {
    const { pool } = makeMockPool([]);
    const repo = new GdprRequestRepository(pool as never);

    await repo.findByTenantId("tenant-1", { status: "completed" });

    const [sql, params] = pool.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/status = \$/);
    expect(params).toContain("completed");
  });

  it("adds cursor pagination clause when cursor is valid", async () => {
    const { pool } = makeMockPool([]);
    const repo = new GdprRequestRepository(pool as never);

    const cursor = "2024-01-01T00:00:00.000Z|aaaaaaaa-0000-0000-0000-000000000001";
    await repo.findByTenantId("tenant-1", { cursor });

    const [sql, params] = pool.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/requested_at.*<.*\$\d+::timestamptz/);
    expect(params).toContain("2024-01-01T00:00:00.000Z");
    expect(params).toContain("aaaaaaaa-0000-0000-0000-000000000001");
  });

  it("ignores a malformed cursor gracefully", async () => {
    const { pool } = makeMockPool([]);
    const repo = new GdprRequestRepository(pool as never);

    // A cursor with no '|' separator is ignored — no cursor clause injected
    await repo.findByTenantId("tenant-1", { cursor: "bad-cursor-no-pipe" });

    const [sql] = pool.query.mock.calls[0] as [string, unknown[]];
    // Should not contain the timestamptz cast that the cursor clause adds
    expect(sql).not.toMatch(/timestamptz/);
  });
});

// ---------------------------------------------------------------------------
// updateStatus()
// ---------------------------------------------------------------------------

describe("GdprRequestRepository.updateStatus()", () => {
  it("updates only status when no optional fields provided", async () => {
    const row = makeRow({ status: "processing" });
    const { pool } = makeMockPool([row]);
    const repo = new GdprRequestRepository(pool as never);

    const result = await repo.updateStatus(row.id, { status: "processing" });

    expect(result).toBe(row);
    const [sql, params] = pool.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/UPDATE gateway\.gdpr_requests/);
    expect(sql).toMatch(/status = \$2/);
    expect(params[0]).toBe(row.id);
    expect(params[1]).toBe("processing");
  });

  it("includes completed_at when provided", async () => {
    const now = new Date();
    const row = makeRow({ status: "completed", completed_at: now });
    const { pool } = makeMockPool([row]);
    const repo = new GdprRequestRepository(pool as never);

    await repo.updateStatus(row.id, { status: "completed", completed_at: now });

    const [sql, params] = pool.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/completed_at = \$/);
    expect(params).toContain(now);
  });

  it("includes result_url when provided", async () => {
    const row = makeRow({ status: "completed", result_url: "data:application/json;base64,xyz" });
    const { pool } = makeMockPool([row]);
    const repo = new GdprRequestRepository(pool as never);

    await repo.updateStatus(row.id, {
      status: "completed",
      result_url: "data:application/json;base64,xyz",
    });

    const [sql, params] = pool.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/result_url = \$/);
    expect(params).toContain("data:application/json;base64,xyz");
  });

  it("includes error_detail when provided", async () => {
    const row = makeRow({ status: "failed", error_detail: "auth service unavailable" });
    const { pool } = makeMockPool([row]);
    const repo = new GdprRequestRepository(pool as never);

    await repo.updateStatus(row.id, {
      status: "failed",
      error_detail: "auth service unavailable",
    });

    const [sql, params] = pool.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/error_detail = \$/);
    expect(params).toContain("auth service unavailable");
  });

  it("returns null when the row is not found", async () => {
    const { pool } = makeMockPool([]);
    const repo = new GdprRequestRepository(pool as never);

    const result = await repo.updateStatus("nonexistent", { status: "completed" });
    expect(result).toBeNull();
  });
});
