/**
 * LoginPage — centered card layout for the email/password login flow.
 *
 * Reads the ?redirect search param so AuthGuard's redirect-back mechanism
 * works correctly after login. OAuth buttons trigger server-side OAuth flows.
 */
import React from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { LoginForm } from "@/components/auth/LoginForm.js";
import { OAuthButton } from "@/components/auth/OAuthButton.js";

const REGISTRATION_ENABLED = false;
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card.js";
import { Separator } from "@/components/ui/separator.js";
import { safeRedirect } from "@/lib/auth-utils.js";

export function LoginPage() {
  const navigate = useNavigate();
  // The redirect param is set by AuthGuard when it bounces unauthenticated
  // users to /login. It is always a relative pathname (never an external URL).
  const search = useSearch({ from: "/login" });
  // The search type comes from the router — cast to access optional redirect
  const rawRedirect =
    typeof (search as Record<string, unknown>)["redirect"] === "string"
      ? (search as Record<string, unknown>)["redirect"] as string
      : "/";
  const redirectTo = safeRedirect(rawRedirect);

  function handleLoginSuccess(): void {
    // Use window.location for a full reload that re-runs the bootstrap gate
    // and rehydrates the auth store from GET /api/v1/auth/me.
    window.location.href = redirectTo;
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--color-background)] px-4">
      <div className="w-full max-w-md space-y-6">
        {/* Brand header — above the card */}
        <div className="text-center">
          <h1 className="text-2xl font-bold text-[var(--color-foreground)]">
            OnePlatform
          </h1>
          <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
            Sign in to your account
          </p>
        </div>

        <Card>
          <CardHeader className="space-y-1">
            <CardTitle className="text-lg">Sign in</CardTitle>
            <CardDescription>
              Enter your email and password to continue
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-4">
            <LoginForm onSuccess={handleLoginSuccess} />

            <div className="relative">
              <Separator />
              <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-[var(--color-card)] px-2 text-xs text-[var(--color-muted-foreground)]">
                or
              </span>
            </div>

            <div className="space-y-2">
              <OAuthButton provider="github" />
              <OAuthButton provider="google" />
            </div>
          </CardContent>
        </Card>

        {/* Registration link — hidden until a /register route and self-serve
            signup flow are implemented. The server does not expose a public
            registration endpoint; new users are invited by a tenant admin.
            Re-enable this once M-17 (registration page) ships. */}
        {REGISTRATION_ENABLED && (
          <p className="text-center text-sm text-[var(--color-muted-foreground)]">
            Have an invite?{" "}
            <button
              type="button"
              className="text-[var(--color-primary)] hover:underline"
              onClick={() => void navigate({ to: "/login", search: { mode: "register" } })}
            >
              Register
            </button>
          </p>
        )}
      </div>
    </main>
  );
}
