/**
 * Tests for useUser hook.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useUser } from "./useUser.js";
import { useAppContext } from "../provider/AppContext.js";
import { vi } from "vitest";

// Mock useAppContext so we can control the context value without a real AppProvider
vi.mock("../provider/AppContext.js", () => ({
  useAppContext: vi.fn(),
}));

const mockUseAppContext = vi.mocked(useAppContext);

describe("useUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the user when context has a loaded user", () => {
    const user = {
      id: "u1",
      email: "alice@example.com",
      displayName: "Alice",
      tenantId: "t1",
      roles: ["admin"],
      isGuest: false,
      isLoaded: true,
    };
    mockUseAppContext.mockReturnValue({
      user,
      isReady: true,
    } as unknown as ReturnType<typeof useAppContext>);

    const { result } = renderHook(() => useUser());
    expect(result.current).toEqual(user);
  });

  it("returns sentinel values when user is null (still loading)", () => {
    mockUseAppContext.mockReturnValue({
      user: null,
      isReady: false,
    } as unknown as ReturnType<typeof useAppContext>);

    const { result } = renderHook(() => useUser());
    expect(result.current.id).toBe("");
    expect(result.current.email).toBeNull();
    expect(result.current.displayName).toBe("");
    expect(result.current.isGuest).toBe(false);
  });

  it("returns null email for guest sessions", () => {
    mockUseAppContext.mockReturnValue({
      user: {
        id: "g1",
        email: null,
        displayName: "Guest",
        tenantId: "t1",
        roles: [],
        isGuest: true,
      },
      isReady: true,
    } as unknown as ReturnType<typeof useAppContext>);

    const { result } = renderHook(() => useUser());
    expect(result.current.email).toBeNull();
    expect(result.current.isGuest).toBe(true);
  });
});
