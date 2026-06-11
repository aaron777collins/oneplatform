/**
 * AppProvider configuration and state types.
 */

import type React from "react";

// ─── Config injected by the App Service HTML shell ────────────────────────────

export interface OPAppConfig {
  appId: string;
  tenantId: string;
}

// ─── AppProvider props ────────────────────────────────────────────────────────

export interface AppProviderProps {
  children: React.ReactNode;
  /** Rendered while AppProvider is initialising (permissions + user fetch). Default: null */
  loadingFallback?: React.ReactNode;
  /**
   * Override appId for testing.
   * In production this is always read from window.__OP_APP_CONFIG__ and this prop is ignored.
   */
  _testAppId?: string;
  _testTenantId?: string;
}

// ─── Internal provider state ──────────────────────────────────────────────────

export type AppProviderInitState =
  | { status: "loading" }
  | { status: "ready" }
  | { status: "error"; message: string };
