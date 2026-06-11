/**
 * Tests for useQuery hook.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useQuery } from "./useQuery.js";
import { useAppContext } from "../provider/AppContext.js";
import { queryCache } from "../cache/QueryCache.js";
import type { BffClient } from "../client/BffClient.js";

vi.mock("../provider/AppContext.js", () => ({
  useAppContext: vi.fn(),
}));

const mockUseAppContext = vi.mocked(useAppContext);

function makeMockBffClient(response?: unknown): BffClient {
  return {
    request: vi.fn().mockResolvedValue(
      response ?? { data: [], pagination: { nextCursor: null, total: 0 } },
    ),
    setUnauthorizedHandler: vi.fn(),
  } as unknown as BffClient;
}

describe("useQuery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear the module-level query cache between tests
    queryCache.invalidate("orders");
    queryCache.invalidate("customers");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts in loading state with null data", () => {
    const client = makeMockBffClient();
    mockUseAppContext.mockReturnValue({ bffClient: client, isReady: true } as ReturnType<typeof useAppContext>);

    const { result } = renderHook(() => useQuery("orders"));
    expect(result.current.isLoading).toBe(true);
    expect(result.current.data).toBeNull();
  });

  it("resolves data after BFF responds", async () => {
    const orders = [{ id: "o1", total: 100 }];
    const client = makeMockBffClient({ data: orders, pagination: { nextCursor: null, total: 1 } });
    mockUseAppContext.mockReturnValue({ bffClient: client, isReady: true } as ReturnType<typeof useAppContext>);

    const { result } = renderHook(() => useQuery("orders"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data).toEqual(orders);
  });

  it("sets isError and error on BFF failure", async () => {
    const client = {
      request: vi.fn().mockRejectedValue({
        code: "PERMISSION_DENIED",
        message: "Forbidden",
        statusCode: 403,
        isRetryable: false,
        requestId: "req-1",
      }),
    } as unknown as BffClient;
    mockUseAppContext.mockReturnValue({ bffClient: client, isReady: true } as ReturnType<typeof useAppContext>);

    const { result } = renderHook(() => useQuery("orders"));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.code).toBe("PERMISSION_DENIED");
  });

  it("does not fetch when enabled: false", async () => {
    const client = makeMockBffClient();
    mockUseAppContext.mockReturnValue({ bffClient: client, isReady: true } as ReturnType<typeof useAppContext>);

    renderHook(() => useQuery("orders", { enabled: false }));
    // Give enough time for a fetch to have fired if it was going to
    await new Promise((r) => setTimeout(r, 50));
    expect(client.request).not.toHaveBeenCalled();
  });

  it("does not fetch when isReady: false", async () => {
    const client = makeMockBffClient();
    mockUseAppContext.mockReturnValue({ bffClient: client, isReady: false } as ReturnType<typeof useAppContext>);

    renderHook(() => useQuery("orders"));
    await new Promise((r) => setTimeout(r, 50));
    expect(client.request).not.toHaveBeenCalled();
  });

  it("calls onError callback on failure", async () => {
    const onError = vi.fn();
    const client = {
      request: vi.fn().mockRejectedValue({
        code: "INTERNAL_ERROR",
        message: "Server error",
        statusCode: 500,
        isRetryable: false,
        requestId: "",
      }),
    } as unknown as BffClient;
    mockUseAppContext.mockReturnValue({ bffClient: client, isReady: true } as ReturnType<typeof useAppContext>);

    renderHook(() => useQuery("orders", { onError }));
    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
  });

  it("refetch triggers a fresh fetch", async () => {
    const client = makeMockBffClient({ data: [{ id: "o1" }], pagination: { nextCursor: null, total: 1 } });
    mockUseAppContext.mockReturnValue({ bffClient: client, isReady: true } as ReturnType<typeof useAppContext>);

    const { result } = renderHook(() => useQuery("orders"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => { void result.current.refetch(); });
    await waitFor(() => expect(client.request).toHaveBeenCalledTimes(2));
  });

  it("fetchNextPage appends to existing data", async () => {
    const clientFn = vi.fn()
      .mockResolvedValueOnce({ data: [{ id: "o1" }], pagination: { nextCursor: "cursor1", total: 2 } })
      .mockResolvedValueOnce({ data: [{ id: "o2" }], pagination: { nextCursor: null, total: 2 } });

    const client = { request: clientFn } as unknown as BffClient;
    mockUseAppContext.mockReturnValue({ bffClient: client, isReady: true } as ReturnType<typeof useAppContext>);

    const { result } = renderHook(() => useQuery<{ id: string }>("orders", { staleTime: 0 }));
    await waitFor(() => expect(result.current.data?.length).toBe(1));

    act(() => { void result.current.fetchNextPage(); });
    await waitFor(() => expect(result.current.data?.length).toBe(2));
    expect(result.current.data?.map((r) => r.id)).toEqual(["o1", "o2"]);
  });

  it("fetchNextPage does nothing when nextCursor is null", async () => {
    // Use a unique entity name to avoid cache state from other tests in this run
    const client = makeMockBffClient({ data: [{ id: "i1" }], pagination: { nextCursor: null, total: 1 } });
    mockUseAppContext.mockReturnValue({ bffClient: client, isReady: true } as ReturnType<typeof useAppContext>);

    const { result } = renderHook(() => useQuery("invoices", { staleTime: 60_000 }));
    await waitFor(() => expect(result.current.data).not.toBeNull());
    const callCountAfterLoad = (client.request as ReturnType<typeof vi.fn>).mock.calls.length;

    // fetchNextPage with null nextCursor should be a no-op
    await act(async () => { await result.current.fetchNextPage(); });
    expect(client.request).toHaveBeenCalledTimes(callCountAfterLoad);
  });

  it("returns pagination data", async () => {
    const client = makeMockBffClient({
      data: [],
      pagination: { nextCursor: "abc", total: 100 },
    });
    mockUseAppContext.mockReturnValue({ bffClient: client, isReady: true } as ReturnType<typeof useAppContext>);

    const { result } = renderHook(() => useQuery("orders"));
    await waitFor(() => expect(result.current.pagination).not.toBeNull());
    expect(result.current.pagination?.total).toBe(100);
    expect(result.current.pagination?.nextCursor).toBe("abc");
  });
});
