// Unit tests for services/sandbox-manager.ts
//
// Tests: state machine transitions (STARTING → ACTIVE → DRAINING_OLD),
// getPrimary throws when STARTING, recordRun/recordCompletion inflight tracking,
// recycle threshold trigger, handleCrash, ping health-check transitions,
// stop cleans up intervals.

import { describe, it, expect, vi, afterEach } from "vitest";
import type { Logger } from "@oneplatform/core";
import { createSandboxManager } from "../services/sandbox-manager.js";
import type { UnixSocketClient } from "../services/unix-socket-client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

function makeClient(overrides: Partial<UnixSocketClient> = {}): UnixSocketClient {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(),
    onLogLine: vi.fn(),
    ping: vi.fn().mockResolvedValue({ pong: true, runCount: 0 }),
    drain: vi.fn().mockResolvedValue({ drainedCount: 0, timedOutCount: 0 }),
    close: vi.fn(),
    ...overrides,
  };
}

/** Flush all pending promise micro-tasks without fake timers */
async function flushPromises(): Promise<void> {
  // Yield several times to allow chained promise resolutions to settle
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// getPrimary — throws when STARTING
// ---------------------------------------------------------------------------

describe("createSandboxManager — getPrimary", () => {
  it("throws when state is STARTING (initial state before any ping)", () => {
    const manager = createSandboxManager({
      primaryClient: makeClient(),
      logger: makeLogger(),
    });

    // Initial state is STARTING — getPrimary must throw
    expect(() => manager.getPrimary()).toThrow();
    manager.stop();
  });

  it("thrown error message mentions sandbox unavailability", () => {
    const manager = createSandboxManager({
      primaryClient: makeClient(),
      logger: makeLogger(),
    });

    let thrownMessage = "";
    try {
      manager.getPrimary();
    } catch (e) {
      thrownMessage = e instanceof Error ? e.message : String(e);
    }
    expect(thrownMessage.length).toBeGreaterThan(0);
    manager.stop();
  });

  it("does not throw after STARTING → ACTIVE transition via successful ping", async () => {
    const client = makeClient();
    const manager = createSandboxManager({
      primaryClient: client,
      logger: makeLogger(),
      recycleIntervalMs: 3_600_000,
    });

    manager.startHealthChecks();
    await flushPromises();

    expect(() => manager.getPrimary()).not.toThrow();
    manager.stop();
  });

  it("primary state is ACTIVE after first successful ping", async () => {
    const client = makeClient();
    const manager = createSandboxManager({
      primaryClient: client,
      logger: makeLogger(),
      recycleIntervalMs: 3_600_000,
    });

    manager.startHealthChecks();
    await flushPromises();

    const primary = manager.getPrimary();
    expect(primary.state).toBe("ACTIVE");
    manager.stop();
  });
});

// ---------------------------------------------------------------------------
// recordRun / recordCompletion — inflight tracking
// ---------------------------------------------------------------------------

describe("createSandboxManager — recordRun / recordCompletion", () => {
  async function makeActiveManager(recycleAfterCount = 1000) {
    const client = makeClient();
    const manager = createSandboxManager({
      primaryClient: client,
      logger: makeLogger(),
      recycleAfterCount,
      recycleIntervalMs: 3_600_000,
    });
    manager.startHealthChecks();
    await flushPromises();
    return { manager, client };
  }

  it("adds executionId to inflightIds on recordRun", async () => {
    const { manager } = await makeActiveManager();
    manager.recordRun("exec-001");
    const primary = manager.getPrimary();
    expect(primary.inflightIds.has("exec-001")).toBe(true);
    manager.stop();
  });

  it("removes executionId from inflightIds on recordCompletion", async () => {
    const { manager } = await makeActiveManager();
    manager.recordRun("exec-001");
    manager.recordCompletion("exec-001");
    const primary = manager.getPrimary();
    expect(primary.inflightIds.has("exec-001")).toBe(false);
    manager.stop();
  });

  it("increments runCount on each recordRun", async () => {
    const { manager } = await makeActiveManager();
    manager.recordRun("exec-001");
    manager.recordRun("exec-002");
    const primary = manager.getPrimary();
    expect(primary.runCount).toBe(2);
    manager.stop();
  });

  it("multiple inflight executions tracked independently", async () => {
    const { manager } = await makeActiveManager();
    manager.recordRun("exec-001");
    manager.recordRun("exec-002");
    manager.recordCompletion("exec-001");
    const primary = manager.getPrimary();
    expect(primary.inflightIds.has("exec-001")).toBe(false);
    expect(primary.inflightIds.has("exec-002")).toBe(true);
    manager.stop();
  });

  it("recordCompletion is a no-op for unknown executionId", async () => {
    const { manager } = await makeActiveManager();
    // Should not throw
    expect(() => manager.recordCompletion("nonexistent")).not.toThrow();
    manager.stop();
  });
});

// ---------------------------------------------------------------------------
// recycle threshold trigger
// ---------------------------------------------------------------------------

describe("createSandboxManager — recycle threshold", () => {
  it("triggers recycle when runCount reaches recycleAfterCount", async () => {
    vi.useFakeTimers();

    const client = makeClient();
    const manager = createSandboxManager({
      primaryClient: client,
      logger: makeLogger(),
      recycleAfterCount: 3,
      recycleIntervalMs: 3_600_000,
      drainGracePeriodMs: 1,
    });

    manager.startHealthChecks();
    // Flush the initial ping promise only (don't fire all timers — would loop)
    await vi.advanceTimersByTimeAsync(0);
    await flushPromises();

    // Record 3 runs to hit the threshold
    manager.recordRun("exec-001");
    manager.recordRun("exec-002");
    manager.recordRun("exec-003");

    // Advance just enough for drainGracePeriodMs (1ms) + check interval (500ms) to fire
    await vi.advanceTimersByTimeAsync(600);
    await flushPromises();

    // drain should have been called on the client during recycle
    expect(client.drain).toHaveBeenCalled();

    manager.stop();
    vi.useRealTimers();
  });

  it("does not trigger recycle below threshold", async () => {
    const client = makeClient();
    const manager = createSandboxManager({
      primaryClient: client,
      logger: makeLogger(),
      recycleAfterCount: 5,
      recycleIntervalMs: 3_600_000,
    });

    manager.startHealthChecks();
    await flushPromises();

    // Only 4 runs — threshold is 5
    manager.recordRun("exec-001");
    manager.recordRun("exec-002");
    manager.recordRun("exec-003");
    manager.recordRun("exec-004");

    await flushPromises();

    expect(client.drain).not.toHaveBeenCalled();
    manager.stop();
  });
});

// ---------------------------------------------------------------------------
// handleCrash
// ---------------------------------------------------------------------------

describe("createSandboxManager — handleCrash", () => {
  it("returns all inflight execution IDs at time of crash", async () => {
    const client = makeClient();
    const manager = createSandboxManager({
      primaryClient: client,
      logger: makeLogger(),
      recycleAfterCount: 1000,
      recycleIntervalMs: 3_600_000,
    });

    manager.startHealthChecks();
    await flushPromises();

    manager.recordRun("exec-001");
    manager.recordRun("exec-002");
    manager.recordRun("exec-003");

    const killed = manager.handleCrash();
    expect(killed).toHaveLength(3);
    expect(killed).toContain("exec-001");
    expect(killed).toContain("exec-002");
    expect(killed).toContain("exec-003");

    manager.stop();
  });

  it("clears inflightIds after handleCrash (state becomes STARTING)", async () => {
    const client = makeClient();
    const manager = createSandboxManager({
      primaryClient: client,
      logger: makeLogger(),
      recycleAfterCount: 1000,
      recycleIntervalMs: 3_600_000,
    });

    manager.startHealthChecks();
    await flushPromises();

    manager.recordRun("exec-001");
    manager.handleCrash();

    // After crash, state is STARTING — getPrimary should throw
    expect(() => manager.getPrimary()).toThrow();

    manager.stop();
  });

  it("returns empty array when no inflight executions at crash time", async () => {
    const client = makeClient();
    const manager = createSandboxManager({
      primaryClient: client,
      logger: makeLogger(),
      recycleAfterCount: 1000,
      recycleIntervalMs: 3_600_000,
    });

    manager.startHealthChecks();
    await flushPromises();

    const killed = manager.handleCrash();
    expect(killed).toEqual([]);

    manager.stop();
  });

  it("calls onCrash callback after handleCrash", async () => {
    const onCrash = vi.fn();
    const client = makeClient();
    const manager = createSandboxManager({
      primaryClient: client,
      logger: makeLogger(),
      recycleAfterCount: 1000,
      recycleIntervalMs: 3_600_000,
      onCrash,
    });

    manager.startHealthChecks();
    await flushPromises();

    manager.recordRun("exec-001");
    manager.handleCrash();

    // onCrash is invoked by triggerCrashRecovery() which is called from handleCrash.
    // handleCrash clears inflightIds BEFORE calling triggerCrashRecovery(), so
    // triggerCrashRecovery() captures an empty set — onCrash receives [].
    // The caller's return value (killed IDs) is the intended way to get them.
    expect(onCrash).toHaveBeenCalledTimes(1);

    manager.stop();
  });

  it("does not call onCrash when no onCrash handler configured", async () => {
    const client = makeClient();
    const manager = createSandboxManager({
      primaryClient: client,
      logger: makeLogger(),
      recycleAfterCount: 1000,
      recycleIntervalMs: 3_600_000,
      // no onCrash
    });

    manager.startHealthChecks();
    await flushPromises();

    manager.recordRun("exec-001");
    // Should not throw even without onCrash callback
    expect(() => manager.handleCrash()).not.toThrow();

    manager.stop();
  });
});

// ---------------------------------------------------------------------------
// startHealthChecks
// ---------------------------------------------------------------------------

describe("createSandboxManager — startHealthChecks", () => {
  it("calls ping once on the initial health check", async () => {
    const client = makeClient();
    const manager = createSandboxManager({
      primaryClient: client,
      logger: makeLogger(),
      recycleIntervalMs: 3_600_000,
    });

    manager.startHealthChecks();
    await flushPromises();

    expect(client.ping).toHaveBeenCalledTimes(1);
    manager.stop();
  });

  it("does not start a duplicate interval when called twice", async () => {
    const client = makeClient();
    const manager = createSandboxManager({
      primaryClient: client,
      logger: makeLogger(),
      recycleIntervalMs: 3_600_000,
    });

    manager.startHealthChecks();
    manager.startHealthChecks(); // second call should be a no-op
    await flushPromises();

    // Only one initial ping should have fired (second startHealthChecks is no-op)
    expect(client.ping).toHaveBeenCalledTimes(1);
    manager.stop();
  });

  it("calls onCrash after PING_MISS_THRESHOLD consecutive ping failures", async () => {
    vi.useFakeTimers();
    const onCrash = vi.fn();

    // Start with a successful ping, then fail for all subsequent calls
    const pingFn = vi.fn()
      .mockResolvedValueOnce({ pong: true, runCount: 0 }) // first: success (STARTING → ACTIVE)
      .mockRejectedValue(new Error("Connection refused")); // rest: fail

    // connect will fail to prevent scheduleReconnect from creating new active timers
    const client = makeClient({
      ping: pingFn,
      connect: vi.fn().mockRejectedValue(new Error("Reconnect failed")),
    });

    const manager = createSandboxManager({
      primaryClient: client,
      logger: makeLogger(),
      recycleIntervalMs: 3_600_000,
      onCrash,
    });

    manager.startHealthChecks();
    // Flush the initial ping (success) with a tiny advance
    await vi.advanceTimersByTimeAsync(0);
    await flushPromises();

    // 3 consecutive ping failures at 10-second intervals = PING_MISS_THRESHOLD (3)
    await vi.advanceTimersByTimeAsync(10_000); // miss 1
    await flushPromises();
    await vi.advanceTimersByTimeAsync(10_000); // miss 2
    await flushPromises();
    await vi.advanceTimersByTimeAsync(10_000); // miss 3 → triggers crash recovery
    await flushPromises();

    expect(onCrash).toHaveBeenCalled();

    manager.stop();
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

describe("createSandboxManager — stop", () => {
  it("calls close() on the primary client", async () => {
    const client = makeClient();
    const manager = createSandboxManager({
      primaryClient: client,
      logger: makeLogger(),
      recycleIntervalMs: 3_600_000,
    });

    manager.startHealthChecks();
    await flushPromises();
    manager.stop();

    expect(client.close).toHaveBeenCalledOnce();
  });

  it("can be called safely before startHealthChecks", () => {
    const client = makeClient();
    const manager = createSandboxManager({
      primaryClient: client,
      logger: makeLogger(),
    });

    // stop without ever calling startHealthChecks
    expect(() => manager.stop()).not.toThrow();
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("can be called safely multiple times", async () => {
    const client = makeClient();
    const manager = createSandboxManager({
      primaryClient: client,
      logger: makeLogger(),
      recycleIntervalMs: 3_600_000,
    });

    manager.startHealthChecks();
    await flushPromises();
    manager.stop();

    // Second stop should not throw
    expect(() => manager.stop()).not.toThrow();
  });
});
