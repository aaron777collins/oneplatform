# L2 Package Design: @oneplatform/app-sdk

**Document Type:** L2 Package Design  
**Status:** Draft  
**Date:** 2026-06-10  
**Author:** Principal Architect  
**References:** ADR-26 (App-SDK and BFF Design), ADR-25 (App Platform Design), ADR-27 (App Access Control), L1 Design Spec §9

---

## Table of Contents

1. [Package Overview](#1-package-overview)
2. [Constraints and Invariants](#2-constraints-and-invariants)
3. [Module Structure](#3-module-structure)
4. [Public API Surface](#4-public-api-surface)
5. [AppProvider](#5-appprovider)
6. [BFF Client (Internal)](#6-bff-client-internal)
7. [Permission Cache (Internal)](#7-permission-cache-internal)
8. [useQuery Hook](#8-usequery-hook)
9. [useMutation Hook](#9-usemutation-hook)
10. [useSubscription Hook](#10-usesubscription-hook)
11. [useUser Hook](#11-useuser-hook)
12. [usePermission Hook](#12-usepermission-hook)
13. [useAppStorage Hook](#13-useappstorage-hook)
14. [Error Handling](#14-error-handling)
15. [Type Generation and Ontology Generics](#15-type-generation-and-ontology-generics)
16. [Security Design](#16-security-design)
17. [Testing Strategy](#17-testing-strategy)
18. [Build and Distribution](#18-build-and-distribution)
19. [Open Questions and Deferred Decisions](#19-open-questions-and-deferred-decisions)

---

## 1. Package Overview

`@oneplatform/app-sdk` is a React hooks library that provides the complete data and platform API surface for apps built inside OnePlatform. It is the only permitted way for hosted apps to interact with platform data and services.

### Scope

This package is used **exclusively inside platform-hosted apps** — that is, React applications written in the Monaco editor, built by esbuild in the Execution Service sandbox, and served by the App Service. It is not a general-purpose SDK. External server-to-server integrations use `@oneplatform/sdk`. Plugin development uses `@oneplatform/plugin-sdk`.

### What this package does

- Provides seven public exports: `AppProvider`, `useQuery`, `useMutation`, `useSubscription`, `useUser`, `usePermission`, `useAppStorage`
- All network I/O targets the App Service BFF (`/bff/*` routes) — never internal services directly
- Authenticates via the `op_session` httpOnly cookie; no tokens are ever accessible in JavaScript
- Maintains a client-side permission cache seeded at mount time and refreshed on visibility change
- Manages a single persistent WebSocket connection for real-time subscriptions

### Peer dependencies

```json
{
  "peerDependencies": {
    "react": ">=18.0.0",
    "react-dom": ">=18.0.0"
  },
  "peerDependenciesMeta": {
    "react-dom": { "optional": false }
  }
}
```

React 18 is the minimum version. The package uses `useId`, `useSyncExternalStore`, and the concurrent-mode-safe `startTransition` API, all of which require React 18.

### Runtime environment assumptions

- Executes in a browser sandbox (`Content-Security-Policy: default-src 'self'; script-src 'self'; connect-src 'self'`)
- No `eval`, no dynamic `import()` after initial load, no cross-origin fetches
- `window.__OP_APP_CONFIG__` is present and populated by the App Service HTML shell before the bundle executes
- All `fetch` calls are same-origin (no CORS needed)
- WebSocket connects to the same origin over the `wss:` scheme

---

## 2. Constraints and Invariants

These are non-negotiable properties that every code change must preserve.

| # | Invariant | Rationale |
|---|-----------|-----------|
| C-1 | No service token or internal access JWT is ever present in JavaScript-accessible memory | XSS cannot steal credentials it cannot read |
| C-2 | All BFF calls use `credentials: "include"` | The httpOnly `op_session` cookie is sent automatically; no explicit auth header |
| C-3 | `usePermission` is always synchronous | Components must not suspend on permission checks; UI jank is unacceptable |
| C-4 | Permission cache is loaded before any hook renders data | Hooks must not render data before permission state is known |
| C-5 | The BFF client never follows redirects to non-same-origin URLs | Prevents open redirect exploitation |
| C-6 | WebSocket URL is constructed from `window.location.origin` only | Prevents WebSocket endpoint injection |
| C-7 | `useAppStorage` values are serialised as JSON before storage; maximum 64 KB enforced client-side before the write | Prevents silent truncation on the server |
| C-8 | No default exports | Tree-shaking requires named exports; default exports in React component libraries cause bundler confusion |
| C-9 | Zero runtime dependencies beyond `react` and `react-dom` | The sandbox image pre-bundles a fixed set of modules; no additional `node_modules` can be fetched at runtime |

---

## 3. Module Structure

```
packages/app-sdk/
  package.json
  tsconfig.json
  tsconfig.build.json
  vitest.config.ts
  src/
    index.ts                      # Public barrel — named re-exports only
    provider/
      AppProvider.tsx             # Root context provider
      AppContext.ts               # React context shape and default value
      types.ts                    # AppConfig, AppProviderState
    client/
      BffClient.ts                # Internal fetch wrapper
      BffClient.test.ts
      errors.ts                   # AppSDKError class and error factory
      errors.test.ts
    cache/
      PermissionCache.ts          # Permission snapshot cache
      PermissionCache.test.ts
      QueryCache.ts               # In-memory query result cache
      QueryCache.test.ts
    hooks/
      useQuery.ts
      useQuery.test.ts
      useMutation.ts
      useMutation.test.ts
      useSubscription.ts
      useSubscription.test.ts
      useUser.ts
      useUser.test.ts
      usePermission.ts
      usePermission.test.ts
      useAppStorage.ts
      useAppStorage.test.ts
    ws/
      WebSocketManager.ts         # Singleton WebSocket lifecycle
      WebSocketManager.test.ts
    types/
      api.ts                      # BFF request/response shapes
      entities.ts                 # Generic entity types
      events.ts                   # EntityEvent, SubscriptionOptions
      index.ts                    # Re-exports all public types
  __mocks__/
    BffClient.ts                  # Manual mock for tests
    WebSocketManager.ts
```

### Barrel export discipline

`src/index.ts` exports exactly the public API surface. Internal modules (`client/`, `cache/`, `ws/`) are not re-exported. Any import of `@oneplatform/app-sdk/client/BffClient` from user code will result in a build error because esbuild's allowed-imports enforcement operates at the bundle level.

```typescript
// src/index.ts — complete export list
export { AppProvider } from "./provider/AppProvider";
export { useQuery } from "./hooks/useQuery";
export { useMutation } from "./hooks/useMutation";
export { useSubscription } from "./hooks/useSubscription";
export { useUser } from "./hooks/useUser";
export { usePermission } from "./hooks/usePermission";
export { useAppStorage } from "./hooks/useAppStorage";
export type {
  QueryOptions,
  QueryResult,
  MutationResult,
  SubscriptionOptions,
  SubscriptionResult,
  UserContext,
  AppSDKError,
  EntityEvent,
  BulkResult,
  FilterValue,
} from "./types/index";
```

---

## 4. Public API Surface

Complete TypeScript signatures for all public exports.

```typescript
// ─────────────────────────────────────────────────────────────────────────────
// AppProvider
// ─────────────────────────────────────────────────────────────────────────────

interface AppProviderProps {
  children: React.ReactNode;
  /**
   * Override appId for testing. In production this is always read from
   * window.__OP_APP_CONFIG__.appId and this prop is ignored.
   */
  _testAppId?: string;
  _testTenantId?: string;
}

function AppProvider(props: AppProviderProps): JSX.Element;

// ─────────────────────────────────────────────────────────────────────────────
// useQuery<T>
// ─────────────────────────────────────────────────────────────────────────────

type FilterOperator = "eq" | "ne" | "lt" | "lte" | "gt" | "gte" | "in" | "nin" | "contains";
type FilterValue = string | number | boolean | string[] | number[];

interface FilterSpec {
  [field: string]: Partial<Record<FilterOperator, FilterValue>>;
}

interface QueryOptions {
  filter?: FilterSpec;
  sort?: string[];          // ["name", "-createdAt"] — prefix "-" for DESC
  fields?: string[];        // field projection; omit for all
  cursor?: string;          // pagination cursor; omit for first page
  limit?: number;           // default 50, max 100
  enabled?: boolean;        // if false, skip fetch (default true)
  staleTime?: number;       // ms before refetch on next render (default 30_000)
  onError?: (error: AppSDKError) => void;
}

interface Pagination {
  nextCursor: string | null;
  total: number;
}

interface QueryResult<T> {
  data: T[] | null;
  pagination: Pagination | null;
  isLoading: boolean;
  isError: boolean;
  error: AppSDKError | null;
  refetch: () => Promise<void>;
  fetchNextPage: () => Promise<void>;
}

function useQuery<T = unknown>(
  entity: string,
  options?: QueryOptions
): QueryResult<T>;

// ─────────────────────────────────────────────────────────────────────────────
// useMutation<T>
// ─────────────────────────────────────────────────────────────────────────────

interface BulkResult<T> {
  created: T[];
  errors: Array<{ index: number; error: AppSDKError }>;
}

interface MutationResult<T> {
  create: (data: Partial<T>) => Promise<T>;
  update: (id: string, data: Partial<T>) => Promise<T>;   // PATCH
  replace: (id: string, data: T) => Promise<T>;           // PUT
  remove: (id: string) => Promise<void>;
  bulkCreate: (items: Partial<T>[]) => Promise<BulkResult<T>>;
  isLoading: boolean;
  isError: boolean;
  error: AppSDKError | null;
  reset: () => void;  // clears isError and error
}

function useMutation<T = unknown>(entity: string): MutationResult<T>;

// ─────────────────────────────────────────────────────────────────────────────
// useSubscription<T>
// ─────────────────────────────────────────────────────────────────────────────

type EntityEventType = "created" | "updated" | "deleted";

interface EntityEvent<T> {
  type: EntityEventType;
  entity: string;
  id: string;
  data: T;
  timestamp: string;  // ISO 8601
  tenantId: string;
}

interface SubscriptionOptions {
  filter?: FilterSpec;
  events?: EntityEventType[];  // default: all three
  onEvent?: (event: EntityEvent<unknown>) => void;
}

interface SubscriptionResult<T> {
  lastEvent: EntityEvent<T> | null;
  isConnected: boolean;
  reconnectAttempts: number;
}

function useSubscription<T = unknown>(
  entity: string,
  options?: SubscriptionOptions
): SubscriptionResult<T>;

// ─────────────────────────────────────────────────────────────────────────────
// useUser
// ─────────────────────────────────────────────────────────────────────────────

interface UserContext {
  id: string;
  email: string | null;  // null for guest sessions
  displayName: string;
  tenantId: string;
  roles: string[];
  isGuest: boolean;
}

function useUser(): UserContext;

// ─────────────────────────────────────────────────────────────────────────────
// usePermission
// ─────────────────────────────────────────────────────────────────────────────

type PermissionAction = "create" | "read" | "update" | "delete" | "admin";

function usePermission(
  action: PermissionAction | string,
  resource: string         // entity name or "*" for any
): boolean;

// ─────────────────────────────────────────────────────────────────────────────
// useAppStorage
// ─────────────────────────────────────────────────────────────────────────────

function useAppStorage<T>(
  key: string,
  defaultValue: T
): [T, (value: T) => Promise<void>];

// ─────────────────────────────────────────────────────────────────────────────
// Error type
// ─────────────────────────────────────────────────────────────────────────────

interface AppSDKError {
  code: string;         // e.g. "PERMISSION_DENIED", "ENTITY_NOT_FOUND", "NETWORK_ERROR"
  message: string;
  statusCode: number;   // HTTP status code; 0 for network errors
  isRetryable: boolean; // true for 429, 503, NETWORK_ERROR
  requestId: string;    // X-Request-ID from BFF response; empty string for network errors
}
```

---

## 5. AppProvider

### Responsibilities

`AppProvider` is the mandatory root component for every hosted app. It must be the outermost component in the component tree. It performs four tasks at mount time:

1. Reads `window.__OP_APP_CONFIG__` and validates the shape
2. Initialises the `BffClient` singleton with the base URL
3. Seeds the `PermissionCache` from `GET /bff/permissions`
4. Seeds the user context from `GET /bff/me`
5. Opens the WebSocket connection via `WebSocketManager`

All hooks assume they run inside an `AppProvider`. If they are called outside one, they throw a clear error in development mode and return safe fallback values in production mode.

### window.__OP_APP_CONFIG__

The App Service injects the following into the HTML shell as an inline script (the only inline script allowed by CSP) using a nonce:

```html
<script nonce="{{CSP_NONCE}}">
  window.__OP_APP_CONFIG__ = {
    "appId": "{{APP_ID}}",
    "tenantId": "{{TENANT_ID}}"
  };
</script>
```

`AppProvider` reads and validates this object at mount using a type guard. If the object is absent or malformed, `AppProvider` renders an error boundary fallback and logs a console error. It does not throw during rendering, to avoid an unhandled error from crashing the entire shell page.

```typescript
interface OPAppConfig {
  appId: string;
  tenantId: string;
}

function readAppConfig(overrides?: Partial<OPAppConfig>): OPAppConfig {
  // overrides used only in tests (_testAppId, _testTenantId props)
  const raw = (window as Window & { __OP_APP_CONFIG__?: unknown }).__OP_APP_CONFIG__;
  if (!raw || typeof raw !== "object") {
    throw new Error("[app-sdk] window.__OP_APP_CONFIG__ is missing. Ensure the App Service HTML shell is serving the app correctly.");
  }
  const config = raw as Record<string, unknown>;
  if (typeof config.appId !== "string" || typeof config.tenantId !== "string") {
    throw new Error("[app-sdk] window.__OP_APP_CONFIG__ is missing appId or tenantId.");
  }
  return {
    appId: overrides?.appId ?? config.appId,
    tenantId: overrides?.tenantId ?? config.tenantId,
  };
}
```

### AppContext

```typescript
// src/provider/AppContext.ts

interface AppContextValue {
  appId: string;
  tenantId: string;
  bffClient: BffClient;
  permissionCache: PermissionCache;
  wsManager: WebSocketManager;
  user: UserContext | null;      // null while loading
  isReady: boolean;              // true after permissions + user are loaded
}

const AppContext = React.createContext<AppContextValue | null>(null);

export function useAppContext(): AppContextValue {
  const ctx = React.useContext(AppContext);
  if (ctx === null) {
    if (process.env.NODE_ENV !== "production") {
      throw new Error("[app-sdk] Hook called outside of <AppProvider>. Wrap your app root with <AppProvider>.");
    }
    // Production: return a safe no-op context rather than crashing
    return createNullContext();
  }
  return ctx;
}
```

### Initialisation sequence

`AppProvider` executes the following on mount. Steps 2 and 3 run in parallel. The app renders a loading state until both complete, then sets `isReady: true`.

```
Mount
  │
  ├─ 1. readAppConfig() → { appId, tenantId }
  │
  ├─ 2. GET /bff/me          (via BffClient)  ─────────────────────┐
  │                                                                  │ parallel
  └─ 3. GET /bff/permissions (via BffClient)  ────────── ──────────┘
                                                                     │
                                               both resolve          ▼
                                               set user, seed PermissionCache
                                               isReady = true
                                               render children
```

If either request returns `401`, AppProvider redirects to `/login?redirect={encodeURIComponent(window.location.pathname + window.location.search)}`. This handles expired sessions transparently.

If either request fails with a non-401 error, AppProvider renders an inline error UI (not a full-page redirect). The error is surfaced to the developer in the console with the `requestId` for debugging.

### Re-initialisation on visibility change

When `document.visibilityState` changes to `"visible"`, AppProvider triggers a permission cache refresh (calls `PermissionCache.refresh()`). This handles the case where a user's permissions change while they have the app open in a background tab. The refresh is debounced with a 2-second delay to avoid hammering the BFF immediately on tab switch.

```typescript
React.useEffect(() => {
  const onVisible = debounce(() => {
    if (document.visibilityState === "visible") {
      permissionCache.refresh();
    }
  }, 2000);
  document.addEventListener("visibilitychange", onVisible);
  return () => document.removeEventListener("visibilitychange", onVisible);
}, [permissionCache]);
```

### Children loading behaviour

While `isReady` is false, `AppProvider` renders `null` by default. App developers may pass a `loadingFallback` prop to render a custom loading UI:

```typescript
interface AppProviderProps {
  children: React.ReactNode;
  loadingFallback?: React.ReactNode;  // default: null
  _testAppId?: string;
  _testTenantId?: string;
}
```

Rationale: rendering children before `isReady` would cause every hook to fire without permission state, producing a brief flash of forbidden data or errors before the permission cache is ready. Suppressing render until `isReady` is the correct default.

---

## 6. BFF Client (Internal)

`BffClient` is an internal class (not exported). It wraps `fetch` with consistent error handling, request ID generation, and credential handling.

### Class definition

```typescript
// src/client/BffClient.ts

interface BffRequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  queryParams?: Record<string, string | number | boolean | string[]>;
  signal?: AbortSignal;
}

class BffClient {
  private readonly baseUrl: string;

  constructor() {
    // Base URL is always the same origin — no configuration needed
    this.baseUrl = window.location.origin;
  }

  async request<T>(path: string, options: BffRequestOptions = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (options.queryParams) {
      appendQueryParams(url.searchParams, options.queryParams);
    }

    let response: Response;
    try {
      response = await fetch(url.toString(), {
        method: options.method ?? "GET",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
        },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        credentials: "include",  // Always include httpOnly cookie
        redirect: "error",       // Never follow redirects — C-5
        signal: options.signal,
      });
    } catch (err) {
      throw createNetworkError(err);
    }

    if (!response.ok) {
      throw await parseBffError(response);
    }

    return response.json() as Promise<T>;
  }
}
```

### Query parameter serialisation

Filter parameters follow the bracket notation used by the BFF:

```
filter[status][eq]=active
filter[ownerId][in][]=id1&filter[ownerId][in][]=id2
sort[0]=name&sort[1]=-createdAt
fields[0]=id&fields[1]=name
cursor=eyJpZCI6IjEyMyJ9
limit=50
```

`appendQueryParams` handles array flattening and nested object notation.

### Error parsing

```typescript
async function parseBffError(response: Response): Promise<AppSDKError> {
  const requestId = response.headers.get("X-Request-ID") ?? "";
  let body: { error?: { code?: string; message?: string } } = {};
  try {
    body = await response.json();
  } catch {
    // non-JSON error body — use HTTP status text
  }
  return {
    code: body.error?.code ?? httpStatusToCode(response.status),
    message: body.error?.message ?? response.statusText,
    statusCode: response.status,
    isRetryable: [429, 503].includes(response.status),
    requestId,
  };
}

function httpStatusToCode(status: number): string {
  const map: Record<number, string> = {
    400: "BAD_REQUEST",
    401: "UNAUTHORIZED",
    403: "PERMISSION_DENIED",
    404: "ENTITY_NOT_FOUND",
    409: "CONFLICT",
    429: "RATE_LIMITED",
    500: "INTERNAL_ERROR",
    503: "SERVICE_UNAVAILABLE",
  };
  return map[status] ?? "UNKNOWN_ERROR";
}
```

### Network error factory

```typescript
function createNetworkError(err: unknown): AppSDKError {
  const message = err instanceof Error ? err.message : "Network request failed";
  return {
    code: "NETWORK_ERROR",
    message,
    statusCode: 0,
    isRetryable: true,
    requestId: "",
  };
}
```

### AbortController management

Every `BffClient.request` call accepts an optional `AbortSignal`. Hooks create and manage their own `AbortController` instances in `useEffect` cleanup. `BffClient` itself does not manage timeouts — that is the responsibility of individual hooks.

---

## 7. Permission Cache (Internal)

`PermissionCache` holds a snapshot of all permissions for the current user and supports synchronous boolean lookups. It is seeded at `AppProvider` mount and refreshed on visibility change.

### BFF endpoint

```
GET /bff/permissions
Response: {
  permissions: Array<{
    action: string;      // "create" | "read" | "update" | "delete" | "admin"
    resource: string;    // entity name or "*"
    allowed: boolean;
  }>
}
```

### Cache shape

Permissions are indexed in a `Map<string, boolean>` keyed by `"${action}:${resource}"` for O(1) synchronous lookup.

```typescript
// src/cache/PermissionCache.ts

class PermissionCache {
  private snapshot: Map<string, boolean> = new Map();
  private hasWildcardAdmin = false;
  private listeners = new Set<() => void>();
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

  async seed(bffClient: BffClient): Promise<void> {
    const data = await bffClient.request<PermissionsResponse>("/bff/permissions");
    this.applySnapshot(data.permissions);
    this.scheduleRefresh(bffClient);
  }

  check(action: string, resource: string): boolean {
    // Admin wildcard on any resource grants all actions on that resource
    if (this.snapshot.get(`admin:*`) === true) return true;
    if (this.snapshot.get(`admin:${resource}`) === true) return true;
    return this.snapshot.get(`${action}:${resource}`) === true ||
           this.snapshot.get(`${action}:*`) === true;
  }

  async refresh(bffClient: BffClient): Promise<void> {
    try {
      const data = await bffClient.request<PermissionsResponse>("/bff/permissions");
      this.applySnapshot(data.permissions);
      this.notifyListeners();
    } catch {
      // Refresh failure is non-fatal. Keep serving the existing snapshot.
      // The next scheduled refresh will try again.
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private applySnapshot(permissions: PermissionEntry[]): void {
    this.snapshot = new Map(
      permissions.map((p) => [`${p.action}:${p.resource}`, p.allowed])
    );
  }

  private notifyListeners(): void {
    this.listeners.forEach((fn) => fn());
  }

  private scheduleRefresh(bffClient: BffClient): void {
    this.refreshTimer = setInterval(
      () => void this.refresh(bffClient),
      this.REFRESH_INTERVAL_MS
    );
  }

  destroy(): void {
    if (this.refreshTimer !== null) clearInterval(this.refreshTimer);
    this.listeners.clear();
  }
}
```

### Why a flat snapshot, not a tree

A nested `{ resource: { action: boolean } }` tree would require a lookup like `snapshot?.customers?.read`. A flat `Map<"read:customers", boolean>` is O(1), requires no optional chaining, and is trivially inspectable in DevTools. The wildcard check adds at most one additional lookup.

### Stale permission handling

If the user's permissions change between a `PermissionCache` refresh, components calling `usePermission` will temporarily show a stale result. This is an acceptable trade-off — the BFF enforces RBAC on every actual data request regardless of the client-side cache. A stale `true` from `usePermission` followed by a `403` from the BFF is handled by the hook's error path. A stale `false` hides UI elements that the user now has access to; these reappear on next refresh or visibility change.

---

## 8. useQuery Hook

### Behaviour contract

- Fetches `GET /bff/data/{entity}` with query parameters derived from `options`
- Deduplicates concurrent calls with the same `(entity, options)` key — a second call within the `staleTime` window returns the cached result without re-fetching
- Implements stale-while-revalidate: returns cached data immediately, triggers a background refetch if the entry is older than `staleTime`
- `fetchNextPage` appends to `data[]` using cursor pagination — it does not replace the current result
- Does not fetch if `enabled: false`
- Cancels in-flight fetches on unmount (via `AbortController`)

### Query cache key

The cache key is a stable JSON string of `{ entity, filter, sort, fields, limit }`. The `cursor` is excluded from the key because cursor state is managed inside the hook's internal page list. `staleTime` is excluded because it controls eviction, not identity.

```typescript
function buildCacheKey(entity: string, options: QueryOptions): string {
  return JSON.stringify({
    entity,
    filter: options.filter ?? null,
    sort: options.sort ?? null,
    fields: options.fields ?? null,
    limit: options.limit ?? 50,
  });
}
```

### QueryCache (internal)

`QueryCache` is a module-level singleton (not stored in React state) to enable deduplication across multiple component instances mounting simultaneously.

```typescript
// src/cache/QueryCache.ts

interface CacheEntry<T> {
  data: T[] | null;
  pagination: Pagination | null;
  error: AppSDKError | null;
  fetchedAt: number;  // Date.now()
  promise: Promise<void> | null;  // in-flight deduplification
}

class QueryCache {
  private entries = new Map<string, CacheEntry<unknown>>();

  get<T>(key: string): CacheEntry<T> | undefined {
    return this.entries.get(key) as CacheEntry<T> | undefined;
  }

  set<T>(key: string, entry: CacheEntry<T>): void {
    this.entries.set(key, entry as CacheEntry<unknown>);
  }

  isStale(key: string, staleTime: number): boolean {
    const entry = this.entries.get(key);
    if (!entry) return true;
    return Date.now() - entry.fetchedAt > staleTime;
  }

  invalidate(entity: string): void {
    // Invalidate all cache entries for a given entity (called by useMutation after write)
    for (const key of this.entries.keys()) {
      if (key.includes(`"entity":"${entity}"`)) {
        this.entries.delete(key);
      }
    }
  }
}

export const queryCache = new QueryCache();
```

### Hook implementation sketch

```typescript
// src/hooks/useQuery.ts

export function useQuery<T = unknown>(
  entity: string,
  options: QueryOptions = {}
): QueryResult<T> {
  const { bffClient, isReady } = useAppContext();
  const cacheKey = buildCacheKey(entity, options);
  const staleTime = options.staleTime ?? 30_000;

  // useSyncExternalStore for cache-driven re-renders
  const cachedEntry = useSyncExternalStore(
    (notify) => queryCache.subscribe(cacheKey, notify),
    () => queryCache.get<T>(cacheKey),
  );

  const isLoading = !isReady || (cachedEntry === undefined && !cachedEntry?.error);
  const pages = useRef<string[]>([]);  // cursor chain for fetchNextPage

  const fetchPage = useCallback(
    async (cursor?: string, append = false) => {
      const controller = new AbortController();
      const params = buildQueryParams(options, cursor);
      try {
        const result = await bffClient.request<BffDataResponse<T>>(
          `/bff/data/${entity}`,
          { queryParams: params, signal: controller.signal }
        );
        queryCache.set(cacheKey, {
          data: append
            ? [...(queryCache.get<T>(cacheKey)?.data ?? []), ...result.data]
            : result.data,
          pagination: result.pagination,
          error: null,
          fetchedAt: Date.now(),
          promise: null,
        });
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        const sdkError = err as AppSDKError;
        queryCache.set(cacheKey, {
          data: cachedEntry?.data ?? null,
          pagination: cachedEntry?.pagination ?? null,
          error: sdkError,
          fetchedAt: Date.now(),
          promise: null,
        });
        options.onError?.(sdkError);
      }
    },
    [entity, cacheKey, bffClient, options]
  );

  // Initial fetch and stale-while-revalidate
  useEffect(() => {
    if (!isReady || options.enabled === false) return;
    if (queryCache.isStale(cacheKey, staleTime)) {
      void fetchPage(undefined, false);
    }
  }, [isReady, options.enabled, cacheKey, staleTime, fetchPage]);

  const refetch = useCallback(() => fetchPage(undefined, false), [fetchPage]);

  const fetchNextPage = useCallback(async () => {
    const cursor = cachedEntry?.pagination?.nextCursor;
    if (!cursor) return;
    await fetchPage(cursor, true);
  }, [cachedEntry, fetchPage]);

  return {
    data: cachedEntry?.data ?? null,
    pagination: cachedEntry?.pagination ?? null,
    isLoading: isLoading && !cachedEntry,
    isError: !!cachedEntry?.error,
    error: cachedEntry?.error ?? null,
    refetch,
    fetchNextPage,
  };
}
```

### BFF request URL pattern

```
GET /bff/data/{entity}
  ?filter[field][op]=value
  &sort[0]=field&sort[1]=-otherField
  &fields[0]=id&fields[1]=name
  &cursor=eyJpZCI6IjEyMyJ9
  &limit=50
```

### Stale-while-revalidate semantics

| Cache state | `isLoading` | `data` | Behaviour |
|------------|-------------|--------|-----------|
| No entry | `true` | `null` | Fetch in progress, nothing to show yet |
| Fresh entry | `false` | cached | No re-fetch triggered |
| Stale entry | `false` | cached | Background re-fetch; data updates when resolved |
| Errored entry | `false` | `null` | `isError: true`, `error` set |

---

## 9. useMutation Hook

### Behaviour contract

- Exposes `create`, `update`, `replace`, `remove`, `bulkCreate` functions
- Each function returns a `Promise` that resolves with the server's response or rejects with `AppSDKError`
- Applies optimistic updates to `QueryCache` before the network request, then rolls back on error
- Sets `isLoading: true` while any mutation is in flight; `false` otherwise
- Multiple concurrent mutations on the same entity are serialised (queued) to avoid race conditions on optimistic state

### BFF request mapping

| Method | HTTP | URL |
|--------|------|-----|
| `create(data)` | `POST` | `/bff/data/{entity}` |
| `update(id, data)` | `PATCH` | `/bff/data/{entity}/{id}` |
| `replace(id, data)` | `PUT` | `/bff/data/{entity}/{id}` |
| `remove(id)` | `DELETE` | `/bff/data/{entity}/{id}` |
| `bulkCreate(items)` | `POST` | `/bff/data/{entity}/bulk` |

### Optimistic update strategy

On `create`: append a provisional record (with a client-generated `_optimisticId` field) to all `QueryCache` entries for the entity.

On `update`/`replace`: replace the matching record in all `QueryCache` entries for the entity.

On `remove`: remove the matching record from all `QueryCache` entries for the entity.

The provisional record or modification is applied synchronously before the fetch. On network error, the cache is restored to its pre-mutation state using the saved snapshot.

```typescript
export function useMutation<T = unknown>(entity: string): MutationResult<T> {
  const { bffClient } = useAppContext();
  const [state, setState] = useState<MutationState>({
    isLoading: false,
    isError: false,
    error: null,
  });

  const mutationQueue = useRef<Promise<void>>(Promise.resolve());

  function enqueue<R>(fn: () => Promise<R>): Promise<R> {
    let resolve!: (v: R) => void;
    let reject!: (e: unknown) => void;
    const p = new Promise<R>((res, rej) => { resolve = res; reject = rej; });
    mutationQueue.current = mutationQueue.current.then(async () => {
      try { resolve(await fn()); } catch (e) { reject(e); }
    });
    return p;
  }

  const create = useCallback((data: Partial<T>): Promise<T> => {
    return enqueue(async () => {
      setState({ isLoading: true, isError: false, error: null });
      const snapshot = queryCache.snapshot(entity);
      const optimisticId = `_opt_${crypto.randomUUID()}`;
      queryCache.optimisticCreate(entity, { ...data, _optimisticId: optimisticId });
      try {
        const result = await bffClient.request<T>(`/bff/data/${entity}`, {
          method: "POST",
          body: data,
        });
        queryCache.confirmCreate(entity, optimisticId, result as Record<string, unknown>);
        setState({ isLoading: false, isError: false, error: null });
        return result;
      } catch (err) {
        queryCache.restoreSnapshot(entity, snapshot);
        const sdkError = err as AppSDKError;
        setState({ isLoading: false, isError: true, error: sdkError });
        throw sdkError;
      }
    });
  }, [entity, bffClient]);

  // update, replace, remove, bulkCreate follow the same pattern
  // ...

  return {
    create,
    update: /* ... */,
    replace: /* ... */,
    remove: /* ... */,
    bulkCreate: /* ... */,
    isLoading: state.isLoading,
    isError: state.isError,
    error: state.error,
    reset: () => setState({ isLoading: false, isError: false, error: null }),
  };
}
```

### Why a mutation queue

Without serialisation, two rapid calls to `remove("id-1")` followed by `create({ ... })` can apply optimistic state out of order, producing a corrupted cache. Queuing mutations ensures they apply sequentially while still returning individual Promises to callers. The queue is per-hook instance, not global.

### Cache invalidation after mutation

After a successful mutation, `useMutation` calls `queryCache.invalidate(entity)`. This removes all cached entries for the entity, causing `useQuery` instances for that entity to re-fetch on the next render cycle. This is correct but can cause a brief flash; the alternative (manual cache patching) is complex and error-prone. The `staleTime` on `useQuery` defaults to 30 seconds, so frequent mutations do not cause excessive re-fetches in practice.

---

## 10. useSubscription Hook

### Behaviour contract

- Opens (or reuses) a shared WebSocket connection to `wss://{origin}/apps/{slug}/ws` via `WebSocketManager`
- Registers interest in a specific entity and filter with the server by sending a subscription message over the WebSocket
- Delivers incoming events to the caller via `lastEvent` state and the optional `onEvent` callback
- Reports connection status (`isConnected`) and reconnect attempt count
- Unregisters the subscription on unmount (sends an unsubscribe message to the server)

### WebSocketManager (internal)

One WebSocket connection is shared across all `useSubscription` instances within a single app. `WebSocketManager` is a singleton managed by `AppProvider`.

```typescript
// src/ws/WebSocketManager.ts

interface SubscriptionRegistration {
  entity: string;
  filter?: FilterSpec;
  events?: EntityEventType[];
  onEvent: (event: EntityEvent<unknown>) => void;
}

class WebSocketManager {
  private socket: WebSocket | null = null;
  private registrations = new Map<string, SubscriptionRegistration>();
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private statusListeners = new Set<(connected: boolean, attempts: number) => void>();
  private readonly MAX_RECONNECT_DELAY_MS = 30_000;
  private readonly BASE_RECONNECT_DELAY_MS = 1_000;

  connect(appSlug: string): void {
    const url = `${window.location.origin.replace(/^http/, "ws")}/apps/${appSlug}/ws`;
    this.socket = new WebSocket(url);
    this.socket.addEventListener("open", this.onOpen);
    this.socket.addEventListener("message", this.onMessage);
    this.socket.addEventListener("close", this.onClose);
    this.socket.addEventListener("error", this.onError);
  }

  register(id: string, reg: SubscriptionRegistration): void {
    this.registrations.set(id, reg);
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.send({ type: "subscribe", subscriptionId: id, entity: reg.entity, filter: reg.filter, events: reg.events });
    }
    // If not connected, registrations are replayed in onOpen
  }

  unregister(id: string): void {
    this.registrations.delete(id);
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.send({ type: "unsubscribe", subscriptionId: id });
    }
  }

  private onOpen = (): void => {
    this.reconnectAttempts = 0;
    this.notifyStatus(true, 0);
    // Replay all registrations (handles reconnect case)
    for (const [id, reg] of this.registrations) {
      this.send({ type: "subscribe", subscriptionId: id, entity: reg.entity, filter: reg.filter, events: reg.events });
    }
  };

  private onMessage = (event: MessageEvent): void => {
    let msg: EntityEvent<unknown> & { subscriptionId?: string };
    try { msg = JSON.parse(event.data as string); } catch { return; }
    const reg = this.registrations.get(msg.subscriptionId ?? "");
    if (reg) reg.onEvent(msg);
  };

  private onClose = (): void => {
    this.notifyStatus(false, this.reconnectAttempts);
    this.scheduleReconnect();
  };

  private scheduleReconnect(): void {
    const delay = Math.min(
      this.BASE_RECONNECT_DELAY_MS * 2 ** this.reconnectAttempts,
      this.MAX_RECONNECT_DELAY_MS
    );
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      const slug = this.extractSlug();
      if (slug) this.connect(slug);
    }, delay);
  }

  destroy(): void {
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.statusListeners.clear();
  }
}
```

### Reconnect policy

Exponential backoff with jitter, capped at 30 seconds:

```
attempt 0 → 1s
attempt 1 → 2s
attempt 2 → 4s
attempt 3 → 8s
attempt 4 → 16s
attempt 5+ → 30s (capped)
```

After reconnect, all active subscriptions are re-sent automatically (the `onOpen` handler replays registrations). No subscriber needs to do anything on reconnect.

### useSubscription implementation

```typescript
// src/hooks/useSubscription.ts

export function useSubscription<T = unknown>(
  entity: string,
  options: SubscriptionOptions = {}
): SubscriptionResult<T> {
  const { wsManager } = useAppContext();
  const id = useId();  // React 18 stable ID
  const [lastEvent, setLastEvent] = useState<EntityEvent<T> | null>(null);

  const [status, setStatus] = useSyncExternalStore(
    (notify) => wsManager.subscribeToStatus(notify),
    () => wsManager.getStatus(),
  );

  useEffect(() => {
    wsManager.register(id, {
      entity,
      filter: options.filter,
      events: options.events,
      onEvent: (event) => {
        setLastEvent(event as EntityEvent<T>);
        options.onEvent?.(event);
      },
    });
    return () => wsManager.unregister(id);
  }, [id, entity, wsManager]);
  // options.filter, options.events, options.onEvent are intentionally excluded
  // from deps to avoid re-registering on every render if caller passes literals.
  // Callers must memoize options if they need dynamic filter changes.

  return {
    lastEvent,
    isConnected: status.isConnected,
    reconnectAttempts: status.reconnectAttempts,
  };
}
```

### Options stability note

The `options` object is excluded from the `useEffect` dependency array. This is intentional and must be documented for app developers. If `options.filter` changes and the developer needs the subscription to re-register with the new filter, they must wrap the options in `useMemo`. This mirrors the pattern used by libraries like `react-query` for query key stability.

---

## 11. useUser Hook

### Behaviour contract

- Returns the cached user context loaded by `AppProvider` at mount
- No network calls per render — `AppProvider` has already populated the context
- If the session expires during the app's lifetime (rare for a 7-day session), the next BFF call returns `401`, and `AppProvider`'s global error handler redirects to login. `useUser` itself does not re-fetch.

### Implementation

```typescript
// src/hooks/useUser.ts

export function useUser(): UserContext {
  const { user } = useAppContext();

  if (user === null) {
    // AppProvider is still loading (isReady: false). Return a safe sentinel value.
    return {
      id: "",
      email: null,
      displayName: "",
      tenantId: "",
      roles: [],
      isGuest: false,
    };
  }

  return user;
}
```

### BFF endpoint

```
GET /bff/me
Response: {
  id: string;
  email: string | null;       // null for guest sessions
  displayName: string;
  tenantId: string;
  roles: string[];
  isGuest: boolean;
}
```

The response shape maps directly to `UserContext`. The App Service derives all fields from the `op_session` cookie via the Auth Service without any user-supplied input.

---

## 12. usePermission Hook

### Behaviour contract

- Synchronous — never suspends, never causes a loading state
- Reads from `PermissionCache` which is loaded before `AppProvider` renders children (so it is always ready when a hook component renders)
- Re-renders affected components when `PermissionCache` is refreshed (via `useSyncExternalStore`)

### Implementation

```typescript
// src/hooks/usePermission.ts

export function usePermission(
  action: PermissionAction | string,
  resource: string
): boolean {
  const { permissionCache } = useAppContext();

  // useSyncExternalStore ensures re-render when cache is refreshed
  return useSyncExternalStore(
    (notify) => permissionCache.subscribe(notify),
    () => permissionCache.check(action, resource),
  );
}
```

### Why useSyncExternalStore

`useSyncExternalStore` is the correct React 18 primitive for subscribing to external mutable stores. It handles concurrent mode safely — it tears consistently and avoids the tearing problems that `useState` + `useEffect` + listener patterns introduce in React 18's concurrent rendering.

### Usage guidance (for app developers)

```typescript
// Conditional render based on permission
function AdminPanel() {
  const canAdmin = usePermission("admin", "users");
  if (!canAdmin) return null;
  return <UserTable />;
}

// Disable button based on permission
function SaveButton({ onClick }) {
  const canCreate = usePermission("create", "orders");
  return (
    <button onClick={onClick} disabled={!canCreate}>
      Create Order
    </button>
  );
}
```

### Permission model mapping

The BFF returns a flat array of allowed permissions. The `PermissionCache.check` method applies the following precedence:

1. If `admin:*` is in the snapshot, all checks return `true`
2. If `admin:{resource}` is in the snapshot, all action checks for that resource return `true`
3. If `{action}:*` is in the snapshot, the action is permitted on any resource
4. If `{action}:{resource}` is in the snapshot, the action is permitted on that specific resource
5. Otherwise, `false`

---

## 13. useAppStorage Hook

### Behaviour contract

- Returns `[value, setValue]` where `value` is the current stored value (or `defaultValue` if nothing is stored)
- `setValue` sends a `PUT /bff/storage/{key}` request and updates local state optimistically
- Key constraints: maximum 128 characters, alphanumeric plus `-` and `_`
- Value constraints: serialisable as JSON, maximum 64 KB (enforced client-side before PUT)
- Storage is per-app and per-user — two users viewing the same app have independent storage
- Persistence: survives browser refresh via the BFF (not `localStorage`)

### BFF endpoints

```
GET /bff/storage/{key}
Response: { key: string; value: unknown; updatedAt: string } | { key: string; value: null }

PUT /bff/storage/{key}
Request body: { value: unknown }
Response: { key: string; value: unknown; updatedAt: string }
```

### Implementation

```typescript
// src/hooks/useAppStorage.ts

const MAX_KEY_LENGTH = 128;
const MAX_VALUE_BYTES = 64 * 1024;  // 64 KB
const VALID_KEY_PATTERN = /^[a-zA-Z0-9_-]+$/;

export function useAppStorage<T>(
  key: string,
  defaultValue: T
): [T, (value: T) => Promise<void>] {
  const { bffClient, isReady } = useAppContext();
  const [value, setValueState] = useState<T>(defaultValue);
  const [isLoaded, setIsLoaded] = useState(false);

  if (key.length > MAX_KEY_LENGTH || !VALID_KEY_PATTERN.test(key)) {
    throw new Error(`[app-sdk] useAppStorage key "${key}" is invalid. Keys must be 1-128 alphanumeric characters, hyphens, or underscores.`);
  }

  // Load initial value from BFF
  useEffect(() => {
    if (!isReady) return;
    let cancelled = false;
    bffClient.request<StorageGetResponse>(`/bff/storage/${encodeURIComponent(key)}`)
      .then((res) => {
        if (!cancelled) {
          setValueState(res.value !== null ? (res.value as T) : defaultValue);
          setIsLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) setIsLoaded(true);  // Use defaultValue on error
      });
    return () => { cancelled = true; };
  }, [isReady, key]);

  const setValue = useCallback(async (newValue: T): Promise<void> => {
    const serialised = JSON.stringify(newValue);
    const byteLength = new TextEncoder().encode(serialised).length;
    if (byteLength > MAX_VALUE_BYTES) {
      throw {
        code: "VALUE_TOO_LARGE",
        message: `Storage value for key "${key}" exceeds 64 KB limit (${byteLength} bytes).`,
        statusCode: 0,
        isRetryable: false,
        requestId: "",
      } satisfies AppSDKError;
    }
    // Optimistic update
    setValueState(newValue);
    await bffClient.request(`/bff/storage/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: { value: newValue },
    });
  }, [key, bffClient]);

  return [isLoaded ? value : defaultValue, setValue];
}
```

### Guest session behaviour

For guest sessions (`useUser().isGuest === true`), the BFF writes storage to a short-lived guest session record. Writes succeed but expire when the guest session expires (24 hours). `useAppStorage` has no special handling for this — the hook behaves identically. The expiry semantics are a BFF concern.

---

## 14. Error Handling

### Error taxonomy

All errors are normalised to `AppSDKError` before reaching the caller.

| Code | Status | Retryable | Source |
|------|--------|-----------|--------|
| `NETWORK_ERROR` | 0 | Yes | fetch threw (offline, DNS, timeout) |
| `UNAUTHORIZED` | 401 | No | Session expired — AppProvider redirects to login |
| `PERMISSION_DENIED` | 403 | No | RBAC check failed at BFF |
| `ENTITY_NOT_FOUND` | 404 | No | Entity or record does not exist |
| `VALIDATION_ERROR` | 400 | No | Request body failed BFF validation |
| `CONFLICT` | 409 | No | Optimistic lock conflict |
| `RATE_LIMITED` | 429 | Yes | Too many requests from this browser |
| `INTERNAL_ERROR` | 500 | No | BFF internal error |
| `SERVICE_UNAVAILABLE` | 503 | Yes | Downstream service temporarily down |
| `VALUE_TOO_LARGE` | 0 | No | Storage value exceeds 64 KB (client-side check) |

### Global 401 handling

Any `401` response from any BFF endpoint is intercepted by `BffClient` before returning the error to the hook. `BffClient` calls a registered `onUnauthorized` callback (set by `AppProvider`) which triggers the redirect to `/login`.

```typescript
class BffClient {
  private onUnauthorized: (() => void) | null = null;

  setUnauthorizedHandler(handler: () => void): void {
    this.onUnauthorized = handler;
  }

  async request<T>(path: string, options: BffRequestOptions = {}): Promise<T> {
    // ...
    if (response.status === 401) {
      this.onUnauthorized?.();
      // Throw so the individual hook also knows (even though AppProvider will redirect)
      throw await parseBffError(response);
    }
    // ...
  }
}
```

AppProvider registers the handler at mount:

```typescript
bffClient.setUnauthorizedHandler(() => {
  window.location.href = `/login?redirect=${encodeURIComponent(window.location.pathname + window.location.search)}`;
});
```

### useQuery error behaviour

`useQuery` does not throw on error. It sets `isError: true` and `error` on the returned object. This follows the pattern established by React Query and SWR, which developers are already familiar with. `useQuery` does NOT use React's `ErrorBoundary` mechanism — the caller is expected to handle the `isError` state explicitly.

### useMutation error behaviour

`useMutation.create/update/replace/remove/bulkCreate` return Promises that reject with `AppSDKError`. The caller must handle the rejected Promise. `isError` and `error` on the hook result reflect the most recent mutation's error state.

### Retry policy

No automatic retry is built into the SDK. The `isRetryable` flag on `AppSDKError` signals to the caller whether retrying makes sense. App developers who want retry behaviour should wrap mutation calls with their own retry logic. The rationale is that automatic retries for mutations (create, update, delete) can cause duplicate operations if the original request succeeded but the response was lost. Automatic retry for queries is safer but would require exponential backoff state, increasing complexity. Since the platform rate-limits at 500 requests/minute (well above any realistic app usage), network transients are rare.

---

## 15. Type Generation and Ontology Generics

### Goal

App developers write `useQuery<Customer>()` and get full TypeScript type safety on `data`, `create`, `update` etc. — field names autocomplete, wrong field names are compile errors, returned `data` is typed as `Customer[]`.

### How types reach Monaco

The App Service generates TypeScript declaration files for all tenant entities and injects them into Monaco using `monaco.languages.typescript.typescriptDefaults.addExtraLib()` before the editor renders. These files are generated by the Ontology Service's code generation path (ADR-14) and delivered to the browser via `GET /api/v1/apps/{id}/types`.

The injected declarations look like:

```typescript
// auto-generated — do not edit
declare module "@oneplatform/app-sdk" {
  export interface Customer {
    id: string;
    name: string;
    email: string;
    status: "active" | "churned" | "prospect";
    createdAt: string;
    tenantId: string;
  }

  export interface Order {
    id: string;
    customerId: string;
    total: number;
    status: "pending" | "fulfilled" | "cancelled";
    createdAt: string;
    tenantId: string;
  }
}
```

With these declarations present, `useQuery<Customer>` resolves to `QueryResult<Customer>`, and `data` is typed as `Customer[] | null`.

### Package-level generics

The SDK itself ships with all hooks typed as generics with default `T = unknown`. This means the package works correctly without any injected declarations — the developer simply loses static type safety. The injected declarations are additive, not required.

### TypeScript strict mode

All package source files are compiled with `"strict": true`. The generated declaration files must also pass strict type checking (the App Service validates them after generation).

---

## 16. Security Design

### Authentication model

The SDK carries no tokens. Authentication state is entirely in the `op_session` httpOnly Secure SameSite=Strict cookie, which is set by the App Service at login and is invisible to JavaScript. Every `fetch` call uses `credentials: "include"` to send this cookie automatically.

An attacker who achieves XSS in the app sandbox cannot extract the session cookie. They can call BFF endpoints via `fetch` (the cookie is sent automatically), but:
1. All BFF calls are subject to RBAC enforcement before reaching any internal service
2. The `connect-src 'self'` CSP directive prevents calling any non-same-origin URL
3. The `Content-Security-Policy: frame-ancestors 'self'` header prevents the app from being embedded in a malicious page

### CSRF

`SameSite=Strict` cookies are not sent on cross-site requests. A cross-site attacker cannot include the `op_session` cookie in a forged request. For apps served under the platform's own origin, `SameSite=Strict` is fully effective. For custom subdomain deployments where `SameSite` may not prevent cross-subdomain requests (same eTLD+1), the App Service additionally checks the `Origin` header against the app's registered origin (per ADR-26).

### Input sanitisation

The SDK validates:
- Storage keys: pattern `/^[a-zA-Z0-9_-]+$/`, max 128 chars — prevents path traversal in `/bff/storage/{key}`
- Storage value size: max 64 KB checked client-side before PUT — fail-fast, better UX than a server 413
- Entity names passed to hooks: entity names containing `/` or `..` would produce invalid BFF URLs. The SDK normalises entity names with `encodeURIComponent`.

### Scope isolation

`useAppStorage` keys are scoped to `{ appId, userId }` on the server. There is no client-side enforcement needed — the BFF does the scoping. However, developers should be aware that two apps cannot share storage via `useAppStorage`; cross-app communication is an inter-app messaging feature outside the scope of this package.

### Permission cache staleness

The permission cache is a best-effort UI optimisation. The BFF enforces RBAC on every actual data request regardless of what the client-side cache says. A stale cached `true` (user lost permission but cache has not refreshed) results in a `403 PERMISSION_DENIED` error from the BFF, which the hook surfaces as `isError: true`. This is the correct security outcome.

---

## 17. Testing Strategy

### Framework

- **Unit tests:** Vitest with React Testing Library (`@testing-library/react`, `@testing-library/hooks`)
- **Mock BFF:** `__mocks__/BffClient.ts` — a manual mock that captures calls and lets tests assert on request arguments and return controlled responses
- **No integration tests** in this package — integration is tested at the App Service level via Docker Compose

### What each test file covers

| File | What to test |
|------|-------------|
| `BffClient.test.ts` | Error parsing for each status code, network error wrapping, query param serialisation, `redirect: "error"` enforcement, `credentials: "include"` assertion |
| `PermissionCache.test.ts` | Wildcard rules, `admin:*` override, refresh on visibility change, staleness after refresh, subscribe/unsubscribe |
| `QueryCache.test.ts` | Stale detection, invalidation by entity, snapshot and restore |
| `useQuery.test.ts` | Data rendering, `isLoading` transitions, `isError` on 403/500, `fetchNextPage` appending, deduplication (same key, two mounts), `enabled: false` skips fetch |
| `useMutation.test.ts` | Optimistic create, rollback on error, queue serialisation (two concurrent creates), `reset()` clears error state |
| `useSubscription.test.ts` | `lastEvent` updates on message, `isConnected` reflects WebSocket state, unmount unregisters |
| `useUser.test.ts` | Returns sentinel when `isReady: false`, returns user when ready, guest session nulls email |
| `usePermission.test.ts` | Synchronous return, re-renders on cache refresh, wildcard matching |
| `useAppStorage.test.ts` | Loads default on empty, 64 KB guard throws before fetch, optimistic update before PUT resolves |
| `AppProvider.test.ts` | Renders children after init, redirects on 401 from `/bff/me`, renders `loadingFallback` during init, invalid `window.__OP_APP_CONFIG__` shows error state |

### Mock BFF pattern

```typescript
// __mocks__/BffClient.ts

const handlers: Map<string, unknown> = new Map();

export function mockBffResponse(path: string, response: unknown): void {
  handlers.set(path, response);
}

export function mockBffError(path: string, error: Partial<AppSDKError>): void {
  handlers.set(path, { __isMockError: true, ...error });
}

export class BffClient {
  async request<T>(path: string): Promise<T> {
    const handler = handlers.get(path);
    if (!handler) throw new Error(`[mock-bff] No handler for ${path}`);
    if ((handler as { __isMockError?: boolean }).__isMockError) throw handler;
    return handler as T;
  }
}
```

### Test wrapper

All hook tests use a shared `renderWithProvider` helper:

```typescript
function renderWithProvider(
  ui: React.ReactElement,
  overrides: { appId?: string; tenantId?: string } = {}
) {
  return render(
    <AppProvider _testAppId={overrides.appId ?? "test-app"} _testTenantId={overrides.tenantId ?? "test-tenant"}>
      {ui}
    </AppProvider>
  );
}
```

### Coverage targets

- Statement coverage: >= 90%
- Branch coverage: >= 85%
- All `AppSDKError` codes exercised in at least one test

---

## 18. Build and Distribution

### Build output

The package is built using `tsc` (type declarations) and the monorepo's shared esbuild config (CJS + ESM bundles).

```json
// packages/app-sdk/package.json (relevant fields)
{
  "name": "@oneplatform/app-sdk",
  "version": "0.1.0",
  "main": "dist/index.cjs",
  "module": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "require": "./dist/index.cjs",
      "types": "./dist/index.d.ts"
    }
  },
  "sideEffects": false,
  "files": ["dist"]
}
```

`"sideEffects": false` enables tree-shaking in esbuild. Since the package has no module-level side effects (no global registrations, no polyfills), this is accurate.

### Pre-bundled in sandbox

The Execution Service sandbox image pre-installs `@oneplatform/app-sdk` from a private registry. User apps do not install it at build time — it is already present. The esbuild call that compiles user apps marks `@oneplatform/app-sdk` as external, so the bundle does not include the SDK source; it is loaded from the pre-bundled copy at runtime.

This means the SDK version is locked to what the sandbox image was built with. Updating the SDK requires rebuilding the sandbox image. This is intentional: it ensures all hosted apps use the same SDK version and prevents a malicious app from loading a modified SDK.

### Type declaration injection

The App Service reads the SDK's `dist/index.d.ts` at startup and caches it in memory. When the Monaco editor loads for an app, the App Service serves this file (plus the tenant's generated entity declarations) to the browser for injection via `addExtraLib`. This means Monaco always uses type declarations that match the deployed SDK version.

---

## 19. Open Questions and Deferred Decisions

| # | Question | Impact | Decision Needed By |
|---|----------|--------|-------------------|
| OQ-1 | Should `useSubscription` support SSE as a fallback for environments where WebSocket is blocked? ADR-26 references SSE for App Service → Gateway, but the browser → App Service connection is documented as WebSocket only. | Medium — some enterprise proxies block WebSocket | Before Phase 6 (SDK implementation) |
| OQ-2 | Should `useQuery.fetchNextPage` support backwards pagination (previous page)? The current design is cursor-forward only. | Low — most app use cases are forward-only lists | Can defer until user feedback |
| OQ-3 | `useMutation.bulkCreate` — should it be transactional (all-or-nothing) or best-effort (partial success)? The current `BulkResult<T>` shape supports partial success, but the BFF contract must be clarified. | Medium — affects error recovery logic in apps | Requires BFF contract decision |
| OQ-4 | Inter-app communication: apps in the same tenant cannot currently communicate except through shared `useQuery` data. Should the SDK expose a `useAppMessage` hook? | Low for MVP | Defer to post-MVP |
| OQ-5 | Should `useAppStorage` support listing all keys for the current app/user (`GET /bff/storage`)? Useful for migration/debugging. | Low — not needed for core use cases | Can add without breaking change |
| OQ-6 | The `options` stability note in `useSubscription` (users must `useMemo` filter options) is a footgun. Should the SDK do deep equality comparison internally on each render to detect filter changes? | Medium — developer experience | Evaluate in Phase 6; requires benchmark to confirm no perf regression |

---

## Appendix A: BFF Endpoint Summary

All endpoints are relative to `window.location.origin` (same-origin). All include `Cookie: op_session=...` automatically.

| Endpoint | Method | Hook | Description |
|----------|--------|------|-------------|
| `/bff/me` | GET | `AppProvider`, `useUser` | Current user context |
| `/bff/permissions` | GET | `AppProvider`, `PermissionCache` | Permission snapshot |
| `/bff/data/{entity}` | GET | `useQuery` | List records with filtering, sorting, pagination |
| `/bff/data/{entity}` | POST | `useMutation.create` | Create one record |
| `/bff/data/{entity}/bulk` | POST | `useMutation.bulkCreate` | Create multiple records |
| `/bff/data/{entity}/{id}` | PATCH | `useMutation.update` | Partial update |
| `/bff/data/{entity}/{id}` | PUT | `useMutation.replace` | Full replacement |
| `/bff/data/{entity}/{id}` | DELETE | `useMutation.remove` | Delete one record |
| `/bff/storage/{key}` | GET | `useAppStorage` | Read one storage value |
| `/bff/storage/{key}` | PUT | `useAppStorage` | Write one storage value |
| `wss://{origin}/apps/{slug}/ws` | WS | `useSubscription` | Real-time entity events |

---

## Appendix B: Data Flow Diagrams

### AppProvider Initialisation

```
window.__OP_APP_CONFIG__
        │
        ▼
  readAppConfig()
        │
        ├──────────────────────────────┐
        ▼                              ▼
  GET /bff/me                   GET /bff/permissions
  ──── 200 ────────────────────── 200 ────────────────
        │                              │
        ▼                              ▼
  user = UserContext       PermissionCache.applySnapshot()
        │                              │
        └──────────────────────────────┘
                           │
                           ▼
                     isReady = true
                     render children
```

### useQuery Data Flow

```
Component renders
      │
      ▼
  useQuery("customers", { filter: { status: { eq: "active" } } })
      │
      ├── QueryCache.get(key)
      │       │
      │       ├── MISS → isLoading: true, fetch GET /bff/data/customers?...
      │       │              │
      │       │              ▼
      │       │          App Service BFF
      │       │              │ validate session cookie
      │       │              │ check RBAC (can user read customers?)
      │       │              │ forward to Ontology Service
      │       │              │ apply field-level permissions
      │       │              ▼
      │       │          { data: [...], pagination: { nextCursor, total } }
      │       │              │
      │       │              ▼
      │       └── QueryCache.set(key, entry) → useSyncExternalStore notify → re-render
      │
      └── HIT (fresh) → data: cached, isLoading: false
      └── HIT (stale) → data: cached, isLoading: false, background refetch
```

### useMutation Optimistic Update

```
useMutation("orders").create({ total: 99.99 })
      │
      ├─ 1. QueryCache snapshot saved
      ├─ 2. QueryCache.optimisticCreate → provisional record appended
      ├─ 3. Component re-renders with provisional record visible
      │
      ├─ 4. POST /bff/data/orders { total: 99.99 }
      │         │
      │         ├── 201 Created → { id: "real-id", ... }
      │         │       │
      │         │       └─ 5a. QueryCache.confirmCreate → replace provisional with real record
      │         │              Component re-renders with confirmed record
      │         │
      │         └── 4xx/5xx
      │                 │
      │                 └─ 5b. QueryCache.restoreSnapshot → undo provisional record
      │                        isError: true, error: AppSDKError
      │                        Component re-renders without provisional record
```
