// Unit tests for services/plugin-cache.ts
//
// Tests: LRU cache hit/miss, SHA-256 verification (pass/fail),
// per-bundle size cap, invalidate (by plugin + tenant, platform-wide),
// prefetch, getBundleStats, fetch error handling.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import type { Logger } from "@oneplatform/core";
import { createPluginBundleCache } from "../services/plugin-cache.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TENANT_ID = "550e8400-e29b-41d4-a716-446655440000";
const PLUGIN_ID = "550e8400-e29b-41d4-a716-446655440001";
const VERSION = "1.0.0";

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

function makeDeps(logger = makeLogger()) {
  return {
    logger,
    pluginServiceUrl: "http://plugin-service:3001",
    serviceTokenSigner: { sign: async () => "secret" },
  };
}

/** Create a valid bundle and its correct sha256 hash */
function makeBundle(content = "console.log('hello');"): {
  bundleBase64: string;
  bundleHash: string;
} {
  const bundleBase64 = Buffer.from(content).toString("base64");
  const hash = createHash("sha256")
    .update(Buffer.from(bundleBase64, "base64"))
    .digest("hex");
  return { bundleBase64, bundleHash: `sha256:${hash}` };
}

function makePluginServiceResponse(
  overrides: Partial<{
    pluginId: string;
    version: string;
    bundleBase64: string;
    bundleHash: string;
    language: string;
  }> = {},
) {
  const { bundleBase64, bundleHash } = makeBundle();
  return {
    data: {
      pluginId: PLUGIN_ID,
      version: VERSION,
      bundleBase64,
      bundleHash,
      language: "js",
      ...overrides,
    },
  };
}

// ---------------------------------------------------------------------------
// Cache miss + successful fetch
// ---------------------------------------------------------------------------

describe("createPluginBundleCache — cache miss and fetch", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a cached bundle on cache miss with valid hash", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue(makePluginServiceResponse()),
    });

    const cache = createPluginBundleCache(makeDeps());
    const result = await cache.get(TENANT_ID, PLUGIN_ID, VERSION);

    expect(result).not.toBeNull();
    expect(result?.pluginId).toBe(PLUGIN_ID);
    expect(result?.tenantId).toBe(TENANT_ID);
    expect(result?.version).toBe(VERSION);
  });

  it("includes bundleSizeBytes and cachedAt in returned entry", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue(makePluginServiceResponse()),
    });

    const cache = createPluginBundleCache(makeDeps());
    const result = await cache.get(TENANT_ID, PLUGIN_ID, VERSION);

    expect(result?.bundleSizeBytes).toBeGreaterThan(0);
    expect(result?.cachedAt).toBeInstanceOf(Date);
  });

  it("calls Plugin Service with correct URL including version", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue(makePluginServiceResponse()),
    });

    const cache = createPluginBundleCache(makeDeps());
    await cache.get(TENANT_ID, PLUGIN_ID, VERSION);

    const callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(callArgs[0]).toContain(`/internal/plugins/${PLUGIN_ID}/bundle`);
    expect(callArgs[0]).toContain(`version=${VERSION}`);
  });

  it("includes X-Service-Token header in Plugin Service request", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue(makePluginServiceResponse()),
    });

    const cache = createPluginBundleCache(makeDeps());
    await cache.get(TENANT_ID, PLUGIN_ID, VERSION);

    const callArgs = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(callArgs[1].headers?.["X-Service-Token"]).toBe("secret");
  });
});

// ---------------------------------------------------------------------------
// SHA-256 hash verification
// ---------------------------------------------------------------------------

describe("createPluginBundleCache — hash verification", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null when bundle hash does not match", async () => {
    const { bundleBase64 } = makeBundle("good content");
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue(
        makePluginServiceResponse({
          bundleBase64,
          bundleHash: "sha256:deadbeef1234567890abcdef", // wrong hash
        }),
      ),
    });

    const logger = makeLogger();
    const cache = createPluginBundleCache({ ...makeDeps(), logger });
    const result = await cache.get(TENANT_ID, PLUGIN_ID, VERSION);

    expect(result).toBeNull();
    expect(logger.error).toHaveBeenCalled();
  });

  it("logs EXECUTION_BUNDLE_INTEGRITY_ERROR on hash mismatch", async () => {
    const { bundleBase64 } = makeBundle("content");
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue(
        makePluginServiceResponse({
          bundleBase64,
          bundleHash: "sha256:wronghash",
        }),
      ),
    });

    const logger = makeLogger();
    const cache = createPluginBundleCache({ ...makeDeps(), logger });
    await cache.get(TENANT_ID, PLUGIN_ID, VERSION);

    const errorCalls = (logger.error as ReturnType<typeof vi.fn>).mock.calls;
    const hasBundleIntegrityLog = errorCalls.some(
      (call) => typeof call[0] === "string" && call[0].includes("EXECUTION_BUNDLE_INTEGRITY_ERROR"),
    );
    expect(hasBundleIntegrityLog).toBe(true);
  });

  it("rejects hash without 'sha256:' prefix", async () => {
    const { bundleBase64 } = makeBundle();
    const rawHash = createHash("sha256")
      .update(Buffer.from(bundleBase64, "base64"))
      .digest("hex");

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue(
        makePluginServiceResponse({
          bundleBase64,
          bundleHash: rawHash, // no 'sha256:' prefix
        }),
      ),
    });

    const cache = createPluginBundleCache(makeDeps());
    const result = await cache.get(TENANT_ID, PLUGIN_ID, VERSION);
    expect(result).toBeNull();
  });

  it("stores bundle in LRU after successful hash verification", async () => {
    const serviceResponse = makePluginServiceResponse();
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue(serviceResponse),
      });

    const cache = createPluginBundleCache(makeDeps());
    await cache.get(TENANT_ID, PLUGIN_ID, VERSION); // first call populates cache

    // Second call should use cache (no second fetch)
    const result = await cache.get(TENANT_ID, PLUGIN_ID, VERSION);
    expect(result).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1); // only one fetch
  });
});

// ---------------------------------------------------------------------------
// Cache hit
// ---------------------------------------------------------------------------

describe("createPluginBundleCache — cache hit", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not call Plugin Service on cache hit", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue(makePluginServiceResponse()),
    });

    const cache = createPluginBundleCache(makeDeps());
    await cache.get(TENANT_ID, PLUGIN_ID, VERSION); // populate
    await cache.get(TENANT_ID, PLUGIN_ID, VERSION); // should hit cache

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("increments hitCount on cache hit", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue(makePluginServiceResponse()),
    });

    const cache = createPluginBundleCache(makeDeps());
    await cache.get(TENANT_ID, PLUGIN_ID, VERSION); // miss
    await cache.get(TENANT_ID, PLUGIN_ID, VERSION); // hit

    const stats = cache.getBundleStats();
    expect(stats.hitCount).toBe(1);
    expect(stats.missCount).toBe(1);
  });

  it("increments missCount on cache miss", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue(makePluginServiceResponse()),
    });

    const cache = createPluginBundleCache(makeDeps());
    await cache.get(TENANT_ID, PLUGIN_ID, VERSION); // miss

    const stats = cache.getBundleStats();
    expect(stats.missCount).toBe(1);
    expect(stats.hitCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Fetch error handling
// ---------------------------------------------------------------------------

describe("createPluginBundleCache — fetch errors", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null when Plugin Service is unreachable (fetch throws)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const cache = createPluginBundleCache(makeDeps());
    const result = await cache.get(TENANT_ID, PLUGIN_ID, VERSION);
    expect(result).toBeNull();
  });

  it("returns null when Plugin Service returns non-200 status", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });

    const cache = createPluginBundleCache(makeDeps());
    const result = await cache.get(TENANT_ID, PLUGIN_ID, VERSION);
    expect(result).toBeNull();
  });

  it("logs warning when Plugin Service request fails", async () => {
    fetchMock.mockRejectedValueOnce(new Error("Connection refused"));

    const logger = makeLogger();
    const cache = createPluginBundleCache({ ...makeDeps(), logger });
    await cache.get(TENANT_ID, PLUGIN_ID, VERSION);

    expect(logger.warn).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// invalidate
// ---------------------------------------------------------------------------

describe("createPluginBundleCache — invalidate", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function populateCache(
    cache: ReturnType<typeof createPluginBundleCache>,
    tenantId: string,
    pluginId: string,
    version: string,
  ): Promise<void> {
    const serviceResponse = makePluginServiceResponse({ pluginId, version });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue(serviceResponse),
    });
    await cache.get(tenantId, pluginId, version);
  }

  it("evicts entries for a specific tenant+plugin", async () => {
    const cache = createPluginBundleCache(makeDeps());
    await populateCache(cache, TENANT_ID, PLUGIN_ID, VERSION);

    cache.invalidate(PLUGIN_ID, TENANT_ID);

    // After eviction, next get should trigger a fetch
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue(makePluginServiceResponse()),
    });
    await cache.get(TENANT_ID, PLUGIN_ID, VERSION);
    expect(fetchMock).toHaveBeenCalledTimes(2); // first populate, then re-fetch
  });

  it("evicts all tenant entries when tenantId is null (platform-wide)", async () => {
    const TENANT_B = "550e8400-e29b-41d4-a716-446655440002";
    const cache = createPluginBundleCache(makeDeps());

    // Populate two tenant entries for same plugin
    await populateCache(cache, TENANT_ID, PLUGIN_ID, VERSION);
    await populateCache(cache, TENANT_B, PLUGIN_ID, VERSION);

    cache.invalidate(PLUGIN_ID, null); // platform-wide

    const stats = cache.getBundleStats();
    expect(stats.currentEntryCount).toBe(0);
  });

  it("evicts all tenant entries when tenantId is undefined (platform-wide)", async () => {
    const cache = createPluginBundleCache(makeDeps());
    await populateCache(cache, TENANT_ID, PLUGIN_ID, VERSION);

    cache.invalidate(PLUGIN_ID, undefined);

    const stats = cache.getBundleStats();
    expect(stats.currentEntryCount).toBe(0);
  });

  it("does not evict entries for a different plugin", async () => {
    const OTHER_PLUGIN = "550e8400-e29b-41d4-a716-446655440099";
    const cache = createPluginBundleCache(makeDeps());
    await populateCache(cache, TENANT_ID, PLUGIN_ID, VERSION);

    cache.invalidate(OTHER_PLUGIN, TENANT_ID); // different plugin

    const stats = cache.getBundleStats();
    expect(stats.currentEntryCount).toBe(1); // original entry still there
  });

  it("logs invalidation info message", async () => {
    const logger = makeLogger();
    const cache = createPluginBundleCache({ ...makeDeps(), logger });
    await populateCache(cache, TENANT_ID, PLUGIN_ID, VERSION);

    cache.invalidate(PLUGIN_ID, TENANT_ID);

    expect(logger.info).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// prefetch
// ---------------------------------------------------------------------------

describe("createPluginBundleCache — prefetch", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns true when entry is already cached (no fetch)", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue(makePluginServiceResponse()),
    });

    const cache = createPluginBundleCache(makeDeps());
    await cache.get(TENANT_ID, PLUGIN_ID, VERSION); // populate

    const result = await cache.prefetch(PLUGIN_ID, TENANT_ID, VERSION);
    expect(result).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1); // no extra fetch
  });

  it("fetches and returns true when entry not in cache", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue(makePluginServiceResponse()),
    });

    const cache = createPluginBundleCache(makeDeps());
    const result = await cache.prefetch(PLUGIN_ID, TENANT_ID, VERSION);
    expect(result).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns false when fetch fails during prefetch", async () => {
    fetchMock.mockRejectedValueOnce(new Error("Network error"));

    const cache = createPluginBundleCache(makeDeps());
    const result = await cache.prefetch(PLUGIN_ID, TENANT_ID, VERSION);
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getBundleStats
// ---------------------------------------------------------------------------

describe("createPluginBundleCache — getBundleStats", () => {
  it("returns zero stats for a fresh cache", () => {
    const cache = createPluginBundleCache(makeDeps());
    const stats = cache.getBundleStats();
    expect(stats.hitCount).toBe(0);
    expect(stats.missCount).toBe(0);
    expect(stats.currentEntryCount).toBe(0);
  });

  it("currentEntryCount reflects number of entries in LRU", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    // Two different plugin/version combos
    const resp1 = makePluginServiceResponse({ version: "1.0.0" });
    const resp2 = makePluginServiceResponse({ version: "2.0.0" });
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: vi.fn().mockResolvedValue(resp1) })
      .mockResolvedValueOnce({ ok: true, json: vi.fn().mockResolvedValue(resp2) });

    const cache = createPluginBundleCache(makeDeps());
    await cache.get(TENANT_ID, PLUGIN_ID, "1.0.0");
    await cache.get(TENANT_ID, PLUGIN_ID, "2.0.0");

    const stats = cache.getBundleStats();
    expect(stats.currentEntryCount).toBe(2);
    expect(stats.missCount).toBe(2);

    vi.restoreAllMocks();
  });
});
