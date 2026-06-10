# @oneplatform/sdk — L2 Package Design

**Document status:** Approved  
**Last updated:** 2026-06-10  
**Author:** Platform Architecture  
**Supersedes:** SDK summary in L1 design (lines 1685-1736)  
**ADRs this document implements:** ADR-7, ADR-9, ADR-20, ADR-22, ADR-29

---

## Table of Contents

1. [Package Overview](#1-package-overview)
2. [Module Structure](#2-module-structure)
3. [Client Construction](#3-client-construction)
4. [Authentication Modes](#4-authentication-modes)
5. [HTTP Transport Layer](#5-http-transport-layer)
6. [Auto-Retry](#6-auto-retry)
7. [Error Hierarchy](#7-error-hierarchy)
8. [Pagination](#8-pagination)
9. [Real-Time Subscriptions](#9-real-time-subscriptions)
10. [Resource Methods](#10-resource-methods)
11. [Ontology-Typed Code Generation](#11-ontology-typed-code-generation)
12. [Type Definitions Reference](#12-type-definitions-reference)
13. [Security Design](#13-security-design)
14. [Observability and Logging](#14-observability-and-logging)
15. [Testing Strategy](#15-testing-strategy)
16. [Build and Distribution](#16-build-and-distribution)
17. [Versioning and Compatibility](#17-versioning-and-compatibility)

---

## 1. Package Overview

### 1.1 Purpose

`@oneplatform/sdk` is the canonical TypeScript/JavaScript client for external applications connecting to OnePlatform. It is the primary integration surface for developers who need to:

- Read and write ontology-typed entity data (Products, Orders, Customers, or any tenant-defined type)
- Trigger and monitor pipelines
- Subscribe to real-time platform events via Server-Sent Events
- Manage connectors, API keys, and other platform resources programmatically

The SDK is deliberately a thin client: it translates the platform's REST API into typed method calls, handles cross-cutting concerns (auth token lifecycle, retry, pagination, real-time reconnection), and delegates all business logic to the server. It does not embed business rules, cache platform data, or maintain local state beyond what is necessary for transport concerns.

### 1.2 Package Identity

| Property | Value |
|---|---|
| npm package name | `@oneplatform/sdk` |
| Package manager | pnpm (monorepo workspace `packages/sdk`) |
| Language | TypeScript 5.x |
| Minimum Node.js | 18.0.0 (native `fetch`, `ReadableStream`, `EventTarget`) |
| Browser support | All modern browsers (Chrome 90+, Firefox 90+, Safari 15+) |
| Bundle format | Dual ESM + CJS via tsup |
| License | BSL-1.1 (same as platform) |

### 1.3 Design Constraints

**No runtime dependencies beyond fetch.** The SDK uses the platform-native `fetch` API (available in Node 18+ and all modern browsers without polyfills). It carries zero third-party runtime dependencies. This keeps the bundle small, avoids supply-chain risk, and ensures the SDK works in edge runtimes (Cloudflare Workers, Vercel Edge Functions) without modification.

**Generated core, hand-authored ergonomics.** The low-level HTTP client methods in `src/generated/` are produced by `@hey-api/openapi-ts` from the platform's OpenAPI 3.1 spec. The public API surface in `src/resources/` wraps those generated types in ergonomic, type-safe resource objects. This architecture means the generated layer can be regenerated on every API change without breaking the ergonomic wrappers.

**Zero global state.** Every `createClient()` call returns an independent client instance. Multiple clients (different tenants, different auth configurations) can coexist in the same process. No module-level singletons.

---

## 2. Module Structure

```
packages/sdk/
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── src/
│   ├── index.ts                    # Public barrel export (ESM entry)
│   ├── client.ts                   # createClient() factory
│   ├── auth/
│   │   ├── index.ts
│   │   ├── api-key.ts              # API key auth handler
│   │   ├── access-token.ts         # Static access token handler
│   │   ├── pkce.ts                 # Browser PKCE flow handler
│   │   └── token-manager.ts        # Token refresh lifecycle
│   ├── errors/
│   │   ├── index.ts
│   │   ├── base.ts                 # OnePlatformError base class
│   │   ├── client-errors.ts        # AuthError, NotFoundError, ValidationError, etc.
│   │   ├── rate-limit-error.ts     # RateLimitError with retryAfterSeconds
│   │   ├── server-error.ts         # ServerError (5xx)
│   │   └── network-error.ts        # NetworkError (fetch threw)
│   ├── retry/
│   │   ├── index.ts
│   │   └── retry-handler.ts        # Exponential backoff with jitter
│   ├── pagination/
│   │   ├── index.ts
│   │   └── paginator.ts            # AsyncIterable<Page<T>>, collect(), take()
│   ├── subscriptions/
│   │   ├── index.ts
│   │   └── sse-subscriber.ts       # SSE connection, auto-reconnect, pattern matching
│   ├── resources/
│   │   ├── index.ts
│   │   ├── data.ts                 # client.data namespace
│   │   ├── pipelines.ts            # client.pipelines namespace
│   │   ├── connectors.ts           # client.connectors namespace
│   │   ├── ontologies.ts           # client.ontologies namespace
│   │   ├── events.ts               # client.events namespace (subscribe)
│   │   ├── apps.ts                 # client.apps namespace
│   │   ├── plugins.ts              # client.plugins namespace
│   │   ├── api-keys.ts             # client.apiKeys namespace
│   │   ├── users.ts                # client.users namespace
│   │   └── logs.ts                 # client.logs namespace
│   ├── filter-builder/
│   │   ├── index.ts
│   │   └── filter-builder.ts       # Type-safe filter DSL builder
│   ├── generated/                  # AUTO-GENERATED — do not edit manually
│   │   ├── .gitignore              # Tracks generated/ as non-editable
│   │   ├── client.gen.ts           # @hey-api/openapi-ts fetch client
│   │   ├── types.gen.ts            # All OpenAPI schema types
│   │   ├── services.gen.ts         # All generated service method stubs
│   │   └── schemas.gen.ts          # Zod schemas (optional, for runtime validation)
│   └── types/
│       ├── index.ts
│       ├── client-options.ts       # ClientOptions, RetryPolicy, AuthConfig
│       ├── pagination.ts           # Page<T>, PaginationOptions, CursorResult
│       ├── subscription.ts         # SubscriptionOptions, PlatformEvent, Subscription
│       └── resources.ts            # FilterOptions, SortOptions, FieldSelection
├── dist/                           # tsup output (gitignored)
│   ├── index.js                    # CJS bundle
│   ├── index.mjs                   # ESM bundle
│   ├── index.d.ts                  # Type declarations
│   └── index.d.mts                 # ESM type declarations
└── test/
    ├── unit/
    │   ├── retry.test.ts
    │   ├── pagination.test.ts
    │   ├── errors.test.ts
    │   ├── auth.test.ts
    │   └── subscriptions.test.ts
    └── integration/
        ├── helpers/
        │   └── platform-harness.ts  # Starts the full platform stack for tests
        ├── data.test.ts
        ├── pipelines.test.ts
        └── events.test.ts
```

### 2.1 Barrel Export Contract

`src/index.ts` re-exports everything a consumer needs. The export surface is intentionally narrow — generated internals and transport details are not exported.

```typescript
// Public API surface exported from @oneplatform/sdk
export { createClient } from './client';

// Error types — all exported for instanceof checks
export {
  OnePlatformError,
  ClientError,
  AuthError,
  NotFoundError,
  ValidationError,
  ConflictError,
  ForbiddenError,
  RateLimitError,
  ServerError,
  NetworkError,
  CursorExpiredError,
} from './errors';

// Pagination types
export type { Page, PaginatedIterable, PaginationOptions } from './pagination';

// Subscription types
export type { Subscription, PlatformEvent, SubscriptionOptions } from './subscriptions';

// Client option types
export type {
  ClientOptions,
  RetryPolicy,
  AuthConfig,
  ApiKeyAuthConfig,
  AccessTokenAuthConfig,
  BrowserAuthConfig,
} from './types/client-options';

// Filter/sort builder for advanced queries
export { filter } from './filter-builder';
export type { FilterBuilder, SortSpec } from './filter-builder';
```

Nothing in `src/generated/` is exported from the public barrel. Generated types flow through to consumers only via the typed resource methods.

---

## 3. Client Construction

### 3.1 createClient()

```typescript
function createClient(options: ClientOptions): OnePlatformClient
```

`createClient()` is the single entry point. It is synchronous — it does not perform I/O, connect to the server, or validate credentials. Connection errors surface on the first API call.

**ClientOptions:**

```typescript
interface ClientOptions {
  /**
   * Base URL of the OnePlatform instance.
   * Examples:
   *   "https://platform.example.com"
   *   "http://localhost:3000"  (local development)
   * Must NOT have a trailing slash.
   * Required.
   */
  baseUrl: string;

  /**
   * Authentication configuration.
   * Exactly one of: apiKey, accessToken, or browser must be provided.
   * If omitted entirely, the SDK auto-detects the environment:
   *   - Browser environment → starts browser PKCE flow
   *   - Node.js environment → throws ConfigurationError (explicit auth required)
   */
  auth?: AuthConfig;

  /**
   * Retry policy. Defaults applied if omitted.
   * Set to false to disable all retry logic.
   */
  retry?: RetryPolicy | false;

  /**
   * Request timeout in milliseconds. Default: 30000 (30s).
   * Applies to each individual HTTP request (not the total retry sequence).
   * Set to 0 to disable timeout (not recommended).
   */
  timeout?: number;

  /**
   * Custom fetch implementation.
   * Defaults to globalThis.fetch.
   * Useful for testing (inject a mock) or environments where fetch needs configuration.
   */
  fetch?: typeof globalThis.fetch;

  /**
   * Custom headers to include on every request.
   * Merged with SDK-managed headers (Authorization, Content-Type, Accept).
   * SDK-managed headers take precedence if keys conflict.
   */
  headers?: Record<string, string>;

  /**
   * Log level for SDK-internal diagnostic messages.
   * These go to console.debug/info/warn/error.
   * Default: 'warn'.
   */
  logLevel?: 'debug' | 'info' | 'warn' | 'error' | 'silent';
}
```

**RetryPolicy:**

```typescript
interface RetryPolicy {
  /**
   * Maximum number of retry attempts (not counting the initial attempt).
   * Default: 3.
   */
  maxRetries?: number;

  /**
   * Initial backoff delay in milliseconds.
   * Each retry doubles this value (exponential).
   * Default: 500ms.
   */
  initialDelayMs?: number;

  /**
   * Maximum backoff delay cap in milliseconds.
   * Prevents exponential runaway on many retries.
   * Default: 30000ms (30s).
   */
  maxDelayMs?: number;

  /**
   * HTTP status codes that trigger a retry.
   * Default: [429, 500, 502, 503, 504].
   * 429 always uses the Retry-After header if present, regardless of backoff calculation.
   */
  retryableStatusCodes?: number[];

  /**
   * Whether to add ±25% random jitter to the backoff delay.
   * Prevents thundering-herd from many clients retrying simultaneously.
   * Default: true.
   */
  jitter?: boolean;
}
```

### 3.2 OnePlatformClient Shape

```typescript
interface OnePlatformClient {
  // Data access (ontology-typed entities)
  data: DataNamespace;

  // Pipeline management
  pipelines: PipelineNamespace;

  // Connector management
  connectors: ConnectorNamespace;

  // Ontology schema management
  ontologies: OntologyNamespace;

  // Real-time event subscriptions
  events: EventNamespace;

  // App management
  apps: AppNamespace;

  // Plugin management
  plugins: PluginNamespace;

  // API key management
  apiKeys: ApiKeyNamespace;

  // User management (admin-only operations)
  users: UserNamespace;

  // Log and audit queries
  logs: LogNamespace;

  /**
   * Returns the resolved options this client was created with.
   * Auth tokens are redacted. Useful for debugging.
   */
  getConfig(): Readonly<ResolvedClientConfig>;

  /**
   * Checks platform connectivity and auth.
   * Makes a GET /api/v1/auth/whoami request.
   * Resolves with the current user identity or throws an error.
   */
  ping(): Promise<WhoAmIResponse>;

  /**
   * Cleanly terminates all active SSE subscriptions and in-flight requests.
   * After calling destroy(), the client must not be reused.
   */
  destroy(): void;
}
```

### 3.3 Construction Example

```typescript
import { createClient } from '@oneplatform/sdk';

// Server-side: API key auth
const client = createClient({
  baseUrl: 'https://platform.example.com',
  auth: { apiKey: 'op_live_abc123...' },
  timeout: 15000,
  retry: { maxRetries: 3, initialDelayMs: 500 },
});

// Server-side: existing access token (e.g., forwarded from a user session)
const client = createClient({
  baseUrl: 'https://platform.example.com',
  auth: { accessToken: userJwt },
});

// Browser: PKCE flow (auth is automatic)
const client = createClient({
  baseUrl: 'https://platform.example.com',
  auth: { browser: { clientId: 'app:my-app:tenant-id' } },
});
```

---

## 4. Authentication Modes

### 4.1 Mode Selection

```typescript
type AuthConfig =
  | ApiKeyAuthConfig
  | AccessTokenAuthConfig
  | BrowserAuthConfig;
```

Exactly one mode is active per client instance. The SDK selects the authentication mode once at client construction and never switches. If auto-detection is requested (auth omitted), the environment is checked synchronously at construction time using `typeof window !== 'undefined'`.

**Environment auto-detection logic:**

```
if auth is omitted:
  if typeof window !== 'undefined':
    → browser mode (PKCE, requires clientId resolution — see §4.4)
  else:
    → throw ConfigurationError("auth is required in non-browser environments")
```

### 4.2 API Key Mode (Server-Only)

```typescript
interface ApiKeyAuthConfig {
  apiKey: string;
}
```

**Constraints:**
- The API key value MUST match the prefix pattern `op_live_` (production) or `op_test_` (test keys). The SDK validates this at construction time and throws `ConfigurationError` immediately if the format is invalid.
- API key mode is refused if the SDK detects a browser environment (`typeof window !== 'undefined'`). This check is not bypassable via options — it is a hard security invariant. The error thrown is `ConfigurationError("API keys are not permitted in browser environments. Use browser PKCE auth instead.")`.
- The API key is sent as a `Bearer` token in the `Authorization` header on every request.

**Header produced:**
```
Authorization: Bearer op_live_abc123...
```

### 4.3 Access Token Mode (Manual JWT)

```typescript
interface AccessTokenAuthConfig {
  /**
   * A JWT access token previously obtained from the Auth Service.
   * The SDK sends it as-is and does NOT attempt token refresh.
   * When the token expires, requests will fail with AuthError.
   * The caller is responsible for refreshing and calling client.setAccessToken().
   */
  accessToken: string;

  /**
   * Optional callback invoked when a request fails with 401 Unauthorized.
   * The SDK calls this to fetch a fresh token.
   * If provided, the SDK will retry the failed request once with the new token.
   * If this callback throws or returns null, the original AuthError is propagated.
   */
  refreshToken?: () => Promise<string | null>;
}
```

The `refreshToken` callback enables integration with application-level session management without requiring the SDK to understand the platform's OAuth flows. A typical use case: a Next.js app that manages its own session stores the access token server-side and provides a refresh function.

**Header produced:**
```
Authorization: Bearer eyJhbGc...
```

### 4.4 Browser PKCE Mode

```typescript
interface BrowserAuthConfig {
  /**
   * OAuth client ID registered with the platform Auth Service.
   * Format: "app:{appId}:{tenantId}"
   */
  clientId: string;

  /**
   * URI the browser is redirected to after the Auth Service grants the code.
   * Must match a registered redirect URI for this clientId.
   * Default: current window.location.origin + '/auth/callback'
   */
  redirectUri?: string;

  /**
   * Scopes to request. Default: ['openid', 'profile', 'data:read', 'data:write'].
   */
  scopes?: string[];

  /**
   * Storage key prefix for tokens in sessionStorage.
   * Default: 'op_sdk'.
   * Tokens are stored as 'op_sdk_access_token', 'op_sdk_refresh_token', etc.
   */
  storagePrefix?: string;
}
```

**PKCE flow behavior:**

The browser auth handler operates as a state machine. On first client construction:

1. Check `sessionStorage` for an existing access token. If found and not expired (with a 30s clock skew buffer), use it immediately.
2. Check the current URL for `?code=` and `?state=` query parameters. If found, this is a callback redirect from the Auth Service — exchange the authorization code for tokens via `POST /api/v1/auth/token`, store the tokens, strip the query parameters from the URL via `history.replaceState()`, and emit a `'ready'` event on the client.
3. If neither condition is met, initiate the PKCE authorization flow:
   - Generate a 32-byte random `code_verifier` using `crypto.getRandomValues()`
   - Compute `code_challenge = BASE64URL(SHA256(code_verifier))`
   - Store `code_verifier` and a random `state` in `sessionStorage`
   - Redirect the browser to `GET /api/v1/auth/authorize?response_type=code&client_id=...&redirect_uri=...&scope=...&code_challenge=...&code_challenge_method=S256&state=...`

Access token refresh: the PKCE handler stores the refresh token in `sessionStorage`. When an access token expires (detected via 401 response or expiry timestamp check before the request), the handler calls `POST /api/v1/auth/token` with `grant_type=refresh_token` silently. If the refresh fails (expired refresh token), the handler clears storage and re-initiates the PKCE flow.

**Security invariants for browser mode:**
- Tokens are stored ONLY in `sessionStorage`, never `localStorage` (session-scoped storage avoids persistence across tabs and prevents token exfiltration via storage event listeners across origins).
- The `code_verifier` is used once and discarded after the code exchange.
- The `state` parameter is validated on callback to prevent CSRF.
- `X-Requested-With: XMLHttpRequest` header is added to all requests from browser mode to allow the server's CSRF detection middleware to identify SDK calls.
- API keys are rejected — the SDK throws `ConfigurationError` if `apiKey` is passed when `typeof window !== 'undefined'`.

### 4.5 Token Lifecycle Summary

| Mode | Token Refresh | Token Storage | Browser Safe |
|---|---|---|---|
| API key | Not applicable | In-memory only | No — rejected |
| Access token (no callback) | Caller responsibility | In-memory only | Yes (with caution) |
| Access token (with callback) | Automatic on 401 | In-memory only | Yes |
| Browser PKCE | Automatic on 401/expiry | sessionStorage | Yes — intended mode |

---

## 5. HTTP Transport Layer

### 5.1 Request Pipeline

Every API call flows through a fixed pipeline in the transport layer:

```
caller → resource method → generated service stub
  → request builder (add auth header, Content-Type, Accept, custom headers)
  → timeout wrapper (AbortController, configurable TTL)
  → retry wrapper (§6)
  → fetch()
  → response parser (JSON decode, envelope unwrap)
  → error mapper (HTTP status → typed error class, §7)
  → return typed result or throw typed error
```

### 5.2 Request Headers

Every outbound request includes:

| Header | Value | Notes |
|---|---|---|
| `Authorization` | `Bearer {token}` | Always present (auth mode determines token) |
| `Content-Type` | `application/json` | Present on POST/PATCH/PUT |
| `Accept` | `application/json` | Always present |
| `X-SDK-Version` | `@oneplatform/sdk/{semver}` | For server-side diagnostics |
| `X-Request-ID` | UUID v4 (per-request) | Enables log correlation on retries |
| `X-Requested-With` | `XMLHttpRequest` | Browser mode only |
| Custom headers | From `ClientOptions.headers` | Merged, lower precedence than SDK headers |

### 5.3 Response Envelope Unwrapping

The platform returns all successful responses in `{ "data": T }` and all errors in `{ "error": { code, message, details, requestId } }`. The transport layer unwraps these transparently:

- On `2xx` with `{ data: T }` body: resolves with `T` directly.
- On `2xx` with no envelope (e.g., `204 No Content`): resolves with `undefined`.
- On `4xx` or `5xx`: parses the error body, maps to the appropriate error class (§7), and throws.
- On network failure (fetch throws): wraps in `NetworkError` and throws.
- On non-JSON response (unexpected): throws `ServerError` with message indicating unexpected content type.

### 5.4 Request Timeout

Every request is wrapped in an `AbortController` with a timeout signal:

```typescript
const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(), options.timeout ?? 30000);
const response = await fetch(url, { ...fetchOptions, signal: controller.signal });
clearTimeout(timeoutId);
```

If the abort fires, fetch throws a `DOMException` with `name: 'AbortError'`. The transport layer catches this and throws `NetworkError` with `{ reason: 'timeout', timeoutMs: n }`.

The timeout applies to each individual attempt, not to the total retry sequence. A 3-retry sequence with 30s timeout may take up to 4 × 30s = 120s in the worst case. Callers that need a hard end-to-end deadline should use `Promise.race` with their own timer.

---

## 6. Auto-Retry

### 6.1 Default Configuration

| Parameter | Default Value |
|---|---|
| Max retries | 3 |
| Initial delay | 500ms |
| Max delay | 30000ms |
| Jitter | ±25% |
| Retryable status codes | 429, 500, 502, 503, 504 |

### 6.2 Retry Decision Logic

```
attempt(request):
  response = fetch(request)
  
  if response.status in [429, 500, 502, 503, 504]:
    if attemptNumber >= maxRetries:
      → map to error, throw
    
    if response.status == 429:
      retryAfter = response.headers.get('Retry-After')
      if retryAfter:
        delayMs = parseRetryAfter(retryAfter)  // seconds or HTTP-date
      else:
        delayMs = backoff(attemptNumber)
    else:
      delayMs = backoff(attemptNumber)
    
    await sleep(delayMs)
    return attempt(request, attemptNumber + 1)
  
  if response.status in 4xx and status != 429:
    → map to error, throw immediately (no retry)
  
  if response.ok:
    return parse(response)
  
  // Catch-all for unexpected non-4xx/5xx
  → throw ServerError
```

### 6.3 Backoff Calculation

```typescript
function backoff(attemptNumber: number, policy: RetryPolicy): number {
  const base = policy.initialDelayMs * Math.pow(2, attemptNumber); // 500, 1000, 2000, 4000...
  const capped = Math.min(base, policy.maxDelayMs);
  
  if (!policy.jitter) return capped;
  
  // ±25% jitter
  const jitterFactor = 0.75 + Math.random() * 0.5; // 0.75 to 1.25
  return Math.floor(capped * jitterFactor);
}
```

Delay schedule with defaults (before jitter):

| Attempt | Delay before attempt |
|---|---|
| 1 (initial) | 0ms |
| 2 (1st retry) | 500ms |
| 3 (2nd retry) | 1000ms |
| 4 (3rd retry) | 2000ms |

### 6.4 Retry-After Header Parsing

```typescript
function parseRetryAfter(header: string): number {
  const seconds = parseInt(header, 10);
  if (!isNaN(seconds)) {
    // Seconds format: "Retry-After: 30"
    return seconds * 1000;
  }
  // HTTP-date format: "Retry-After: Wed, 11 Jun 2026 00:00:00 GMT"
  const date = Date.parse(header);
  if (!isNaN(date)) {
    return Math.max(0, date - Date.now());
  }
  // Unparseable — fall back to normal backoff
  return backoff(currentAttempt, policy);
}
```

The delay from `Retry-After` is capped at `maxDelayMs` to prevent a misbehaving server from instructing the SDK to wait indefinitely.

### 6.5 Non-Retryable Errors

Status codes outside `[429, 500, 502, 503, 504]` are thrown immediately without retry:

| Status | Error Class | Reason |
|---|---|---|
| 400 | `ClientError` | Caller's request is malformed — retrying won't help |
| 401 | `AuthError` | Invalid credentials — retrying won't help (except access token mode with refreshToken callback — handled separately) |
| 403 | `ForbiddenError` | Insufficient permissions — retrying won't help |
| 404 | `NotFoundError` | Resource doesn't exist — retrying won't help |
| 409 | `ConflictError` | Unique constraint — retrying won't help |
| 410 | `CursorExpiredError` | Cursor is stale — caller must restart pagination |
| 422 | `ValidationError` | Schema validation failed — retrying won't help |

### 6.6 Retry and Request Bodies

For requests with a body (POST, PATCH, PUT), the body must be re-read on each retry attempt. The SDK always captures the request body as a string (JSON serialized) before the first attempt. The same string is passed to each retry attempt — bodies are never streams.

Idempotency consideration: PATCH and DELETE operations on existing resources are safe to retry. POST operations that create resources are not inherently idempotent. The SDK does not attempt to detect this distinction — it retries POSTs on 5xx the same as any other method. Consumers who need idempotency guarantees for POST operations should either:
1. Include a client-generated `Idempotency-Key` header in `ClientOptions.headers` (the platform honors this for creation endpoints), or
2. Disable retry for their POST calls by passing `retry: false` to `createClient`.

---

## 7. Error Hierarchy

### 7.1 Class Hierarchy

```
OnePlatformError extends Error
  ├── ClientError                      // 4xx (non-429)
  │   ├── AuthError                    // 401
  │   ├── ForbiddenError               // 403
  │   ├── NotFoundError                // 404
  │   ├── ConflictError                // 409
  │   ├── ValidationError              // 422
  │   ├── CursorExpiredError           // 410 (cursor older than 24h)
  │   └── ConfigurationError           // SDK misconfiguration (no HTTP status)
  ├── RateLimitError                   // 429
  ├── ServerError                      // 5xx
  └── NetworkError                     // fetch threw (network failure, timeout, DNS)
```

### 7.2 Base Class

```typescript
class OnePlatformError extends Error {
  /**
   * Platform error code (SCREAMING_SNAKE_CASE).
   * Examples: "ENTITY_NOT_FOUND", "RATE_LIMIT_EXCEEDED", "INTERNAL_ERROR"
   * "SDK_ERROR" for errors that never reached the server.
   */
  readonly code: string;

  /**
   * Human-readable message safe to display in a UI.
   * Does not include stack traces, internal paths, or platform internals.
   */
  readonly message: string;

  /**
   * HTTP status code from the server. Undefined for NetworkError and ConfigurationError.
   */
  readonly statusCode?: number;

  /**
   * Platform-assigned request ID. Present on all server errors.
   * Absent on NetworkError, ConfigurationError.
   * Provide to platform support for log correlation.
   */
  readonly requestId?: string;

  /**
   * Structured details from the server error body.
   * ValidationError uses details.fields: { fieldName: string[] } for per-field messages.
   */
  readonly details?: Record<string, unknown>;

  /**
   * Whether this error type is safe to retry.
   * RateLimitError, ServerError, NetworkError → true
   * ClientError subclasses → false
   */
  readonly retryable: boolean;

  /**
   * Original response object (if the error came from an HTTP response).
   * Useful for reading custom headers (e.g., X-RateLimit-Reset).
   */
  readonly response?: Response;
}
```

### 7.3 Subclass Details

```typescript
class ClientError extends OnePlatformError {
  readonly retryable = false;
}

class AuthError extends ClientError {
  readonly statusCode = 401;
  // code: "UNAUTHORIZED"
}

class ForbiddenError extends ClientError {
  readonly statusCode = 403;
  // code: "FORBIDDEN" | "PERMISSION_DENIED" | "ORIGIN_NOT_ALLOWED"
}

class NotFoundError extends ClientError {
  readonly statusCode = 404;
  // code: "NOT_FOUND" | "ENTITY_NOT_FOUND"
}

class ConflictError extends ClientError {
  readonly statusCode = 409;
  // code: "CONFLICT"
}

class ValidationError extends ClientError {
  readonly statusCode = 422;
  // code: "VALIDATION_ERROR"
  // details.fields: Record<string, string[]> — per-field errors
  get fieldErrors(): Record<string, string[]> {
    return (this.details?.fields as Record<string, string[]>) ?? {};
  }
}

class CursorExpiredError extends ClientError {
  readonly statusCode = 410;
  // code: "CURSOR_EXPIRED"
  // Caller must restart pagination from the beginning
}

class ConfigurationError extends ClientError {
  // No statusCode — this error is never sent to the server
  // code: "SDK_CONFIGURATION_ERROR"
  readonly retryable = false;
}

class RateLimitError extends OnePlatformError {
  readonly statusCode = 429;
  readonly retryable = true;

  /**
   * Seconds until the rate limit resets.
   * Parsed from the Retry-After header.
   * null if the server did not provide a Retry-After value.
   */
  readonly retryAfterSeconds: number | null;
}

class ServerError extends OnePlatformError {
  // code: "INTERNAL_ERROR" | "SERVICE_UNAVAILABLE" | any 5xx platform code
  readonly retryable = true;
}

class NetworkError extends OnePlatformError {
  readonly retryable = true;
  readonly code = 'SDK_NETWORK_ERROR';
  // No statusCode — request never reached the server (or response was never received)

  /**
   * Underlying cause.
   * 'timeout': AbortController fired before response arrived
   * 'fetch-failed': fetch() threw (DNS failure, connection refused, etc.)
   * 'parse-failed': response arrived but body parsing failed
   */
  readonly reason: 'timeout' | 'fetch-failed' | 'parse-failed';

  /**
   * Timeout duration in ms, if reason === 'timeout'.
   */
  readonly timeoutMs?: number;
}
```

### 7.4 Error Construction from HTTP Response

```typescript
async function mapResponseToError(response: Response): Promise<OnePlatformError> {
  let body: { error?: { code: string; message: string; details?: unknown; requestId?: string } };
  
  try {
    body = await response.json();
  } catch {
    // Response body is not JSON — construct a generic error
    return new ServerError({
      code: 'INTERNAL_ERROR',
      message: `Server returned ${response.status} with non-JSON body`,
      statusCode: response.status,
      response,
      retryable: response.status >= 500,
    });
  }

  const { code = 'UNKNOWN_ERROR', message = 'An unknown error occurred', details, requestId } = body.error ?? {};
  const base = { code, message, details, requestId, statusCode: response.status, response };

  switch (response.status) {
    case 400: return new ClientError(base);
    case 401: return new AuthError(base);
    case 403: return new ForbiddenError(base);
    case 404: return new NotFoundError(base);
    case 409: return new ConflictError(base);
    case 410: return new CursorExpiredError(base);
    case 422: return new ValidationError(base);
    case 429: return new RateLimitError({ ...base, retryAfterSeconds: parseRetryAfterSeconds(response) });
    default:
      if (response.status >= 500) return new ServerError(base);
      return new ClientError(base); // Unknown 4xx
  }
}
```

---

## 8. Pagination

### 8.1 Design

All collection endpoints use cursor-based pagination per ADR-29. The SDK exposes pagination as an `AsyncIterable<Page<T>>` that allows callers to iterate page-by-page or collect all results into an array.

### 8.2 Page Type

```typescript
interface Page<T> {
  /**
   * The items on this page.
   */
  items: T[];

  /**
   * Opaque cursor for the next page.
   * null if this is the last page.
   */
  nextCursor: string | null;

  /**
   * Total matching items across all pages.
   * null for large collections where total computation is too expensive (>100k rows).
   */
  total: number | null;

  /**
   * Whether this is the last page (nextCursor === null).
   */
  hasMore: boolean;
}
```

### 8.3 PaginatedIterable Interface

```typescript
interface PaginatedIterable<T> extends AsyncIterable<Page<T>> {
  /**
   * Collects all items across all pages into a flat array.
   * Iterates pages until nextCursor is null.
   *
   * @param maxItems - Hard cap on total collected items. Defaults to 10000.
   *   Throws PaginationLimitError if maxItems is exceeded and there are still more pages.
   *   This prevents unbounded memory consumption on misconfigured calls.
   * @returns Array of all items (up to maxItems).
   */
  collect(maxItems?: number): Promise<T[]>;

  /**
   * Collects exactly n items. Stops pagination early once n items are gathered.
   * Does not throw if the collection has fewer than n items — returns what's available.
   *
   * @param n - Number of items to return.
   */
  take(n: number): Promise<T[]>;

  /**
   * Returns just the first page.
   * Equivalent to: (await asyncIterator.next()).value
   */
  firstPage(): Promise<Page<T>>;
}
```

### 8.4 Paginator Implementation

```typescript
class Paginator<T> implements PaginatedIterable<T> {
  constructor(
    private readonly fetchPage: (cursor: string | null, limit: number) => Promise<Page<T>>,
    private readonly pageSize: number = 50,
  ) {}

  async *[Symbol.asyncIterator](): AsyncGenerator<Page<T>> {
    let cursor: string | null = null;
    do {
      const page = await this.fetchPage(cursor, this.pageSize);
      yield page;
      cursor = page.nextCursor;
    } while (cursor !== null);
  }

  async collect(maxItems = 10000): Promise<T[]> {
    const results: T[] = [];
    for await (const page of this) {
      results.push(...page.items);
      if (results.length >= maxItems) {
        if (page.hasMore) {
          throw new PaginationLimitError(
            `collect() stopped at ${maxItems} items. Pass a higher maxItems or use AsyncIterable iteration.`,
            maxItems,
          );
        }
        break;
      }
    }
    return results;
  }

  async take(n: number): Promise<T[]> {
    const results: T[] = [];
    for await (const page of this) {
      results.push(...page.items);
      if (results.length >= n) return results.slice(0, n);
    }
    return results;
  }

  async firstPage(): Promise<Page<T>> {
    const iter = this[Symbol.asyncIterator]();
    const first = await iter.next();
    return first.value;
  }
}
```

**CursorExpiredError handling during iteration:** If a `CursorExpiredError` is thrown mid-iteration (cursor was 24h+ old between pages), the error propagates from the `for await` loop without wrapping. Callers should catch this and restart the iteration from the beginning if needed.

### 8.5 Usage Examples

```typescript
// Page-by-page iteration
for await (const page of client.data.Product.list()) {
  console.log(`Page of ${page.items.length}, total: ${page.total}`);
  for (const product of page.items) {
    process(product);
  }
}

// Collect all (up to default 10k limit)
const allProducts = await client.data.Product.list().collect();

// Collect up to 500 items
const recent = await client.data.Product.list({
  sort: '-createdAt',
}).collect(500);

// Take exactly 10
const first10 = await client.data.Product.list().take(10);

// First page only (no iteration)
const page1 = await client.data.Product.list().firstPage();
console.log(page1.items, page1.total);
```

---

## 9. Real-Time Subscriptions

### 9.1 Design

Real-time events use Server-Sent Events (SSE) per ADR-9. SSE is the platform's standard for one-way streaming: simpler than WebSockets, HTTP/1.1 compatible, inherently browser-safe via `EventSource`, and supported with auto-reconnect semantics by the HTTP spec.

The SDK's subscription layer wraps SSE with:
- Event pattern matching (wildcard prefix support)
- Automatic reconnection with `Last-Event-ID` for exactly-once delivery resumption
- Typed event payloads derived from the OpenAPI spec
- Structured subscription lifecycle management

### 9.2 Event Types

The platform emits events in the format:

```
event: pipeline.run.completed
data: {"id":"evt_01J4...","tenantId":"...","entityType":"pipeline","action":"run.completed","payload":{...},"occurredAt":"2026-06-10T..."}
id: evt_01J4...
```

```typescript
interface PlatformEvent {
  /** Unique event ID. Used as Last-Event-ID for resumption. */
  id: string;

  /** Event type. Dot-separated hierarchy. Examples: "pipeline.run.completed", "data.created" */
  type: string;

  /** Tenant ID this event belongs to. */
  tenantId: string;

  /** ISO 8601 timestamp when the event occurred. */
  occurredAt: string;

  /** Event-specific payload. Type varies by event type. */
  payload: unknown;
}
```

### 9.3 Subscription API

```typescript
interface SubscriptionOptions {
  /**
   * Event patterns to subscribe to.
   * Supports exact strings and prefix wildcards (trailing .*).
   * Examples:
   *   ["pipeline.run.completed"]            — specific event
   *   ["pipeline.*"]                        — all pipeline events
   *   ["data.created", "data.updated"]      — multiple specific events
   *   ["*"]                                 — all events (use sparingly)
   */
  events: string[];

  /**
   * Optional server-side filter applied before delivery.
   * Reduces unnecessary traffic for high-volume event streams.
   */
  filter?: {
    entityType?: string;
    entityId?: string;
    pipelineId?: string;
  };

  /**
   * If provided, the subscription resumes from this event ID.
   * The server replays any events after this ID (up to its replay window).
   * Automatically managed by the SDK on reconnection using Last-Event-ID.
   */
  fromEventId?: string;
}

interface Subscription {
  /**
   * The subscription ID assigned by the server.
   * Included in the first 'connected' event from the SSE stream.
   */
  readonly id: string;

  /**
   * Current connection status.
   */
  readonly status: 'connecting' | 'connected' | 'reconnecting' | 'closed';

  /**
   * The Last-Event-ID received. Used for reconnection resumption.
   */
  readonly lastEventId: string | null;

  /**
   * Terminates the subscription. The SSE connection is closed.
   * The event handler will not be called after unsubscribe().
   */
  unsubscribe(): void;

  /**
   * Emitted when the connection status changes.
   */
  on(event: 'status', handler: (status: Subscription['status']) => void): this;

  /**
   * Emitted when an error occurs (typically before a reconnect attempt).
   */
  on(event: 'error', handler: (error: NetworkError) => void): this;
}
```

### 9.4 Creating a Subscription

```typescript
const sub = client.events.subscribe(
  { events: ['pipeline.*'], filter: { entityType: 'Order' } },
  (event: PlatformEvent) => {
    console.log(event.type, event.payload);
  },
);

// Monitor status changes
sub.on('status', (status) => {
  if (status === 'reconnecting') console.warn('SSE reconnecting...');
});

// Clean up
sub.unsubscribe();
```

### 9.5 SSE Connection Management

The SDK opens an SSE connection to `GET /api/v1/events/subscribe?events=pipeline.*&filter[entityType]=Order`.

**Authorization:** SSE requests include the same `Authorization: Bearer` header as regular API calls. SSE endpoints at the server use `?token=` query parameter as a fallback for environments where custom request headers cannot be set on `EventSource`. The SDK prefers the header approach via `fetch` with `ReadableStream` rather than the native `EventSource` (which cannot set custom headers). This preserves the same auth model and avoids the `?token=` query parameter pattern (which risks tokens appearing in access logs).

**SSE implementation approach:** The SDK does NOT use the browser's built-in `EventSource` API. Instead it uses `fetch` with streaming response body (`response.body.getReader()`), which allows:
1. Custom `Authorization` header (not possible with native `EventSource`)
2. The same retry/backoff logic as regular requests
3. Portability to Node.js without needing `eventsource` npm package

**Reconnection logic:**

```
connect(url, options):
  response = fetch(url, { headers: { Authorization: ... } })
  
  if response is not 200 or text/event-stream:
    → throw NetworkError (no retry — let caller decide)
  
  stream = response.body.getReader()
  parse SSE events from stream:
    on 'id' line: store lastEventId
    on 'data' line: buffer
    on empty line (event boundary): dispatch to handler, clear buffer
  
  on stream end or read error:
    if subscription.status === 'closed': return  // deliberate unsubscribe
    emit 'status': 'reconnecting'
    wait for backoff(reconnectAttempt) ms
    reconnectHeaders = { 'Last-Event-ID': lastEventId ?? '' }
    reconnect(url, { ...options, fromEventId: lastEventId })
```

Reconnect backoff: starts at 1s, doubles per attempt, capped at 30s, with ±25% jitter.

**Maximum reconnect attempts:** 10. After 10 consecutive failures, the subscription emits `'error'` with a `NetworkError` and sets status to `'closed'`. The caller must create a new subscription if desired.

### 9.6 Pattern Matching

Pattern matching is performed client-side for display/routing purposes, but the primary filtering happens server-side. The `events` patterns in `SubscriptionOptions` are sent to the server, which applies them before delivering events over the SSE stream. The SDK validates pattern syntax at construction time and rejects patterns that contain characters invalid for the platform's trie-based pattern matcher (only alphanumeric, `.`, and trailing `*` are valid pattern characters).

---

## 10. Resource Methods

### 10.1 Namespace Overview

All resource methods follow the same structural pattern. Below is the complete method inventory by namespace.

### 10.2 data Namespace

The `data` namespace provides access to ontology-typed entities. Each entity type is accessed as `client.data.{EntityType}`. For base entity types that exist before code generation (generic access), a `client.data.entity(entityType)` accessor is also available.

```typescript
interface DataNamespace {
  /**
   * Access a typed entity resource by name.
   * Used with generated typed clients where EntityType is known at compile time.
   * Example: client.data.Product.list()
   */
  [entityType: string]: EntityResource<Record<string, unknown>>;

  /**
   * Generic entity access when type is not known at compile time.
   */
  entity(entityType: string): EntityResource<Record<string, unknown>>;
}

interface EntityResource<T> {
  list(options?: ListOptions): PaginatedIterable<T>;
  get(id: string, options?: GetOptions): Promise<T>;
  create(data: Partial<T>, options?: MutationOptions): Promise<T>;
  update(id: string, data: Partial<T>, options?: MutationOptions): Promise<T>;
  replace(id: string, data: T, options?: MutationOptions): Promise<T>;
  delete(id: string): Promise<void>;
  bulk(operation: BulkOperation<T>): Promise<BulkResult<T>>;
}
```

### 10.3 ListOptions

```typescript
interface ListOptions {
  /**
   * Server page size. Default: 50. Max: 100.
   * Controls the page size for each server request, not the total collect() limit.
   */
  limit?: number;

  /**
   * Filter specification. Use the filter() builder for type-safe construction
   * or pass raw filter objects for dynamic use cases.
   *
   * Example using builder: filter('status').eq('active').and('price').gt(100)
   * Example raw: { 'filter[status][eq]': 'active', 'filter[price][gt]': '100' }
   */
  filter?: FilterBuilder | Record<string, string>;

  /**
   * Sort specification. Prefix with '-' for descending.
   * Example: '-createdAt' or ['name', '-price']
   */
  sort?: string | string[];

  /**
   * Fields to include in the response. Reduces payload size.
   * Unknown fields are silently ignored by the server.
   * Example: ['id', 'name', 'status']
   */
  fields?: string[];

  /**
   * Starting cursor for pagination. Usually managed by the Paginator automatically.
   * Pass explicitly only if resuming a previous pagination session.
   */
  cursor?: string;
}
```

### 10.4 FilterBuilder

```typescript
// Construction via factory function
import { filter } from '@oneplatform/sdk';

const f = filter('status').eq('active')
  .and('price').gt(100)
  .and('tags').in(['featured', 'sale'])
  .and('deletedAt').null(true);

// Produces query params:
// filter[status][eq]=active&filter[price][gt]=100&filter[tags][in]=featured,sale&filter[deletedAt][null]=true

// Use in list()
client.data.Product.list({ filter: f });
```

```typescript
interface FilterBuilder {
  // Chainable conditions
  and(field: string): FieldConditionBuilder;

  // Serializes to Record<string, string> for inclusion in query params
  toParams(): Record<string, string>;
}

interface FieldConditionBuilder extends FilterBuilder {
  eq(value: string | number | boolean): FilterBuilder;
  neq(value: string | number | boolean): FilterBuilder;
  gt(value: number | string): FilterBuilder;
  gte(value: number | string): FilterBuilder;
  lt(value: number | string): FilterBuilder;
  lte(value: number | string): FilterBuilder;
  like(pattern: string): FilterBuilder;
  in(values: Array<string | number>): FilterBuilder;
  null(isNull: boolean): FilterBuilder;
}
```

### 10.5 pipelines Namespace

```typescript
interface PipelineNamespace {
  list(options?: ListOptions): PaginatedIterable<Pipeline>;
  get(id: string): Promise<Pipeline>;
  create(data: CreatePipelineRequest): Promise<Pipeline>;
  update(id: string, data: UpdatePipelineRequest): Promise<Pipeline>;
  delete(id: string): Promise<void>;
  trigger(id: string, input?: Record<string, unknown>): Promise<PipelineRun>;
  getRun(pipelineId: string, runId: string): Promise<PipelineRun>;
  listRuns(pipelineId: string, options?: ListOptions): PaginatedIterable<PipelineRun>;
  cancelRun(pipelineId: string, runId: string): Promise<PipelineRun>;
  streamRunLogs(pipelineId: string, runId: string): PaginatedIterable<LogEntry>;
}
```

### 10.6 connectors Namespace

```typescript
interface ConnectorNamespace {
  list(options?: ListOptions): PaginatedIterable<ConnectorInstance>;
  get(id: string): Promise<ConnectorInstance>;
  create(data: CreateConnectorRequest): Promise<ConnectorInstance>;
  update(id: string, data: UpdateConnectorRequest): Promise<ConnectorInstance>;
  delete(id: string): Promise<void>;
  test(id: string): Promise<ConnectorTestResult>;
  trigger(id: string): Promise<PipelineRun>;
}
```

### 10.7 ontologies Namespace

```typescript
interface OntologyNamespace {
  list(options?: ListOptions): PaginatedIterable<OntologySchema>;
  get(id: string): Promise<OntologySchema>;
  create(data: CreateOntologyRequest): Promise<OntologySchema>;
  update(id: string, data: UpdateOntologyRequest): Promise<OntologySchema>;
  delete(id: string): Promise<void>;
  validate(data: ValidateOntologyRequest): Promise<ValidationResult>;
  diff(fromVersion: string, toVersion: string): Promise<OntologyDiff>;
  getMigrationStatus(id: string): Promise<MigrationStatus>;
}
```

### 10.8 apiKeys Namespace

```typescript
interface ApiKeyNamespace {
  list(options?: ListOptions): PaginatedIterable<ApiKey>;
  create(data: CreateApiKeyRequest): Promise<CreatedApiKey>; // Returns key value once
  revoke(id: string): Promise<void>;
  rotate(id: string): Promise<CreatedApiKey>; // Returns new key value once
}
```

### 10.9 logs Namespace

```typescript
interface LogNamespace {
  query(options: LogQueryOptions): PaginatedIterable<LogEntry>;
  tail(options?: TailOptions): PaginatedIterable<LogEntry>;
  queryAudit(options: AuditQueryOptions): PaginatedIterable<AuditEntry>;
}
```

---

## 11. Ontology-Typed Code Generation

### 11.1 Overview

The `op sdk generate` CLI command produces a file (`oneplatform.gen.ts` by default) that wraps `@oneplatform/sdk` with types derived from the tenant's current ontology. The result is a `createTypedClient()` function that returns a client where data namespace methods are fully typed for the tenant's specific entities.

This is optional — developers who work with dynamic or unknown schemas use `client.data.entity('Product').list()` with `unknown` types. Developers who want compile-time safety for their specific tenant's data model run `op sdk generate` to produce typed wrappers.

### 11.2 Generation Command

```
op sdk generate [--out <path>] [--platform-url <url>] [--api-key <key>]

Options:
  --out             Output file path. Default: ./src/oneplatform.gen.ts
  --platform-url    Platform base URL. Default: OP_PLATFORM_URL env var.
  --api-key         API key for spec fetch. Default: OP_API_KEY env var.
  --watch           Re-generate on ontology changes (polls /api/v1/openapi.json every 30s).
  --no-format       Skip prettier formatting of the output file.
```

### 11.3 Generation Steps

```
op sdk generate:
  1. Fetch GET {platformUrl}/api/v1/openapi.json
     Auth: Bearer {apiKey}
     Response: full OpenAPI 3.1 spec, tenant-specific (includes entity routes)

  2. Run @hey-api/openapi-ts on the spec:
     - client: '@hey-api/client-fetch'
     - output: { path: './tmp/.oneplatform-gen-work/', format: false }
     - Produces: client.gen.ts, types.gen.ts, services.gen.ts

  3. Run oneplatform code-gen transformer on the output:
     - Reads all entity paths matching /api/v1/data/{entityType}
     - Extracts the entity schema for each {entityType}
     - Generates TypeScript interfaces: Product, Order, Customer, etc.
     - Generates EntityResource<T> specializations with typed filter fields
     - Generates createTypedClient() factory

  4. Write combined output to --out file
  5. Format with prettier (unless --no-format)
  6. Print summary: "Generated N entity types: Product, Order, Customer..."
```

### 11.4 Generated File Structure

```typescript
// oneplatform.gen.ts
// AUTO-GENERATED by @oneplatform/cli sdk generate
// DO NOT EDIT MANUALLY — re-run `op sdk generate` to update
// Generated: 2026-06-10T12:00:00Z | Schema version: 42

import { createClient, type ClientOptions, type PaginatedIterable, type Page } from '@oneplatform/sdk';

// ============================================================
// Entity type definitions (from tenant ontology)
// ============================================================

export interface Product {
  id: string;
  name: string;
  status: 'active' | 'inactive' | 'draft';
  price: number;
  currency: string;
  tags: string[];
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface Order {
  id: string;
  status: 'pending' | 'fulfilled' | 'cancelled';
  customerId: string;
  items: OrderItem[];
  total: number;
  createdAt: string;
  updatedAt: string;
}

// ... (all tenant entity types)

// ============================================================
// Typed filter builders (per entity type)
// ============================================================

export interface ProductFilterBuilder {
  status: FieldConditionBuilder<'active' | 'inactive' | 'draft'>;
  price: NumericConditionBuilder;
  name: StringConditionBuilder;
  createdAt: DateConditionBuilder;
  // ... all indexed fields
}

// ============================================================
// Typed resource interfaces (per entity type)
// ============================================================

export interface TypedProductResource {
  list(options?: TypedListOptions<ProductFilterBuilder>): PaginatedIterable<Product>;
  get(id: string): Promise<Product>;
  create(data: Omit<Product, 'id' | 'createdAt' | 'updatedAt'>): Promise<Product>;
  update(id: string, data: Partial<Omit<Product, 'id' | 'createdAt' | 'updatedAt'>>): Promise<Product>;
  replace(id: string, data: Omit<Product, 'id' | 'createdAt' | 'updatedAt'>): Promise<Product>;
  delete(id: string): Promise<void>;
  bulk(operation: BulkOperation<Product>): Promise<BulkResult<Product>>;
}

// ============================================================
// Typed client
// ============================================================

export interface TypedDataNamespace {
  Product: TypedProductResource;
  Order: TypedOrderResource;
  Customer: TypedCustomerResource;
  // ... all entity types
}

export interface TypedOnePlatformClient extends Omit<OnePlatformClient, 'data'> {
  data: TypedDataNamespace;
}

export function createTypedClient(options: ClientOptions): TypedOnePlatformClient {
  const base = createClient(options);
  return {
    ...base,
    data: {
      Product: base.data.entity('Product') as TypedProductResource,
      Order: base.data.entity('Order') as TypedOrderResource,
      Customer: base.data.entity('Customer') as TypedCustomerResource,
      // ... all entity types
    },
  };
}
```

### 11.5 Generated File Usage

```typescript
import { createTypedClient } from './oneplatform.gen';

const client = createTypedClient({
  baseUrl: 'https://platform.example.com',
  auth: { apiKey: process.env.OP_API_KEY },
});

// Fully typed: products is Product[]
const products = await client.data.Product.list({
  filter: (f) => f.status.eq('active').and(f.price.gt(100)),
  sort: '-createdAt',
}).collect(500);

// TypeScript enforces correct field names and value types
const order = await client.data.Order.create({
  customerId: 'cust_123',
  status: 'pending', // TypeScript: only 'pending' | 'fulfilled' | 'cancelled' allowed
  items: [],
  total: 0,
});
```

### 11.6 Regeneration Workflow

The generated file should be committed to source control alongside application code. It represents the tenant's API surface at a point in time. When ontologies change:

1. Developer runs `op sdk generate` (or CI pipeline runs it automatically).
2. TypeScript compiler catches any breaking changes in their application code.
3. Developer updates application code to match the new schema.
4. Commit the updated `oneplatform.gen.ts` and application code together.

The `--watch` flag supports hot regeneration during local development:

```bash
op sdk generate --watch
# Watches for schema version changes, re-generates on change
# TypeScript language server picks up the new types automatically
```

---

## 12. Type Definitions Reference

### 12.1 Core Platform Types

These types are exported from `@oneplatform/sdk` (not the generated file) and represent stable platform structures.

```typescript
// Auth and identity
interface WhoAmIResponse {
  userId: string;
  email: string;
  tenantId: string;
  roles: string[];
  scopes: string[];
}

// Pipeline types
interface Pipeline {
  id: string;
  name: string;
  description: string | null;
  status: 'active' | 'paused' | 'draft';
  trigger: PipelineTrigger;
  createdAt: string;
  updatedAt: string;
}

interface PipelineRun {
  id: string;
  pipelineId: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: string | null;
  completedAt: string | null;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  error: { message: string; code: string } | null;
}

// Connector types
interface ConnectorInstance {
  id: string;
  name: string;
  pluginId: string;
  status: 'healthy' | 'error' | 'unchecked';
  lastSyncAt: string | null;
  createdAt: string;
}

// Ontology types
interface OntologySchema {
  id: string;
  name: string;
  displayName: string;
  version: number;
  fields: OntologyField[];
  relationships: OntologyRelationship[];
  createdAt: string;
  updatedAt: string;
}

// API key types
interface ApiKey {
  id: string;
  name: string;
  prefix: string; // First 8 chars: "op_live_" prefix only, rest masked
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

interface CreatedApiKey extends ApiKey {
  /** Full key value. Returned exactly once. Store securely. */
  key: string;
}

// Log types
interface LogEntry {
  id: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  service: string;
  traceId: string;
  tenantId: string;
  metadata: Record<string, unknown>;
  timestamp: string;
}

interface AuditEntry {
  id: string;
  action: string;
  actorId: string | null;
  actorType: 'user' | 'api-key' | 'service' | 'system';
  resourceType: string;
  resourceId: string;
  tenantId: string;
  metadata: Record<string, unknown>;
  traceId: string;
  timestamp: string;
}

// Bulk operation types
interface BulkOperation<T> {
  operation: 'create' | 'update' | 'delete';
  items: Array<Partial<T>>;
  transactional?: boolean;
}

interface BulkResult<T> {
  results: Array<
    | { index: number; id: string; status: 'success'; item: T }
    | { index: number; status: 'error'; error: { code: string; message: string } }
  >;
  summary: { total: number; succeeded: number; failed: number };
}
```

---

## 13. Security Design

### 13.1 Threat Model

The SDK operates in two environments with different threat profiles:

**Server-side (Node.js):** The primary threat is credential leakage via logs, error messages, or unhandled promise rejections. The SDK never logs token values. Auth headers are not included in error messages or serialized error objects. `ConfigurationError` messages that reference the API key value mask all but the first 8 characters (`op_live_[masked]`).

**Browser:** The primary threat is token theft via XSS. The SDK uses `sessionStorage` for token storage (scoped to the tab session, cleared on tab close) rather than `localStorage`. `sessionStorage` is still accessible to JavaScript running in the same origin, so XSS can still read tokens — the defense is minimizing the window (tokens expire in 15 minutes) and never putting API keys (which are permanent until revoked) in the browser.

### 13.2 Security Invariants

| Invariant | Enforcement Point |
|---|---|
| API keys never used in browser | `createClient()` — throws `ConfigurationError` if `apiKey` + browser environment detected |
| Tokens not logged | SDK log functions strip Authorization header from request objects before logging |
| Tokens not included in Error serialization | `OnePlatformError` serializes only `code`, `message`, `statusCode`, `requestId`, `details` — no request headers |
| PKCE code_verifier used once | `pkce.ts` — verifier is deleted from sessionStorage after successful code exchange |
| PKCE state parameter validated | `pkce.ts` — state from URL is compared to stored state; mismatch throws `AuthError` |
| SSE auth via header, not query param | `sse-subscriber.ts` — uses fetch with streaming, not native `EventSource` |
| `X-Requested-With` on browser requests | Browser auth mode adds this header; allows server CSRF detection to identify SDK requests |

### 13.3 Sensitive Data in Errors

The `OnePlatformError.details` field may contain field values from validation errors. Callers should be aware that details can contain user-submitted data. The SDK does not sanitize or redact `details` because the server controls this content and the platform spec defines it as user-safe.

Platform error messages (`message` field) are guaranteed by the server contract (ADR-29) to not include stack traces, internal paths, or implementation details. The SDK relies on this guarantee.

### 13.4 Fetch Security

The SDK uses the platform-default fetch (or caller-provided fetch). It does not configure `credentials: 'include'` (cookies are not relevant for the SDK's auth model — it uses tokens in headers). CORS behavior is controlled by the platform's `OP_ALLOWED_ORIGINS` configuration, not the SDK.

---

## 14. Observability and Logging

### 14.1 Internal SDK Diagnostics

The SDK emits structured diagnostic messages via the standard console methods, gated by the configured `logLevel`.

```typescript
// Log levels (from most to least verbose)
// debug: request start, retry attempts, backoff delays, SSE connection state changes
// info:  client creation (with redacted config), successful auth refresh
// warn:  retry after 429, reconnect after SSE drop, deprecated endpoint header detected
// error: all errors thrown to caller (before throw, for correlation with logs)
// silent: nothing
```

The SDK does NOT install any global error handlers, process listeners, or `unhandledRejection` listeners. It is the caller's responsibility to handle errors from SDK calls.

### 14.2 Request Correlation

Every request includes `X-Request-ID: {uuid-v4}`. The server echoes this ID as `requestId` in error responses. When errors occur, the SDK includes the `requestId` in the thrown error object. Callers can use this to correlate SDK errors with platform logs via `GET /api/v1/logs?filter[traceId][eq]={requestId}`.

### 14.3 Deprecation Warning Detection

If an API response includes a `Deprecation: true` header, the SDK emits a `console.warn` message:

```
[OnePlatform SDK] Warning: endpoint {method} {path} is deprecated.
  Sunset: {date}
  Migration guide: {link from Link header}
  Request ID: {requestId}
```

This is emitted once per unique endpoint path per client lifetime (not on every response) to avoid log noise.

---

## 15. Testing Strategy

### 15.1 Test Categories

| Category | Location | What It Tests | Dependencies |
|---|---|---|---|
| Unit — retry | `test/unit/retry.test.ts` | Backoff calculation, Retry-After parsing, retry count limits | Mock fetch |
| Unit — pagination | `test/unit/pagination.test.ts` | AsyncIterable protocol, collect(), take(), CursorExpiredError | Mock fetch |
| Unit — errors | `test/unit/errors.test.ts` | HTTP status → error class mapping, retryable flags, ValidationError.fieldErrors | Mock fetch |
| Unit — auth | `test/unit/auth.test.ts` | API key header injection, browser detection rejection, PKCE flow, token refresh callback | Mock fetch + mock DOM |
| Unit — subscriptions | `test/unit/subscriptions.test.ts` | SSE parsing, reconnection backoff, Last-Event-ID, pattern validation | Mock ReadableStream |
| Unit — filter builder | `test/unit/filter-builder.test.ts` | Filter DSL serialization, chaining, invalid field detection | None |
| Integration — data | `test/integration/data.test.ts` | Full CRUD cycle, pagination across real pages, bulk operations | Running platform |
| Integration — pipelines | `test/integration/pipelines.test.ts` | trigger, listRuns, cancelRun | Running platform |
| Integration — events | `test/integration/events.test.ts` | SSE subscription, reconnect after disconnect, event delivery | Running platform |

### 15.2 Unit Test Approach

Unit tests use a mock fetch strategy. The test helper provides a `mockFetch()` function that records calls and returns preset responses:

```typescript
// test/helpers/mock-fetch.ts
function mockFetch(responses: MockResponse[]): jest.Mock {
  let callIndex = 0;
  return jest.fn(async (url: string, init?: RequestInit) => {
    const response = responses[callIndex++] ?? responses[responses.length - 1];
    return new Response(
      JSON.stringify(response.body),
      { status: response.status, headers: response.headers ?? {} }
    );
  });
}

// Usage
const fetch = mockFetch([
  { status: 500, body: { error: { code: 'INTERNAL_ERROR', message: 'Server error' } } },
  { status: 500, body: { error: { code: 'INTERNAL_ERROR', message: 'Server error' } } },
  { status: 200, body: { data: { id: '123', name: 'Product' } } },
]);
const client = createClient({ baseUrl: 'http://test', auth: { apiKey: 'op_live_test' }, fetch });
const product = await client.data.entity('Product').get('123');
// Verifies: 2 retries happened before success
expect(fetch).toHaveBeenCalledTimes(3);
```

**No real HTTP in unit tests.** The mock fetch is injected via `ClientOptions.fetch`. Every behavior of the transport layer (retry, error mapping, pagination, auth headers) is fully exercised with the mock.

### 15.3 Browser Environment Simulation

Auth tests that verify browser-mode behavior use jsdom (provided by the Vitest browser option) or manual `globalThis.window` mocking:

```typescript
// Simulate browser environment
const originalWindow = globalThis.window;
beforeEach(() => { (globalThis as any).window = {}; });
afterEach(() => { (globalThis as any).window = originalWindow; });

it('rejects API keys in browser environment', () => {
  expect(() => createClient({
    baseUrl: 'http://test',
    auth: { apiKey: 'op_live_test' },
  })).toThrow(ConfigurationError);
});
```

### 15.4 Integration Test Platform Harness

Integration tests require a running platform. The harness manages this:

```typescript
// test/integration/helpers/platform-harness.ts
export class PlatformHarness {
  private static dockerComposeFile = 'docker-compose.test.yml';
  private baseUrl: string;
  private adminApiKey: string;

  async start(): Promise<void> {
    // Start platform via docker compose
    // Wait for /readyz on Gateway
    // Create a test tenant and return admin API key
  }

  async stop(): Promise<void> {
    // docker compose down --volumes
  }

  createClient(options?: Partial<ClientOptions>): OnePlatformClient {
    return createClient({
      baseUrl: this.baseUrl,
      auth: { apiKey: this.adminApiKey },
      ...options,
    });
  }

  async seedEntities(entityType: string, count: number): Promise<void> {
    // Creates test entities via the API
  }
}
```

Integration tests are gated by `RUN_INTEGRATION_TESTS=true` environment variable and run in CI only after the unit suite passes. They use a dedicated `docker-compose.test.yml` with in-memory config to minimize startup time.

### 15.5 Test Tooling

| Tool | Purpose |
|---|---|
| Vitest | Test runner (compatible with tsup ESM output) |
| @vitest/coverage-v8 | Coverage collection |
| jsdom | Browser API simulation for PKCE tests |
| prettier | Code formatting in generated file tests |

### 15.6 Coverage Requirements

| Category | Line Coverage Target |
|---|---|
| `src/retry/` | 100% |
| `src/errors/` | 100% |
| `src/pagination/` | 100% |
| `src/auth/` | 95% (PKCE browser flow: 90% — some branches require a real browser) |
| `src/subscriptions/` | 90% |
| `src/resources/` | 80% (method signatures covered by integration tests) |
| Overall | 90% |

---

## 16. Build and Distribution

### 16.1 tsup Configuration

```typescript
// tsup.config.ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  splitting: false,
  // ESM output: dist/index.mjs + dist/index.d.mts
  // CJS output: dist/index.js  + dist/index.d.ts
  outExtension({ format }) {
    return { js: format === 'esm' ? '.mjs' : '.js' };
  },
  // Exclude generated files from the main bundle
  // They are distributed as source in the package for regeneration
  external: [],
  noExternal: [],
});
```

### 16.2 package.json exports Map

```json
{
  "name": "@oneplatform/sdk",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": {
      "import": {
        "types": "./dist/index.d.mts",
        "default": "./dist/index.mjs"
      },
      "require": {
        "types": "./dist/index.d.ts",
        "default": "./dist/index.js"
      }
    }
  },
  "main": "./dist/index.js",
  "module": "./dist/index.mjs",
  "types": "./dist/index.d.ts",
  "files": [
    "dist/",
    "src/",
    "README.md"
  ],
  "engines": {
    "node": ">=18.0.0"
  },
  "sideEffects": false,
  "peerDependencies": {},
  "dependencies": {},
  "devDependencies": {
    "@hey-api/openapi-ts": "^0.52.0",
    "tsup": "^8.0.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

**`sideEffects: false`** is critical. It tells bundlers (webpack, rollup, esbuild) that all modules in this package are pure — unused exports can be eliminated by tree-shaking. Do not add any module-level side effects (no auto-registering, no global mutations) to any file in `src/`.

**Zero production dependencies.** The `dependencies` block is intentionally empty. The SDK ships only built artifacts; all dev tooling lives in `devDependencies`. This eliminates the risk of transitive dependency vulnerabilities in consumer projects.

### 16.3 Tree-Shaking Verification

A CI check verifies that importing only `createClient` and `OnePlatformError` results in a bundle that excludes the subscription code, the filter builder, and resource-specific methods:

```typescript
// scripts/check-tree-shake.ts
// Uses rollup to produce a minimal bundle, then checks that only
// expected modules appear in the output. Fails CI if unexpected
// modules (e.g., sse-subscriber.ts) appear in a pure auth import.
```

### 16.4 Publishing

The SDK is published to npm under the `@oneplatform` scope. The Turborepo build pipeline ensures:

1. `turbo run build --filter=@oneplatform/sdk` runs `tsup` and produces `dist/`
2. `turbo run test --filter=@oneplatform/sdk` runs unit tests
3. `turbo run docs:generate --filter=@oneplatform/sdk` runs TypeDoc
4. `npm publish --access=public` is triggered by GitHub Actions on tag push

The generated `src/generated/` files are NOT published as the source of truth — the `dist/` output is. The `src/` directory is included in the published package only to allow inspection and to enable `op sdk generate` to reference the package location for code generation templates.

---

## 17. Versioning and Compatibility

### 17.1 Versioning Policy

The SDK version tracks the platform API version with the following scheme:

- `MAJOR.MINOR.PATCH`
- Major version bumps when a breaking change is introduced to the SDK's public API surface (not the generated layer).
- Minor version bumps when new resource methods or auth modes are added.
- Patch version bumps for bug fixes and internal changes.

The platform API version (`/api/v1/`) is distinct from the SDK version. The SDK declares the minimum platform API version it requires in its `package.json` as a `peerDependency`-equivalent metadata field:

```json
{
  "onePlatformApiVersion": ">=1.0.0"
}
```

### 17.2 Generated Code Versioning

The generated `oneplatform.gen.ts` file includes the schema version it was generated from:

```typescript
// Generated: 2026-06-10T12:00:00Z | Schema version: 42
```

If the running platform's schema version is ahead of the generated file's version, the SDK emits a single `console.warn` per process startup:

```
[OnePlatform SDK] Warning: your generated client (schema v42) is behind the platform (schema v47).
  Run `op sdk generate` to update and pick up new entity types and fields.
```

### 17.3 Deprecation Handling

When the SDK detects `Deprecation: true` in a response header, it logs a warning (§14.3). SDK methods themselves are deprecated using TypeScript `@deprecated` JSDoc annotations, which surface in IDE tooltips:

```typescript
/** @deprecated Use client.data.entity() instead. Removed in SDK v2.0.0. */
getData(entityType: string): EntityResource<unknown>;
```

---

## Appendix A: Error Code to Error Class Mapping

| Platform Error Code | HTTP Status | SDK Error Class |
|---|---|---|
| `UNAUTHORIZED` | 401 | `AuthError` |
| `FORBIDDEN` / `PERMISSION_DENIED` | 403 | `ForbiddenError` |
| `NOT_FOUND` / `ENTITY_NOT_FOUND` | 404 | `NotFoundError` |
| `CONFLICT` | 409 | `ConflictError` |
| `VALIDATION_ERROR` | 422 | `ValidationError` |
| `RATE_LIMIT_EXCEEDED` | 429 | `RateLimitError` |
| `INTERNAL_ERROR` | 500 | `ServerError` |
| `SERVICE_UNAVAILABLE` | 503 | `ServerError` |
| `CURSOR_EXPIRED` | 410 | `CursorExpiredError` |
| `PAGINATION_LIMIT_EXCEEDED` | 400 | `ClientError` |
| `INVALID_CURSOR` | 400 | `ClientError` |
| `BULK_LIMIT_EXCEEDED` | 400 | `ClientError` |
| `UNKNOWN_FILTER_FIELD` | 400 | `ClientError` |
| `UNSORTABLE_FIELD` | 400 | `ClientError` |
| Any unrecognized 4xx code | 4xx | `ClientError` |
| Any unrecognized 5xx code | 5xx | `ServerError` |

---

## Appendix B: Environment Detection Logic

```typescript
function isBrowserEnvironment(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.document !== 'undefined' &&
    typeof window.sessionStorage !== 'undefined'
  );
}
```

This check is performed synchronously at `createClient()` call time. It is not re-evaluated after client construction. SSR frameworks (Next.js, Remix, Nuxt) that run browser-targeting code on the server will return `false` for this check when running in Node.js during server-side rendering — they should pass explicit `auth` configuration rather than relying on auto-detection.

---

## Appendix C: Key Design Decisions

**Why not native EventSource for SSE?** The native `EventSource` API cannot send custom headers. All SDK requests use `Authorization: Bearer` in the header. Using fetch with a `ReadableStream` reader gives the SSE client the same auth model as all other requests, avoids query-string token exposure, and keeps the implementation consistent across environments (Node.js, browser, edge).

**Why sessionStorage and not memory for PKCE tokens?** In-memory tokens are lost on page navigation, requiring the user to re-authenticate on every page load. sessionStorage persists for the tab session (same security boundary as the in-memory heap) while surviving navigation. The security profile is comparable: both are accessible to same-origin JavaScript.

**Why is the generated layer separate from the ergonomic layer?** `@hey-api/openapi-ts` changes output format between versions. By keeping generated code confined to `src/generated/` and wrapping it with stable ergonomic wrappers in `src/resources/`, a regeneration event that changes generated types requires updating only the thin adapter code, not any user-facing API. The public API surface is hand-authored and evolves deliberately.

**Why PaginatedIterable instead of returning arrays directly?** Large entity collections (millions of records) cannot be held in memory. Forcing callers to iterate explicitly, and requiring them to call `.collect()` explicitly when they want an array, prevents accidental OOM. The `.collect(maxItems)` default of 10,000 is a hard safety net that prevents `collect()` from silently consuming unbounded memory.

**Why zero production dependencies?** Every dependency in `node_modules` is a potential CVE, a bundle size contributor, and a maintenance burden. The SDK uses only browser/Node built-in APIs (`fetch`, `crypto.getRandomValues`, `AbortController`, `ReadableStream`). This is possible because the platform standardizes on modern Web APIs that are available everywhere the SDK targets (Node 18+, modern browsers, edge runtimes).
