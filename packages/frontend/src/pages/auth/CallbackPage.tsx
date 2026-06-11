import React, { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useApiClient } from "@/lib/api-client.js";
import { useAuthStore } from "@/stores/auth.store.js";
import type { Session } from "@/stores/auth.store.js";
import type { ApiResponse } from "@/lib/api-client.js";

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
        const redirect = params.get("redirect") ?? "/";
        void navigate({ to: redirect as "/" });
      } catch {
        void navigate({ to: "/login" });
      }
    })();
  }, [client, navigate, setSession]);

  return (
    <div className="flex min-h-screen items-center justify-center" role="status">
      <p>Completing sign-in…</p>
    </div>
  );
}

function detectProvider(params: URLSearchParams): string {
  const state = params.get("state") ?? "";
  if (state.startsWith("github:")) return "github";
  if (state.startsWith("google:")) return "google";
  return "github";
}
