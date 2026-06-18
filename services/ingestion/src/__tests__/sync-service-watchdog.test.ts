// Unit tests for the executeWatchdog function in sync-service.ts
//
// The watchdog is responsible for finding sync_state rows stuck in 'running'
// beyond the stale threshold and resetting them to 'failed'. These tests verify
// the two-phase logic (find-then-reset), per-connector logging, correct count
// return, and that the watchdog never throws (crash-safety for the scheduler).
//
// Tests import executeWatchdog directly — a standalone export that takes only
// syncStateRepo and logger — so no BullMQ queue construction is required.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Logger } from "@oneplatform/core";
import {
  executeWatchdog,
} from "../services/sync-service.js";
import type {
  SyncStateRepository,
  SyncStateRow,
} from "../services/connector-service.js";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const CONNECTOR_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CONNECTOR_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const JOB_ID_A = "job-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const JOB_ID_B = "job-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSyncStateRow(overrides: Partial<SyncStateRow> = {}): SyncStateRow {
  return {
    connector_id: CONNECTOR_A,
    last_cursor: null,
    last_sync_at: null,
    last_sync_job_id: JOB_ID_A,
    sync_mode: "incremental",
    status: "running",
    last_error: null,
    last_error_code: null,
    rows_last_sync: "0",
    rows_total: "0",
    updated_at: new Date(Date.now() - 60 * 60 * 1_000), // 1 hour ago
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

type MockFn = ReturnType<typeof vi.fn>;

interface MockSyncStateRepo {
  upsert: MockFn;
  findByConnectorId: MockFn;
  findByConnectorIds: MockFn;
  updateStatus: MockFn;
  updateCursor: MockFn;
  resetStaleSyncs: MockFn;
  findStaleSyncs: MockFn;
  create: MockFn;
  update: MockFn;
}

function makeSyncStateRepo(): MockSyncStateRepo {
  return {
    upsert: vi.fn(),
    findByConnectorId: vi.fn(),
    findByConnectorIds: vi.fn(),
    updateStatus: vi.fn(),
    updateCursor: vi.fn(),
    resetStaleSyncs: vi.fn().mockResolvedValue(0),
    findStaleSyncs: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    update: vi.fn(),
  };
}

interface TestBundle {
  syncStateRepo: MockSyncStateRepo;
  logger: Logger;
}

function makeBundle(): TestBundle {
  return {
    syncStateRepo: makeSyncStateRepo(),
    logger: makeLogger(),
  };
}

function runWatchdog(
  bundle: TestBundle,
  staleThresholdMs = 30 * 60 * 1_000,
): Promise<number> {
  return executeWatchdog(
    bundle.syncStateRepo as unknown as SyncStateRepository,
    bundle.logger,
    staleThresholdMs,
  );
}

// ---------------------------------------------------------------------------
// executeWatchdog — no stale syncs
// ---------------------------------------------------------------------------

describe("executeWatchdog — no stale syncs", () => {
  let bundle: TestBundle;

  beforeEach(() => {
    bundle = makeBundle();
    bundle.syncStateRepo.findStaleSyncs.mockResolvedValue([]);
    bundle.syncStateRepo.resetStaleSyncs.mockResolvedValue(0);
  });

  it("returns 0 when no stale syncs exist", async () => {
    const count = await runWatchdog(bundle);
    expect(count).toBe(0);
  });

  it("calls findStaleSyncs with the given threshold", async () => {
    const threshold = 30 * 60 * 1_000;
    await runWatchdog(bundle, threshold);
    expect(bundle.syncStateRepo.findStaleSyncs.mock.calls).toHaveLength(1);
    expect(bundle.syncStateRepo.findStaleSyncs.mock.calls[0]?.[0]).toBe(threshold);
  });

  it("calls resetStaleSyncs even when no stale rows are found", async () => {
    await runWatchdog(bundle);
    expect(bundle.syncStateRepo.resetStaleSyncs.mock.calls).toHaveLength(1);
  });

  it("emits a debug log when nothing is stale", async () => {
    await runWatchdog(bundle);
    const debugCalls = (bundle.logger.debug as ReturnType<typeof vi.fn>).mock.calls;
    expect(debugCalls.length).toBeGreaterThan(0);
  });

  it("does not emit a warn log when nothing is stale", async () => {
    await runWatchdog(bundle);
    const warnCalls = (bundle.logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    expect(warnCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// executeWatchdog — one stale sync
// ---------------------------------------------------------------------------

describe("executeWatchdog — one stale sync", () => {
  let bundle: TestBundle;
  const staleRow = makeSyncStateRow({ connector_id: CONNECTOR_A, last_sync_job_id: JOB_ID_A });

  beforeEach(() => {
    bundle = makeBundle();
    bundle.syncStateRepo.findStaleSyncs.mockResolvedValue([staleRow]);
    bundle.syncStateRepo.resetStaleSyncs.mockResolvedValue(1);
  });

  it("returns the count returned by resetStaleSyncs", async () => {
    const count = await runWatchdog(bundle);
    expect(count).toBe(1);
  });

  it("logs a warn entry for the stale connector before resetting", async () => {
    await runWatchdog(bundle);
    const warnCalls = (bundle.logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    // Expect at least one warn that mentions the connector
    const perConnectorWarn = warnCalls.find(
      (call) =>
        typeof call[1] === "object" &&
        call[1] !== null &&
        (call[1] as Record<string, unknown>)["connectorId"] === CONNECTOR_A,
    );
    expect(perConnectorWarn).toBeDefined();
  });

  it("logs a summary warn with the total resetCount", async () => {
    await runWatchdog(bundle);
    const warnCalls = (bundle.logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    const summaryWarn = warnCalls.find(
      (call) =>
        typeof call[1] === "object" &&
        call[1] !== null &&
        (call[1] as Record<string, unknown>)["resetCount"] === 1,
    );
    expect(summaryWarn).toBeDefined();
  });

  it("passes the same threshold to findStaleSyncs and resetStaleSyncs", async () => {
    const threshold = 20 * 60 * 1_000;
    await runWatchdog(bundle, threshold);
    expect(bundle.syncStateRepo.findStaleSyncs.mock.calls[0]?.[0]).toBe(threshold);
    expect(bundle.syncStateRepo.resetStaleSyncs.mock.calls[0]?.[0]).toBe(threshold);
  });
});

// ---------------------------------------------------------------------------
// executeWatchdog — multiple stale syncs
// ---------------------------------------------------------------------------

describe("executeWatchdog — multiple stale syncs", () => {
  let bundle: TestBundle;
  const staleRowA = makeSyncStateRow({ connector_id: CONNECTOR_A, last_sync_job_id: JOB_ID_A });
  const staleRowB = makeSyncStateRow({ connector_id: CONNECTOR_B, last_sync_job_id: JOB_ID_B });

  beforeEach(() => {
    bundle = makeBundle();
    bundle.syncStateRepo.findStaleSyncs.mockResolvedValue([staleRowA, staleRowB]);
    bundle.syncStateRepo.resetStaleSyncs.mockResolvedValue(2);
  });

  it("returns 2 when two syncs are reset", async () => {
    const count = await runWatchdog(bundle);
    expect(count).toBe(2);
  });

  it("logs one warn per stale connector", async () => {
    await runWatchdog(bundle);
    const warnCalls = (bundle.logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    const connectorIds = warnCalls
      .filter(
        (call) =>
          typeof call[1] === "object" &&
          call[1] !== null &&
          "connectorId" in (call[1] as object),
      )
      .map((call) => (call[1] as Record<string, unknown>)["connectorId"]);

    expect(connectorIds).toContain(CONNECTOR_A);
    expect(connectorIds).toContain(CONNECTOR_B);
  });
});

// ---------------------------------------------------------------------------
// executeWatchdog — default threshold (passed explicitly since we call the
// raw function, not the method with its default parameter)
// ---------------------------------------------------------------------------

describe("executeWatchdog — default stale threshold", () => {
  let bundle: TestBundle;

  beforeEach(() => {
    bundle = makeBundle();
    bundle.syncStateRepo.findStaleSyncs.mockResolvedValue([]);
    bundle.syncStateRepo.resetStaleSyncs.mockResolvedValue(0);
  });

  it("accepts threshold of 900_000 (15 minutes — the service default)", async () => {
    const threshold = 15 * 60 * 1_000;
    await runWatchdog(bundle, threshold);
    const callArg = bundle.syncStateRepo.findStaleSyncs.mock.calls[0]?.[0] as number;
    expect(callArg).toBe(threshold);
  });

  it("accepts threshold of 0 (startup reset — all running rows are stale)", async () => {
    await runWatchdog(bundle, 0);
    const callArg = bundle.syncStateRepo.findStaleSyncs.mock.calls[0]?.[0] as number;
    expect(callArg).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// executeWatchdog — crash safety
// ---------------------------------------------------------------------------

describe("executeWatchdog — crash safety", () => {
  let bundle: TestBundle;

  beforeEach(() => {
    bundle = makeBundle();
  });

  it("does not throw when findStaleSyncs rejects", async () => {
    bundle.syncStateRepo.findStaleSyncs.mockRejectedValue(new Error("DB connection lost"));
    await expect(runWatchdog(bundle)).resolves.not.toThrow();
  });

  it("returns 0 when findStaleSyncs rejects", async () => {
    bundle.syncStateRepo.findStaleSyncs.mockRejectedValue(new Error("DB connection lost"));
    const count = await runWatchdog(bundle);
    expect(count).toBe(0);
  });

  it("does not throw when resetStaleSyncs rejects", async () => {
    bundle.syncStateRepo.findStaleSyncs.mockResolvedValue([]);
    bundle.syncStateRepo.resetStaleSyncs.mockRejectedValue(new Error("UPDATE failed"));
    await expect(runWatchdog(bundle)).resolves.not.toThrow();
  });

  it("returns 0 when resetStaleSyncs rejects", async () => {
    bundle.syncStateRepo.findStaleSyncs.mockResolvedValue([]);
    bundle.syncStateRepo.resetStaleSyncs.mockRejectedValue(new Error("UPDATE failed"));
    const count = await runWatchdog(bundle);
    expect(count).toBe(0);
  });

  it("logs an error when an exception occurs", async () => {
    bundle.syncStateRepo.findStaleSyncs.mockRejectedValue(new Error("timeout"));
    await runWatchdog(bundle);
    const errorCalls = (bundle.logger.error as ReturnType<typeof vi.fn>).mock.calls;
    expect(errorCalls.length).toBeGreaterThan(0);
  });
});
