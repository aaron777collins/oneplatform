/**
 * CallbackPage — handles the OAuth provider redirect back to the app.
 *
 * The provider redirects to /auth/callback?code=...&state=... after the user
 * authorizes. This page exchanges the code+state with the server, which
 * validates the PKCE verifier and sets the op_session cookie.
 *
 * Provider detection reads the state param prefix (set by the server):
 *   "github:..." → github
 *   "google:..." → google
 *
 * On failure the user is sent back to /login rather than showing an error
 * page — retrying is preferable to a dead-end error screen.
 */
import React, { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useApiClient } from "@/lib/api-client.js";
import { useAuthStore } from "@/stores/auth.store.js";
import type { Session } from "@/stores/auth.store.js";
import type { ApiResponse } from "@/lib/api-client.js";
import { Loader2 } from "lucide-react";

export function CallbackPage() {
  const navigate = useNavigate();
  const client = useApiClient();
  const setSession = useAuthStore((state) => state.setSession);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");
    const provider = detectProvider(params);

    if (!code || !state) {
      void navigate({ to: "/login" });
      return;
    }

    void (async () => {
      try {
        const result = await client.post<ApiResponse<Session>>(
          `/v1/auth/oauth/${provider}/callback`,
          { code, state },
        );
        setSession(result.data);

        // Navigate to the stored redirect param or fall back to root.
        // Using window.location for a full reload so the bootstrap gate
        // re-runs and the auth store rehydrates cleanly.
        const redirect = params.get("redirect") ?? "/";
        window.location.href = redirect;
      } catch {
        // Any error sends back to login — the user can retry the OAuth flow
        void navigate({ to: "/login" });
      }
    })();
  }, [client, navigate, setSession]);

  return (
    <main
      className="flex min-h-screen items-center justify-center"
      role="status"
      aria-label="Completing sign-in…"
    >
      <div className="flex flex-col items-center gap-3 text-center">
        <Loader2
          className="h-8 w-8 animate-spin text-[var(--color-primary)]"
          aria-hidden="true"
        />
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Completing sign-in…
        </p>
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function detectProvider(params: URLSearchParams): string {
  const state = params.get("state") ?? "";
  if (state.startsWith("github:")) return "github";
  if (state.startsWith("google:")) return "google";
  // Default to github for backward compatibility if prefix is absent
  return "github";
}
