/**
 * MySQL Connector unit tests.
 *
 * All tests run in-process with a mock PluginContext. No real MySQL server
 * or proxy is required. The fetchHandler intercepts context.fetch.fetch()
 * calls and returns synthetic proxy responses.
 *
 * Test structure:
 *   - metadata()           — connector self-description
 *   - connect()            — config validation, credential access, PK discovery
 *   - fetchBatch()         — pagination, incremental sync, edge cases
 *   - disconnect()         — no-op lifecycle
 *   - Error handling       — proxy errors, bad config, malformed responses
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { connector } from "../index.js";
import { createMockContext } from "@oneplatform/plugin-sdk/testing";
import type { MockContextOptions } from "@oneplatform/plugin-sdk/testing";
import { PluginConfigError, PluginAuthError } from "@oneplatform/plugin-sdk";

// ────────────────────────────────────────────────────────────────────────────
// Test fixture helpers
// ────────────────────────────────────────────────────────────────────────────

const PROXY_URL = "https://mysql-proxy.internal.example.com/query";

/** Minimal valid config for table mode. */
const BASE_CONFIG = {
  database: "mydb",
  table: "orders",
  batchSize: 2,
  proxyUrl: PROXY_URL,
};

/** Credentials map used by most tests. */
const BASE_CREDENTIALS = {
  connectionString: "mysql://user:secret@db.example.com:3306/mydb",
};

/** Build a fake proxy response for primary key discovery. */
function makePkDiscoveryResponse(columnName: string | null): Response {
  const rows = columnName !== null ? [{ COLUMN_NAME: columnName }] : [];
  return new Response(JSON.stringify({ rows }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Build a fake proxy response for a data query. */
function makeDataResponse(rows: Record<string, unknown>[], totalCount?: number): Response {
  const body: Record<string, unknown> = { rows };
  if (totalCount !== undefined) {
    body["totalCount"] = totalCount;
  }
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Create a mock context whose fetch handler dispatches based on request body.
 * The first call is always the PK discovery query; subsequent calls are data queries.
 */
function makeContext(
  dataRows: Record<string, unknown>[][],
  options: Partial<MockContextOptions> = {},
  pkColumn: string | null = "id",
) {
  let callIndex = 0;

  const fetchHandler = async (_url: string, init?: RequestInit): Promise<Response> => {
    const body = init?.body !== undefined ? JSON.parse(init.body as string) : {};
    const query: string = body.query ?? "";

    // PK discovery requests target INFORMATION_SCHEMA
    if (query.includes("INFORMATION_SCHEMA")) {
      return makePkDiscoveryResponse(pkColumn);
    }

    // Data queries return successive pages from the dataRows matrix
    const page = dataRows[callIndex] ?? [];
    callIndex++;
    return makeDataResponse(page);
  };

  return createMockContext({
    credentials: BASE_CREDENTIALS,
    fetchHandler,
    ...options,
  });
}

// ────────────────────────────────────────────────────────────────────────────
// metadata()
// ────────────────────────────────────────────────────────────────────────────

describe("metadata()", () => {
  it("returns the correct type discriminant", () => {
    const meta = connector.metadata();
    expect(meta.type).toBe("connector");
  });

  it("returns the correct plugin id", () => {
    const meta = connector.metadata();
    expect(meta.id).toBe("com.oneplatform.connector-mysql");
  });

  it("declares supportsIncremental=true", () => {
    const meta = connector.metadata();
    expect(meta.supportsIncremental).toBe(true);
  });

  it("declares supportsRealtime=false", () => {
    const meta = connector.metadata();
    expect(meta.supportsRealtime).toBe(false);
  });

  it("has a configSchema requiring database and table", () => {
    const meta = connector.metadata();
    const required = (meta.configSchema as { required?: string[] }).required ?? [];
    expect(required).toContain("database");
    expect(required).toContain("table");
  });

  it("has a non-empty description of at least 10 characters", () => {
    const meta = connector.metadata();
    expect(meta.description.length).toBeGreaterThanOrEqual(10);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// connect() — config validation
// ────────────────────────────────────────────────────────────────────────────

describe("connect() — config validation", () => {
  it("throws PluginConfigError when database is missing", async () => {
    const ctx = makeContext([]);
    await expect(
      connector.connect({ table: "orders", proxyUrl: PROXY_URL }, ctx),
    ).rejects.toThrow(PluginConfigError);
  });

  it("throws PluginConfigError when table is missing", async () => {
    const ctx = makeContext([]);
    await expect(
      connector.connect({ database: "mydb", proxyUrl: PROXY_URL }, ctx),
    ).rejects.toThrow(PluginConfigError);
  });

  it("throws PluginConfigError when proxyUrl is missing", async () => {
    const ctx = makeContext([]);
    await expect(
      connector.connect({ database: "mydb", table: "orders" }, ctx),
    ).rejects.toThrow(PluginConfigError);
  });

  it("throws PluginConfigError when proxyUrl uses http (not https)", async () => {
    const ctx = makeContext([]);
    await expect(
      connector.connect(
        { ...BASE_CONFIG, proxyUrl: "http://proxy.example.com/query" },
        ctx,
      ),
    ).rejects.toThrow(PluginConfigError);
  });

  it("throws PluginConfigError when database contains a backtick", async () => {
    const ctx = makeContext([]);
    await expect(
      connector.connect({ ...BASE_CONFIG, database: "my`db" }, ctx),
    ).rejects.toThrow(PluginConfigError);
  });

  it("throws PluginConfigError when table contains a backtick", async () => {
    const ctx = makeContext([]);
    await expect(
      connector.connect({ ...BASE_CONFIG, table: "orders`" }, ctx),
    ).rejects.toThrow(PluginConfigError);
  });

  it("throws PluginConfigError when customQuery does not start with SELECT", async () => {
    const ctx = makeContext([]);
    await expect(
      connector.connect(
        { ...BASE_CONFIG, customQuery: "DELETE FROM orders" },
        ctx,
      ),
    ).rejects.toThrow(PluginConfigError);
  });

  it("throws PluginConfigError when customQuery includes LIMIT", async () => {
    const ctx = makeContext([]);
    await expect(
      connector.connect(
        { ...BASE_CONFIG, customQuery: "SELECT * FROM orders LIMIT 100" },
        ctx,
      ),
    ).rejects.toThrow(PluginConfigError);
  });

  it("throws PluginConfigError when customQuery includes OFFSET", async () => {
    const ctx = makeContext([]);
    await expect(
      connector.connect(
        { ...BASE_CONFIG, customQuery: "SELECT * FROM orders OFFSET 10" },
        ctx,
      ),
    ).rejects.toThrow(PluginConfigError);
  });

  it("throws PluginAuthError when connectionString credential is absent", async () => {
    const ctx = createMockContext({
      credentials: {}, // no connectionString
      fetchHandler: async () => makePkDiscoveryResponse("id"),
    });
    await expect(connector.connect(BASE_CONFIG, ctx)).rejects.toThrow(PluginAuthError);
  });

  it("succeeds with valid config and returns a ConnectorHandle", async () => {
    const ctx = makeContext([]);
    const handle = await connector.connect(BASE_CONFIG, ctx);
    expect(handle.connectionId).toMatch(/^mysql:/);
    expect(handle.metadata).toBeDefined();
  });

  it("stores the resolved primaryKeyColumn in handle metadata", async () => {
    const ctx = makeContext([], {}, "order_id");
    const handle = await connector.connect(BASE_CONFIG, ctx);
    expect((handle.metadata as Record<string, unknown>)["primaryKeyColumn"]).toBe("order_id");
  });

  it("sets primaryKeyColumn to null when table has no PK", async () => {
    const ctx = makeContext([], {}, null);
    const handle = await connector.connect(BASE_CONFIG, ctx);
    expect((handle.metadata as Record<string, unknown>)["primaryKeyColumn"]).toBeNull();
  });

  it("sets primaryKeyColumn to null for custom query mode (no PK discovery)", async () => {
    // In custom query mode the connector skips the INFORMATION_SCHEMA call.
    // The mock fetchHandler should not receive a PK query at all.
    const fetchCalls: string[] = [];
    const ctx = createMockContext({
      credentials: BASE_CREDENTIALS,
      fetchHandler: async (_url, init) => {
        const body = JSON.parse((init?.body as string) ?? "{}");
        fetchCalls.push(body.query);
        // All calls are data queries in custom query mode
        return makeDataResponse([]);
      },
    });

    const handle = await connector.connect(
      { ...BASE_CONFIG, customQuery: "SELECT id, total FROM orders WHERE status = 'paid'" },
      ctx,
    );

    // Verify no INFORMATION_SCHEMA query was issued
    expect(fetchCalls.every((q) => !q.includes("INFORMATION_SCHEMA"))).toBe(true);
    expect((handle.metadata as Record<string, unknown>)["primaryKeyColumn"]).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// fetchBatch() — offset pagination
// ────────────────────────────────────────────────────────────────────────────

describe("fetchBatch() — offset pagination", () => {
  it("returns all records from the first batch and hasMore=true when batch is full", async () => {
    const page1 = [{ id: 1, name: "Alice" }, { id: 2, name: "Bob" }];
    const ctx = makeContext([page1]);
    const handle = await connector.connect(BASE_CONFIG, ctx);

    const result = await connector.fetchBatch(handle, null, ctx);

    expect(result.records).toHaveLength(2);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).not.toBeNull();
  });

  it("signals hasMore=false when the batch is smaller than batchSize", async () => {
    const page1 = [{ id: 1, name: "Alice" }]; // 1 row < batchSize (2)
    const ctx = makeContext([page1]);
    const handle = await connector.connect(BASE_CONFIG, ctx);

    const result = await connector.fetchBatch(handle, null, ctx);

    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
  });

  it("signals hasMore=false and returns no records for an empty result set", async () => {
    const ctx = makeContext([[]]); // empty first page
    const handle = await connector.connect(BASE_CONFIG, ctx);

    const result = await connector.fetchBatch(handle, null, ctx);

    expect(result.records).toHaveLength(0);
    expect(result.hasMore).toBe(false);
  });

  it("advances the cursor offset correctly across two pages", async () => {
    const page1 = [{ id: 1 }, { id: 2 }];
    const page2 = [{ id: 3 }]; // partial page signals end
    const ctx = makeContext([page1, page2]);
    const handle = await connector.connect(BASE_CONFIG, ctx);

    const first = await connector.fetchBatch(handle, null, ctx);
    expect(first.hasMore).toBe(true);

    const second = await connector.fetchBatch(handle, first.nextCursor!, ctx);
    expect(second.records).toHaveLength(1);
    expect(second.hasMore).toBe(false);
  });

  it("uses the primary key column as sourceId when available", async () => {
    const rows = [{ id: 42, value: "x" }];
    const ctx = makeContext([rows], {}, "id");
    const handle = await connector.connect(BASE_CONFIG, ctx);

    const result = await connector.fetchBatch(handle, null, ctx);

    expect(result.records[0]?.sourceId).toBe("42");
  });

  it("falls back to row offset as sourceId when there is no primary key", async () => {
    const rows = [{ value: "x" }];
    const ctx = makeContext([rows], {}, null);
    const handle = await connector.connect(BASE_CONFIG, ctx);

    const result = await connector.fetchBatch(handle, null, ctx);

    // Offset 0, within-batch index 0 → sourceId "0"
    expect(result.records[0]?.sourceId).toBe("0");
  });

  it("populates fetchedAt as an ISO 8601 timestamp", async () => {
    const ctx = makeContext([[{ id: 1 }]]);
    const handle = await connector.connect(BASE_CONFIG, ctx);

    const result = await connector.fetchBatch(handle, null, ctx);

    expect(result.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("includes estimatedTotal when the proxy supplies totalCount", async () => {
    let callIndex = 0;
    const ctx = createMockContext({
      credentials: BASE_CREDENTIALS,
      fetchHandler: async (_url, init) => {
        const body = JSON.parse((init?.body as string) ?? "{}");
        if (body.query?.includes("INFORMATION_SCHEMA")) {
          return makePkDiscoveryResponse("id");
        }
        callIndex++;
        return makeDataResponse([{ id: callIndex }], 500);
      },
    });

    const handle = await connector.connect(BASE_CONFIG, ctx);
    const result = await connector.fetchBatch(handle, null, ctx);

    expect(result.estimatedTotal).toBe(500);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// fetchBatch() — incremental sync
// ────────────────────────────────────────────────────────────────────────────

describe("fetchBatch() — incremental sync", () => {
  const INCREMENTAL_CONFIG = { ...BASE_CONFIG, incrementalColumn: "updated_at" };

  it("does not add a WHERE clause on the first call (cursor=null)", async () => {
    const queriesSent: string[] = [];
    const ctx = createMockContext({
      credentials: BASE_CREDENTIALS,
      fetchHandler: async (_url, init) => {
        const body = JSON.parse((init?.body as string) ?? "{}");
        queriesSent.push(body.query ?? "");
        if (body.query?.includes("INFORMATION_SCHEMA")) {
          return makePkDiscoveryResponse("id");
        }
        return makeDataResponse([{ id: 1, updated_at: "2024-01-01T00:00:00Z" }]);
      },
    });

    const handle = await connector.connect(INCREMENTAL_CONFIG, ctx);
    await connector.fetchBatch(handle, null, ctx);

    const dataQuery = queriesSent.find((q) => !q.includes("INFORMATION_SCHEMA")) ?? "";
    expect(dataQuery).not.toContain("WHERE");
  });

  it("tracks the high-water mark in the cursor after the first batch", async () => {
    const rows = [
      { id: 1, updated_at: "2024-01-01T00:00:00Z" },
      { id: 2, updated_at: "2024-06-01T00:00:00Z" },
    ];
    const ctx = makeContext([rows]);
    const handle = await connector.connect(INCREMENTAL_CONFIG, ctx);

    const result = await connector.fetchBatch(handle, null, ctx);

    // Cursor encodes the high-water mark. Decode it to verify.
    expect(result.nextCursor).not.toBeNull();
    const decoded = JSON.parse(
      Buffer.from(result.nextCursor!, "base64url").toString("utf8"),
    ) as { since: string | null };
    expect(decoded.since).toBe("2024-06-01T00:00:00Z");
  });

  it("adds a WHERE clause with the high-water mark on subsequent calls", async () => {
    const queriesSent: string[] = [];
    const paramsSent: unknown[][] = [];

    const ctx = createMockContext({
      credentials: BASE_CREDENTIALS,
      fetchHandler: async (_url, init) => {
        const body = JSON.parse((init?.body as string) ?? "{}");
        queriesSent.push(body.query ?? "");
        paramsSent.push(body.params ?? []);
        if (body.query?.includes("INFORMATION_SCHEMA")) {
          return makePkDiscoveryResponse("id");
        }
        // First data call: full page to generate a next cursor
        if (queriesSent.filter((q) => !q.includes("INFORMATION_SCHEMA")).length === 1) {
          return makeDataResponse([
            { id: 1, updated_at: "2024-03-15T10:00:00Z" },
            { id: 2, updated_at: "2024-03-15T12:00:00Z" },
          ]);
        }
        // Second data call: partial page (end of data)
        return makeDataResponse([{ id: 3, updated_at: "2024-03-16T08:00:00Z" }]);
      },
    });

    const handle = await connector.connect(INCREMENTAL_CONFIG, ctx);
    const first = await connector.fetchBatch(handle, null, ctx);
    await connector.fetchBatch(handle, first.nextCursor!, ctx);

    // Find the second data query (third total query after PK discovery and first data call)
    const dataQueries = queriesSent.filter((q) => !q.includes("INFORMATION_SCHEMA"));
    expect(dataQueries).toHaveLength(2);
    expect(dataQueries[1]).toContain("WHERE");
    expect(dataQueries[1]).toContain("`updated_at`");

    // The WHERE parameter must be the high-water mark, not interpolated into the SQL
    const secondDataParams = paramsSent[paramsSent.length - 1] ?? [];
    expect(secondDataParams).toContain("2024-03-15T12:00:00Z");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// fetchBatch() — custom query mode
// ────────────────────────────────────────────────────────────────────────────

describe("fetchBatch() — custom query mode", () => {
  it("appends LIMIT and OFFSET to the custom query", async () => {
    const queriesSent: string[] = [];
    const paramsSent: unknown[][] = [];

    const ctx = createMockContext({
      credentials: BASE_CREDENTIALS,
      fetchHandler: async (_url, init) => {
        const body = JSON.parse((init?.body as string) ?? "{}");
        queriesSent.push(body.query ?? "");
        paramsSent.push(body.params ?? []);
        return makeDataResponse([{ id: 1 }]);
      },
    });

    const customConfig = {
      ...BASE_CONFIG,
      customQuery: "SELECT id, total FROM orders WHERE status = 'paid'",
    };
    const handle = await connector.connect(customConfig, ctx);
    await connector.fetchBatch(handle, null, ctx);

    const dataQuery = queriesSent[0] ?? "";
    expect(dataQuery).toContain("LIMIT");
    expect(dataQuery).toContain("OFFSET");
    // LIMIT and OFFSET values must be parameterised, not interpolated
    expect(dataQuery).toContain("?");
    const params = paramsSent[0] ?? [];
    expect(params).toContain(BASE_CONFIG.batchSize);
    expect(params).toContain(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// disconnect()
// ────────────────────────────────────────────────────────────────────────────

describe("disconnect()", () => {
  it("completes without throwing", async () => {
    const ctx = makeContext([]);
    const handle = await connector.connect(BASE_CONFIG, ctx);
    await expect(connector.disconnect(handle, ctx)).resolves.toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Error handling
// ────────────────────────────────────────────────────────────────────────────

describe("Error handling", () => {
  it("throws PluginAuthError on proxy 401", async () => {
    const ctx = createMockContext({
      credentials: BASE_CREDENTIALS,
      fetchHandler: async (_url, init) => {
        const body = JSON.parse((init?.body as string) ?? "{}");
        if (body.query?.includes("INFORMATION_SCHEMA")) {
          return makePkDiscoveryResponse("id");
        }
        return new Response("Unauthorized", { status: 401 });
      },
    });

    const handle = await connector.connect(BASE_CONFIG, ctx);
    await expect(connector.fetchBatch(handle, null, ctx)).rejects.toThrow(PluginAuthError);
  });

  it("throws PluginRateLimitError on proxy 429", async () => {
    const { PluginRateLimitError } = await import("@oneplatform/plugin-sdk");
    const ctx = createMockContext({
      credentials: BASE_CREDENTIALS,
      fetchHandler: async (_url, init) => {
        const body = JSON.parse((init?.body as string) ?? "{}");
        if (body.query?.includes("INFORMATION_SCHEMA")) {
          return makePkDiscoveryResponse("id");
        }
        return new Response("Too Many Requests", {
          status: 429,
          headers: { "Retry-After": "30" },
        });
      },
    });

    const handle = await connector.connect(BASE_CONFIG, ctx);
    await expect(connector.fetchBatch(handle, null, ctx)).rejects.toThrow(PluginRateLimitError);
  });

  it("throws PluginTimeoutError on proxy 500", async () => {
    const { PluginTimeoutError } = await import("@oneplatform/plugin-sdk");
    const ctx = createMockContext({
      credentials: BASE_CREDENTIALS,
      fetchHandler: async (_url, init) => {
        const body = JSON.parse((init?.body as string) ?? "{}");
        if (body.query?.includes("INFORMATION_SCHEMA")) {
          return makePkDiscoveryResponse("id");
        }
        return new Response("Internal Server Error", { status: 500 });
      },
    });

    const handle = await connector.connect(BASE_CONFIG, ctx);
    await expect(connector.fetchBatch(handle, null, ctx)).rejects.toThrow(PluginTimeoutError);
  });

  it("throws PluginDataError when proxy response is not valid JSON", async () => {
    const { PluginDataError } = await import("@oneplatform/plugin-sdk");
    const ctx = createMockContext({
      credentials: BASE_CREDENTIALS,
      fetchHandler: async (_url, init) => {
        const body = JSON.parse((init?.body as string) ?? "{}");
        if (body.query?.includes("INFORMATION_SCHEMA")) {
          return makePkDiscoveryResponse("id");
        }
        return new Response("not json", {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        });
      },
    });

    const handle = await connector.connect(BASE_CONFIG, ctx);
    await expect(connector.fetchBatch(handle, null, ctx)).rejects.toThrow(PluginDataError);
  });

  it("throws PluginDataError when proxy response is missing the rows field", async () => {
    const { PluginDataError } = await import("@oneplatform/plugin-sdk");
    const ctx = createMockContext({
      credentials: BASE_CREDENTIALS,
      fetchHandler: async (_url, init) => {
        const body = JSON.parse((init?.body as string) ?? "{}");
        if (body.query?.includes("INFORMATION_SCHEMA")) {
          return makePkDiscoveryResponse("id");
        }
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    const handle = await connector.connect(BASE_CONFIG, ctx);
    await expect(connector.fetchBatch(handle, null, ctx)).rejects.toThrow(PluginDataError);
  });

  it("throws PluginConfigError on an invalid (non-base64url) cursor", async () => {
    const ctx = makeContext([]);
    const handle = await connector.connect(BASE_CONFIG, ctx);

    await expect(
      connector.fetchBatch(handle, "not-a-valid-cursor!!!", ctx),
    ).rejects.toThrow(PluginConfigError);
  });

  it("throws PluginTimeoutError on a network-level failure", async () => {
    const { PluginTimeoutError } = await import("@oneplatform/plugin-sdk");
    const ctx = createMockContext({
      credentials: BASE_CREDENTIALS,
      fetchHandler: async (_url, init) => {
        const body = JSON.parse((init?.body as string) ?? "{}");
        if (body.query?.includes("INFORMATION_SCHEMA")) {
          return makePkDiscoveryResponse("id");
        }
        throw new Error("fetch failed: connection refused");
      },
    });

    const handle = await connector.connect(BASE_CONFIG, ctx);
    await expect(connector.fetchBatch(handle, null, ctx)).rejects.toThrow(PluginTimeoutError);
  });
});
