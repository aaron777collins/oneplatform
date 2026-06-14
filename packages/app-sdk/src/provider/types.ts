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
   * Override the BFF base URL. Defaults to window.location.origin.
   *
   * Set this when the BFF is hosted on a different origin — for example in
   * React Native WebView environments, Electron-based hybrid apps, or
   * cross-origin iframe embeddings where the app and BFF are on separate
   * domains.
   *
   * Must be an absolute URL using http:// or https://, with no trailing slash.
   *
   * Warning: setting this to a third-party origin will send auth cookies
   * cross-origin. Ensure the target origin is trusted and that the BFF
   * sets the appropriate CORS and SameSite cookie headers.
   */
  bffBaseUrl?: string;
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
