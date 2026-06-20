/**
 * Unit tests for the REST API connector.
 *
 * All tests are fully in-process. No real HTTP requests are made.
 * Mock responses are injected via MockContextOptions.fetchHandler.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createMockContext } from "@oneplatform/plugin-sdk/testing";
import { PluginConfigError, PluginAuthError, PluginRateLimitError } from "@oneplatform/plugin-sdk";
import { connector } from "../index.js";

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/** Minimal valid config; tests override only what they care about. */
const BASE_CONFIG = {
  baseUrl: "https://api.example.com/v1",
  endpoint: "/items",
} as const;

/** Build a mock Response with a JSON body. */
function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

// ────────────────────────────────────────────────────────────────────────────
// metadata()
// ────────────────────────────────────────────────────────────────────────────

describe("metadata()", () => {
  it("returns ConnectorMetadata with the correct type", () => {
    const meta = connector.metadata();
    expect(meta.type).toBe("connector");
  });

  it("returns the correct plugin id", () => {
    const meta = connector.metadata();
    expect(meta.id).toBe("com.oneplatform.connector-rest-api");
  });

  it("declares supportsIncremental = true", () => {
    const meta = connector.metadata();
    expect(meta.supportsIncremental).toBe(true);
  });

  it("declares supportsRealtime = false", () => {
    const meta = connector.metadata();
    expect(meta.supportsRealtime).toBe(false);
  });

  it("has a non-empty name and description", () => {
    const meta = connector.metadata();
    expect(meta.name.length).toBeGreaterThan(0);
    expect(meta.description.length).toBeGreaterThanOrEqual(10);
  });

  it("declares category as 'api'", () => {
    const meta = connector.metadata();
    expect(meta.category).toBe("api");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// connect()
// ────────────────────────────────────────────────────────────────────────────

describe("connect()", () => {
  it("returns a ConnectorHandle with a connectionId string", async () => {
    const ctx = createMockContext();
    const handle = await connector.connect(BASE_CONFIG, ctx);
    expect(typeof handle.connectionId).toBe("string");
    expect(handle.connectionId.length).toBeGreaterThan(0);
  });

  it("stores baseUrl and endpoint in handle metadata", async () => {
    const ctx = createMockContext();
    const handle = await connector.connect(BASE_CONFIG, ctx);
    const meta = handle.metadata as Record<string, unknown>;
    expect(meta["baseUrl"]).toBe("https://api.example.com/v1");
    expect(meta["endpoint"]).toBe("/items");
  });

  it("throws PluginConfigError when baseUrl is missing", async () => {
    const ctx = createMockContext();
    await expect(
      connector.connect({ endpoint: "/items" }, ctx),
    ).rejects.toBeInstanceOf(PluginConfigError);
  });

  it("throws PluginConfigError when baseUrl is an empty string", async () => {
    const ctx = createMockContext();
    await expect(
      connector.connect({ baseUrl: "", endpoint: "/items" }, ctx),
    ).rejects.toBeInstanceOf(PluginConfigError);
  });

  it("throws PluginConfigError when endpoint is missing", async () => {
    const ctx = createMockContext();
    await expect(
      connector.connect({ baseUrl: "https://api.example.com" }, ctx),
    ).rejects.toBeInstanceOf(PluginConfigError);
  });

  it("throws PluginConfigError when baseUrl is not a valid URL", async () => {
    const ctx = createMockContext();
    await expect(
      connector.connect({ baseUrl: "not-a-url", endpoint: "/items" }, ctx),
    ).rejects.toBeInstanceOf(PluginConfigError);
  });

  it("resolves bearer token auth from credentials and applies it in fetchBatch", async () => {
    let capturedHeaders: Record<string, string> = {};
    const ctx = createMockContext({
      credentials: { bearerToken: "tok-abc123" },
      fetchHandler: (url, init) => {
        capturedHeaders = Object.fromEntries(
          Object.entries((init?.headers as Record<string, string>) ?? {}),
        );
        return Promise.resolve(jsonResponse([{ id: "1" }]));
      },
    });
    const handle = await connector.connect(BASE_CONFIG, ctx);
    // Auth credentials must NOT be stored in metadata (credential isolation).
    const meta = handle.metadata as Record<string, unknown>;
    expect(meta["authType"]).toBeUndefined();
    expect(meta["authHeader"]).toBeUndefined();
    // Auth must be applied at request time by fetchBatch.
    await connector.fetchBatch(handle, null, ctx);
    expect(capturedHeaders["Authorization"]).toBe("Bearer tok-abc123");
  });

  it("resolves apiKey auth from credentials and applies it in fetchBatch", async () => {
    let capturedHeaders: Record<string, string> = {};
    const ctx = createMockContext({
      credentials: { apiKey: "key-xyz" },
      fetchHandler: (url, init) => {
        capturedHeaders = Object.fromEntries(
          Object.entries((init?.headers as Record<string, string>) ?? {}),
        );
        return Promise.resolve(jsonResponse([{ id: "1" }]));
      },
    });
    const handle = await connector.connect(BASE_CONFIG, ctx);
    const meta = handle.metadata as Record<string, unknown>;
    expect(meta["authType"]).toBeUndefined();
    expect(meta["authHeader"]).toBeUndefined();
    await connector.fetchBatch(handle, null, ctx);
    expect(capturedHeaders["X-API-Key"]).toBe("key-xyz");
  });

  it("resolves basic auth when username and password are both present and applies it in fetchBatch", async () => {
    let capturedHeaders: Record<string, string> = {};
    const ctx = createMockContext({
      credentials: { username: "alice", password: "s3cr3t" },
      fetchHandler: (url, init) => {
        capturedHeaders = Object.fromEntries(
          Object.entries((init?.headers as Record<string, string>) ?? {}),
        );
        return Promise.resolve(jsonResponse([{ id: "1" }]));
      },
    });
    const handle = await connector.connect(BASE_CONFIG, ctx);
    const meta = handle.metadata as Record<string, unknown>;
    expect(meta["authType"]).toBeUndefined();
    expect(meta["authHeader"]).toBeUndefined();
    await connector.fetchBatch(handle, null, ctx);
    expect(capturedHeaders["Authorization"]).toBe(
      `Basic ${Buffer.from("alice:s3cr3t").toString("base64")}`,
    );
  });

  it("connects without error when no credentials are provided (no-auth API)", async () => {
    const ctx = createMockContext({
      credentials: {},
      fetchHandler: () => Promise.resolve(jsonResponse([{ id: "1" }])),
    });
    const handle = await connector.connect(BASE_CONFIG, ctx);
    const meta = handle.metadata as Record<string, unknown>;
    // Auth credentials must NOT be stored in metadata.
    expect(meta["authType"]).toBeUndefined();
    expect(meta["authHeader"]).toBeUndefined();
    // fetchBatch must succeed without auth headers.
    await expect(connector.fetchBatch(handle, null, ctx)).resolves.toBeDefined();
  });

  it("prefers bearerToken over apiKey when both are present", async () => {
    let capturedHeaders: Record<string, string> = {};
    const ctx = createMockContext({
      credentials: { bearerToken: "bearer-wins", apiKey: "api-loses" },
      fetchHandler: (url, init) => {
        capturedHeaders = Object.fromEntries(
          Object.entries((init?.headers as Record<string, string>) ?? {}),
        );
        return Promise.resolve(jsonResponse([{ id: "1" }]));
      },
    });
    const handle = await connector.connect(BASE_CONFIG, ctx);
    await connector.fetchBatch(handle, null, ctx);
    expect(capturedHeaders["Authorization"]).toBe("Bearer bearer-wins");
    expect(capturedHeaders["X-API-Key"]).toBeUndefined();
  });

  it("defaults method to GET when not specified", async () => {
    const ctx = createMockContext();
    const handle = await connector.connect(BASE_CONFIG, ctx);
    expect((handle.metadata as Record<string, unknown>)["method"]).toBe("GET");
  });

  it("accepts POST method", async () => {
    const ctx = createMockContext();
    const handle = await connector.connect({ ...BASE_CONFIG, method: "POST" }, ctx);
    expect((handle.metadata as Record<string, unknown>)["method"]).toBe("POST");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// fetchBatch() — no pagination
// ────────────────────────────────────────────────────────────────────────────

describe("fetchBatch() — no pagination", () => {
  it("fetches a single page and returns all records with hasMore=false", async () => {
    const items = [
      { id: "1", name: "Alpha" },
      { id: "2", name: "Beta" },
    ];

    const ctx = createMockContext({
      fetchHandler: async () => jsonResponse(items),
    });
    const handle = await connector.connect(BASE_CONFIG, ctx);
    const result = await connector.fetchBatch(handle, null, ctx);

    expect(result.records).toHaveLength(2);
    expect(result.records[0]!.sourceId).toBe("1");
    expect(result.records[1]!.sourceId).toBe("2");
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
  });

  it("sets fetchedAt to a valid ISO 8601 timestamp", async () => {
    const ctx = createMockContext({
      fetchHandler: async () => jsonResponse([{ id: "x" }]),
    });
    const handle = await connector.connect(BASE_CONFIG, ctx);
    const result = await connector.fetchBatch(handle, null, ctx);

    expect(() => new Date(result.fetchedAt)).not.toThrow();
    expect(new Date(result.fetchedAt).toISOString()).toBe(result.fetchedAt);
  });

  it("returns empty records and hasMore=false for an empty array response", async () => {
    const ctx = createMockContext({
      fetchHandler: async () => jsonResponse([]),
    });
    const handle = await connector.connect(BASE_CONFIG, ctx);
    const result = await connector.fetchBatch(handle, null, ctx);

    expect(result.records).toHaveLength(0);
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// fetchBatch() — offset pagination
// ────────────────────────────────────────────────────────────────────────────

describe("fetchBatch() — offset pagination", () => {
  const OFFSET_CONFIG = {
    ...BASE_CONFIG,
    paginationType: "offset",
    pageSize: 2,
  };

  it("sends offset=0 and limit=pageSize on the first call", async () => {
    const ctx = createMockContext({
      fetchHandler: async (url) => {
        const parsed = new URL(url);
        expect(parsed.searchParams.get("offset")).toBe("0");
        expect(parsed.searchParams.get("limit")).toBe("2");
        return jsonResponse([{ id: "a" }, { id: "b" }]);
      },
    });

    const handle = await connector.connect(OFFSET_CONFIG, ctx);
    const result = await connector.fetchBatch(handle, null, ctx);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).not.toBeNull();
  });

  it("advances the offset correctly on the second call", async () => {
    let callCount = 0;
    const ctx = createMockContext({
      fetchHandler: async (url) => {
        callCount++;
        const parsed = new URL(url);
        if (callCount === 1) {
          return jsonResponse([{ id: "a" }, { id: "b" }]);
        }
        expect(parsed.searchParams.get("offset")).toBe("2");
        return jsonResponse([{ id: "c" }]); // Partial page → last page
      },
    });

    const handle = await connector.connect(OFFSET_CONFIG, ctx);
    const first = await connector.fetchBatch(handle, null, ctx);
    const second = await connector.fetchBatch(handle, first.nextCursor!, ctx);

    expect(second.records[0]!.sourceId).toBe("c");
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
  });

  it("signals end of data when the page is smaller than pageSize", async () => {
    const ctx = createMockContext({
      fetchHandler: async () =>
        jsonResponse([{ id: "only-one" }]), // 1 record < pageSize of 2
    });

    const handle = await connector.connect(OFFSET_CONFIG, ctx);
    const result = await connector.fetchBatch(handle, null, ctx);

    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// fetchBatch() — cursor pagination
// ────────────────────────────────────────────────────────────────────────────

describe("fetchBatch() — cursor pagination", () => {
  const CURSOR_CONFIG = {
    ...BASE_CONFIG,
    paginationType: "cursor",
    pageSize: 10,
  };

  it("sends no cursor param on the first call", async () => {
    const ctx = createMockContext({
      fetchHandler: async (url) => {
        const parsed = new URL(url);
        expect(parsed.searchParams.has("cursor")).toBe(false);
        return jsonResponse({ data: [{ id: "1" }], next_cursor: "tok-page-2" });
      },
    });

    const handle = await connector.connect(
      { ...CURSOR_CONFIG, responseDataPath: "data" },
      ctx,
    );
    const result = await connector.fetchBatch(handle, null, ctx);

    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).not.toBeNull();
  });

  it("sends the cursor token from the previous response on subsequent calls", async () => {
    let callCount = 0;
    const ctx = createMockContext({
      fetchHandler: async (url) => {
        callCount++;
        const parsed = new URL(url);
        if (callCount === 1) {
          return jsonResponse({
            data: [{ id: "1" }],
            next_cursor: "tok-page-2",
          });
        }
        expect(parsed.searchParams.get("cursor")).toBe("tok-page-2");
        return jsonResponse({ data: [{ id: "2" }] }); // No next_cursor → last page
      },
    });

    const handle = await connector.connect(
      { ...CURSOR_CONFIG, responseDataPath: "data" },
      ctx,
    );
    const first = await connector.fetchBatch(handle, null, ctx);
    const second = await connector.fetchBatch(handle, first.nextCursor!, ctx);

    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
  });

  it("signals end of data when the response has no next_cursor field", async () => {
    const ctx = createMockContext({
      fetchHandler: async () =>
        jsonResponse({ results: [{ id: "last" }] }),
    });

    const handle = await connector.connect(
      { ...CURSOR_CONFIG, responseDataPath: "results" },
      ctx,
    );
    const result = await connector.fetchBatch(handle, null, ctx);

    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// fetchBatch() — link pagination
// ────────────────────────────────────────────────────────────────────────────

describe("fetchBatch() — link pagination", () => {
  const LINK_CONFIG = {
    ...BASE_CONFIG,
    paginationType: "link",
  };

  it("follows the Link header rel=next URL on subsequent calls", async () => {
    let callCount = 0;
    const ctx = createMockContext({
      fetchHandler: async (url) => {
        callCount++;
        if (callCount === 1) {
          return jsonResponse([{ id: "p1" }], 200, {
            Link: '<https://api.example.com/v1/items?page=2>; rel="next"',
          });
        }
        expect(url).toBe("https://api.example.com/v1/items?page=2");
        return jsonResponse([{ id: "p2" }]); // No Link header → last page
      },
    });

    const handle = await connector.connect(LINK_CONFIG, ctx);
    const first = await connector.fetchBatch(handle, null, ctx);

    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();

    const second = await connector.fetchBatch(handle, first.nextCursor!, ctx);
    expect(second.records[0]!.sourceId).toBe("p2");
    expect(second.hasMore).toBe(false);
  });

  it("signals end of data when no Link header is present", async () => {
    const ctx = createMockContext({
      fetchHandler: async () => jsonResponse([{ id: "x" }]),
    });

    const handle = await connector.connect(LINK_CONFIG, ctx);
    const result = await connector.fetchBatch(handle, null, ctx);

    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// fetchBatch() — HTTP error handling
// ────────────────────────────────────────────────────────────────────────────

describe("fetchBatch() — HTTP error handling", () => {
  it("throws PluginAuthError on HTTP 401", async () => {
    const ctx = createMockContext({
      fetchHandler: async () => new Response("Unauthorized", { status: 401 }),
    });
    const handle = await connector.connect(BASE_CONFIG, ctx);

    await expect(
      connector.fetchBatch(handle, null, ctx),
    ).rejects.toBeInstanceOf(PluginAuthError);
  });

  it("throws PluginAuthError on HTTP 403", async () => {
    const ctx = createMockContext({
      fetchHandler: async () => new Response("Forbidden", { status: 403 }),
    });
    const handle = await connector.connect(BASE_CONFIG, ctx);

    await expect(
      connector.fetchBatch(handle, null, ctx),
    ).rejects.toBeInstanceOf(PluginAuthError);
  });

  it("throws PluginRateLimitError on HTTP 429", async () => {
    const ctx = createMockContext({
      fetchHandler: async () =>
        new Response("Too Many Requests", {
          status: 429,
          headers: { "Retry-After": "30" },
        }),
    });
    const handle = await connector.connect(BASE_CONFIG, ctx);

    await expect(
      connector.fetchBatch(handle, null, ctx),
    ).rejects.toBeInstanceOf(PluginRateLimitError);
  });

  it("includes retryAfterSeconds from Retry-After header in PluginRateLimitError", async () => {
    const ctx = createMockContext({
      fetchHandler: async () =>
        new Response("Too Many Requests", {
          status: 429,
          headers: { "Retry-After": "60" },
        }),
    });
    const handle = await connector.connect(BASE_CONFIG, ctx);

    let thrownError: PluginRateLimitError | undefined;
    try {
      await connector.fetchBatch(handle, null, ctx);
    } catch (err) {
      thrownError = err as PluginRateLimitError;
    }

    expect(thrownError).toBeDefined();
    expect(thrownError?.retryAfterSeconds).toBe(60);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// fetchBatch() — responseDataPath extraction
// ────────────────────────────────────────────────────────────────────────────

describe("fetchBatch() — responseDataPath extraction", () => {
  it("extracts records from a top-level key (e.g., 'data')", async () => {
    const ctx = createMockContext({
      fetchHandler: async () =>
        jsonResponse({ data: [{ id: "r1" }, { id: "r2" }] }),
    });
    const handle = await connector.connect(
      { ...BASE_CONFIG, responseDataPath: "data" },
      ctx,
    );
    const result = await connector.fetchBatch(handle, null, ctx);

    expect(result.records).toHaveLength(2);
    expect(result.records[0]!.sourceId).toBe("r1");
  });

  it("extracts records from a nested path (e.g., 'results.items')", async () => {
    const ctx = createMockContext({
      fetchHandler: async () =>
        jsonResponse({ results: { items: [{ id: "nested-1" }] } }),
    });
    const handle = await connector.connect(
      { ...BASE_CONFIG, responseDataPath: "results.items" },
      ctx,
    );
    const result = await connector.fetchBatch(handle, null, ctx);

    expect(result.records).toHaveLength(1);
    expect(result.records[0]!.sourceId).toBe("nested-1");
  });

  it("uses _id as sourceId when id is absent", async () => {
    const ctx = createMockContext({
      fetchHandler: async () =>
        jsonResponse([{ _id: "mongo-abc", value: 42 }]),
    });
    const handle = await connector.connect(BASE_CONFIG, ctx);
    const result = await connector.fetchBatch(handle, null, ctx);

    expect(result.records[0]!.sourceId).toBe("mongo-abc");
  });

  it("falls back to index as sourceId when neither id nor _id is present", async () => {
    const ctx = createMockContext({
      fetchHandler: async () =>
        jsonResponse([{ name: "no-id-field" }]),
    });
    const handle = await connector.connect(BASE_CONFIG, ctx);
    const result = await connector.fetchBatch(handle, null, ctx);

    expect(result.records[0]!.sourceId).toBe("0");
  });

  it("preserves all raw fields on DataRecord.data", async () => {
    const item = { id: "x", name: "Foo", price: 9.99, active: true };
    const ctx = createMockContext({
      fetchHandler: async () => jsonResponse([item]),
    });
    const handle = await connector.connect(BASE_CONFIG, ctx);
    const result = await connector.fetchBatch(handle, null, ctx);

    expect(result.records[0]!.data).toEqual(item);
  });

  it("populates metadata.updatedAt from updatedAt field when present", async () => {
    const item = { id: "ts-1", updatedAt: "2024-01-15T12:00:00.000Z" };
    const ctx = createMockContext({
      fetchHandler: async () => jsonResponse([item]),
    });
    const handle = await connector.connect(BASE_CONFIG, ctx);
    const result = await connector.fetchBatch(handle, null, ctx);

    expect(result.records[0]!.metadata?.updatedAt).toBe("2024-01-15T12:00:00.000Z");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// disconnect()
// ────────────────────────────────────────────────────────────────────────────

describe("disconnect()", () => {
  it("resolves without error", async () => {
    const ctx = createMockContext();
    const handle = await connector.connect(BASE_CONFIG, ctx);
    await expect(connector.disconnect(handle, ctx)).resolves.toBeUndefined();
  });

  it("makes no outbound fetch calls", async () => {
    const ctx = createMockContext();
    const handle = await connector.connect(BASE_CONFIG, ctx);
    await connector.disconnect(handle, ctx);

    // connect() makes no fetch calls; disconnect() must not either.
    expect(ctx.fetch.__calls).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Request header behavior
// ────────────────────────────────────────────────────────────────────────────

describe("request headers", () => {
  it("sends X-API-Key header when apiKey credential is configured", async () => {
    let capturedHeaders: Record<string, string> | undefined;

    const ctx = createMockContext({
      credentials: { apiKey: "my-api-key" },
      fetchHandler: async (_url, init) => {
        capturedHeaders = init?.headers as Record<string, string>;
        return jsonResponse([]);
      },
    });

    const handle = await connector.connect(BASE_CONFIG, ctx);
    await connector.fetchBatch(handle, null, ctx);

    expect(capturedHeaders?.["X-API-Key"]).toBe("my-api-key");
  });

  it("sends Authorization: Bearer header when bearerToken credential is configured", async () => {
    let capturedHeaders: Record<string, string> | undefined;

    const ctx = createMockContext({
      credentials: { bearerToken: "my-bearer" },
      fetchHandler: async (_url, init) => {
        capturedHeaders = init?.headers as Record<string, string>;
        return jsonResponse([]);
      },
    });

    const handle = await connector.connect(BASE_CONFIG, ctx);
    await connector.fetchBatch(handle, null, ctx);

    expect(capturedHeaders?.["Authorization"]).toBe("Bearer my-bearer");
  });

  it("includes static headers from config in every request", async () => {
    let capturedHeaders: Record<string, string> | undefined;

    const ctx = createMockContext({
      fetchHandler: async (_url, init) => {
        capturedHeaders = init?.headers as Record<string, string>;
        return jsonResponse([]);
      },
    });

    const handle = await connector.connect(
      { ...BASE_CONFIG, headers: { "X-API-Version": "2024-01" } },
      ctx,
    );
    await connector.fetchBatch(handle, null, ctx);

    expect(capturedHeaders?.["X-API-Version"]).toBe("2024-01");
  });

  it("always includes Accept: application/json", async () => {
    let capturedHeaders: Record<string, string> | undefined;

    const ctx = createMockContext({
      fetchHandler: async (_url, init) => {
        capturedHeaders = init?.headers as Record<string, string>;
        return jsonResponse([]);
      },
    });

    const handle = await connector.connect(BASE_CONFIG, ctx);
    await connector.fetchBatch(handle, null, ctx);

    expect(capturedHeaders?.["Accept"]).toBe("application/json");
  });

  it("injects traceparent header for distributed tracing", async () => {
    let capturedHeaders: Record<string, string> | undefined;

    const ctx = createMockContext({
      fetchHandler: async (_url, init) => {
        capturedHeaders = init?.headers as Record<string, string>;
        return jsonResponse([]);
      },
    });

    const handle = await connector.connect(BASE_CONFIG, ctx);
    await connector.fetchBatch(handle, null, ctx);

    // The mock tracing context injects a synthetic traceparent header.
    expect(capturedHeaders?.["traceparent"]).toBeDefined();
  });
});
