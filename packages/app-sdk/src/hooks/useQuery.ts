/**
 * Data fetching hook for platform entities.
 *
 * Fetches GET /bff/data/{entity} with filtering, sorting, and cursor pagination.
 * Implements stale-while-revalidate: cached data is returned immediately while
 * a background refetch runs if the entry is older than staleTime.
 *
 * Deduplication: concurrent useQuery calls with the same (entity, options) key
 * share one in-flight fetch via the module-level QueryCache singleton.
 *
 * fetchNextPage appends to the existing data[] rather than replacing it —
 * callers accumulate pages incrementally (infinite scroll pattern).
 */

import React from "react";
import { useAppContext } from "../provider/AppContext.js";
import { queryCache } from "../cache/QueryCache.js";
import { buildFilterParams } from "../client/BffClient.js";
import { isAppSDKError, toAppSDKError } from "../client/errors.js";
import type { QueryOptions, QueryResult, AppSDKError, Pagination } from "../types/entities.js";
import type { BffDataResponse } from "../types/api.js";

// ─── Cache key builder ─────────────────────────────────────────────────────────

/**
 * Builds a stable cache key from the query identity fields.
 * cursor and staleTime are intentionally excluded: cursor is managed internally
 * by the hook's page list, and staleTime controls eviction policy, not identity.
 */
function buildCacheKey(entity: string, options: QueryOptions): string {
  return JSON.stringify({
    entity,
    filter: options.filter ?? null,
    sort: options.sort ?? null,
    fields: options.fields ?? null,
    limit: options.limit ?? 50,
  });
}

// ─── Query parameter builder ───────────────────────────────────────────────────

function buildQueryParams(
  options: QueryOptions,
  cursor: string | undefined,
): Record<string, string | number | boolean | string[]> {
  const params: Record<string, string | number | boolean | string[]> = {};

  if (options.filter) {
    const filterParams = buildFilterParams(options.filter);
    for (const [k, v] of Object.entries(filterParams)) {
      params[k] = v;
    }
  }

  if (options.sort?.length) {
    params["sort"] = options.sort;
  }

  if (options.fields?.length) {
    params["fields"] = options.fields;
  }

  if (cursor) {
    params["cursor"] = cursor;
  }

  params["limit"] = options.limit ?? 50;

  return params;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useQuery<T = unknown>(
  entity: string,
  options: QueryOptions = {},
): QueryResult<T> {
  const { bffClient, isReady } = useAppContext();
  const staleTime = options.staleTime ?? 30_000;
  const enabled = options.enabled !== false;

  const cacheKey = React.useMemo(
    () => buildCacheKey(entity, options),
    // options dependency is intentionally coarse — if the caller passes a new
    // options literal each render, staleTime prevents redundant network calls.
    // App developers should memoize options objects for optimal performance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entity, options.filter, options.sort, options.fields, options.limit],
  );

  // useSyncExternalStore drives re-renders when QueryCache updates the entry.
  // This is the correct React 18 primitive for subscribing to an external mutable store.
  const cachedEntry = React.useSyncExternalStore(
    React.useCallback(
      (notify: () => void) => queryCache.subscribe(cacheKey, notify),
      [cacheKey],
    ),
    React.useCallback(() => queryCache.get<T>(cacheKey), [cacheKey]),
  );

  // Tracks the cursor chain for fetchNextPage across renders
  const cursorsRef = React.useRef<string[]>([]);

  // Holds the AbortController for the currently active fetch so the cleanup
  // function can abort it when the component unmounts or the effect re-runs.
  const abortControllerRef = React.useRef<AbortController | null>(null);

  const fetchPage = React.useCallback(
    async (cursor: string | undefined, append: boolean): Promise<void> => {
      const controller = new AbortController();
      // Replace any previous controller; the old request is already settled or
      // will be ignored because its abort signal fires independently.
      abortControllerRef.current = controller;
      const params = buildQueryParams(options, cursor);

      try {
        const result = await bffClient.request<BffDataResponse<T>>(
          `/bff/data/${encodeURIComponent(entity)}`,
          { queryParams: params, signal: controller.signal },
        );

        const existingData = queryCache.get<T>(cacheKey)?.data ?? [];
        queryCache.set<T>(cacheKey, {
          data: append ? [...existingData, ...result.data] : result.data,
          pagination: result.pagination,
          error: null,
          fetchedAt: Date.now(),
          promise: null,
        });
      } catch (err) {
        // AbortError means the hook unmounted or the effect was re-triggered — silently ignore
        if (err instanceof Error && err.name === "AbortError") return;

        const sdkError: AppSDKError = isAppSDKError(err) ? err : toAppSDKError(err);
        const existing = queryCache.get<T>(cacheKey);
        queryCache.set<T>(cacheKey, {
          data: existing?.data ?? null,
          pagination: existing?.pagination ?? null,
          error: sdkError,
          fetchedAt: Date.now(),
          promise: null,
        });
        options.onError?.(sdkError);
      }
    },
    // Intentionally stable: rebuilding fetchPage on every options change would
    // invalidate the useEffect below and cause refetches on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entity, cacheKey, bffClient],
  );

  // Initial fetch + stale-while-revalidate
  React.useEffect(() => {
    if (!isReady || !enabled) return;

    if (queryCache.isStale(cacheKey, staleTime)) {
      cursorsRef.current = [];
      void fetchPage(undefined, false);
    }

    // Abort the in-flight request when the effect cleanup runs (unmount or
    // dependency change). This prevents a stale response from updating the
    // cache after the component has navigated away.
    return () => {
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
    };
  }, [isReady, enabled, cacheKey, staleTime, fetchPage]);

  const refetch = React.useCallback((): Promise<void> => {
    cursorsRef.current = [];
    return fetchPage(undefined, false);
  }, [fetchPage]);

  const fetchNextPage = React.useCallback(async (): Promise<void> => {
    const nextCursor = cachedEntry?.pagination?.nextCursor;
    if (!nextCursor) return;
    cursorsRef.current = [...cursorsRef.current, nextCursor];
    await fetchPage(nextCursor, true);
  }, [cachedEntry, fetchPage]);

  const isLoading =
    !isReady || (enabled && cachedEntry === undefined && !cachedEntry);

  return {
    data: cachedEntry?.data ?? null,
    pagination: cachedEntry?.pagination ?? null,
    isLoading: isLoading && cachedEntry === undefined,
    isError: cachedEntry?.error != null,
    error: cachedEntry?.error ?? null,
    refetch,
    fetchNextPage,
  };
}

// Exported for use in useMutation (cache key shape must be consistent)
export { buildCacheKey };

// Suppress unused import — Pagination is used in BffDataResponse via api.ts
export type { Pagination };
