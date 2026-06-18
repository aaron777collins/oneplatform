/**
 * Gateway tenant IP allowlist service.
 *
 * WHY query the auth DB directly (not via the auth service API):
 *   The gateway is a hot path — every request passes through it. Making an
 *   HTTP round-trip to the auth service on every request would double the
 *   latency. The gateway already shares the same PostgreSQL cluster and holds
 *   read credentials, so a direct parameterised query is the right trade-off.
 *
 * The result is cached with a short TTL so changes (adding/removing IPs) take
 * effect within the configured window without hammering the database.
 */

import type pg from "pg";
import type { Logger } from "@oneplatform/core";

// Row shape returned by the auth.tenants query.
interface TenantAllowlistRow {
  ip_allowlist: string[];
}

interface CacheEntry {
  allowlist: string[];
  expiresAt: number; // epoch ms
}

export interface TenantAllowlistServiceConfig {
  db: pg.Pool;
  logger: Logger;
  /**
   * How long to cache a tenant's allowlist result in milliseconds.
   * Defaults to 30 seconds. Shorter means faster propagation of changes;
   * longer means fewer DB hits under high traffic.
   */
  cacheTtlMs?: number;
}

export interface TenantAllowlistService {
  /**
   * Return the IP allowlist for a tenant.
   * Returns an empty array when the tenant has no allowlist configured
   * (allow all) or when the tenant cannot be found.
   */
  getAllowlist(tenantId: string): Promise<string[]>;
}

export function createTenantAllowlistService(
  config: TenantAllowlistServiceConfig,
): TenantAllowlistService {
  const { db, logger } = config;
  const cacheTtlMs = config.cacheTtlMs ?? 30_000;

  // In-memory LRU-style cache. A Map preserves insertion order, so we can
  // evict the oldest entry when the cache grows beyond a safe bound.
  const cache = new Map<string, CacheEntry>();
  const MAX_CACHE_ENTRIES = 5_000;

  function evictStale(): void {
    const now = Date.now();
    for (const [key, entry] of cache) {
      if (entry.expiresAt <= now) {
        cache.delete(key);
      }
    }
    // Hard cap: evict oldest entries when we're over the limit after TTL eviction
    if (cache.size > MAX_CACHE_ENTRIES) {
      const toEvict = cache.size - MAX_CACHE_ENTRIES;
      let i = 0;
      for (const key of cache.keys()) {
        cache.delete(key);
        if (++i >= toEvict) break;
      }
    }
  }

  async function getAllowlist(tenantId: string): Promise<string[]> {
    const cached = cache.get(tenantId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.allowlist;
    }

    try {
      const result = await db.query<TenantAllowlistRow>(
        `SELECT ip_allowlist
           FROM auth.tenants
          WHERE id = $1
            AND deleted_at IS NULL`,
        [tenantId],
      );

      const row = result.rows[0];
      // Absent tenant or empty JSONB → allow all (empty array)
      const allowlist: string[] = row?.ip_allowlist ?? [];

      evictStale();
      cache.set(tenantId, { allowlist, expiresAt: Date.now() + cacheTtlMs });
      return allowlist;
    } catch (err) {
      // Log and fail open: if the DB is unreachable, don't block all traffic.
      // This is a conscious trade-off — availability beats security under DB
      // failure because the auth middleware already enforced authentication.
      // A separate alert should fire when the DB is unreachable.
      logger.error("TenantAllowlistService: failed to query allowlist — failing open", {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  return { getAllowlist };
}
