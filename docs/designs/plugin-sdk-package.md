# L2 Package Design: @oneplatform/plugin-sdk

**Date:** 2026-06-10
**Status:** DRAFT
**Author:** Architecture Team
**References:**
- L1: `docs/superpowers/specs/2026-06-10-oneplatform-design.md` §8 Plugin System, §10 CLI and SDKs
- L0: `docs/decisions/002-expanded-architecture-decisions.md` ADR-31, ADR-32, ADR-33, ADR-34
- Implementation location: `packages/plugin-sdk/`

---

## Table of Contents

1. [Package Overview](#1-package-overview)
2. [Module Structure](#2-module-structure)
3. [Core Type Primitives](#3-core-type-primitives)
4. [PluginContext Interface](#4-plugincontext-interface)
5. [Plugin Interfaces](#5-plugin-interfaces)
6. [Error Taxonomy](#6-error-taxonomy)
7. [Metadata Types](#7-metadata-types)
8. [HookDeclaration Interface](#8-hookdeclaration-interface)
9. [Manifest Schema and Zod Validation](#9-manifest-schema-and-zod-validation)
10. [Plugin Scaffold — op plugin create](#10-plugin-scaffold--op-plugin-create)
11. [Local Dev Server — op plugin simulate-hook](#11-local-dev-server--op-plugin-simulate-hook)
12. [Build and Pack — op plugin pack](#12-build-and-pack--op-plugin-pack)
13. [Testing Utilities](#13-testing-utilities)
14. [Security Design](#14-security-design)
15. [Dependency Policy](#15-dependency-policy)
16. [Testing Strategy](#16-testing-strategy)
17. [package.json and Build Configuration](#17-packagejson-and-build-configuration)
18. [Decision Log](#18-decision-log)

---

## 1. Package Overview

### Purpose

`@oneplatform/plugin-sdk` is the single package that a plugin author imports to build, type-check, test, and package a OnePlatform plugin. It provides:

- Complete TypeScript interfaces for all five plugin types (`Connector`, `Transformer`, `Destination`, `AuthProvider`, `Widget`).
- The `PluginContext` object injected into every plugin execution, with all sub-interfaces.
- A typed error taxonomy that the Execution Service uses for retry routing and DLQ decisions.
- Metadata type definitions consumed by the Plugin Service and displayed in the plugin marketplace UI.
- The `HookDeclaration` interface that maps to `plugin.manifest.json` hook entries.
- A Zod validation schema for `plugin.manifest.json`, used both locally (during `op plugin pack`) and in the Plugin Service (on install).
- Local development tools: `op plugin create` (scaffold) and `op plugin simulate-hook` (local hook execution).

### Design Constraints

**No runtime dependencies in the types export path.** The plugin interfaces and context types are pure TypeScript — no Zod, no Node.js builtins, no framework imports. This means a plugin can import the types for type-checking without any bundled runtime code appearing in the plugin's `dist/bundle.js`. Zod is used only for the manifest schema validation, which lives in a separate export path that is imported by the CLI and Plugin Service, never by plugin code itself.

**Plugins cannot import platform internals.** The SDK never re-exports any `@oneplatform/core` types, services, or database clients. The `PluginContext` interface describes what the platform injects — plugin authors consume it, they do not construct it.

**The SDK is the contract.** All built-in platform connectors, transformers, and destinations implement the same interfaces as third-party plugins. The SDK is tested against the platform's own built-in implementations before any external developer uses it. An interface that is hard to implement correctly will be discovered internally first.

### npm Package Identity

```
Package name:   @oneplatform/plugin-sdk
Registry:       private (bundled with OnePlatform distribution)
Version:        follows platform version (e.g., 1.0.0)
License:        BSL-1.1
Node.js target: >=20.0.0
TypeScript:     ^5.5.0 (compilerOptions match tsconfig.base.json)
```

---

## 2. Module Structure

### Source Layout

```
packages/plugin-sdk/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts                   — types-only re-export (no runtime code)
    ├── types/
    │   ├── context.ts             — PluginContext and all sub-interfaces
    │   ├── connector.ts           — Connector interface + supporting types
    │   ├── transformer.ts         — Transformer interface + TransformerContext
    │   ├── destination.ts         — Destination interface + DestinationContext
    │   ├── auth-provider.ts       — AuthProvider interface + AuthContext
    │   ├── widget.ts              — Widget interface + WidgetData
    │   ├── metadata.ts            — All *Metadata types + BaseMetadata
    │   ├── hooks.ts               — HookDeclaration, HookStage enum
    │   ├── errors.ts              — PluginError hierarchy (runtime classes)
    │   └── primitives.ts          — DataRecord, JSONSchema, shared value types
    ├── manifest/
    │   ├── schema.ts              — Zod schema for plugin.manifest.json
    │   └── types.ts               — PluginManifest TypeScript type (inferred from Zod)
    ├── testing/
    │   ├── index.ts               — Testing utilities re-export
    │   ├── mock-context.ts        — createMockContext() factory
    │   └── assertions.ts          — assertValidPlugin(), assertValidMetadata()
    └── dev/
        ├── simulate-hook.ts       — CLI entry: op plugin simulate-hook
        ├── scaffold.ts            — CLI entry: op plugin create
        └── pack.ts                — CLI entry: op plugin pack / validate
```

### Export Map

The `package.json` `exports` field exposes three entry points with strict separation:

```json
{
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    },
    "./manifest": {
      "import": "./dist/manifest/schema.js",
      "types": "./dist/manifest/schema.d.ts"
    },
    "./testing": {
      "import": "./dist/testing/index.js",
      "types": "./dist/testing/index.d.ts"
    }
  }
}
```

**`@oneplatform/plugin-sdk`** — The types-only root entry. Exports all interfaces, context types, error classes, metadata types, and the `HookDeclaration` interface. Plugin source code imports only from this path. This path must never import Zod, Node.js `fs`, `child_process`, or any other runtime library.

**`@oneplatform/plugin-sdk/manifest`** — Exports the Zod schema and the inferred `PluginManifest` type. Imported by `@oneplatform/cli` (for `op plugin pack` and `op plugin validate`) and by the Plugin Service (for install-time validation). Plugin authors may import this to validate their own manifest in tests.

**`@oneplatform/plugin-sdk/testing`** — Exports `createMockContext()`, `createMockCredentials()`, and assertion helpers. Only a `devDependency` in plugin projects. Never imported in production plugin code.

### Rationale for Separation

Keeping the root export (`"."`) free of all runtime dependencies means plugin authors can install `@oneplatform/plugin-sdk` as a zero-cost `devDependency` (types only) or as a direct `dependency` for the error classes. Either way, the plugin's bundled output (`dist/bundle.js`) does not drag in Zod, tar utilities, or Node.js crypto APIs. This matters because the plugin bundle runs inside `isolated-vm`, which enforces a 512MB memory limit — unnecessary bundled code increases both bundle size and cold-start time.

The error classes (`PluginError` and its subclasses) are runtime code, not types. They live in `src/types/errors.ts` and are included in the root export. The Execution Service uses `instanceof` checks on these classes to route errors. This works correctly only if both the plugin bundle and the Execution Service resolve to the same class definitions — they will, because the Execution Service imports `@oneplatform/plugin-sdk` directly and the plugin bundle includes the compiled error classes.

---

## 3. Core Type Primitives

These types are used across multiple plugin interfaces and are defined in `src/types/primitives.ts`.

```typescript
// JSON Schema Draft 7 subset. Used for configSchema, outputSchema, inputSchema fields.
// Deliberately typed as Record<string, unknown> — full JSON Schema typing is out of scope
// for this SDK. Plugin authors use standard JSON Schema tooling (ajv, etc.) for authoring.
export type JSONSchema = Record<string, unknown>;

// A single record from an external data source, as produced by a Connector
// or consumed by a Transformer or Destination.
export interface DataRecord {
  // The record's stable identifier in the external system.
  // Used for deduplication and incremental sync (upsert by sourceId).
  sourceId: string;

  // The record's raw field values. Keys are arbitrary strings from the source.
  data: Record<string, unknown>;

  // Optional provenance metadata. Connectors should populate these when available.
  metadata?: {
    createdAt?: string;    // ISO 8601 from source system
    updatedAt?: string;    // ISO 8601 from source system
    deletedAt?: string;    // ISO 8601. Non-null signals a soft-delete event.
    checksum?: string;     // Content hash for change detection (e.g., MD5 of JSON)
  };
}

// A record that has been mapped to an ontology entity type.
// Produced by the Ontology Service after a raw DataRecord passes through mapping.
export interface MappedRecord {
  sourceId: string;
  entityType: string;            // Platform ontology entity type (e.g., "Customer")
  data: Record<string, unknown>; // Ontology-typed, validated field values
  operation: "upsert" | "delete";
}
```

---

## 4. PluginContext Interface

Defined in `src/types/context.ts`. This is the complete injected context available to plugin code. The platform constructs a concrete implementation of this interface and passes it as the second argument to every plugin method. Plugin code must not attempt to construct `PluginContext` directly — it is always injected.

```typescript
export interface PluginContext {
  credentials: CredentialAccessor;
  fetch: FetchProxy;
  cache: CacheAccessor;
  logger: PluginLogger;
  tenant: TenantContext;
  ontology: OntologyAccessor;
  tracing: TracingContext;
}
```

### CredentialAccessor

```typescript
export interface CredentialAccessor {
  /**
   * Returns the decrypted credential value for a named credential bound to this
   * plugin instance. Credentials are configured by a platform admin and bound
   * at enable time via the plugin instance configuration form.
   *
   * The returned string is the raw credential value (API key, token, password, etc.).
   * Never log this value. Never include it in error messages. Never store it in the
   * plugin's cache — the platform rotates credentials and will deliver updated values
   * automatically.
   *
   * @throws PluginAuthError if the credential is not found or decryption fails.
   */
  get(name: string): Promise<string>;

  /**
   * Returns the names of all credentials available to this plugin instance.
   * Use this to check for optional credentials before calling get().
   */
  list(): Promise<string[]>;
}
```

### FetchProxy

```typescript
export interface FetchProxy {
  /**
   * Proxied HTTP fetch. Only URLs declared in manifest.requiredExternalUrls are
   * permitted. All internal OnePlatform service URLs are blocked unconditionally,
   * even if declared.
   *
   * URL matching is performed per-component on the parsed WHATWG URL:
   * - Protocol must match exactly (https:// required; http:// is blocked)
   * - Hostname must match exactly — no prefix/substring matching
   * - Path matching uses glob patterns on path segments only
   *
   * @throws PluginAuthError if the URL is not in the approved allowlist.
   */
  fetch(url: string, init?: RequestInit): Promise<Response>;
}
```

### CacheAccessor

```typescript
export interface CacheAccessor {
  /**
   * Get a value from the plugin instance's namespaced cache.
   * Cache keys are automatically scoped to {tenantId}:{instanceId} — two plugin
   * instances in the same tenant cannot read each other's cached data.
   *
   * Returns null if the key does not exist or has expired.
   */
  get<T>(key: string): Promise<T | null>;

  /**
   * Store a value in the plugin instance's namespaced cache.
   * @param ttlSeconds Optional TTL in seconds. If omitted, the value does not expire
   *                   until evicted by LRU pressure. Maximum TTL is 86400 (24 hours).
   */
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;

  /**
   * Delete a key from the plugin instance's cache.
   * No-op if the key does not exist.
   */
  delete(key: string): Promise<void>;

  /**
   * Acquire a distributed mutex lock. Useful for ensuring only one execution at a
   * time performs a token refresh or other singleton operation.
   *
   * Returns a LockHandle if the lock was acquired, or null if it is already held.
   * Always call release() in a finally block.
   *
   * @param ttlSeconds Lock TTL. The lock is automatically released after this duration
   *                   even if release() is never called (prevents deadlocks).
   */
  lock(key: string, ttlSeconds: number): Promise<LockHandle | null>;
}

export interface LockHandle {
  release(): Promise<void>;
}
```

### PluginLogger

```typescript
export interface PluginLogger {
  /**
   * Log a debug-level message. Debug logs are suppressed by default in production
   * tenants and are only visible with explicit debug mode enabled on the instance.
   */
  debug(message: string, metadata?: Record<string, unknown>): void;

  /** Log an informational message. Appears in the plugin execution log view. */
  info(message: string, metadata?: Record<string, unknown>): void;

  /**
   * Log a warning. Warnings are surfaced in the plugin monitoring dashboard and
   * increment the warning counter for this plugin instance.
   */
  warn(message: string, metadata?: Record<string, unknown>): void;

  /**
   * Log an error. Errors are surfaced in the plugin monitoring dashboard, increment
   * the error counter, and trigger alerting if configured by the tenant admin.
   *
   * IMPORTANT: Never pass credential values, access tokens, or PII in the metadata
   * argument. The metadata object is persisted to the platform logging system.
   */
  error(message: string, metadata?: Record<string, unknown>): void;
}
```

### TenantContext

```typescript
export interface TenantContext {
  /** UUID of the tenant that owns this plugin instance. */
  tenantId: string;

  /** Human-readable display name for this tenant. */
  tenantName: string;

  /**
   * Configuration values provided by the tenant admin at plugin enable time.
   * Values are validated against the plugin's manifest.configSchema before being
   * stored. Safe to read; always typed as Record<string, unknown>.
   */
  config: Record<string, unknown>;

  /**
   * Unique ID of this specific plugin instance within the tenant.
   * A single plugin can be enabled multiple times (e.g., two Shopify connectors
   * pointing to different stores). Each enable creates a distinct instanceId.
   */
  instanceId: string;
}
```

### OntologyAccessor

```typescript
export interface OntologyAccessor {
  /**
   * Read-only access to the tenant's current ontology schema.
   * Returns all entity type definitions currently configured for this tenant.
   * Result is cached within a single execution — repeated calls do not make
   * additional network requests.
   *
   * Plugins CANNOT mutate the ontology. This method is read-only.
   */
  getSchema(): Promise<OntologySchema>;

  /**
   * Retrieve the schema for a single entity type by name.
   * Returns null if the entity type does not exist in this tenant's ontology.
   */
  getEntitySchema(entityType: string): Promise<EntitySchema | null>;
}

export interface OntologySchema {
  entityTypes: EntitySchema[];
  version: number;
  updatedAt: string; // ISO 8601
}

export interface EntitySchema {
  name: string;
  displayName: string;
  fields: EntityField[];
  primaryKey: string;
}

export interface EntityField {
  name: string;
  type: "string" | "number" | "boolean" | "date" | "datetime" | "json" | "reference";
  required: boolean;
  referenceTo?: string; // Entity type name, if type === "reference"
}
```

### TracingContext

```typescript
export interface TracingContext {
  /**
   * Inject the current trace context into an outbound request headers object.
   * Use this with FetchProxy to propagate distributed traces into external service
   * calls. The returned object is a new object containing the original headers
   * plus the injected trace headers (W3C traceparent/tracestate).
   *
   * Example:
   *   const headers = ctx.tracing.injectHeaders({ "Content-Type": "application/json" });
   *   const response = await ctx.fetch(url, { headers });
   */
  injectHeaders(headers: Record<string, string>): Record<string, string>;

  /**
   * Create a child span for a named operation. The span is automatically parented
   * to the current execution trace. Call setAttribute() to add context, and always
   * call end() in a finally block.
   *
   * Example:
   *   const span = ctx.tracing.startSpan("fetchOrders");
   *   try {
   *     // ... do work ...
   *     span.setAttribute("order.count", records.length);
   *   } finally {
   *     span.end();
   *   }
   */
  startSpan(name: string): SpanHandle;
}

export interface SpanHandle {
  setAttribute(key: string, value: string | number | boolean): void;
  end(): void;
}
```

---

## 5. Plugin Interfaces

Each interface is defined in its own file under `src/types/`. The primary plugin object must be exported from `dist/bundle.js` using the named export declared in `manifest.entrypoint`. The platform calls `bundle[manifest.entrypoint]` to obtain the plugin object.

### 5.1 Connector

Defined in `src/types/connector.ts`.

A Connector is a data source. The Ingestion Service drives its lifecycle: it calls `connect()` once per ingestion job, then calls `fetchBatch()` in a cursor loop until `hasMore` is false, then calls `disconnect()`. Connectors are NOT pipeline hooks — they are registered as named data sources and appear in the "Data Sources" section of the platform UI.

```typescript
export interface ConnectorHandle {
  /**
   * Opaque identifier for this active connection, assigned by the plugin.
   * Used to correlate fetchBatch and disconnect calls to the same connection.
   * Must be a string. The platform stores this between fetchBatch calls to
   * support resumable ingestion.
   */
  connectionId: string;

  /**
   * Plugin-managed connection state. May include auth tokens, base URLs,
   * or other values needed by fetchBatch and disconnect.
   * Must be JSON-serializable (the platform may checkpoint this between calls).
   */
  metadata: Record<string, unknown>;
}

export interface BatchResult {
  records: DataRecord[];

  /**
   * Cursor for the next fetchBatch call. Set to null to signal that all records
   * have been returned. The cursor value is opaque to the platform — it may be
   * a page token, timestamp, offset, or any string the connector uses internally.
   */
  nextCursor: string | null;

  /** Set to true if there are more records after this batch (i.e., nextCursor is non-null). */
  hasMore: boolean;

  /** ISO 8601 timestamp of when this batch was fetched. Used for freshness tracking. */
  fetchedAt: string;

  /**
   * Advisory hint for the platform progress UI. If unknown, omit this field.
   * The platform never makes correctness decisions based on this value.
   */
  estimatedTotal?: number;
}

export interface EventCallback {
  (event: DataRecord): Promise<void>;
}

export interface Subscription {
  unsubscribe(): Promise<void>;
  isActive(): boolean;
}

export interface Connector {
  /**
   * Return the connector's metadata. Called by the Plugin Service at install time
   * to verify the entrypoint is valid, and by the Ingestion Service to display
   * connector details in the data source catalog.
   */
  metadata(): ConnectorMetadata;

  /**
   * Validate the plugin configuration and credentials, and establish a connection.
   * Called once per ingestion job before the first fetchBatch call.
   *
   * This method should be fast (< 5 seconds). If the external service requires
   * a round-trip for auth (e.g., OAuth token refresh), do it here and cache the
   * token in the context.cache.
   *
   * @throws PluginConfigError if config is invalid or missing required fields.
   * @throws PluginAuthError if credential validation fails.
   */
  connect(
    config: Record<string, unknown>,
    context: PluginContext
  ): Promise<ConnectorHandle>;

  /**
   * Fetch the next batch of records from the external system.
   *
   * cursor=undefined signals the first call (fetch from the beginning of available data).
   * For incremental syncs, the cursor is the value returned by the previous fetchBatch.
   * The platform stores the last successful cursor and resumes from it on retry.
   *
   * Batch size should be controlled by the connector, typically 100-1000 records.
   * Avoid batches larger than 10,000 records — the platform's ingestion queue has
   * per-message limits.
   *
   * @throws PluginRateLimitError if the external API returns 429.
   * @throws PluginTimeoutError if a network call exceeds the configured timeout.
   * @throws PluginAuthError if the connection credentials have expired.
   */
  fetchBatch(
    handle: ConnectorHandle,
    cursor: string | undefined,
    context: PluginContext
  ): Promise<BatchResult>;

  /**
   * Subscribe to real-time change events from the external system.
   * Only implement if ConnectorMetadata.supportsRealtime is true.
   *
   * The platform calls this method once when a real-time data source is activated.
   * The callback receives individual change events as they arrive. Each callback
   * invocation is an async operation — the connector must await it before processing
   * the next event to maintain ordering.
   *
   * The returned Subscription must remain active until unsubscribe() is called,
   * which happens when the tenant disables real-time on the data source.
   */
  subscribeToEvents?(
    handle: ConnectorHandle,
    callback: EventCallback,
    context: PluginContext
  ): Promise<Subscription>;

  /**
   * Clean up the connection. Called after the ingestion job completes or on error.
   * Must not throw. If cleanup fails, log the error and return.
   *
   * Resources to release: HTTP connections, open file handles, WebSocket connections.
   * Do NOT revoke OAuth tokens here — they may be reused by the next ingestion run.
   */
  disconnect(handle: ConnectorHandle, context: PluginContext): Promise<void>;
}
```

### 5.2 Transformer

Defined in `src/types/transformer.ts`.

A Transformer processes records in a pipeline step. The Pipeline Service calls the transformer for each step that is configured to use this plugin. Transformers run inside the Execution Service sandbox with a context that does not include the `fetch` or `credentials` APIs (pipeline transformers are expected to be pure data operations; external calls should be handled by connectors).

```typescript
export interface TransformerContext {
  tenant: TenantContext;
  logger: PluginLogger;
  ontology: OntologyAccessor;
  cache: CacheAccessor;
  tracing: TracingContext;

  /**
   * Present when the transformer runs inside a named pipeline run.
   * Use for logging and correlation, not for control flow.
   */
  pipelineRunId?: string;

  /** The ID of the pipeline step that invoked this transformer. */
  stageId?: string;
}

export interface Transformer {
  metadata(): TransformerMetadata;

  /**
   * Transform a single record.
   *
   * Return the (possibly modified) DataRecord to pass it downstream.
   * Return null to drop the record — it will not appear in the output.
   * Do not mutate the input record — return a new object.
   *
   * @throws PluginDataError if the record is malformed and cannot be processed.
   *         The platform will route the record to the pipeline's dead-letter queue.
   *         Do not throw for recoverable data issues — return a modified record instead.
   */
  transform(
    record: DataRecord,
    context: TransformerContext
  ): Promise<DataRecord | null>;

  /**
   * Transform a batch of records. Optional optimization for transformers that can
   * process records more efficiently in bulk (e.g., batch enrichment API calls).
   *
   * If implemented, the platform uses this instead of calling transform() N times.
   * The result array must preserve ordering: records[i] maps to result[i] or is
   * absent (dropped). Use an empty array to drop all records.
   *
   * The platform NEVER calls both transform() and transformBatch() for the same
   * batch — it prefers transformBatch() if present.
   */
  transformBatch?(
    records: DataRecord[],
    context: TransformerContext
  ): Promise<DataRecord[]>;
}
```

### 5.3 Destination

Defined in `src/types/destination.ts`.

A Destination writes mapped, ontology-typed records to an external system. The Ingestion Service calls destinations after a record has been validated, mapped to an ontology entity, and committed to the platform data store. Destinations may receive both upsert and delete operations.

```typescript
export interface WriteResult {
  /** Count of records successfully written. */
  written: number;

  /** Count of records that failed. */
  failed: number;

  /**
   * Per-record error details for failed records.
   * Include the sourceId so the platform can correlate failures to records.
   * Do not include credential values in the error string.
   */
  errors: Array<{ sourceId: string; error: string }>;
}

export interface DestinationContext {
  tenant: TenantContext;
  logger: PluginLogger;
  cache: CacheAccessor;
  fetch: FetchProxy;
  tracing: TracingContext;
}

export interface Destination {
  metadata(): DestinationMetadata;

  /**
   * Write a batch of mapped records to the destination.
   *
   * The platform calls this with batches sized according to the destination's
   * delivery guarantee. For at-least-once destinations, the same record may be
   * delivered more than once (e.g., after a retry). The destination must handle
   * idempotent writes if its DestinationMetadata.deliveryGuarantee is
   * "at-least-once" or "exactly-once".
   *
   * Never partially fail silently — report all failures in WriteResult.errors.
   * The platform uses this to trigger DLQ routing.
   */
  write(
    records: MappedRecord[],
    context: DestinationContext
  ): Promise<WriteResult>;

  /**
   * Stream records to the destination. Only implement if
   * DestinationMetadata.supportsStreaming is true.
   *
   * The platform provides an AsyncIterable of records. The destination should
   * maintain an open connection to the target system and write records as they
   * arrive. Return a WriteResult when the stream is exhausted.
   */
  writeStream?(
    stream: AsyncIterable<MappedRecord>,
    context: DestinationContext
  ): Promise<WriteResult>;
}
```

### 5.4 AuthProvider

Defined in `src/types/auth-provider.ts`.

An AuthProvider extends the platform's authentication system with a custom OAuth2, SAML, OIDC, LDAP, or proprietary protocol integration. The Auth Service drives the OAuth dance and calls the plugin for the URL-building and callback-handling steps.

Security note: The Auth Service validates the `state` parameter (CSRF check) internally before calling `handleCallback`. The plugin never receives the raw `state` value.

```typescript
export interface AuthOptions {
  /** The platform's OAuth callback URL. Must be included verbatim in the authorization URL. */
  redirectUri: string;

  /** OAuth scopes to request. If omitted, the provider's default scopes apply. */
  scopes?: string[];

  /** Provider-specific query parameters to append to the authorization URL. */
  additionalParams?: Record<string, string>;
}

export interface CallbackParams {
  /**
   * The authorization code from the OAuth provider.
   * For SAML flows, this is the decoded assertion value after base64 decoding.
   */
  code: string;

  /** Set if the provider returned an error in the callback. */
  error?: string;

  /** Human-readable description of the error, if present. */
  errorDescription?: string;
}

export interface AuthContext {
  tenant: TenantContext;
  logger: PluginLogger;

  /**
   * Cache accessor for storing PKCE code verifiers, nonces, or other
   * short-lived values needed across the two legs of the auth flow.
   * Use TTLs of 300 seconds (5 minutes) for these values.
   */
  cache: CacheAccessor;
}

export interface AuthResult {
  accessToken: string;
  refreshToken?: string;

  /** ISO 8601 expiry time for the access token. */
  expiresAt?: string;

  /** Raw claims from the identity provider. Used by mapClaimsToRoles(). */
  claims: Record<string, unknown>;

  /** Platform RBAC role names assigned to this user, as returned by mapClaimsToRoles(). */
  platformRoles: string[];

  /** The user's stable ID in the external identity provider. */
  providerUserId: string;
}

export interface TokenValidation {
  valid: boolean;
  claims?: Record<string, unknown>;
  expiresAt?: string;
  error?: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
}

export interface AuthProvider {
  metadata(): AuthProviderMetadata;

  /**
   * Build the authorization URL that the browser navigates to.
   * This method is synchronous — it should not make network calls.
   *
   * @param state An opaque, cryptographically random string generated by the Auth Service.
   *              Include this in the authorization URL as the `state` query parameter.
   *              The Auth Service will verify it matches when the callback arrives.
   * @param options Platform-provided callback configuration.
   * @returns The full authorization URL to redirect the browser to.
   */
  getAuthorizationUrl(state: string, options: AuthOptions): string;

  /**
   * Handle the OAuth callback. Exchange the authorization code for tokens.
   *
   * The Auth Service has already verified the state parameter (CSRF check) before
   * calling this method. The plugin should exchange the code for tokens and return
   * an AuthResult. Never call external token validation URLs from this method —
   * the platform considers the tokens valid if they arrive in the provider's callback.
   *
   * @throws PluginAuthError if the code exchange fails (e.g., expired code, bad credentials).
   */
  handleCallback(
    params: CallbackParams,
    context: AuthContext
  ): Promise<AuthResult>;

  /**
   * Validate an access token with the external provider.
   * Only implement if AuthProviderMetadata.supportsTokenValidation is true.
   * Called on API requests to verify the token has not been revoked externally.
   *
   * @returns TokenValidation with valid=false if the token is expired or revoked.
   *          Do not throw for invalid tokens — return valid=false.
   * @throws PluginAuthError only for unrecoverable errors (e.g., provider unreachable).
   */
  validateToken?(
    token: string,
    context: AuthContext
  ): Promise<TokenValidation>;

  /**
   * Exchange a refresh token for a new access token.
   * Only implement if AuthProviderMetadata.supportsTokenRefresh is true.
   *
   * Use context.cache.lock() to prevent concurrent refreshes for the same user.
   *
   * @throws PluginAuthError if the refresh token is expired or revoked.
   */
  refreshToken?(
    refreshToken: string,
    context: AuthContext
  ): Promise<TokenPair>;

  /**
   * Map external identity provider claims to OnePlatform RBAC role names.
   * Called during login and on every token refresh to keep role assignments current.
   *
   * Returns an array of platform role name strings. Roles that do not exist in
   * the platform are ignored. An empty array means the user has no roles (they
   * can still log in but will have no permissions).
   *
   * This method is synchronous and must not make network calls.
   */
  mapClaimsToRoles(claims: Record<string, unknown>): string[];
}
```

### 5.5 Widget

Defined in `src/types/widget.ts`.

A Widget renders a UI component inside the platform dashboard. The App Service executes the widget's `render()` method server-side and serves the returned HTML in a sandboxed `<iframe>`. The Widget interface does not receive `PluginContext` because it does not run in the Execution Service sandbox — the App Service renders it in a restricted Node.js context. Widget code must not access credentials or make outbound HTTP calls.

```typescript
export type WidgetSlot = "main" | "sidebar" | "header" | "footer" | "fullscreen";

export interface WidgetSlotDeclaration {
  slot: WidgetSlot;
  defaultWidth: number;  // Grid units (1-12)
  defaultHeight: number; // Grid units (1-12)
}

export interface DataQuery {
  entityType: string;
  filter?: Record<string, unknown>;
  sort?: string;
  fields?: string[];
  limit?: number;
}

export interface WidgetData {
  /**
   * Pre-fetched query results, keyed by entityType.
   * Populated by the platform before render() is called.
   * The platform fetches data using the tenant's access rights — widgets
   * never make data API calls directly.
   */
  queryResults: Record<string, unknown[]>;

  /** The widget instance's configuration values. */
  config: Record<string, unknown>;

  /** The requesting user's identity and roles. Use for conditional rendering only. */
  user: { id: string; roles: string[] };
}

export interface Widget {
  metadata(): WidgetMetadata;

  /**
   * Return a complete HTML document string to be served inside the widget iframe.
   *
   * Security constraints:
   * - Do not include <script> tags in the output. DOMPurify (server-side) strips
   *   all <script> elements. The platform injects a bootstrap script via nonce.
   * - Do not attempt to access window.parent or window.top — the iframe uses
   *   sandbox="allow-scripts" (no allow-same-origin), creating an opaque origin.
   * - Use inline styles freely (style-src 'unsafe-inline' is permitted).
   * - Do not embed external images — use data URIs or serve from the widget bundle.
   *
   * The returned HTML must be a complete document (<html><head><body>...</body></html>).
   */
  render(data: WidgetData): string;

  /**
   * Declare what platform data this widget needs.
   * The platform pre-fetches this data before calling render(), so render() receives
   * fully populated WidgetData.queryResults without making any async calls.
   *
   * Keep queries minimal — each declared query adds latency to the dashboard load.
   */
  declareDataRequirements(): DataQuery[];

  /** Declare which slot(s) this widget can render in. */
  declareSlot(): WidgetSlotDeclaration;
}
```

---

## 6. Error Taxonomy

Defined in `src/types/errors.ts`. These are runtime classes (not just types) because the Execution Service uses `instanceof` checks to determine retry behavior and routing.

Every error a plugin throws should be one of these typed errors. Untyped `Error` instances are treated as `PluginError` with `isRetryable=false`.

```typescript
/**
 * Base class for all plugin errors. Do not throw PluginError directly —
 * use one of the typed subclasses below.
 */
export class PluginError extends Error {
  constructor(
    message: string,
    /** Machine-readable error code, e.g., "INVALID_CURSOR". Snake_case, uppercase. */
    public readonly code: string,
    /**
     * Whether the Execution Service should retry this execution.
     * true:  transient failure, retry with backoff (rate limits, timeouts, 5xx)
     * false: permanent failure, route to DLQ immediately (bad config, bad data)
     */
    public readonly isRetryable: boolean,
    /** Structured context for debugging. Never include credential values. */
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = this.constructor.name;
    // Maintain correct prototype chain when transpiled to ES5 or CommonJS
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * The external service returned 401 or 403.
 * isRetryable=false: credential rotation (a human action) is required before retry.
 * The platform surfaces this error in the plugin monitoring dashboard immediately.
 */
export class PluginAuthError extends PluginError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "PLUGIN_AUTH_ERROR", false, details);
  }
}

/**
 * The external service returned 429 (Too Many Requests).
 * isRetryable=true: the Execution Service respects retryAfterSeconds if present,
 * otherwise applies exponential backoff (base 2s, max 300s, jitter ±20%).
 */
export class PluginRateLimitError extends PluginError {
  constructor(
    message: string,
    /** Hint from the external service's Retry-After header, if present. */
    public readonly retryAfterSeconds?: number
  ) {
    super(message, "PLUGIN_RATE_LIMIT", true, { retryAfterSeconds });
  }
}

/**
 * A network call timed out, or the execution sandbox timeout was reached.
 * isRetryable=true: timeouts are often transient.
 * The platform logs the timeout duration alongside this error for diagnosis.
 */
export class PluginTimeoutError extends PluginError {
  constructor(message: string) {
    super(message, "PLUGIN_TIMEOUT", true);
  }
}

/**
 * The external service returned malformed, unexpected, or unprocessable data.
 * isRetryable=false: the data shape is wrong; retrying will produce the same error.
 * The platform routes the record to the DLQ with the sample attached.
 *
 * Include a sample of the problematic data in the sample parameter for DLQ debugging.
 * Truncate large samples to 1KB.
 */
export class PluginDataError extends PluginError {
  constructor(
    message: string,
    /** A sample of the data that could not be processed. Truncate to 1KB. */
    public readonly sample?: unknown
  ) {
    super(message, "PLUGIN_DATA_ERROR", false, { sample });
  }
}

/**
 * A required configuration field is missing or has an invalid value.
 * isRetryable=false: configuration is static; retrying without configuration
 * change will produce the same error.
 *
 * Throw this from connect() when a required config field is absent or invalid.
 * Do not throw this from fetchBatch — configuration issues should be caught at
 * connect() time.
 */
export class PluginConfigError extends PluginError {
  constructor(
    message: string,
    /** The name of the config field that is missing or invalid. */
    public readonly field?: string
  ) {
    super(message, "PLUGIN_CONFIG_ERROR", false, { field });
  }
}
```

---

## 7. Metadata Types

Defined in `src/types/metadata.ts`. Metadata types describe the plugin's capabilities and are returned by each plugin's `metadata()` method. The Plugin Service stores these values and the marketplace UI reads them.

```typescript
export interface BaseMetadata {
  /** Must match manifest.id exactly. */
  id: string;

  /** Human-readable display name. 2-100 characters. */
  name: string;

  /** Brief description shown in the marketplace. 10-500 characters. */
  description: string;

  /** Must match manifest.version exactly. */
  version: string;

  /** Plugin author name or organization. */
  author: string;

  /** URL or data URI for the plugin icon. PNG or SVG, max 64KB. */
  icon?: string;

  /** JSON Schema for the tenant-admin configuration form. */
  configSchema: JSONSchema;

  /** Discoverability tags shown in the marketplace filter UI. */
  tags?: string[];
}

export interface ConnectorMetadata extends BaseMetadata {
  readonly type: "connector";

  /**
   * Marketplace category. Standard values: "crm", "ecommerce", "database",
   * "file", "analytics", "marketing", "finance", "devtools", "iot", "other".
   */
  category: string;

  /** JSON Schema describing the shape of records this connector produces. */
  outputSchema: JSONSchema;

  /** True if the connector supports cursor-based incremental fetching. */
  supportsIncremental: boolean;

  /** True if the connector implements subscribeToEvents(). */
  supportsRealtime: boolean;

  /**
   * Advisory rate limit hint for the Ingestion Service's scheduling algorithm.
   * Does not enforce anything — the connector is responsible for enforcing its own
   * rate limits by throwing PluginRateLimitError.
   */
  rateLimit?: {
    requestsPerMinute: number;
    rowsPerSecond?: number;
  };
}

export interface TransformerMetadata extends BaseMetadata {
  readonly type: "transformer";

  /** JSON Schema for accepted record shape. null means any shape is accepted. */
  inputSchema?: JSONSchema;

  /** JSON Schema for output record shape. null means shape mirrors input. */
  outputSchema?: JSONSchema;

  /**
   * True if transform(transform(x)) === transform(x) for all x.
   * Idempotent transformers can be safely retried without data duplication.
   */
  idempotent: boolean;
}

export interface DestinationMetadata extends BaseMetadata {
  readonly type: "destination";

  /** JSON Schema for the record shape this destination accepts. null = any shape. */
  acceptedSchema?: JSONSchema;

  /**
   * Delivery guarantee provided by this destination's write() implementation.
   * "at-most-once":  records may be lost on failure; no retry
   * "at-least-once": records are retried on failure; destination must handle duplicates
   * "exactly-once":  records are deduplicated by sourceId; strongest guarantee
   */
  deliveryGuarantee: "at-most-once" | "at-least-once" | "exactly-once";

  /** True if the destination supports write() with batches > 1. */
  supportsBulk: boolean;

  /** True if the destination implements writeStream(). */
  supportsStreaming: boolean;
}

export interface AuthProviderMetadata extends BaseMetadata {
  readonly type: "auth-provider";

  /** The identity protocol this provider implements. */
  protocol: "oauth2" | "saml" | "oidc" | "ldap" | "custom";

  /** True if the provider implements validateToken(). */
  supportsTokenValidation: boolean;

  /** True if the provider implements refreshToken(). */
  supportsTokenRefresh: boolean;

  /**
   * OAuth scopes this provider supports. Shown in the admin configuration UI.
   * Omit for non-OAuth providers.
   */
  scopes?: string[];
}

export interface WidgetMetadata extends BaseMetadata {
  readonly type: "widget";

  /** Minimum grid width. Integer 1-12. */
  minWidth: number;

  /** Minimum grid height. Integer 1-12. */
  minHeight: number;

  /** Maximum grid width. Omit for no constraint. */
  maxWidth?: number;

  /** Maximum grid height. Omit for no constraint. */
  maxHeight?: number;

  /** Slots this widget can render in. */
  slots: WidgetSlotDeclaration[];
}

/** Union of all metadata types for use in generic plugin-handling code. */
export type AnyPluginMetadata =
  | ConnectorMetadata
  | TransformerMetadata
  | DestinationMetadata
  | AuthProviderMetadata
  | WidgetMetadata;
```

---

## 8. HookDeclaration Interface

Defined in `src/types/hooks.ts`. The `HookDeclaration` interface maps directly to entries in `plugin.manifest.json`'s `hooks` array. Hooks are registered at plugin-enable time and deregistered at disable time by the Plugin Service.

```typescript
/**
 * All valid hook stages. The pattern is "{timing}:{domain}.{event}" or
 * "{timing}:{domain}.{event}:{stepId}" for parameterized pipeline step hooks.
 *
 * Timing: "before" = before the stage executes; "after" = after the stage executes.
 */
export type HookStage =
  // Ingestion Service
  | "before:ingestion.receive"
  | "after:ingestion.receive"
  | "before:ingestion.validate"
  | "after:ingestion.validate"
  | "before:ingestion.enrich"
  | "after:ingestion.enrich"
  | "before:ingestion.stage"
  | "after:ingestion.stage"
  // Ontology Service
  | "before:ontology.map"
  | "after:ontology.map"
  | "before:ontology.normalize"
  | "after:ontology.normalize"
  // Pipeline Service
  | "before:pipeline.trigger"
  | "after:pipeline.trigger"
  | "before:pipeline.step"
  | "after:pipeline.step"
  | "before:pipeline.complete"
  | "after:pipeline.complete"
  // Execution Service
  | "before:execution.before"
  | "after:execution.before"
  | "before:execution.after"
  | "after:execution.after"
  // Auth Service
  | "before:auth.login"
  | "after:auth.login"
  | "after:auth.logout"
  | "before:auth.token.issue"
  | "after:auth.token.issue"
  // App Service
  | "before:app.request"
  | "after:app.request"
  | "before:app.build"
  | "after:app.build"
  // Parameterized pipeline step (stepId substituted at registration time)
  | `before:pipeline.step:${string}`
  | `after:pipeline.step:${string}`;

export interface HookDeclaration {
  /**
   * The hook stage this declaration registers for.
   * Must be one of the HookStage values above.
   */
  stage: HookStage;

  /**
   * Criticality determines what happens when this hook fails or times out.
   *
   * "critical":  Hook failure aborts the stage and returns an error to the caller.
   *              Use for hooks that enforce invariants (e.g., schema validation).
   * "advisory":  Hook failure is logged but the stage continues with the pre-hook
   *              payload. Use for enrichment or observability hooks.
   */
  criticality: "critical" | "advisory";

  /**
   * Execution order within a stage's hook chain. Lower priority = earlier execution.
   * Default: 100. Valid range: 0-999.
   * When two hooks share the same priority, execution order is deterministic but
   * not specified — do not rely on ordering between plugins with equal priority.
   */
  priority?: number;

  /**
   * Execution timeout override for this specific hook.
   * Default: 30 seconds. Maximum: 300 seconds.
   * Must be specified in seconds as a positive integer.
   */
  timeout?: number;

  /**
   * The named export in dist/bundle.js that implements this hook.
   * Example: "onBeforeIngestionReceive"
   *
   * The export must be a function with this signature:
   *   async function onBeforeIngestionReceive(
   *     payload: HookPayload,
   *     context: PluginContext
   *   ): Promise<HookResult>
   */
  entrypoint: string;
}

/**
 * The payload passed to every hook function.
 * The concrete shape of `data` depends on the hook stage.
 * Hook functions may return a modified payload to alter platform behavior.
 */
export interface HookPayload {
  /** The stage that triggered this hook. */
  stage: HookStage;

  /** The data being processed at this stage. Shape varies by stage. */
  data: Record<string, unknown>;

  /** Metadata about the execution context. */
  context: {
    tenantId: string;
    traceId: string;
    spanId: string;
    pipelineRunId?: string;
    ingestionJobId?: string;
  };
}

/**
 * The return type of a hook function.
 * To modify the data flowing through the stage, return a new payload.
 * To pass data through unmodified, return the input payload unchanged.
 * Returning null from an advisory hook is equivalent to returning the input payload.
 */
export interface HookResult {
  /** The (possibly modified) data to pass to the next hook or to the stage itself. */
  data: Record<string, unknown>;
}
```

---

## 9. Manifest Schema and Zod Validation

Defined in `src/manifest/schema.ts`. This module is exported at `@oneplatform/plugin-sdk/manifest` and is NOT included in the root export path (it pulls in Zod as a runtime dependency).

### Zod Schema

```typescript
import { z } from "zod";

const JSONSchemaZ = z.record(z.unknown());

const HookDeclarationZ = z.object({
  stage: z.string().min(1),
  criticality: z.enum(["critical", "advisory"]),
  priority: z.number().int().min(0).max(999).optional(),
  timeout: z.number().int().min(1).max(300).optional(),
  entrypoint: z.string().regex(/^[a-zA-Z_$][a-zA-Z0-9_$]*$/, {
    message: "entrypoint must be a valid JavaScript identifier",
  }),
});

const RequiredCredentialZ = z.object({
  name: z.string().min(1).max(100),
  description: z.string().min(1).max(500),
  type: z.enum(["secret", "password", "token", "certificate"]),
  required: z.boolean(),
});

export const PluginManifestSchema = z.object({
  manifestVersion: z.literal("1"),

  id: z
    .string()
    .min(3)
    .max(200)
    .regex(/^[a-z0-9]+(\.[a-z0-9][a-z0-9-]*[a-z0-9])+$/, {
      message:
        "id must be reverse-domain format, e.g. com.example.my-plugin",
    }),

  name: z.string().min(2).max(100),

  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+(-[a-zA-Z0-9.+-]+)?(\+[a-zA-Z0-9.+]+)?$/, {
      message: "version must be SemVer, e.g. 1.2.3 or 1.0.0-beta.1",
    }),

  type: z.enum([
    "connector",
    "transformer",
    "destination",
    "auth-provider",
    "widget",
  ]),

  description: z.string().min(10).max(200),

  author: z.string().min(1).max(200),

  supportUrl: z.string().url().optional(),
  homepageUrl: z.string().url().optional(),

  icon: z
    .string()
    .refine(
      (v) =>
        v.startsWith("https://") ||
        v.startsWith("data:image/png;base64,") ||
        v.startsWith("data:image/svg+xml;base64,"),
      { message: "icon must be an https URL or a PNG/SVG data URI" }
    )
    .optional(),

  minPlatformVersion: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/, {
      message: "minPlatformVersion must be a simple x.y.z SemVer",
    }),

  entrypoint: z.string().regex(/^[a-zA-Z_$][a-zA-Z0-9_$]*$/, {
    message: "entrypoint must be a valid JavaScript identifier",
  }),

  configSchema: JSONSchemaZ,

  hooks: z.array(HookDeclarationZ).default([]),

  requiredExternalUrls: z
    .array(
      z.string().refine(
        (u) => u.startsWith("https://"),
        { message: "requiredExternalUrls entries must use https://" }
      )
    )
    .default([]),

  requiredApis: z
    .array(
      z.enum(["credentials", "fetch", "cache", "ontology", "tracing"])
    )
    .default([]),

  requiredCredentials: z.array(RequiredCredentialZ).default([]),

  bundleChecksum: z
    .string()
    .regex(/^[a-f0-9]{64}$/, {
      message: "bundleChecksum must be a 64-character lowercase hex SHA-256",
    }),

  gpgFingerprint: z
    .string()
    .regex(/^[A-F0-9]{40}$/, {
      message: "gpgFingerprint must be a 40-character uppercase hex fingerprint",
    })
    .optional(),

  tags: z.array(z.string().min(1).max(50)).max(20).optional(),

  license: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[A-Za-z0-9\-.+]+$/, {
      message: "license must be an SPDX identifier, e.g. MIT or Apache-2.0",
    }),

  changelog: z.string().max(5000).optional(),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;
```

### Validation Usage

The manifest schema is used in two places:

1. **`op plugin pack` (CLI):** Validates the manifest before bundling. Exits non-zero with structured error output on failure.

2. **Plugin Service install endpoint:** Calls `PluginManifestSchema.safeParse()`. On failure, returns HTTP 422 with `errors: ZodError.issues`. The Plugin Service imports `@oneplatform/plugin-sdk/manifest` directly — the Zod schema is the single source of truth.

### Manifest Validation Error Format

```typescript
// On validation failure, the CLI and Plugin Service both produce this structure:
interface ManifestValidationError {
  valid: false;
  errors: Array<{
    path: string;        // Dot-separated path, e.g., "hooks[0].entrypoint"
    message: string;     // Human-readable validation message
    received?: unknown;  // The value that failed validation (omitted for security)
  }>;
}
```

---

## 10. Plugin Scaffold — op plugin create

Defined in `src/dev/scaffold.ts`. This module implements the interactive `op plugin create` CLI command.

### User Interaction Flow

```
$ op plugin create

  OnePlatform Plugin Scaffold
  ──────────────────────────────────────

  Plugin type?
  > connector
    transformer
    destination
    auth-provider
    widget

  Plugin ID (reverse-domain, e.g. com.example.my-plugin):
  > com.acme.salesforce-connector

  Display name:
  > Salesforce Connector

  Author (name or organization):
  > Acme Corp

  Output directory (default: ./salesforce-connector):
  >

  Creating plugin scaffold in ./salesforce-connector/
  ✔ package.json
  ✔ tsconfig.json
  ✔ plugin.manifest.json
  ✔ src/index.ts
  ✔ src/__tests__/index.test.ts
  ✔ .gitignore

  Next steps:
    cd salesforce-connector
    pnpm install
    pnpm dev           # TypeScript watch mode
    op plugin simulate-hook before:ingestion.receive --input ./test-payload.json
    op plugin pack     # When ready to distribute
```

### Generated File Contents

#### `plugin.manifest.json` (Connector example)

```json
{
  "manifestVersion": "1",
  "id": "com.acme.salesforce-connector",
  "name": "Salesforce Connector",
  "version": "0.1.0",
  "type": "connector",
  "description": "Connects OnePlatform to Salesforce CRM",
  "author": "Acme Corp",
  "minPlatformVersion": "1.0.0",
  "entrypoint": "SalesforceConnector",
  "configSchema": {
    "type": "object",
    "required": ["instanceUrl"],
    "properties": {
      "instanceUrl": {
        "type": "string",
        "description": "Your Salesforce instance URL, e.g. https://mycompany.salesforce.com"
      }
    }
  },
  "hooks": [],
  "requiredExternalUrls": [
    "https://*.salesforce.com/**"
  ],
  "requiredApis": ["credentials", "fetch", "cache"],
  "requiredCredentials": [
    {
      "name": "clientId",
      "description": "Salesforce Connected App Client ID",
      "type": "token",
      "required": true
    },
    {
      "name": "clientSecret",
      "description": "Salesforce Connected App Client Secret",
      "type": "secret",
      "required": true
    }
  ],
  "bundleChecksum": "",
  "license": "MIT",
  "tags": ["crm", "salesforce"]
}
```

#### `src/index.ts` (Connector example)

```typescript
import type {
  Connector,
  ConnectorHandle,
  ConnectorMetadata,
  BatchResult,
  PluginContext,
} from "@oneplatform/plugin-sdk";
import { PluginAuthError, PluginConfigError, PluginRateLimitError } from "@oneplatform/plugin-sdk";

export const SalesforceConnector: Connector = {
  metadata(): ConnectorMetadata {
    return {
      type: "connector",
      id: "com.acme.salesforce-connector",
      name: "Salesforce Connector",
      description: "Connects OnePlatform to Salesforce CRM",
      version: "0.1.0",
      author: "Acme Corp",
      category: "crm",
      configSchema: {
        type: "object",
        required: ["instanceUrl"],
        properties: {
          instanceUrl: { type: "string" },
        },
      },
      outputSchema: {
        type: "object",
        properties: {
          Id: { type: "string" },
          Name: { type: "string" },
        },
      },
      supportsIncremental: true,
      supportsRealtime: false,
    };
  },

  async connect(
    config: Record<string, unknown>,
    context: PluginContext
  ): Promise<ConnectorHandle> {
    const instanceUrl = config["instanceUrl"];
    if (typeof instanceUrl !== "string" || !instanceUrl) {
      throw new PluginConfigError("instanceUrl is required", "instanceUrl");
    }

    const clientId = await context.credentials.get("clientId");
    const clientSecret = await context.credentials.get("clientSecret");

    // TODO: Implement OAuth2 token acquisition
    // const token = await acquireToken(instanceUrl, clientId, clientSecret, context);

    return {
      connectionId: `sf-${Date.now()}`,
      metadata: { instanceUrl, accessToken: "TODO" },
    };
  },

  async fetchBatch(
    handle: ConnectorHandle,
    cursor: string | undefined,
    context: PluginContext
  ): Promise<BatchResult> {
    const offset = cursor ? parseInt(cursor, 10) : 0;
    context.logger.info("Fetching batch", { offset });

    // TODO: Implement actual API call
    // const result = await context.fetch(
    //   `${handle.metadata.instanceUrl}/services/data/v60.0/query?q=...OFFSET ${offset}`,
    //   { headers: { Authorization: `Bearer ${handle.metadata.accessToken}` } }
    // );

    return {
      records: [],
      nextCursor: null,
      hasMore: false,
      fetchedAt: new Date().toISOString(),
    };
  },

  async disconnect(
    handle: ConnectorHandle,
    context: PluginContext
  ): Promise<void> {
    context.logger.info("Disconnecting", { connectionId: handle.connectionId });
  },
};
```

#### `src/__tests__/index.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import { createMockContext } from "@oneplatform/plugin-sdk/testing";
import { SalesforceConnector } from "../index.js";
import { PluginConfigError } from "@oneplatform/plugin-sdk";

describe("SalesforceConnector", () => {
  it("returns valid metadata", () => {
    const meta = SalesforceConnector.metadata();
    expect(meta.type).toBe("connector");
    expect(meta.id).toBe("com.acme.salesforce-connector");
    expect(meta.supportsIncremental).toBe(true);
  });

  it("throws PluginConfigError if instanceUrl is missing", async () => {
    const ctx = createMockContext();
    await expect(
      SalesforceConnector.connect({}, ctx)
    ).rejects.toThrow(PluginConfigError);
  });

  it("returns empty batch result", async () => {
    const ctx = createMockContext({
      credentials: { clientId: "test-id", clientSecret: "test-secret" },
    });
    const handle = await SalesforceConnector.connect(
      { instanceUrl: "https://test.salesforce.com" },
      ctx
    );
    const result = await SalesforceConnector.fetchBatch(handle, undefined, ctx);
    expect(result.hasMore).toBe(false);
    expect(result.records).toHaveLength(0);
  });
});
```

### Scaffold Template Set

The scaffold produces different `src/index.ts` and test stubs for each plugin type. The templates are embedded in the SDK as string constants in `src/dev/scaffold.ts` — they are not read from disk at runtime. This keeps the scaffold self-contained with no dependency on template files relative to the CLI binary's install location.

---

## 11. Local Dev Server — op plugin simulate-hook

Defined in `src/dev/simulate-hook.ts`. This module implements `op plugin simulate-hook`, which allows plugin authors to execute a hook function locally using a mock `PluginContext`.

### Command Interface

```
op plugin simulate-hook <stage>
  --plugin     Path to the compiled bundle.js (default: ./dist/bundle.js)
  --input      Path to a JSON file containing the HookPayload.data
  --tenant-id  Tenant ID to use in the mock context (default: "dev-tenant")
  --instance-id Plugin instance ID (default: "dev-instance")
  --credentials Path to a JSON file with credential name→value mappings
  --config     Path to a JSON file with plugin instance config values
  --pretty     Pretty-print the hook output (default: true when stdout is tty)
  --no-sandbox Run outside isolated-vm (faster, less safe — for quick iteration only)
```

### Execution Flow

The simulate-hook command does not require a running OnePlatform instance. It executes the hook locally using a constructed mock context.

```
1. Load dist/bundle.js from --plugin path (defaults to ./dist/bundle.js)
2. Read --input JSON file → HookPayload
3. Construct a mock PluginContext:
   - credentials: loads from --credentials JSON file
   - fetch: proxied through a local interceptor (logs outbound URLs, returns mock 200 OK)
   - cache: in-process Map (cleared on every simulate-hook run)
   - logger: writes structured JSON to stderr
   - tenant: populated from --tenant-id, --instance-id, --config
   - ontology: returns empty schema unless --ontology-schema flag is provided
   - tracing: no-op (logs span names to stderr for visibility)
4. Import bundle.js and call bundle[entrypoint](payload, mockContext)
5. Write the returned HookResult to stdout as JSON
6. Write execution summary to stderr: duration, log count, spans
```

### Output Format

```json
{
  "stage": "before:ingestion.receive",
  "duration_ms": 142,
  "result": {
    "data": {
      "sourceId": "abc-123",
      "data": { "name": "Alice" }
    }
  },
  "logs": [
    { "level": "info", "message": "Processing record", "metadata": { "sourceId": "abc-123" } }
  ],
  "spans": [
    { "name": "fetchCustomerDetails", "duration_ms": 85 }
  ]
}
```

On error, `result` is replaced with:
```json
{
  "error": {
    "type": "PluginDataError",
    "code": "PLUGIN_DATA_ERROR",
    "message": "Field 'email' expected string, got number",
    "isRetryable": false,
    "details": { "sample": { "email": 12345 } }
  }
}
```

### Isolation Mode

By default, `simulate-hook` executes the plugin in a lightweight `vm.Script` context (Node.js `vm` module), not `isolated-vm`. This is intentional for local development: it is faster and allows Node.js debugger attachment.

When `--sandbox` flag is provided, the plugin executes in a real `isolated-vm` context matching the production Execution Service sandbox, including the 512MB memory limit and 30s timeout. This is useful for verifying that the plugin does not access forbidden globals before submitting to the platform.

---

## 12. Build and Pack — op plugin pack

Defined in `src/dev/pack.ts`. Implements `op plugin pack` and `op plugin validate`.

### op plugin pack

```
op plugin pack [--out <path>] [--sign <gpg-key-id>]
```

The command runs from the plugin's project root (where `plugin.manifest.json` lives).

**Steps:**

1. Read and validate `plugin.manifest.json` using `PluginManifestSchema.safeParse()`. Abort on failure with structured error output listing every failing field.

2. Run esbuild to compile the plugin:
   ```
   esbuild src/index.ts \
     --bundle \
     --format=esm \
     --platform=node \
     --target=node20 \
     --outfile=dist/bundle.js \
     --external:@oneplatform/plugin-sdk
   ```
   The `--external:@oneplatform/plugin-sdk` flag is critical: it prevents the SDK's error classes from being bundled into the plugin. The Execution Service provides the SDK's runtime exports to the plugin's execution context, ensuring `instanceof PluginAuthError` checks work correctly on both sides.

3. Compute SHA-256 of `dist/bundle.js`:
   ```
   sha256 = crypto.createHash("sha256").update(bundleBytes).digest("hex")
   ```

4. Write SHA-256 to `dist/bundle.js.sha256` (hex string, no newline).

5. Update `manifest.bundleChecksum` in the in-memory manifest with the computed SHA-256.

6. Write the updated manifest back to `plugin.manifest.json` (overwriting the file). This keeps the on-disk manifest in sync with the built artifact.

7. If `--sign <gpg-key-id>` is provided:
   - Create a gzip-compressed tar of the three files first (without the signature).
   - Run `gpg --detach-sign --armor --local-user <gpg-key-id>` on the tar.
   - Include the `.sig` file in the final tarball.

8. Create the final archive:
   ```
   {manifest.id}-{manifest.version}.oppkg
   ├── plugin.manifest.json
   ├── dist/bundle.js
   └── dist/bundle.js.sha256
   ```
   If `--out <path>` is provided, write to that path. Otherwise, write to the current directory.

9. Print a summary:
   ```
   Packed: com.acme.salesforce-connector-1.0.0.oppkg (142 KB)
   Bundle: dist/bundle.js (138 KB)
   Checksum: 3a7b9f...
   Signed: No
   ```

### op plugin validate

```
op plugin validate <path-to.oppkg>
```

Validates a packed plugin without installing it. Intended for CI pipelines.

**Checks performed:**

1. File structure: verify the tarball contains exactly `plugin.manifest.json`, `dist/bundle.js`, and `dist/bundle.js.sha256`.
2. Manifest schema: run `PluginManifestSchema.safeParse()`.
3. Checksum integrity: compute SHA-256 of `dist/bundle.js`, compare against `manifest.bundleChecksum`.
4. GPG signature: if a `.sig` file is present, verify against the `manifest.gpgFingerprint` key (requires GPG keyring configured on the machine running validate).
5. Entrypoint check: import `dist/bundle.js` in a sandboxed `vm.Script` context and verify that `bundle[manifest.entrypoint]` exists and is callable.
6. Metadata check: call `bundle[manifest.entrypoint].metadata()` and verify the returned object has a `type` field matching `manifest.type`.

**Exit codes:**
- 0: all checks pass
- 1: one or more checks failed (errors printed to stderr as structured JSON)

---

## 13. Testing Utilities

Defined in `src/testing/`. Exported at `@oneplatform/plugin-sdk/testing`. These utilities are intended for use in plugin test suites only.

### createMockContext()

```typescript
/**
 * Configuration for the mock context. All fields are optional.
 * Unspecified fields get sensible test defaults.
 */
export interface MockContextOptions {
  tenantId?: string;
  tenantName?: string;
  instanceId?: string;
  config?: Record<string, unknown>;

  /**
   * Map of credential name → value. When context.credentials.get("name") is called
   * and "name" exists in this map, the mock returns the value immediately.
   * When "name" does not exist, the mock throws PluginAuthError.
   */
  credentials?: Record<string, string>;

  /**
   * If true, context.fetch() calls are passed through to the actual network.
   * Default: false (fetch is intercepted and returns 200 OK with an empty body).
   */
  allowRealFetch?: boolean;

  /**
   * Custom fetch handler. Called instead of real fetch when allowRealFetch is false.
   * Use to return mock API responses.
   */
  fetchHandler?: (url: string, init?: RequestInit) => Promise<Response>;

  /**
   * Ontology schema to return from context.ontology.getSchema().
   * Default: empty schema with no entity types.
   */
  ontologySchema?: OntologySchema;
}

/**
 * Create a mock PluginContext for use in unit tests.
 * The mock context is fully in-process — no Redis, no database, no network.
 *
 * @example
 * const ctx = createMockContext({
 *   credentials: { apiKey: "test-key-123" },
 *   config: { baseUrl: "https://api.example.com" },
 * });
 */
export function createMockContext(options: MockContextOptions = {}): PluginContext;
```

### Mock Context Behavior

**credentials:** Returns values from the `credentials` map. Throws `PluginAuthError` for unknown credential names (matches production behavior). Tracks `get()` calls — test code can verify that credentials were accessed correctly:

```typescript
const ctx = createMockContext({ credentials: { apiKey: "secret" } });
await myPlugin.connect({}, ctx);
expect(ctx.credentials.__calls).toContainEqual({ name: "apiKey" });
```

**fetch:** By default, returns `new Response("{}", { status: 200 })` for all URLs without making any network call. When `fetchHandler` is provided, delegates to that function. When `allowRealFetch: true`, calls the real `globalThis.fetch`. Tracks all outbound URL calls:

```typescript
expect(ctx.fetch.__calls).toContainEqual({
  url: "https://api.example.com/orders",
  init: { method: "GET" },
});
```

**cache:** An in-process `Map`. Each `createMockContext()` call creates a fresh map. The `lock()` method always succeeds in tests (returns a mock `LockHandle` that no-ops on `release()`).

**logger:** Collects all log calls in an array accessible at `ctx.logger.__logs`:
```typescript
expect(ctx.logger.__logs).toContainEqual({
  level: "warn",
  message: expect.stringContaining("deprecated"),
});
```

**tracing:** `startSpan()` returns a mock `SpanHandle` that records `setAttribute` calls and `end()` invocations. `injectHeaders()` returns the headers with a synthetic `traceparent` appended.

### assertValidPlugin()

```typescript
/**
 * Assert that a plugin object conforms to its declared interface.
 * Throws a descriptive error if required methods are missing or have wrong arity.
 * Use in tests to catch interface violations before pack time.
 */
export function assertValidPlugin(
  plugin: unknown,
  expectedType: "connector" | "transformer" | "destination" | "auth-provider" | "widget"
): void;
```

### assertValidMetadata()

```typescript
/**
 * Assert that a metadata object is valid for its type.
 * Verifies required fields are present and have correct types.
 */
export function assertValidMetadata(metadata: unknown): void;
```

---

## 14. Security Design

### Credential Isolation

The `CredentialAccessor` interface provides access only to credentials explicitly declared in `manifest.requiredCredentials`. The platform constructs a concrete `CredentialAccessor` that is bound to the current plugin instance — it cannot enumerate credentials from other plugin instances or tenants. The credential values are decrypted inside the Execution Service's request handling layer and passed to the sandbox as a sealed closure. Plugin code inside `isolated-vm` can call `credentials.get()` but cannot access the decryption key or the underlying encrypted store.

### Fetch Allowlist Enforcement

The `FetchProxy` implementation inside the Execution Service enforces the URL allowlist at two levels:

1. **Per-component hostname matching (not prefix matching).** A manifest declaring `https://api.shopify.com/**` does NOT permit requests to `https://api.shopify.com.attacker.com/` or `https://evil.api.shopify.com/`. Hostname matching requires an exact string match on the parsed hostname component.

2. **Internal URL blocking unconditional.** URLs matching the pattern `http://*-service:*` (internal Docker network service URLs) are blocked regardless of what the manifest declares. This block is applied before allowlist lookup — no manifest can whitelist internal service URLs.

### Sandbox Boundary

Plugin code runs inside `isolated-vm`. The sandbox provides:
- No access to `process`, `require`, `fs`, `net`, or any Node.js built-ins.
- No access to `globalThis.__op_internal` or any platform-internal symbols.
- Memory limit: 512MB.
- CPU timeout: 30 seconds per invocation (connectors: configurable, default 5 minutes per `fetchBatch` call).

The `PluginContext` object passed into the sandbox is a frozen proxy that delegates calls to the host (Node.js process outside the sandbox) via `isolated-vm`'s `ExternalCopy` and `Reference` mechanisms. Plugin code cannot inspect the proxy's closure or access any other host-side state through it.

### Error Taxonomy Security Implication

Plugin errors that propagate to API responses (via the Pipeline Service and Gateway) are sanitized: only the `code`, `isRetryable`, and `message` fields are forwarded. The `details` field is never included in API responses — it is logged internally and attached to the execution trace for debugging. This prevents plugins from leaking internal data (such as partial API responses) to API clients via error messages.

### Manifest Integrity

When the Plugin Service loads a plugin bundle for execution, it recomputes the SHA-256 of the bundle and compares against `manifest.bundleChecksum`. A mismatch results in a `PluginIntegrityError` and the execution is refused. This check happens on every load, not just at install time, to detect storage corruption or tampering after installation.

---

## 15. Dependency Policy

### Root Export (`@oneplatform/plugin-sdk`)

The root export path must have **zero runtime dependencies**. It may import:
- Other files within `packages/plugin-sdk/src/types/` and `packages/plugin-sdk/src/types/errors.ts`.
- Nothing else.

The `PluginError` class hierarchy is the only runtime code in the root export. All other exports from the root path are TypeScript `interface` and `type` declarations, which emit zero JavaScript.

This constraint is verified at build time: if `dist/index.js` (after compilation) imports any module other than the compiled error class file, the build fails.

### Manifest Export (`@oneplatform/plugin-sdk/manifest`)

Permitted dependency: `zod ^3.x`. Zod is a production dependency of this export path, listed in `package.json` under `dependencies`. The Plugin Service and CLI import this path and must have Zod available.

### Testing Export (`@oneplatform/plugin-sdk/testing`)

Permitted dependencies: `vitest ^1.x` (peer dependency, not bundled). The testing utilities use Vitest's `expect` internals for the `__calls` and `__logs` tracking — but do not import Vitest directly. The testing utilities are compatible with any test runner.

### Plugin Project Dependencies

Plugin projects should declare `@oneplatform/plugin-sdk` as a `devDependency`. At pack time, the `--external:@oneplatform/plugin-sdk` esbuild flag ensures the SDK does not appear in the bundle. The Execution Service provides the SDK's runtime exports (specifically the error classes) to the plugin sandbox at execution time.

---

## 16. Testing Strategy

### SDK Self-Tests

The SDK's own test suite lives in `packages/plugin-sdk/src/__tests__/`. Coverage targets:

| Module | What to Test |
|--------|--------------|
| `src/types/errors.ts` | Class hierarchy, `instanceof` chain, `isRetryable` values, prototype preservation across `super()` calls |
| `src/manifest/schema.ts` | Valid manifests parse cleanly; invalid manifests produce errors on the correct `path`; edge cases (GPG fingerprint format, SemVer ranges, URL patterns) |
| `src/testing/mock-context.ts` | `createMockContext()` default behavior; credential lookup success/failure; fetch interception; cache operations; lock/release lifecycle; logger capture |
| `src/dev/simulate-hook.ts` | Happy path with a known-good hook function; error propagation for hook functions that throw typed errors; stage routing |
| `src/dev/pack.ts` | Bundle creation produces correct file layout; checksum is reproducible; manifest checksum is written back correctly; `--external:@oneplatform/plugin-sdk` is applied |

### Plugin Author Testing Pattern

Plugin authors write unit tests that import from `@oneplatform/plugin-sdk/testing`. The recommended pattern:

```typescript
// Test: connector happy path
it("fetches first batch", async () => {
  const ctx = createMockContext({
    credentials: { apiKey: "test-key" },
    config: { baseUrl: "https://api.example.com" },
    fetchHandler: async (url) => {
      if (url.includes("/orders")) {
        return new Response(
          JSON.stringify({ orders: [{ id: "1", name: "Order 1" }], nextPage: null }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("Not Found", { status: 404 });
    },
  });

  const handle = await MyConnector.connect({ baseUrl: "https://api.example.com" }, ctx);
  const result = await MyConnector.fetchBatch(handle, undefined, ctx);

  expect(result.hasMore).toBe(false);
  expect(result.records).toHaveLength(1);
  expect(result.records[0]?.sourceId).toBe("1");
});
```

### Integration Test with simulate-hook

For hook plugins, integration tests can use `simulate-hook` programmatically:

```typescript
import { simulateHook } from "@oneplatform/plugin-sdk/testing";

it("modifies the payload", async () => {
  const result = await simulateHook({
    bundlePath: "./dist/bundle.js",
    stage: "before:ingestion.receive",
    entrypoint: "onBeforeIngestionReceive",
    payload: { data: { name: "Alice", email: "ALICE@EXAMPLE.COM" } },
    contextOptions: { config: { normalizeEmail: true } },
  });

  expect(result.data["email"]).toBe("alice@example.com");
});
```

### Type-Level Testing

The SDK's TypeScript interfaces are tested at the type level using `tsd` (TypeScript type testing library). Type tests verify that:
- A `Connector` implementation satisfies the `Connector` interface.
- An object missing a required method does not satisfy the interface.
- The `PluginContext` injection pattern compiles without errors.
- Error subclasses satisfy `instanceof PluginError`.

---

## 17. package.json and Build Configuration

### package.json

```json
{
  "name": "@oneplatform/plugin-sdk",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    },
    "./manifest": {
      "import": "./dist/manifest/schema.js",
      "types": "./dist/manifest/schema.d.ts"
    },
    "./testing": {
      "import": "./dist/testing/index.js",
      "types": "./dist/testing/index.d.ts"
    }
  },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "files": ["dist"],
  "scripts": {
    "build": "tsc --project tsconfig.json",
    "dev": "tsc --project tsconfig.json --watch",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:types": "tsd",
    "lint": "tsc --noEmit",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "tsd": "^0.31.0",
    "typescript": "^5.5.0",
    "vitest": "^1.6.0"
  },
  "peerDependencies": {
    "typescript": "^5.5.0"
  }
}
```

Note: `zod` is listed as a production `dependency` (not `devDependency`) because the `./manifest` export path requires it at runtime. However, plugin bundles never include it — they use `--external:@oneplatform/plugin-sdk` during pack, and the manifest export is never imported by plugin code.

### tsconfig.json

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "declaration": true,
    "declarationMap": true,
    "composite": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

The monorepo `tsconfig.base.json` sets:
- `"target": "ES2022"`, `"module": "NodeNext"`, `"strict": true`
- `"exactOptionalPropertyTypes": true`, `"noUncheckedIndexedAccess": true`
- `"noImplicitOverride": true`

These strict settings apply to the SDK and to plugin projects that extend the base config. Plugin projects are encouraged (but not required) to use the same `tsconfig.base.json`.

---

## 18. Decision Log

### D1: Zero Runtime Dependencies in Root Export

**Decision:** The root export path (`@oneplatform/plugin-sdk`) imports no runtime dependencies.

**Rationale:** Plugin bundles run inside `isolated-vm` with 512MB memory and a 30s timeout. Any library bundled into the plugin consumes that budget. Keeping the SDK types-only means plugin authors pay only for what their own code needs.

**Alternative considered:** Providing a full PluginContext mock implementation in the root export (so plugin authors can import it for quick prototyping). Rejected: this would pull in either an in-process Redis client (for the real cache implementation) or a mock library, both of which increase bundle size unnecessarily.

### D2: Error Classes as Runtime Code

**Decision:** `PluginError` and its five subclasses are runtime JavaScript classes, not just TypeScript interfaces.

**Rationale:** The Execution Service uses `instanceof PluginError` to distinguish plugin-thrown errors from unexpected exceptions. `instanceof` only works when both sides reference the same constructor. Because the Execution Service imports the SDK directly, and because the plugin bundle uses `--external:@oneplatform/plugin-sdk` (so the error classes are NOT bundled into the plugin), both sides resolve to the same constructors. If error classes were types only, the Execution Service would fall back to duck typing on the `code` field — fragile and easy to accidentally spoof.

**Alternative considered:** Using a `[Symbol.toStringTag]` or `__type` discriminant property instead of `instanceof`. Rejected: `instanceof` is idiomatic TypeScript error handling and requires no additional convention documentation.

### D3: Zod in the Manifest Export Only

**Decision:** Zod is a dependency of the `./manifest` export path, not the root path.

**Rationale:** The manifest schema is used at pack time (CLI) and install time (Plugin Service), never inside a plugin bundle. Separating it to its own export path keeps the dependency graph clean: plugin code never transitively imports Zod.

**Trade-off:** Plugin authors who want to validate their manifest in tests must explicitly import `@oneplatform/plugin-sdk/manifest` rather than importing from the root. This is acceptable — validating the manifest is a deliberate, specific act.

### D4: simulate-hook Uses vm.Script by Default, isolated-vm Optionally

**Decision:** Local development simulation uses Node.js `vm.Script` by default and `isolated-vm` via `--sandbox` flag.

**Rationale:** `isolated-vm` adds ~200ms cold-start per invocation due to V8 isolate creation. For tight dev loops with many rapid test invocations, this overhead is unacceptable. `vm.Script` provides adequate isolation for local development (the developer trusts their own code). `--sandbox` mode provides production-accurate validation when the developer is ready to verify sandbox compatibility before submitting.

**Alternative considered:** Always using `isolated-vm` for simulate-hook. Rejected: it makes the development loop noticeably slower and provides no safety benefit since the developer is executing their own code locally.

### D5: --external:@oneplatform/plugin-sdk in esbuild

**Decision:** The `op plugin pack` command always passes `--external:@oneplatform/plugin-sdk` to esbuild.

**Rationale:** The SDK's error classes must be the same constructors in both the plugin and the Execution Service for `instanceof` to work. If the error classes were bundled into the plugin, the Execution Service would see two different `PluginAuthError` constructors (one from the plugin bundle, one from the Execution Service's own import), breaking `instanceof` checks. The Execution Service provides the SDK's runtime exports via an import injection before executing the plugin bundle.

**Implementation note:** The Execution Service injects a synthetic `@oneplatform/plugin-sdk` module into the plugin's execution context using `isolated-vm`'s module hook. This synthetic module exports the same error classes the Execution Service itself imports. This mechanism is defined in the Execution Service design, not in the SDK — the SDK's only obligation is to compile cleanly with the `--external` flag.

### D6: Templates Embedded as Strings

**Decision:** Scaffold templates are embedded in `src/dev/scaffold.ts` as string constants, not read from template files.

**Rationale:** When the `op` CLI binary is compiled with `bun build --compile`, only the compiled JavaScript is included in the binary. Template files on disk would not be accessible unless they were embedded. Embedding them as string constants ensures the scaffold works identically from a compiled binary or from source.

**Trade-off:** Template updates require a code change and rebuild. Accepted: template updates are rare compared to other changes, and the simplicity of self-contained templates outweighs the marginal inconvenience.

### D7: TransformerContext Excludes credentials and fetch

**Decision:** `TransformerContext` does not include `credentials` or `fetch` properties, unlike the full `PluginContext`.

**Rationale:** Transformers are pipeline-step data operations — they transform records that the platform has already ingested. They should not make outbound network calls (that creates non-determinism and external dependencies in the pipeline) and do not need external credentials. This constraint is enforced by interface design: if a transformer needs external data, the correct pattern is to use a connector to bring that data into the platform first, then join in the transformer using cached ontology data.

**Alternative considered:** Providing the full `PluginContext` to transformers and documenting that `fetch` and `credentials` should not be used. Rejected: interface enforcement is stronger than documentation enforcement. Omitting the fields from the type makes accidental misuse a compile-time error.

---

*Document version: 1.0*
*Corresponds to: L1 Design §8 (Plugin System), ADR-31, ADR-32, ADR-33, ADR-34*
