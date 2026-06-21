/**
 * Root provider component for OnePlatform hosted apps.
 *
 * Every hosted app must wrap its component tree in `AppProvider`. It performs
 * platform initialisation at mount:
 *
 * 1. Reads and validates `window.__OP_APP_CONFIG__`
 * 2. Fetches `/bff/me` and `/bff/permissions` in parallel
 * 3. Seeds `PermissionCache` from the permissions response
 * 4. Connects the WebSocket via `WebSocketManager`
 * 5. Sets `isReady = true` so hooks can begin rendering data
 *
 * Children are withheld until `isReady` is `true` (C-4) to prevent hooks from
 * rendering data before permission state is available.
 *
 * @example
 * ```tsx
 * function Root() {
 *   return (
 *     <AppProvider loadingFallback={<Spinner />}>
 *       <App />
 *     </AppProvider>
 *   );
 * }
 * ```
 */

import React from "react";
import { BffClient } from "../client/BffClient.js";
import { PermissionCache } from "../cache/PermissionCache.js";
import { WebSocketManager } from "../ws/WebSocketManager.js";
import { AppContext } from "./AppContext.js";
import type { AppProviderProps, OPAppConfig, AppProviderInitState } from "./types.js";
import type { UserContext } from "../types/entities.js";

// Injected by the build tool. Guards sensitive error detail from production bundles.
declare const __OP_DEV__: boolean | undefined;

// ─── Retry helper ─────────────────────────────────────────────────────────────

// BFF_MAX_RETRIES is the total number of attempts (initial call + retries).
// Backoff delays: 500ms, 1000ms (one delay between each pair of attempts).
const BFF_MAX_RETRIES = 3;
const BFF_RETRY_BASE_MS = 500; // 500ms → 1000ms

/**
 * Calls `fn` up to BFF_MAX_RETRIES times total with exponential backoff
 * between attempts. Returns the resolved value on the first success. Throws
 * the last error if all attempts fail.
 *
 * Retry is appropriate here because the BFF seed calls (me + permissions) are
 * idempotent GETs and transient network blips should not permanently brick the
 * app — the alternative is a full page reload by the user.
 */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  // attempt 0 = initial call; attempts 1..(BFF_MAX_RETRIES-1) = retries.
  // Total attempts = BFF_MAX_RETRIES (not BFF_MAX_RETRIES + 1).
  for (let attempt = 0; attempt < BFF_MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // Only delay if there is a subsequent retry to make.
      if (attempt < BFF_MAX_RETRIES - 1) {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, BFF_RETRY_BASE_MS * Math.pow(2, attempt)),
        );
      }
    }
  }
  throw lastErr;
}

// ─── Config reader ────────────────────────────────────────────────────────────

/**
 * Resolves the OPAppConfig from (in precedence order):
 *   1. The explicit `configProp` passed to AppProvider — useful for local dev
 *      and tests where the platform HTML shell is not present.
 *   2. The `testOverrides` (appId / tenantId) applied on top of window.__OP_APP_CONFIG__
 *      — used by the test harness.
 *   3. `window.__OP_APP_CONFIG__` — the standard production source injected by
 *      the App Service HTML shell.
 *
 * Throws a descriptive error when no valid config can be resolved so that
 * developers see a clear console message rather than a null-reference error
 * deep in the component tree.
 */
function readAppConfig(
  configProp?: OPAppConfig,
  overrides?: { appId?: string; tenantId?: string },
): OPAppConfig {
  // The explicit config prop takes full precedence — skip window global entirely.
  if (configProp) {
    if (typeof configProp.appId !== "string" || typeof configProp.tenantId !== "string") {
      throw new Error(
        "[app-sdk] AppProvider config prop is missing required appId or tenantId fields.",
      );
    }
    return configProp;
  }

  const raw = (window as Window & { __OP_APP_CONFIG__?: unknown }).__OP_APP_CONFIG__;
  if (!raw || typeof raw !== "object") {
    throw new Error(
      "[app-sdk] window.__OP_APP_CONFIG__ is missing. " +
        "Ensure the App Service HTML shell is serving the app correctly, " +
        "or pass a config prop to AppProvider for local development: " +
        "<AppProvider config={{ appId: '...', tenantId: '...' }}>",
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

  // appSlug is optional — present in non-embed mode, absent in embed mode.
  const result: OPAppConfig = { appId: resolvedAppId, tenantId: resolvedTenantId };
  const rawSlug = config["appSlug"];
  if (typeof rawSlug === "string" && rawSlug !== "") {
    result.appSlug = rawSlug;
  }
  return result;
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
//
// bffBaseUrl is captured at first render only — changing it after mount has
// no effect, which is intentional: the client's base URL is immutable once set.

function useProviderSingletons(bffBaseUrl?: string) {
  const bffClientRef = React.useRef<BffClient | null>(null);
  const permissionCacheRef = React.useRef<PermissionCache | null>(null);
  const wsManagerRef = React.useRef<WebSocketManager | null>(null);

  if (!bffClientRef.current) bffClientRef.current = new BffClient(bffBaseUrl);
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
  bffBaseUrl,
  config: configProp,
  _testAppId,
  _testTenantId,
}: AppProviderProps): React.JSX.Element {
  const { bffClient, permissionCache, wsManager } = useProviderSingletons(bffBaseUrl);

  const [initState, setInitState] = React.useState<AppProviderInitState>({
    status: "loading",
  });
  // Incrementing retryCount re-runs the init effect so the user can recover
  // from a failed initialisation without a full page reload.
  const [retryCount, setRetryCount] = React.useState(0);
  const [user, setUser] = React.useState<UserContext | null>(null);

  // appId and tenantId are read once at mount. Stored in ref because they
  // do not participate in re-render logic — they are stable config values.
  const configRef = React.useRef<OPAppConfig | null>(null);

  React.useEffect(() => {
    let cancelled = false;

    // Reset to loading state at the start of each (re)try so the UI shows the
    // loading fallback rather than a stale error while requests are in-flight.
    setInitState({ status: "loading" });

    async function init(): Promise<void> {
      // Step 1: read and validate config
      let config: OPAppConfig;
      try {
        // Build overrides without undefined values to satisfy exactOptionalPropertyTypes
        const overrides: { appId?: string; tenantId?: string } = {};
        if (_testAppId !== undefined) overrides.appId = _testAppId;
        if (_testTenantId !== undefined) overrides.tenantId = _testTenantId;
        // configProp takes precedence over window.__OP_APP_CONFIG__ — used for
        // local development where the platform HTML shell is not present.
        config = readAppConfig(configProp, overrides);
        configRef.current = config;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(msg);
        if (!cancelled) setInitState({ status: "error", message: msg });
        return;
      }

      // Step 2: configure the BFF client with the app ID so every subsequent
      // request carries the required X-App-Id header (see BffClient.configure).
      bffClient.configure(config.appId);

      // Step 3: register the 401 → login redirect handler
      bffClient.setUnauthorizedHandler(() => {
        const redirect = encodeURIComponent(
          window.location.pathname + window.location.search,
        );
        window.location.href = `/login?redirect=${redirect}`;
      });

      // Step 4: fetch /bff/me and /bff/permissions in parallel (C-4).
      // V6-192: Each call retries independently so a transient failure on one
      // does not reset the retry counter for the other. Both must succeed for
      // initialisation to complete.
      try {
        const [meResult] = await Promise.all([
          withRetry(() =>
            bffClient.request<{ data: UserContext } | UserContext>("/bff/me"),
          ),
          withRetry(() => permissionCache.seed(bffClient)),
        ]);

        if (cancelled) return;

        // BFF returns { data: UserContext } envelope; unwrap if present.
        const meData = (meResult as { data?: UserContext }).data ?? (meResult as UserContext);
        setUser(meData);

        // Step 4: open the WebSocket connection.
        // WebSocketManager builds /apps/{slug}/ws — pass the app slug, not the UUID appId.
        // Falls back to appId when slug is unavailable (e.g. embed mode) so the WS
        // connection at least attempts to connect rather than silently doing nothing.
        wsManager.connect(config.appSlug ?? config.appId);

        setInitState({ status: "ready" });
      } catch (err) {
        // 401 is handled by the unauthorized handler above (which redirects).
        // Non-401 errors render an inline error UI with a retry button after
        // all BFF_MAX_RETRIES attempts have been exhausted.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- retryCount drives re-runs; test overrides are stable
  }, [retryCount]);

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
    // Only expose the raw error message in development builds. In production
    // the message may contain internal service details (URL paths, auth config)
    // that should not be surfaced to end users.
    //
    // __OP_DEV__ is injected by the build tool. When it is absent (e.g. in tests
    // or unbuilt source) we default to showing the message so developers always
    // see useful diagnostics. The production bundle always defines __OP_DEV__=false.
    const isDev = typeof __OP_DEV__ !== "undefined" ? __OP_DEV__ : true;

    return (
      <div
        role="alert"
        aria-live="assertive"
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          minHeight: "100dvh",
          fontFamily: "system-ui, sans-serif",
          padding: "2rem",
          backgroundColor: "var(--op-error-bg, #fff8f8)",
          color: "var(--op-error-fg, #333)",
        }}
      >
        <div
          style={{
            maxWidth: "480px",
            border: "1px solid var(--op-error-border, #fca5a5)",
            borderRadius: "8px",
            padding: "1.5rem",
            backgroundColor: "var(--op-error-surface, #fff)",
            boxShadow: "0 1px 4px rgba(0,0,0,0.08)",
          }}
        >
          <p style={{ margin: "0 0 0.5rem", fontWeight: 600, fontSize: "1rem" }}>
            Unable to load the application
          </p>
          <p
            style={{
              margin: "0 0 1rem",
              fontSize: "0.875rem",
              color: "var(--op-error-subtext, #666)",
            }}
          >
            {isDev
              ? initState.message
              : "The application failed to start. Please try again or contact support if the issue persists."}
          </p>
          <button
            type="button"
            aria-label="Retry loading the application"
            onClick={() => setRetryCount((n) => n + 1)}
            style={{
              padding: "0.5rem 1.25rem",
              borderRadius: "6px",
              border: "1px solid var(--op-error-btn-border, #d1d5db)",
              background: "var(--op-error-btn-bg, #f9fafb)",
              cursor: "pointer",
              fontSize: "0.875rem",
              fontWeight: 500,
            }}
          >
            Try again
          </button>
        </div>
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
