/**
 * Shared test utilities — import from here instead of @testing-library/react
 * to ensure every test gets consistent provider wrapping.
 *
 * Why a fresh QueryClient per test:
 *   - retry: false prevents silent re-runs that mask assertion timing
 *   - gcTime: 0 keeps garbage collection deterministic (no stale cache bleed)
 */
import React, { type ReactElement } from "react";
import { render, type RenderOptions } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi } from "vitest";
import { ApiClientContext, type ApiClient } from "@/lib/api-client.js";
import { useAuthStore, type Session } from "@/stores/auth.store.js";

// ---------------------------------------------------------------------------
// Mock API client factory
// ---------------------------------------------------------------------------

/**
 * Returns a typed mock implementing ApiClient. Each method returns
 * `Promise.resolve(undefined)` by default and can be overridden per-test
 * with `mockResolvedValueOnce` / `mockImplementation`.
 */
export function createMockApiClient(): ApiClient {
  return {
    get: vi.fn().mockResolvedValue(undefined),
    post: vi.fn().mockResolvedValue(undefined),
    put: vi.fn().mockResolvedValue(undefined),
    patch: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Session factory
// ---------------------------------------------------------------------------

/**
 * Produces a Session with safe, read-only defaults suitable for most tests.
 * Override individual fields via `overrides` rather than building from scratch.
 */
export function createMockSession(overrides?: Partial<Session>): Session {
  return {
    userId: "u1",
    tenantId: "t1",
    roles: ["viewer"],
    scopes: [],
    isGuest: false,
    emailVerified: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Auth store helpers
// ---------------------------------------------------------------------------

/** Seeds the Zustand auth store with a session — call in beforeEach. */
export function seedAuthStore(session: Session): void {
  useAuthStore.getState().setSession(session);
}

/** Resets the Zustand auth store to unauthenticated state — call in afterEach. */
export function clearAuthStore(): void {
  useAuthStore.getState().clearSession();
}

// ---------------------------------------------------------------------------
// renderWithProviders
// ---------------------------------------------------------------------------

interface RenderWithProvidersOptions extends Omit<RenderOptions, "wrapper"> {
  /** Override the mock API client injected into ApiClientContext. */
  apiClient?: ApiClient;
  /**
   * Sets window.location.pathname before render so router-aware components
   * see the expected path. Defaults to "/".
   */
  initialPath?: string;
}

/**
 * Renders `ui` inside all required application providers.
 *
 * Providers applied (outer → inner):
 *   1. QueryClientProvider — fresh client per test, no retries, no gc delay
 *   2. ApiClientContext.Provider — mock client (overridable via options)
 *
 * @tanstack/react-router is intentionally NOT included here because router
 * setup is complex and test-specific. Components that require routing should
 * set up their own router wrapper or use a MemoryRouter equivalent.
 */
export function renderWithProviders(
  ui: ReactElement,
  options: RenderWithProvidersOptions = {},
): ReturnType<typeof render> {
  const { apiClient, initialPath, ...renderOptions } = options;

  // Isolate each test's query cache completely
  const testQueryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });

  const mockClient = apiClient ?? createMockApiClient();

  // Set the path before rendering so any synchronous router reads see it
  if (initialPath !== undefined) {
    window.history.replaceState({}, "", initialPath);
  }

  function Wrapper({ children }: { children: React.ReactNode }): ReactElement {
    return (
      <QueryClientProvider client={testQueryClient}>
        <ApiClientContext.Provider value={mockClient}>
          {children}
        </ApiClientContext.Provider>
      </QueryClientProvider>
    );
  }

  return render(ui, { wrapper: Wrapper, ...renderOptions });
}

// Re-export everything from @testing-library/react so tests only need one import
export * from "@testing-library/react";
