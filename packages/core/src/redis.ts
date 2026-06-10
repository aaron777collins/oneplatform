import { Redis } from "ioredis";
import type { Redis as RedisType } from "ioredis";

export interface RedisClientConfig {
  url: string;
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
