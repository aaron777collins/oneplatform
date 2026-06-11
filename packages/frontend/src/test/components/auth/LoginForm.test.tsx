/**
 * LoginForm tests
 *
 * Covers client-side validation, successful login, server error mapping (401 vs
 * other ApiError), button disabled state during submission, and the role="alert"
 * error banner.
 *
 * The API client is mocked via context so no real HTTP calls are made.
 *
 * Each test creates a fresh userEvent instance — sharing an instance across
 * tests causes pointer-state leakage in user-event v14.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { LoginForm } from "@/components/auth/LoginForm.js";
import { ApiClientContext, ApiError } from "@/lib/api-client.js";
import { useAuthStore } from "@/stores/auth.store.js";

// ---------------------------------------------------------------------------
// Router mock — LoginForm uses Link for "Forgot password?"
// ---------------------------------------------------------------------------

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement("a", props, children),
  useNavigate: () => vi.fn(),
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
// Do NOT pass true (replace-entire-state) here — that strips the action
// functions from the store, causing "setSession is not a function" in
// components that read actions via the selector hook.
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
// Render helper — wraps with QueryClientProvider + ApiClientContext
// ---------------------------------------------------------------------------

function renderWithClient(ui: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <ApiClientContext.Provider value={mockClient}>
        {ui}
      </ApiClientContext.Provider>
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LoginForm", () => {
  beforeEach(() => {
    // mockReset clears call history and implementations.
    // Each nested beforeEach that sets implementations runs AFTER this.
    mockPost.mockReset();
  });

  afterEach(() => {
    resetAuthStore();
  });

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  describe("client-side validation", () => {
    it("shows email validation error when email is empty on submit", async () => {
      const user = userEvent.setup();
      renderWithClient(<LoginForm onSuccess={vi.fn()} />);
      await user.click(screen.getByRole("button", { name: /sign in/i }));

      await waitFor(() => {
        expect(screen.getByText(/valid email/i)).toBeInTheDocument();
      });
    });

    it("shows email validation error when email is invalid", async () => {
      const user = userEvent.setup();
      renderWithClient(<LoginForm onSuccess={vi.fn()} />);
      await user.type(screen.getByLabelText(/email/i), "not-an-email");
      await user.click(screen.getByRole("button", { name: /sign in/i }));

      await waitFor(() => {
        expect(screen.getByText(/valid email/i)).toBeInTheDocument();
      });
    });

    it("shows password validation error when password is empty", async () => {
      const user = userEvent.setup();
      renderWithClient(<LoginForm onSuccess={vi.fn()} />);
      await user.type(screen.getByLabelText(/email/i), "test@example.com");
      await user.click(screen.getByRole("button", { name: /sign in/i }));

      await waitFor(() => {
        expect(screen.getByText(/password is required/i)).toBeInTheDocument();
      });
    });

    it("does not call POST when validation fails", async () => {
      const user = userEvent.setup();
      renderWithClient(<LoginForm onSuccess={vi.fn()} />);
      await user.click(screen.getByRole("button", { name: /sign in/i }));

      await waitFor(() => {
        expect(screen.getByText(/valid email/i)).toBeInTheDocument();
      });
      expect(mockPost).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Successful submission
  // -------------------------------------------------------------------------

  describe("successful login", () => {
    const session = {
      userId: "u-1",
      tenantId: "t-1",
      roles: ["viewer"],
      scopes: ["read"],
      isGuest: false,
      emailVerified: true,
    };

    beforeEach(() => {
      mockPost.mockResolvedValue({ data: session });
    });

    it("calls POST /v1/auth/login with email and password", async () => {
      const user = userEvent.setup();
      const onSuccess = vi.fn();
      renderWithClient(<LoginForm onSuccess={onSuccess} />);
      await user.type(screen.getByLabelText(/email/i), "test@example.com");
      await user.type(screen.getByLabelText(/password/i), "mypassword123");
      await user.click(screen.getByRole("button", { name: /sign in/i }));

      // Wait for the full async flow (including setSession + onSuccess) so no
      // dangling Promises bleed into the next test when cleanup() unmounts.
      await waitFor(() => {
        expect(onSuccess).toHaveBeenCalledTimes(1);
      });
      expect(mockPost).toHaveBeenCalledWith(
        "/v1/auth/login",
        { email: "test@example.com", password: "mypassword123" },
      );
    });

    it("calls setSession in the auth store on success", async () => {
      const user = userEvent.setup();
      renderWithClient(<LoginForm onSuccess={vi.fn()} />);
      await user.type(screen.getByLabelText(/email/i), "test@example.com");
      await user.type(screen.getByLabelText(/password/i), "mypassword123");
      await user.click(screen.getByRole("button", { name: /sign in/i }));

      await waitFor(() => {
        expect(useAuthStore.getState().isAuthenticated).toBe(true);
        expect(useAuthStore.getState().userId).toBe("u-1");
      });
    });

    it("invokes the onSuccess callback after successful login", async () => {
      const user = userEvent.setup();
      const onSuccess = vi.fn();
      renderWithClient(<LoginForm onSuccess={onSuccess} />);
      await user.type(screen.getByLabelText(/email/i), "test@example.com");
      await user.type(screen.getByLabelText(/password/i), "mypassword123");
      await user.click(screen.getByRole("button", { name: /sign in/i }));

      await waitFor(() => {
        expect(onSuccess).toHaveBeenCalledTimes(1);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  describe("error handling", () => {
    it("shows 'Invalid email or password' on 401 response", async () => {
      const user = userEvent.setup();
      mockPost.mockRejectedValue(
        new ApiError(401, "INVALID_CREDENTIALS", "Unauthorized", "req-1"),
      );

      renderWithClient(<LoginForm onSuccess={vi.fn()} />);
      await user.type(screen.getByLabelText(/email/i), "wrong@example.com");
      await user.type(screen.getByLabelText(/password/i), "badpassword");
      await user.click(screen.getByRole("button", { name: /sign in/i }));

      await waitFor(() => {
        expect(
          screen.getByText(/invalid email or password/i),
        ).toBeInTheDocument();
      });
    });

    it("renders the error message with role=alert", async () => {
      const user = userEvent.setup();
      mockPost.mockRejectedValue(
        new ApiError(401, "INVALID_CREDENTIALS", "Unauthorized", "req-1"),
      );

      renderWithClient(<LoginForm onSuccess={vi.fn()} />);
      await user.type(screen.getByLabelText(/email/i), "wrong@example.com");
      await user.type(screen.getByLabelText(/password/i), "badpassword");
      await user.click(screen.getByRole("button", { name: /sign in/i }));

      await waitFor(() => {
        expect(screen.getByRole("alert")).toBeInTheDocument();
      });
    });

    it("shows the ApiError message for non-401 errors", async () => {
      const user = userEvent.setup();
      mockPost.mockRejectedValue(
        new ApiError(
          500,
          "INTERNAL_ERROR",
          "Something went wrong on the server",
          "req-2",
        ),
      );

      renderWithClient(<LoginForm onSuccess={vi.fn()} />);
      await user.type(screen.getByLabelText(/email/i), "test@example.com");
      await user.type(screen.getByLabelText(/password/i), "mypassword123");
      await user.click(screen.getByRole("button", { name: /sign in/i }));

      await waitFor(() => {
        expect(
          screen.getByText(/something went wrong on the server/i),
        ).toBeInTheDocument();
      });
    });

    it("shows a generic message for non-ApiError exceptions", async () => {
      const user = userEvent.setup();
      mockPost.mockRejectedValue(new Error("Network failure"));

      renderWithClient(<LoginForm onSuccess={vi.fn()} />);
      await user.type(screen.getByLabelText(/email/i), "test@example.com");
      await user.type(screen.getByLabelText(/password/i), "mypassword123");
      await user.click(screen.getByRole("button", { name: /sign in/i }));

      await waitFor(() => {
        expect(
          screen.getByText(/unexpected error/i),
        ).toBeInTheDocument();
      });
    });

    it("clears the previous server error when a new submission starts", async () => {
      const user = userEvent.setup();
      // First call fails, second call succeeds
      mockPost
        .mockRejectedValueOnce(
          new ApiError(401, "INVALID_CREDENTIALS", "Unauthorized", "req-1"),
        )
        .mockResolvedValueOnce({
          data: {
            userId: "u-1",
            tenantId: "t-1",
            roles: [],
            scopes: [],
            isGuest: false,
            emailVerified: true,
          },
        });

      renderWithClient(<LoginForm onSuccess={vi.fn()} />);

      // First submission — expect error to appear
      await user.type(screen.getByLabelText(/email/i), "bad@example.com");
      await user.type(screen.getByLabelText(/password/i), "badpass");
      await user.click(screen.getByRole("button", { name: /sign in/i }));
      await waitFor(() => {
        expect(screen.getByRole("alert")).toBeInTheDocument();
      });

      // Second submission — error should be cleared (role="alert" gone after success)
      await user.clear(screen.getByLabelText(/email/i));
      await user.clear(screen.getByLabelText(/password/i));
      await user.type(screen.getByLabelText(/email/i), "good@example.com");
      await user.type(screen.getByLabelText(/password/i), "goodpass");
      await user.click(screen.getByRole("button", { name: /sign in/i }));
      await waitFor(() => {
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  // Submit button state
  // -------------------------------------------------------------------------

  describe("submit button", () => {
    it("button is enabled in idle state", () => {
      renderWithClient(<LoginForm onSuccess={vi.fn()} />);
      const btn = screen.getByRole("button", { name: /sign in/i });
      expect(btn).not.toBeDisabled();
    });

    it("button shows 'Signing in…' text while the request is in flight", async () => {
      const user = userEvent.setup();
      // Never resolves so button stays in submitting state
      mockPost.mockReturnValue(new Promise(() => {}));

      renderWithClient(<LoginForm onSuccess={vi.fn()} />);
      await user.type(screen.getByLabelText(/email/i), "test@example.com");
      await user.type(screen.getByLabelText(/password/i), "mypassword123");
      await user.click(screen.getByRole("button", { name: /sign in/i }));

      await waitFor(() => {
        expect(screen.getByRole("button", { name: /signing in/i })).toBeDisabled();
      });
    });
  });
});
