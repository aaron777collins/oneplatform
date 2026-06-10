// Unit tests for utils/sliding-window-rate-limiter.ts
//
// Tests focus exclusively on the in-memory fallback path (inMemoryCheck) since
// that is the only pure-logic surface area testable without a real Redis client.
// We exercise the fallback by constructing a limiter with a fake Redis that
// immediately emits an 'error' event, which flips redisHealthy to false.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { createSlidingWindowLimiter } from "../utils/sliding-window-rate-limiter.js";
import type { Redis } from "ioredis";

// ---------------------------------------------------------------------------
// Minimal fake Redis that starts in "error" state so the in-memory path is used.
// We attach the 'error' listener synchronously inside createSlidingWindowLimiter,
// so we can emit the error event *after* construction by calling triggerError().
// ---------------------------------------------------------------------------

interface FakeRedis {
  redis: Redis;
  triggerError: () => void;
}

function makeFakeRedis(): FakeRedis {
  const emitter = new EventEmitter() as Redis;
  return {
    redis: emitter,
    triggerError: () => {
      emitter.emit("error", new Error("redis unavailable"));
    },
  };
}

// Helper: build a limiter where Redis is already unhealthy.
// We create the limiter first (which registers the 'error' listener), then
// immediately fire the error event synchronously so that redisHealthy=false
// before any check() call.
function makeLimiter(
  windowMs: number,
  fallbackReplicaCount: number
) {
  const { redis, triggerError } = makeFakeRedis();
  const limiter = createSlidingWindowLimiter({ redis, windowMs, fallbackReplicaCount });
  // Trigger error synchronously — the listener is already registered
  triggerError();
  return limiter;
}

// No-op — previously needed for async emit, now trigger is synchronous
async function flushEmit(): Promise<void> {
  // nothing to flush
}

// Generate a unique key per test to avoid cross-test state bleed through the
// module-level inMemoryWindows Map.
let keyCounter = 0;
function uniqueKey(base = "test-key"): string {
  return `${base}-${++keyCounter}-${Date.now()}`;
}

// ---------------------------------------------------------------------------
// In-memory fallback — allows up to limit
// ---------------------------------------------------------------------------

describe("in-memory fallback — basic allow/deny", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows requests up to the per-instance limit", async () => {
    const limiter = makeLimiter(60_000, 1);
    await flushEmit();
    const key = uniqueKey();
    const limit = 5;

    for (let i = 0; i < limit; i++) {
      const result = await limiter.check(key, limit);
      expect(result.allowed).toBe(true);
    }
  });

  it("denies the request at exactly the limit", async () => {
    const limiter = makeLimiter(60_000, 1);
    await flushEmit();
    const key = uniqueKey();
    const limit = 3;

    for (let i = 0; i < limit; i++) {
      await limiter.check(key, limit);
    }
    const result = await limiter.check(key, limit);
    expect(result.allowed).toBe(false);
  });

  it("returns remaining = 0 when denied", async () => {
    const limiter = makeLimiter(60_000, 1);
    await flushEmit();
    const key = uniqueKey();
    const limit = 2;

    await limiter.check(key, limit);
    await limiter.check(key, limit);
    const denied = await limiter.check(key, limit);
    expect(denied.remaining).toBe(0);
  });

  it("remaining decrements with each allowed request", async () => {
    const limiter = makeLimiter(60_000, 1);
    await flushEmit();
    const key = uniqueKey();
    const limit = 4;

    const r0 = await limiter.check(key, limit);
    expect(r0.remaining).toBe(3);
    const r1 = await limiter.check(key, limit);
    expect(r1.remaining).toBe(2);
    const r2 = await limiter.check(key, limit);
    expect(r2.remaining).toBe(1);
    const r3 = await limiter.check(key, limit);
    expect(r3.remaining).toBe(0);
  });

  it("policy is 'in-memory-fallback'", async () => {
    const limiter = makeLimiter(60_000, 1);
    await flushEmit();
    const key = uniqueKey();
    const result = await limiter.check(key, 10);
    expect(result.policy).toBe("in-memory-fallback");
  });

  it("resetAt is a future Unix timestamp (seconds)", async () => {
    const limiter = makeLimiter(60_000, 1);
    await flushEmit();
    const key = uniqueKey();
    const before = Math.floor(Date.now() / 1000);
    const result = await limiter.check(key, 10);
    expect(result.resetAt).toBeGreaterThanOrEqual(before + 60);
  });
});

// ---------------------------------------------------------------------------
// Window rotation — entries expire after windowMs
// ---------------------------------------------------------------------------

describe("in-memory fallback — window rotation", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows requests again after the window rolls over", async () => {
    const windowMs = 1000;
    const limiter = makeLimiter(windowMs, 1);
    await flushEmit();
    const key = uniqueKey();
    const limit = 2;

    await limiter.check(key, limit);
    await limiter.check(key, limit);
    // At limit — next one is denied
    const denied = await limiter.check(key, limit);
    expect(denied.allowed).toBe(false);

    // Advance past the window
    vi.advanceTimersByTime(windowMs + 1);

    // Should now be allowed again
    const allowed = await limiter.check(key, limit);
    expect(allowed.allowed).toBe(true);
  });

  it("only counts timestamps within the current window", async () => {
    const windowMs = 5000;
    const limiter = makeLimiter(windowMs, 1);
    await flushEmit();
    const key = uniqueKey();
    const limit = 3;

    // Use 2 slots
    await limiter.check(key, limit);
    await limiter.check(key, limit);

    // Advance halfway through the window
    vi.advanceTimersByTime(windowMs / 2);

    // Use 1 more slot
    await limiter.check(key, limit);

    // Advance past the initial 2 timestamps but not the latest one
    vi.advanceTimersByTime(windowMs / 2 + 1);

    // Only 1 timestamp is in the window — 2 remaining
    const result = await limiter.check(key, limit);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(1);
  });

  it("full window reset: all slots available after full window elapsed", async () => {
    const windowMs = 1000;
    const limiter = makeLimiter(windowMs, 1);
    await flushEmit();
    const key = uniqueKey();
    const limit = 5;

    for (let i = 0; i < limit; i++) {
      await limiter.check(key, limit);
    }
    // Exhausted
    expect((await limiter.check(key, limit)).allowed).toBe(false);

    vi.advanceTimersByTime(windowMs + 1);

    const r = await limiter.check(key, limit);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(limit - 1);
  });
});

// ---------------------------------------------------------------------------
// Per-instance limit division by replica count
// ---------------------------------------------------------------------------

describe("in-memory fallback — replica count division", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("divides limit by replica count (2 replicas → half the limit)", async () => {
    const limiter = makeLimiter(60_000, 2);
    await flushEmit();
    const key = uniqueKey();
    const limit = 10; // instance limit = floor(10/2) = 5

    for (let i = 0; i < 5; i++) {
      const r = await limiter.check(key, limit);
      expect(r.allowed).toBe(true);
    }
    const denied = await limiter.check(key, limit);
    expect(denied.allowed).toBe(false);
  });

  it("divides limit by replica count (3 replicas → floor(10/3) = 3)", async () => {
    const limiter = makeLimiter(60_000, 3);
    await flushEmit();
    const key = uniqueKey();
    const limit = 10; // instance limit = 3

    for (let i = 0; i < 3; i++) {
      expect((await limiter.check(key, limit)).allowed).toBe(true);
    }
    expect((await limiter.check(key, limit)).allowed).toBe(false);
  });

  it("replica count of 0 is treated as 1 (floor(limit/max(1,0)) = limit)", async () => {
    const limiter = makeLimiter(60_000, 0);
    await flushEmit();
    const key = uniqueKey();
    const limit = 4;

    for (let i = 0; i < 4; i++) {
      expect((await limiter.check(key, limit)).allowed).toBe(true);
    }
    expect((await limiter.check(key, limit)).allowed).toBe(false);
  });

  it("replica count of 1 does not divide the limit", async () => {
    const limiter = makeLimiter(60_000, 1);
    await flushEmit();
    const key = uniqueKey();
    const limit = 6;

    for (let i = 0; i < 6; i++) {
      expect((await limiter.check(key, limit)).allowed).toBe(true);
    }
    expect((await limiter.check(key, limit)).allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Burst multiplier affects effective limit
// ---------------------------------------------------------------------------

describe("in-memory fallback — burst multiplier", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("burst multiplier of 2 doubles the effective limit", async () => {
    const limiter = makeLimiter(60_000, 1);
    await flushEmit();
    const key = uniqueKey();
    const limit = 5;
    const burst = 2; // effective = 10

    for (let i = 0; i < 10; i++) {
      expect((await limiter.check(key, limit, burst)).allowed).toBe(true);
    }
    expect((await limiter.check(key, limit, burst)).allowed).toBe(false);
  });

  it("default burst multiplier of 1 leaves limit unchanged", async () => {
    const limiter = makeLimiter(60_000, 1);
    await flushEmit();
    const key = uniqueKey();
    const limit = 3;

    for (let i = 0; i < 3; i++) {
      expect((await limiter.check(key, limit)).allowed).toBe(true);
    }
    expect((await limiter.check(key, limit)).allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Independent keys are tracked separately
// ---------------------------------------------------------------------------

describe("in-memory fallback — key isolation", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("different keys have independent counters", async () => {
    const limiter = makeLimiter(60_000, 1);
    await flushEmit();
    const key1 = uniqueKey("tenant-a");
    const key2 = uniqueKey("tenant-b");
    const limit = 2;

    await limiter.check(key1, limit);
    await limiter.check(key1, limit);
    // key1 is at limit
    expect((await limiter.check(key1, limit)).allowed).toBe(false);
    // key2 is untouched
    expect((await limiter.check(key2, limit)).allowed).toBe(true);
  });

  it("same key across different limiter instances shares nothing (module-level map is shared)", async () => {
    // The module-level inMemoryWindows Map is shared across all limiter instances.
    // This test verifies that check() uses the same window for the same key.
    const l1 = makeLimiter(60_000, 1);
    const l2 = makeLimiter(60_000, 1);
    await flushEmit();
    const key = uniqueKey("shared");
    const limit = 3;

    // Consume 2 slots via l1
    await l1.check(key, limit);
    await l1.check(key, limit);

    // l2 sees the same window — only 1 slot left
    const r = await l2.check(key, limit);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(0);

    // Now exhausted
    expect((await l2.check(key, limit)).allowed).toBe(false);
  });
});
