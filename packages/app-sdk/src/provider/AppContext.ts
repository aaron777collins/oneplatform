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
 * Returns a no-op context used in production when a hook is called outside
 * AppProvider. We return safe fallback values rather than throwing so that
 * a misconfigured subtree does not crash the entire shell page.
 *
 * In development mode useAppContext() throws a descriptive error instead
 * (see below) to catch misconfiguration during development.
 */
function createNullContext(): AppContextValue {
  return {
    appId: "",
    tenantId: "",
    bffClient: new BffClient(),
    permissionCache: new PermissionCache(),
    wsManager: new WebSocketManager(),
    user: null,
    isReady: false,
  };
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
    return createNullContext();
  }
  return ctx;
}
