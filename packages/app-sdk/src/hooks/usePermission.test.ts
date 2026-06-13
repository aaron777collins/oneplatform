/**
 * Tests for usePermission hook.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePermission } from "./usePermission.js";
import { useAppContext } from "../provider/AppContext.js";
import { PermissionCache } from "../cache/PermissionCache.js";
import type { BffClient } from "../client/BffClient.js";

vi.mock("../provider/AppContext.js", () => ({
  useAppContext: vi.fn(),
}));

const mockUseAppContext = vi.mocked(useAppContext);

// Build a real PermissionCache seeded with test data
function buildCache(permissions: Array<{ action: string; resource: string; allowed: boolean }>): PermissionCache {
  const cache = new PermissionCache();
  const permMap: Record<string, string[]> = {};
  for (const p of permissions) {
    if (p.allowed) {
      (permMap[p.resource] ??= []).push(p.action);
    }
  }
  (cache as unknown as { applySnapshot: (p: Record<string, string[]>) => void }).applySnapshot(permMap);
  return cache;
}

describe("usePermission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns true for a matching permission", () => {
    const cache = buildCache([{ action: "read", resource: "customers", allowed: true }]);
    mockUseAppContext.mockReturnValue({ permissionCache: cache } as ReturnType<typeof useAppContext>);

    const { result } = renderHook(() => usePermission("read", "customers"));
    expect(result.current).toBe(true);
  });

  it("returns false for an absent permission", () => {
    const cache = buildCache([]);
    mockUseAppContext.mockReturnValue({ permissionCache: cache } as ReturnType<typeof useAppContext>);

    const { result } = renderHook(() => usePermission("delete", "orders"));
    expect(result.current).toBe(false);
  });

  it("admin:* wildcard returns true for any action/resource", () => {
    const cache = buildCache([{ action: "admin", resource: "*", allowed: true }]);
    mockUseAppContext.mockReturnValue({ permissionCache: cache } as ReturnType<typeof useAppContext>);

    const { result } = renderHook(() => usePermission("delete", "anything"));
    expect(result.current).toBe(true);
  });

  it("re-renders and updates when cache is refreshed", () => {
    const cache = buildCache([{ action: "read", resource: "customers", allowed: true }]);
    mockUseAppContext.mockReturnValue({ permissionCache: cache } as ReturnType<typeof useAppContext>);

    const { result } = renderHook(() => usePermission("read", "customers"));
    expect(result.current).toBe(true);

    // Simulate permission revocation by directly updating the cache snapshot
    act(() => {
      const snap = new Map([["read:customers", false]]);
      (cache as unknown as { snapshot: Map<string, boolean> }).snapshot = snap;
      // Trigger the notification manually
      (cache as unknown as { notifyListeners: () => void }).notifyListeners?.();
    });

    expect(result.current).toBe(false);
  });

  it("is synchronous — never in loading state", () => {
    const cache = buildCache([]);
    mockUseAppContext.mockReturnValue({ permissionCache: cache } as ReturnType<typeof useAppContext>);

    // The result should be immediately available (boolean, not null/undefined/Promise)
    const { result } = renderHook(() => usePermission("create", "orders"));
    expect(typeof result.current).toBe("boolean");
  });
});
