/**
 * Unit tests for the retry handler.
 * Covers: backoff calculation, Retry-After parsing, retry count limits, non-retryable pass-through.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  calculateBackoff,
  parseRetryAfterMs,
  resolveRetryPolicy,
  withRetry,
  DEFAULT_RETRY_POLICY,
} from '../../src/retry/retry-handler.js';

describe('calculateBackoff', () => {
  const policy = { ...DEFAULT_RETRY_POLICY, jitter: false } as const;

  it('doubles the initial delay per attempt', () => {
    expect(calculateBackoff(0, policy)).toBe(500);
    expect(calculateBackoff(1, policy)).toBe(1000);
    expect(calculateBackoff(2, policy)).toBe(2000);
    expect(calculateBackoff(3, policy)).toBe(4000);
  });

  it('caps at maxDelayMs', () => {
    const cappedPolicy = { ...policy, maxDelayMs: 1000 };
    expect(calculateBackoff(10, cappedPolicy)).toBe(1000);
  });

  it('applies jitter within ±25% range', () => {
    const jitterPolicy = { ...policy, jitter: true } as const;
    const delay = calculateBackoff(0, jitterPolicy); // base 500ms
    expect(delay).toBeGreaterThanOrEqual(375); // 500 * 0.75
    expect(delay).toBeLessThanOrEqual(625); // 500 * 1.25
  });
});

describe('parseRetryAfterMs', () => {
  const policy = { ...DEFAULT_RETRY_POLICY, jitter: false } as const;

  it('parses integer seconds', () => {
    expect(parseRetryAfterMs('30', 0, policy)).toBe(30_000);
  });

  it('parses HTTP-date and returns ms until that date', () => {
    const future = new Date(Date.now() + 5000);
    const result = parseRetryAfterMs(future.toUTCString(), 0, policy);
    // Allow 500ms tolerance for timing
    expect(result).toBeGreaterThanOrEqual(4_000);
    expect(result).toBeLessThanOrEqual(6_000);
  });

  it('caps result at maxDelayMs', () => {
    expect(parseRetryAfterMs('99999', 0, policy)).toBe(policy.maxDelayMs);
  });

  it('falls back to backoff on unparseable header', () => {
    const result = parseRetryAfterMs('not-a-date', 0, policy);
    expect(result).toBe(500); // calculateBackoff(0, policy) with no jitter
  });
});

describe('resolveRetryPolicy', () => {
  it('returns false when false is passed', () => {
    expect(resolveRetryPolicy(false)).toBe(false);
  });

  it('returns defaults when undefined is passed', () => {
    const resolved = resolveRetryPolicy(undefined);
    expect(resolved).not.toBe(false);
    if (resolved !== false) {
      expect(resolved.maxRetries).toBe(3);
      expect(resolved.initialDelayMs).toBe(500);
      expect(resolved.jitter).toBe(true);
    }
  });

  it('merges partial policy with defaults', () => {
    const resolved = resolveRetryPolicy({ maxRetries: 5 });
    expect(resolved).not.toBe(false);
    if (resolved !== false) {
      expect(resolved.maxRetries).toBe(5);
      expect(resolved.initialDelayMs).toBe(DEFAULT_RETRY_POLICY.initialDelayMs);
    }
  });
});

describe('withRetry', () => {
  it('returns immediately on success', async () => {
    const attempt = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(attempt, () => undefined, () => undefined, resolveRetryPolicy());
    expect(result).toBe('ok');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('retries on retryable status codes', async () => {
    const err = Object.assign(new Error('server error'), { statusCode: 500 });
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(err)
      .mockRejectedValueOnce(err)
      .mockResolvedValue('ok');

    const result = await withRetry(
      attempt,
      (e) => (e as { statusCode?: number }).statusCode,
      () => undefined,
      // Use a policy with 0ms delays to make tests fast
      { maxRetries: 3, initialDelayMs: 0, maxDelayMs: 0, retryableStatusCodes: [500], jitter: false },
    );
    expect(result).toBe('ok');
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it('throws immediately on non-retryable status', async () => {
    const err = Object.assign(new Error('not found'), { statusCode: 404 });
    const attempt = vi.fn().mockRejectedValue(err);

    await expect(
      withRetry(
        attempt,
        (e) => (e as { statusCode?: number }).statusCode,
        () => undefined,
        { maxRetries: 3, initialDelayMs: 0, maxDelayMs: 0, retryableStatusCodes: [500], jitter: false },
      ),
    ).rejects.toBe(err);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('exhausts retries and throws the last error', async () => {
    const err = Object.assign(new Error('always fails'), { statusCode: 503 });
    const attempt = vi.fn().mockRejectedValue(err);

    await expect(
      withRetry(
        attempt,
        (e) => (e as { statusCode?: number }).statusCode,
        () => undefined,
        { maxRetries: 2, initialDelayMs: 0, maxDelayMs: 0, retryableStatusCodes: [503], jitter: false },
      ),
    ).rejects.toBe(err);
    expect(attempt).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('skips retry when policy is false', async () => {
    const err = Object.assign(new Error('fails'), { statusCode: 500 });
    const attempt = vi.fn().mockRejectedValue(err);

    await expect(
      withRetry(attempt, () => 500, () => undefined, false),
    ).rejects.toBe(err);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('calls onRetry callback with attempt index and delay', async () => {
    const err = Object.assign(new Error('fail'), { statusCode: 500 });
    const attempt = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('ok');
    const onRetry = vi.fn();

    await withRetry(
      attempt,
      (e) => (e as { statusCode?: number }).statusCode,
      () => undefined,
      { maxRetries: 2, initialDelayMs: 0, maxDelayMs: 0, retryableStatusCodes: [500], jitter: false },
      onRetry,
    );

    expect(onRetry).toHaveBeenCalledWith(0, 0, err);
  });
});
