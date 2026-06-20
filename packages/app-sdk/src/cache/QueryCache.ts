/**
 * In-memory query result cache (internal — not exported from package index).
 *
 * A module-level singleton so that multiple hook instances mounting for the
 * same (entity, options) key share a single in-flight fetch and receive the
 * same cached entry, eliminating redundant network calls (deduplication).
 *
 * The cache is intentionally simple — it holds the most recent result for
 * each cache key and supports stale-while-revalidate via fetchedAt timestamps.
 * Complex eviction (LRU, TTL-based GC) is deferred until profiling shows a need.
 */

import type { AppSDKError, Pagination } from "../types/entities.js";

// ─── Cache entry shape ────────────────────────────────────────────────────────

export interface CacheEntry<T> {
  data: T[] | null;
  pagination: Pagination | null;
  error: AppSDKError | null;
  /** Date.now() when this entry was last populated from the network */
  fetchedAt: number;
  /** In-flight deduplication: holds the pending fetch Promise */
  promise: Promise<void> | null;
}

// ─── Listener registry ────────────────────────────────────────────────────────

type CacheListener = () => void;

// ─── QueryCache ───────────────────────────────────────────────────────────────

export class QueryCache {
  private readonly entries = new Map<string, CacheEntry<unknown>>();
  private readonly listeners = new Map<string, Set<CacheListener>>();

  // ─── Read operations ───────────────────────────────────────────────────────

  get<T>(key: string): CacheEntry<T> | undefined {
    return this.entries.get(key) as CacheEntry<T> | undefined;
  }

  isStale(key: string, staleTime: number): boolean {
    const entry = this.entries.get(key);
    if (!entry) return true;
    return Date.now() - entry.fetchedAt > staleTime;
  }

  // ─── Write operations ──────────────────────────────────────────────────────

  set<T>(key: string, entry: CacheEntry<T>): void {
    this.entries.set(key, entry as CacheEntry<unknown>);
    this.notifyListeners(key);
  }

  // ─── Optimistic update helpers ─────────────────────────────────────────────

  /**
   * Returns a deep copy of all cache entries for a given entity, keyed by cache key.
   * Stored before a mutation so the state can be rolled back on error.
   */
  snapshot(entity: string): Map<string, CacheEntry<unknown>> {
    const snap = new Map<string, CacheEntry<unknown>>();
    for (const [key, entry] of this.entries) {
      if (this.keyBelongsToEntity(key, entity)) {
        // Shallow-copy is sufficient: data array and pagination are replaced atomically
        snap.set(key, { ...entry, data: entry.data ? [...entry.data] : null });
      }
    }
    return snap;
  }

  /**
   * Appends an optimistic (provisional) record to all cache entries for an entity.
   * The provisional record carries a _optimisticId field for later replacement.
   */
  optimisticCreate(entity: string, record: Record<string, unknown>): void {
    for (const [key, entry] of this.entries) {
      if (!this.keyBelongsToEntity(key, entity)) continue;
      const current = entry.data ?? [];
      this.entries.set(key, {
        ...entry,
        data: [...current, record],
      });
      this.notifyListeners(key);
    }
  }

  /**
   * Optimistically applies an update to matching records in all cache entries
   * for an entity. Matches by the record's `id` field.
   */
  optimisticUpdate(entity: string, id: string, patch: Record<string, unknown>): void {
    for (const [key, entry] of this.entries) {
      if (!this.keyBelongsToEntity(key, entity)) continue;
      if (!entry.data) continue;
      this.entries.set(key, {
        ...entry,
        data: entry.data.map((item) => {
          const record = item as Record<string, unknown>;
          return record["id"] === id ? { ...record, ...patch } : item;
        }),
      });
      this.notifyListeners(key);
    }
  }

  /**
   * Optimistically removes a record with the given `id` from all cache entries
   * for an entity.
   */
  optimisticRemove(entity: string, id: string): void {
    for (const [key, entry] of this.entries) {
      if (!this.keyBelongsToEntity(key, entity)) continue;
      if (!entry.data) continue;
      this.entries.set(key, {
        ...entry,
        data: entry.data.filter(
          (item) => (item as Record<string, unknown>)["id"] !== id,
        ),
      });
      this.notifyListeners(key);
    }
  }

  /**
   * Replaces a provisional (optimistic) record with the server-confirmed record.
   * Matches by _optimisticId, then replaces the entire record with the server response.
   */
  confirmCreate(
    entity: string,
    optimisticId: string,
    serverRecord: Record<string, unknown>,
  ): void {
    for (const [key, entry] of this.entries) {
      if (!this.keyBelongsToEntity(key, entity)) continue;
      if (!entry.data) continue;
      this.entries.set(key, {
        ...entry,
        data: entry.data.map((item) => {
          const record = item as Record<string, unknown>;
          return record["_optimisticId"] === optimisticId ? serverRecord : item;
        }),
      });
      this.notifyListeners(key);
    }
  }

  /**
   * Restores cache entries from a snapshot taken before a failed mutation.
   */
  restoreSnapshot(entity: string, snap: Map<string, CacheEntry<unknown>>): void {
    for (const [key, entry] of snap) {
      if (this.keyBelongsToEntity(key, entity)) {
        this.entries.set(key, entry);
        this.notifyListeners(key);
      }
    }
  }

  /**
   * Removes all cache entries for an entity, causing the next useQuery render
   * to trigger a fresh fetch. Called by useMutation after any successful write.
   *
   * Keys are collected before deletion to avoid mutating the Map while iterating
   * over it — the ES2015 spec guarantees safety for the current key, but this
   * explicit two-phase approach is immune to future refactoring to other
   * collection types that may not share that guarantee.
   */
  invalidate(entity: string): void {
    const keysToDelete = Array.from(this.entries.keys()).filter((key) =>
      this.keyBelongsToEntity(key, entity),
    );
    for (const key of keysToDelete) {
      this.entries.delete(key);
      this.notifyListeners(key);
    }
  }

  // ─── useSyncExternalStore integration ─────────────────────────────────────

  /**
   * Subscribes a listener to changes for a specific cache key.
   * Returns an unsubscribe function compatible with useSyncExternalStore.
   */
  subscribe(key: string, listener: CacheListener): () => void {
    let keyListeners = this.listeners.get(key);
    if (!keyListeners) {
      keyListeners = new Set();
      this.listeners.set(key, keyListeners);
    }
    keyListeners.add(listener);
    return () => {
      const set = this.listeners.get(key);
      if (set) {
        set.delete(listener);
        if (set.size === 0) this.listeners.delete(key);
      }
    };
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private notifyListeners(key: string): void {
    const set = this.listeners.get(key);
    if (!set) return;
    for (const listener of set) {
      listener();
    }
  }

  /**
   * Cache keys are stable JSON strings produced by buildCacheKey, which always
   * serialises `entity` as the first field:
   *   {"entity":"orders","filter":...}
   *
   * Using startsWith on the fixed prefix avoids false positives from entity names
   * that are substrings of longer names (e.g. "order" matching "orderItems").
   * JSON.stringify produces deterministic key order in V8, and buildCacheKey
   * always puts `entity` first, so the prefix approach is reliable here.
   */
  private keyBelongsToEntity(key: string, entity: string): boolean {
    const escapedEntity = JSON.stringify(entity);
    return key.startsWith(`{"entity":${escapedEntity}`);
  }
}

// Module-level singleton enabling cross-component deduplication
export const queryCache = new QueryCache();
