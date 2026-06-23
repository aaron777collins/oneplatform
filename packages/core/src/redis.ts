import { Redis } from "ioredis";
import type { Redis as RedisType } from "ioredis";

/** Configuration for {@link createRedisClient}. */
export interface RedisClientConfig {
  /** Redis connection URL (e.g. `redis://host:6379`). */
  url: string;
  /**
   * Maximum number of retries per command before the command is rejected.
   * Defaults to 3. Set to `null` to retry indefinitely (not recommended).
   */
  maxRetriesPerRequest?: number;
}

// Exponential backoff capped at 30 s; gives up after 10 attempts so callers
// surface a hard failure rather than retrying indefinitely during an outage.
function retryStrategy(times: number): number | null {
  if (times > 10) {
    return null;
  }
  return Math.min(100 * Math.pow(2, times), 30_000);
}

/**
 * Creates an ioredis `Redis` client configured for OnePlatform services.
 *
 * Uses `lazyConnect` so startup succeeds even when Redis is momentarily
 * unavailable. Reconnects with exponential backoff capped at 30 s, giving
 * up after 10 consecutive failures to surface hard outages quickly.
 *
 * @param config - Redis URL and optional per-command retry limit.
 */
export function createRedisClient(config: RedisClientConfig): RedisType {
  return new Redis(config.url, {
    // lazyConnect defers the TCP handshake until the first command, which lets
    // service startup succeed even when Redis is momentarily unavailable.
    lazyConnect: true,
    maxRetriesPerRequest: config.maxRetriesPerRequest ?? 3,
    retryStrategy,
    keepAlive: 10_000,
    enableOfflineQueue: true,
    connectionName: process.env["SERVICE_NAME"] ?? "op-service",
  });
}

/** BullMQ-compatible ioredis connection options parsed from a Redis URL. */
export interface BullmqConnectionOptions {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db?: number;
  maxRetriesPerRequest: null;
}

/**
 * Parses a `redis://user:pass@host:port/db` URL into BullMQ-compatible ioredis
 * connection options.
 *
 * BullMQ's `connection` option takes ioredis `RedisOptions`, which has NO `url`
 * field — passing `{ url }` silently falls back to localhost:6379 with no auth
 * (ioredis ignores the unknown key). BullMQ also mandates
 * `maxRetriesPerRequest: null` because its blocking commands (BRPOPLPUSH etc.)
 * must never be aborted mid-wait. This helper produces the correct shape.
 */
export function bullmqConnection(url: string): BullmqConnectionOptions {
  const parsed = new URL(url);
  const opts: BullmqConnectionOptions = {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 6379,
    maxRetriesPerRequest: null,
  };
  if (parsed.username) opts.username = decodeURIComponent(parsed.username);
  if (parsed.password) opts.password = decodeURIComponent(parsed.password);
  const dbPath = parsed.pathname.replace(/^\//, "");
  if (dbPath) opts.db = Number(dbPath);
  return opts;
}
