/**
 * Unit tests for the PostgreSQL connector.
 *
 * All network calls are intercepted via the mock context's fetchHandler —
 * no real database or proxy is required to run these tests.
 *
 * Test structure mirrors the Connector lifecycle:
 *   metadata() → connect() → fetchBatch() (loop) → disconnect()
 *
 * WHY we test cursor encoding: the cursor is the only piece of state that
 * survives between ingestion runs. A regression there would silently
 * re-ingest all rows or skip rows after a resume.
 */

import { describe, it, expect } from "vitest";
import { createMockContext } from "@oneplatform/plugin-sdk/testing";
import {
  PluginConfigError,
  PluginAuthError,
  PluginDataError,
  PluginRateLimitError,
  PluginTimeoutError,
} from "@oneplatform/plugin-sdk";
import { connector } from "../index.js";

// ─── Shared fixtures ───────────────────────────────────────────────────────────

const VALID_PROXY_URL = "https://db-proxy.internal";

const VALID_CONFIG = {
  proxyUrl: VALID_PROXY_URL,
  table: "users",
  schema: "public",
  batchSize: 2,
};

const OFFSET_CONFIG = { ...VALID_CONFIG, paginationStrategy: "offset" as const };

/**
 * Minimal schema response from the proxy's /schema endpoint.
 * Matches ProxySchemaResponse shape from the implementation.
 */
const SCHEMA_RESPONSE = {
  columns: [
    { name: "id", type: "integer", isPrimary: true },
    { name: "email", type: "text", isPrimary: false },
    { name: "updated_at", type: "timestamptz", isPrimary: false },
  ],
};

/**
 * Build a mock fetch handler that returns preset responses keyed by
 * URL path prefix. This avoids complex URL parsing in test assertions —
 * the handler just checks the start of the URL.
 */
function makeFetchHandler(
  responses: Record<string, { status: number; body: unknown }>,
): (url: string, init?: RequestInit) => Promise<Response> {
  return async (url: string) => {
    for (const [prefix, resp] of Object.entries(responses)) {
      if (url.includes(prefix)) {
        return new Response(JSON.stringify(resp.body), {
          status: resp.status,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    // Unmatched URL — fail loudly so tests don't silently pass on wrong URLs
    throw new Error(`Unmatched fetch URL in test: ${url}`);
  };
}

// ─── metadata() ───────────────────────────────────────────────────────────────

describe("metadata()", () => {
  it("returns ConnectorMetadata with correct type discriminant", () => {
    const meta = connector.metadata();
    expect(meta.type).toBe("connector");
  });

  it("has a non-empty id, name, and description", () => {
    const meta = connector.metadata();
    expect(meta.id).toBeTruthy();
    expect(meta.name.length).toBeGreaterThanOrEqual(2);
    expect(meta.description.length).toBeGreaterThanOrEqual(10);
  });

  it("declares supportsIncremental=true and supportsRealtime=true", () => {
    const meta = connector.metadata();
    expect(meta.supportsIncremental).toBe(true);
    expect(meta.supportsRealtime).toBe(true);
  });

  it("is categorized as 'database'", () => {
    const meta = connector.metadata();
    expect(meta.category).toBe("database");
  });
});

// ─── connect() ────────────────────────────────────────────────────────────────

describe("connect()", () => {
  it("returns a ConnectorHandle with a non-empty connectionId on success", async () => {
    const ctx = createMockContext({
      credentials: { connectionString: "postgresql://user:pw@localhost/db" },
      fetchHandler: makeFetchHandler({
        "/schema": { status: 200, body: SCHEMA_RESPONSE },
      }),
    });

    const handle = await connector.connect(VALID_CONFIG, ctx);

    expect(typeof handle.connectionId).toBe("string");
    expect(handle.connectionId.length).toBeGreaterThan(0);
    expect(handle.metadata["proxyUrl"]).toBe(VALID_PROXY_URL);
  });

  it("throws PluginConfigError when proxyUrl is missing", async () => {
    const ctx = createMockContext({
      credentials: { connectionString: "postgresql://user:pw@localhost/db" },
    });

    await expect(
      connector.connect({ table: "users" }, ctx),
    ).rejects.toBeInstanceOf(PluginConfigError);
  });

  it("throws PluginConfigError when proxyUrl uses HTTP instead of HTTPS", async () => {
    const ctx = createMockContext({
      credentials: { connectionString: "postgresql://user:pw@localhost/db" },
    });

    await expect(
      connector.connect({ proxyUrl: "http://proxy.internal", table: "users" }, ctx),
    ).rejects.toBeInstanceOf(PluginConfigError);
  });

  it("throws PluginConfigError when neither table nor customQuery is provided", async () => {
    const ctx = createMockContext({
      credentials: { connectionString: "postgresql://user:pw@localhost/db" },
    });

    await expect(
      connector.connect({ proxyUrl: VALID_PROXY_URL }, ctx),
    ).rejects.toBeInstanceOf(PluginConfigError);
  });

  it("throws PluginConfigError when both customQuery and incrementalColumn are set", async () => {
    const ctx = createMockContext({
      credentials: { connectionString: "postgresql://user:pw@localhost/db" },
    });

    await expect(
      connector.connect(
        {
          proxyUrl: VALID_PROXY_URL,
          customQuery: "SELECT * FROM orders",
          incrementalColumn: "updated_at",
        },
        ctx,
      ),
    ).rejects.toBeInstanceOf(PluginConfigError);
  });

  it("throws PluginAuthError when connectionString credential is absent", async () => {
    const ctx = createMockContext({
      credentials: {}, // no connectionString
    });

    await expect(
      connector.connect(VALID_CONFIG, ctx),
    ).rejects.toBeInstanceOf(PluginAuthError);
  });

  it("throws PluginConfigError when batchSize exceeds maximum", async () => {
    const ctx = createMockContext({
      credentials: { connectionString: "postgresql://user:pw@localhost/db" },
    });

    await expect(
      connector.connect(
        { ...VALID_CONFIG, batchSize: 99_999 },
        ctx,
      ),
    ).rejects.toBeInstanceOf(PluginConfigError);
  });

  it("stores config in handle.metadata for fetchBatch re-hydration", async () => {
    const ctx = createMockContext({
      credentials: { connectionString: "postgresql://user:pw@localhost/db" },
      fetchHandler: makeFetchHandler({
        "/schema": { status: 200, body: SCHEMA_RESPONSE },
      }),
    });

    const handle = await connector.connect(
      { ...VALID_CONFIG, schema: "myschema", incrementalColumn: "updated_at" },
      ctx,
    );

    expect(handle.metadata["table"]).toBe("users");
    expect(handle.metadata["schema"]).toBe("myschema");
    expect(handle.metadata["incrementalColumn"]).toBe("updated_at");
    expect(handle.metadata["batchSize"]).toBe(2);
  });
});

// ─── fetchBatch() — offset pagination ────────────────────────────────────────

describe("fetchBatch() — offset pagination", () => {
  async function connectWithOffset(overrides: Record<string, unknown> = {}) {
    const fetchHandler = makeFetchHandler({
      "/schema": { status: 200, body: SCHEMA_RESPONSE },
    });
    const ctx = createMockContext({
      credentials: { connectionString: "postgresql://user:pw@localhost/db" },
      fetchHandler,
    });
    const handle = await connector.connect({ ...OFFSET_CONFIG, ...overrides }, ctx);
    return handle;
  }

  it("first call with null cursor fetches from offset 0", async () => {
    const fetchedUrls: string[] = [];
    const rows = [
      { id: 1, email: "a@example.com" },
      { id: 2, email: "b@example.com" },
    ];

    const ctx = createMockContext({
      credentials: { connectionString: "postgresql://user:pw@localhost/db" },
      fetchHandler: async (url) => {
        fetchedUrls.push(url);
        if (url.includes("/schema")) {
          return new Response(JSON.stringify(SCHEMA_RESPONSE), { status: 200 });
        }
        if (url.includes("/rows")) {
          return new Response(JSON.stringify({ rows }), { status: 200 });
        }
        throw new Error(`Unmatched URL: ${url}`);
      },
    });

    const handle = await connector.connect(OFFSET_CONFIG, ctx);
    const result = await connector.fetchBatch(handle, null, ctx);

    expect(result.records).toHaveLength(2);
    expect(result.records[0]?.sourceId).toBe("1");
    expect(result.records[0]?.data["email"]).toBe("a@example.com");

    // The /rows call should include offset=0
    const rowsCall = fetchedUrls.find((u) => u.includes("/rows"));
    expect(rowsCall).toBeDefined();
    expect(rowsCall).toContain("offset=0");
  });

  it("returns hasMore=true and a valid nextCursor when batch is full", async () => {
    const rows = [
      { id: 1, email: "a@example.com" },
      { id: 2, email: "b@example.com" },
    ]; // batchSize is 2 → full batch

    const ctx = createMockContext({
      credentials: { connectionString: "postgresql://user:pw@localhost/db" },
      fetchHandler: async (url) => {
        if (url.includes("/schema")) return new Response(JSON.stringify(SCHEMA_RESPONSE), { status: 200 });
        return new Response(JSON.stringify({ rows }), { status: 200 });
      },
    });

    const handle = await connector.connect(OFFSET_CONFIG, ctx);
    const result = await connector.fetchBatch(handle, null, ctx);

    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).not.toBeNull();
  });

  it("returns hasMore=false and null nextCursor when batch is partial", async () => {
    const rows = [{ id: 1, email: "a@example.com" }]; // batchSize is 2 → partial

    const ctx = createMockContext({
      credentials: { connectionString: "postgresql://user:pw@localhost/db" },
      fetchHandler: async (url) => {
        if (url.includes("/schema")) return new Response(JSON.stringify(SCHEMA_RESPONSE), { status: 200 });
        return new Response(JSON.stringify({ rows }), { status: 200 });
      },
    });

    const handle = await connector.connect(OFFSET_CONFIG, ctx);
    const result = await connector.fetchBatch(handle, null, ctx);

    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
  });

  it("returns hasMore=false and null nextCursor on empty batch", async () => {
    const ctx = createMockContext({
      credentials: { connectionString: "postgresql://user:pw@localhost/db" },
      fetchHandler: async (url) => {
        if (url.includes("/schema")) return new Response(JSON.stringify(SCHEMA_RESPONSE), { status: 200 });
        return new Response(JSON.stringify({ rows: [] }), { status: 200 });
      },
    });

    const handle = await connector.connect(OFFSET_CONFIG, ctx);
    const result = await connector.fetchBatch(handle, null, ctx);

    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
    expect(result.records).toHaveLength(0);
  });

  it("advances offset correctly across multiple batches", async () => {
    const allRows = [
      { id: 1, email: "a@example.com" },
      { id: 2, email: "b@example.com" },
      { id: 3, email: "c@example.com" },
    ];

    // batchSize=2, so first batch returns rows 0–1, second returns row 2
    let callCount = 0;
    const ctx = createMockContext({
      credentials: { connectionString: "postgresql://user:pw@localhost/db" },
      fetchHandler: async (url) => {
        if (url.includes("/schema")) return new Response(JSON.stringify(SCHEMA_RESPONSE), { status: 200 });
        if (url.includes("/rows")) {
          const parsed = new URL(url);
          const offset = parseInt(parsed.searchParams.get("offset") ?? "0", 10);
          const limit = parseInt(parsed.searchParams.get("limit") ?? "2", 10);
          callCount++;
          return new Response(
            JSON.stringify({ rows: allRows.slice(offset, offset + limit), total: 3 }),
            { status: 200 },
          );
        }
        throw new Error(`Unmatched: ${url}`);
      },
    });

    const handle = await connector.connect(OFFSET_CONFIG, ctx);

    const batch1 = await connector.fetchBatch(handle, null, ctx);
    expect(batch1.records).toHaveLength(2);
    expect(batch1.hasMore).toBe(true);
    expect(batch1.estimatedTotal).toBe(3);

    const batch2 = await connector.fetchBatch(handle, batch1.nextCursor, ctx);
    expect(batch2.records).toHaveLength(1);
    expect(batch2.hasMore).toBe(false);
    expect(batch2.nextCursor).toBeNull();
    expect(callCount).toBe(2);
  });

  it("includes ISO 8601 fetchedAt timestamp in result", async () => {
    const ctx = createMockContext({
      credentials: { connectionString: "postgresql://user:pw@localhost/db" },
      fetchHandler: async (url) => {
        if (url.includes("/schema")) return new Response(JSON.stringify(SCHEMA_RESPONSE), { status: 200 });
        return new Response(JSON.stringify({ rows: [] }), { status: 200 });
      },
    });

    const handle = await connector.connect(OFFSET_CONFIG, ctx);
    const result = await connector.fetchBatch(handle, null, ctx);

    expect(() => new Date(result.fetchedAt)).not.toThrow();
    expect(new Date(result.fetchedAt).toISOString()).toBe(result.fetchedAt);
  });
});

// ─── fetchBatch() — cursor-based incremental sync ────────────────────────────

describe("fetchBatch() — incremental sync", () => {
  const INCREMENTAL_CONFIG = {
    ...VALID_CONFIG,
    incrementalColumn: "updated_at",
  };

  it("first call (null cursor) fetches without cursor_value param", async () => {
    const fetchedUrls: string[] = [];

    const ctx = createMockContext({
      credentials: { connectionString: "postgresql://user:pw@localhost/db" },
      fetchHandler: async (url) => {
        fetchedUrls.push(url);
        if (url.includes("/schema")) return new Response(JSON.stringify(SCHEMA_RESPONSE), { status: 200 });
        return new Response(
          JSON.stringify({ rows: [{ id: 1, email: "a@example.com", updated_at: "2024-01-01T00:00:00Z" }] }),
          { status: 200 },
        );
      },
    });

    const handle = await connector.connect(INCREMENTAL_CONFIG, ctx);
    await connector.fetchBatch(handle, null, ctx);

    const rowsCall = fetchedUrls.find((u) => u.includes("/rows"));
    expect(rowsCall).toBeDefined();
    // Should NOT contain cursor_value since this is the first call
    expect(rowsCall).not.toContain("cursor_value");
    // Should contain incremental_column
    expect(rowsCall).toContain("incremental_column=updated_at");
  });

  it("subsequent call passes cursor_value from previous batch's last row", async () => {
    const fetchedUrls: string[] = [];

    const batch1Rows = [
      { id: 1, email: "a@example.com", updated_at: "2024-01-01T00:00:00Z" },
      { id: 2, email: "b@example.com", updated_at: "2024-01-02T00:00:00Z" },
    ]; // full batch of 2

    let callCount = 0;
    const ctx = createMockContext({
      credentials: { connectionString: "postgresql://user:pw@localhost/db" },
      fetchHandler: async (url) => {
        fetchedUrls.push(url);
        if (url.includes("/schema")) return new Response(JSON.stringify(SCHEMA_RESPONSE), { status: 200 });
        callCount++;
        const rows = callCount === 1 ? batch1Rows : [];
        return new Response(JSON.stringify({ rows }), { status: 200 });
      },
    });

    const handle = await connector.connect(INCREMENTAL_CONFIG, ctx);

    const batch1 = await connector.fetchBatch(handle, null, ctx);
    expect(batch1.hasMore).toBe(true);
    expect(batch1.nextCursor).not.toBeNull();

    await connector.fetchBatch(handle, batch1.nextCursor, ctx);

    const secondRowsCall = fetchedUrls.filter((u) => u.includes("/rows"))[1];
    expect(secondRowsCall).toContain("cursor_value=2024-01-02");
  });

  it("returns hasMore=false when incremental batch is not full", async () => {
    const rows = [
      { id: 1, email: "a@example.com", updated_at: "2024-01-01T00:00:00Z" },
    ]; // only 1 row, batchSize=2 → partial → hasMore=false

    const ctx = createMockContext({
      credentials: { connectionString: "postgresql://user:pw@localhost/db" },
      fetchHandler: async (url) => {
        if (url.includes("/schema")) return new Response(JSON.stringify(SCHEMA_RESPONSE), { status: 200 });
        return new Response(JSON.stringify({ rows }), { status: 200 });
      },
    });

    const handle = await connector.connect(INCREMENTAL_CONFIG, ctx);
    const result = await connector.fetchBatch(handle, null, ctx);

    expect(result.hasMore).toBe(false);
    // Incremental sync always persists the cursor even on partial batches
    // so that restarting the sync resumes from the last processed row
    // rather than re-fetching already-ingested data (V5-116).
    expect(result.nextCursor).not.toBeNull();
    const cursor = JSON.parse(result.nextCursor!);
    expect(cursor.mode).toBe("incremental");
    expect(cursor.lastValue).toBe("2024-01-01T00:00:00Z");
  });

  it("throws PluginDataError when incrementalColumn is missing from rows", async () => {
    // The proxy returned rows that don't include the incremental column
    const rows = [
      { id: 1, email: "a@example.com" }, // no updated_at
      { id: 2, email: "b@example.com" }, // no updated_at — full batch triggers cursor extraction
    ];

    const ctx = createMockContext({
      credentials: { connectionString: "postgresql://user:pw@localhost/db" },
      fetchHandler: async (url) => {
        if (url.includes("/schema")) return new Response(JSON.stringify(SCHEMA_RESPONSE), { status: 200 });
        return new Response(JSON.stringify({ rows }), { status: 200 });
      },
    });

    const handle = await connector.connect(INCREMENTAL_CONFIG, ctx);

    await expect(
      connector.fetchBatch(handle, null, ctx),
    ).rejects.toBeInstanceOf(PluginDataError);
  });
});

// ─── fetchBatch() — custom query ──────────────────────────────────────────────

describe("fetchBatch() — custom SQL query", () => {
  const CUSTOM_QUERY_CONFIG = {
    proxyUrl: VALID_PROXY_URL,
    customQuery: "SELECT id, email FROM users WHERE active = true",
    batchSize: 2,
  };

  it("POSTs to /query with sql and offset params", async () => {
    const capturedBodies: unknown[] = [];

    const ctx = createMockContext({
      credentials: { connectionString: "postgresql://user:pw@localhost/db" },
      fetchHandler: async (url, init) => {
        if (url.includes("/query")) {
          capturedBodies.push(JSON.parse((init?.body as string) ?? "{}"));
          return new Response(JSON.stringify({ rows: [] }), { status: 200 });
        }
        throw new Error(`Unexpected URL: ${url}`);
      },
    });

    const handle = await connector.connect(CUSTOM_QUERY_CONFIG, ctx);
    await connector.fetchBatch(handle, null, ctx);

    expect(capturedBodies).toHaveLength(1);
    const body = capturedBodies[0] as { sql: string; params: { limit: number; offset: number } };
    expect(body.sql).toBe(CUSTOM_QUERY_CONFIG.customQuery);
    expect(body.params.offset).toBe(0);
    expect(body.params.limit).toBe(2);
  });

  it("advances offset across batches", async () => {
    const capturedOffsets: number[] = [];

    const ctx = createMockContext({
      credentials: { connectionString: "postgresql://user:pw@localhost/db" },
      fetchHandler: async (url, init) => {
        if (url.includes("/query")) {
          const body = JSON.parse((init?.body as string) ?? "{}") as { params: { offset: number } };
          capturedOffsets.push(body.params.offset);
          const rows =
            capturedOffsets.length === 1
              ? [{ id: 1, email: "a@example.com" }, { id: 2, email: "b@example.com" }]
              : []; // second batch is empty
          return new Response(JSON.stringify({ rows }), { status: 200 });
        }
        throw new Error(`Unexpected: ${url}`);
      },
    });

    const handle = await connector.connect(CUSTOM_QUERY_CONFIG, ctx);
    const batch1 = await connector.fetchBatch(handle, null, ctx);
    await connector.fetchBatch(handle, batch1.nextCursor, ctx);

    expect(capturedOffsets).toEqual([0, 2]);
  });
});

// ─── Error handling ───────────────────────────────────────────────────────────

describe("error handling", () => {
  it("throws PluginAuthError on proxy 401", async () => {
    const ctx = createMockContext({
      credentials: { connectionString: "postgresql://user:pw@localhost/db" },
      fetchHandler: async (url) => {
        if (url.includes("/schema")) return new Response(JSON.stringify(SCHEMA_RESPONSE), { status: 200 });
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
      },
    });

    const handle = await connector.connect(VALID_CONFIG, ctx);
    await expect(connector.fetchBatch(handle, null, ctx)).rejects.toBeInstanceOf(PluginAuthError);
  });

  it("throws PluginRateLimitError on proxy 429", async () => {
    const ctx = createMockContext({
      credentials: { connectionString: "postgresql://user:pw@localhost/db" },
      fetchHandler: async (url) => {
        if (url.includes("/schema")) return new Response(JSON.stringify(SCHEMA_RESPONSE), { status: 200 });
        return new Response("Too Many Requests", { status: 429 });
      },
    });

    const handle = await connector.connect(VALID_CONFIG, ctx);
    await expect(connector.fetchBatch(handle, null, ctx)).rejects.toBeInstanceOf(PluginRateLimitError);
  });

  it("throws PluginTimeoutError on proxy 504", async () => {
    const ctx = createMockContext({
      credentials: { connectionString: "postgresql://user:pw@localhost/db" },
      fetchHandler: async (url) => {
        if (url.includes("/schema")) return new Response(JSON.stringify(SCHEMA_RESPONSE), { status: 200 });
        return new Response("Gateway Timeout", { status: 504 });
      },
    });

    const handle = await connector.connect(VALID_CONFIG, ctx);
    await expect(connector.fetchBatch(handle, null, ctx)).rejects.toBeInstanceOf(PluginTimeoutError);
  });

  it("throws PluginDataError when proxy returns malformed JSON on /rows", async () => {
    const ctx = createMockContext({
      credentials: { connectionString: "postgresql://user:pw@localhost/db" },
      fetchHandler: async (url) => {
        if (url.includes("/schema")) return new Response(JSON.stringify(SCHEMA_RESPONSE), { status: 200 });
        // Return valid JSON object but missing the 'rows' array
        return new Response(JSON.stringify({ error: "table not found" }), { status: 200 });
      },
    });

    const handle = await connector.connect(VALID_CONFIG, ctx);
    await expect(connector.fetchBatch(handle, null, ctx)).rejects.toBeInstanceOf(PluginDataError);
  });

  it("throws PluginDataError when a row is missing the primary key column", async () => {
    const ctx = createMockContext({
      credentials: { connectionString: "postgresql://user:pw@localhost/db" },
      fetchHandler: async (url) => {
        if (url.includes("/schema")) return new Response(JSON.stringify(SCHEMA_RESPONSE), { status: 200 });
        // Row with no 'id' field
        return new Response(JSON.stringify({ rows: [{ email: "a@example.com" }] }), { status: 200 });
      },
    });

    const handle = await connector.connect(VALID_CONFIG, ctx);
    await expect(connector.fetchBatch(handle, null, ctx)).rejects.toBeInstanceOf(PluginDataError);
  });
});

// ─── disconnect() ─────────────────────────────────────────────────────────────

describe("disconnect()", () => {
  it("resolves without throwing", async () => {
    const ctx = createMockContext({
      credentials: { connectionString: "postgresql://user:pw@localhost/db" },
      fetchHandler: makeFetchHandler({
        "/schema": { status: 200, body: SCHEMA_RESPONSE },
      }),
    });

    const handle = await connector.connect(VALID_CONFIG, ctx);
    await expect(connector.disconnect(handle, ctx)).resolves.toBeUndefined();
  });

  it("does not make any network calls on disconnect", async () => {
    const ctx = createMockContext({
      credentials: { connectionString: "postgresql://user:pw@localhost/db" },
      fetchHandler: makeFetchHandler({
        "/schema": { status: 200, body: SCHEMA_RESPONSE },
      }),
    });

    const handle = await connector.connect(VALID_CONFIG, ctx);
    const callsBeforeDisconnect = ctx.fetch.__calls.length;

    await connector.disconnect(handle, ctx);

    expect(ctx.fetch.__calls.length).toBe(callsBeforeDisconnect);
  });
});
