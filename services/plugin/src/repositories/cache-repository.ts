import { Redis } from "ioredis";

// ---------------------------------------------------------------------------
// CacheRepository — Redis-backed plugin cache for the plugin cache API
//
// Redis key format: plugin:cache:{tenantId}:{pluginId}:{key}
// This scoping ensures cross-tenant and cross-plugin isolation.
// The Plugin Service Redis ACL covers ~plugin:* keys (ADR-5, spec §8.4).
// ---------------------------------------------------------------------------

export class CacheRepository {
  constructor(private readonly redis: Redis) {}

  private buildKey(tenantId: string, pluginId: string, key: string): string {
    return `plugin:cache:${tenantId}:${pluginId}:${key}`;
  }

  async get(tenantId: string, pluginId: string, key: string): Promise<unknown | null> {
    const redisKey = this.buildKey(tenantId, pluginId, key);
    const raw = await this.redis.get(redisKey);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      // If stored value is not JSON (should not happen with our PUT logic), return as string.
      return raw;
    }
  }

  async set(
    tenantId: string,
    pluginId: string,
    key: string,
    value: unknown,
    ttlSeconds: number
  ): Promise<void> {
    const redisKey = this.buildKey(tenantId, pluginId, key);
    await this.redis.setex(redisKey, ttlSeconds, JSON.stringify(value));
  }

  async delete(tenantId: string, pluginId: string, key: string): Promise<boolean> {
    const redisKey = this.buildKey(tenantId, pluginId, key);
    const deleted = await this.redis.del(redisKey);
    return deleted > 0;
  }
}
