/**
 * React context that carries the platform SDK state to all hooks.
 *
 * Hooks call useAppContext() to obtain the BffClient, PermissionCache,
 * WebSocketManager, and user context. The context is populated by
 * AppProvider and is null until the provider mounts.
 */

import React from "react";
import { BffClient } from "../client/BffClient.js";
import { PermissionCache } from "../cache/PermissionCache.js";
import { WebSocketManager } from "../ws/WebSocketManager.js";
import type { UserContext } from "../types/entities.js";

// ─── Context value shape ──────────────────────────────────────────────────────

export interface AppContextValue {
  appId: string;
  tenantId: string;
  bffClient: BffClient;
  permissionCache: PermissionCache;
  wsManager: WebSocketManager;
  /** null while the initial /bff/me request is in-flight */
  user: UserContext | null;
  /** true once both /bff/me and /bff/permissions have resolved */
  isReady: boolean;
}

// ─── Context instance ─────────────────────────────────────────────────────────

export const AppContext = React.createContext<AppContextValue | null>(null);

// ─── No-op fallback for production mode outside provider ─────────────────────

/**
 * Module-level singleton for the no-op production fallback context.
 *
 * Allocated lazily the first time a hook is called outside AppProvider in
 * production. Kept as a singleton so repeated calls share the same
 * BffClient / PermissionCache / WebSocketManager instances instead of
 * spawning heavyweight new objects on every render.
 */
let _nullContext: AppContextValue | null = null;

function getNullContext(): AppContextValue {
  // Initialise once; subsequent calls return the same object.
  _nullContext ??= {
    appId: "",
    tenantId: "",
    bffClient: new BffClient(),
    permissionCache: new PermissionCache(),
    wsManager: new WebSocketManager(),
    user: null,
    isReady: false,
  };
  return _nullContext;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

declare const __OP_DEV__: boolean | undefined;

export function useAppContext(): AppContextValue {
  const ctx = React.useContext(AppContext);
  if (ctx === null) {
    // Use a typeof guard that tree-shakes cleanly in the browser bundle.
    // The condition is intentionally loose: we throw in any non-production
    // environment (dev, test) and return the safe fallback in production only.
    const isDev =
      typeof __OP_DEV__ !== "undefined"
        ? __OP_DEV__
        : !("__OP_PROD__" in globalThis);
    if (isDev) {
      throw new Error(
        "[app-sdk] A hook was called outside of <AppProvider>. " +
          "Wrap your app root with <AppProvider>.",
      );
    }
    // Production: return safe no-op context rather than crashing the shell
    return getNullContext();
  }
  return ctx;
}
