/**
 * CallbackPage tests
 *
 * Two concerns are tested independently:
 *
 * 1. safeRedirect — the helper that blocks open-redirect attacks by rejecting
 *    absolute URLs. Tested as a pure function via the exported component's
 *    observable behaviour (window.location.href after a successful exchange).
 *
 * 2. CallbackPage component — the OAuth code-exchange effect and navigation
 *    logic for missing params, provider detection, error fallback, and the
 *    loader spinner.
 *
 * CallbackPage reads search params from window.location.search (not from the
 * router) so tests set window.location.search directly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { CallbackPage } from "@/pages/auth/CallbackPage.js";
import { ApiClientContext, ApiError } from "@/lib/api-client.js";
import { useAuthStore } from "@/stores/auth.store.js";

// ---------------------------------------------------------------------------
// Router mock
// ---------------------------------------------------------------------------

const mockNavigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mockNavigate,
  useSearch: () => ({}),
}));

// ---------------------------------------------------------------------------
// API client mock
// ---------------------------------------------------------------------------

const mockPost = vi.fn();
const mockClient = {
  get: vi.fn(),
  post: mockPost,
  put: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
};

// ---------------------------------------------------------------------------
// Auth store reset helper
//
// Do NOT pass true (replace-entire-state) — that strips the action functions
// from the store, causing "setSession is not a function" in components that
// subscribe to actions via the selector hook.
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
// window.location mock
// The CallbackPage reads window.location.search for OAuth params and writes
// window.location.href to perform the post-login navigation.
// ---------------------------------------------------------------------------

const locationMock: { href: string; search: string; pathname: string } = {
  href: "",
  search: "",
  pathname: "/auth/callback",
};

// ---------------------------------------------------------------------------
// Render helper
// ---------------------------------------------------------------------------

function renderCallbackPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <ApiClientContext.Provider value={mockClient}>
        <CallbackPage />
      </ApiClientContext.Provider>
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockNavigate.mockClear();
  mockPost.mockReset();
  locationMock.href = "";
  locationMock.search = "";

  Object.defineProperty(window, "location", {
    writable: true,
    value: locationMock,
    configurable: true,
  });
});

afterEach(() => {
  resetAuthStore();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setSearchParams(params: Record<string, string>) {
  const qs = new URLSearchParams(params);
  locationMock.search = `?${qs.toString()}`;
}

const SUCCESS_SESSION = {
  userId: "u-1",
  tenantId: "t-1",
  roles: ["viewer"],
  scopes: ["read"],
  isGuest: false,
  emailVerified: true,
};

// ---------------------------------------------------------------------------
// safeRedirect — tested via CallbackPage's navigation behaviour
//
// The function itself is private, but its semantics are fully observable:
// after a successful exchange, the component sets window.location.href to
// whatever safeRedirect returns.
// ---------------------------------------------------------------------------

describe("safeRedirect (via CallbackPage post-exchange navigation)", () => {
  beforeEach(() => {
    mockPost.mockResolvedValue({ data: SUCCESS_SESSION });
  });

  it("replaces https:// absolute URL with '/'", async () => {
    setSearchParams({
      code: "code-1",
      state: "github:state-1",
      redirect: "https://evil.example.com",
    });
    renderCallbackPage();

    await waitFor(() => {
      expect(locationMock.href).toBe("/");
    });
  });

  it("replaces protocol-relative URL (//evil.example.com) with '/'", async () => {
    setSearchParams({
      code: "code-1",
      state: "github:state-1",
      redirect: "//evil.example.com",
    });
    renderCallbackPage();

    await waitFor(() => {
      expect(locationMock.href).toBe("/");
    });
  });

  it("preserves a valid relative path", async () => {
    setSearchParams({
      code: "code-1",
      state: "github:state-1",
      redirect: "/dashboard",
    });
    renderCallbackPage();

    await waitFor(() => {
      expect(locationMock.href).toBe("/dashboard");
    });
  });

  it("preserves a relative path with a query string", async () => {
    setSearchParams({
      code: "code-1",
      state: "github:state-1",
      redirect: "/dashboard?q=1",
    });
    renderCallbackPage();

    await waitFor(() => {
      expect(locationMock.href).toBe("/dashboard?q=1");
    });
  });

  it("falls back to '/' when the redirect param is absent", async () => {
    setSearchParams({
      code: "code-1",
      state: "github:state-1",
      // no redirect param
    });
    renderCallbackPage();

    await waitFor(() => {
      expect(locationMock.href).toBe("/");
    });
  });
});

// ---------------------------------------------------------------------------
// CallbackPage component
// ---------------------------------------------------------------------------

describe("CallbackPage", () => {
  describe("missing required params", () => {
    it("navigates to /login when the code param is missing", async () => {
      setSearchParams({ state: "github:some-state" });
      renderCallbackPage();

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith({ to: "/login" });
      });
    });

    it("navigates to /login when the state param is missing", async () => {
      setSearchParams({ code: "some-code" });
      renderCallbackPage();

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith({ to: "/login" });
      });
    });

    it("does not call the exchange endpoint when params are missing", async () => {
      setSearchParams({ code: "some-code" });
      renderCallbackPage();

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalled();
      });
      expect(mockPost).not.toHaveBeenCalled();
    });
  });

  describe("provider detection via state prefix", () => {
    beforeEach(() => {
      mockPost.mockResolvedValue({ data: SUCCESS_SESSION });
    });

    it("calls the github callback endpoint when state starts with 'github:'", async () => {
      setSearchParams({ code: "code-abc", state: "github:random-state" });
      renderCallbackPage();

      await waitFor(() => {
        expect(mockPost).toHaveBeenCalledWith(
          "/v1/auth/oauth/github/callback",
          expect.objectContaining({ code: "code-abc" }),
        );
      });
    });

    it("calls the google callback endpoint when state starts with 'google:'", async () => {
      setSearchParams({ code: "code-xyz", state: "google:random-state" });
      renderCallbackPage();

      await waitFor(() => {
        expect(mockPost).toHaveBeenCalledWith(
          "/v1/auth/oauth/google/callback",
          expect.objectContaining({ code: "code-xyz" }),
        );
      });
    });

    it("passes the full state string to the callback endpoint", async () => {
      const fullState = "github:abc123xyz";
      setSearchParams({ code: "code-1", state: fullState });
      renderCallbackPage();

      await waitFor(() => {
        expect(mockPost).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({ state: fullState }),
        );
      });
    });
  });

  describe("successful exchange", () => {
    it("calls setSession with the session from the response", async () => {
      mockPost.mockResolvedValue({ data: SUCCESS_SESSION });
      setSearchParams({ code: "code-1", state: "github:state-1" });
      renderCallbackPage();

      await waitFor(() => {
        expect(useAuthStore.getState().isAuthenticated).toBe(true);
        expect(useAuthStore.getState().userId).toBe("u-1");
      });
    });

    it("does not navigate to /login on success", async () => {
      mockPost.mockResolvedValue({ data: SUCCESS_SESSION });
      setSearchParams({ code: "code-1", state: "github:state-1" });
      renderCallbackPage();

      await waitFor(() => {
        expect(locationMock.href).toBe("/");
      });
      expect(mockNavigate).not.toHaveBeenCalledWith({ to: "/login" });
    });

    it("blocks an absolute redirect URL and navigates to / instead", async () => {
      mockPost.mockResolvedValue({ data: SUCCESS_SESSION });
      setSearchParams({
        code: "code-1",
        state: "github:state-1",
        redirect: "https://evil.com/steal",
      });
      renderCallbackPage();

      await waitFor(() => {
        expect(locationMock.href).toBe("/");
      });
    });
  });

  describe("exchange error", () => {
    it("navigates to /login when the exchange request throws", async () => {
      mockPost.mockRejectedValue(
        new ApiError(400, "INVALID_CODE", "Code already used", "req-1"),
      );
      setSearchParams({ code: "bad-code", state: "github:state-1" });
      renderCallbackPage();

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith({ to: "/login" });
      });
    });

    it("navigates to /login on network-level errors too", async () => {
      mockPost.mockRejectedValue(new Error("Network failure"));
      setSearchParams({ code: "code-1", state: "github:state-1" });
      renderCallbackPage();

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith({ to: "/login" });
      });
    });
  });

  describe("loading state", () => {
    it("shows a spinner while the exchange is in flight", async () => {
      // Never resolves so the loader stays visible
      mockPost.mockReturnValue(new Promise(() => {}));
      setSearchParams({ code: "code-1", state: "github:state-1" });
      renderCallbackPage();

      // The main element carries role="status"
      expect(screen.getByRole("status")).toBeInTheDocument();
      expect(screen.getByText(/completing sign-in/i)).toBeInTheDocument();
    });
  });
});
