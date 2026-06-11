/**
 * RegisterForm tests
 *
 * Validates every Zod rule (display name length, password strength, confirm
 * password match), the POST payload shape, auth store side-effect on success,
 * and server error display.
 *
 * The invite token is passed as a prop — the parent page owns URL parsing.
 *
 * Each test creates a fresh userEvent instance to avoid pointer-state leakage
 * across tests (user-event v14 behaviour).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { RegisterForm } from "@/components/auth/RegisterForm.js";
import { ApiClientContext, ApiError } from "@/lib/api-client.js";
import { useAuthStore } from "@/stores/auth.store.js";

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
// Render helper
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

function makeForm(overrides?: {
  inviteToken?: string;
  onSuccess?: () => void;
}) {
  return (
    <RegisterForm
      inviteToken={overrides?.inviteToken ?? "token-abc"}
      onSuccess={overrides?.onSuccess ?? vi.fn()}
    />
  );
}

// ---------------------------------------------------------------------------
// Fill the form with valid defaults, overriding only specified fields
// ---------------------------------------------------------------------------

interface FieldValues {
  displayName?: string | null;
  email?: string | null;
  password?: string | null;
  confirmPassword?: string | null;
}

async function fillForm(
  user: ReturnType<typeof userEvent.setup>,
  values: FieldValues = {},
) {
  const {
    displayName = "Jane Smith",
    email = "jane@example.com",
    password = "ValidPass1234!",
    confirmPassword = undefined, // undefined means use the same as password
  } = values;

  const confirm = confirmPassword === undefined ? (password ?? "ValidPass1234!") : confirmPassword;

  if (displayName !== null && displayName !== undefined) {
    await user.type(screen.getByLabelText(/display name/i), displayName);
  }
  if (email !== null && email !== undefined) {
    await user.type(screen.getByLabelText(/^email$/i), email);
  }
  if (password !== null && password !== undefined) {
    await user.type(screen.getByLabelText(/^password$/i), password);
  }
  if (confirm !== null && confirm !== undefined) {
    await user.type(screen.getByLabelText(/confirm password/i), confirm);
  }
}

async function fillAndSubmit(
  user: ReturnType<typeof userEvent.setup>,
  values: FieldValues = {},
) {
  await fillForm(user, values);
  await user.click(screen.getByRole("button", { name: /create account/i }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RegisterForm", () => {
  beforeEach(() => {
    mockPost.mockReset();
  });

  afterEach(() => {
    resetAuthStore();
  });

  // -------------------------------------------------------------------------
  // Display name validation
  // -------------------------------------------------------------------------

  describe("displayName validation", () => {
    it("shows error when display name is too short (< 2 chars)", async () => {
      const user = userEvent.setup();
      renderWithClient(makeForm());
      // Type just one character — shorter than the min of 2
      await user.type(screen.getByLabelText(/display name/i), "A");
      await user.click(screen.getByRole("button", { name: /create account/i }));

      await waitFor(() => {
        expect(
          screen.getByText(/at least 2 characters/i),
        ).toBeInTheDocument();
      });
    });

    it("shows error when display name is too long (> 64 chars)", async () => {
      const user = userEvent.setup();
      renderWithClient(makeForm());
      await user.type(
        screen.getByLabelText(/display name/i),
        "A".repeat(65),
      );
      await user.click(screen.getByRole("button", { name: /create account/i }));

      await waitFor(() => {
        expect(
          screen.getByText(/at most 64 characters/i),
        ).toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  // Password strength validation
  // -------------------------------------------------------------------------

  describe("password validation", () => {
    it("shows error when password is shorter than 12 characters", async () => {
      const user = userEvent.setup();
      renderWithClient(makeForm());
      // "Short1!a" is 8 chars, below the 12-char minimum
      await fillAndSubmit(user, {
        password: "Short1!a",
        confirmPassword: "Short1!a",
      });

      await waitFor(() => {
        expect(screen.getByText(/at least 12 characters/i)).toBeInTheDocument();
      });
    });

    it("shows error when password has no uppercase letter", async () => {
      const user = userEvent.setup();
      renderWithClient(makeForm());
      await fillAndSubmit(user, {
        password: "alllowercase123",
        confirmPassword: "alllowercase123",
      });

      await waitFor(() => {
        expect(screen.getByText(/uppercase letter/i)).toBeInTheDocument();
      });
    });

    it("shows error when password has no lowercase letter", async () => {
      const user = userEvent.setup();
      renderWithClient(makeForm());
      await fillAndSubmit(user, {
        password: "ALLUPPERCASE123",
        confirmPassword: "ALLUPPERCASE123",
      });

      await waitFor(() => {
        expect(screen.getByText(/lowercase letter/i)).toBeInTheDocument();
      });
    });

    it("shows error when password has no number", async () => {
      const user = userEvent.setup();
      renderWithClient(makeForm());
      await fillAndSubmit(user, {
        password: "NoNumbersHereXX",
        confirmPassword: "NoNumbersHereXX",
      });

      await waitFor(() => {
        expect(screen.getByText(/contain a number/i)).toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  // Confirm password validation
  // -------------------------------------------------------------------------

  describe("confirmPassword validation", () => {
    it("shows error when passwords do not match", async () => {
      const user = userEvent.setup();
      renderWithClient(makeForm());
      await fillAndSubmit(user, {
        password: "ValidPass1234!",
        confirmPassword: "DifferentPass9!",
      });

      await waitFor(() => {
        expect(screen.getByText(/passwords do not match/i)).toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  // Successful submission
  // -------------------------------------------------------------------------

  describe("successful registration", () => {
    const session = {
      userId: "new-user-1",
      tenantId: "t-1",
      roles: ["viewer"],
      scopes: ["read"],
      isGuest: false,
      emailVerified: false,
    };

    beforeEach(() => {
      mockPost.mockResolvedValue({ data: session });
    });

    it("POSTs to /v1/auth/register with all required fields including inviteToken", async () => {
      const user = userEvent.setup();
      const onSuccess = vi.fn();
      renderWithClient(makeForm({ inviteToken: "invite-xyz", onSuccess }));

      await fillAndSubmit(user);

      // Wait for full async flow completion before asserting — prevents dangling
      // Promises from bleeding into subsequent tests when cleanup() unmounts.
      await waitFor(() => {
        expect(onSuccess).toHaveBeenCalledTimes(1);
      });
      expect(mockPost).toHaveBeenCalledWith(
        "/v1/auth/register",
        expect.objectContaining({
          displayName: "Jane Smith",
          email: "jane@example.com",
          password: "ValidPass1234!",
          inviteToken: "invite-xyz",
        }),
      );
    });

    it("does NOT include confirmPassword in the POST body", async () => {
      const user = userEvent.setup();
      const onSuccess = vi.fn();
      renderWithClient(makeForm({ onSuccess }));
      await fillAndSubmit(user);

      await waitFor(() => {
        expect(onSuccess).toHaveBeenCalledTimes(1);
      });
      const [, body] = mockPost.mock.calls[0] as [string, Record<string, unknown>];
      expect(body).not.toHaveProperty("confirmPassword");
    });

    it("calls setSession in the auth store on success", async () => {
      const user = userEvent.setup();
      renderWithClient(makeForm());
      await fillAndSubmit(user);

      await waitFor(() => {
        expect(useAuthStore.getState().isAuthenticated).toBe(true);
        expect(useAuthStore.getState().userId).toBe("new-user-1");
      });
    });

    it("invokes onSuccess callback after successful registration", async () => {
      const user = userEvent.setup();
      const onSuccess = vi.fn();
      renderWithClient(makeForm({ onSuccess }));
      await fillAndSubmit(user);

      await waitFor(() => {
        expect(onSuccess).toHaveBeenCalledTimes(1);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Server error handling
  // -------------------------------------------------------------------------

  describe("server error handling", () => {
    it("shows ApiError message as a role=alert banner", async () => {
      const user = userEvent.setup();
      mockPost.mockRejectedValue(
        new ApiError(
          409,
          "EMAIL_TAKEN",
          "An account with this email already exists",
          "req-1",
        ),
      );

      renderWithClient(makeForm());
      await fillAndSubmit(user);

      await waitFor(() => {
        const alert = screen.getByRole("alert");
        expect(alert).toBeInTheDocument();
        expect(alert.textContent).toMatch(
          /an account with this email already exists/i,
        );
      });
    });

    it("shows a generic message for non-ApiError exceptions", async () => {
      const user = userEvent.setup();
      mockPost.mockRejectedValue(new Error("Network failure"));

      renderWithClient(makeForm());
      await fillAndSubmit(user);

      await waitFor(() => {
        expect(screen.getByText(/unexpected error/i)).toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  // Submit button state
  // -------------------------------------------------------------------------

  describe("submit button", () => {
    it("shows 'Creating account…' and is disabled while submitting", async () => {
      const user = userEvent.setup();
      mockPost.mockReturnValue(new Promise(() => {}));

      renderWithClient(makeForm());
      await fillAndSubmit(user);

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /creating account/i }),
        ).toBeDisabled();
      });
    });
  });
});
