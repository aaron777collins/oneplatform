/**
 * Tests for QueryCache.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { QueryCache } from "./QueryCache.js";

describe("QueryCache", () => {
  let cache: QueryCache;

  beforeEach(() => {
    cache = new QueryCache();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("set + get", () => {
    it("stores and retrieves an entry", () => {
      cache.set("key1", {
        data: [{ id: "1", name: "Alice" }],
        pagination: { nextCursor: null, total: 1 },
        error: null,
        fetchedAt: Date.now(),
        promise: null,
      });
      const entry = cache.get("key1");
      expect(entry?.data).toHaveLength(1);
    });

    it("returns undefined for a missing key", () => {
      expect(cache.get("missing")).toBeUndefined();
    });
  });

  describe("isStale", () => {
    it("returns true when no entry exists", () => {
      expect(cache.isStale("key1", 30_000)).toBe(true);
    });

    it("returns false for a fresh entry", () => {
      cache.set("key1", {
        data: [],
        pagination: null,
        error: null,
        fetchedAt: Date.now(),
        promise: null,
      });
      expect(cache.isStale("key1", 30_000)).toBe(false);
    });

    it("returns true after staleTime elapses", () => {
      cache.set("key1", {
        data: [],
        pagination: null,
        error: null,
        fetchedAt: Date.now(),
        promise: null,
      });
      vi.advanceTimersByTime(31_000);
      expect(cache.isStale("key1", 30_000)).toBe(true);
    });
  });

  describe("invalidate", () => {
    it("removes all entries for the given entity", () => {
      const key = JSON.stringify({ entity: "orders", filter: null, sort: null, fields: null, limit: 50 });
      cache.set(key, { data: [], pagination: null, error: null, fetchedAt: Date.now(), promise: null });
      cache.invalidate("orders");
      expect(cache.get(key)).toBeUndefined();
    });

    it("does not affect entries for other entities", () => {
      const ordersKey = JSON.stringify({ entity: "orders", filter: null, sort: null, fields: null, limit: 50 });
      const customersKey = JSON.stringify({ entity: "customers", filter: null, sort: null, fields: null, limit: 50 });
      cache.set(ordersKey, { data: [], pagination: null, error: null, fetchedAt: Date.now(), promise: null });
      cache.set(customersKey, { data: [{ id: "c1" }], pagination: null, error: null, fetchedAt: Date.now(), promise: null });
      cache.invalidate("orders");
      expect(cache.get(customersKey)).toBeDefined();
    });
  });

  describe("optimistic operations + snapshot/restore", () => {
    const entityKey = JSON.stringify({ entity: "tasks", filter: null, sort: null, fields: null, limit: 50 });

    function seedCache(): void {
      cache.set(entityKey, {
        data: [{ id: "t1", title: "Task 1" }],
        pagination: null,
        error: null,
        fetchedAt: Date.now(),
        promise: null,
      });
    }

    it("optimisticCreate appends provisional record", () => {
      seedCache();
      cache.optimisticCreate("tasks", { id: "_opt_1", title: "New Task" });
      expect(cache.get(entityKey)?.data).toHaveLength(2);
    });

    it("optimisticUpdate patches matching record by id", () => {
      seedCache();
      cache.optimisticUpdate("tasks", "t1", { title: "Updated" });
      const data = cache.get(entityKey)?.data as Array<{ id: string; title: string }>;
      expect(data?.[0]?.title).toBe("Updated");
    });

    it("optimisticRemove removes matching record by id", () => {
      seedCache();
      cache.optimisticRemove("tasks", "t1");
      expect(cache.get(entityKey)?.data).toHaveLength(0);
    });

    it("restoreSnapshot reverts to pre-mutation state", () => {
      seedCache();
      const snap = cache.snapshot("tasks");
      cache.optimisticCreate("tasks", { id: "_opt_1", title: "New Task" });
      cache.restoreSnapshot("tasks", snap);
      expect(cache.get(entityKey)?.data).toHaveLength(1);
    });

    it("confirmCreate replaces provisional record with server record", () => {
      seedCache();
      const optimisticId = "_opt_test";
      cache.optimisticCreate("tasks", { _optimisticId: optimisticId, title: "Provisional" });
      cache.confirmCreate("tasks", optimisticId, { id: "server-id", title: "Confirmed" });
      const data = cache.get(entityKey)?.data as Array<{ id: string; _optimisticId?: string }>;
      expect(data?.some((r) => r._optimisticId === optimisticId)).toBe(false);
      expect(data?.some((r) => r.id === "server-id")).toBe(true);
    });
  });

  describe("subscribe", () => {
    it("notifies listener on set", () => {
      const listener = vi.fn();
      const key = "test-key";
      cache.subscribe(key, listener);
      cache.set(key, { data: [], pagination: null, error: null, fetchedAt: Date.now(), promise: null });
      expect(listener).toHaveBeenCalledOnce();
    });

    it("stops notifying after unsubscribe", () => {
      const listener = vi.fn();
      const key = "test-key";
      const unsub = cache.subscribe(key, listener);
      unsub();
      cache.set(key, { data: [], pagination: null, error: null, fetchedAt: Date.now(), promise: null });
      expect(listener).not.toHaveBeenCalled();
    });
  });
});
