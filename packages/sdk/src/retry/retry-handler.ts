/**
 * Exponential backoff with jitter for transient failures.
 *
 * The retry loop is decoupled from the transport layer — it receives a generic
 * "attempt" function that returns a result or throws. This makes it independently
 * testable without setting up a full HTTP stack.
 */

import type { RetryPolicy } from '../types/client-options.js';

export const DEFAULT_RETRY_POLICY = {
  maxRetries: 3,
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  retryableStatusCodes: [429, 500, 502, 503, 504] as number[],
  jitter: true,
} as const satisfies Required<Omit<RetryPolicy, 'jitter'>> & { jitter: boolean };

/**
 * Calculates the delay for attempt number `attemptIndex` (0-based, first retry = 0).
 *
 * We apply ±25% jitter by default to prevent thundering-herd when many clients
 * hit the same server failure simultaneously.
 */
export function calculateBackoff(attemptIndex: number, policy: Required<RetryPolicy>): number {
  const base = policy.initialDelayMs * Math.pow(2, attemptIndex);
  const capped = Math.min(base, policy.maxDelayMs);

  if (!policy.jitter) return capped;

  // 0.75 to 1.25 uniform distribution → ±25% jitter
  const jitterFactor = 0.75 + Math.random() * 0.5;
  return Math.floor(capped * jitterFactor);
}

/**
 * Parses the Retry-After header value (seconds integer or HTTP-date string)
 * into milliseconds. Falls back to backoff calculation on parse failure.
 */
export function parseRetryAfterMs(
  header: string,
  attemptIndex: number,
  policy: Required<RetryPolicy>,
): number {
  const seconds = parseInt(header, 10);
  if (!isNaN(seconds)) {
    // Seconds format: "Retry-After: 30"
    return Math.min(seconds * 1000, policy.maxDelayMs);
  }

  // HTTP-date format: "Retry-After: Wed, 11 Jun 2026 00:00:00 GMT"
  const date = Date.parse(header);
  if (!isNaN(date)) {
    return Math.min(Math.max(0, date - Date.now()), policy.maxDelayMs);
  }

  // Unparseable — fall back to normal exponential backoff
  return calculateBackoff(attemptIndex, policy);
}

/** Merge caller-supplied RetryPolicy with defaults, filling in any missing fields. */
export function resolveRetryPolicy(policy?: RetryPolicy | false): Required<RetryPolicy> | false {
  if (policy === false) return false;
  if (policy === undefined) return { ...DEFAULT_RETRY_POLICY };

  return {
    maxRetries: policy.maxRetries ?? DEFAULT_RETRY_POLICY.maxRetries,
    initialDelayMs: policy.initialDelayMs ?? DEFAULT_RETRY_POLICY.initialDelayMs,
    maxDelayMs: policy.maxDelayMs ?? DEFAULT_RETRY_POLICY.maxDelayMs,
    retryableStatusCodes:
      policy.retryableStatusCodes ?? [...DEFAULT_RETRY_POLICY.retryableStatusCodes],
    jitter: policy.jitter ?? DEFAULT_RETRY_POLICY.jitter,
  };
}

/**
 * Wraps an async operation with retry logic.
 *
 * @param attempt - Returns a value or throws. If it throws with `statusCode` on
 *   the thrown object the retry decision is made on that code. The function also
 *   receives the current `retryAfterMs` when the server signalled a delay.
 * @param getStatusCode - Extracts a status code from a thrown error for retry
 *   decision. Return undefined to suppress retry for that error type.
 * @param getRetryAfterHeader - If present on the thrown error, used to override
 *   backoff with the server-specified delay.
 * @param policy - Resolved retry policy. Pass `false` to run attempt once only.
 */
export async function withRetry<T>(
  attempt: () => Promise<T>,
  getStatusCode: (err: unknown) => number | undefined,
  getRetryAfterHeader: (err: unknown) => string | undefined,
  policy: Required<RetryPolicy> | false,
  onRetry?: (attemptIndex: number, delayMs: number, err: unknown) => void,
): Promise<T> {
  if (policy === false) {
    return attempt();
  }

  let lastError: unknown;

  for (let attemptIndex = 0; attemptIndex <= policy.maxRetries; attemptIndex++) {
    try {
      return await attempt();
    } catch (err) {
      lastError = err;

      // Never retry on the last allowed attempt
      if (attemptIndex >= policy.maxRetries) break;

      const status = getStatusCode(err);
      if (status === undefined || !policy.retryableStatusCodes.includes(status)) {
        // Not a retryable status — propagate immediately
        throw err;
      }

      const retryAfterHeader = getRetryAfterHeader(err);
      const delayMs =
        retryAfterHeader !== undefined
          ? parseRetryAfterMs(retryAfterHeader, attemptIndex, policy)
          : calculateBackoff(attemptIndex, policy);

      onRetry?.(attemptIndex, delayMs, err);

      await sleep(delayMs);
    }
  }

  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
