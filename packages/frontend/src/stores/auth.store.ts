import { create } from "zustand";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Session {
  userId: string;
  tenantId: string;
  roles: string[];
  scopes: string[];
  isGuest: boolean;
  emailVerified: boolean;
  /** User's email address — displayed in the topbar instead of UUID. */
  email?: string | null;
  /** User's human-readable display name (full name or username). */
  displayName?: string | null;
  /** Human-readable tenant name — displayed in the topbar instead of tenant UUID. */
  tenantName?: string | null;
}

interface AuthState {
  userId: string | null;
  tenantId: string | null;
  roles: string[];
  scopes: string[];
  isGuest: boolean;
  emailVerified: boolean;
  /** Populated from GET /v1/auth/me after login. Null until fetched. */
  email: string | null;
  /** Populated from GET /v1/auth/me after login. Null until fetched. */
  displayName: string | null;
  /** Populated from GET /v1/auth/me after login. Null until fetched. */
  tenantName: string | null;
  isLoading: boolean;
  isAuthenticated: boolean;

  // Actions
  setSession: (session: Session) => void;
  clearSession: () => void;
  setLoading: (loading: boolean) => void;
  /**
   * Returns true if the current user has the given role OR has platform-admin
   * (which supersedes all other role checks).
   */
  hasPermission: (requiredRole: string) => boolean;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useAuthStore = create<AuthState>()((set, get) => ({
  userId: null,
  tenantId: null,
  roles: [],
  scopes: [],
  isGuest: false,
  emailVerified: false,
  email: null,
  displayName: null,
  tenantName: null,
  isLoading: true,
  isAuthenticated: false,

  setSession: (session: Session): void => {
    set({
      userId: session.userId,
      tenantId: session.tenantId,
      roles: session.roles ?? [],
      scopes: session.scopes ?? [],
      isGuest: session.isGuest ?? false,
      emailVerified: session.emailVerified ?? false,
      email: session.email ?? null,
      displayName: session.displayName ?? null,
      tenantName: session.tenantName ?? null,
      isLoading: false,
      isAuthenticated: true,
    });
  },

  clearSession: (): void => {
    set({
      userId: null,
      tenantId: null,
      roles: [],
      scopes: [],
      isGuest: false,
      emailVerified: false,
      email: null,
      displayName: null,
      tenantName: null,
      isLoading: false,
      isAuthenticated: false,
    });
  },

  setLoading: (loading: boolean): void => {
    set({ isLoading: loading });
  },

  hasPermission: (requiredRole: string): boolean => {
    const { roles } = get();
    return roles.includes(requiredRole) || roles.includes("platform-admin");
  },
}));
