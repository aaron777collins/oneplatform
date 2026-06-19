/**
 * Per-app, per-user persistent storage hook.
 *
 * Persists values as JSON through the App Service BFF (`/bff/storage/{key}`).
 * Values survive browser refresh because they are stored server-side, not in
 * `localStorage` or `sessionStorage`.
 *
 * **Constraints (C-7):**
 * - Keys: 1–128 characters, alphanumeric plus hyphens and underscores
 * - Values: serialisable as JSON, max 64 KB (enforced client-side before PUT)
 *
 * Optimistic updates: the local state is updated immediately on `setValue`,
 * before the PUT resolves, so the UI responds without waiting for the network.
 *
 * Guest sessions: the BFF stores values in short-lived guest session records.
 * `useAppStorage` behaves identically — expiry semantics are a server concern.
 *
 * @param key          - Storage key (1–128 alphanumeric, hyphen, or underscore characters).
 * @param defaultValue - Value to use until the BFF fetch completes or on error.
 * @returns A `[value, setValue, meta]` tuple.
 *
 * @example
 * ```tsx
 * const [theme, setTheme, { isLoading }] = useAppStorage('ui-theme', 'light');
 * ```
 */

import React from "react";
import { useAppContext } from "../provider/AppContext.js";
import type { AppSDKError } from "../types/entities.js";
import type { BffStorageGetResponse } from "../types/api.js";

// Injected by the build tool; tells us whether we're in a development build
// without importing from AppContext (to keep this module self-contained).
declare const __OP_DEV__: boolean | undefined;

// ─── Validation constants ──────────────────────────────────────────────────────

const MAX_KEY_LENGTH = 128;
const MAX_VALUE_BYTES = 64 * 1_024; // 64 KB
const VALID_KEY_PATTERN = /^[a-zA-Z0-9_-]+$/;

// ─── Return type ──────────────────────────────────────────────────────────────

export interface AppStorageMeta {
  error: Error | null;
  isLoading: boolean;
}

// The hook always returns a 3-tuple so callers can inspect the meta state
// without pattern-matching on exceptions. The setter is a no-op when the key
// is invalid — callers must check meta.error if they need to surface the issue.
export type UseAppStorageResult<T> = [T, (value: T) => Promise<void>, AppStorageMeta];

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useAppStorage<T>(
  key: string,
  defaultValue: T,
): UseAppStorageResult<T> {
  const { bffClient, isReady } = useAppContext();

  const isKeyValid =
    key.length > 0 && key.length <= MAX_KEY_LENGTH && VALID_KEY_PATTERN.test(key);

  // Warn in development when a key is invalid so misconfigured callers get
  // immediate feedback, but do NOT throw — a dynamic key that is momentarily
  // empty (e.g. derived from a loading state) must not permanently crash the
  // component. The hook returns a safe no-op state instead.
  if (!isKeyValid) {
    // Only emit in dev; in production the invalid key just results in a no-op
    // so the rest of the UI keeps working.
    // Mirror the same env detection pattern used in AppContext.ts
    if (typeof __OP_DEV__ !== "undefined" ? __OP_DEV__ : true) {
      console.error(
        `[app-sdk] useAppStorage key "${key}" is invalid. ` +
          "Keys must be 1-128 alphanumeric characters, hyphens, or underscores.",
      );
    }
  }

  const [value, setValueState] = React.useState<T>(defaultValue);
  const [isLoaded, setIsLoaded] = React.useState(false);

  // Load the stored value from the BFF on first mount (and when isReady becomes true).
  // Skipped entirely when the key is invalid so we never make a request with a
  // malformed path segment.
  React.useEffect(() => {
    if (!isReady || !isKeyValid) return;
    let cancelled = false;

    bffClient
      .request<{ data: BffStorageGetResponse } | BffStorageGetResponse>(`/bff/storage/${encodeURIComponent(key)}`)
      .then((res) => {
        if (!cancelled) {
          // BFF returns { data: { key, value, updatedAt } } envelope; unwrap if present.
          const storageData = (res as { data?: BffStorageGetResponse }).data ?? (res as BffStorageGetResponse);
          setValueState(storageData.value !== null ? (storageData.value as T) : defaultValue);
          setIsLoaded(true);
        }
      })
      .catch(() => {
        // Network or BFF error — fall back to defaultValue without crashing
        if (!cancelled) setIsLoaded(true);
      });

    return () => {
      cancelled = true;
    };
    // defaultValue is intentionally excluded to avoid re-fetching when a caller
    // passes a new defaultValue reference on each render. The initial defaultValue
    // is applied at mount; subsequent defaultValue changes are not applied.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady, isKeyValid, key, bffClient]);

  const setValue = React.useCallback(
    async (newValue: T): Promise<void> => {
      // No-op when the key is invalid; error is surfaced via meta.error below.
      if (!isKeyValid) return;

      // Client-side size guard (C-7): fail fast with a clear error rather than
      // letting the server return a 413 after the user has already waited.
      const serialised = JSON.stringify(newValue);
      const byteLength = new TextEncoder().encode(serialised).length;
      if (byteLength > MAX_VALUE_BYTES) {
        const error: AppSDKError = {
          code: "VALUE_TOO_LARGE",
          message:
            `Storage value for key "${key}" exceeds the 64 KB limit ` +
            `(${byteLength} bytes).`,
          statusCode: 0,
          isRetryable: false,
          requestId: "",
        };
        throw error;
      }

      // Optimistic update — apply locally before the network round-trip.
      // Capture the previous value so we can revert if the server request fails.
      const previousValue = value;
      setValueState(newValue);

      try {
        await bffClient.request(`/bff/storage/${encodeURIComponent(key)}`, {
          method: "PUT",
          body: { value: newValue },
        });
      } catch (err) {
        // Revert the optimistic update on failure so the UI stays consistent
        // with the persisted server state.
        setValueState(previousValue);
        throw err;
      }
    },
    [isKeyValid, key, bffClient, value],
  );

  const meta: AppStorageMeta = {
    error: isKeyValid
      ? null
      : new Error(
          `[app-sdk] useAppStorage key "${key}" is invalid. ` +
            "Keys must be 1-128 alphanumeric characters, hyphens, or underscores.",
        ),
    // Loading while the BFF fetch is outstanding (and key is valid)
    isLoading: isKeyValid && isReady && !isLoaded,
  };

  // Return defaultValue until the initial BFF fetch completes so the caller
  // never sees an uninitialised state.
  return [isLoaded ? value : defaultValue, setValue, meta];
}
