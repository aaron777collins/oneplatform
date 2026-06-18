/**
 * Tests for BffClient.
 *
 * BffClient is a browser-only class — tests mock global fetch and window.location.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BffClient, appendQueryParams, buildFilterParams } from "./BffClient.js";

// ─── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  // Provide a minimal window.location.origin
  Object.defineProperty(window, "location", {
    value: { origin: "https://app.example.com" },
    writable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── appendQueryParams ─────────────────────────────────────────────────────────

describe("appendQueryParams", () => {
  it("appends scalar values", () => {
    const params = new URLSearchParams();
    appendQueryParams(params, { limit: 50, cursor: "abc" });
    expect(params.get("limit")).toBe("50");
    expect(params.get("cursor")).toBe("abc");
  });

  it("expands arrays with index notation", () => {
    const params = new URLSearchParams();
    appendQueryParams(params, { sort: ["name", "-createdAt"] });
    expect(params.get("sort[0]")).toBe("name");
    expect(params.get("sort[1]")).toBe("-createdAt");
  });
});

// ─── buildFilterParams ─────────────────────────────────────────────────────────

describe("buildFilterParams", () => {
  it("builds bracket notation for scalar filter values", () => {
    const params = buildFilterParams({ status: { eq: "active" } });
    expect(params["filter[status][eq]"]).toBe("active");
  });

  it("builds indexed notation for array filter values", () => {
    const params = buildFilterParams({ ownerId: { in: ["id1", "id2"] } });
    expect(params["filter[ownerId][in][0]"]).toBe("id1");
    expect(params["filter[ownerId][in][1]"]).toBe("id2");
  });
});

// ─── BffClient constructor ─────────────────────────────────────────────────────

describe("BffClient constructor", () => {
  it("strips a single trailing slash from bffBaseUrl", () => {
    const client = new BffClient("https://api.example.com/");
    // Access private field via type cast to verify normalisation
    expect((client as unknown as { baseUrl: string }).baseUrl).toBe(
      "https://api.example.com",
    );
  });

  it("strips multiple trailing slashes from bffBaseUrl", () => {
    const client = new BffClient("https://api.example.com///");
    expect((client as unknown as { baseUrl: string }).baseUrl).toBe(
      "https://api.example.com",
    );
  });

  it("leaves a URL without trailing slash unchanged", () => {
    const client = new BffClient("https://api.example.com");
    expect((client as unknown as { baseUrl: string }).baseUrl).toBe(
      "https://api.example.com",
    );
  });
});

// ─── BffClient.request ─────────────────────────────────────────────────────────

describe("BffClient.request", () => {
  interface MockResponseShape {
    ok: boolean;
    status: number;
    headers: { get: (name: string) => string | null };
    json: () => Promise<unknown>;
  }

  function makeHeaders(requestId?: string): { get: (name: string) => string | null } {
    return { get: (name: string) => (name === "X-Request-ID" ? (requestId ?? null) : null) };
  }

  function mockFetch(response: MockResponseShape): void {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
  }

  function createConfiguredClient(): BffClient {
    const client = new BffClient();
    client.configure("test-app");
    return client;
  }

  it("uses credentials: include on every request", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: makeHeaders(),
      json: () => Promise.resolve({ data: [] }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    const client = createConfiguredClient();
    await client.request("/bff/data/orders");

    const [, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(options.credentials).toBe("include");
  });

  it("uses redirect: error on every request", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: makeHeaders(),
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal("fetch", fetchSpy);

    const client = createConfiguredClient();
    await client.request("/bff/me");

    const [, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(options.redirect).toBe("error");
  });

  it("throws AppSDKError on non-2xx response", async () => {
    mockFetch({
      ok: false,
      status: 403,
      headers: makeHeaders(),
      json: () => Promise.resolve({ error: { code: "PERMISSION_DENIED", message: "Forbidden" } }),
    });

    const client = createConfiguredClient();
    await expect(client.request("/bff/data/customers")).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
      statusCode: 403,
    });
  });

  it("wraps fetch network errors as NETWORK_ERROR", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Failed to fetch")));

    const client = createConfiguredClient();
    await expect(client.request("/bff/me")).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      statusCode: 0,
      isRetryable: true,
    });
  });

  it("calls onUnauthorized handler on 401 response", async () => {
    mockFetch({
      ok: false,
      status: 401,
      headers: makeHeaders(),
      json: () => Promise.resolve({ error: { code: "UNAUTHORIZED" } }),
    });

    const client = createConfiguredClient();
    const handler = vi.fn();
    client.setUnauthorizedHandler(handler);

    await expect(client.request("/bff/me")).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("serialises request body as JSON", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: makeHeaders(),
      json: () => Promise.resolve({ id: "new-id" }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    const client = createConfiguredClient();
    await client.request("/bff/data/orders", {
      method: "POST",
      body: { total: 99.99 },
    });

    const [, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(options.body).toBe(JSON.stringify({ total: 99.99 }));
  });

  it("does not include body for GET requests", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: makeHeaders(),
      json: () => Promise.resolve([]),
    });
    vi.stubGlobal("fetch", fetchSpy);

    const client = createConfiguredClient();
    await client.request("/bff/data/orders");

    const [, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(options.body).toBeUndefined();
  });

  it("omits Content-Type header on DELETE with no body", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      headers: makeHeaders(),
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal("fetch", fetchSpy);

    const client = createConfiguredClient();
    await client.request("/bff/data/orders/o1", { method: "DELETE" });

    const [, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = options.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBeUndefined();
  });

  it("includes Content-Type header when body is present", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      headers: makeHeaders(),
      json: () => Promise.resolve({ id: "new-id" }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    const client = createConfiguredClient();
    await client.request("/bff/data/orders", { method: "POST", body: { name: "test" } });

    const [, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = options.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
  });
});
