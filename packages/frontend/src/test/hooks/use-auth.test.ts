/**
 * Tests for use-auth hooks.
 *
 * useSession and usePermission/useScope read from the Zustand auth store.
 * useRequireAuth additionally calls useNavigate from @tanstack/react-router,
 * which we mock at the module level so the hook never tries to access a real
 * router context.
 *
 * The auth store is a module-level singleton, so we reset it after each test
 * to prevent state leakage between test cases.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAuthStore, type Session } from "@/stores/auth.store.js";
import {
  useSession,
  useRequireAuth,
  usePermission,
  useScope,
} from "@/hooks/use-auth.js";

// ---------------------------------------------------------------------------
// Mock @tanstack/react-router
//
// useRequireAuth calls navigate inside a useEffect. We capture the navigate
// mock so we can assert on the arguments it receives.
// ---------------------------------------------------------------------------

const mockNavigate = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mockNavigate,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    userId: "user-1",
    tenantId: "tenant-1",
    roles: ["viewer"],
    scopes: ["read"],
    isGuest: false,
    emailVerified: true,
    ...overrides,
  };
}

/** Reset the auth store singleton to its initial values between tests.
 *
 * We merge (replace=false) rather than replace the whole store so that the
 * action functions (setSession, clearSession, etc.) are preserved across
 * tests. Replacing with replace=true wipes them out and breaks any test that
 * calls actions after a reset.
 */
function resetAuthStore(): void {
  useAuthStore.setState({
    userId: null,
    tenantId: null,
    roles: [],
    scopes: [],
    isGuest: false,
    emailVerified: false,
    isLoading: true,
    isAuthenticated: false,
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

afterEach(() => {
  resetAuthStore();
  mockNavigate.mockReset();
});

// ---------------------------------------------------------------------------
// useSession
// ---------------------------------------------------------------------------

describe("useSession", () => {
  it("returns initial state when no session has been set", () => {
    const { result } = renderHook(() => useSession());

    expect(result.current.userId).toBeNull();
    expect(result.current.tenantId).toBeNull();
    expect(result.current.roles).toEqual([]);
    expect(result.current.scopes).toEqual([]);
    expect(result.current.isGuest).toBe(false);
    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.isLoading).toBe(true);
  });

  it("returns the full session after setSession is called", () => {
    const { result } = renderHook(() => useSession());

    act(() => {
      useAuthStore.getState().setSession(
        makeSession({
          userId: "u-42",
          tenantId: "t-7",
          roles: ["data-engineer"],
          scopes: ["read", "write"],
          isGuest: false,
          emailVerified: true,
        }),
      );
    });

    expect(result.current.userId).toBe("u-42");
    expect(result.current.tenantId).toBe("t-7");
    expect(result.current.roles).toEqual(["data-engineer"]);
    expect(result.current.scopes).toEqual(["read", "write"]);
    expect(result.current.isGuest).toBe(false);
    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.isLoading).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// useRequireAuth
// ---------------------------------------------------------------------------

describe("useRequireAuth", () => {
  it("navigates to /login with redirect param when not loading and not authenticated", () => {
    // Auth check is complete (isLoading=false) but user is not authenticated
    useAuthStore.setState({ isLoading: false, isAuthenticated: false });

    renderHook(() => useRequireAuth());

    expect(mockNavigate).toHaveBeenCalledWith({
      to: "/login",
      search: { redirect: window.location.pathname },
    });
  });

  it("does not navigate while the auth check is still loading", () => {
    // isLoading=true means we haven't resolved the session yet
    useAuthStore.setState({ isLoading: true, isAuthenticated: false });

    renderHook(() => useRequireAuth());

    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("does not navigate when the user is authenticated", () => {
    useAuthStore.setState({ isLoading: false, isAuthenticated: true });

    renderHook(() => useRequireAuth());

    expect(mockNavigate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// usePermission
// ---------------------------------------------------------------------------

describe("usePermission", () => {
  it("returns true for any role check when the user has the platform-admin role", () => {
    useAuthStore.setState({ roles: ["platform-admin"] }, true);

    const { result } = renderHook(() => usePermission("data-engineer"));

    expect(result.current).toBe(true);
  });

  it("returns true when the user has the exact required role", () => {
    useAuthStore.setState({ roles: ["viewer"] }, true);

    const { result } = renderHook(() => usePermission("viewer"));

    expect(result.current).toBe(true);
  });

  it("returns false when the user has a different role that does not satisfy the requirement", () => {
    useAuthStore.setState({ roles: ["viewer"] }, true);

    const { result } = renderHook(() => usePermission("data-engineer"));

    expect(result.current).toBe(false);
  });

  it("returns false when the user has no roles at all", () => {
    useAuthStore.setState({ roles: [] }, true);

    const { result } = renderHook(() => usePermission("viewer"));

    expect(result.current).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// useScope
// ---------------------------------------------------------------------------

describe("useScope", () => {
  it("returns true when the user has the required scope", () => {
    useAuthStore.setState({ scopes: ["read", "write"] }, true);

    const { result } = renderHook(() => useScope("write"));

    expect(result.current).toBe(true);
  });

  it("returns false when the required scope is not in the user's scope list", () => {
    useAuthStore.setState({ scopes: ["read"] }, true);

    const { result } = renderHook(() => useScope("admin"));

    expect(result.current).toBe(false);
  });

  it("returns false when the user has no scopes", () => {
    useAuthStore.setState({ scopes: [] }, true);

    const { result } = renderHook(() => useScope("read"));

    expect(result.current).toBe(false);
  });
});
