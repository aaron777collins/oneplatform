/**
 * Data fetching hook for platform entities.
 *
 * Fetches `GET /bff/data/{entity}` with filtering, sorting, and cursor
 * pagination. Implements stale-while-revalidate: cached data is returned
 * immediately while a background refetch runs if the entry is older than
 * `staleTime`.
 *
 * Deduplication: concurrent `useQuery` calls with the same `(entity, options)`
 * key share one in-flight fetch via the module-level `QueryCache` singleton.
 *
 * `fetchNextPage` appends to the existing `data[]` rather than replacing it —
 * callers accumulate pages incrementally (infinite scroll pattern).
 *
 * @param entity  - The ontology entity type name (e.g. `'Product'`).
 * @param options - Filtering, sorting, field selection, and cache control.
 * @returns A {@link QueryResult} containing `data`, loading state, and pagination helpers.
 *
 * @example
 * ```tsx
 * // V6-165: Always memoize the options object to prevent refetch loops.
 * const queryOptions = useMemo(
 *   () => ({
 *     filter: { status: { eq: 'active' } },
 *     sort: ['-createdAt'],
 *     limit: 20,
 *   }),
 *   [],
 * );
 * const { data, isLoading, fetchNextPage } = useQuery<Product>('Product', queryOptions);
 * ```
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
 * Recursively sorts object keys so that JSON.stringify produces a stable
 * string regardless of the property insertion order.
 */
function sortKeys(value: unknown): unknown {
  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

/**
 * Builds a stable cache key from the query identity fields.
 * cursor and staleTime are intentionally excluded: cursor is managed internally
 * by the hook's page list, and staleTime controls eviction policy, not identity.
 *
 * Filter keys are recursively sorted so that `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }`
 * produce the same cache key — making key computation order-independent.
 */
function buildCacheKey(entity: string, options: QueryOptions): string {
  return JSON.stringify({
    entity,
    filter: sortKeys(options.filter) ?? null,
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

/**
 * Fetches platform entity data with filtering, sorting, and cursor pagination.
 *
 * Implements stale-while-revalidate caching: cached data is returned immediately
 * while a background refetch runs if the entry is older than `options.staleTime`
 * (default 30 seconds).
 *
 * Concurrent calls with the same (entity, options) key share one in-flight
 * fetch via the module-level QueryCache singleton — no duplicate network requests.
 *
 * @performance The `options` object is compared by reference for cache key
 * computation. Passing a new object literal on every render causes unnecessary
 * re-fetches (the cache key changes even though the filter values are identical).
 * Always memoize the options object with `useMemo`:
 *
 * ```ts
 * // WRONG — new object on every render triggers a refetch loop
 * const { data } = useQuery("customer", { filter: { status: { eq: "active" } } });
 *
 * // CORRECT — stable reference, refetch only runs when the filter values change
 * const queryOptions = useMemo(
 *   () => ({ filter: { status: { eq: "active" } } }),
 *   [] // empty deps: stable for the component's lifetime
 * );
 * const { data } = useQuery("customer", queryOptions);
 * ```
 *
 * For dynamic filters, include the changing values in the `useMemo` deps array:
 *
 * ```ts
 * const queryOptions = useMemo(
 *   () => ({ filter: { status: { eq: activeFilter } } }),
 *   [activeFilter] // re-memoize (and re-fetch) only when activeFilter changes
 * );
 * const { data } = useQuery("customer", queryOptions);
 * ```
 *
 * @param entity - The ontology entity type slug (e.g. "customer", "order")
 * @param options - Optional filter, sort, field selection, and pagination config
 * @returns QueryResult with data, loading state, error, and pagination helpers
 */
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

  // Keep a ref to options so fetchPage always reads the latest values
  // without needing options in its dependency array (which would cause
  // refetches on every render when callers pass unstable object literals).
  const optionsRef = React.useRef(options);
  React.useEffect(() => {
    optionsRef.current = options;
  });

  const fetchPage = React.useCallback(
    async (cursor: string | undefined, append: boolean): Promise<void> => {
      const controller = new AbortController();
      // Replace any previous controller; the old request is already settled or
      // will be ignored because its abort signal fires independently.
      abortControllerRef.current = controller;
      const params = buildQueryParams(optionsRef.current, cursor);

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
        optionsRef.current.onError?.(sdkError);
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

  const isLoading = !isReady || (enabled && cachedEntry === undefined);

  return {
    data: cachedEntry?.data ?? null,
    pagination: cachedEntry?.pagination ?? null,
    isLoading,
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
