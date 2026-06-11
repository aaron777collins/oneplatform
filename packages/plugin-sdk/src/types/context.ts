/**
 * PluginContext and all sub-interfaces.
 * The platform constructs a concrete implementation of PluginContext and injects it
 * as the second argument to every plugin method. Plugin code must never construct
 * PluginContext directly.
 */

// ────────────────────────────────────────────────────────────────────────────
// Ontology sub-types (declared before PluginContext to satisfy forward-ref rules)
// ────────────────────────────────────────────────────────────────────────────

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
  // Entity type name, present only when type === "reference"
  referenceTo?: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Tracing sub-types
// ────────────────────────────────────────────────────────────────────────────

export interface SpanHandle {
  setAttribute(key: string, value: string | number | boolean): void;
  end(): void;
}

// ────────────────────────────────────────────────────────────────────────────
// Cache sub-types
// ────────────────────────────────────────────────────────────────────────────

export interface LockHandle {
  release(): Promise<void>;
}

// ────────────────────────────────────────────────────────────────────────────
// Sub-interfaces of PluginContext
// ────────────────────────────────────────────────────────────────────────────

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

// ────────────────────────────────────────────────────────────────────────────
// Root PluginContext
// ────────────────────────────────────────────────────────────────────────────

export interface PluginContext {
  credentials: CredentialAccessor;
  fetch: FetchProxy;
  cache: CacheAccessor;
  logger: PluginLogger;
  tenant: TenantContext;
  ontology: OntologyAccessor;
  tracing: TracingContext;
}
