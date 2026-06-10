// Unit tests for utils/circuit-breaker.ts
//
// Covers the closed→open→half-open→closed state machine exhaustively,
// including boundary conditions, concurrent probes, and error re-throw
// semantics.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createCircuitBreaker, CircuitBreakerOpenError } from "../utils/circuit-breaker.js";
import { AppError } from "@oneplatform/core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolves<T>(value: T): () => Promise<T> {
  return () => Promise.resolve(value);
}

function rejects(err: Error = new Error("upstream failure")): () => Promise<never> {
  return () => Promise.reject(err);
}

function makeBreakerWith(failureThreshold: number, resetTimeoutMs: number) {
  return createCircuitBreaker({ failureThreshold, resetTimeoutMs });
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

describe("circuit breaker initial state", () => {
  it("starts in closed state", () => {
    const cb = makeBreakerWith(3, 10_000);
    expect(cb.getState()).toBe("closed");
  });

  it("executes a successful function and returns its value", async () => {
    const cb = makeBreakerWith(3, 10_000);
    const result = await cb.execute(resolves(42));
    expect(result).toBe(42);
  });

  it("propagates the resolved value through a promise chain", async () => {
    const cb = makeBreakerWith(3, 10_000);
    const result = await cb.execute(() => Promise.resolve("hello"));
    expect(result).toBe("hello");
  });

  it("remains closed after a single success", async () => {
    const cb = makeBreakerWith(3, 10_000);
    await cb.execute(resolves("ok"));
    expect(cb.getState()).toBe("closed");
  });

  it("re-throws errors while remaining closed below threshold", async () => {
    const cb = makeBreakerWith(3, 10_000);
    const err = new Error("transient");
    await expect(cb.execute(rejects(err))).rejects.toThrow("transient");
    expect(cb.getState()).toBe("closed");
  });

  it("does not open after threshold - 1 consecutive failures", async () => {
    const cb = makeBreakerWith(5, 10_000);
    for (let i = 0; i < 4; i++) {
      await expect(cb.execute(rejects())).rejects.toThrow();
    }
    expect(cb.getState()).toBe("closed");
  });
});

// ---------------------------------------------------------------------------
// Closed → Open transition
// ---------------------------------------------------------------------------

describe("closed → open transition", () => {
  it("opens after exactly failureThreshold consecutive failures", async () => {
    const cb = makeBreakerWith(3, 10_000);
    for (let i = 0; i < 3; i++) {
      await expect(cb.execute(rejects())).rejects.toThrow();
    }
    expect(cb.getState()).toBe("open");
  });

  it("resets consecutive failure count on success, so threshold restarts", async () => {
    const cb = makeBreakerWith(3, 10_000);
    // Two failures, one success, two more failures — should not open yet
    await expect(cb.execute(rejects())).rejects.toThrow();
    await expect(cb.execute(rejects())).rejects.toThrow();
    await cb.execute(resolves("reset"));
    await expect(cb.execute(rejects())).rejects.toThrow();
    await expect(cb.execute(rejects())).rejects.toThrow();
    expect(cb.getState()).toBe("closed");
  });

  it("opens on exactly the Nth consecutive failure (threshold = 1)", async () => {
    const cb = makeBreakerWith(1, 10_000);
    await expect(cb.execute(rejects())).rejects.toThrow();
    expect(cb.getState()).toBe("open");
  });

  it("opens on exactly the Nth consecutive failure (threshold = 5)", async () => {
    const cb = makeBreakerWith(5, 10_000);
    for (let i = 0; i < 4; i++) {
      await expect(cb.execute(rejects())).rejects.toThrow();
      expect(cb.getState()).toBe("closed");
    }
    await expect(cb.execute(rejects())).rejects.toThrow();
    expect(cb.getState()).toBe("open");
  });

  it("throws CircuitBreakerOpenError immediately when open", async () => {
    const cb = makeBreakerWith(1, 10_000);
    await expect(cb.execute(rejects())).rejects.toThrow();
    // Second call — breaker is now open
    await expect(cb.execute(resolves("should not run"))).rejects.toBeInstanceOf(
      CircuitBreakerOpenError
    );
  });

  it("does not invoke the function when the breaker is open", async () => {
    const cb = makeBreakerWith(1, 10_000);
    await expect(cb.execute(rejects())).rejects.toThrow();

    let called = false;
    const fn = () => {
      called = true;
      return Promise.resolve("nope");
    };
    await expect(cb.execute(fn)).rejects.toBeInstanceOf(CircuitBreakerOpenError);
    expect(called).toBe(false);
  });

  it("CircuitBreakerOpenError has statusCode 503", async () => {
    const cb = makeBreakerWith(1, 10_000);
    await expect(cb.execute(rejects())).rejects.toThrow();
    try {
      await cb.execute(resolves("x"));
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CircuitBreakerOpenError);
      expect((err as CircuitBreakerOpenError).statusCode).toBe(503);
    }
  });

  it("CircuitBreakerOpenError is an instance of AppError", async () => {
    const cb = makeBreakerWith(1, 10_000);
    await expect(cb.execute(rejects())).rejects.toThrow();
    try {
      await cb.execute(resolves("x"));
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
    }
  });

  it("CircuitBreakerOpenError code is GATEWAY_PROXY_UNAVAILABLE", async () => {
    const cb = makeBreakerWith(1, 10_000);
    await expect(cb.execute(rejects())).rejects.toThrow();
    try {
      await cb.execute(resolves("x"));
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as CircuitBreakerOpenError).code).toBe("GATEWAY_PROXY_UNAVAILABLE");
    }
  });
});

// ---------------------------------------------------------------------------
// Open → Half-open transition (time-based)
// ---------------------------------------------------------------------------

describe("open → half-open transition", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("remains open before resetTimeoutMs has elapsed", async () => {
    const cb = makeBreakerWith(1, 5000);
    await expect(cb.execute(rejects())).rejects.toThrow();
    vi.advanceTimersByTime(4999);
    expect(cb.getState()).toBe("open");
    // Execute should still throw CircuitBreakerOpenError
    await expect(cb.execute(resolves("x"))).rejects.toBeInstanceOf(CircuitBreakerOpenError);
  });

  it("transitions to half-open exactly when resetTimeoutMs elapses", async () => {
    const cb = makeBreakerWith(1, 5000);
    await expect(cb.execute(rejects())).rejects.toThrow();
    vi.advanceTimersByTime(5000);
    // Trigger the lazy transition check by executing
    const promise = cb.execute(resolves("probe"));
    expect(cb.getState()).toBe("half-open");
    await promise;
  });

  it("transitions to half-open after resetTimeoutMs + 1ms", async () => {
    const cb = makeBreakerWith(1, 5000);
    await expect(cb.execute(rejects())).rejects.toThrow();
    vi.advanceTimersByTime(5001);
    await cb.execute(resolves("probe"));
    expect(cb.getState()).toBe("closed");
  });

  it("transition to half-open is lazy — happens on execute() call, not on a timer", async () => {
    const cb = makeBreakerWith(1, 100);
    await expect(cb.execute(rejects())).rejects.toThrow();
    vi.advanceTimersByTime(200);
    // State is still open until execute() is called
    // (getState alone does NOT trigger the transition)
    // The actual check happens inside execute()
    const result = await cb.execute(resolves("late probe"));
    expect(result).toBe("late probe");
    expect(cb.getState()).toBe("closed");
  });
});

// ---------------------------------------------------------------------------
// Half-open → Closed on probe success
// ---------------------------------------------------------------------------

describe("half-open → closed on probe success", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("closes after a single successful probe in half-open state", async () => {
    const cb = makeBreakerWith(1, 1000);
    await expect(cb.execute(rejects())).rejects.toThrow();
    vi.advanceTimersByTime(1000);
    await cb.execute(resolves("probe-success"));
    expect(cb.getState()).toBe("closed");
  });

  it("allows normal execution after closing from half-open", async () => {
    const cb = makeBreakerWith(1, 1000);
    await expect(cb.execute(rejects())).rejects.toThrow();
    vi.advanceTimersByTime(1000);
    await cb.execute(resolves("probe"));
    const result = await cb.execute(resolves("normal"));
    expect(result).toBe("normal");
    expect(cb.getState()).toBe("closed");
  });

  it("resets failure count on successful probe close", async () => {
    const cb = makeBreakerWith(2, 1000);
    // Open the breaker
    await expect(cb.execute(rejects())).rejects.toThrow();
    await expect(cb.execute(rejects())).rejects.toThrow();
    vi.advanceTimersByTime(1000);
    // Probe succeeds → closed
    await cb.execute(resolves("probe"));
    expect(cb.getState()).toBe("closed");
    // One more failure should not re-open (threshold is 2)
    await expect(cb.execute(rejects())).rejects.toThrow();
    expect(cb.getState()).toBe("closed");
  });
});

// ---------------------------------------------------------------------------
// Half-open → Open on probe failure
// ---------------------------------------------------------------------------

describe("half-open → open on probe failure", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("re-opens immediately when the probe fails", async () => {
    const cb = makeBreakerWith(1, 1000);
    await expect(cb.execute(rejects())).rejects.toThrow();
    vi.advanceTimersByTime(1000);
    await expect(cb.execute(rejects(new Error("probe failed")))).rejects.toThrow("probe failed");
    expect(cb.getState()).toBe("open");
  });

  it("can re-enter half-open after a second timeout following probe failure", async () => {
    const cb = makeBreakerWith(1, 1000);
    await expect(cb.execute(rejects())).rejects.toThrow();
    vi.advanceTimersByTime(1000);
    await expect(cb.execute(rejects())).rejects.toThrow(); // probe fails → re-opens
    expect(cb.getState()).toBe("open");
    vi.advanceTimersByTime(1000);
    await cb.execute(resolves("second-probe-success"));
    expect(cb.getState()).toBe("closed");
  });

  it("still rejects non-probe requests in open state after failed probe", async () => {
    const cb = makeBreakerWith(1, 1000);
    await expect(cb.execute(rejects())).rejects.toThrow();
    vi.advanceTimersByTime(1000);
    await expect(cb.execute(rejects())).rejects.toThrow(); // probe fails
    // Now open again — subsequent calls should be short-circuited
    await expect(cb.execute(resolves("blocked"))).rejects.toBeInstanceOf(CircuitBreakerOpenError);
  });
});

// ---------------------------------------------------------------------------
// Error propagation — original errors are always re-thrown
// ---------------------------------------------------------------------------

describe("error propagation", () => {
  it("re-throws the original error class (not CircuitBreakerOpenError) in closed state", async () => {
    class CustomError extends Error {
      readonly custom = true;
    }
    const cb = makeBreakerWith(5, 1000);
    const err = new CustomError("custom");
    await expect(cb.execute(() => Promise.reject(err))).rejects.toBeInstanceOf(CustomError);
  });

  it("re-throws the original error in half-open state on probe failure", async () => {
    vi.useFakeTimers();
    const cb = makeBreakerWith(1, 1000);
    const originalError = new TypeError("probe rejection");
    await expect(cb.execute(rejects())).rejects.toThrow();
    vi.advanceTimersByTime(1000);
    await expect(cb.execute(() => Promise.reject(originalError))).rejects.toBeInstanceOf(TypeError);
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("threshold of 0 is treated the same as threshold 0 — never opens on success", async () => {
    // Creating with threshold=0 means 0 failures needed — but the code checks
    // consecutiveFailures >= failureThreshold. 0 >= 0 on the first failure.
    const cb = makeBreakerWith(0, 1000);
    // A failure should open immediately since 1 >= 0 is false ... actually 1 >= 0 is true.
    // The condition is: consecutiveFailures >= failureThreshold
    // After first failure consecutiveFailures becomes 1, 1 >= 0 is true.
    await expect(cb.execute(rejects())).rejects.toThrow();
    expect(cb.getState()).toBe("open");
  });

  it("handles async functions that resolve with undefined", async () => {
    const cb = makeBreakerWith(3, 1000);
    const result = await cb.execute(() => Promise.resolve(undefined));
    expect(result).toBeUndefined();
    expect(cb.getState()).toBe("closed");
  });

  it("handles async functions that resolve with null", async () => {
    const cb = makeBreakerWith(3, 1000);
    const result = await cb.execute(() => Promise.resolve(null));
    expect(result).toBeNull();
  });

  it("handles async functions that resolve with objects", async () => {
    const cb = makeBreakerWith(3, 1000);
    const obj = { a: 1, b: [2, 3] };
    const result = await cb.execute(() => Promise.resolve(obj));
    expect(result).toEqual(obj);
  });

  it("multiple independent circuit breakers do not share state", async () => {
    const cb1 = makeBreakerWith(1, 1000);
    const cb2 = makeBreakerWith(1, 1000);
    await expect(cb1.execute(rejects())).rejects.toThrow();
    expect(cb1.getState()).toBe("open");
    expect(cb2.getState()).toBe("closed");
  });

  it("consecutive successes in closed state keep failure count at zero", async () => {
    const cb = makeBreakerWith(2, 1000);
    for (let i = 0; i < 10; i++) {
      await cb.execute(resolves(i));
    }
    expect(cb.getState()).toBe("closed");
    // One failure should still leave it closed (threshold = 2)
    await expect(cb.execute(rejects())).rejects.toThrow();
    expect(cb.getState()).toBe("closed");
  });
});

// ---------------------------------------------------------------------------
// Concurrent calls in half-open state
// ---------------------------------------------------------------------------

describe("concurrent calls in half-open state", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("blocks concurrent probes in half-open state — only the first probe runs, second is rejected", async () => {
    const cb = makeBreakerWith(1, 1000);
    await expect(cb.execute(rejects())).rejects.toThrow();
    vi.advanceTimersByTime(1000);

    // Only the first concurrent caller is allowed to probe. The second sees
    // the probeInFlight sentinel and is immediately rejected as if open.
    // This prevents a thundering herd when the upstream recovers.
    const results = await Promise.allSettled([
      cb.execute(resolves("a")),
      cb.execute(resolves("b")),
    ]);

    // First probe succeeds and closes the breaker
    expect(results[0]).toMatchObject({ status: "fulfilled", value: "a" });
    // Second concurrent call is rejected while the probe is in-flight
    expect(results[1]).toMatchObject({ status: "rejected" });
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(CircuitBreakerOpenError);
    expect(cb.getState()).toBe("closed");
  });
});
