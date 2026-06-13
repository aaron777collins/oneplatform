/**
 * Tests for PermissionCache.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PermissionCache } from "./PermissionCache.js";
import type { BffClient } from "../client/BffClient.js";

// ─── Test helpers ──────────────────────────────────────────────────────────────

function makeMockBffClient(permissions: Array<{ action: string; resource: string; allowed: boolean }>): BffClient {
  const permMap: Record<string, string[]> = {};
  for (const p of permissions) {
    if (p.allowed) {
      (permMap[p.resource] ??= []).push(p.action);
    }
  }
  return {
    request: vi.fn().mockResolvedValue({ data: { permissions: permMap } }),
    setUnauthorizedHandler: vi.fn(),
  } as unknown as BffClient;
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe("PermissionCache", () => {
  let cache: PermissionCache;

  beforeEach(() => {
    cache = new PermissionCache();
    vi.useFakeTimers();
  });

  afterEach(() => {
    cache.destroy();
    vi.useRealTimers();
  });

  describe("seed + check", () => {
    it("returns true for an exact match", async () => {
      const client = makeMockBffClient([
        { action: "read", resource: "customers", allowed: true },
      ]);
      await cache.seed(client);
      expect(cache.check("read", "customers")).toBe(true);
    });

    it("returns false for an absent permission", async () => {
      const client = makeMockBffClient([]);
      await cache.seed(client);
      expect(cache.check("delete", "orders")).toBe(false);
    });

    it("admin:* grants all actions on all resources", async () => {
      const client = makeMockBffClient([
        { action: "admin", resource: "*", allowed: true },
      ]);
      await cache.seed(client);
      expect(cache.check("delete", "customers")).toBe(true);
      expect(cache.check("create", "invoices")).toBe(true);
    });

    it("admin:{resource} grants all actions on that resource only", async () => {
      const client = makeMockBffClient([
        { action: "admin", resource: "customers", allowed: true },
      ]);
      await cache.seed(client);
      expect(cache.check("delete", "customers")).toBe(true);
      expect(cache.check("delete", "orders")).toBe(false);
    });

    it("{action}:* grants that action on any resource", async () => {
      const client = makeMockBffClient([
        { action: "read", resource: "*", allowed: true },
      ]);
      await cache.seed(client);
      expect(cache.check("read", "orders")).toBe(true);
      expect(cache.check("delete", "orders")).toBe(false);
    });

    it("denied permissions return false even if present in snapshot", async () => {
      const client = makeMockBffClient([
        { action: "delete", resource: "customers", allowed: false },
      ]);
      await cache.seed(client);
      expect(cache.check("delete", "customers")).toBe(false);
    });
  });

  describe("refresh", () => {
    it("updates snapshot and notifies listeners", async () => {
      const initialClient = makeMockBffClient([
        { action: "read", resource: "customers", allowed: true },
      ]);
      await cache.seed(initialClient);

      const listener = vi.fn();
      cache.subscribe(listener);

      const refreshClient = makeMockBffClient([
        { action: "read", resource: "customers", allowed: false },
      ]);
      await cache.refresh(refreshClient);

      expect(cache.check("read", "customers")).toBe(false);
      expect(listener).toHaveBeenCalledOnce();
    });

    it("does not throw on refresh failure — keeps existing snapshot", async () => {
      const initialClient = makeMockBffClient([
        { action: "read", resource: "customers", allowed: true },
      ]);
      await cache.seed(initialClient);

      const failingClient = {
        request: vi.fn().mockRejectedValue(new Error("Network error")),
      } as unknown as BffClient;

      await expect(cache.refresh(failingClient)).resolves.toBeUndefined();
      expect(cache.check("read", "customers")).toBe(true);
    });
  });

  describe("subscribe / unsubscribe", () => {
    it("returns a cleanup function that removes the listener", async () => {
      const client = makeMockBffClient([]);
      await cache.seed(client);

      const listener = vi.fn();
      const unsubscribe = cache.subscribe(listener);
      unsubscribe();

      const refreshClient = makeMockBffClient([{ action: "read", resource: "*", allowed: true }]);
      await cache.refresh(refreshClient);

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("destroy", () => {
    it("clears all listeners", async () => {
      const client = makeMockBffClient([]);
      await cache.seed(client);

      const listener = vi.fn();
      cache.subscribe(listener);
      cache.destroy();

      const refreshClient = makeMockBffClient([{ action: "read", resource: "*", allowed: true }]);
      // After destroy, refresh should not crash but listeners should not be notified
      await cache.refresh(refreshClient);
      expect(listener).not.toHaveBeenCalled();
    });
  });
});
