/**
 * AuthenticatedLayout — the parent route component for all protected routes.
 *
 * Wraps every authenticated page with:
 * 1. Auth check — redirects to /login if no valid session
 * 2. AppShell — sidebar + topbar + main content area (Layer 2)
 *
 * This is registered as a pathless route in router.tsx so it wraps all
 * children without appearing in the URL.
 */
import { Outlet, useNavigate } from "@tanstack/react-router";
import React, { useEffect } from "react";
import { useAuthStore } from "@/stores/auth.store.js";
import { useApiClient } from "@/lib/api-client.js";
import type { Session } from "@/stores/auth.store.js";
import type { ApiResponse } from "@/lib/api-client.js";

export function AuthenticatedLayout() {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const isLoading = useAuthStore((state) => state.isLoading);
  const setSession = useAuthStore((state) => state.setSession);
  const setLoading = useAuthStore((state) => state.setLoading);
  const client = useApiClient();
  const navigate = useNavigate();

  // Populate auth store from server on mount. Runs once per session.
  // On 401 the api-client redirects directly via window.location.href.
  useEffect(() => {
    if (isAuthenticated) return;

    void (async () => {
      try {
        const result = await client.get<ApiResponse<Session>>("/v1/auth/me");
        setSession(result.data);
      } catch {
        setLoading(false);
        void navigate({
          to: "/login",
          search: { redirect: window.location.pathname },
        });
      }
    })();
  }, [isAuthenticated, client, setSession, setLoading, navigate]);

  if (isLoading) {
    return (
      <div
        className="flex min-h-screen items-center justify-center"
        role="status"
        aria-label="Loading"
      >
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  if (!isAuthenticated) {
    // Redirect is in flight — render nothing to avoid flashing protected content
    return null;
  }

  // AppShell (sidebar + topbar + main) will be implemented in Layer 2.
  return (
    <div className="flex min-h-screen flex-col">
      <Outlet />
    </div>
  );
}
