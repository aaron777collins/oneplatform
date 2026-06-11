/**
 * Tests for useAppStorage hook.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useAppStorage } from "./useAppStorage.js";
import { useAppContext } from "../provider/AppContext.js";
import type { BffClient } from "../client/BffClient.js";

vi.mock("../provider/AppContext.js", () => ({
  useAppContext: vi.fn(),
}));

const mockUseAppContext = vi.mocked(useAppContext);

function makeMockBffClient(getResponse?: unknown, putResponse?: unknown): BffClient {
  return {
    request: vi.fn().mockImplementation((path: string, opts?: { method?: string }) => {
      if (!opts?.method || opts.method === "GET") {
        return Promise.resolve(getResponse ?? { key: "test-key", value: null });
      }
      return Promise.resolve(putResponse ?? { key: "test-key", value: null, updatedAt: "" });
    }),
    setUnauthorizedHandler: vi.fn(),
  } as unknown as BffClient;
}

describe("useAppStorage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws for invalid key", () => {
    const client = makeMockBffClient();
    mockUseAppContext.mockReturnValue({ bffClient: client, isReady: true } as ReturnType<typeof useAppContext>);

    expect(() =>
      renderHook(() => useAppStorage("invalid key!", "default")),
    ).toThrow("[app-sdk] useAppStorage key");
  });

  it("throws for key exceeding 128 characters", () => {
    const client = makeMockBffClient();
    mockUseAppContext.mockReturnValue({ bffClient: client, isReady: true } as ReturnType<typeof useAppContext>);

    const longKey = "a".repeat(129);
    expect(() =>
      renderHook(() => useAppStorage(longKey, "default")),
    ).toThrow("[app-sdk] useAppStorage key");
  });

  it("returns defaultValue before BFF response resolves", () => {
    const client = makeMockBffClient();
    mockUseAppContext.mockReturnValue({ bffClient: client, isReady: true } as ReturnType<typeof useAppContext>);

    const { result } = renderHook(() => useAppStorage("my-key", "default-val"));
    // Before the GET resolves, should return defaultValue
    expect(result.current[0]).toBe("default-val");
  });

  it("loads stored value from BFF on mount", async () => {
    const client = makeMockBffClient({ key: "prefs", value: { theme: "dark" } });
    mockUseAppContext.mockReturnValue({ bffClient: client, isReady: true } as ReturnType<typeof useAppContext>);

    const { result } = renderHook(() => useAppStorage("prefs", { theme: "light" }));
    await waitFor(() => {
      expect(result.current[0]).toEqual({ theme: "dark" });
    });
  });

  it("returns defaultValue when BFF returns null value", async () => {
    const client = makeMockBffClient({ key: "prefs", value: null });
    mockUseAppContext.mockReturnValue({ bffClient: client, isReady: true } as ReturnType<typeof useAppContext>);

    const { result } = renderHook(() => useAppStorage("prefs", "my-default"));
    await waitFor(() => expect(result.current[0]).toBe("my-default"));
  });

  it("applies optimistic update immediately before PUT resolves", async () => {
    let resolvePut!: (v: unknown) => void;
    const client = {
      request: vi.fn().mockImplementation((_path: string, opts?: { method?: string }) => {
        if (!opts?.method || opts.method === "GET") {
          return Promise.resolve({ key: "prefs", value: "initial" });
        }
        return new Promise((res) => { resolvePut = res; });
      }),
    } as unknown as BffClient;
    mockUseAppContext.mockReturnValue({ bffClient: client, isReady: true } as ReturnType<typeof useAppContext>);

    const { result } = renderHook(() => useAppStorage("prefs", "default"));

    // Wait for initial load
    await waitFor(() => expect(result.current[0]).toBe("initial"));

    // setValue optimistically updates local state
    act(() => {
      void result.current[1]("updated-value");
    });

    expect(result.current[0]).toBe("updated-value");

    // Resolve the PUT
    act(() => { resolvePut({ key: "prefs", value: "updated-value", updatedAt: "" }); });
  });

  it("throws VALUE_TOO_LARGE before making the PUT request when value exceeds 64 KB", async () => {
    const client = makeMockBffClient({ key: "big", value: null });
    mockUseAppContext.mockReturnValue({ bffClient: client, isReady: true } as ReturnType<typeof useAppContext>);

    const { result } = renderHook(() => useAppStorage("big-key", ""));
    await waitFor(() => expect(result.current[0]).toBe(""));

    // Value of ~65 KB
    const bigValue = "x".repeat(66_000);
    await expect(result.current[1](bigValue)).rejects.toMatchObject({
      code: "VALUE_TOO_LARGE",
      statusCode: 0,
      isRetryable: false,
    });

    // BFF should not have been called with a PUT
    const allCalls = (client.request as ReturnType<typeof vi.fn>).mock.calls as unknown[][];
    const putCalls = allCalls.filter((call) => {
      const opts = call[1] as { method?: string } | undefined;
      return opts?.method === "PUT";
    });
    expect(putCalls).toHaveLength(0);
  });

  it("falls back to defaultValue when initial GET fails", async () => {
    const client = {
      request: vi.fn().mockRejectedValue(new Error("Network error")),
    } as unknown as BffClient;
    mockUseAppContext.mockReturnValue({ bffClient: client, isReady: true } as ReturnType<typeof useAppContext>);

    const { result } = renderHook(() => useAppStorage("prefs", "fallback-default"));
    await waitFor(() => expect(result.current[0]).toBe("fallback-default"));
  });
});
