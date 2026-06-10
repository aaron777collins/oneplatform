// Unit tests for the pure helper functions inside services/retention-service.ts
//
// The three helpers — startOfMonth, addMonths, formatPartitionName — are
// not exported, so they are exercised indirectly via the exported
// RetentionService class.  We test the observable effects:
//   - ensurePartitions() calls db.query with the correct partition name strings
//   - runRetention() toggles retentionRunning and prevents concurrent execution
//
// All database interaction is replaced with lightweight fakes so no real
// Postgres connection is needed.

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { RetentionService } from "../services/retention-service.js";

// ---------------------------------------------------------------------------
// Fake db.Pool — records every call to query() for inspection
// ---------------------------------------------------------------------------

interface QueryCall {
  text: string;
  values?: unknown[];
}

function makeDb(overrides: { query?: (text: string, values?: unknown[]) => Promise<unknown> } = {}) {
  const calls: QueryCall[] = [];

  const query = overrides.query ?? (async (text: string, values?: unknown[]) => {
    calls.push({ text, values });
    // Return empty result for partition queries; simulate no partitions to drop
    return { rows: [] };
  });

  return {
    query: vi.fn(query),
    _calls: calls,
  } as unknown as import("pg").Pool & { _calls: QueryCall[] };
}

// ---------------------------------------------------------------------------
// formatPartitionName (tested indirectly via ensurePartitions)
// ---------------------------------------------------------------------------

describe("formatPartitionName — tested via ensurePartitions()", () => {
  it("names the partition events_YYYY_MM for the current month", async () => {
    const db = makeDb();
    const service = new RetentionService(db as unknown as import("pg").Pool);

    // Freeze Date so the test is deterministic
    const frozen = new Date("2026-06-10T08:00:00Z");
    vi.setSystemTime(frozen);

    await service.ensurePartitions();

    // The first CREATE TABLE IF NOT EXISTS call should contain events_2026_06
    const createCalls = db.query.mock.calls.filter(
      (args: unknown[]) =>
        typeof args[0] === "string" && (args[0] as string).includes("CREATE TABLE IF NOT EXISTS")
    );
    expect(createCalls.length).toBe(2);
    const sql0 = createCalls[0]?.[0] as string;
    expect(sql0).toContain("events_2026_06");

    vi.useRealTimers();
  });

  it("names the next partition correctly when rolling into the next month", async () => {
    const db = makeDb();
    const service = new RetentionService(db as unknown as import("pg").Pool);

    // 2026-06-10 → current month is June (06), next is July (07)
    vi.setSystemTime(new Date("2026-06-10T00:00:00Z"));

    await service.ensurePartitions();

    const createCalls = db.query.mock.calls.filter(
      (args: unknown[]) =>
        typeof args[0] === "string" && (args[0] as string).includes("CREATE TABLE IF NOT EXISTS")
    );
    const sql1 = createCalls[1]?.[0] as string;
    expect(sql1).toContain("events_2026_07");

    vi.useRealTimers();
  });

  it("produces two-digit month with leading zero for single-digit months", async () => {
    const db = makeDb();
    const service = new RetentionService(db as unknown as import("pg").Pool);

    // March → month 03 and April → month 04
    vi.setSystemTime(new Date("2026-03-15T00:00:00Z"));

    await service.ensurePartitions();

    const createCalls = db.query.mock.calls.filter(
      (args: unknown[]) =>
        typeof args[0] === "string" && (args[0] as string).includes("CREATE TABLE IF NOT EXISTS")
    );
    expect(createCalls[0]?.[0]).toContain("events_2026_03");
    expect(createCalls[1]?.[0]).toContain("events_2026_04");

    vi.useRealTimers();
  });

  it("wraps year correctly when current month is December", async () => {
    const db = makeDb();
    const service = new RetentionService(db as unknown as import("pg").Pool);

    vi.setSystemTime(new Date("2026-12-05T00:00:00Z"));

    await service.ensurePartitions();

    const createCalls = db.query.mock.calls.filter(
      (args: unknown[]) =>
        typeof args[0] === "string" && (args[0] as string).includes("CREATE TABLE IF NOT EXISTS")
    );
    // December 2026 → current
    expect(createCalls[0]?.[0]).toContain("events_2026_12");
    // January 2027 → next
    expect(createCalls[1]?.[0]).toContain("events_2027_01");

    vi.useRealTimers();
  });

  it("emits partition boundary values as ISO-8601 strings in the correct order", async () => {
    const db = makeDb();
    const service = new RetentionService(db as unknown as import("pg").Pool);

    vi.setSystemTime(new Date("2026-06-10T00:00:00Z"));

    await service.ensurePartitions();

    // First partition: June 2026 [2026-06-01T00:00:00.000Z, 2026-07-01T00:00:00.000Z)
    const createCalls = db.query.mock.calls.filter(
      (args: unknown[]) =>
        typeof args[0] === "string" && (args[0] as string).includes("CREATE TABLE IF NOT EXISTS")
    );

    const values0 = createCalls[0]?.[1] as string[];
    expect(values0[0]).toBe("2026-06-01T00:00:00.000Z"); // from
    expect(values0[1]).toBe("2026-07-01T00:00:00.000Z"); // to (exclusive)

    const values1 = createCalls[1]?.[1] as string[];
    expect(values1[0]).toBe("2026-07-01T00:00:00.000Z"); // from
    expect(values1[1]).toBe("2026-08-01T00:00:00.000Z"); // to (exclusive)

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// ensurePartitions — DB interaction contract
// ---------------------------------------------------------------------------

describe("ensurePartitions()", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("issues exactly 4 queries per call (2 CREATE + 2 INSERT into registry)", async () => {
    const db = makeDb();
    const service = new RetentionService(db as unknown as import("pg").Pool);

    vi.setSystemTime(new Date("2026-06-10T00:00:00Z"));

    await service.ensurePartitions();

    // 2 CREATE TABLE IF NOT EXISTS + 2 INSERT INTO partition_registry
    expect(db.query).toHaveBeenCalledTimes(4);
  });

  it("inserts the correct partition_name into partition_registry", async () => {
    const db = makeDb();
    const service = new RetentionService(db as unknown as import("pg").Pool);

    vi.setSystemTime(new Date("2026-06-10T00:00:00Z"));

    await service.ensurePartitions();

    const registryCalls = db.query.mock.calls.filter(
      (args: unknown[]) =>
        typeof args[0] === "string" &&
        (args[0] as string).includes("INSERT INTO logging.partition_registry")
    );
    expect(registryCalls).toHaveLength(2);

    const values0 = registryCalls[0]?.[1] as string[];
    expect(values0[0]).toBe("events_2026_06");

    const values1 = registryCalls[1]?.[1] as string[];
    expect(values1[0]).toBe("events_2026_07");
  });

  it("uses ON CONFLICT (partition_name) DO NOTHING for idempotent inserts", async () => {
    const db = makeDb();
    const service = new RetentionService(db as unknown as import("pg").Pool);

    vi.setSystemTime(new Date("2026-06-10T00:00:00Z"));

    await service.ensurePartitions();

    const registryCalls = db.query.mock.calls.filter(
      (args: unknown[]) =>
        typeof args[0] === "string" &&
        (args[0] as string).includes("ON CONFLICT")
    );
    expect(registryCalls.length).toBeGreaterThanOrEqual(2);
    const sql = registryCalls[0]?.[0] as string;
    expect(sql).toContain("DO NOTHING");
  });
});

// ---------------------------------------------------------------------------
// runRetention() — concurrency guard
// ---------------------------------------------------------------------------

describe("runRetention() — concurrency guard", () => {
  it("throws if called while already running", async () => {
    // Make the first query hang indefinitely so retentionRunning stays true
    let resolveFirst!: () => void;
    const firstQueryPromise = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });

    const db = {
      query: vi.fn(async () => {
        await firstQueryPromise;
        return { rows: [] };
      }),
    } as unknown as import("pg").Pool;

    const service = new RetentionService(db);

    // Start first run — don't await it; it's blocked on firstQueryPromise
    const firstRun = service.runRetention();

    // Attempt second run while first is in-flight
    await expect(service.runRetention()).rejects.toThrow(
      "Retention job is already running"
    );

    // Unblock first run
    resolveFirst();
    await firstRun.catch(() => {
      // first run may succeed or fail depending on query mock; ignore
    });
  });

  it("clears retentionRunning flag even when the job throws", async () => {
    const db = {
      query: vi.fn(async () => {
        throw new Error("DB failure during retention");
      }),
    } as unknown as import("pg").Pool;

    const service = new RetentionService(db);

    // First run should throw
    await expect(service.runRetention()).rejects.toThrow("DB failure");

    // Second run must not throw 'already running' — flag must be cleared
    await expect(service.runRetention()).rejects.toThrow("DB failure");
  });

  it("allows a second run after the first completes successfully", async () => {
    const db = makeDb();
    const service = new RetentionService(db as unknown as import("pg").Pool);

    await service.runRetention();
    // Should not throw 'already running'
    await expect(service.runRetention()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// runRetention() — SQL shape
// ---------------------------------------------------------------------------

describe("runRetention() — SQL shape", () => {
  it("deletes debug rows using the OP_RETENTION_DEBUG_DAYS env var", async () => {
    process.env["OP_RETENTION_DEBUG_DAYS"] = "3";
    const db = makeDb();
    const service = new RetentionService(db as unknown as import("pg").Pool);

    await service.runRetention();

    const debugDeleteCall = db.query.mock.calls.find(
      (args: unknown[]) =>
        typeof args[0] === "string" &&
        (args[0] as string).includes("level = 'debug'")
    );
    expect(debugDeleteCall).toBeDefined();
    const values = debugDeleteCall?.[1] as string[];
    expect(values[0]).toBe("3");

    delete process.env["OP_RETENTION_DEBUG_DAYS"];
  });

  it("deletes info rows using the OP_RETENTION_INFO_DAYS env var", async () => {
    process.env["OP_RETENTION_INFO_DAYS"] = "14";
    const db = makeDb();
    const service = new RetentionService(db as unknown as import("pg").Pool);

    await service.runRetention();

    const infoDeleteCall = db.query.mock.calls.find(
      (args: unknown[]) =>
        typeof args[0] === "string" &&
        (args[0] as string).includes("level = 'info'")
    );
    expect(infoDeleteCall).toBeDefined();
    const values = infoDeleteCall?.[1] as string[];
    expect(values[0]).toBe("14");

    delete process.env["OP_RETENTION_INFO_DAYS"];
  });

  it("uses default retention days when env vars are absent", async () => {
    delete process.env["OP_RETENTION_DEBUG_DAYS"];
    delete process.env["OP_RETENTION_INFO_DAYS"];
    delete process.env["OP_RETENTION_ERROR_DAYS"];
    delete process.env["OP_RETENTION_AUDIT_DAYS"];

    const db = makeDb();
    const service = new RetentionService(db as unknown as import("pg").Pool);

    await service.runRetention();

    const debugCall = db.query.mock.calls.find(
      (args: unknown[]) =>
        typeof args[0] === "string" &&
        (args[0] as string).includes("level = 'debug'")
    );
    // Default is 7 days
    expect((debugCall?.[1] as string[])[0]).toBe("7");

    const infoCall = db.query.mock.calls.find(
      (args: unknown[]) =>
        typeof args[0] === "string" &&
        (args[0] as string).includes("level = 'info'")
    );
    // Default is 30 days
    expect((infoCall?.[1] as string[])[0]).toBe("30");
  });

  it("queries partition_registry to find expired partitions to drop", async () => {
    const db = makeDb();
    const service = new RetentionService(db as unknown as import("pg").Pool);

    await service.runRetention();

    const registryQuery = db.query.mock.calls.find(
      (args: unknown[]) =>
        typeof args[0] === "string" &&
        (args[0] as string).includes("partition_registry") &&
        (args[0] as string).includes("period_end")
    );
    expect(registryQuery).toBeDefined();
  });

  it("drops expired partitions found in registry", async () => {
    // Simulate the registry returning one partition to drop
    const db = {
      query: vi.fn(async (sql: string) => {
        if (
          typeof sql === "string" &&
          sql.includes("partition_registry") &&
          sql.includes("period_end")
        ) {
          return { rows: [{ partition_name: "events_2025_01" }] };
        }
        return { rows: [] };
      }),
    } as unknown as import("pg").Pool;

    const service = new RetentionService(db);
    await service.runRetention();

    const dropCall = (db as unknown as { query: ReturnType<typeof vi.fn> }).query.mock.calls.find(
      (args: unknown[]) =>
        typeof args[0] === "string" &&
        (args[0] as string).includes("DROP TABLE") &&
        (args[0] as string).includes("events_2025_01")
    );
    expect(dropCall).toBeDefined();
  });

  it("deletes audit events using the OP_RETENTION_AUDIT_DAYS env var", async () => {
    process.env["OP_RETENTION_AUDIT_DAYS"] = "180";
    const db = makeDb();
    const service = new RetentionService(db as unknown as import("pg").Pool);

    await service.runRetention();

    const auditDeleteCall = db.query.mock.calls.find(
      (args: unknown[]) =>
        typeof args[0] === "string" &&
        (args[0] as string).includes("audit_events")
    );
    expect(auditDeleteCall).toBeDefined();
    const values = auditDeleteCall?.[1] as string[];
    expect(values[0]).toBe("180");

    delete process.env["OP_RETENTION_AUDIT_DAYS"];
  });
});

// ---------------------------------------------------------------------------
// stop() — cancels all timers
// ---------------------------------------------------------------------------

describe("stop()", () => {
  it("cancels timers without throwing even when no schedulers were started", () => {
    const db = makeDb();
    const service = new RetentionService(db as unknown as import("pg").Pool);
    expect(() => service.stop()).not.toThrow();
  });

  it("cancels retention timer so it does not fire after stop()", () => {
    vi.useFakeTimers();
    const runRetention = vi.fn(async () => {});

    const db = makeDb();
    const service = new RetentionService(db as unknown as import("pg").Pool);

    vi.spyOn(service, "runRetention").mockImplementation(runRetention);

    service.startRetentionScheduler();
    service.stop();

    // Advance time far past 2:00 AM UTC — the timer was cancelled so runRetention
    // must not be called
    vi.advanceTimersByTime(30 * 60 * 60 * 1000); // 30 hours

    expect(runRetention).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// getRetentionDays — env var parsing edge cases
// ---------------------------------------------------------------------------

describe("getRetentionDays — env var parsing (tested via runRetention)", () => {
  afterEach(() => {
    delete process.env["OP_RETENTION_DEBUG_DAYS"];
  });

  it("parses a string integer env var to a number", async () => {
    process.env["OP_RETENTION_DEBUG_DAYS"] = "42";
    const db = makeDb();
    const service = new RetentionService(db as unknown as import("pg").Pool);
    await service.runRetention();

    const debugCall = db.query.mock.calls.find(
      (args: unknown[]) =>
        typeof args[0] === "string" &&
        (args[0] as string).includes("level = 'debug'")
    );
    expect((debugCall?.[1] as string[])[0]).toBe("42");
  });

  it("uses default when env var is not set", async () => {
    delete process.env["OP_RETENTION_DEBUG_DAYS"];
    const db = makeDb();
    const service = new RetentionService(db as unknown as import("pg").Pool);
    await service.runRetention();

    const debugCall = db.query.mock.calls.find(
      (args: unknown[]) =>
        typeof args[0] === "string" &&
        (args[0] as string).includes("level = 'debug'")
    );
    // Default is 7
    expect((debugCall?.[1] as string[])[0]).toBe("7");
  });
});
