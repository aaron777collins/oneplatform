/**
 * Client-side permission snapshot cache (internal — not exported from package index).
 *
 * Holds a flat Map<"action:resource", boolean> that enables O(1) synchronous
 * permission checks. A flat map rather than a nested tree avoids optional
 * chaining chains and is trivially inspectable in DevTools.
 *
 * Security note: this cache is a UI optimisation only. The BFF enforces RBAC
 * on every request regardless of what this cache says. A stale cached `true`
 * results in a 403 from the BFF which hooks surface as isError: true.
 */

import type { BffClient } from "../client/BffClient.js";
import type { PermissionEntry, BffPermissionsResponse } from "../types/api.js";

export class PermissionCache {
  // Flat map: "action:resource" → allowed. Replaced atomically on each refresh.
  private snapshot: Map<string, boolean> = new Map();

  // Listeners subscribed via useSyncExternalStore
  private readonly listeners = new Set<() => void>();

  // Background refresh timer (setInterval handle)
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  // 5-minute background refresh to catch permission changes while the app is open
  private static readonly REFRESH_INTERVAL_MS = 5 * 60 * 1_000;

  /**
   * Seeds the cache from the BFF and starts background refresh.
   * Called once by AppProvider at mount.
   */
  async seed(bffClient: BffClient): Promise<void> {
    const data = await bffClient.request<BffPermissionsResponse>("/bff/permissions");
    this.applySnapshot(data.permissions);
    this.startBackgroundRefresh(bffClient);
  }

  /**
   * Refreshes the snapshot from the BFF without disrupting callers.
   *
   * Refresh failure is intentionally non-fatal: the existing snapshot continues
   * to serve reads. The next scheduled interval will try again.
   */
  async refresh(bffClient: BffClient): Promise<void> {
    try {
      const data = await bffClient.request<BffPermissionsResponse>("/bff/permissions");
      this.applySnapshot(data.permissions);
      this.notifyListeners();
    } catch {
      // Stale snapshot is acceptable — BFF enforces RBAC on every actual request.
    }
  }

  /**
   * Synchronous permission check. Never throws, never suspends (C-3).
   *
   * Precedence (highest to lowest):
   * 1. admin:* → grants everything
   * 2. admin:{resource} → grants all actions on that resource
   * 3. {action}:* → grants that action on any resource
   * 4. {action}:{resource} → exact match
   */
  check(action: string, resource: string): boolean {
    if (this.snapshot.get("admin:*") === true) return true;
    if (this.snapshot.get(`admin:${resource}`) === true) return true;
    if (this.snapshot.get(`${action}:*`) === true) return true;
    return this.snapshot.get(`${action}:${resource}`) === true;
  }

  /**
   * Subscribes a listener to snapshot changes. Returns an unsubscribe function.
   * Used by usePermission via useSyncExternalStore.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Returns all permissions as a snapshot for testing/debugging.
   */
  getSnapshot(): ReadonlyMap<string, boolean> {
    return this.snapshot;
  }

  /**
   * Clears the refresh timer and all listeners.
   * Called by AppProvider on unmount.
   */
  destroy(): void {
    if (this.refreshTimer !== null) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.listeners.clear();
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private applySnapshot(permissions: PermissionEntry[]): void {
    // Replace atomically so check() never sees a partial update
    this.snapshot = new Map(
      permissions.map((p) => [`${p.action}:${p.resource}`, p.allowed]),
    );
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private startBackgroundRefresh(bffClient: BffClient): void {
    if (this.refreshTimer !== null) clearInterval(this.refreshTimer);
    this.refreshTimer = setInterval(() => {
      void this.refresh(bffClient);
    }, PermissionCache.REFRESH_INTERVAL_MS);
  }
}
