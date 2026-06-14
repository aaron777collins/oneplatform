/**
 * Data mutation hook for platform entities.
 *
 * Provides `create`, `update` (PATCH), `replace` (PUT), `remove` (DELETE),
 * and `bulkCreate` operations. All mutations:
 *
 * 1. Apply an optimistic update to `QueryCache` before the network call
 * 2. Revert to the pre-mutation snapshot on error
 * 3. Are serialised via a per-hook mutation queue to prevent race conditions
 *    when multiple mutations fire concurrently on the same entity
 * 4. Invalidate all `QueryCache` entries for the entity on success, triggering
 *    fresh fetches in any mounted `useQuery` instances for that entity
 *
 * @param entity - The ontology entity type name (e.g. `'Product'`).
 * @returns A {@link MutationResult} with `create`, `update`, `replace`, `remove`,
 *   `bulkCreate`, and `reset` methods plus loading/error state.
 *
 * @example
 * ```tsx
 * const { create, isLoading, error } = useMutation<Product>('Product');
 *
 * async function handleSubmit(data: Partial<Product>) {
 *   await create(data);
 * }
 * ```
 */

import React from "react";
import { useAppContext } from "../provider/AppContext.js";
import { queryCache } from "../cache/QueryCache.js";
import { isAppSDKError, toAppSDKError } from "../client/errors.js";
import type {
  MutationResult,
  BulkResult,
  AppSDKError,
} from "../types/entities.js";
import type { BffBulkCreateResponse } from "../types/api.js";

// ─── Internal state ────────────────────────────────────────────────────────────

interface MutationState {
  isLoading: boolean;
  isError: boolean;
  error: AppSDKError | null;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useMutation<T = unknown>(entity: string): MutationResult<T> {
  const { bffClient } = useAppContext();

  const [state, setState] = React.useState<MutationState>({
    isLoading: false,
    isError: false,
    error: null,
  });

  // Mutation queue: each mutation is enqueued as a Promise chain so that
  // concurrent calls are serialised, preventing optimistic state corruption.
  const mutationQueueRef = React.useRef<Promise<void>>(Promise.resolve());

  /**
   * Wraps a mutation function in the serialisation queue.
   * Returns the individual mutation's Promise to the caller.
   */
  function enqueue<R>(fn: () => Promise<R>): Promise<R> {
    let resolve!: (v: R) => void;
    let reject!: (e: unknown) => void;
    const p = new Promise<R>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    mutationQueueRef.current = mutationQueueRef.current.then(async () => {
      try {
        resolve(await fn());
      } catch (e) {
        reject(e);
      }
    });
    return p;
  }

  function normaliseMutationError(err: unknown): AppSDKError {
    return isAppSDKError(err) ? err : toAppSDKError(err);
  }

  // ─── create ───────────────────────────────────────────────────────────────

  const create = React.useCallback(
    (data: Partial<T>): Promise<T> => {
      return enqueue(async () => {
        setState({ isLoading: true, isError: false, error: null });
        const snapshot = queryCache.snapshot(entity);
        const optimisticId = `_opt_${crypto.randomUUID()}`;
        queryCache.optimisticCreate(entity, {
          ...(data as Record<string, unknown>),
          _optimisticId: optimisticId,
        });
        try {
          const result = await bffClient.request<T>(
            `/bff/data/${encodeURIComponent(entity)}`,
            { method: "POST", body: data },
          );
          queryCache.confirmCreate(
            entity,
            optimisticId,
            result as Record<string, unknown>,
          );
          queryCache.invalidate(entity);
          setState({ isLoading: false, isError: false, error: null });
          return result;
        } catch (err) {
          queryCache.restoreSnapshot(entity, snapshot);
          const sdkError = normaliseMutationError(err);
          setState({ isLoading: false, isError: true, error: sdkError });
          throw sdkError;
        }
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- enqueue is stable
    [entity, bffClient],
  );

  // ─── update (PATCH) ───────────────────────────────────────────────────────

  const update = React.useCallback(
    (id: string, data: Partial<T>): Promise<T> => {
      return enqueue(async () => {
        setState({ isLoading: true, isError: false, error: null });
        const snapshot = queryCache.snapshot(entity);
        queryCache.optimisticUpdate(entity, id, data as Record<string, unknown>);
        try {
          const result = await bffClient.request<T>(
            `/bff/data/${encodeURIComponent(entity)}/${encodeURIComponent(id)}`,
            { method: "PATCH", body: data },
          );
          queryCache.invalidate(entity);
          setState({ isLoading: false, isError: false, error: null });
          return result;
        } catch (err) {
          queryCache.restoreSnapshot(entity, snapshot);
          const sdkError = normaliseMutationError(err);
          setState({ isLoading: false, isError: true, error: sdkError });
          throw sdkError;
        }
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entity, bffClient],
  );

  // ─── replace (PUT) ────────────────────────────────────────────────────────

  const replace = React.useCallback(
    (id: string, data: T): Promise<T> => {
      return enqueue(async () => {
        setState({ isLoading: true, isError: false, error: null });
        const snapshot = queryCache.snapshot(entity);
        queryCache.optimisticUpdate(entity, id, data as Record<string, unknown>);
        try {
          const result = await bffClient.request<T>(
            `/bff/data/${encodeURIComponent(entity)}/${encodeURIComponent(id)}`,
            { method: "PUT", body: data },
          );
          queryCache.invalidate(entity);
          setState({ isLoading: false, isError: false, error: null });
          return result;
        } catch (err) {
          queryCache.restoreSnapshot(entity, snapshot);
          const sdkError = normaliseMutationError(err);
          setState({ isLoading: false, isError: true, error: sdkError });
          throw sdkError;
        }
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entity, bffClient],
  );

  // ─── remove (DELETE) ──────────────────────────────────────────────────────

  const remove = React.useCallback(
    (id: string): Promise<void> => {
      return enqueue(async () => {
        setState({ isLoading: true, isError: false, error: null });
        const snapshot = queryCache.snapshot(entity);
        queryCache.optimisticRemove(entity, id);
        try {
          await bffClient.request<void>(
            `/bff/data/${encodeURIComponent(entity)}/${encodeURIComponent(id)}`,
            { method: "DELETE" },
          );
          queryCache.invalidate(entity);
          setState({ isLoading: false, isError: false, error: null });
        } catch (err) {
          queryCache.restoreSnapshot(entity, snapshot);
          const sdkError = normaliseMutationError(err);
          setState({ isLoading: false, isError: true, error: sdkError });
          throw sdkError;
        }
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entity, bffClient],
  );

  // ─── bulkCreate ───────────────────────────────────────────────────────────

  const bulkCreate = React.useCallback(
    (items: Partial<T>[]): Promise<BulkResult<T>> => {
      return enqueue(async () => {
        setState({ isLoading: true, isError: false, error: null });
        try {
          const raw = await bffClient.request<BffBulkCreateResponse<T>>(
            `/bff/data/${encodeURIComponent(entity)}/bulk`,
            { method: "POST", body: { items } },
          );

          // Normalise BFF error entries to AppSDKError shape
          const result: BulkResult<T> = {
            created: raw.created,
            errors: raw.errors.map((e) => ({
              index: e.index,
              error: {
                code: e.error.code,
                message: e.error.message,
                statusCode: 422,
                isRetryable: false,
                requestId: "",
              },
            })),
          };

          queryCache.invalidate(entity);
          setState({ isLoading: false, isError: false, error: null });
          return result;
        } catch (err) {
          const sdkError = normaliseMutationError(err);
          setState({ isLoading: false, isError: true, error: sdkError });
          throw sdkError;
        }
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entity, bffClient],
  );

  // ─── reset ────────────────────────────────────────────────────────────────

  const reset = React.useCallback(() => {
    setState({ isLoading: false, isError: false, error: null });
  }, []);

  return {
    create,
    update,
    replace,
    remove,
    bulkCreate,
    isLoading: state.isLoading,
    isError: state.isError,
    error: state.error,
    reset,
  };
}
