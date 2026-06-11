import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useAuthStore } from "@/stores/auth.store.js";

// ---------------------------------------------------------------------------
// useSession — expose auth state to components
// ---------------------------------------------------------------------------

export interface SessionResult {
  userId: string | null;
  tenantId: string | null;
  roles: string[];
  scopes: string[];
  isGuest: boolean;
  isAuthenticated: boolean;
  isLoading: boolean;
}

export function useSession(): SessionResult {
  return useAuthStore((state) => ({
    userId: state.userId,
    tenantId: state.tenantId,
    roles: state.roles,
    scopes: state.scopes,
    isGuest: state.isGuest,
    isAuthenticated: state.isAuthenticated,
    isLoading: state.isLoading,
  }));
}

// ---------------------------------------------------------------------------
// useRequireAuth — redirect to /login if not authenticated
// ---------------------------------------------------------------------------

/**
 * Use this hook in protected components instead of wrapping with AuthGuard
 * when fine-grained control is needed. Redirects with `?redirect=<current>`
 * so the user returns here after login.
 */
export function useRequireAuth(): void {
  const { isAuthenticated, isLoading } = useAuthStore();
  const navigate = useNavigate();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      void navigate({
        to: "/login",
        search: { redirect: window.location.pathname },
      });
    }
  }, [isAuthenticated, isLoading, navigate]);
}

// ---------------------------------------------------------------------------
// usePermission — role-based gate
// ---------------------------------------------------------------------------

/**
 * Returns true if the current user has the given role.
 * platform-admin always returns true regardless of the requested role.
 */
export function usePermission(requiredRole: string): boolean {
  const roles = useAuthStore((state) => state.roles);
  return roles.includes(requiredRole) || roles.includes("platform-admin");
}

/**
 * Returns true if the current user has the given OAuth scope.
 */
export function useScope(requiredScope: string): boolean {
  const scopes = useAuthStore((state) => state.scopes);
  return scopes.includes(requiredScope);
}
