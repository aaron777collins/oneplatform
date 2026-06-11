/**
 * OAuthButton tests
 *
 * Verifies that clicking redirects to the correct provider-specific OAuth
 * authorize URL and that the button label and type are correct per provider.
 *
 * Full-page redirect is mocked by replacing window.location with a plain
 * object — the component writes to window.location.href which is normally
 * non-writable in jsdom.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";

import { OAuthButton } from "@/components/auth/OAuthButton.js";

// ---------------------------------------------------------------------------
// window.location mock — jsdom's location.href setter prevents navigation
// ---------------------------------------------------------------------------

const locationMock = { href: "", pathname: "/" };

beforeEach(() => {
  locationMock.href = "";
  Object.defineProperty(window, "location", {
    writable: true,
    value: locationMock,
    configurable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OAuthButton", () => {
  const user = userEvent.setup();

  describe("provider=github", () => {
    it("includes 'GitHub' in the button label", () => {
      render(<OAuthButton provider="github" />);
      expect(screen.getByRole("button", { name: /github/i })).toBeInTheDocument();
    });

    it("is type=button (not submit, to avoid accidental form submission)", () => {
      render(<OAuthButton provider="github" />);
      const btn = screen.getByRole("button", { name: /github/i });
      expect(btn).toHaveAttribute("type", "button");
    });

    it("sets window.location.href to the GitHub OAuth authorize URL on click", async () => {
      render(<OAuthButton provider="github" />);
      await user.click(screen.getByRole("button", { name: /github/i }));

      expect(locationMock.href).toBe("/api/v1/auth/oauth/github/authorize");
    });

    it("URL starts with /api/ (routes through the server, not a third-party URL)", async () => {
      render(<OAuthButton provider="github" />);
      await user.click(screen.getByRole("button", { name: /github/i }));

      expect(locationMock.href).toMatch(/^\/api\//);
    });
  });

  describe("provider=google", () => {
    it("includes 'Google' in the button label", () => {
      render(<OAuthButton provider="google" />);
      expect(screen.getByRole("button", { name: /google/i })).toBeInTheDocument();
    });

    it("is type=button", () => {
      render(<OAuthButton provider="google" />);
      const btn = screen.getByRole("button", { name: /google/i });
      expect(btn).toHaveAttribute("type", "button");
    });

    it("sets window.location.href to the Google OAuth authorize URL on click", async () => {
      render(<OAuthButton provider="google" />);
      await user.click(screen.getByRole("button", { name: /google/i }));

      expect(locationMock.href).toBe("/api/v1/auth/oauth/google/authorize");
    });
  });
});
