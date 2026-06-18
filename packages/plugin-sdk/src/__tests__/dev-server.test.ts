/**
 * Tests for the dev-server module.
 *
 * We test each layer independently:
 *   - createDevContext  — behaviour of each sub-accessor
 *   - connector-runner  — lifecycle orchestration, timing, error capture
 *   - formatter         — pure formatting helpers (non-TTY mode, no color codes)
 *   - PluginDevServer   — integration: load plugin stub → run → summary
 *
 * We do NOT test plugin-loader's dynamic import path here because that would
 * require writing real bundle files to disk. The CLI integration tests cover that.
 * Instead, we test loadPlugin's error paths (missing manifest, invalid manifest).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createDevContext } from "../dev-server/dev-context.js";
import { runConnectorLifecycle } from "../dev-server/connector-runner.js";
import { PluginLoadError } from "../dev-server/plugin-loader.js";
import type { ConnectorExport, DevServerOptions } from "../dev-server/types.js";
import type { ConnectorHandle, BatchResult } from "../types/connector.js";
import type { PluginManifest } from "../manifest/schema.js";
import { PluginAuthError } from "../types/errors.js";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const STUB_MANIFEST: PluginManifest = {
  manifestVersion: "1",
  id: "com.example.test-connector",
  name: "Test Connector",
  version: "0.1.0",
  type: "connector",
  description: "A test connector plugin for dev server tests",
  author: "test-author",
  minPlatformVersion: "1.0.0",
  entrypoint: "TestConnector",
  configSchema: {},
  hooks: [],
  requiredExternalUrls: [],
  requiredApis: [],
  requiredCredentials: [],
  bundleChecksum: "a".repeat(64),
  license: "MIT",
};

/** Build a minimal ConnectorExport that completes a single-page fetch. */
function buildConnector(overrides: Partial<ConnectorExport> = {}): ConnectorExport {
  return {
    metadata() {
      return {
        type: "connector",
        id: STUB_MANIFEST.id,
        name: STUB_MANIFEST.name,
        description: STUB_MANIFEST.description,
        version: STUB_MANIFEST.version,
        author: STUB_MANIFEST.author,
        category: "other",
        outputSchema: {},
        configSchema: {},
        supportsIncremental: false,
        supportsRealtime: false,
      };
    },
    async connect(_config, _ctx): Promise<ConnectorHandle> {
      return { connectionId: "conn-001", metadata: { url: "https://api.test" } };
    },
    async fetchBatch(_handle, _cursor, _ctx): Promise<BatchResult> {
      return {
        records: [
          { sourceId: "r-001", data: { id: "r-001", name: "Alice" } },
          { sourceId: "r-002", data: { id: "r-002", name: "Bob" } },
        ],
        nextCursor: null,
        hasMore: false,
        fetchedAt: new Date().toISOString(),
      };
    },
    async disconnect(_handle, _ctx): Promise<void> {
      // no-op
    },
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// createDevContext
// ─────────────────────────────────────────────────────────────────────────────

describe("createDevContext", () => {
  describe("defaults", () => {
    it("uses dev-tenant and dev-instance as defaults", () => {
      const ctx = createDevContext();
      expect(ctx.tenant.tenantId).toBe("dev-tenant");
      expect(ctx.tenant.instanceId).toBe("dev-instance");
    });

    it("accepts caller-provided tenant and instance IDs", () => {
      const ctx = createDevContext({ tenantId: "my-tenant", instanceId: "my-instance" });
      expect(ctx.tenant.tenantId).toBe("my-tenant");
      expect(ctx.tenant.instanceId).toBe("my-instance");
    });

    it("starts with empty logs", () => {
      const ctx = createDevContext();
      expect(ctx.__logs).toHaveLength(0);
    });
  });

  describe("credentials", () => {
    it("returns a provided credential value", async () => {
      const ctx = createDevContext({ credentials: { apiKey: "secret-xyz" } });
      await expect(ctx.credentials.get("apiKey")).resolves.toBe("secret-xyz");
    });

    it("throws PluginAuthError for a missing credential", async () => {
      const ctx = createDevContext({ credentials: {} });
      await expect(ctx.credentials.get("missing")).rejects.toBeInstanceOf(PluginAuthError);
    });

    it("PluginAuthError message names the missing credential", async () => {
      const ctx = createDevContext({ credentials: {} });
      await expect(ctx.credentials.get("apiKey")).rejects.toThrow(/apiKey/);
    });

    it("lists available credentials", async () => {
      const ctx = createDevContext({ credentials: { a: "1", b: "2" } });
      const names = await ctx.credentials.list();
      expect(names).toContain("a");
      expect(names).toContain("b");
    });
  });

  describe("fetch — mock mode", () => {
    it("returns 200 with empty object when no mockData is configured", async () => {
      const ctx = createDevContext();
      const res = await ctx.fetch.fetch("https://api.example.com/items");
      expect(res.status).toBe(200);
      const body = await res.json() as unknown;
      expect(body).toEqual({});
    });

    it("matches mockData by URL substring", async () => {
      const ctx = createDevContext({
        mockData: { "api.example.com/items": { items: ["a", "b"] } },
      });
      const res = await ctx.fetch.fetch("https://api.example.com/items?page=1");
      expect(res.status).toBe(200);
      const body = await res.json() as { items: string[] };
      expect(body.items).toEqual(["a", "b"]);
    });

    it("uses first matching mockData entry when multiple could match", async () => {
      const ctx = createDevContext({
        mockData: {
          "api.example.com/items": { source: "items" },
          "api.example.com":       { source: "root" },
        },
      });
      const res = await ctx.fetch.fetch("https://api.example.com/items");
      const body = await res.json() as { source: string };
      // Items pattern appears first in object insertion order
      expect(body.source).toBe("items");
    });
  });

  describe("cache", () => {
    it("returns null for a cache miss", async () => {
      const ctx = createDevContext();
      const val = await ctx.cache.get<string>("missing-key");
      expect(val).toBeNull();
    });

    it("stores and retrieves a value", async () => {
      const ctx = createDevContext();
      await ctx.cache.set("token", "bearer-abc");
      const val = await ctx.cache.get<string>("token");
      expect(val).toBe("bearer-abc");
    });

    it("deletes a value", async () => {
      const ctx = createDevContext();
      await ctx.cache.set("key", "value");
      await ctx.cache.delete("key");
      const val = await ctx.cache.get<string>("key");
      expect(val).toBeNull();
    });

    it("lock always succeeds and release is a no-op", async () => {
      const ctx = createDevContext();
      const lock = await ctx.cache.lock("my-lock", 10);
      expect(lock).not.toBeNull();
      // Should not throw
      await lock!.release();
    });
  });

  describe("logger", () => {
    it("captures log entries in __logs", () => {
      const ctx = createDevContext();
      ctx.logger.info("hello world");
      ctx.logger.warn("watch out");
      expect(ctx.__logs).toHaveLength(2);
      expect(ctx.__logs[0]).toMatchObject({ level: "info", message: "hello world" });
      expect(ctx.__logs[1]).toMatchObject({ level: "warn", message: "watch out" });
    });

    it("captures metadata when provided", () => {
      const ctx = createDevContext();
      ctx.logger.error("oops", { code: "E001" });
      expect(ctx.__logs[0]).toMatchObject({
        level: "error",
        message: "oops",
        metadata: { code: "E001" },
      });
    });

    it("does not include metadata key when metadata is absent", () => {
      const ctx = createDevContext();
      ctx.logger.debug("no meta");
      const entry = ctx.__logs[0]!;
      expect("metadata" in entry).toBe(false);
    });
  });

  describe("ontology", () => {
    it("getSchema returns an empty schema", async () => {
      const ctx = createDevContext();
      const schema = await ctx.ontology.getSchema();
      expect(schema.entityTypes).toHaveLength(0);
    });

    it("getEntitySchema returns null for unknown types", async () => {
      const ctx = createDevContext();
      const schema = await ctx.ontology.getEntitySchema("Contact");
      expect(schema).toBeNull();
    });
  });

  describe("tracing", () => {
    it("injectHeaders adds a traceparent header", () => {
      const ctx = createDevContext();
      const headers = ctx.tracing.injectHeaders({ "Content-Type": "application/json" });
      expect(headers["traceparent"]).toBeDefined();
      expect(headers["Content-Type"]).toBe("application/json");
    });

    it("startSpan returns a handle that can setAttribute and end", () => {
      const ctx = createDevContext();
      const span = ctx.tracing.startSpan("test-span");
      // Should not throw
      span.setAttribute("count", 42);
      span.end();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// runConnectorLifecycle
// ─────────────────────────────────────────────────────────────────────────────

describe("runConnectorLifecycle", () => {
  function makeContext() {
    return createDevContext({ credentials: { apiKey: "test-key" } });
  }

  const defaultOptions: DevServerOptions = {};

  it("returns success=true for a well-behaved connector", async () => {
    const ctx = makeContext();
    const summary = await runConnectorLifecycle(buildConnector(), STUB_MANIFEST, ctx, defaultOptions);
    expect(summary.success).toBe(true);
  });

  it("counts total records fetched", async () => {
    const ctx = makeContext();
    const summary = await runConnectorLifecycle(buildConnector(), STUB_MANIFEST, ctx, defaultOptions);
    expect(summary.totalRecords).toBe(2);
  });

  it("records exactly one batch for a single-page connector", async () => {
    const ctx = makeContext();
    const summary = await runConnectorLifecycle(buildConnector(), STUB_MANIFEST, ctx, defaultOptions);
    expect(summary.batches).toHaveLength(1);
  });

  it("includes timings for metadata, connect, fetchBatch, disconnect", async () => {
    const ctx = makeContext();
    const summary = await runConnectorLifecycle(buildConnector(), STUB_MANIFEST, ctx, defaultOptions);
    const methods = summary.timings.map((t) => t.method);
    expect(methods).toContain("metadata");
    expect(methods).toContain("connect");
    expect(methods).toContain("fetchBatch");
    expect(methods).toContain("disconnect");
  });

  it("all timing durations are non-negative", async () => {
    const ctx = makeContext();
    const summary = await runConnectorLifecycle(buildConnector(), STUB_MANIFEST, ctx, defaultOptions);
    for (const t of summary.timings) {
      expect(t.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("follows the cursor for multi-page connectors", async () => {
    let page = 0;
    const connector = buildConnector({
      async fetchBatch(_handle, _cursor, _ctx): Promise<BatchResult> {
        page++;
        return {
          records: [{ sourceId: `r-p${page}`, data: { page } }],
          nextCursor: page < 3 ? `page-${page + 1}` : null,
          hasMore: page < 3,
          fetchedAt: new Date().toISOString(),
        };
      },
    });

    const ctx = makeContext();
    const summary = await runConnectorLifecycle(connector, STUB_MANIFEST, ctx, defaultOptions);
    expect(summary.batches).toHaveLength(3);
    expect(summary.totalRecords).toBe(3);
  });

  it("respects maxBatches option", async () => {
    let fetchCount = 0;
    const connector = buildConnector({
      async fetchBatch(): Promise<BatchResult> {
        fetchCount++;
        return {
          records: [{ sourceId: `r-${fetchCount}`, data: {} }],
          nextCursor: "always-more",
          hasMore: true,
          fetchedAt: new Date().toISOString(),
        };
      },
    });

    const ctx = makeContext();
    const summary = await runConnectorLifecycle(connector, STUB_MANIFEST, ctx, { maxBatches: 5 });
    expect(summary.batches.length).toBeLessThanOrEqual(5);
  });

  it("captures connect() errors and returns success=false", async () => {
    const connector = buildConnector({
      async connect(): Promise<ConnectorHandle> {
        throw new Error("Connection refused by test");
      },
    });

    const ctx = makeContext();
    const summary = await runConnectorLifecycle(connector, STUB_MANIFEST, ctx, defaultOptions);
    expect(summary.success).toBe(false);
    expect(summary.error?.message).toContain("Connection refused by test");
  });

  it("captures fetchBatch() errors and returns success=false", async () => {
    const connector = buildConnector({
      async fetchBatch(): Promise<BatchResult> {
        throw new Error("API rate limited");
      },
    });

    const ctx = makeContext();
    const summary = await runConnectorLifecycle(connector, STUB_MANIFEST, ctx, defaultOptions);
    expect(summary.success).toBe(false);
    expect(summary.error?.message).toContain("API rate limited");
  });

  it("captures disconnect() errors and returns success=false", async () => {
    const connector = buildConnector({
      async disconnect(): Promise<void> {
        throw new Error("Disconnect exploded");
      },
    });

    const ctx = makeContext();
    const summary = await runConnectorLifecycle(connector, STUB_MANIFEST, ctx, defaultOptions);
    expect(summary.success).toBe(false);
    expect(summary.error?.message).toContain("Disconnect exploded");
  });

  it("times out a hung connect() call", async () => {
    const connector = buildConnector({
      async connect(): Promise<ConnectorHandle> {
        // Simulate an indefinite hang
        await new Promise<void>(() => { /* never resolves */ });
        return { connectionId: "unreachable", metadata: {} };
      },
    });

    const ctx = makeContext();
    const summary = await runConnectorLifecycle(
      connector,
      STUB_MANIFEST,
      ctx,
      { callTimeoutMs: 50 }, // very short timeout
    );
    expect(summary.success).toBe(false);
    expect(summary.error?.message).toContain("timed out");
  }, 5_000);

  it("carries plugin log entries in the summary", async () => {
    const connector = buildConnector({
      async connect(_config, ctx): Promise<ConnectorHandle> {
        ctx.logger.info("connecting to API");
        return { connectionId: "conn-001", metadata: {} };
      },
    });

    const ctx = makeContext();
    const summary = await runConnectorLifecycle(connector, STUB_MANIFEST, ctx, defaultOptions);
    const logMessages = summary.logs.map((l) => l.message);
    expect(logMessages).toContain("connecting to API");
  });

  it("includes peakHeapUsedBytes in the summary", async () => {
    const ctx = makeContext();
    const summary = await runConnectorLifecycle(buildConnector(), STUB_MANIFEST, ctx, defaultOptions);
    expect(summary.peakHeapUsedBytes).toBeGreaterThan(0);
  });

  it("error info includes error name and code for typed PluginErrors", async () => {
    const connector = buildConnector({
      async connect(): Promise<ConnectorHandle> {
        throw new PluginAuthError("bad token");
      },
    });

    const ctx = makeContext();
    const summary = await runConnectorLifecycle(connector, STUB_MANIFEST, ctx, defaultOptions);
    expect(summary.success).toBe(false);
    expect(summary.error?.name).toBe("PluginAuthError");
    expect(summary.error?.code).toBe("PLUGIN_AUTH_ERROR");
    expect(summary.error?.isRetryable).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PluginLoadError
// ─────────────────────────────────────────────────────────────────────────────

describe("PluginLoadError", () => {
  it("is an instance of Error", () => {
    const err = new PluginLoadError("manifest not found");
    expect(err).toBeInstanceOf(Error);
  });

  it("has name PluginLoadError", () => {
    const err = new PluginLoadError("something broke");
    expect(err.name).toBe("PluginLoadError");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Formatter — non-TTY output (no ANSI codes)
// ─────────────────────────────────────────────────────────────────────────────

describe("formatter", () => {
  // Capture stderr writes during formatter tests so we can assert on them.
  let stderrLines: string[];
  let originalWrite: typeof process.stderr.write;

  beforeEach(() => {
    stderrLines = [];
    originalWrite = process.stderr.write.bind(process.stderr);
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      stderrLines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    });
  });

  afterEach(() => {
    process.stderr.write = originalWrite;
    vi.restoreAllMocks();
  });

  it("printStartBanner writes to stderr without throwing", async () => {
    const { printStartBanner } = await import("../dev-server/formatter.js");
    expect(() => printStartBanner("/home/user/my-plugin")).not.toThrow();
    expect(stderrLines.length).toBeGreaterThan(0);
  });

  it("printRunSummary includes record count and manifest ID", async () => {
    const { printRunSummary } = await import("../dev-server/formatter.js");

    const summary = {
      manifest: STUB_MANIFEST,
      connectorMetadata: buildConnector().metadata(),
      handle: { connectionId: "conn-001", metadata: {} },
      batches: [
        {
          records: [{ sourceId: "r1", data: {} }],
          nextCursor: null,
          hasMore: false,
          fetchedAt: new Date().toISOString(),
        },
      ],
      totalRecords: 1,
      timings: [{ method: "metadata" as const, durationMs: 5 }],
      peakHeapUsedBytes: 1024 * 1024,
      logs: [],
      success: true,
    };

    printRunSummary(summary);
    const combined = stderrLines.join("");
    expect(combined).toContain("1");                         // total records
    expect(combined).toContain(STUB_MANIFEST.id);
  });

  it("printRunSummary includes error details for a failed run", async () => {
    const { printRunSummary } = await import("../dev-server/formatter.js");

    const summary = {
      manifest: STUB_MANIFEST,
      connectorMetadata: buildConnector().metadata(),
      handle: { connectionId: "(failed)", metadata: {} },
      batches: [],
      totalRecords: 0,
      timings: [],
      peakHeapUsedBytes: 512 * 1024,
      logs: [],
      success: false,
      error: {
        name: "PluginAuthError",
        message: "Bad credentials",
        code: "PLUGIN_AUTH_ERROR",
      },
    };

    printRunSummary(summary);
    const combined = stderrLines.join("");
    expect(combined).toContain("PluginAuthError");
    expect(combined).toContain("Bad credentials");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PluginDevServer — integration with a real temp directory
// ─────────────────────────────────────────────────────────────────────────────

describe("PluginDevServer", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "op-dev-server-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("throws PluginLoadError when the directory does not exist", async () => {
    const { PluginDevServer } = await import("../dev-server/plugin-dev-server.js");
    const server = new PluginDevServer();
    await expect(server.start("/does/not/exist/path-abc123")).rejects.toBeInstanceOf(PluginLoadError);
  });

  it("throws PluginLoadError when plugin.manifest.json is absent", async () => {
    const { PluginDevServer } = await import("../dev-server/plugin-dev-server.js");
    const server = new PluginDevServer();
    // tmpDir exists but has no manifest
    await expect(server.start(tmpDir)).rejects.toBeInstanceOf(PluginLoadError);
  });

  it("throws PluginLoadError when the manifest is invalid JSON", async () => {
    const { PluginDevServer } = await import("../dev-server/plugin-dev-server.js");
    fs.writeFileSync(path.join(tmpDir, "plugin.manifest.json"), "{ not valid json }", "utf-8");
    const server = new PluginDevServer();
    await expect(server.start(tmpDir)).rejects.toBeInstanceOf(PluginLoadError);
  });

  it("throws PluginLoadError when manifest fails schema validation", async () => {
    const { PluginDevServer } = await import("../dev-server/plugin-dev-server.js");
    // Valid JSON but missing required fields
    fs.writeFileSync(
      path.join(tmpDir, "plugin.manifest.json"),
      JSON.stringify({ manifestVersion: "1", id: "bad" }),
      "utf-8",
    );
    const server = new PluginDevServer();
    await expect(server.start(tmpDir)).rejects.toBeInstanceOf(PluginLoadError);
  });

  it("stop() is safe to call before start()", async () => {
    const { PluginDevServer: DevServer } = await import("../dev-server/plugin-dev-server.js");
    const server = new DevServer();
    // Should not throw
    expect(() => server.stop()).not.toThrow();
  });
});
