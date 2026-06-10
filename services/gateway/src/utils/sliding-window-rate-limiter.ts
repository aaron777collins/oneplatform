// Sliding-window rate limiter with Redis + in-memory fallback (design §8.2–8.3).
//
// Algorithm (Redis path):
//   Uses two Redis keys per window: the current window counter and the
//   previous window counter. The effective count is interpolated so that
//   window boundaries do not produce the spike artifact of fixed-window
//   algorithms:
//
//     effectiveCount = prev * (1 - elapsedFraction) + current
//
//   A Lua script executes the read-compare-increment atomically in a single
//   round trip, preventing race conditions between concurrent workers.
//
// Fallback (in-memory path):
//   Activated automatically when the Redis client emits an 'error' event.
//   Tracks request timestamps in a capped array per key; entries older than
//   windowMs are shifted out on each check. The per-instance limit is divided
//   by the replica count so the aggregate across all instances approximates
//   the configured limit.

import type { Redis } from "ioredis";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number; // Unix timestamp (seconds)
  policy: string;  // human-readable tier name, e.g. "per-tenant"
}

export interface RateLimiterConfig {
  redis: Redis;
  windowMs: number;
  /**
   * Number of Gateway replicas. Used when computing the per-instance limit
   * for the in-memory fallback path (instanceLimit = floor(limit / replicas)).
   */
  fallbackReplicaCount: number;
}

export interface RateLimiter {
  check(key: string, limit: number, burstMultiplier?: number): Promise<RateLimitResult>;
}

// ---------------------------------------------------------------------------
// Lua script (design §8.2)
//
// KEYS[1] = current window key
// KEYS[2] = previous window key
// ARGV[1] = current window start (ms, as string)
// ARGV[2] = window duration (ms, as string)
// ARGV[3] = effective limit (already multiplied by burst factor, as string)
//
// Returns an array: [allowed (0|1), remaining, reset (Unix seconds)]
//   allowed=0 → denied;  allowed=1 → permitted
// ---------------------------------------------------------------------------

const SLIDING_WINDOW_LUA = `
local current  = tonumber(redis.call('GET', KEYS[1])) or 0
local previous = tonumber(redis.call('GET', KEYS[2])) or 0
local elapsed  = tonumber(ARGV[1]) % tonumber(ARGV[2])
local effective = previous * (1 - elapsed / tonumber(ARGV[2])) + current
if effective >= tonumber(ARGV[3]) then
  return {0, math.floor(effective), -1}
end
redis.call('INCR', KEYS[1])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]) * 2)
local remaining = tonumber(ARGV[3]) - math.floor(effective) - 1
local reset = math.floor((tonumber(ARGV[1]) + tonumber(ARGV[2])) / 1000)
return {1, remaining, reset}
`.trim();

// ---------------------------------------------------------------------------
// In-memory fallback window
// ---------------------------------------------------------------------------

interface InMemoryWindow {
  // Sorted array of request timestamps (ms). Entries older than windowMs are
  // pruned on each check to bound memory usage.
  timestamps: number[];
}

const inMemoryWindows = new Map<string, InMemoryWindow>();

function inMemoryCheck(
  key: string,
  instanceLimit: number,
  windowMs: number
): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  const windowStart = now - windowMs;

  let window = inMemoryWindows.get(key);
  if (window === undefined) {
    window = { timestamps: [] };
    inMemoryWindows.set(key, window);
  }

  // Remove timestamps outside the current window.
  // Using a while loop instead of filter to mutate in place and avoid GC churn.
  while (window.timestamps.length > 0 && (window.timestamps[0] ?? 0) <= windowStart) {
    window.timestamps.shift();
  }

  const count = window.timestamps.length;
  const resetAt = Math.floor((now + windowMs) / 1000);

  if (count >= instanceLimit) {
    return { allowed: false, remaining: 0, resetAt };
  }

  window.timestamps.push(now);
  return { allowed: true, remaining: instanceLimit - count - 1, resetAt };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSlidingWindowLimiter(config: RateLimiterConfig): RateLimiter {
  const { redis, windowMs, fallbackReplicaCount } = config;

  let redisHealthy = true;

  // Listen for Redis errors to activate the in-memory fallback. The client
  // will continue to emit 'error' while unhealthy; on reconnect the Redis
  // commands will succeed again and we flip back automatically.
  redis.on("error", () => {
    redisHealthy = false;
  });

  // Re-enable Redis path on successful reconnect.
  redis.on("ready", () => {
    redisHealthy = true;
  });

  async function check(
    key: string,
    limit: number,
    burstMultiplier = 1
  ): Promise<RateLimitResult> {
    const effectiveLimit = Math.floor(limit * burstMultiplier);

    // In-memory fallback when Redis is unreachable.
    if (!redisHealthy) {
      const replicaCount = Math.max(1, fallbackReplicaCount);
      const instanceLimit = Math.floor(effectiveLimit / replicaCount);
      const result = inMemoryCheck(key, instanceLimit, windowMs);
      return {
        ...result,
        policy: "in-memory-fallback",
      };
    }

    const now = Date.now();
    const windowStart = Math.floor(now / windowMs) * windowMs;
    const prevWindowStart = windowStart - windowMs;

    const currentKey = `${key}:${windowStart}`;
    const prevKey = `${key}:${prevWindowStart}`;

    try {
      // The Lua script returns [allowed, remaining, reset] as a Redis array.
      // ioredis types eval() as returning unknown so we cast after the await.
      const raw = await redis.eval(
        SLIDING_WINDOW_LUA,
        2,
        currentKey,
        prevKey,
        String(now),
        String(windowMs),
        String(effectiveLimit)
      );
      const result = raw as [number, number, number];

      const [allowed, remaining, resetAt] = result;

      return {
        allowed: allowed === 1,
        remaining: Math.max(0, remaining),
        resetAt: resetAt > 0 ? resetAt : Math.floor((now + windowMs) / 1000),
        policy: "redis-sliding-window",
      };
    } catch {
      // Redis command failed (e.g., during an outage that hasn't triggered the
      // 'error' event yet). Drop to in-memory fallback for this request.
      redisHealthy = false;
      const replicaCount = Math.max(1, fallbackReplicaCount);
      const instanceLimit = Math.floor(effectiveLimit / replicaCount);
      const fallbackResult = inMemoryCheck(key, instanceLimit, windowMs);
      return {
        ...fallbackResult,
        policy: "in-memory-fallback",
      };
    }
  }

  return { check };
}
