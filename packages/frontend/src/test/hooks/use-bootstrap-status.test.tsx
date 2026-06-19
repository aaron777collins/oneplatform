/**
 * Tests for useBootstrapStatus.
 *
 * The hook uses @tanstack/react-query via useQuery, and reads the API client
 * from ApiClientContext. We wrap renderHook in a provider tree that supplies
 * both a fresh QueryClient (retry:false, gcTime:0) and a mock ApiClient.
 *
 * Each test creates an independent QueryClient so there is no cache bleed
 * between assertions.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiClientContext, type ApiClient } from "@/lib/api-client.js";
import { createMockApiClient } from "@/test/test-utils.js";
import {
  useBootstrapStatus,
  type BootstrapStatus,
} from "@/hooks/use-bootstrap-status.js";
import type { ApiResponse } from "@/lib/api-client.js";

// ---------------------------------------------------------------------------
// Wrapper factory
//
// Each test that needs custom behaviour receives its own QueryClient so that
// query retry state from one test cannot affect another.
// ---------------------------------------------------------------------------

function createWrapper(client: ApiClient, queryClient?: QueryClient) {
  const qc =
    queryClient ??
    new QueryClient({
      defaultOptions: {
        queries: {
          // Disable retries globally — individual tests override per-query via
          // the hook's own retry option when testing retry behaviour.
          retry: false,
          gcTime: 0,
        },
      },
    });

  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={qc}>
        <ApiClientContext.Provider value={client}>
          {children}
        </ApiClientContext.Provider>
      </QueryClientProvider>
    );
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBootstrapResponse(overrides: Partial<BootstrapStatus> = {}): ApiResponse<BootstrapStatus> {
  return {
    data: {
      completed: true,
      ...overrides,
    },
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("useBootstrapStatus", () => {
  let mockClient: ReturnType<typeof createMockApiClient>;

  beforeEach(() => {
    mockClient = createMockApiClient();
  });

  it("calls client.get with the correct bootstrap status path", async () => {
    mockClient.get = vi.fn().mockResolvedValue(makeBootstrapResponse());

    const { result } = renderHook(() => useBootstrapStatus(), {
      wrapper: createWrapper(mockClient),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockClient.get).toHaveBeenCalledWith("/v1/bootstrap/status");
  });

  it("exposes the response data on success", async () => {
    const responseData = makeBootstrapResponse({
      completed: false,
      bootstrapToken: "tok-abc123",
    });
    mockClient.get = vi.fn().mockResolvedValue(responseData);

    const { result } = renderHook(() => useBootstrapStatus(), {
      wrapper: createWrapper(mockClient),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual(responseData);
  });

  it("uses the bootstrap-status query key", async () => {
    // The query key is observable via the cache after a successful fetch.
    mockClient.get = vi.fn().mockResolvedValue(makeBootstrapResponse());

    const sharedQc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });

    const { result } = renderHook(() => useBootstrapStatus(), {
      wrapper: createWrapper(mockClient, sharedQc),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // The cache entry must exist under the ["bootstrap-status"] key
    const cached = sharedQc.getQueryData(["bootstrap-status"]);
    expect(cached).toBeDefined();
  });

  it("does not retry on a 4xx error — client.get called exactly once", async () => {
    const error400 = { statusCode: 400, message: "Bad Request" };

    // Allow the hook's own retry function to drive behaviour; retryDelay:0
    // avoids timer delays that would prevent waitFor from settling quickly.
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: true, retryDelay: 0, gcTime: 0 } },
    });

    const errorClient = createMockApiClient();
    errorClient.get = vi.fn().mockRejectedValue(error400);

    const { result } = renderHook(() => useBootstrapStatus(), {
      wrapper: createWrapper(errorClient, qc),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    // The hook's own retry function returns false for 4xx, so the initial call
    // is the only call — no retries are issued.
    expect(errorClient.get).toHaveBeenCalledTimes(1);
  });

  it("retries up to 2 times on a 5xx error — client.get called 3 times total", async () => {
    const error500 = { statusCode: 500, message: "Internal Server Error" };

    // retryDelay:0 makes retries instant so waitFor can settle without fake timers.
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: true, retryDelay: 0, gcTime: 0 } },
    });

    const errorClient = createMockApiClient();
    errorClient.get = vi.fn().mockRejectedValue(error500);

    const { result } = renderHook(() => useBootstrapStatus(), {
      wrapper: createWrapper(errorClient, qc),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    // 1 initial attempt + 2 retries (hook's retry caps at failureCount < 2)
    expect(errorClient.get).toHaveBeenCalledTimes(3);
  });
});
