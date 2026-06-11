import { createHash } from "node:crypto";
import { LRUCache } from "lru-cache";
import type { Logger } from "@oneplatform/core";

// ---------------------------------------------------------------------------
// PluginBundleCache — in-process LRU cache for compiled plugin bundles
// Design spec §10.2
//
// Cache key: "${tenantId}:${pluginId}:${version}" — version is included so
// deploying a new bundle automatically bypasses the stale entry.  Old entries
// expire after 1 hour.
//
// Hash verification: every bundle fetched from Plugin Service has its SHA-256
// verified before the entry is stored. A mismatch rejects the bundle and
// logs EXECUTION_BUNDLE_INTEGRITY_ERROR.
// ---------------------------------------------------------------------------

export interface CachedBundle {
  pluginId: string;
  tenantId: string;
  version: string;
  bundleBase64: string;
  bundleHash: string; // "sha256:<hex>" as returned by Plugin Service
  bundleSizeBytes: number;
  cachedAt: Date;
}

export interface BundleStats {
  hitCount: number;
  missCount: number;
  currentEntryCount: number;
}

export interface PluginBundleCache {
  get(tenantId: string, pluginId: string, version: string): Promise<CachedBundle | null>;
  invalidate(pluginId: string, tenantId?: string | null): void;
  prefetch(pluginId: string, tenantId: string, version: string): Promise<boolean>;
  getBundleStats(): BundleStats;
}

export interface PluginBundleCacheDeps {
  logger: Logger;
  /** Base URL of the Plugin Service for bundle fetches */
  pluginServiceUrl: string;
  /** Service token added to outbound Plugin Service requests */
  serviceToken: string;
}

// Cache configuration — design spec §10.2 table
const MAX_ENTRIES = 100;
const TTL_MS = 3_600_000;        // 1 hour
const MAX_BUNDLE_BYTES = 10 * 1024 * 1024;  // 10 MB per entry
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;  // 200 MB total

export function createPluginBundleCache(deps: PluginBundleCacheDeps): PluginBundleCache {
  const { logger, pluginServiceUrl, serviceToken } = deps;

  let hitCount = 0;
  let missCount = 0;

  const lru = new LRUCache<string, CachedBundle>({
    max: MAX_ENTRIES,
    ttl: TTL_MS,
    // sizeCalculation lets lru-cache enforce the 200 MB total cap
    sizeCalculation: (entry) => entry.bundleSizeBytes,
    maxSize: MAX_TOTAL_BYTES,
  });

  function cacheKey(tenantId: string, pluginId: string, version: string): string {
    return `${tenantId}:${pluginId}:${version}`;
  }

  // ---------------------------------------------------------------------------
  // Bundle hash verification — spec §10.2
  // ---------------------------------------------------------------------------

  function verifyBundleHash(
    bundleBase64: string,
    expectedHash: string,
  ): boolean {
    // expectedHash format: "sha256:<hex>"
    const prefix = "sha256:";
    if (!expectedHash.startsWith(prefix)) return false;
    const expected = expectedHash.slice(prefix.length);

    const bundleBytes = Buffer.from(bundleBase64, "base64");
    const actual = createHash("sha256").update(bundleBytes).digest("hex");

    return actual === expected;
  }

  // ---------------------------------------------------------------------------
  // Fetch from Plugin Service — called on cache miss
  // ---------------------------------------------------------------------------

  async function fetchFromPluginService(
    pluginId: string,
    version: string,
  ): Promise<{
    bundleBase64: string;
    bundleHash: string;
    version: string;
    language: string;
  } | null> {
    const url = version
      ? `${pluginServiceUrl}/internal/plugins/${encodeURIComponent(pluginId)}/bundle?version=${encodeURIComponent(version)}`
      : `${pluginServiceUrl}/internal/plugins/${encodeURIComponent(pluginId)}/bundle`;

    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          "X-Service-Token": serviceToken,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      logger.warn("PluginBundleCache: Plugin Service request failed", {
        pluginId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }

    if (!response.ok) {
      logger.warn("PluginBundleCache: Plugin Service returned non-200", {
        pluginId,
        status: response.status,
      });
      return null;
    }

    const body = await response.json() as {
      data: {
        pluginId: string;
        version: string;
        bundleHash: string;
        bundleBase64: string;
        language: string;
      };
    };

    return {
      bundleBase64: body.data.bundleBase64,
      bundleHash: body.data.bundleHash,
      version: body.data.version,
      language: body.data.language,
    };
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async function get(
    tenantId: string,
    pluginId: string,
    version: string,
  ): Promise<CachedBundle | null> {
    const key = cacheKey(tenantId, pluginId, version);
    const cached = lru.get(key);

    if (cached !== undefined) {
      hitCount++;
      return cached;
    }

    missCount++;
    const fetched = await fetchFromPluginService(pluginId, version);
    if (fetched === null) return null;

    if (!verifyBundleHash(fetched.bundleBase64, fetched.bundleHash)) {
      logger.error("PluginBundleCache: bundle hash mismatch — rejecting bundle", {
        pluginId,
        version: fetched.version,
        expectedHash: fetched.bundleHash,
      });
      // Log EXECUTION_BUNDLE_INTEGRITY_ERROR per spec §10.2
      logger.error("EXECUTION_BUNDLE_INTEGRITY_ERROR", { pluginId, version: fetched.version });
      return null;
    }

    const bundleSizeBytes = Buffer.byteLength(fetched.bundleBase64, "base64");
    if (bundleSizeBytes > MAX_BUNDLE_BYTES) {
      logger.warn("PluginBundleCache: bundle exceeds per-entry size limit — not caching", {
        pluginId,
        bundleSizeBytes,
        limit: MAX_BUNDLE_BYTES,
      });
    }

    const entry: CachedBundle = {
      pluginId,
      tenantId,
      version: fetched.version,
      bundleBase64: fetched.bundleBase64,
      bundleHash: fetched.bundleHash,
      bundleSizeBytes,
      cachedAt: new Date(),
    };

    if (bundleSizeBytes <= MAX_BUNDLE_BYTES) {
      lru.set(key, entry);
    }

    return entry;
  }

  function invalidate(pluginId: string, tenantId?: string | null): void {
    // lru-cache does not support partial iteration over keys without forEachEntry,
    // but its forEach method does work for eviction.
    const keysToDelete: string[] = [];
    lru.forEach((_entry, key) => {
      const parts = key.split(":");
      // key format: "<tenantId>:<pluginId>:<version>"
      // tenantId may contain hyphens (UUID) but not colons, so split at first two colons
      const keyPluginId = parts[1];
      const keyTenantId = parts[0];

      if (keyPluginId !== pluginId) return;
      if (tenantId !== undefined && tenantId !== null && keyTenantId !== tenantId) return;

      keysToDelete.push(key);
    });

    for (const key of keysToDelete) {
      lru.delete(key);
    }

    logger.info("PluginBundleCache: invalidated entries", {
      pluginId,
      ...(tenantId !== undefined && tenantId !== null ? { tenantId } : {}),
      evictedCount: keysToDelete.length,
    });
  }

  async function prefetch(
    pluginId: string,
    tenantId: string,
    version: string,
  ): Promise<boolean> {
    const key = cacheKey(tenantId, pluginId, version);
    if (lru.has(key)) return true; // Already cached

    const entry = await get(tenantId, pluginId, version);
    return entry !== null;
  }

  function getBundleStats(): BundleStats {
    return {
      hitCount,
      missCount,
      currentEntryCount: lru.size,
    };
  }

  return { get, invalidate, prefetch, getBundleStats };
}
