/**
 * Root provider component for OnePlatform hosted apps.
 *
 * Every hosted app must wrap its component tree in AppProvider. It performs
 * platform initialisation at mount:
 *
 *   1. Reads and validates window.__OP_APP_CONFIG__
 *   2. Fetches /bff/me and /bff/permissions in parallel
 *   3. Seeds PermissionCache from the permissions response
 *   4. Connects the WebSocket via WebSocketManager
 *   5. Sets isReady = true so hooks can begin rendering data
 *
 * Children are withheld until isReady is true (C-4) to prevent hooks from
 * rendering data before permission state is available.
 */

import React from "react";
import { BffClient } from "../client/BffClient.js";
import { PermissionCache } from "../cache/PermissionCache.js";
import { WebSocketManager } from "../ws/WebSocketManager.js";
import { AppContext } from "./AppContext.js";
import type { AppProviderProps, OPAppConfig, AppProviderInitState } from "./types.js";
import type { UserContext } from "../types/entities.js";

// ─── Config reader ────────────────────────────────────────────────────────────

/**
 * Reads and validates window.__OP_APP_CONFIG__.
 * Throws a descriptive error if the config is absent or malformed so that
 * app developers see a clear message in the console rather than a null
 * reference error deep in the component tree.
 */
function readAppConfig(overrides?: { appId?: string; tenantId?: string }): OPAppConfig {
  const raw = (window as Window & { __OP_APP_CONFIG__?: unknown }).__OP_APP_CONFIG__;
  if (!raw || typeof raw !== "object") {
    throw new Error(
      "[app-sdk] window.__OP_APP_CONFIG__ is missing. " +
        "Ensure the App Service HTML shell is serving the app correctly.",
    );
  }
  const config = raw as Record<string, unknown>;
  if (typeof config["appId"] !== "string" || typeof config["tenantId"] !== "string") {
    throw new Error(
      "[app-sdk] window.__OP_APP_CONFIG__ is missing required appId or tenantId fields.",
    );
  }
  // Use spread pattern to satisfy exactOptionalPropertyTypes:
  // never assign `string | undefined` to a `string` field.
  const resolvedAppId: string = overrides?.appId ?? config["appId"];
  const resolvedTenantId: string = overrides?.tenantId ?? config["tenantId"];
  return { appId: resolvedAppId, tenantId: resolvedTenantId };
}

// ─── Debounce helper ──────────────────────────────────────────────────────────

function debounce<T extends () => void>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return function debounced(this: unknown) {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn.call(this);
    }, ms);
  } as T;
}

// ─── Singletons ───────────────────────────────────────────────────────────────
// These are created once per AppProvider mount and destroyed on unmount.
// We use useRef to hold them so they survive re-renders without recreation.

function useProviderSingletons() {
  const bffClientRef = React.useRef<BffClient | null>(null);
  const permissionCacheRef = React.useRef<PermissionCache | null>(null);
  const wsManagerRef = React.useRef<WebSocketManager | null>(null);

  if (!bffClientRef.current) bffClientRef.current = new BffClient();
  if (!permissionCacheRef.current) permissionCacheRef.current = new PermissionCache();
  if (!wsManagerRef.current) wsManagerRef.current = new WebSocketManager();

  return {
    bffClient: bffClientRef.current,
    permissionCache: permissionCacheRef.current,
    wsManager: wsManagerRef.current,
  };
}

// ─── AppProvider ──────────────────────────────────────────────────────────────

export function AppProvider({
  children,
  loadingFallback = null,
  _testAppId,
  _testTenantId,
}: AppProviderProps): React.JSX.Element {
  const { bffClient, permissionCache, wsManager } = useProviderSingletons();

  const [initState, setInitState] = React.useState<AppProviderInitState>({
    status: "loading",
  });
  const [user, setUser] = React.useState<UserContext | null>(null);

  // appId and tenantId are read once at mount. Stored in ref because they
  // do not participate in re-render logic — they are stable config values.
  const configRef = React.useRef<OPAppConfig | null>(null);

  React.useEffect(() => {
    let cancelled = false;

    async function init(): Promise<void> {
      // Step 1: read and validate config
      let config: OPAppConfig;
      try {
        // Build overrides without undefined values to satisfy exactOptionalPropertyTypes
        const overrides: { appId?: string; tenantId?: string } = {};
        if (_testAppId !== undefined) overrides.appId = _testAppId;
        if (_testTenantId !== undefined) overrides.tenantId = _testTenantId;
        config = readAppConfig(overrides);
        configRef.current = config;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(msg);
        if (!cancelled) setInitState({ status: "error", message: msg });
        return;
      }

      // Step 2: register the 401 → login redirect handler
      bffClient.setUnauthorizedHandler(() => {
        const redirect = encodeURIComponent(
          window.location.pathname + window.location.search,
        );
        window.location.href = `/login?redirect=${redirect}`;
      });

      // Step 3: fetch /bff/me and /bff/permissions in parallel (C-4)
      try {
        const [meResult] = await Promise.all([
          bffClient.request<UserContext>("/bff/me"),
          permissionCache.seed(bffClient),
        ]);

        if (cancelled) return;

        setUser(meResult);

        // Step 4: open the WebSocket connection
        wsManager.connect(config.appId);

        setInitState({ status: "ready" });
      } catch (err) {
        // 401 is handled by the unauthorized handler above (which redirects).
        // Non-401 errors render an inline error UI.
        if (cancelled) return;
        const msg =
          err instanceof Error ? err.message : "Platform initialisation failed";
        console.error("[app-sdk] Initialisation error:", err);
        setInitState({ status: "error", message: msg });
      }
    }

    void init();

    return () => {
      cancelled = true;
      wsManager.destroy();
      permissionCache.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally runs once; test overrides are stable
  }, []);

  // Step 5: re-seed permissions on visibility change.
  // Debounced 2 seconds so we don't hammer the BFF immediately on tab switch.
  React.useEffect(() => {
    if (initState.status !== "ready") return;

    const onVisible = debounce(() => {
      if (document.visibilityState === "visible") {
        void permissionCache.refresh(bffClient);
      }
    }, 2_000);

    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [initState.status, permissionCache, bffClient]);

  // ─── Render ─────────────────────────────────────────────────────────────────

  if (initState.status === "error") {
    return (
      <div role="alert" style={{ padding: "1rem", color: "red" }}>
        <strong>[OnePlatform] Failed to initialise app SDK</strong>
        <pre style={{ marginTop: "0.5rem", fontSize: "0.875rem" }}>
          {initState.message}
        </pre>
      </div>
    );
  }

  if (initState.status === "loading") {
    return <>{loadingFallback}</>;
  }

  const config = configRef.current;
  if (!config) {
    // Should never happen: status is "ready" only after config is set
    return <></>;
  }

  return (
    <AppContext.Provider
      value={{
        appId: config.appId,
        tenantId: config.tenantId,
        bffClient,
        permissionCache,
        wsManager,
        user,
        isReady: true,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}
