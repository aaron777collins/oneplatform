import { describe, it, expect, afterEach } from "vitest";
import { useAuthStore, type Session } from "@/stores/auth.store";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const INITIAL_STATE = {
  userId: null,
  tenantId: null,
  roles: [],
  scopes: [],
  isGuest: false,
  emailVerified: false,
  isLoading: true,
  isAuthenticated: false,
} as const;

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    userId: "user-1",
    tenantId: "tenant-1",
    roles: ["viewer"],
    scopes: ["read"],
    isGuest: false,
    emailVerified: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Reset the singleton between tests so each test starts from a known baseline.
//
// We use replace=true here but must re-attach every action from the store
// after wiping, because Zustand's replace mode removes function slices too.
// The cleanest alternative is to NOT use replace and instead merge only the
// data fields — that leaves the action closures untouched and avoids the
// re-attach step entirely.
// ---------------------------------------------------------------------------

afterEach(() => {
  // Merge-only reset: data fields return to initial values; action closures
  // already live in the store's closure scope and are never changed.
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
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useAuthStore", () => {
  describe("initial state", () => {
    it("isLoading is true", () => {
      expect(useAuthStore.getState().isLoading).toBe(true);
    });

    it("isAuthenticated is false", () => {
      expect(useAuthStore.getState().isAuthenticated).toBe(false);
    });

    it("userId is null", () => {
      expect(useAuthStore.getState().userId).toBeNull();
    });

    it("tenantId is null", () => {
      expect(useAuthStore.getState().tenantId).toBeNull();
    });

    it("roles is empty array", () => {
      expect(useAuthStore.getState().roles).toEqual([]);
    });

    it("scopes is empty array", () => {
      expect(useAuthStore.getState().scopes).toEqual([]);
    });

    it("isGuest is false", () => {
      expect(useAuthStore.getState().isGuest).toBe(false);
    });

    it("emailVerified is false", () => {
      expect(useAuthStore.getState().emailVerified).toBe(false);
    });
  });

  describe("setSession", () => {
    it("propagates all fields from session", () => {
      const session = makeSession({
        userId: "u-42",
        tenantId: "t-7",
        roles: ["data-engineer"],
        scopes: ["read", "write"],
        isGuest: false,
        emailVerified: true,
      });

      useAuthStore.getState().setSession(session);

      const state = useAuthStore.getState();
      expect(state.userId).toBe("u-42");
      expect(state.tenantId).toBe("t-7");
      expect(state.roles).toEqual(["data-engineer"]);
      expect(state.scopes).toEqual(["read", "write"]);
      expect(state.isGuest).toBe(false);
      expect(state.emailVerified).toBe(true);
    });

    it("isLoading becomes false after setSession", () => {
      useAuthStore.getState().setSession(makeSession());
      expect(useAuthStore.getState().isLoading).toBe(false);
    });

    it("isAuthenticated becomes true after setSession", () => {
      useAuthStore.getState().setSession(makeSession());
      expect(useAuthStore.getState().isAuthenticated).toBe(true);
    });
  });

  describe("clearSession", () => {
    it("resets all identity fields to initial values", () => {
      // Establish a session first so there is something to clear
      useAuthStore.getState().setSession(
        makeSession({ userId: "u-99", tenantId: "t-99", roles: ["admin"] }),
      );

      useAuthStore.getState().clearSession();

      const state = useAuthStore.getState();
      expect(state.userId).toBeNull();
      expect(state.tenantId).toBeNull();
      expect(state.roles).toEqual([]);
      expect(state.scopes).toEqual([]);
      expect(state.isGuest).toBe(false);
      expect(state.emailVerified).toBe(false);
    });

    it("isAuthenticated is false after clearSession", () => {
      useAuthStore.getState().setSession(makeSession());
      useAuthStore.getState().clearSession();
      expect(useAuthStore.getState().isAuthenticated).toBe(false);
    });

    it("isLoading is false after clearSession (loading is done, just unauthenticated)", () => {
      useAuthStore.getState().setSession(makeSession());
      useAuthStore.getState().clearSession();
      // clearSession marks the auth check as complete — not pending
      expect(useAuthStore.getState().isLoading).toBe(false);
    });
  });

  describe("setLoading", () => {
    it("setLoading(false) sets isLoading to false without touching other fields", () => {
      useAuthStore.getState().setSession(makeSession({ userId: "u-5" }));
      useAuthStore.getState().setLoading(false);

      const state = useAuthStore.getState();
      expect(state.isLoading).toBe(false);
      // setSession already set this; setLoading must not clear it
      expect(state.userId).toBe("u-5");
      expect(state.isAuthenticated).toBe(true);
    });

    it("setLoading(true) sets isLoading to true", () => {
      useAuthStore.getState().setSession(makeSession());
      useAuthStore.getState().setLoading(true);
      expect(useAuthStore.getState().isLoading).toBe(true);
    });
  });

  describe("hasPermission", () => {
    it('"platform-admin" role grants any permission check (supersedes all roles)', () => {
      // Merge-only: keeps action closures, only overwrites the roles field
      useAuthStore.setState({ roles: ["platform-admin"] });
      expect(useAuthStore.getState().hasPermission("data-engineer")).toBe(true);
    });

    it('"platform-admin" role grants its own role check too', () => {
      useAuthStore.setState({ roles: ["platform-admin"] });
      expect(useAuthStore.getState().hasPermission("platform-admin")).toBe(true);
    });

    it('"viewer" role grants "viewer" permission', () => {
      useAuthStore.setState({ roles: ["viewer"] });
      expect(useAuthStore.getState().hasPermission("viewer")).toBe(true);
    });

    it('"viewer" role does not grant "data-engineer" permission', () => {
      useAuthStore.setState({ roles: ["viewer"] });
      expect(useAuthStore.getState().hasPermission("data-engineer")).toBe(false);
    });

    it("empty roles denies all permission checks", () => {
      // Initial state already has empty roles; call directly
      expect(useAuthStore.getState().hasPermission("anything")).toBe(false);
    });
  });
});
