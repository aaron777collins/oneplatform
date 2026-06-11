/**
 * Per-app, per-user persistent storage hook.
 *
 * Persists values as JSON through the App Service BFF (/bff/storage/{key}).
 * Values survive browser refresh because they are stored server-side, not in
 * localStorage or sessionStorage.
 *
 * Constraints (C-7):
 * - Keys: 1-128 characters, alphanumeric plus hyphens and underscores
 * - Values: serialisable as JSON, max 64 KB (enforced client-side before PUT)
 *
 * Optimistic updates: the local state is updated immediately on setValue,
 * before the PUT resolves, so the UI responds without waiting for the network.
 *
 * Guest sessions: the BFF stores values in short-lived guest session records.
 * useAppStorage behaves identically — expiry semantics are a server concern.
 */

import React from "react";
import { useAppContext } from "../provider/AppContext.js";
import type { AppSDKError } from "../types/entities.js";
import type { BffStorageGetResponse } from "../types/api.js";

// ─── Validation constants ──────────────────────────────────────────────────────

const MAX_KEY_LENGTH = 128;
const MAX_VALUE_BYTES = 64 * 1_024; // 64 KB
const VALID_KEY_PATTERN = /^[a-zA-Z0-9_-]+$/;

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useAppStorage<T>(
  key: string,
  defaultValue: T,
): [T, (value: T) => Promise<void>] {
  const { bffClient, isReady } = useAppContext();

  // Validate key at render time so misconfigured callers fail loudly (C-7).
  // This is a programming error, not a runtime error — throw immediately.
  if (key.length === 0 || key.length > MAX_KEY_LENGTH || !VALID_KEY_PATTERN.test(key)) {
    throw new Error(
      `[app-sdk] useAppStorage key "${key}" is invalid. ` +
        "Keys must be 1-128 alphanumeric characters, hyphens, or underscores.",
    );
  }

  const [value, setValueState] = React.useState<T>(defaultValue);
  const [isLoaded, setIsLoaded] = React.useState(false);

  // Load the stored value from the BFF on first mount (and when isReady becomes true)
  React.useEffect(() => {
    if (!isReady) return;
    let cancelled = false;

    bffClient
      .request<BffStorageGetResponse>(`/bff/storage/${encodeURIComponent(key)}`)
      .then((res) => {
        if (!cancelled) {
          setValueState(res.value !== null ? (res.value as T) : defaultValue);
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
  }, [isReady, key, bffClient]);

  const setValue = React.useCallback(
    async (newValue: T): Promise<void> => {
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

      // Optimistic update — apply locally before the network round-trip
      setValueState(newValue);

      await bffClient.request(`/bff/storage/${encodeURIComponent(key)}`, {
        method: "PUT",
        body: { value: newValue },
      });
    },
    [key, bffClient],
  );

  // Return defaultValue until the initial BFF fetch completes so the caller
  // never sees an uninitialised state.
  return [isLoaded ? value : defaultValue, setValue];
}
