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
}

interface AuthState {
  userId: string | null;
  tenantId: string | null;
  roles: string[];
  scopes: string[];
  isGuest: boolean;
  emailVerified: boolean;
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
  isLoading: true,
  isAuthenticated: false,

  setSession: (session: Session): void => {
    set({
      userId: session.userId,
      tenantId: session.tenantId,
      roles: session.roles,
      scopes: session.scopes,
      isGuest: session.isGuest,
      emailVerified: session.emailVerified,
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
