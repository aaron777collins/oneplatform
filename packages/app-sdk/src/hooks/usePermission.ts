/**
 * Synchronous permission check hook (C-3).
 *
 * Never suspends, never causes a loading state. Reads from PermissionCache
 * which is seeded before AppProvider renders children (C-4), so the cache
 * is always populated when this hook is called.
 *
 * Re-renders automatically when the permission cache is refreshed (on
 * visibility change or the 5-minute background interval) via useSyncExternalStore.
 *
 * Permission model:
 *   admin:*             → grants all actions on all resources
 *   admin:{resource}    → grants all actions on that resource
 *   {action}:*          → grants that action on any resource
 *   {action}:{resource} → exact match
 */

import React from "react";
import { useAppContext } from "../provider/AppContext.js";
import type { PermissionAction } from "../types/entities.js";

export function usePermission(
  action: PermissionAction | string,
  resource: string,
): boolean {
  const { permissionCache } = useAppContext();

  // useSyncExternalStore handles concurrent-mode tearing safely.
  // The subscribe function must be stable (or wrapped in useCallback) to
  // prevent re-subscribing on every render.
  return React.useSyncExternalStore(
    React.useCallback(
      (notify: () => void) => permissionCache.subscribe(notify),
      [permissionCache],
    ),
    React.useCallback(
      () => permissionCache.check(action, resource),
      [permissionCache, action, resource],
    ),
  );
}
