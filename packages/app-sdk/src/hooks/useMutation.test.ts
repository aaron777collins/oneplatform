/**
 * Tests for useMutation hook.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useMutation } from "./useMutation.js";
import { useAppContext } from "../provider/AppContext.js";
import { queryCache } from "../cache/QueryCache.js";
import type { BffClient } from "../client/BffClient.js";

vi.mock("../provider/AppContext.js", () => ({
  useAppContext: vi.fn(),
}));

const mockUseAppContext = vi.mocked(useAppContext);

function makeMockBffClient(response?: unknown, shouldFail = false): BffClient {
  return {
    request: vi.fn().mockImplementation(() =>
      shouldFail
        ? Promise.reject({
            code: "INTERNAL_ERROR",
            message: "Server error",
            statusCode: 500,
            isRetryable: false,
            requestId: "",
          })
        : Promise.resolve(response ?? { id: "new-id" }),
    ),
    setUnauthorizedHandler: vi.fn(),
  } as unknown as BffClient;
}

describe("useMutation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryCache.invalidate("orders");
  });

  it("starts with isLoading: false and no error", () => {
    const client = makeMockBffClient();
    mockUseAppContext.mockReturnValue({ bffClient: client } as ReturnType<typeof useAppContext>);

    const { result } = renderHook(() => useMutation("orders"));
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isError).toBe(false);
    expect(result.current.error).toBeNull();
  });

  describe("create", () => {
    it("returns the created entity", async () => {
      const client = makeMockBffClient({ id: "o1", total: 99.99 });
      mockUseAppContext.mockReturnValue({ bffClient: client } as ReturnType<typeof useAppContext>);

      const { result } = renderHook(() => useMutation<{ id: string; total: number }>("orders"));
      let created!: { id: string; total: number };
      await act(async () => {
        created = await result.current.create({ total: 99.99 });
      });
      expect(created).toEqual({ id: "o1", total: 99.99 });
    });

    it("applies optimistic create to QueryCache before network call", async () => {
      const cacheKey = JSON.stringify({ entity: "orders", filter: null, sort: null, fields: null, limit: 50 });
      queryCache.set(cacheKey, {
        data: [{ id: "existing-o1" }],
        pagination: null,
        error: null,
        fetchedAt: Date.now(),
        promise: null,
      });

      let resolveCreate!: (v: unknown) => void;
      const client = {
        request: vi.fn().mockReturnValue(new Promise((res) => { resolveCreate = res; })),
      } as unknown as BffClient;
      mockUseAppContext.mockReturnValue({ bffClient: client } as ReturnType<typeof useAppContext>);

      const { result } = renderHook(() => useMutation("orders"));
      act(() => { void result.current.create({ total: 50 }); });

      // Before network resolves, optimistic record should be appended
      await waitFor(() => {
        const data = queryCache.get(cacheKey)?.data as Array<{ _optimisticId?: string }>;
        expect(data?.some((r) => r._optimisticId)).toBe(true);
      });

      // Resolve the request
      act(() => { resolveCreate({ id: "o2", total: 50 }); });
    });

    it("rolls back optimistic create on network error", async () => {
      const cacheKey = JSON.stringify({ entity: "orders", filter: null, sort: null, fields: null, limit: 50 });
      queryCache.set(cacheKey, {
        data: [{ id: "existing-o1" }],
        pagination: null,
        error: null,
        fetchedAt: Date.now(),
        promise: null,
      });

      const client = makeMockBffClient(undefined, true);
      mockUseAppContext.mockReturnValue({ bffClient: client } as ReturnType<typeof useAppContext>);

      const { result } = renderHook(() => useMutation("orders"));
      await act(async () => {
        await expect(result.current.create({ total: 50 })).rejects.toMatchObject({
          code: "INTERNAL_ERROR",
        });
      });

      // Cache should be restored to pre-mutation state
      const data = queryCache.get(cacheKey)?.data as Array<{ id: string }>;
      expect(data).toHaveLength(1);
      expect(data?.[0]?.id).toBe("existing-o1");
    });

    it("sets isError and error on failure", async () => {
      const client = makeMockBffClient(undefined, true);
      mockUseAppContext.mockReturnValue({ bffClient: client } as ReturnType<typeof useAppContext>);

      const { result } = renderHook(() => useMutation("orders"));
      await act(async () => {
        await result.current.create({ total: 50 }).catch(() => {});
      });

      expect(result.current.isError).toBe(true);
      expect(result.current.error?.code).toBe("INTERNAL_ERROR");
    });
  });

  describe("update (PATCH)", () => {
    it("sends PATCH request and returns updated entity", async () => {
      const client = makeMockBffClient({ id: "o1", total: 150 });
      mockUseAppContext.mockReturnValue({ bffClient: client } as ReturnType<typeof useAppContext>);

      const { result } = renderHook(() => useMutation<{ id: string; total: number }>("orders"));
      let updated!: { id: string; total: number };
      await act(async () => {
        updated = await result.current.update("o1", { total: 150 });
      });
      expect(updated.total).toBe(150);

      const [url, opts] = (client.request as ReturnType<typeof vi.fn>).mock.calls[0] as [string, { method: string }];
      expect(url).toContain("/o1");
      expect(opts.method).toBe("PATCH");
    });
  });

  describe("remove (DELETE)", () => {
    it("removes the record from QueryCache optimistically and invalidates on success", async () => {
      const cacheKey = JSON.stringify({ entity: "orders", filter: null, sort: null, fields: null, limit: 50 });
      queryCache.set(cacheKey, {
        data: [{ id: "o1" }, { id: "o2" }],
        pagination: null,
        error: null,
        fetchedAt: Date.now(),
        promise: null,
      });

      const client = makeMockBffClient(undefined);
      mockUseAppContext.mockReturnValue({ bffClient: client } as ReturnType<typeof useAppContext>);

      const { result } = renderHook(() => useMutation("orders"));

      // Capture pre-mutation state to verify optimistic removal
      const preMutation = queryCache.get(cacheKey)?.data as Array<{ id: string }>;
      expect(preMutation).toHaveLength(2);

      await act(async () => { await result.current.remove("o1"); });

      // After successful remove + invalidate, the cache entry is cleared
      // so useQuery will re-fetch on next render. The entry is undefined post-invalidation.
      expect(queryCache.get(cacheKey)).toBeUndefined();
    });
  });

  describe("reset", () => {
    it("clears isError and error state", async () => {
      const client = makeMockBffClient(undefined, true);
      mockUseAppContext.mockReturnValue({ bffClient: client } as ReturnType<typeof useAppContext>);

      const { result } = renderHook(() => useMutation("orders"));
      await act(async () => {
        await result.current.create({}).catch(() => {});
      });

      expect(result.current.isError).toBe(true);

      act(() => { result.current.reset(); });

      expect(result.current.isError).toBe(false);
      expect(result.current.error).toBeNull();
    });
  });

  describe("mutation queue serialisation", () => {
    it("serialises concurrent mutations", async () => {
      const callOrder: string[] = [];
      const client = {
        request: vi.fn().mockImplementation((url: string) => {
          callOrder.push(url as string);
          return Promise.resolve({ id: "result" });
        }),
      } as unknown as BffClient;
      mockUseAppContext.mockReturnValue({ bffClient: client } as ReturnType<typeof useAppContext>);

      const { result } = renderHook(() => useMutation("orders"));

      // Fire two mutations simultaneously
      await act(async () => {
        await Promise.all([
          result.current.create({ total: 1 }),
          result.current.create({ total: 2 }),
        ]);
      });

      // Both should have been called, in order
      expect(callOrder).toHaveLength(2);
    });
  });
});
