/**
 * AuthGuard — wraps any content that requires an authenticated session.
 *
 * Reads the auth store's isAuthenticated/isLoading state, which is populated
 * on app mount by the GET /api/v1/auth/me query (see main.tsx). Shows a
 * skeleton while the initial session check is in flight so users on slow
 * connections don't see a flash-redirect to /login.
 *
 * The return URL is appended so the user is sent back to the protected page
 * after completing login.
 */
import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAuthStore } from "@/stores/auth.store.js";
import { Skeleton } from "@/components/ui/skeleton.js";

interface AuthGuardProps {
  children: React.ReactNode;
}

export function AuthGuard({ children }: AuthGuardProps) {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const isLoading = useAuthStore((state) => state.isLoading);
  const navigate = useNavigate();

  React.useEffect(() => {
    // Only redirect once the initial session check completes — during loading
    // the session may still be valid but not yet confirmed.
    if (!isLoading && !isAuthenticated) {
      void navigate({
        to: "/login",
        search: { redirect: window.location.pathname },
      });
    }
  }, [isAuthenticated, isLoading, navigate]);

  if (isLoading) {
    return <AuthLoadingSkeleton />;
  }

  if (!isAuthenticated) {
    // Navigation is in flight; render nothing so there is no content flash.
    return null;
  }

  return <>{children}</>;
}

// ---------------------------------------------------------------------------
// Loading skeleton — matches the authenticated shell shape to prevent layout
// shift. Shown for the duration of the GET /api/v1/auth/me request.
// ---------------------------------------------------------------------------

function AuthLoadingSkeleton() {
  return (
    <div
      className="flex min-h-screen"
      role="status"
      aria-label="Checking authentication…"
    >
      {/* Sidebar skeleton */}
      <div className="w-60 shrink-0 border-r border-[var(--color-border)] p-4 space-y-3">
        <Skeleton className="h-8 w-32" />
        <div className="space-y-2 pt-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-6 w-full" />
          ))}
        </div>
      </div>

      {/* Main content skeleton */}
      <div className="flex-1 p-8 space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-48" />
        <div className="grid grid-cols-3 gap-4 pt-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-32 w-full rounded-lg" />
          ))}
        </div>
      </div>
    </div>
  );
}
