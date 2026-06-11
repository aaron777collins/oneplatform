import { describe, it, expect, vi, beforeEach } from "vitest";
import { queryClient, configureQueryClientAuth } from "@/lib/query-client.js";
import { ApiError } from "@/lib/api-client.js";

// ---------------------------------------------------------------------------
// Cache hygiene — clear between tests so one test's cached data cannot affect
// another test's staleTime or refetch assertions.
// ---------------------------------------------------------------------------

beforeEach(() => {
  queryClient.clear();
});

// ---------------------------------------------------------------------------
// Default query options
// ---------------------------------------------------------------------------

describe("queryClient default options", () => {
  it("has a staleTime of 30 seconds", () => {
    const staleTime = queryClient.getDefaultOptions().queries?.staleTime;
    expect(staleTime).toBe(30_000);
  });
});

// ---------------------------------------------------------------------------
// Retry policy
// ---------------------------------------------------------------------------

describe("retry policy", () => {
  // The retry option is a function — cast through unknown to satisfy TypeScript
  // without adding a runtime type guard in the production module.
  const retryFn = queryClient.getDefaultOptions().queries
    ?.retry as (failureCount: number, error: unknown) => boolean;

  describe("4xx ApiError — never retry", () => {
    it("returns false for 400 Bad Request", () => {
      expect(retryFn(0, new ApiError(400, "BAD_REQUEST", "bad", ""))).toBe(false);
    });

    it("returns false for 404 Not Found", () => {
      expect(retryFn(0, new ApiError(404, "NOT_FOUND", "not found", ""))).toBe(false);
    });

    it("returns false regardless of failure count for 4xx", () => {
      expect(retryFn(5, new ApiError(422, "UNPROCESSABLE", "invalid", ""))).toBe(false);
    });
  });

  describe("5xx ApiError — retry up to 2 times", () => {
    it("retries on first failure (failureCount 0)", () => {
      expect(retryFn(0, new ApiError(500, "INTERNAL_SERVER_ERROR", "err", ""))).toBe(true);
    });

    it("retries on second failure (failureCount 1)", () => {
      expect(retryFn(1, new ApiError(500, "INTERNAL_SERVER_ERROR", "err", ""))).toBe(true);
    });

    it("stops retrying after two attempts (failureCount 2)", () => {
      expect(retryFn(2, new ApiError(500, "INTERNAL_SERVER_ERROR", "err", ""))).toBe(false);
    });
  });

  describe("non-ApiError (network errors etc.) — retry up to 2 times", () => {
    it("retries on first failure", () => {
      expect(retryFn(0, new Error("network error"))).toBe(true);
    });

    it("retries on second failure", () => {
      expect(retryFn(1, new Error("network error"))).toBe(true);
    });

    it("stops retrying at failure count 2", () => {
      expect(retryFn(2, new Error("network error"))).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// configureQueryClientAuth — 401 mutation callback
// ---------------------------------------------------------------------------

describe("configureQueryClientAuth", () => {
  beforeEach(() => {
    // Reset the registered callback before each test so tests are independent
    configureQueryClientAuth(() => {});
  });

  it("calls the registered callback when a mutation errors with 401", () => {
    const spy = vi.fn();
    configureQueryClientAuth(spy);

    // Invoke the mutation onError handler directly — this is the integration
    // point between the QueryClient and the session management layer.
    const onError = queryClient.getDefaultOptions().mutations?.onError;
    expect(onError).toBeDefined();
    onError?.(new ApiError(401, "UNAUTHORIZED", "unauthorized", ""), undefined as never, undefined as never, undefined as never);

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("does not call the callback for non-401 ApiError mutations", () => {
    const spy = vi.fn();
    configureQueryClientAuth(spy);

    const onError = queryClient.getDefaultOptions().mutations?.onError;
    onError?.(new ApiError(403, "FORBIDDEN", "forbidden", ""), undefined as never, undefined as never, undefined as never);

    expect(spy).not.toHaveBeenCalled();
  });

  it("does not call the callback for non-ApiError mutations", () => {
    const spy = vi.fn();
    configureQueryClientAuth(spy);

    const onError = queryClient.getDefaultOptions().mutations?.onError;
    onError?.(new Error("network"), undefined as never, undefined as never, undefined as never);

    expect(spy).not.toHaveBeenCalled();
  });
});
