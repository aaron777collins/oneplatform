/**
 * AuthGuard tests
 *
 * The component gates content behind the auth store's isAuthenticated flag.
 * Tests verify the three distinct states: loading (skeleton), unauthenticated
 * (redirect + no children), and authenticated (children rendered).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";

import { AuthGuard } from "@/components/auth/AuthGuard.js";
import { useAuthStore } from "@/stores/auth.store.js";

// ---------------------------------------------------------------------------
// Router mock — AuthGuard only needs navigate
// ---------------------------------------------------------------------------

const mockNavigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mockNavigate,
}));

// ---------------------------------------------------------------------------
// Auth store reset helper
//
// Do NOT pass true (replace-entire-state) — that strips the action functions
// from the store and breaks any component that reads actions via the selector
// hook (e.g. useAuthStore((s) => s.setSession)).
// ---------------------------------------------------------------------------

function resetAuthStore() {
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
// Helpers
// ---------------------------------------------------------------------------

function renderGuard(children: React.ReactNode = <div>Protected content</div>) {
  return render(<AuthGuard>{children}</AuthGuard>);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AuthGuard", () => {
  beforeEach(() => {
    mockNavigate.mockClear();
  });

  afterEach(() => {
    resetAuthStore();
  });

  describe("isLoading=true (initial session check in flight)", () => {
    it("renders the loading skeleton with role=status", () => {
      // Default initial state already has isLoading=true
      renderGuard();
      expect(screen.getByRole("status")).toBeInTheDocument();
    });

    it("does not call navigate while the session check is pending", () => {
      renderGuard();
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it("does not render children during loading", () => {
      renderGuard(<div data-testid="child">Child</div>);
      expect(screen.queryByTestId("child")).not.toBeInTheDocument();
    });
  });

  describe("isLoading=false, isAuthenticated=false (unauthenticated)", () => {
    beforeEach(() => {
      // Merge (no replace) so action functions are preserved
      useAuthStore.setState({ isLoading: false, isAuthenticated: false });
    });

    it("calls navigate to /login when unauthenticated", () => {
      renderGuard();
      expect(mockNavigate).toHaveBeenCalledWith(
        expect.objectContaining({ to: "/login" }),
      );
    });

    it("passes the redirect param with current pathname when navigating to /login", () => {
      renderGuard();
      expect(mockNavigate).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "/login",
          search: expect.objectContaining({ redirect: expect.any(String) }),
        }),
      );
    });

    it("renders null — no content flash before redirect completes", () => {
      const { container } = renderGuard(
        <div data-testid="protected">Protected</div>,
      );
      // The container should be empty; no children ever painted
      expect(container.firstChild).toBeNull();
      expect(screen.queryByTestId("protected")).not.toBeInTheDocument();
    });
  });

  describe("isLoading=false, isAuthenticated=true (authenticated)", () => {
    beforeEach(() => {
      useAuthStore.setState(
        { isLoading: false, isAuthenticated: true },
      );
    });

    it("renders children when authenticated", () => {
      renderGuard(<div data-testid="protected">Protected content</div>);
      expect(screen.getByTestId("protected")).toBeInTheDocument();
      expect(screen.getByText("Protected content")).toBeInTheDocument();
    });

    it("does not call navigate when authenticated", () => {
      renderGuard();
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it("does not render the loading skeleton when authenticated", () => {
      renderGuard();
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });
  });
});
