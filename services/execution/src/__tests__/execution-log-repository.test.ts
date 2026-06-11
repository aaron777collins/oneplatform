// Unit tests for repositories/execution-log-repository.ts
//
// Tests: append (single), appendBatch (multi), findByExecutionId (with/without
// afterLineNumber), findSince (SSE resume), countByExecutionId.

import { describe, it, expect, vi } from "vitest";
import type pg from "pg";
import { ExecutionLogRepository } from "../repositories/execution-log-repository.js";
import type { ExecutionLogRow, CreateExecutionLogData } from "../repositories/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const EXEC_ID = "550e8400-e29b-41d4-a716-446655440001";

const baseLogRow: ExecutionLogRow = {
  id: 1,
  execution_id: EXEC_ID,
  execution_date: new Date("2026-01-01T00:00:00Z"),
  timestamp: new Date("2026-01-01T00:00:01Z"),
  level: "info",
  message: "Hello from sandbox",
  line_number: 1,
  stream: "stdout",
  metadata: null,
};

function makeLogData(overrides: Partial<CreateExecutionLogData> = {}): CreateExecutionLogData {
  return {
    execution_id: EXEC_ID,
    execution_date: new Date("2026-01-01T00:00:00Z"),
    level: "info",
    message: "log line",
    line_number: 1,
    stream: "stdout",
    ...overrides,
  };
}

function makeMockPool(rows: ExecutionLogRow[] = []): pg.Pool {
  return {
    query: vi.fn().mockResolvedValue({ rows }),
  } as unknown as pg.Pool;
}

// ---------------------------------------------------------------------------
// append (single)
// ---------------------------------------------------------------------------

describe("ExecutionLogRepository.append", () => {
  it("returns the inserted log row on success", async () => {
    const pool = makeMockPool([baseLogRow]);
    const repo = new ExecutionLogRepository(pool);
    const result = await repo.append(makeLogData());
    expect(result).toEqual(baseLogRow);
  });

  it("passes all required fields as positional parameters", async () => {
    const pool = makeMockPool([baseLogRow]);
    const repo = new ExecutionLogRepository(pool);
    const data = makeLogData({ level: "warn", message: "warning msg", stream: "stderr" });
    await repo.append(data);

    const mockQuery = pool.query as ReturnType<typeof vi.fn>;
    const callArgs = mockQuery.mock.calls[0] as [string, unknown[]];
    const params = callArgs[1];
    expect(params[0]).toBe(EXEC_ID);
    expect(params[2]).toBe("warn");
    expect(params[3]).toBe("warning msg");
    expect(params[5]).toBe("stderr");
  });

  it("serialises metadata as JSON string when provided", async () => {
    const pool = makeMockPool([{ ...baseLogRow, metadata: { requestId: "r-1" } }]);
    const repo = new ExecutionLogRepository(pool);
    const data = makeLogData({ metadata: { requestId: "r-1" } });
    await repo.append(data);

    const mockQuery = pool.query as ReturnType<typeof vi.fn>;
    const callArgs = mockQuery.mock.calls[0] as [string, unknown[]];
    const params = callArgs[1];
    // params[6] is metadata — should be JSON string
    expect(params[6]).toBe(JSON.stringify({ requestId: "r-1" }));
  });

  it("sends null for metadata when not provided", async () => {
    const pool = makeMockPool([baseLogRow]);
    const repo = new ExecutionLogRepository(pool);
    await repo.append(makeLogData()); // no metadata

    const mockQuery = pool.query as ReturnType<typeof vi.fn>;
    const callArgs = mockQuery.mock.calls[0] as [string, unknown[]];
    const params = callArgs[1];
    expect(params[6]).toBeNull();
  });

  it("throws when INSERT returns no rows", async () => {
    const pool = makeMockPool([]);
    const repo = new ExecutionLogRepository(pool);
    await expect(repo.append(makeLogData())).rejects.toThrow(
      `INSERT INTO execution.execution_logs returned no rows for execution ${EXEC_ID}`,
    );
  });
});

// ---------------------------------------------------------------------------
// appendBatch
// ---------------------------------------------------------------------------

describe("ExecutionLogRepository.appendBatch", () => {
  it("returns without querying when lines array is empty", async () => {
    const pool = makeMockPool([]);
    const repo = new ExecutionLogRepository(pool);
    await repo.appendBatch([]);

    const mockQuery = pool.query as ReturnType<typeof vi.fn>;
    expect(mockQuery.mock.calls).toHaveLength(0);
  });

  it("inserts a single batch in one query for multiple lines", async () => {
    const pool = makeMockPool([]);
    const repo = new ExecutionLogRepository(pool);
    const lines = [
      makeLogData({ line_number: 1, message: "line 1" }),
      makeLogData({ line_number: 2, message: "line 2" }),
      makeLogData({ line_number: 3, message: "line 3" }),
    ];
    await repo.appendBatch(lines);

    const mockQuery = pool.query as ReturnType<typeof vi.fn>;
    expect(mockQuery.mock.calls).toHaveLength(1);
  });

  it("generates correct number of value clauses (one per line)", async () => {
    const pool = makeMockPool([]);
    const repo = new ExecutionLogRepository(pool);
    const lines = [
      makeLogData({ line_number: 1 }),
      makeLogData({ line_number: 2 }),
    ];
    await repo.appendBatch(lines);

    const mockQuery = pool.query as ReturnType<typeof vi.fn>;
    const callArgs = mockQuery.mock.calls[0] as [string, unknown[]];
    const sql = callArgs[0];
    // Count value tuple placeholders: ($1, $2, ...) patterns after VALUES
    // The INSERT column list also uses parens so we look for "$N" pairs
    const valuesTuples = sql.split("VALUES")[1] ?? "";
    const clauseCount = (valuesTuples.match(/\(/g) ?? []).length;
    expect(clauseCount).toBe(2);
  });

  it("generates 7 parameters per line (no overlap between lines)", async () => {
    const pool = makeMockPool([]);
    const repo = new ExecutionLogRepository(pool);
    const lines = [
      makeLogData({ line_number: 1, message: "a" }),
      makeLogData({ line_number: 2, message: "b" }),
      makeLogData({ line_number: 3, message: "c" }),
    ];
    await repo.appendBatch(lines);

    const mockQuery = pool.query as ReturnType<typeof vi.fn>;
    const callArgs = mockQuery.mock.calls[0] as [string, unknown[]];
    const params = callArgs[1];
    expect(params).toHaveLength(3 * 7); // 3 lines × 7 params each
  });

  it("serialises metadata as JSON for lines with metadata", async () => {
    const pool = makeMockPool([]);
    const repo = new ExecutionLogRepository(pool);
    const lines = [
      makeLogData({ line_number: 1, metadata: { key: "value" } }),
    ];
    await repo.appendBatch(lines);

    const mockQuery = pool.query as ReturnType<typeof vi.fn>;
    const callArgs = mockQuery.mock.calls[0] as [string, unknown[]];
    const params = callArgs[1];
    // 7th param (index 6) is metadata for first line
    expect(params[6]).toBe(JSON.stringify({ key: "value" }));
  });

  it("sends null for metadata when absent in a line", async () => {
    const pool = makeMockPool([]);
    const repo = new ExecutionLogRepository(pool);
    const lines = [makeLogData({ line_number: 1 })]; // no metadata
    await repo.appendBatch(lines);

    const mockQuery = pool.query as ReturnType<typeof vi.fn>;
    const callArgs = mockQuery.mock.calls[0] as [string, unknown[]];
    const params = callArgs[1];
    expect(params[6]).toBeNull();
  });

  it("handles single-line batch without error", async () => {
    const pool = makeMockPool([]);
    const repo = new ExecutionLogRepository(pool);
    await repo.appendBatch([makeLogData({ line_number: 1 })]);

    const mockQuery = pool.query as ReturnType<typeof vi.fn>;
    expect(mockQuery.mock.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// findByExecutionId
// ---------------------------------------------------------------------------

describe("ExecutionLogRepository.findByExecutionId", () => {
  it("returns all log rows for an execution with default limit", async () => {
    const pool = makeMockPool([baseLogRow]);
    const repo = new ExecutionLogRepository(pool);
    const result = await repo.findByExecutionId(EXEC_ID);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(baseLogRow);
  });

  it("uses default limit of 500 when no query provided", async () => {
    const pool = makeMockPool([]);
    const repo = new ExecutionLogRepository(pool);
    await repo.findByExecutionId(EXEC_ID);

    const mockQuery = pool.query as ReturnType<typeof vi.fn>;
    const callArgs = mockQuery.mock.calls[0] as [string, unknown[]];
    const params = callArgs[1];
    expect(params).toContain(500);
  });

  it("uses provided limit", async () => {
    const pool = makeMockPool([]);
    const repo = new ExecutionLogRepository(pool);
    await repo.findByExecutionId(EXEC_ID, { limit: 100 });

    const mockQuery = pool.query as ReturnType<typeof vi.fn>;
    const callArgs = mockQuery.mock.calls[0] as [string, unknown[]];
    const params = callArgs[1];
    expect(params).toContain(100);
  });

  it("adds afterLineNumber filter when provided", async () => {
    const pool = makeMockPool([]);
    const repo = new ExecutionLogRepository(pool);
    await repo.findByExecutionId(EXEC_ID, { afterLineNumber: 42 });

    const mockQuery = pool.query as ReturnType<typeof vi.fn>;
    const callArgs = mockQuery.mock.calls[0] as [string, unknown[]];
    const sql = callArgs[0];
    const params = callArgs[1];
    expect(sql).toContain("line_number > $2");
    expect(params).toContain(42);
  });

  it("does not add afterLineNumber filter when not provided", async () => {
    const pool = makeMockPool([]);
    const repo = new ExecutionLogRepository(pool);
    await repo.findByExecutionId(EXEC_ID);

    const mockQuery = pool.query as ReturnType<typeof vi.fn>;
    const callArgs = mockQuery.mock.calls[0] as [string, unknown[]];
    const sql = callArgs[0];
    expect(sql).not.toContain("line_number >");
  });

  it("returns empty array when no logs found", async () => {
    const pool = makeMockPool([]);
    const repo = new ExecutionLogRepository(pool);
    const result = await repo.findByExecutionId("nonexistent");
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// findSince — SSE resume path
// ---------------------------------------------------------------------------

describe("ExecutionLogRepository.findSince", () => {
  it("returns log rows after the specified line number", async () => {
    const row2 = { ...baseLogRow, id: 2, line_number: 2, message: "line 2" };
    const pool = makeMockPool([row2]);
    const repo = new ExecutionLogRepository(pool);
    const result = await repo.findSince(EXEC_ID, 1);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(row2);
  });

  it("returns empty array when no new lines exist (never null)", async () => {
    const pool = makeMockPool([]);
    const repo = new ExecutionLogRepository(pool);
    const result = await repo.findSince(EXEC_ID, 999);
    expect(result).toEqual([]);
  });

  it("passes afterLineNumber as $2 parameter", async () => {
    const pool = makeMockPool([]);
    const repo = new ExecutionLogRepository(pool);
    await repo.findSince(EXEC_ID, 25);

    const mockQuery = pool.query as ReturnType<typeof vi.fn>;
    const callArgs = mockQuery.mock.calls[0] as [string, unknown[]];
    const params = callArgs[1];
    expect(params[1]).toBe(25);
  });

  it("uses default limit of 500 when not provided", async () => {
    const pool = makeMockPool([]);
    const repo = new ExecutionLogRepository(pool);
    await repo.findSince(EXEC_ID, 0);

    const mockQuery = pool.query as ReturnType<typeof vi.fn>;
    const callArgs = mockQuery.mock.calls[0] as [string, unknown[]];
    const params = callArgs[1];
    expect(params[2]).toBe(500);
  });

  it("uses provided limit", async () => {
    const pool = makeMockPool([]);
    const repo = new ExecutionLogRepository(pool);
    await repo.findSince(EXEC_ID, 0, 50);

    const mockQuery = pool.query as ReturnType<typeof vi.fn>;
    const callArgs = mockQuery.mock.calls[0] as [string, unknown[]];
    const params = callArgs[1];
    expect(params[2]).toBe(50);
  });

  it("queries with line_number > filter and ORDER BY line_number ASC", async () => {
    const pool = makeMockPool([]);
    const repo = new ExecutionLogRepository(pool);
    await repo.findSince(EXEC_ID, 10);

    const mockQuery = pool.query as ReturnType<typeof vi.fn>;
    const callArgs = mockQuery.mock.calls[0] as [string, unknown[]];
    const sql = callArgs[0];
    expect(sql).toContain("line_number > $2");
    expect(sql).toContain("ORDER BY line_number ASC");
  });
});

// ---------------------------------------------------------------------------
// countByExecutionId
// ---------------------------------------------------------------------------

describe("ExecutionLogRepository.countByExecutionId", () => {
  it("returns the count as a number", async () => {
    const mockPool = {
      query: vi.fn().mockResolvedValue({ rows: [{ count: "42" }] }),
    } as unknown as pg.Pool;
    const repo = new ExecutionLogRepository(mockPool);
    const count = await repo.countByExecutionId(EXEC_ID);
    expect(count).toBe(42);
  });

  it("returns 0 when no rows returned", async () => {
    const mockPool = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    } as unknown as pg.Pool;
    const repo = new ExecutionLogRepository(mockPool);
    const count = await repo.countByExecutionId(EXEC_ID);
    expect(count).toBe(0);
  });

  it("returns 0 for count string '0'", async () => {
    const mockPool = {
      query: vi.fn().mockResolvedValue({ rows: [{ count: "0" }] }),
    } as unknown as pg.Pool;
    const repo = new ExecutionLogRepository(mockPool);
    const count = await repo.countByExecutionId(EXEC_ID);
    expect(count).toBe(0);
  });

  it("parses large count values (e.g., 10000)", async () => {
    const mockPool = {
      query: vi.fn().mockResolvedValue({ rows: [{ count: "10000" }] }),
    } as unknown as pg.Pool;
    const repo = new ExecutionLogRepository(mockPool);
    const count = await repo.countByExecutionId(EXEC_ID);
    expect(count).toBe(10000);
  });

  it("queries with execution_id parameter", async () => {
    const mockPool = {
      query: vi.fn().mockResolvedValue({ rows: [{ count: "0" }] }),
    } as unknown as pg.Pool;
    const repo = new ExecutionLogRepository(mockPool);
    await repo.countByExecutionId(EXEC_ID);

    const mockQuery = mockPool.query as ReturnType<typeof vi.fn>;
    const callArgs = mockQuery.mock.calls[0] as [string, unknown[]];
    const params = callArgs[1];
    expect(params[0]).toBe(EXEC_ID);
  });
});
