// Per-service circuit breaker (design §6.4).
//
// Prevents thread exhaustion when an upstream is down. After
// `failureThreshold` consecutive failures within a window, the breaker opens
// and callers receive an immediate error instead of waiting for a timeout to
// accumulate. After `resetTimeoutMs`, the breaker moves to half-open and
// allows one probe request through. A probe success closes the breaker; a
// probe failure re-opens it.
//
// State machine:
//
//   closed ──(threshold failures)──► open ──(resetTimeoutMs)──► half-open
//     ▲                                                               │
//     └──────────────────(probe success)─────────────────────────────┘
//                                                     │
//                                 (probe failure) ────► open
//

import { AppError } from "@oneplatform/core";

// ---------------------------------------------------------------------------
// Error thrown when execution is rejected because the breaker is open.
// HTTP 503 maps cleanly to "service unavailable" from the client's perspective.
// ---------------------------------------------------------------------------

export class CircuitBreakerOpenError extends AppError {
  readonly code = "GATEWAY_PROXY_UNAVAILABLE" as const;
  readonly statusCode = 503;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type BreakerState = "closed" | "open" | "half-open";

export interface CircuitBreaker {
  /**
   * Run `fn`. Throws `CircuitBreakerOpenError` when the breaker is open.
   * Records success / failure to drive state transitions.
   */
  execute<T>(fn: () => Promise<T>): Promise<T>;

  /** Current state of the breaker. */
  getState(): BreakerState;
}

export interface CircuitBreakerOptions {
  /**
   * Number of consecutive failures that cause the breaker to open.
   * The default in the design is 5 (OP_CIRCUIT_BREAKER_THRESHOLD).
   */
  failureThreshold: number;

  /**
   * Milliseconds to wait in the open state before transitioning to half-open
   * and allowing a single probe request through.
   * Default in the design: 10,000 ms (OP_CIRCUIT_BREAKER_RESET_MS).
   */
  resetTimeoutMs: number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates an independent circuit breaker instance. Each upstream service
 * target should have its own instance so a failure in one service does not
 * affect breakers for other services.
 */
export function createCircuitBreaker(
  options: CircuitBreakerOptions
): CircuitBreaker {
  const { failureThreshold, resetTimeoutMs } = options;

  let state: BreakerState = "closed";
  let consecutiveFailures = 0;
  // Timestamp (ms) at which the breaker entered the open state.
  // Used to determine when to transition to half-open.
  let openedAt: number | null = null;
  // Sentinel: true while the single half-open probe is in-flight.
  // Additional callers see the breaker as open so only one probe races
  // at a time — preventing a thundering herd when the upstream recovers.
  let probeInFlight = false;

  function transitionToOpen(): void {
    state = "open";
    openedAt = Date.now();
  }

  function transitionToClosed(): void {
    state = "closed";
    consecutiveFailures = 0;
    openedAt = null;
  }

  function transitionToHalfOpen(): void {
    state = "half-open";
    probeInFlight = false;
    // Reset failure count so the single probe is judged on its own merits.
    consecutiveFailures = 0;
  }

  function checkHalfOpenTransition(): void {
    if (state === "open" && openedAt !== null) {
      if (Date.now() - openedAt >= resetTimeoutMs) {
        transitionToHalfOpen();
      }
    }
  }

  async function execute<T>(fn: () => Promise<T>): Promise<T> {
    // Allow the open→half-open transition to happen lazily on each call
    // rather than requiring a background timer. This keeps the breaker
    // side-effect free and easy to test with controlled time.
    checkHalfOpenTransition();

    if (state === "open") {
      throw new CircuitBreakerOpenError(
        "The upstream service is temporarily unavailable. The circuit breaker is open."
      );
    }

    // In half-open state, exactly one probe is allowed at a time.
    // probeInFlight prevents concurrent requests from all racing through
    // before the first probe result is known.
    if (state === "half-open" && probeInFlight) {
      throw new CircuitBreakerOpenError(
        "The upstream service is temporarily unavailable. The circuit breaker is open."
      );
    }

    if (state === "half-open") {
      probeInFlight = true;
    }

    try {
      const result = await fn();

      if (state === "half-open") {
        // Probe succeeded: upstream recovered, close the breaker.
        probeInFlight = false;
        transitionToClosed();
      } else {
        // Success in closed state: reset consecutive failure counter.
        consecutiveFailures = 0;
      }

      return result;
    } catch (err) {
      consecutiveFailures++;

      if (state === "half-open") {
        // Probe failed: upstream still down, re-open immediately.
        probeInFlight = false;
        transitionToOpen();
      } else if (consecutiveFailures >= failureThreshold) {
        // Threshold reached in closed state: open the breaker.
        transitionToOpen();
      }

      throw err;
    }
  }

  return {
    execute,
    getState: () => state,
  };
}
