/**
 * LoginPage tests
 *
 * LoginPage is primarily a composition layer — it arranges LoginForm and
 * OAuthButtons and passes a post-login navigation callback. Tests verify:
 *
 * - The form is rendered
 * - Both OAuth buttons are present
 * - The shared safeRedirect utility blocks open-redirect attacks (observable
 *   via window.location.href after a successful login). Unit tests for the
 *   safeRedirect function itself live in src/test/lib/auth-utils.test.ts.
 * - A valid relative redirect param is forwarded to window.location.href
 *
 * The LoginPage does NOT support a ?mode=register URL param for switching to
 * RegisterForm — registration is at a separate route. The "Register" link in
 * the footer navigates to /login?mode=register but does not swap the rendered
 * form in the current page.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { LoginPage } from "@/pages/auth/LoginPage.js";
import { ApiClientContext, ApiError } from "@/lib/api-client.js";
import { useAuthStore } from "@/stores/auth.store.js";

// ---------------------------------------------------------------------------
// Router mock — LoginPage uses useNavigate and useSearch
// ---------------------------------------------------------------------------

let mockSearchParams: Record<string, unknown> = {};
const mockNavigate = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mockNavigate,
  // useSearch returns whatever mockSearchParams is set to
  useSearch: () => mockSearchParams,
  Link: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement("a", props, children),
}));

// ---------------------------------------------------------------------------
// API client mock (needed by LoginForm which LoginPage renders)
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
// window.location mock — LoginPage writes window.location.href on success
// ---------------------------------------------------------------------------

const locationMock: { href: string; pathname: string } = {
  href: "",
  pathname: "/login",
};

// ---------------------------------------------------------------------------
// Render helper
// ---------------------------------------------------------------------------

function renderLoginPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <ApiClientContext.Provider value={mockClient}>
        <LoginPage />
      </ApiClientContext.Provider>
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockSearchParams = {};
  mockNavigate.mockClear();
  mockPost.mockReset();
  locationMock.href = "";

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
// Tests
// ---------------------------------------------------------------------------

describe("LoginPage", () => {
  describe("rendering", () => {
    it("renders the LoginForm (sign-in button present)", () => {
      renderLoginPage();
      // Use exact match to avoid ambiguity with "Sign in with GitHub/Google"
      expect(screen.getByRole("button", { name: /^sign in$/i })).toBeInTheDocument();
    });

    it("renders the GitHub OAuth button", () => {
      renderLoginPage();
      expect(screen.getByRole("button", { name: /github/i })).toBeInTheDocument();
    });

    it("renders the Google OAuth button", () => {
      renderLoginPage();
      expect(screen.getByRole("button", { name: /google/i })).toBeInTheDocument();
    });

    it("renders the page heading", () => {
      renderLoginPage();
      expect(screen.getByText(/onePlatform/i)).toBeInTheDocument();
    });
  });

  describe("redirect after login", () => {
    const session = {
      userId: "u-1",
      tenantId: "t-1",
      roles: ["viewer"],
      scopes: ["read"],
      isGuest: false,
      emailVerified: true,
    };

    it("navigates to '/' when no redirect param is present", async () => {
      mockPost.mockResolvedValue({ data: session });
      mockSearchParams = {};
      renderLoginPage();

      const user = userEvent.setup();
      await user.type(screen.getByLabelText(/email/i), "user@example.com");
      await user.type(screen.getByLabelText(/password/i), "mypassword123");
      await user.click(screen.getByRole("button", { name: /^sign in$/i }));

      await waitFor(() => {
        expect(locationMock.href).toBe("/");
      });
    });

    it("navigates to a valid relative redirect path after successful login", async () => {
      mockPost.mockResolvedValue({ data: session });
      mockSearchParams = { redirect: "/connectors" };
      renderLoginPage();

      const user = userEvent.setup();
      await user.type(screen.getByLabelText(/email/i), "user@example.com");
      await user.type(screen.getByLabelText(/password/i), "mypassword123");
      await user.click(screen.getByRole("button", { name: /^sign in$/i }));

      await waitFor(() => {
        expect(locationMock.href).toBe("/connectors");
      });
    });

    it("blocks absolute URL in redirect param and falls back to '/'", async () => {
      mockPost.mockResolvedValue({ data: session });
      mockSearchParams = { redirect: "https://evil.com/steal" };
      renderLoginPage();

      const user = userEvent.setup();
      await user.type(screen.getByLabelText(/email/i), "user@example.com");
      await user.type(screen.getByLabelText(/password/i), "mypassword123");
      await user.click(screen.getByRole("button", { name: /^sign in$/i }));

      await waitFor(() => {
        expect(locationMock.href).toBe("/");
      });
    });

    it("blocks protocol-relative URL (//evil.com) and falls back to '/'", async () => {
      mockPost.mockResolvedValue({ data: session });
      mockSearchParams = { redirect: "//evil.com" };
      renderLoginPage();

      const user = userEvent.setup();
      await user.type(screen.getByLabelText(/email/i), "user@example.com");
      await user.type(screen.getByLabelText(/password/i), "mypassword123");
      await user.click(screen.getByRole("button", { name: /^sign in$/i }));

      await waitFor(() => {
        expect(locationMock.href).toBe("/");
      });
    });
  });

  describe("login error display", () => {
    it("shows error alert on 401 response", async () => {
      mockPost.mockRejectedValue(
        new ApiError(401, "INVALID_CREDENTIALS", "Unauthorized", "req-1"),
      );
      renderLoginPage();

      const user = userEvent.setup();
      await user.type(screen.getByLabelText(/email/i), "bad@example.com");
      await user.type(screen.getByLabelText(/password/i), "badpass");
      await user.click(screen.getByRole("button", { name: /^sign in$/i }));

      await waitFor(() => {
        expect(screen.getByRole("alert")).toBeInTheDocument();
      });
    });
  });
});
