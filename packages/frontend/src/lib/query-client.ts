import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "./api-client.js";

/**
 * Singleton QueryClient with platform-wide defaults.
 *
 * staleTime of 30s is appropriate for platform data that changes infrequently
 * (connector configs, ontology, app lists). Individual hooks override this for
 * data that changes more frequently (e.g., pipeline runs use 10s, logs use 5s).
 *
 * Retry policy: never retry 4xx errors because they indicate a client error
 * that won't resolve on retry. Retry 5xx up to 2 times (the api-client already
 * handles 5xx retries internally, so this is a safety net for unexpected cases).
 *
 * The authStore is not imported here to avoid a circular dependency. Instead,
 * configureAuthStore() is called from main.tsx after both modules are initialized.
 */

let clearSessionCallback: (() => void) | null = null;

export function configureQueryClientAuth(onClearSession: () => void): void {
  clearSessionCallback = onClearSession;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60 * 1000,
      retry: (failureCount: number, error: unknown): boolean => {
        if (error instanceof ApiError && error.statusCode < 500) return false;
        return failureCount < 2;
      },
      refetchOnWindowFocus: true,
    },
    mutations: {
      onError: (error: unknown): void => {
        if (error instanceof ApiError && error.statusCode === 401) {
          clearSessionCallback?.();
        }
      },
    },
  },
});
