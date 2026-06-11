/**
 * Tests for api-client.ts.
 *
 * Security note: this is the single module through which all API calls flow,
 * so correctness here matters — these tests verify the 401 session-refresh
 * flow, retry guards, and error parsing that protect against auth bypass and
 * infinite loops.
 *
 * Architecture notes:
 * - apiFetch is private; we test through createApiClient() which delegates to it.
 * - The module-level clearSessionFn is set via configureAuthStore() — we must
 *   call this in beforeEach so the spy survives module re-use across tests.
 * - window.location is replaced with a plain object because jsdom does not
 *   allow assignment to window.location.href directly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createApiClient,
  configureAuthStore,
  serializeFilters,
  useApiClient,
  ApiError,
  AuthError,
  ApiClientContext,
} from "@/lib/api-client.js";
import { renderHook } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Helpers to build minimal Response objects
// ---------------------------------------------------------------------------

function makeResponse(
  status: number,
  body: unknown = {},
  headers: Record<string, string> = {},
): Response {
  const headerMap = new Headers(headers);
  const bodyText = JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (name: string) => headerMap.get(name),
    },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function make204(): Response {
  return {
    status: 204,
    ok: true,
    headers: { get: () => null },
    json: () => Promise.reject(new SyntaxError("no body")),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let mockFetch: ReturnType<typeof vi.fn>;
// Writable proxy for window.location so tests can assert href assignment
const locationProxy = { href: "" };

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);

  // Install location proxy once before each test — jsdom blocks direct
  // assignment to window.location, so we replace the property descriptor.
  Object.defineProperty(window, "location", {
    writable: true,
    configurable: true,
    value: locationProxy,
  });
  locationProxy.href = "";

  // Always configure a clean spy so 401 tests can verify it was called
  configureAuthStore(vi.fn());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// GET requests
// ---------------------------------------------------------------------------

describe("createApiClient — GET", () => {
  it("calls fetch with /api prefix and credentials: include", async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(200, { data: "ok" }));
    const client = createApiClient({ baseUrl: "" });

    await client.get("/v1/apps");

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/v1/apps",
      expect.objectContaining({ credentials: "include", method: "GET" }),
    );
  });

  it("does not set Content-Type on GET requests", async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(200, {}));
    const client = createApiClient({ baseUrl: "" });

    await client.get("/v1/apps");

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string> | undefined;
    expect(headers?.["Content-Type"]).toBeUndefined();
  });

  it("appends params as a query string", async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(200, {}));
    const client = createApiClient({ baseUrl: "" });

    await client.get("/v1/apps", { status: "active", page: 2 });

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("status=active");
    expect(url).toContain("page=2");
  });
});

// ---------------------------------------------------------------------------
// POST requests
// ---------------------------------------------------------------------------

describe("createApiClient — POST", () => {
  it("sets Content-Type: application/json and stringifies body when present", async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(201, { data: { id: "x" } }));
    const client = createApiClient({ baseUrl: "" });
    const payload = { name: "my-app" };

    await client.post("/v1/apps", payload);

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(init.body).toBe(JSON.stringify(payload));
  });

  it("omits Content-Type when no body is provided", async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(201, {}));
    const client = createApiClient({ baseUrl: "" });

    await client.post("/v1/apps");

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string> | undefined;
    expect(headers?.["Content-Type"]).toBeUndefined();
    expect(init.body).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// DELETE requests
// ---------------------------------------------------------------------------

describe("createApiClient — DELETE", () => {
  it("sends no Content-Type and no body", async () => {
    mockFetch.mockResolvedValueOnce(make204());
    const client = createApiClient({ baseUrl: "" });

    await client.delete("/v1/apps/123");

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string> | undefined;
    expect(headers?.["Content-Type"]).toBeUndefined();
    expect(init.body).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 204 No Content
// ---------------------------------------------------------------------------

describe("createApiClient — 204", () => {
  it("resolves to undefined when the server returns 204 No Content", async () => {
    mockFetch.mockResolvedValueOnce(make204());
    const client = createApiClient({ baseUrl: "" });

    const result = await client.delete("/v1/apps/123");

    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Error handling — 4xx
// ---------------------------------------------------------------------------

describe("createApiClient — 4xx errors", () => {
  it("throws ApiError with correct statusCode for 400", async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse(400, {
        error: { code: "VALIDATION_ERROR", message: "invalid input", requestId: "r1" },
      }),
    );
    const client = createApiClient({ baseUrl: "" });

    await expect(client.post("/v1/apps", {})).rejects.toMatchObject({
      name: "ApiError",
      statusCode: 400,
      code: "VALIDATION_ERROR",
    });
  });

  it("throws ApiError with statusCode 403", async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse(403, { error: { code: "FORBIDDEN", message: "no access", requestId: "" } }),
    );
    const client = createApiClient({ baseUrl: "" });

    await expect(client.get("/v1/admin")).rejects.toMatchObject({
      name: "ApiError",
      statusCode: 403,
    });
  });

  it("uses UNKNOWN_ERROR code when the response body cannot be parsed", async () => {
    // Simulate a response whose .json() rejects (malformed body)
    const badResponse = {
      status: 400,
      ok: false,
      headers: { get: () => null },
      json: () => Promise.reject(new SyntaxError("unexpected token")),
    } as unknown as Response;
    mockFetch.mockResolvedValueOnce(badResponse);
    const client = createApiClient({ baseUrl: "" });

    await expect(client.get("/v1/broken")).rejects.toMatchObject({
      name: "ApiError",
      code: "UNKNOWN_ERROR",
    });
  });
});

// ---------------------------------------------------------------------------
// 401 — session refresh flow
// ---------------------------------------------------------------------------

describe("createApiClient — 401 refresh flow", () => {
  it("calls POST /api/v1/auth/refresh then retries original request on first 401", async () => {
    const data = { data: { id: "u1" } };
    mockFetch
      .mockResolvedValueOnce(makeResponse(401, {}))       // initial 401
      .mockResolvedValueOnce(makeResponse(200, {}))       // refresh succeeds
      .mockResolvedValueOnce(makeResponse(200, data));    // retry succeeds

    const client = createApiClient({ baseUrl: "" });
    const result = await client.get<typeof data>("/v1/me");

    // Three fetch calls: original, refresh, retry
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      "/api/v1/auth/refresh",
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
    expect(result).toEqual(data);
  });

  it("clears session and redirects to /login when refresh fails", async () => {
    const clearSpy = vi.fn();
    configureAuthStore(clearSpy);

    mockFetch
      .mockResolvedValueOnce(makeResponse(401, {}))  // initial 401
      .mockResolvedValueOnce(makeResponse(401, {})); // refresh also 401

    const client = createApiClient({ baseUrl: "" });

    await expect(client.get("/v1/me")).rejects.toBeInstanceOf(AuthError);
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(locationProxy.href).toBe("/login");
  });

  it("redirects immediately without a second refresh call when isRetry is already true", async () => {
    const clearSpy = vi.fn();
    configureAuthStore(clearSpy);

    // Scenario: refresh succeeded, but the retried request also returns 401.
    // The third call (retry) returns 401, and at that point isRetry=true.
    mockFetch
      .mockResolvedValueOnce(makeResponse(401, {}))  // first call → 401
      .mockResolvedValueOnce(makeResponse(200, {}))  // refresh OK
      .mockResolvedValueOnce(makeResponse(401, {})); // retry → 401 again

    const client = createApiClient({ baseUrl: "" });

    await expect(client.get("/v1/me")).rejects.toBeInstanceOf(AuthError);
    // Exactly 3 calls: original, refresh, retry — no fourth "refresh again"
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(locationProxy.href).toBe("/login");
  });
});

// ---------------------------------------------------------------------------
// 429 — rate limit retry
// ---------------------------------------------------------------------------

describe("createApiClient — 429 rate limit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits Retry-After * 1000 ms then retries", async () => {
    const data = { data: "ok" };
    mockFetch
      .mockResolvedValueOnce(makeResponse(429, {}, { "Retry-After": "2" }))
      .mockResolvedValueOnce(makeResponse(200, data));

    const client = createApiClient({ baseUrl: "" });
    const promise = client.get("/v1/things");

    // Before 2000ms the retry has not fired yet
    await vi.advanceTimersByTimeAsync(1999);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // After the full delay the retry fires and resolves
    await vi.advanceTimersByTimeAsync(1);
    const result = await promise;

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result).toEqual(data);
  });

  it("uses a default 1000ms delay when Retry-After header is absent", async () => {
    const data = { data: "ok" };
    mockFetch
      .mockResolvedValueOnce(makeResponse(429, {}))  // no Retry-After header
      .mockResolvedValueOnce(makeResponse(200, data));

    const client = createApiClient({ baseUrl: "" });
    const promise = client.get("/v1/things");

    await vi.advanceTimersByTimeAsync(999);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    const result = await promise;

    expect(result).toEqual(data);
  });

  it("throws ApiError after exceeding 2 retries", async () => {
    mockFetch
      .mockResolvedValueOnce(makeResponse(429, { error: { code: "RATE_LIMITED", message: "slow down", requestId: "" } }))
      .mockResolvedValueOnce(makeResponse(429, { error: { code: "RATE_LIMITED", message: "slow down", requestId: "" } }))
      .mockResolvedValueOnce(makeResponse(429, { error: { code: "RATE_LIMITED", message: "slow down", requestId: "" } }));

    const client = createApiClient({ baseUrl: "" });

    // Wrap advancement + assertion together so the rejection is consumed
    // before it can surface as an unhandled rejection warning.
    const assertion = expect(client.get("/v1/things")).rejects.toMatchObject({
      name: "ApiError",
      statusCode: 429,
    });
    // Advance through all three retry windows (0ms, 1000ms, 1000ms)
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
  });
});

// ---------------------------------------------------------------------------
// 5xx — exponential backoff retry
// ---------------------------------------------------------------------------

describe("createApiClient — 5xx retry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries a 500 after 1s then 2s and resolves on success", async () => {
    const data = { data: "recovered" };
    mockFetch
      .mockResolvedValueOnce(makeResponse(500, {}))  // retryCount 0 → wait 1000ms
      .mockResolvedValueOnce(makeResponse(500, {}))  // retryCount 1 → wait 2000ms
      .mockResolvedValueOnce(makeResponse(200, data));

    const client = createApiClient({ baseUrl: "" });
    const promise = client.get("/v1/services");

    // First retry fires after 1000ms
    await vi.advanceTimersByTimeAsync(1000);
    // Second retry fires after another 2000ms
    await vi.advanceTimersByTimeAsync(2000);

    const result = await promise;
    expect(result).toEqual(data);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("throws ApiError when 500 persists past 2 retries", async () => {
    mockFetch
      .mockResolvedValueOnce(makeResponse(500, { error: { code: "ISE", message: "error", requestId: "" } }))
      .mockResolvedValueOnce(makeResponse(500, { error: { code: "ISE", message: "error", requestId: "" } }))
      .mockResolvedValueOnce(makeResponse(500, { error: { code: "ISE", message: "error", requestId: "" } }));

    const client = createApiClient({ baseUrl: "" });

    // Wrap advancement + assertion together so the rejection is consumed
    // before it can surface as an unhandled rejection warning.
    const assertion = expect(client.get("/v1/services")).rejects.toMatchObject({
      name: "ApiError",
      statusCode: 500,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;

    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// serializeFilters
// ---------------------------------------------------------------------------

describe("serializeFilters", () => {
  it("converts a single field+operator to filter[field][op] format", () => {
    const result = serializeFilters({ status: { eq: "active" } });
    expect(result).toEqual({ "filter[status][eq]": "active" });
  });

  it("handles multiple fields and operators", () => {
    const result = serializeFilters({
      status: { eq: "active" },
      age: { gte: 18, lte: 65 },
    });
    expect(result).toEqual({
      "filter[status][eq]": "active",
      "filter[age][gte]": "18",
      "filter[age][lte]": "65",
    });
  });

  it("returns an empty object for empty input", () => {
    expect(serializeFilters({})).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// configureAuthStore
// ---------------------------------------------------------------------------

describe("configureAuthStore", () => {
  it("registers a callback that fires when a 401 refresh failure clears the session", async () => {
    const clearSpy = vi.fn();
    configureAuthStore(clearSpy);

    // Trigger the 401 → failed-refresh path
    mockFetch
      .mockResolvedValueOnce(makeResponse(401, {}))
      .mockResolvedValueOnce(makeResponse(401, {}));

    const client = createApiClient({ baseUrl: "" });
    await expect(client.get("/v1/test")).rejects.toBeInstanceOf(AuthError);

    expect(clearSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// useApiClient — context guard
// ---------------------------------------------------------------------------

describe("useApiClient", () => {
  it("throws when consumed outside of ApiClientContext.Provider", () => {
    // renderHook without a wrapper gives no context value (null)
    expect(() => renderHook(() => useApiClient())).toThrow(
      "useApiClient must be used within an ApiClientContext.Provider",
    );
  });

  it("returns the client when rendered inside a provider", () => {
    const mockClient = {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    };
    const { result } = renderHook(() => useApiClient(), {
      wrapper: ({ children }) => (
        <ApiClientContext.Provider value={mockClient}>
          {children}
        </ApiClientContext.Provider>
      ),
    });
    expect(result.current).toBe(mockClient);
  });
});
