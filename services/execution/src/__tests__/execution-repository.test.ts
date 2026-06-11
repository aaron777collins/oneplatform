// Unit tests for repositories/execution-repository.ts
//
// Tests: create, findById, findByTenantAndId, findByTenantId (keyset pagination
// + filters), updateStatus (dynamic SET builder), findByPluginId,
// countInflightByPluginId, ensurePartition (date validation + DDL safety).

import { describe, it, expect, vi, beforeEach } from "vitest";
import type pg from "pg";
import { ExecutionRepository } from "../repositories/execution-repository.js";
import type {
  ExecutionRow,
  CreateExecutionData,
  UpdateExecutionData,
} from "../repositories/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TENANT_ID = "550e8400-e29b-41d4-a716-446655440000";
const EXEC_ID = "550e8400-e29b-41d4-a716-446655440001";
const PLUGIN_ID = "550e8400-e29b-41d4-a716-446655440002";

const baseRow: ExecutionRow = {
  id: EXEC_ID,
  tenant_id: TENANT_ID,
  type: "code",
  status: "pending",
  language: "js",
  sandbox_type: "isolated-vm",
  plugin_id: null,
  pipeline_id: null,
  pipeline_run_id: null,
  hook_context: false,
  code_hash: null,
  started_at: new Date("2026-01-01T00:00:00Z"),
  completed_at: null,
  duration_ms: null,
  memory_peak_mb: null,
  exit_code: null,
  error_code: null,
  error_message: null,
  error_stack: null,
  trace_id: "trace-abc",
  initiated_by: "user-001",
  sandbox_vm_run: null,
};

function makeMockPool(rows: ExecutionRow[] = []): pg.Pool {
  return {
    query: vi.fn().mockResolvedValue({ rows }),
  } as unknown as pg.Pool;
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

describe("ExecutionRepository.create", () => {
  it("returns the inserted row when INSERT succeeds", async () => {
    const pool = makeMockPool([baseRow]);
    const repo = new ExecutionRepository(pool);
    const data: CreateExecutionData = {
      tenant_id: TENANT_ID,
      type: "code",
      language: "js",
      sandbox_type: "isolated-vm",
      trace_id: "trace-abc",
      initiated_by: "user-001",
    };

    const result = await repo.create(data);
    expect(result).toEqual(baseRow);
  });

  it("passes all required fields as positional parameters", async () => {
    const pool = makeMockPool([baseRow]);
    const repo = new ExecutionRepository(pool);
    const data: CreateExecutionData = {
      tenant_id: TENANT_ID,
      type: "connector-run",
      language: "python",
      sandbox_type: "docker",
      trace_id: "trace-xyz",
      initiated_by: "service",
    };

    await repo.create(data);

    const mockQuery = pool.query as ReturnType<typeof vi.fn>;
    const callArgs = mockQuery.mock.calls[0] as [string, unknown[]];
    const params = callArgs[1];
    expect(params[0]).toBe(TENANT_ID);
    expect(params[1]).toBe("connector-run");
    expect(params[2]).toBe("python");
    expect(params[3]).toBe("docker");
  });

  it("sends null for absent optional fields (plugin_id, pipeline_id, etc.)", async () => {
    const pool = makeMockPool([baseRow]);
    const repo = new ExecutionRepository(pool);
    const data: CreateExecutionData = {
      tenant_id: TENANT_ID,
      type: "code",
      language: "js",
      sandbox_type: "isolated-vm",
      trace_id: "t",
      initiated_by: "u",
    };

    await repo.create(data);

    const mockQuery = pool.query as ReturnType<typeof vi.fn>;
    const callArgs = mockQuery.mock.calls[0] as [string, unknown[]];
    const params = callArgs[1];
    // params[6] = plugin_id, [7] = pipeline_id, [8] = pipeline_run_id
    expect(params[6]).toBeNull();
    expect(params[7]).toBeNull();
    expect(params[8]).toBeNull();
  });

  it("throws when INSERT returns no rows", async () => {
    const pool = makeMockPool([]); // empty rows
    const repo = new ExecutionRepository(pool);
    const data: CreateExecutionData = {
      tenant_id: TENANT_ID,
      type: "code",
      language: "js",
      sandbox_type: "isolated-vm",
      trace_id: "t",
      initiated_by: "u",
    };

    await expect(repo.create(data)).rejects.toThrow(
      "INSERT INTO execution.executions returned no rows",
    );
  });

  it("propagates optional fields when provided", async () => {
    const pool = makeMockPool([{ ...baseRow, plugin_id: PLUGIN_ID }]);
    const repo = new ExecutionRepository(pool);
    const data: CreateExecutionData = {
      tenant_id: TENANT_ID,
      type: "connector-run",
      language: "js",
      sandbox_type: "isolated-vm",
      trace_id: "t",
      initiated_by: "u",
      plugin_id: PLUGIN_ID,
      hook_context: true,
    };

    await repo.create(data);

    const mockQuery = pool.query as ReturnType<typeof vi.fn>;
    const callArgs = mockQuery.mock.calls[0] as [string, unknown[]];
    const params = callArgs[1];
    expect(params[6]).toBe(PLUGIN_ID);
    expect(params[9]).toBe(true); // hook_context
  });
});

// ---------------------------------------------------------------------------
// findById
// ---------------------------------------------------------------------------

describe("ExecutionRepository.findById", () => {
  it("returns the row when found", async () => {
    const pool = makeMockPool([baseRow]);
    const repo = new ExecutionRepository(pool);
    const result = await repo.findById(EXEC_ID);
    expect(result).toEqual(baseRow);
  });

  it("returns null when not found", async () => {
    const pool = makeMockPool([]);
    const repo = new ExecutionRepository(pool);
    const result = await repo.findById("nonexistent-id");
    expect(result).toBeNull();
  });

  it("queries by id without tenant scoping in WHERE clause", async () => {
    const pool = makeMockPool([baseRow]);
    const repo = new ExecutionRepository(pool);
    await repo.findById(EXEC_ID);

    const mockQuery = pool.query as ReturnType<typeof vi.fn>;
    const callArgs = mockQuery.mock.calls[0] as [string, unknown[]];
    const sql = callArgs[0];
    // The WHERE clause must not filter by tenant_id
    expect(sql).not.toContain("tenant_id = ");
    // Single parameter: the execution id
    const params = callArgs[1];
    expect(params).toHaveLength(1);
    expect(params[0]).toBe(EXEC_ID);
  });
});

// ---------------------------------------------------------------------------
// findByTenantAndId
// ---------------------------------------------------------------------------

describe("ExecutionRepository.findByTenantAndId", () => {
  it("returns the row when tenant and id match", async () => {
    const pool = makeMockPool([baseRow]);
    const repo = new ExecutionRepository(pool);
    const result = await repo.findByTenantAndId(TENANT_ID, EXEC_ID);
    expect(result).toEqual(baseRow);
  });

  it("returns null when no row matches (cross-tenant or not found)", async () => {
    const pool = makeMockPool([]);
    const repo = new ExecutionRepository(pool);
    const result = await repo.findByTenantAndId("other-tenant", EXEC_ID);
    expect(result).toBeNull();
  });

  it("queries with both id and tenant_id parameters", async () => {
    const pool = makeMockPool([baseRow]);
    const repo = new ExecutionRepository(pool);
    await repo.findByTenantAndId(TENANT_ID, EXEC_ID);

    const mockQuery = pool.query as ReturnType<typeof vi.fn>;
    const callArgs = mockQuery.mock.calls[0] as [string, unknown[]];
    const sql = callArgs[0];
    const params = callArgs[1];
    expect(sql).toContain("tenant_id");
    expect(params).toContain(EXEC_ID);
    expect(params).toContain(TENANT_ID);
  });
});

// ---------------------------------------------------------------------------
// findByTenantId — keyset pagination + filters
// ---------------------------------------------------------------------------

describe("ExecutionRepository.findByTenantId", () => {
  it("returns rows for a tenant without filters", async () => {
    const pool = makeMockPool([baseRow]);
    const repo = new ExecutionRepository(pool);
    const result = await repo.findByTenantId(TENANT_ID, { limit: 10 });
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(baseRow);
  });

  it("passes tenant_id as first parameter", async () => {
    const pool = makeMockPool([]);
    const repo = new ExecutionRepository(pool);
    await repo.findByTenantId(TENANT_ID, { limit: 10 });

    const mockQuery = pool.query as ReturnType<typeof vi.fn>;
    const callArgs = mockQuery.mock.calls[0] as [string, unknown[]];
    const params = callArgs[1];
    expect(params[0]).toBe(TENANT_ID);
  });

  it("includes status filter in query when provided", async () => {
    const pool = makeMockPool([]);
    const repo = new ExecutionRepository(pool);
    await repo.findByTenantId(TENANT_ID, {
      limit: 10,
      "filter[status][eq]": "running",
    });

    const mockQuery = pool.query as ReturnType<typeof vi.fn>;
    const callArgs = mockQuery.mock.calls[0] as [string, unknown[]];
    const sql = callArgs[0];
    const params = callArgs[1];
    expect(sql).toContain("status = $");
    expect(params).toContain("running");
  });

  it("includes type filter in query when provided", async () => {
    const pool = makeMockPool([]);
    const repo = new ExecutionRepository(pool);
    await repo.findByTenantId(TENANT_ID, {
      limit: 10,
      "filter[type][eq]": "connector-run",
    });

    const mockQuery = pool.query as ReturnType<typeof vi.fn>;
    const callArgs = mockQuery.mock.calls[0] as [string, unknown[]];
    const sql = callArgs[0];
    const params = callArgs[1];
    expect(sql).toContain("type = $");
    expect(params).toContain("connector-run");
  });

  it("performs cursor lookup then paginated query when cursor provided", async () => {
    const cursorRow = { started_at: new Date("2026-01-01T00:00:00Z") };
    const mockPool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [cursorRow] }) // cursor lookup
        .mockResolvedValueOnce({ rows: [baseRow] }),  // main query
    } as unknown as pg.Pool;

    const repo = new ExecutionRepository(mockPool);
    const result = await repo.findByTenantId(TENANT_ID, {
      limit: 10,
      cursor: EXEC_ID,
    });

    const mockQuery = mockPool.query as ReturnType<typeof vi.fn>;
    expect(mockQuery.mock.calls).toHaveLength(2);

    // First call is the cursor row lookup
    const cursorCallArgs = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(cursorCallArgs[0]).toContain("started_at");
    expect(cursorCallArgs[1]).toContain(EXEC_ID);

    // Second call includes keyset comparison
    const mainCallArgs = mockQuery.mock.calls[1] as [string, unknown[]];
    expect(mainCallArgs[0]).toContain("(started_at, id) <");

    expect(result).toHaveLength(1);
  });

  it("skips cursor condition when cursor row not found (no extra parameters)", async () => {
    const mockPool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })          // cursor not found
        .mockResolvedValueOnce({ rows: [baseRow] }),  // main query
    } as unknown as pg.Pool;

    const repo = new ExecutionRepository(mockPool);
    const result = await repo.findByTenantId(TENANT_ID, {
      limit: 10,
      cursor: "nonexistent-cursor",
    });

    const mockQuery = mockPool.query as ReturnType<typeof vi.fn>;
    const mainCallArgs = mockQuery.mock.calls[1] as [string, unknown[]];
    expect(mainCallArgs[0]).not.toContain("(started_at, id) <");
    expect(result).toHaveLength(1);
  });

  it("passes limit as the last query parameter", async () => {
    const pool = makeMockPool([]);
    const repo = new ExecutionRepository(pool);
    await repo.findByTenantId(TENANT_ID, { limit: 7 });

    const mockQuery = pool.query as ReturnType<typeof vi.fn>;
    const callArgs = mockQuery.mock.calls[0] as [string, unknown[]];
    const params = callArgs[1];
    // last parameter is the limit
    expect(params[params.length - 1]).toBe(7);
  });

  it("returns empty array when no executions found", async () => {
    const pool = makeMockPool([]);
    const repo = new ExecutionRepository(pool);
    const result = await repo.findByTenantId(TENANT_ID, { limit: 50 });
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// updateStatus — dynamic SET builder
// ---------------------------------------------------------------------------

describe("ExecutionRepository.updateStatus", () => {
  it("returns the updated row on success", async () => {
    const updated = { ...baseRow, status: "running" as const };
    const pool = makeMockPool([updated]);
    const repo = new ExecutionRepository(pool);
    const data: UpdateExecutionData = { status: "running" };

    const result = await repo.updateStatus(EXEC_ID, data);
    expect(result).toEqual(updated);
  });

  it("returns null when no row found for the given id", async () => {
    const pool = makeMockPool([]);
    const repo = new ExecutionRepository(pool);
    const data: UpdateExecutionData = { status: "running" };

    const result = await repo.updateStatus("nonexistent", data);
    expect(result).toBeNull();
  });

  it("builds SET with only status when no completion data", async () => {
    const pool = makeMockPool([baseRow]);
    const repo = new ExecutionRepository(pool);
    await repo.updateStatus(EXEC_ID, { status: "running" });

    const mockQuery = pool.query as ReturnType<typeof vi.fn>;
    const callArgs = mockQuery.mock.calls[0] as [string, unknown[]];
    const sql = callArgs[0];
    expect(sql).toContain("status = $1");
    // Should not set completion columns in the SET clause
    // (they appear in SELECT/RETURNING but not in SET)
    expect(sql).not.toContain("completed_at =");
    expect(sql).not.toContain("error_code =");
    // Only 2 params: status + id
    const params = callArgs[1];
    expect(params).toHaveLength(2);
    expect(params[0]).toBe("running");
    expect(params[1]).toBe(EXEC_ID);
  });

  it("builds SET with all completion fields when completion provided", async () => {
    const completedRow = {
      ...baseRow,
      status: "success" as const,
      completed_at: new Date("2026-01-01T01:00:00Z"),
      duration_ms: 1000,
      exit_code: 0,
    };
    const pool = makeMockPool([completedRow]);
    const repo = new ExecutionRepository(pool);

    const data: UpdateExecutionData = {
      status: "success",
      completion: {
        completed_at: new Date("2026-01-01T01:00:00Z"),
        duration_ms: 1000,
        exit_code: 0,
      },
    };
    await repo.updateStatus(EXEC_ID, data);

    const mockQuery = pool.query as ReturnType<typeof vi.fn>;
    const callArgs = mockQuery.mock.calls[0] as [string, unknown[]];
    const sql = callArgs[0];
    expect(sql).toContain("completed_at =");
    expect(sql).toContain("duration_ms =");
    expect(sql).toContain("exit_code =");
  });

  it("adds error_code to SET only when provided in completion", async () => {
    const pool = makeMockPool([{ ...baseRow, status: "error" as const }]);
    const repo = new ExecutionRepository(pool);

    const data: UpdateExecutionData = {
      status: "error",
      completion: {
        completed_at: new Date(),
        duration_ms: 500,
        exit_code: 1,
        error_code: "EXECUTION_TIMEOUT",
        error_message: "Timed out",
      },
    };
    await repo.updateStatus(EXEC_ID, data);

    const mockQuery = pool.query as ReturnType<typeof vi.fn>;
    const callArgs = mockQuery.mock.calls[0] as [string, unknown[]];
    const sql = callArgs[0];
    const params = callArgs[1];
    expect(sql).toContain("error_code =");
    expect(sql).toContain("error_message =");
    expect(params).toContain("EXECUTION_TIMEOUT");
    expect(params).toContain("Timed out");
  });

  it("adds memory_peak_mb to SET only when provided", async () => {
    const pool = makeMockPool([baseRow]);
    const repo = new ExecutionRepository(pool);

    const data: UpdateExecutionData = {
      status: "success",
      completion: {
        completed_at: new Date(),
        duration_ms: 500,
        exit_code: 0,
        memory_peak_mb: 64,
      },
    };
    await repo.updateStatus(EXEC_ID, data);

    const mockQuery = pool.query as ReturnType<typeof vi.fn>;
    const callArgs = mockQuery.mock.calls[0] as [string, unknown[]];
    const sql = callArgs[0];
    const params = callArgs[1];
    expect(sql).toContain("memory_peak_mb =");
    expect(params).toContain(64);
  });

  it("does not include memory_peak_mb in SET when absent", async () => {
    const pool = makeMockPool([baseRow]);
    const repo = new ExecutionRepository(pool);

    const data: UpdateExecutionData = {
      status: "success",
      completion: { completed_at: new Date(), duration_ms: 500, exit_code: 0 },
    };
    await repo.updateStatus(EXEC_ID, data);

    const mockQuery = pool.query as ReturnType<typeof vi.fn>;
    const callArgs = mockQuery.mock.calls[0] as [string, unknown[]];
    const sql = callArgs[0];
    expect(sql).not.toContain("memory_peak_mb =");
  });

  it("passes execution id as last parameter in WHERE clause", async () => {
    const pool = makeMockPool([baseRow]);
    const repo = new ExecutionRepository(pool);
    await repo.updateStatus(EXEC_ID, { status: "running" });

    const mockQuery = pool.query as ReturnType<typeof vi.fn>;
    const callArgs = mockQuery.mock.calls[0] as [string, unknown[]];
    const params = callArgs[1];
    expect(params[params.length - 1]).toBe(EXEC_ID);
  });
});

// ---------------------------------------------------------------------------
// findByPluginId
// ---------------------------------------------------------------------------

describe("ExecutionRepository.findByPluginId", () => {
  it("returns in-flight executions for a plugin", async () => {
    const inflightRow = { ...baseRow, plugin_id: PLUGIN_ID };
    const pool = makeMockPool([inflightRow]);
    const repo = new ExecutionRepository(pool);
    const result = await repo.findByPluginId(PLUGIN_ID);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(inflightRow);
  });

  it("returns empty array when no in-flight executions found", async () => {
    const pool = makeMockPool([]);
    const repo = new ExecutionRepository(pool);
    const result = await repo.findByPluginId("plugin-no-inflight");
    expect(result).toEqual([]);
  });

  it("queries with IN ('pending', 'running') filter", async () => {
    const pool = makeMockPool([]);
    const repo = new ExecutionRepository(pool);
    await repo.findByPluginId(PLUGIN_ID);

    const mockQuery = pool.query as ReturnType<typeof vi.fn>;
    const callArgs = mockQuery.mock.calls[0] as [string, unknown[]];
    const sql = callArgs[0];
    expect(sql).toContain("'pending'");
    expect(sql).toContain("'running'");
    expect(sql).toContain("plugin_id = $1");
  });
});

// ---------------------------------------------------------------------------
// countInflightByPluginId
// ---------------------------------------------------------------------------

describe("ExecutionRepository.countInflightByPluginId", () => {
  it("returns the count of in-flight executions", async () => {
    const mockPool = {
      query: vi.fn().mockResolvedValue({ rows: [{ count: "3" }] }),
    } as unknown as pg.Pool;
    const repo = new ExecutionRepository(mockPool);
    const count = await repo.countInflightByPluginId(PLUGIN_ID);
    expect(count).toBe(3);
  });

  it("returns 0 when no rows returned (no in-flight executions)", async () => {
    const mockPool = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    } as unknown as pg.Pool;
    const repo = new ExecutionRepository(mockPool);
    const count = await repo.countInflightByPluginId(PLUGIN_ID);
    expect(count).toBe(0);
  });

  it("returns 0 for count '0' string from pg driver", async () => {
    const mockPool = {
      query: vi.fn().mockResolvedValue({ rows: [{ count: "0" }] }),
    } as unknown as pg.Pool;
    const repo = new ExecutionRepository(mockPool);
    const count = await repo.countInflightByPluginId(PLUGIN_ID);
    expect(count).toBe(0);
  });

  it("queries with plugin_id parameter and status IN filter", async () => {
    const mockPool = {
      query: vi.fn().mockResolvedValue({ rows: [{ count: "0" }] }),
    } as unknown as pg.Pool;
    const repo = new ExecutionRepository(mockPool);
    await repo.countInflightByPluginId(PLUGIN_ID);

    const mockQuery = mockPool.query as ReturnType<typeof vi.fn>;
    const callArgs = mockQuery.mock.calls[0] as [string, unknown[]];
    const sql = callArgs[0];
    const params = callArgs[1];
    expect(sql).toContain("count(*)");
    expect(sql).toContain("plugin_id = $1");
    expect(params[0]).toBe(PLUGIN_ID);
  });
});

// ---------------------------------------------------------------------------
// ensurePartition — date format validation + DDL safety
// ---------------------------------------------------------------------------

describe("ExecutionRepository.ensurePartition", () => {
  it("executes two CREATE TABLE IF NOT EXISTS DDL statements for valid dates", async () => {
    const mockPool = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    } as unknown as pg.Pool;
    const repo = new ExecutionRepository(mockPool);
    await repo.ensurePartition("2026-09-01", "2026-10-01");

    const mockQuery = mockPool.query as ReturnType<typeof vi.fn>;
    expect(mockQuery.mock.calls).toHaveLength(2);
    const sql1 = (mockQuery.mock.calls[0] as [string])[0];
    const sql2 = (mockQuery.mock.calls[1] as [string])[0];
    expect(sql1).toContain("executions_2026_09");
    expect(sql2).toContain("execution_logs_2026_09");
  });

  it("derives correct suffix from monthStart (replaces hyphen with underscore)", async () => {
    const mockPool = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    } as unknown as pg.Pool;
    const repo = new ExecutionRepository(mockPool);
    await repo.ensurePartition("2026-12-01", "2027-01-01");

    const mockQuery = mockPool.query as ReturnType<typeof vi.fn>;
    const sql1 = (mockQuery.mock.calls[0] as [string])[0];
    expect(sql1).toContain("executions_2026_12");
  });

  it("throws for invalid monthStart format", async () => {
    const pool = makeMockPool([]);
    const repo = new ExecutionRepository(pool);
    await expect(repo.ensurePartition("2026/09/01", "2026/10/01")).rejects.toThrow(
      "invalid date format",
    );
  });

  it("throws for monthEnd with wrong format", async () => {
    const pool = makeMockPool([]);
    const repo = new ExecutionRepository(pool);
    await expect(repo.ensurePartition("2026-09-01", "October 2026")).rejects.toThrow(
      "invalid date format",
    );
  });

  it("throws for monthStart with letters", async () => {
    const pool = makeMockPool([]);
    const repo = new ExecutionRepository(pool);
    await expect(repo.ensurePartition("2026-0x-01", "2026-09-01")).rejects.toThrow(
      "invalid date format",
    );
  });

  it("throws for empty monthStart", async () => {
    const pool = makeMockPool([]);
    const repo = new ExecutionRepository(pool);
    await expect(repo.ensurePartition("", "2026-10-01")).rejects.toThrow(
      "invalid date format",
    );
  });

  it("DDL includes FOR VALUES FROM / TO with supplied dates", async () => {
    const mockPool = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    } as unknown as pg.Pool;
    const repo = new ExecutionRepository(mockPool);
    await repo.ensurePartition("2026-06-01", "2026-07-01");

    const mockQuery = mockPool.query as ReturnType<typeof vi.fn>;
    const sql1 = (mockQuery.mock.calls[0] as [string])[0];
    expect(sql1).toContain("'2026-06-01'");
    expect(sql1).toContain("'2026-07-01'");
  });
});
