# OnePlatform — Architecture Decision Record (Expanded)
# ADR 30–36: Developer Surfaces, Plugin System, and Supporting Infrastructure

**Date:** 2026-06-10
**Status:** Approved
**Relates to:** `001-architecture-decisions.md` (ADR 1–23)
**Purpose:** These seven decisions resolve the critical-gap friction points identified in `docs/USER-STORIES-ANALYSIS.md`. They fill the user-facing surfaces left underspecified by the first 23 decisions: the outbound event system, the plugin interface contracts, plugin packaging and lifecycle, CLI design, SDK architecture, and supporting infrastructure. Every decision here is consistent with and extends ADR 1–23 — it does not contradict or replace any prior decision.

---

## ADR-30: Outbound Event System

### Decision

OnePlatform implements a complete, durable, push-based event notification system. External consumers — CI/CD pipelines, Airflow, Slack bots, mobile apps, third-party webhooks — are notified of platform events through two complementary transports: HTTP webhooks (for server-to-server integrations requiring guaranteed delivery) and Server-Sent Events (for browser and long-lived connection clients). WebSocket access for bidirectional real-time communication is scoped exclusively to the App Service BFF for platform-hosted apps.

The event system is treated as a first-class API surface with a canonical event schema, a versioned event catalog, HMAC-SHA256 payload signing, exponential backoff retry with dead-letter, SSE replay via `Last-Event-ID`, and a test-send facility.

### Rationale

The platform can receive webhooks (inbound) but produces no outbound notifications. This is the #1 integration blocker identified in the friction analysis (API-C01). Every external integration pattern — triggering a downstream Airflow DAG when a pipeline completes, notifying Slack when ingestion fails, pushing mobile alerts on data events — requires the platform to push events. The current architecture provides only pull-based access (polling REST APIs), which is insufficient for event-driven integrations and imposes unacceptable latency for real-time use cases.

HTTP webhooks provide guaranteed at-least-once delivery through BullMQ and are appropriate for server-to-server integrations that can handle retries. SSE provides a lower-latency streaming path for clients maintaining persistent connections and is the correct transport for browser-based event feeds. Both transports use the same event catalog and schema, ensuring a single source of truth for event contracts.

Redis pub/sub (already present in the architecture per Decision 5) provides the internal fan-out backbone without adding new infrastructure. The Gateway Service — already the external boundary — owns webhook delivery, closing the loop with its existing BullMQ and Redis access.

### Implementation

#### Event Schema (Canonical)

Every event emitted by OnePlatform, regardless of transport, conforms to this envelope:

```typescript
interface PlatformEvent {
  eventId: string;           // UUIDv4, globally unique per event emission
  eventType: string;         // Hierarchical dotted string, e.g., "pipeline.completed"
  eventVersion: string;      // Schema version for this event type, e.g., "1.0"
  tenantId: string;          // UUIDv4, tenant that owns the resource
  timestamp: string;         // ISO 8601 UTC, e.g., "2026-06-10T14:30:00.000Z"
  actor: {
    type: "user" | "service" | "system";
    id: string;              // userId for "user", service name for "service", "system" for "system"
    displayName?: string;    // Human-readable label for audit/display
  };
  data: Record<string, unknown>; // Event-specific payload (see catalog below)
}
```

The `eventId` ensures idempotent webhook delivery — consumers that receive a duplicate delivery (retry after a non-acknowledged success) can discard by `eventId`. All event types are immutable once emitted; schema evolution increments `eventVersion`.

#### Event Catalog

The following event types are the complete catalog for v1. Each entry lists its `eventType` string and the fields in `data`.

**Data Events** (emitted by Ontology/Ingestion Services on record mutations):
- `data.created` — `{entityType, entityId, record: {...}}`
- `data.updated` — `{entityType, entityId, previousRecord: {...}, record: {...}, changedFields: string[]}`
- `data.deleted` — `{entityType, entityId}`
- `data.bulk_imported` — `{entityType, count, jobId}`

**Pipeline Events** (emitted by Pipeline Service):
- `pipeline.started` — `{pipelineId, runId, triggeredBy: "manual"|"schedule"|"event"}`
- `pipeline.step.completed` — `{pipelineId, runId, stepId, stepName, durationMs, outputRows}`
- `pipeline.completed` — `{pipelineId, runId, durationMs, outputRows}`
- `pipeline.failed` — `{pipelineId, runId, stepId?, error: {code, message}}`
- `pipeline.cancelled` — `{pipelineId, runId, cancelledBy: actorId}`

**Ingestion Events** (emitted by Ingestion Service):
- `ingestion.started` — `{connectorId, jobId, source}`
- `ingestion.completed` — `{connectorId, jobId, rowsIngested, durationMs}`
- `ingestion.failed` — `{connectorId, jobId, error: {code, message}}`

**Ontology Events** (emitted by Ontology Service):
- `ontology.schema.changed` — `{entityType, previousVersion, newVersion, changeType: "addField"|"removeField"|"addEntity"|"removeEntity"|"other"}`
- `ontology.migration.started` — `{entityType, fromVersion, toVersion, estimatedRows}`
- `ontology.migration.completed` — `{entityType, fromVersion, toVersion, migratedRows, durationMs}`
- `ontology.migration.failed` — `{entityType, fromVersion, toVersion, error: {code, message}}`

**App Events** (emitted by App Service):
- `app.build.started` — `{appId, appSlug, version}`
- `app.build.completed` — `{appId, appSlug, version, durationMs}`
- `app.build.failed` — `{appId, appSlug, version, error: {code, message}}`
- `app.deployed` — `{appId, appSlug, version, previousVersion?}`
- `app.crashed` — `{appId, appSlug, version, error: {code, message}}`
- `app.rolled_back` — `{appId, appSlug, fromVersion, toVersion}`

**Plugin Events** (emitted by Plugin Service):
- `plugin.installed` — `{pluginId, pluginName, version, installedBy: actorId}`
- `plugin.enabled` — `{pluginId, pluginName, tenantId, enabledBy: actorId}`
- `plugin.disabled` — `{pluginId, pluginName, tenantId, disabledBy: actorId}`
- `plugin.uninstalled` — `{pluginId, pluginName, uninstalledBy: actorId}`

**Auth Events** (emitted by Auth Service):
- `auth.user.created` — `{userId, email, roles}`
- `auth.user.deactivated` — `{userId, email, deactivatedBy: actorId}`
- `auth.key.created` — `{keyId, keyName, scopes, expiresAt?}`
- `auth.key.revoked` — `{keyId, keyName, revokedBy: actorId}`

**System Events** (emitted by Gateway Service health monitor):
- `system.health.degraded` — `{service, reason, severity: "warning"|"critical"}`
- `system.health.recovered` — `{service, durationMs}`

**DLQ Events** (emitted by Gateway Service DLQ watcher):
- `dlq.job.added` — `{queue, jobId, originalPayload, error: {code, message}, attemptCount}`

#### Internal Fan-Out Architecture

Each service that emits events publishes to a Redis pub/sub channel `events:{tenantId}:{eventType}` using the `@oneplatform/core` event publisher helper. This is non-blocking: the service publishes and continues; it does not wait for subscribers to process.

The Gateway Service is the single subscriber to all event channels (`PSUBSCRIBE events:*`). On receiving a published event, the Gateway Service:

1. Writes the raw event to a BullMQ queue `outbound-webhooks` (DB 0, per Decision 5 key-prefix ACL: `~webhook:*`).
2. The BullMQ worker in the Gateway Service processes the queue and fans out to all registered webhooks whose `events` filter matches the `eventType`.
3. Simultaneously, the Gateway Service appends the event to a per-tenant in-memory ring buffer (capacity: 1000 events per tenant, LRU eviction) used for SSE replay.

**Why Gateway Service owns delivery:** The Gateway Service already has BullMQ access, is the external boundary, owns rate limiting, and is the appropriate service for outbound HTTP. Adding webhook delivery to the Gateway avoids adding a new service or giving another service external HTTP access. The service RBAC matrix (Decision 19) does not change — no new inter-service calls are introduced.

**Redis ACL update:** The Gateway Service's Redis ACL must be extended to include: `~webhook:* &events:*` (key prefix for webhook delivery queues and pub/sub channel subscription for events). This extends the existing Gateway ACL from Decision 5 (`~ratelimit:* ~gateway:*`).

#### Webhook Registration API

```
POST   /api/v1/webhooks/outbound
GET    /api/v1/webhooks/outbound
GET    /api/v1/webhooks/outbound/{id}
PUT    /api/v1/webhooks/outbound/{id}
DELETE /api/v1/webhooks/outbound/{id}
POST   /api/v1/webhooks/outbound/{id}/test
GET    /api/v1/webhooks/outbound/{id}/deliveries
```

**Registration request body:**
```typescript
interface WebhookRegistrationRequest {
  url: string;               // HTTPS required in production (HTTP allowed if OP_ALLOW_INSECURE_WEBHOOKS=true)
  events: string[];          // Event type patterns, supports "*" suffix wildcard, e.g., "pipeline.*"
  secret?: string;           // If omitted, a 32-byte random secret is generated and returned once
  description?: string;
  enabled?: boolean;         // Default true
  headers?: Record<string, string>; // Custom headers to include in deliveries (for auth tokens)
}
```

**Registration response:**
```typescript
interface WebhookRegistration {
  id: string;
  url: string;
  events: string[];
  secret: string;            // Returned ONLY on creation; never returned again (stored as bcrypt hash)
  description?: string;
  enabled: boolean;
  tenantId: string;
  createdAt: string;
  updatedAt: string;
  stats: {
    totalDeliveries: number;
    successfulDeliveries: number;
    failedDeliveries: number;
    lastDeliveryAt?: string;
    lastDeliveryStatus?: "success" | "failed";
  };
}
```

The webhook secret is stored as a bcrypt hash in Postgres (`gateway.webhooks` table). The raw secret is returned once on creation and never retrievable again — same pattern as API keys (Decision 7).

**URL validation:** On registration, the Gateway Service performs a connectivity check by sending a synthetic `POST` to the URL with a JSON body `{"test": true, "eventType": "webhook.registered"}`. If the URL returns anything other than a 2xx within 5 seconds, the registration fails with a descriptive error. The user must fix the endpoint before registration succeeds. This prevents accumulating dead webhooks silently.

**SSRF Prevention:** Before any connectivity check or delivery, the Gateway validates the webhook URL against:
1. Protocol MUST be HTTPS (HTTP allowed only when `OP_WEBHOOK_ALLOW_HTTP=true`, intended for local dev only)
2. Hostname MUST NOT resolve to a private IP range: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
3. Hostname MUST NOT resolve to loopback: 127.0.0.0/8, ::1
4. Hostname MUST NOT resolve to link-local: 169.254.0.0/16 (blocks AWS/GCP metadata endpoints)
5. Hostname MUST NOT resolve to Docker internal networks: container names and Docker DNS are rejected
6. DNS resolution is performed by the Gateway and the resolved IP is checked — not just the hostname string (prevents DNS rebinding)
7. These checks apply to BOTH registration validation AND delivery — the IP is re-resolved and re-checked on every delivery attempt to prevent post-registration DNS changes

**Pattern matching:** The `events` array supports exact strings (`"pipeline.completed"`) and prefix wildcards (`"pipeline.*"`, `"data.*"`). The `"*"` alone subscribes to all events. Pattern matching uses a trie at delivery time for O(1) lookup across large event catalogs.

#### Delivery Mechanism and Guarantees

Delivery is at-least-once. The Gateway Service BullMQ worker sends HTTP POST requests to the registered URL with:

- Body: JSON-serialized `PlatformEvent`
- `Content-Type: application/json`
- `X-OnePlatform-Signature: sha256={hex-encoded HMAC-SHA256}`
- `X-OnePlatform-Event: {eventType}`
- `X-OnePlatform-Delivery: {deliveryId}` (UUIDv4, stable across retries — idempotency key)
- `X-OnePlatform-Timestamp: {timestamp}` (epoch seconds, for replay attack prevention)
- Any custom headers from registration

**HMAC-SHA256 signature:** computed over the raw JSON request body bytes using the webhook's secret. The consumer reconstructs the HMAC from the raw body and compares with the header value. The timestamp in `X-OnePlatform-Timestamp` should be checked by consumers to reject deliveries older than 5 minutes (replay protection).

**Success criteria:** any HTTP 2xx response within 30 seconds. All non-2xx responses and timeouts are failures.

**Retry schedule (exponential backoff):**

| Attempt | Delay | Cumulative time |
|---------|-------|-----------------|
| 1 | immediate | 0s |
| 2 | 1s | 1s |
| 3 | 5s | 6s |
| 4 | 30s | 36s |
| 5 | 2m | ~2m |
| 6 | 10m | ~12m |
| 7 | 1h | ~1h 12m |
| 8 | 6h | ~7h 12m |
| 9 | 24h | ~31h |

After attempt 9, the delivery is moved to the `webhook-delivery:dlq` BullMQ queue. A `dlq.job.added` event is emitted (which itself may trigger webhook deliveries to other endpoints — but NOT to the failed endpoint, preventing infinite loops). The failed delivery is also reflected in the webhook's stats.

**Recursive DLQ prevention:** `dlq.job.added` events are delivered to registered webhooks, but if the delivery itself fails and creates a DLQ entry, the resulting secondary `dlq.job.added` event is NOT delivered to any webhook. The Gateway Service marks DLQ events originating from webhook delivery failures with an internal `_isWebhookDlq: true` flag and excludes them from further webhook fan-out. This prevents unbounded amplification.

**Delivery log:** the last 100 deliveries per webhook are stored in Postgres (`gateway.webhook_deliveries` table) with: deliveryId, eventId, eventType, attempt, requestedAt, respondedAt, statusCode, responseBody (first 1KB), error. Retained for 7 days. Accessible via `GET /api/v1/webhooks/outbound/{id}/deliveries`.

**Backpressure:** if a webhook URL is consistently failing (5+ consecutive failures), the webhook is automatically throttled: delivery rate limited to 1 attempt per hour until a success is received. This prevents a dead endpoint from consuming disproportionate BullMQ workers. The webhook owner is notified via a `system.health.degraded` event on their OTHER registered webhooks (if any) or via the dashboard.

#### Test-Send API

```
POST /api/v1/webhooks/outbound/{id}/test
```

Request body (optional):
```typescript
interface TestSendRequest {
  eventType?: string;        // Defaults to "webhook.test"
  data?: Record<string, unknown>; // Custom payload for the test
}
```

Sends a real HTTP delivery (with signature, headers, retry on failure) using a synthetic event. Response:
```typescript
interface TestSendResponse {
  deliveryId: string;
  statusCode: number;
  latencyMs: number;
  success: boolean;
  error?: string;
}
```

The test-send does NOT retry on failure — it returns the immediate result synchronously (up to 30s timeout).

#### SSE Endpoint

```
GET /api/v1/events/stream
```

Query parameters:
- `events` — comma-separated event type patterns (same syntax as webhook `events` array)
- `Last-Event-ID` — optional; if provided, the stream replays all matching events buffered after this event ID before entering live mode

Authentication: standard Bearer token or API key. The connection is scoped to the authenticated user's tenant.

**Response format:** standard SSE text stream (`text/event-stream`). Each event is:
```
id: {eventId}
event: {eventType}
data: {JSON-serialized PlatformEvent}
retry: 5000

```

**Replay:** On connection with `Last-Event-ID`, the Gateway Service scans its in-memory ring buffer for the tenant, finds events after the provided `eventId`, and emits them in order before switching to live. If the `eventId` is not found in the buffer (too old), the stream starts from the current position and includes a synthetic `replay.overflow` event to notify the client that some events were missed.

**Multi-replica limitation:** The in-memory ring buffer is per-Gateway-instance. In multi-replica deployments, SSE reconnection with `Last-Event-ID` may miss events buffered by a different replica. When `replay.overflow` is received, the client should treat this as a potential gap and fall back to a full re-fetch of the subscribed entities. For guaranteed event delivery across replicas, use outbound webhooks (which are backed by BullMQ with persistent storage) instead of SSE.

**Backpressure:** if the client reads slower than events arrive (detected by write buffer growing beyond 512KB), the Gateway Service begins dropping non-critical events (DEBUG-level) while preserving critical events. If the write buffer exceeds 1MB, the connection is closed with a `4001 buffer overflow` close code and the client must reconnect with `Last-Event-ID`.

**Heartbeat:** the Gateway sends a `: keepalive` comment every 30 seconds on idle connections to prevent proxy timeout.

**Connection limits:** maximum 10 concurrent SSE connections per API key. Returns 429 with `Retry-After: 60` when exceeded.

#### WebSocket (App Service BFF Only)

WebSocket connections are available exclusively to platform-hosted apps via the App Service BFF. The App Service exposes `ws://{service}:{port}/apps/{slug}/ws` on the internal network. Browser apps never connect directly to the Gateway WebSocket — the App Service proxies all real-time subscriptions through its SSE connection to the Gateway, then broadcasts to connected browsers via WebSocket. This means:

1. The App Service maintains ONE SSE connection to the Gateway per active app (not per browser user).
2. The App Service fans out events to connected browsers via WebSocket.
3. Browser apps connect to `wss://{platform-host}/apps/{slug}/ws` (routed by Gateway to App Service).

This avoids multiplying SSE connections at the Gateway and keeps the security boundary at the App Service BFF.

---

## ADR-31: Plugin Interface Specifications

### Decision

All five plugin types (`Connector`, `Transformer`, `Destination`, `AuthProvider`, `Widget`) are defined as explicit TypeScript interfaces in `@oneplatform/plugin-sdk`. These interfaces are the contract between plugin authors and the platform. Built-in platform features (e.g., the built-in HTTP connector, the built-in JavaScript transformer) implement these same interfaces — there is no privileged internal API. Third-party plugins are fully interchangeable with built-in implementations.

All plugin code executes through the Execution Service sandbox (Decision 6, Decision 16). Plugin implementations never run in the Plugin Service process. The Plugin Service handles lifecycle management only; the Execution Service handles all code execution.

### Rationale

The friction analysis identified this as the most critical blocker for the plugin ecosystem (PLG-C01): without typed interfaces, no developer can write a conforming plugin. Every other plugin decision (packaging, lifecycle, distribution) depends on these interfaces existing first. The decision to make built-in features use the same interfaces as third-party plugins (from the project's SOLID principles) forces the interfaces to be practically sound — they are validated by the platform's own usage before any external developer touches them.

### Implementation

#### Injected Context APIs

Every plugin execution receives a `PluginContext` object as its second argument. This context provides controlled access to platform capabilities. Plugins CANNOT import platform internals — they can only use what is explicitly provided in the context.

```typescript
interface PluginContext {
  credentials: CredentialAccessor;
  fetch: FetchProxy;
  cache: CacheAccessor;
  logger: PluginLogger;
  tenant: TenantContext;
  ontology: OntologyAccessor;
  tracing: TracingContext;
}

interface CredentialAccessor {
  // Returns the decrypted credential value for a named credential bound to this plugin instance.
  // Credentials are bound at configuration time by a platform admin.
  // Throws PluginAuthError if credential not found or decryption fails.
  get(name: string): Promise<string>;
  // Returns a map of all credential names available to this plugin instance.
  list(): Promise<string[]>;
}

interface FetchProxy {
  // Proxied fetch. Only URLs declared in manifest.requiredExternalUrls are allowed.
  // Blocks all internal OnePlatform service URLs unconditionally.
  // Throws PluginAuthError if URL not in allowlist.
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

interface CacheAccessor {
  // Namespaced KV cache scoped to this plugin instance + tenant.
  // Keys from other plugin instances or tenants are never accessible.
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
  // For distributed locks (e.g., mutex around token refresh)
  lock(key: string, ttlSeconds: number): Promise<LockHandle | null>;
}

interface PluginLogger {
  debug(message: string, metadata?: Record<string, unknown>): void;
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, metadata?: Record<string, unknown>): void;
}

interface TenantContext {
  tenantId: string;
  tenantName: string;
  // Plugin instance configuration values (filled in by tenant admin at enable time).
  // Typed against the plugin's configSchema.
  config: Record<string, unknown>;
  instanceId: string;        // Unique ID for this plugin instance within the tenant
}

interface OntologyAccessor {
  // Read-only access to the tenant's current ontology schema.
  // Cannot mutate schema.
  getSchema(): Promise<OntologySchema>;
  getEntitySchema(entityType: string): Promise<EntitySchema | null>;
}

interface TracingContext {
  // Injects current trace context into outbound request headers.
  // Use with FetchProxy to propagate traces across plugin boundaries.
  injectHeaders(headers: Record<string, string>): Record<string, string>;
  // Creates a child span for a named operation.
  startSpan(name: string): SpanHandle;
}

interface LockHandle {
  release(): Promise<void>;
}

interface SpanHandle {
  setAttribute(key: string, value: string | number | boolean): void;
  end(): void;
}
```

#### Plugin Error Taxonomy

Plugin code MUST use these typed errors (exported from `@oneplatform/plugin-sdk`). The platform uses the error type to determine retry behavior, DLQ routing, and user-visible messaging.

```typescript
class PluginError extends Error {
  constructor(
    message: string,
    public readonly code: string,         // Machine-readable, e.g., "INVALID_CURSOR"
    public readonly isRetryable: boolean,
    public readonly details?: Record<string, unknown>
  ) { super(message); }
}

// External service returned 401 or 403. Retrying won't help without credential refresh.
class PluginAuthError extends PluginError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "PLUGIN_AUTH_ERROR", false, details);
  }
}

// External service returned 429. The platform uses the Retry-After header if present,
// else falls back to exponential backoff.
class PluginRateLimitError extends PluginError {
  constructor(message: string, public readonly retryAfterSeconds?: number) {
    super(message, "PLUGIN_RATE_LIMIT", true, { retryAfterSeconds });
  }
}

// Network timeout or the execution sandbox timeout was reached.
class PluginTimeoutError extends PluginError {
  constructor(message: string) {
    super(message, "PLUGIN_TIMEOUT", true);
  }
}

// The external service returned malformed, unexpected, or unprocessable data.
// Not retryable by default — human review needed.
class PluginDataError extends PluginError {
  constructor(message: string, public readonly sample?: unknown) {
    super(message, "PLUGIN_DATA_ERROR", false, { sample });
  }
}

// A required configuration field is missing or invalid.
// Thrown during connect() to surface misconfiguration before long-running work begins.
class PluginConfigError extends PluginError {
  constructor(message: string, public readonly field?: string) {
    super(message, "PLUGIN_CONFIG_ERROR", false, { field });
  }
}
```

#### Metadata Type Definitions

```typescript
// JSON Schema Draft 7 object (subset used for config/data schemas)
type JSONSchema = Record<string, unknown>;

interface BaseMetadata {
  id: string;                // Must match manifest.id
  name: string;              // Display name
  description: string;
  version: string;           // Must match manifest.version
  author: string;
  icon?: string;             // URL or data URI (shown in plugin marketplace UI)
  configSchema: JSONSchema;  // JSON Schema for tenant-admin configuration form
  tags?: string[];
}

interface ConnectorMetadata extends BaseMetadata {
  type: "connector";
  category: string;          // e.g., "crm", "ecommerce", "database", "file"
  outputSchema: JSONSchema;  // Shape of records this connector produces
  supportsIncremental: boolean;
  supportsRealtime: boolean;
  rateLimit?: {              // Advisory — informs ingestion scheduling
    requestsPerMinute: number;
    rowsPerSecond?: number;
  };
}

interface TransformerMetadata extends BaseMetadata {
  type: "transformer";
  inputSchema?: JSONSchema;  // If null, accepts any record shape
  outputSchema?: JSONSchema; // If null, output shape mirrors input shape
  idempotent: boolean;       // True if transform(transform(x)) == transform(x)
}

interface DestinationMetadata extends BaseMetadata {
  type: "destination";
  acceptedSchema?: JSONSchema;
  deliveryGuarantee: "at-most-once" | "at-least-once" | "exactly-once";
  supportsBulk: boolean;
  supportsStreaming: boolean;
}

interface AuthProviderMetadata extends BaseMetadata {
  type: "auth-provider";
  protocol: "oauth2" | "saml" | "oidc" | "ldap" | "custom";
  supportsTokenValidation: boolean;
  supportsTokenRefresh: boolean;
  scopes?: string[];         // OAuth scopes this provider supports
}

interface WidgetMetadata extends BaseMetadata {
  type: "widget";
  minWidth: number;          // Grid units
  minHeight: number;
  maxWidth?: number;
  maxHeight?: number;
  slots: WidgetSlotDeclaration[];
}

type WidgetSlot = "main" | "sidebar" | "header" | "footer" | "fullscreen";

interface WidgetSlotDeclaration {
  slot: WidgetSlot;
  defaultWidth: number;
  defaultHeight: number;
}

interface DataQuery {
  entityType: string;
  filter?: Record<string, unknown>;
  sort?: string;
  fields?: string[];
  limit?: number;
}

interface WidgetData {
  queryResults: Record<string, unknown[]>; // Keyed by entityType
  config: Record<string, unknown>;          // Widget's instance config
  user: { id: string; roles: string[] };
}
```

#### Connector Interface

The `Connector` interface represents an external data source. It is NOT a pipeline hook — it is a data source registered with the Ingestion Service (see ADR-33). The Ingestion Service calls the connector to fetch data; it does not participate in before/after pipeline hooks.

```typescript
interface ConnectorHandle {
  connectionId: string;      // Opaque identifier for this active connection
  metadata: Record<string, unknown>; // Connection-specific state (e.g., API base URL, auth token)
}

interface BatchResult {
  records: DataRecord[];
  nextCursor: string | null; // null = no more records; string = continue fetching from here
  hasMore: boolean;
  fetchedAt: string;         // ISO 8601
  estimatedTotal?: number;   // Advisory hint for progress UI
}

interface DataRecord {
  sourceId: string;          // The record's ID in the external system
  data: Record<string, unknown>;
  metadata?: {
    createdAt?: string;      // ISO 8601, from source system
    updatedAt?: string;
    deletedAt?: string;      // Non-null for soft-delete events
    checksum?: string;       // Content hash for change detection
  };
}

interface EventCallback {
  (event: DataRecord): Promise<void>;
}

interface Subscription {
  unsubscribe(): Promise<void>;
  isActive(): boolean;
}

interface Connector {
  metadata(): ConnectorMetadata;

  // Validate config/credentials and establish a connection.
  // Called once per ingestion job start.
  // Throws PluginConfigError for bad config, PluginAuthError for credential failures.
  connect(
    config: Record<string, unknown>,
    context: PluginContext
  ): Promise<ConnectorHandle>;

  // Fetch a batch of records starting after `cursor`.
  // cursor=undefined means fetch from the beginning.
  // Return nextCursor=null when all records fetched.
  fetchBatch(
    handle: ConnectorHandle,
    cursor: string | undefined,
    context: PluginContext
  ): Promise<BatchResult>;

  // Optional: subscribe to real-time change events from the external system.
  // Only implemented by connectors with supportsRealtime=true.
  // The callback receives individual change records as they arrive.
  subscribeToEvents?(
    handle: ConnectorHandle,
    callback: EventCallback,
    context: PluginContext
  ): Promise<Subscription>;

  // Clean up: close connections, release resources.
  // Called after fetchBatch returns hasMore=false, or on error cleanup.
  disconnect(handle: ConnectorHandle, context: PluginContext): Promise<void>;
}
```

#### Transformer Interface

```typescript
interface TransformerContext {
  tenant: TenantContext;
  logger: PluginLogger;
  ontology: OntologyAccessor;
  cache: CacheAccessor;
  tracing: TracingContext;
  pipelineRunId?: string;    // Set when transformer runs inside a pipeline
  stageId?: string;
}

interface Transformer {
  metadata(): TransformerMetadata;

  // Transform a single record. Return null to drop the record (filtered out).
  // Return the (possibly modified) record to pass it downstream.
  // Throws PluginDataError for unprocessable records.
  transform(
    record: DataRecord,
    context: TransformerContext
  ): Promise<DataRecord | null>;

  // Optional batch transform. If implemented, the platform uses this instead
  // of calling transform() N times for better performance.
  // Records in result must be in the same order as input (with null entries removed).
  transformBatch?(
    records: DataRecord[],
    context: TransformerContext
  ): Promise<DataRecord[]>;
}
```

#### Destination Interface

```typescript
interface MappedRecord {
  sourceId: string;
  entityType: string;        // Mapped ontology entity type
  data: Record<string, unknown>; // Ontology-typed, validated data
  operation: "upsert" | "delete";
}

interface WriteResult {
  written: number;
  failed: number;
  errors: Array<{ sourceId: string; error: string }>;
}

interface DestinationContext {
  tenant: TenantContext;
  logger: PluginLogger;
  cache: CacheAccessor;
  fetch: FetchProxy;
  tracing: TracingContext;
}

interface Destination {
  metadata(): DestinationMetadata;

  // Write a batch of mapped records to the destination.
  // Returns per-record results for error handling.
  write(
    records: MappedRecord[],
    context: DestinationContext
  ): Promise<WriteResult>;

  // Optional streaming write. The platform streams records through this method
  // for destinations supporting streaming (e.g., Kafka, Kinesis).
  writeStream?(
    stream: AsyncIterable<MappedRecord>,
    context: DestinationContext
  ): Promise<WriteResult>;
}
```

#### AuthProvider Interface

```typescript
interface AuthOptions {
  redirectUri: string;
  scopes?: string[];
  additionalParams?: Record<string, string>;
}

interface CallbackParams {
  code: string;
  error?: string;
  errorDescription?: string;
  // Note: `state` is NOT included here. The Auth Service validates the state parameter
  // (CSRF check) internally BEFORE invoking handleCallback. The plugin never sees the
  // raw state value, preventing accidental leakage or misuse.
  // samlResponse is handled via a separate internal flow before this callback is invoked.
}

interface AuthContext {
  tenant: TenantContext;
  logger: PluginLogger;
  cache: CacheAccessor;      // For storing PKCE verifiers, state, etc.
}

interface AuthResult {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;        // ISO 8601
  claims: Record<string, unknown>; // Raw claims from provider
  platformRoles: string[];   // Mapped to platform RBAC roles via mapClaimsToRoles()
  providerUserId: string;    // User's ID in the external provider
}

interface TokenValidation {
  valid: boolean;
  claims?: Record<string, unknown>;
  expiresAt?: string;
  error?: string;
}

interface TokenPair {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
}

interface AuthProvider {
  metadata(): AuthProviderMetadata;

  // Build the authorization URL that the browser navigates to.
  getAuthorizationUrl(state: string, options: AuthOptions): string;

  // Handle the OAuth callback / SAML assertion.
  // state validation (CSRF) is performed by the Auth Service before this is called.
  handleCallback(
    params: CallbackParams,
    context: AuthContext
  ): Promise<AuthResult>;

  // Optional: validate an access token with the provider.
  // Called on requests to verify token hasn't been revoked externally.
  validateToken?(
    token: string,
    context: AuthContext
  ): Promise<TokenValidation>;

  // Optional: exchange a refresh token for a new access token.
  refreshToken?(
    refreshToken: string,
    context: AuthContext
  ): Promise<TokenPair>;

  // Map provider claims to platform RBAC role names.
  // Called during login and on every token refresh to keep roles current.
  // Returns array of platform role names (e.g., ["tenant-admin", "developer"]).
  mapClaimsToRoles(claims: Record<string, unknown>): string[];
}
```

#### Widget Interface

Widgets render in a sandboxed `<iframe>` inside the platform dashboard. The Widget's `render()` method returns an HTML string that is served as the iframe content from a separate origin (`widgets.{platform-host}` or a path-based subdomain equivalent). Communication between the widget iframe and the platform shell uses `window.postMessage` with a strict origin whitelist.

```typescript
interface Widget {
  metadata(): WidgetMetadata;

  // Return a complete HTML document string.
  // This HTML is served as the iframe content.
  // Platform injects a <script> that provides the widget bridge API
  // (postMessage-based data access) before calling render.
  render(data: WidgetData): string;

  // Declare what data this widget needs. The platform pre-fetches this data
  // and passes it in WidgetData.queryResults before calling render().
  declareDataRequirements(): DataQuery[];

  // Which slot this widget can render in.
  declareSlot(): WidgetSlotDeclaration;
}
```

**Widget security model:** Widget iframes use a data URI with `sandbox="allow-scripts"` (no `allow-same-origin`). This creates a unique opaque origin for each iframe, preventing access to the parent dashboard's localStorage, cookies, or DOM regardless of routing configuration. The `postMessage` API works across origins. The CSP is injected via a `<meta>` tag in the data URI HTML. This approach requires no separate subdomain or DNS configuration and works with both path-based and subdomain routing.

Widget iframe CSP uses a per-render nonce: `script-src 'nonce-{random}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; frame-src 'none'`. The App Service generates a unique nonce for each widget render. Plugin widget `render()` output is sanitized by DOMPurify (server-side) which strips ALL `<script>` tags. The nonce is used only for the platform-injected bootstrap script (the `<script nonce="{nonce}">` that sets up the `postMessage` listener). No plugin-authored inline scripts are permitted. `'unsafe-inline'` for `style-src` only is retained because inline styles are a common widget rendering pattern and do not execute code.

#### Hook Stages

The complete list of pipeline hook stages. Hook points are `before:{stage}` and `after:{stage}` for each:

**Ingestion Service stages:**
- `ingestion.receive` — before/after a raw record arrives from a connector or webhook
- `ingestion.validate` — before/after schema validation against the staging schema
- `ingestion.enrich` — before/after record enrichment (e.g., geolocation lookup)
- `ingestion.stage` — before/after writing to the staging table

**Ontology Service stages:**
- `ontology.map` — before/after mapping a raw record to an ontology entity
- `ontology.normalize` — before/after field normalization (type casting, formatting)

**Pipeline Service stages:**
- `pipeline.trigger` — before/after a pipeline run is enqueued
- `pipeline.step` — before/after each pipeline step executes (parameterized: `before:pipeline.step:{stepId}`)
- `pipeline.complete` — before/after a pipeline run finishes

**Execution Service stages:**
- `execution.before` — before user code runs (e.g., inject additional context)
- `execution.after` — after user code runs (e.g., audit the output)

**Auth Service stages:**
- `auth.login` — before/after a user login attempt
- `auth.logout` — after a user logout
- `auth.token.issue` — before/after access token issuance

**App Service stages:**
- `app.request` — before/after an HTTP request to a platform app
- `app.build` — before/after an app build job starts

#### Hook Registration API

Plugins declare hooks in their manifest (see ADR-32). At enable time, the Plugin Service writes hook registrations to Postgres (`plugin.hooks` table). The Pipeline Service queries this table when resolving hook chains (via the Plugin Service API). Hooks are not registered via runtime API calls — they are manifest-declared and install-time registered.

```typescript
// Declared in plugin.manifest.json under the "hooks" key
interface HookDeclaration {
  stage: string;             // e.g., "before:ingestion.receive"
  criticality: "critical" | "advisory"; // Per Decision 16
  priority: number;          // Lower = earlier in chain. Default 100. Range 0–999.
  timeout?: number;          // Override the default 30s timeout for this hook (max 300s)
  entrypoint: string;        // Named export in bundle.js, e.g., "onBeforeIngestionReceive"
}
```

---

## ADR-32: Plugin Package Format and Distribution

### Decision

A plugin is distributed as a signed tarball (`.oppkg` file) containing exactly three files: `dist/bundle.js` (the compiled plugin code), `plugin.manifest.json` (the declarative metadata), and `dist/bundle.js.sha256` (the integrity checksum). The manifest is the single source of truth for plugin identity, capabilities, permissions, and external URL requirements. Code signing uses SHA-256 checksums for baseline integrity; optional GPG detached signatures are supported for elevated trust in organizational deployments.

### Rationale

The friction analysis identified three parallel blockers: no interface specifications (PLG-C01, resolved in ADR-31), no manifest schema (PLG-C02), and no package format (PLG-C03). The format decision flows directly from the interface decisions: once we know what a plugin declares (hooks, config schema, URL requirements), we can specify what the manifest must contain.

The single-bundle approach (esbuild output) makes the packaging format trivially reproducible — the build command is `op plugin pack` and outputs a deterministic artifact. This eliminates environment-specific dependency problems ("it works in node_modules but not in the platform"). A tarball (not a zip) is chosen for consistent cross-platform behavior and easy streaming extraction.

### Implementation

#### Package File Layout

```
{plugin-id}-{version}.oppkg    (gzip-compressed tar archive)
├── plugin.manifest.json
├── dist/
│   ├── bundle.js              (esbuild single-file output, ESM format)
│   └── bundle.js.sha256       (hex-encoded SHA-256 of bundle.js)
```

The `.oppkg` extension is a renamed `.tar.gz`. The Plugin Service's install endpoint accepts this file via multipart upload.

#### Manifest Schema

`plugin.manifest.json` must conform to this JSON Schema (below shown as TypeScript for readability):

```typescript
interface PluginManifest {
  // Manifest schema version. Currently "1".
  manifestVersion: "1";

  // Unique plugin identifier. Reverse-domain format recommended.
  // e.g., "com.example.shopify-connector"
  // Must be stable across versions — this is the plugin's identity key.
  id: string;

  // Human-readable display name.
  name: string;

  // SemVer version string.
  version: string;

  // One of the five plugin types.
  type: "connector" | "transformer" | "destination" | "auth-provider" | "widget";

  // Brief description (< 200 characters).
  description: string;

  // Plugin author (name or organization).
  author: string;

  // Contact/support URL.
  supportUrl?: string;

  // Homepage or documentation URL.
  homepageUrl?: string;

  // Icon: URL (https required) or data URI (PNG/SVG, max 64KB).
  icon?: string;

  // Minimum OnePlatform version required to run this plugin. SemVer range.
  minPlatformVersion: string;

  // The named export in dist/bundle.js that is the plugin class/object.
  entrypoint: string;

  // JSON Schema for the tenant-admin configuration form.
  // Required fields must have "required" in the schema.
  configSchema: JSONSchema;

  // Hook declarations (can be empty array for non-hook plugins).
  hooks: HookDeclaration[];

  // External URLs this plugin's FetchProxy is allowed to call.
  // Glob patterns supported: "https://api.shopify.com/**"
  // Platform internal URLs (http://*-service:*) cannot be declared here.
  // An admin must explicitly approve these on install.
  requiredExternalUrls: string[];
  // URL matching implementation: The FetchProxy parses each URL using the WHATWG URL
  // Standard before matching. Matching is done per-component: (1) protocol must match
  // exactly, (2) hostname must match exactly (no substring or prefix matching —
  // `api.shopify.com` does NOT match `api.shopify.com.attacker.com`), (3) path matching
  // uses glob patterns on path segments only. The glob `**` matches zero or more path
  // segments. Pattern `https://api.shopify.com/**` matches
  // `https://api.shopify.com/admin/orders` but NOT `https://api.shopify.com.evil.com/`
  // or `https://api.shopify.com:8443/`.

  // Platform API capabilities required by this plugin.
  // These map to PluginContext properties that will be non-null.
  requiredApis: Array<
    | "credentials"    // CredentialAccessor
    | "fetch"          // FetchProxy
    | "cache"          // CacheAccessor
    | "ontology"       // OntologyAccessor
    | "tracing"        // TracingContext
  >;

  // Named credentials this plugin requires. Displayed as input fields
  // to the admin when they configure the plugin.
  requiredCredentials: Array<{
    name: string;
    description: string;
    type: "secret" | "password" | "token" | "certificate";
    required: boolean;
  }>;

  // SHA-256 hex digest of dist/bundle.js.
  // Must match the contents of dist/bundle.js.sha256.
  bundleChecksum: string;

  // Optional: GPG fingerprint of the signing key (if GPG-signed).
  gpgFingerprint?: string;

  // Tags for discoverability in the plugin marketplace.
  tags?: string[];

  // License SPDX identifier. e.g., "MIT", "Apache-2.0", "BSL-1.1"
  license: string;

  // Changelog for this version.
  changelog?: string;
}
```

**JSON Schema validation:** The Plugin Service validates `plugin.manifest.json` against a compiled Zod schema on install. Any manifest that fails validation is rejected immediately with a structured error listing all failing fields.

#### Code Signing

**SHA-256 integrity (required):** The `bundleChecksum` in the manifest is the hex-encoded SHA-256 of `dist/bundle.js`. The Plugin Service verifies this on install and again on every load (before passing the bundle to the Execution Service). A mismatch means the bundle was tampered with after packaging and the plugin is rejected.

**GPG signature (optional, organizational deployments):** Plugin authors may sign the tarball with a GPG private key. The Platform Service accepts a detached `.sig` file uploaded alongside the `.oppkg` file. The `gpgFingerprint` in the manifest specifies which public key to use for verification. Platform admins configure trusted GPG fingerprints in the admin panel. If `gpgFingerprint` is set and no trusted key matches, the install fails. If `gpgFingerprint` is unset, no GPG verification is performed.

#### `op plugin pack` Command

```
op plugin pack [--out <path>] [--sign <gpg-key-id>]
```

The pack command:
1. Reads `plugin.manifest.json` from the current directory.
2. Runs `esbuild src/index.ts --bundle --format=esm --platform=node --outfile=dist/bundle.js`. The entry file must export the plugin's main class/object under the name declared in `manifest.entrypoint`.
3. Computes SHA-256 of `dist/bundle.js` and writes it to `dist/bundle.js.sha256`.
4. Updates `manifest.bundleChecksum` with the computed hash.
5. If `--sign <gpg-key-id>` provided, creates a GPG detached signature of the tarball and includes it.
6. Creates `{manifest.id}-{manifest.version}.oppkg` as a gzip-compressed tar archive.

The command validates the manifest schema before packing and aborts with descriptive errors on failure.

#### `op plugin validate` Command

```
op plugin validate <path-to.oppkg>
```

Validates a packed plugin without installing it:
- Extracts the tarball and verifies file structure.
- Validates `plugin.manifest.json` against the manifest schema.
- Verifies `bundleChecksum` against `dist/bundle.js`.
- Verifies GPG signature if present.
- Runs the plugin's `metadata()` method in a sandboxed Node.js worker (not the platform sandbox) to verify the entrypoint is callable and returns valid metadata.
- Reports all validation errors and warnings.

#### Outbound URL Allowlist and Admin Approval

On install, the Plugin Service presents the installing admin with:
1. A list of `requiredExternalUrls` from the manifest.
2. A list of `requiredApis` and their implications.
3. A list of `requiredCredentials` the admin must configure.

The admin must explicitly approve each external URL pattern before the install completes. Approved URL patterns are stored in `plugin.approved_urls` table (linked to the plugin installation record). The FetchProxy enforces these at execution time — URLs not in the approved list return `403 Forbidden` from the proxy.

If the plugin is updated to a new version with additional URL patterns, the admin is prompted to approve the new patterns before the upgrade completes.

#### Plugin Instance Model

A single plugin (identified by `id`) can have multiple active instances within a tenant. Each instance has its own configuration, credential bindings, and behavior. This supports use cases like two separate Salesforce connectors pointing to different Salesforce orgs, or two instances of an email transformer with different rules.

- **Platform-wide installation:** A plugin `.oppkg` is installed once at the platform level. The bundle and manifest are stored once.
- **Per-tenant instances:** Each tenant can enable the plugin zero or more times, creating an instance. Each instance has its own `configSchema`-validated configuration and its own credential bindings.
- **Instance isolation:** The `TenantContext.instanceId` in the sandbox context is unique per instance. Cache keys in `CacheAccessor` are namespaced by `{tenantId}:{instanceId}` — instances cannot read each other's cached state.

#### Per-Tenant vs Platform-Wide Plugins

- **Per-tenant (default):** Tenant admins can install plugins from the marketplace for their tenant only. These are only available to their tenant.
- **Platform-wide:** Platform admins can install a plugin as platform-wide, making it available to all tenants automatically (with per-tenant configuration still required). Platform-wide plugins are shown as "pre-installed" in the marketplace with "Configure" instead of "Install."

#### Registry Compatibility

The manifest format is designed for future plugin registry compatibility. The `id` field (reverse-domain, globally unique) serves as the registry slug. The `version` field is SemVer for registry dependency resolution. When a plugin registry is launched (roadmap), `op plugin install shopify-connector@1.2.0` will resolve to a registry lookup and download the `.oppkg` file — the installation flow is identical to local install.

---

## ADR-33: Plugin Lifecycle and Installation

### Decision

Plugin lifecycle is managed by the Plugin Service using a four-state model: `installed → enabled → disabled → uninstalled`. Installation is performed by platform admins; enabling, disabling, and configuration are performed by tenant admins. Code delivery to the Execution Service is on-demand via a cached internal API. Connector plugins register as data sources in the Ingestion Service — they are not pipeline hooks. Version upgrades use an atomic pointer swap with a 24-hour rollback window.

### Rationale

The friction analysis identified the plugin lifecycle as almost entirely unspecified (PLG-H01, PLG-M02, PLG-H12). The distinction between platform-level installation and tenant-level enabling is critical for multi-tenancy: a platform admin makes a plugin available; a tenant admin decides to use it. This mirrors the app store model (app store makes an app available; user installs it for their account). The separation prevents tenant admins from introducing arbitrary code into the platform without platform admin review.

Connector plugins as distinct data sources (not pipeline hooks) resolves PLG-C05 directly: a connector IS the ingestion source, not a modifier of an existing ingestion pipeline. The Ingestion Service owns the connector execution lifecycle; the Plugin Service only provides lifecycle management and code distribution.

### Implementation

#### State Machine

```
INSTALLED ──────────────────────────────────────────────── UNINSTALLED
    │                                                            ↑
    ▼                                                            │
ENABLED ──→ DISABLED ─────────────────────────────────────────→ ┘
    │             │
    ▼             ▼
 (active)    (draining, then idle)
```

**State transitions:**

- `INSTALLED → ENABLED`: Tenant admin calls `POST /api/v1/plugins/{id}/instances` with instance configuration. Validation runs the plugin's `metadata()` to confirm the entrypoint is callable. Event: `plugin.enabled`.
- `ENABLED → DISABLED`: Tenant admin calls `PUT /api/v1/plugins/{id}/instances/{instanceId}` with `{enabled: false}`. Graceful drain begins (see below). Event: `plugin.disabled`.
- `DISABLED → ENABLED`: Tenant admin re-enables. Event: `plugin.enabled`.
- `DISABLED → UNINSTALLED` (or `INSTALLED → UNINSTALLED`): Platform admin calls `DELETE /api/v1/plugins/{id}`. Uninstall guard runs (see below). Event: `plugin.uninstalled`. The `INSTALLED → UNINSTALLED` transition is only valid when no tenant instances of the plugin are in `ENABLED` state. If any instance is enabled, the uninstall fails with `PluginInUseError`. The admin must disable all instances first.
- `ENABLED → UNINSTALLED`: Not permitted directly. Tenant admin must disable first. Returns 422 with error `"Plugin must be disabled before uninstall."`

#### Installation Flow

```
op plugin install <source>
```

`<source>` accepts:
- Local path: `./my-plugin-1.0.0.oppkg`
- HTTPS URL: `https://example.com/releases/my-plugin-1.0.0.oppkg`
- (Future) Registry slug: `com.example.shopify-connector@1.2.0`

**Install steps:**
1. CLI downloads (if URL) or reads the `.oppkg` file.
2. CLI uploads to `POST /api/v1/plugins` as multipart form data.
3. Plugin Service validates the tarball structure, manifest schema, and bundle checksum.
4. Plugin Service verifies GPG signature if `gpgFingerprint` is present in manifest.
5. Plugin Service presents approval prompt (external URLs, APIs, credentials required) — CLI interactive mode shows this; `--yes` flag auto-approves with a warning logged to audit.
6. Admin approves. Plugin Service stores the manifest in `plugin.plugins` table (Postgres, Plugin Service schema) and uploads the bundle to MinIO bucket `plugin-bundles` at key `{pluginId}/{version}/bundle.js` (see ADR-36 for MinIO configuration). Postgres stores the S3 reference (`bucket + key`), not the bundle itself.
7. Plugin Service registers any declared hooks in `plugin.hooks` table (state: `inactive` until enabled).
8. Plugin Service emits `plugin.installed` event.
9. CLI returns the plugin's ID and installation summary.

**Idempotency:** Installing the same plugin ID + version twice returns the existing installation record with HTTP 200 (not 201). Installing a different version of the same plugin ID creates a new version record and sets it as `pending_activation` (not yet active — a separate upgrade step activates it).

#### Code Delivery to Execution Service

The Execution Service does NOT store plugin bundles. On every plugin hook execution, the Execution Service requests the bundle from the Plugin Service via an internal API:

```
GET /internal/plugins/{pluginId}/bundle?version={version}
```

The Plugin Service returns the bundle as a binary stream. The Execution Service caches bundles in an LRU cache keyed by `{pluginId}:{version}`:
- Maximum cache size: 100 bundles (configurable via `OP_EXECUTION_PLUGIN_CACHE_SIZE`)
- TTL: 1 hour (on disable, Plugin Service sends a cache invalidation via Redis pub/sub `events:plugin:cache-invalidate:{pluginId}:{version}`)
- On cache miss: fetch from Plugin Service (P99 target: < 50ms on local Docker network)

**Cache invalidation on disable:** When a plugin instance is disabled, the Plugin Service sends `POST /internal/execution/plugin-cache-invalidate` with `{pluginId, version}` to the Execution Service (same HTTP-based communication pattern as the drain notification — the Execution Service has NO Redis access per Decision 5). The Execution Service removes the entry from its in-memory LRU cache. New executions after invalidation will find a miss, re-fetch from the Plugin Service, and re-cache.

#### Connector Plugin Registration

Connector plugins are registered as data sources with the Ingestion Service when enabled (not as pipeline hooks). The Plugin Service calls:

```
POST /internal/ingestion/connectors
{
  "pluginId": "com.example.shopify-connector",
  "instanceId": "abc-123",
  "tenantId": "tenant-xyz",
  "displayName": "My Shopify Store",
  "metadata": { ...ConnectorMetadata... }
}
```

The Ingestion Service stores this as an available connector. When the tenant creates a data source from this connector, the Ingestion Service calls:

```
POST /internal/execution/connector-run
{
  "connectorPluginId": "com.example.shopify-connector",
  "instanceId": "abc-123",
  "jobId": "job-456",
  "cursor": "...",
  "config": { ...tenant config... }
}
```

The Execution Service executes `connector.connect()` then iterates `connector.fetchBatch()` in the sandbox. Results are returned to the Ingestion Service in batches via streaming response.

**Connector timeout:** Connector runs use a configurable timeout separate from the 30-second hook timeout. Default: 5 minutes. Configurable per-connector in the Ingestion Service configuration: `OP_CONNECTOR_TIMEOUT_SECONDS` (global default, default 300) and per-connector override in the connector instance config. A full historical sync of a large database may run for hours — this is handled by splitting the work across multiple `fetchBatch` calls (each with its own timeout), not a single call with an extended timeout.

#### Graceful Disable

When a plugin instance is disabled:
1. Plugin Service marks the instance `DISABLING` in Postgres.
2. Plugin Service sends `POST /internal/execution/plugin-drain` with `{instanceId, graceSeconds: 60}` to the Execution Service. The Execution Service stores the draining state in an in-memory `Map<string, {drainingUntil: number}>`. Before dispatching any hook execution, the Execution Service checks the in-memory draining map. On a draining entry, new hook executions for this instance return `PLUGIN_DISABLED` immediately (fail-open: the chain continues without the hook's result, as if the hook were advisory). In-flight executions are allowed to complete. After the grace period expires, the entry is removed from the map. This avoids any Redis dependency for the Execution Service, consistent with Decision 5.
3. In-flight hook executions are given up to 60 seconds to complete. The Pipeline Service polls the Plugin Service every 5 seconds for `{pipelineRunId}` completion.
4. After 60 seconds (or all in-flight executions complete, whichever is first), Plugin Service marks the instance `DISABLED` and emits `plugin.disabled` event.

**Edge case — execution after 60s grace:** If a hook execution is still running after 60 seconds, it is allowed to complete naturally (isolated-vm will kill it at its own 30s timeout). The instance is marked DISABLED regardless. The orphaned result is discarded.

#### Uninstall Guard

Before completing uninstall:
1. **Active jobs check:** Query BullMQ for any jobs in `execution-queue` with `pluginId` in their metadata. If any are in `active` or `waiting` state, return 422: `"Cannot uninstall: {n} active jobs reference this plugin."`
2. **Data orphan warning:** Query ontology data tables for any records with `_ingested_by = {pluginId}`. If records exist, return a structured warning in the response with `count` and ask for `--confirm-orphan` flag. The data is NOT deleted automatically — the user must manually handle it. Uninstall proceeds with the flag.
3. **Hook cleanup:** Plugin Service removes all `plugin.hooks` entries for this plugin. The Pipeline Service hook chain resolution automatically excludes them on next load.
4. **Connector deregistration:** Plugin Service calls `DELETE /internal/ingestion/connectors/{instanceId}` on the Ingestion Service to remove the connector registration.
5. **Bundle cleanup:** Plugin Service marks the bundle as `UNINSTALLED` but retains the files on disk for 7 days before physical deletion. This allows debugging post-uninstall failures.

#### Version Upgrade

```
op plugin install ./my-plugin-2.0.0.oppkg  # Same plugin ID, new version
```

Install validates and stores the new version bundle but does NOT activate it. The current version remains active. Activation is explicit:

```
op plugin upgrade <plugin-id> --to 2.0.0 [--at "2026-06-15T02:00:00Z"]
```

The `--at` flag schedules a delayed activation. Without it, activation is immediate.

**Atomic swap procedure:**
1. Mark old version as `DRAINING` (same 60-second grace as disable).
2. Register new version hooks with `state: 'staged'` (not active). This prevents the new hooks from being dispatched before the pointer swap, eliminating the double-execution window.
3. Publish cache invalidation for old version to Execution Service.
4. Execution Service pre-fetches new version bundle (warm cache before cutover).
5. After grace period, in the same transaction as the pointer swap: update all new version hooks from `state: 'staged'` to `state: 'active'` and mark old version hooks as `state: 'disabled'`. Swap `active_version` pointer in `plugin.plugins` table atomically (single UPDATE). These three operations are committed together so hooks go live at exactly the same moment the pointer moves.
6. Old version moved to `DISABLED` state, retained for 24 hours for rollback.
7. Emit `plugin.upgraded` event.

**Rollback window:** For 24 hours after upgrade, `op plugin rollback <plugin-id>` reverses the swap atomically. After 24 hours, the old version bundle is eligible for physical deletion (runs as a scheduled cleanup job).

#### Service RBAC Matrix Additions

The following entries are added to `@oneplatform/core/service-rbac.ts` (extending Decision 19):

| Caller | Target | Allowed Endpoints |
|--------|--------|------------------|
| Ingestion Service | Plugin Service | `GET /internal/plugins/connectors` (list enabled connectors for tenant) |
| Ingestion Service | Execution Service | `POST /internal/execution/connector-run` (run connector plugin) |
| Plugin Service | Execution Service | `POST /internal/execution/run` (validate plugin entrypoint on install) |
| Plugin Service | Execution Service | `POST /internal/execution/plugin-drain` (signal graceful drain for a plugin instance) |
| Plugin Service | Execution Service | `POST /internal/execution/plugin-cache-invalidate` (invalidate cached bundle on disable/update) |
| App Service | Plugin Service | `GET /internal/plugins/widgets` (list enabled widget plugins for tenant) |
| Execution Service | Plugin Service | `GET /internal/plugins/{pluginId}/bundle` (fetch plugin bundle) |

---

## ADR-34: CLI Design Specification

### Decision

The `op` CLI (`@oneplatform/cli`) is a complete command-line interface for every platform operation. It is API-first: every command is a thin wrapper around the REST API with no privileged access. It distributes as a standalone binary compiled with `bun build --compile` (no Node.js runtime required) and as an npm package. Credentials are stored encrypted at `~/.config/oneplatform/credentials.json` with system keychain integration via `keytar`. Multi-profile support handles dev/staging/production environments. Output format auto-detects tty vs pipe.

### Rationale

The friction analysis identified CLI credential storage (API-C05), multi-profile support (API-H02), command completeness, and standalone binary distribution (API-H08) as high-priority gaps. A CLI that requires Node.js is a significant adoption barrier for DevOps engineers on minimal CI images. A CLI that stores credentials in plaintext is a security liability. A CLI without multi-profile support forces manual credential switching for engineers managing multiple environments.

The decision to compile via `bun build --compile` rather than `pkg` or `nexe` is driven by the existing Bun usage in the monorepo (Turborepo + Bun workspaces) and Bun's native binary compilation producing single-file executables with no external runtime dependency.

### Implementation

#### Complete Command Reference

**`auth` — Authentication and credential management:**
- `op auth login [--platform <url>] [--key <api-key>]` — Interactive login or API key setup
- `op auth logout` — Clear current profile's credentials
- `op auth status` — Show current authentication state
- `op auth whoami` — Print current user info (id, email, roles, tenant)
- `op auth generate-key --name <name> --scopes <scopes> [--expires <date>]` — Create API key
- `op auth list-keys` — List all API keys for current user
- `op auth revoke-key <key-id>` — Revoke an API key
- `op auth rotate-key <key-id> [--overlap 1h]` — Create new key, revoke old after overlap period
- `op auth emergency-rotate` — Nuclear option: rotate JWT signing secret (invalidates ALL sessions)

**`profile` — Multi-environment profiles:**
- `op profile add <name> --platform <url> [--key <api-key>]` — Create a named profile
- `op profile list` — List all profiles
- `op profile use <name>` — Switch active profile
- `op profile remove <name>` — Delete a profile

**`user` — User management (requires `users:manage` scope):**
- `op user list [--tenant <id>]`
- `op user invite --email <email> --role <role>`
- `op user get <id>`
- `op user update <id> --role <role>`
- `op user deactivate <id>`
- `op user import --file <csv-path>` — Bulk invite from CSV

**`role` — Role management (requires `users:manage` scope):**
- `op role list`
- `op role create --name <name> --permissions <perm,...>`
- `op role assign <role-name> --user <user-id>`
- `op role remove <role-name> --user <user-id>`

**`ontology` — Schema management (requires `ontology:read` or `ontology:write`):**
- `op ontology list`
- `op ontology get <entity-type>`
- `op ontology create --file <schema.json>`
- `op ontology update <entity-type> --file <schema.json>`
- `op ontology delete <entity-type> [--confirm]`
- `op ontology validate --file <schema.json>`
- `op ontology diff <entity-type> --file <schema.json>` — Show diff between current and proposed schema
- `op ontology migrate <entity-type>` — Trigger schema migration after breaking change
- `op ontology migration-status <migration-id>`
- `op ontology migration-rollback <migration-id>`
- `op ontology export [--format yaml|json]` — Export all schemas
- `op ontology import --file <path> [--on-conflict fail|skip|overwrite]`

**`data` — Data CRUD (requires `data:read` or `data:write`):**
- `op data query <entity-type> [--filter '...'] [--sort '...'] [--limit N]`
- `op data get <entity-type> <id>`
- `op data create <entity-type> --file <data.json>`
- `op data update <entity-type> <id> --file <data.json>`
- `op data delete <entity-type> <id> [--confirm]`
- `op data import <entity-type> --file <path> [--format csv|json|jsonl]`
- `op data export <entity-type> [--filter '...'] [--format csv|json|jsonl]`

**`connector` — Data connector management (requires `pipelines:manage`):**
- `op connector list`
- `op connector create --plugin <plugin-id> --name <name> --config <config.json>`
- `op connector get <id>`
- `op connector update <id> --config <config.json>`
- `op connector delete <id> [--confirm]`
- `op connector test <id>` — Test connection
- `op connector trigger <id>` — Trigger a manual ingestion run

**`webhook-out` — Outbound webhook management (requires `admin` or service API key):**
- `op webhook-out list`
- `op webhook-out create --url <url> --events <event,...> [--secret <secret>]`
- `op webhook-out update <id> [--url <url>] [--events <event,...>] [--enabled true|false]`
- `op webhook-out delete <id> [--confirm]`
- `op webhook-out test <id> [--event-type <type>]`
- `op webhook-out logs <id> [--limit N]`

**`pipeline` — Pipeline management (requires `pipelines:read` or `pipelines:manage`):**
- `op pipeline list`
- `op pipeline get <id>`
- `op pipeline create --file <pipeline.yaml>`
- `op pipeline update <id> --file <pipeline.yaml>`
- `op pipeline delete <id> [--confirm]`
- `op pipeline trigger <id> [--input '{"key":"value"}']`
- `op pipeline runs <id> [--limit N] [--status running|completed|failed]`
- `op pipeline run-status <run-id>`
- `op pipeline run-cancel <run-id>`
- `op pipeline run-logs <run-id> [--follow] [--step <step-id>]`

**`schedule` — Cron schedule management (requires `pipelines:manage`):**
- `op schedule list`
- `op schedule create --pipeline <id> --cron "0 * * * *" [--name <name>]`
- `op schedule pause <id>`
- `op schedule resume <id>`
- `op schedule delete <id> [--confirm]`

**`dlq` — Dead-letter queue management (requires `admin`):**
- `op dlq list [--queue <queue>] [--limit N]`
- `op dlq replay <job-id>`
- `op dlq discard <job-id> [--confirm]`

**`exec` — Direct code execution (requires `execution:run`):**
- `op exec run --lang js|ts|python --file <code.js> [--input '{"key":"value"}']`
- `op exec history [--limit N]`
- `op exec logs <execution-id>`

**`app` — App management (requires `apps:read` or `apps:deploy`):**
- `op app list`
- `op app get <slug>`
- `op app create --name <name> [--template <template>]`
- `op app deploy <slug> [--file <path>] [--env production|preview]`
- `op app dev <slug> [--port 3100]` — Local dev server with hot reload against live platform
- `op app logs <slug> [--follow]`
- `op app delete <slug> [--confirm]`
- `op app env-set <slug> <key> <value>`
- `op app env-list <slug>`
- `op app rollback <slug> [--to <version>]`

**`plugin` — Plugin management (requires `plugins:manage` for admin operations):**
- `op plugin list` — List installed plugins
- `op plugin install <source>` — Install from local path, URL, or registry
- `op plugin enable <plugin-id> [--tenant <id>]` — Enable for a tenant
- `op plugin disable <plugin-id> [--tenant <id>]` — Disable for a tenant
- `op plugin uninstall <plugin-id> [--confirm]`
- `op plugin info <plugin-id>` — Show manifest and installation details
- `op plugin create` — Interactive scaffold a new plugin from template
- `op plugin pack [--out <path>] [--sign <gpg-key>]` — Package plugin for distribution
- `op plugin validate <path-to.oppkg>` — Validate plugin package
- `op plugin simulate-hook <stage> --plugin <plugin-id> --input <data.json>` — Test hook locally

**`logs` — Log management (requires `admin` or scoped access):**
- `op logs query [--service <name>] [--level debug|info|warn|error] [--from <date>] [--to <date>] [--trace-id <id>]`
- `op logs tail [--service <name>] [--level <level>]` — Follow live logs
- `op logs audit [--from <date>] [--to <date>] [--actor <user-id>]` — Audit trail
- `op logs export --from <date> --to <date> [--format jsonl|csv]`

**`config` — Platform configuration export/import (requires `admin`):**
- `op config export [--format yaml|json] [--include-credentials --passphrase <pass>]`
- `op config import --file <path> [--on-conflict fail|skip|overwrite|merge] [--dry-run]`
- `op config diff --file <path>` — Show what would change without importing
- `op config validate --file <path>`

**`status` — Platform health:**
- `op status` — Show health of all services and infrastructure
- `op status --watch` — Refresh every 5 seconds until Ctrl+C

**`service` — Service administration (requires `admin`):**
- `op service rotate-keys [--service <name>]` — Rotate inter-service signing keys (Decision 19)
- `op service health` — Detailed health check with response times

**`sdk` — SDK code generation:**
- `op sdk generate [--out <path>] [--lang typescript|python|go]` — Generate ontology-typed SDK for current tenant

**`version` — CLI version:**
- `op version` — Print CLI version, platform version, API version

**`completion` — Shell completion:**
- `op completion bash` — Print bash completion script
- `op completion zsh` — Print zsh completion script
- `op completion fish` — Print fish completion script

Total: ~95 commands across 20 groups.

#### Credential Storage

Credentials are stored at `~/.config/oneplatform/credentials.json`. The file stores per-profile credential objects:

```json
{
  "default": {
    "platformUrl": "https://my-instance.example.com",
    "apiKey": "encrypted:AES256GCM:...",
    "encryptedAt": "2026-06-10T14:00:00Z"
  },
  "staging": {
    "platformUrl": "https://staging.example.com",
    "apiKey": "encrypted:AES256GCM:..."
  }
}
```

**Encryption strategy:**
1. **Primary:** `keytar` (system keychain) — stores the AES-256-GCM encryption key in the OS keychain (macOS Keychain, GNOME Keyring, Windows Credential Manager). The `credentials.json` file stores only the encrypted ciphertext. Key: `oneplatform-cli:{profileName}`.
2. **Fallback:** If `keytar` is unavailable (headless servers, minimal Docker images), a machine-derived key is used: HKDF-SHA256 of the machine's `/etc/machine-id` (Linux) or `IOPlatformUUID` (macOS) or `MachineGuid` registry value (Windows). The credentials.json file includes `"keyDerivation": "machine-id"` to indicate fallback mode. On first use in fallback mode, the CLI prints a warning: `"WARNING: Credentials stored with machine-derived key. Transfer of credentials.json to another machine will fail. For better security, install libsecret to enable system keychain storage."`
3. **Env var override:** `OP_API_KEY` and `OP_PLATFORM_URL` environment variables bypass credential file entirely. Useful for CI pipelines.

**File permissions:** `credentials.json` is created with mode `600` (owner read/write only). The CLI verifies this on startup and warns (but does not block) if permissions are too permissive.

#### Multi-Profile Support

Profiles are stored at `~/.config/oneplatform/profiles/{name}.json`:

```json
{
  "name": "production",
  "platformUrl": "https://oneplatform.corp.example.com",
  "tenantId": "abc-123",
  "defaultOutput": "json",
  "timeout": 60
}
```

Active profile is tracked in `~/.config/oneplatform/config.json`:
```json
{ "activeProfile": "default" }
```

Profile precedence: `--profile <name>` flag > `OP_PROFILE` env var > `activeProfile` config.

#### Environment Variable Precedence

For every configuration value, the resolution order (highest to lowest priority):
1. Command-line flag (e.g., `--platform`, `--output`, `--timeout`)
2. `OP_*` environment variables (e.g., `OP_PLATFORM_URL`, `OP_API_KEY`, `OP_OUTPUT`, `OP_TIMEOUT`)
3. Active profile configuration (`~/.config/oneplatform/profiles/{activeProfile}.json`)
4. Default values

#### Output Formats

All commands support `--output json|table|tsv`. Auto-detection: if stdout is a TTY, default is `table`. If stdout is a pipe (non-TTY), default is `json`. This allows `op pipeline runs my-pipeline | jq '.[] | select(.status == "failed")'` to work without flags.

**JSON output:** standard Go-style compact JSON, one object per line for list commands (JSONL format for streaming-friendly parsing).
**Table output:** aligned columns with headers. Truncates long values at 60 chars with `...`.
**TSV output:** tab-separated, no headers. Useful for `awk` processing.

#### Non-Interactive Mode

For use in CI/CD:
- `--yes` / `-y`: automatically confirm all destructive operations without prompting.
- Non-TTY auto-detection: if stdin is not a TTY and `--yes` is not passed, destructive commands print to stderr: `"Run with --yes to confirm in non-interactive mode"` and exit 1.
- `--no-color`: disable ANSI color codes (auto-disabled when stdout is not a TTY).
- `--quiet` / `-q`: suppress all output except errors (useful for scripting where only exit code matters).

#### Rate Limit Handling

On HTTP 429 responses, the CLI:
1. Reads `Retry-After` header (seconds or HTTP date).
2. Prints to stderr: `"Rate limited by server. Retrying in {N}s..."` (suppressed with `--quiet`).
3. Sleeps and retries up to 3 times.
4. After 3 retries, exits with code `2` and error message.

#### Distribution

**Standalone binaries:** published to GitHub Releases on every tagged version:
- `op-linux-amd64` (Linux x86_64)
- `op-linux-arm64` (Linux ARM64, for Raspberry Pi / AWS Graviton CI)
- `op-darwin-arm64` (macOS Apple Silicon)
- `op-darwin-amd64` (macOS Intel)
- `op-windows-amd64.exe` (Windows x86_64)

Built via `bun build --compile --target {platform}`. Each binary is self-contained — no Node.js, no npm, no runtime dependency. SHA-256 checksums published alongside binaries.

**npm package:** `npm install -g @oneplatform/cli` (for Node.js environments and `npx @oneplatform/cli` one-off usage).

**CI version pinning recommendation:** documented in CI setup guide. Use the GitHub Release URL with explicit version: `https://github.com/oneplatform/oneplatform/releases/download/v{VERSION}/op-linux-amd64`. Do not use `latest` in CI — use pinned versions for reproducibility.

---

## ADR-35: SDK Architecture

### Decision

`@oneplatform/sdk` (external SDK) and `@oneplatform/app-sdk` (platform app SDK) are TypeScript packages with dual ESM/CJS module output. The base SDK types and client are generated from the OpenAPI 3.1 specification using `@hey-api/openapi-ts` with the Fetch client adapter. Ontology-typed access is provided by `op sdk generate`, which fetches the tenant's OpenAPI spec (including auto-generated entity routes) and produces a `oneplatform.gen.ts` file containing fully-typed client methods specific to that tenant's schema. The SDK auto-detects the runtime environment and selects the appropriate auth strategy.

### Rationale

The friction analysis identified API-C06 (ontology-typed SDK mechanism undefined) and API-M07/M08 (error classification and pagination iterator) as high-priority gaps. The generator approach (rather than runtime reflection) is chosen because:

1. **Type safety at compile time.** Generated TypeScript types mean TypeScript catches mismatches before runtime.
2. **Tree-shaking.** `@hey-api/openapi-ts` produces tree-shakeable output — unused entity clients are eliminated by bundlers.
3. **Single source of truth.** The OpenAPI spec (generated from Hono routes + Zod schemas, per Decision 23) is the authoritative contract. The SDK is derived from it, never drifting.
4. **No runtime overhead.** No reflection, no schema fetching at runtime, no dynamic proxy construction.

### Implementation

#### Module Format

Both packages use the dual-package pattern:

```json
// package.json
{
  "exports": {
    ".": {
      "import": "./dist/index.esm.js",   // ESM (tree-shakeable)
      "require": "./dist/index.cjs.js",  // CJS (Node.js require())
      "types": "./dist/index.d.ts"
    }
  },
  "main": "./dist/index.cjs.js",         // Legacy CJS entrypoint
  "module": "./dist/index.esm.js",       // Legacy ESM entrypoint (bundlers)
  "types": "./dist/index.d.ts"
}
```

Built via `tsup` (esbuild-powered, handles dual output natively). CJS and ESM outputs are always in sync.

#### SDK Client Construction

```typescript
import { createClient } from "@oneplatform/sdk";

const client = createClient({
  baseUrl: "https://oneplatform.example.com",
  // Auth: one of apiKey, accessToken, or auto (browser PKCE)
  auth: {
    apiKey: "op_live_abc123",
    // OR:
    accessToken: "eyJ...",
    // OR (browser): auto-detected, uses PKCE flow
  },
  // Optional: override retry policy
  retry?: RetryPolicy,
  // Optional: request timeout in ms (default 30000)
  timeout?: number,
});
```

**Runtime environment auto-detection:**
- If `typeof window !== "undefined"` (browser), `auth.apiKey` is forbidden (throws error). Browser clients MUST use `accessToken` or the automatic PKCE flow.
- If running in Node.js/Bun (server), all auth strategies are available.
- This enforces Decision 22's browser security requirement: API keys are server-side only.

#### Base SDK Structure (Generated from OpenAPI)

The base `@oneplatform/sdk` covers all static platform APIs:

```typescript
interface OnePlatformClient {
  // Authentication
  auth: AuthClient;
  // Data (generic, untyped — use generated SDK for typed access)
  data: DataClient;
  // Pipelines
  pipelines: PipelineClient;
  // Apps
  apps: AppClient;
  // Plugins
  plugins: PluginClient;
  // Webhooks
  webhooks: WebhookClient;
  // Users
  users: UserClient;
  // Ontology
  ontology: OntologyClient;
  // Logs
  logs: LogClient;
  // Execution
  execution: ExecutionClient;
  // Real-time event subscriptions
  events: EventsClient;
}
```

#### Ontology-Typed SDK Generation

```
op sdk generate [--out ./src/oneplatform.gen.ts] [--lang typescript]
```

This command:
1. Authenticates and fetches `GET /api/v1/openapi.json?tenant={tenantId}` — the tenant-specific OpenAPI spec that includes auto-generated entity routes (e.g., `/api/v1/data/products`, `/api/v1/data/orders`).
2. Runs `@hey-api/openapi-ts` with the Fetch client adapter, targeting the downloaded spec.
3. Produces `oneplatform.gen.ts` — a single file with typed client methods and TypeScript interfaces.

Example generated usage:

```typescript
import { createTypedClient } from "./oneplatform.gen";

const client = createTypedClient({ baseUrl: "...", auth: { apiKey: "..." } });

// Fully typed — Product type is inferred from ontology schema
const products = await client.data.Product.list({
  filter: { status: "active" },
  sort: "-createdAt",
  limit: 50,
});
// products: PaginatedResult<Product>

const order = await client.data.Order.get("order-123");
// order: Order | null

await client.data.Order.create({
  customerId: "cust-456",
  items: [{ productId: "prod-789", quantity: 2 }],
});
// TypeScript error if required fields are missing
```

The generated file is meant to be committed to the consuming project's repository. Run `op sdk generate` again when the ontology changes.

#### Error Taxonomy

```typescript
class OnePlatformError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly errorCode: string,    // Platform error code, e.g., "ENTITY_NOT_FOUND"
    public readonly requestId: string,    // For support correlation
    public readonly isRetryable: boolean,
    public readonly details?: Record<string, unknown>
  ) { super(message); }
}

// HTTP 4xx (excluding 429) — do not retry
class ClientError extends OnePlatformError {}

// HTTP 401/403 — authentication or authorization failure
class AuthError extends ClientError {}

// HTTP 404 — resource not found
class NotFoundError extends ClientError {}

// HTTP 422 — request was well-formed but semantically invalid
class ValidationError extends ClientError {
  constructor(
    message: string, requestId: string,
    public readonly fieldErrors: Record<string, string[]>
  ) { super(message, 422, "VALIDATION_ERROR", requestId, false); }
}

// HTTP 429 — rate limited; isRetryable = true
class RateLimitError extends OnePlatformError {
  constructor(
    message: string, requestId: string,
    public readonly retryAfterSeconds: number
  ) { super(message, 429, "RATE_LIMIT_EXCEEDED", requestId, true); }
}

// HTTP 5xx — server error; isRetryable = true
class ServerError extends OnePlatformError {}

// Network failure, DNS failure, or request timeout — isRetryable = true
class NetworkError extends OnePlatformError {}
```

Error detection: the SDK catches all non-2xx responses and instantiates the appropriate typed error class. All thrown errors are instances of `OnePlatformError` — callers can check `instanceof` for specific types or use `error.isRetryable` for generic retry logic.

#### Pagination

All list endpoints return paginated results. The SDK wraps this in an `AsyncIterable<Page<T>>`:

```typescript
interface Page<T> {
  items: T[];
  nextCursor: string | null;
  total?: number;            // Not always available — provider-dependent
  hasMore: boolean;
}

interface PaginatedResult<T> extends AsyncIterable<Page<T>> {
  // Convenience: collect ALL items across all pages into a single array.
  // If `maxItems` is provided, stops after collecting that many items.
  // If omitted, defaults to 10,000 items maximum — exceeding this throws
  // CollectionLimitError('Use async iteration for datasets larger than 10,000 items').
  // This prevents accidental memory exhaustion on large datasets.
  collect(maxItems?: number): Promise<T[]>;
  // Convenience: take first N items (fetches minimum necessary pages).
  take(n: number): Promise<T[]>;
}
```

Usage:

```typescript
// Iterate page by page
for await (const page of client.data.Product.list()) {
  console.log(`Processing ${page.items.length} products...`);
  await processBatch(page.items);
}

// Collect all (use only for small datasets)
const allProducts = await client.data.Product.list().collect();

// Take first 200 (fetches at most ceil(200/pageSize) pages)
const first200 = await client.data.Product.list().take(200);
```

**Default page size:** 50 items (matching the API default from ADR-29). Maximum: 100.

#### Auto-Retry Policy

```typescript
interface RetryPolicy {
  maxRetries: number;        // Default: 3
  retryableStatuses: number[]; // Default: [429, 500, 502, 503, 504]
  backoff: "exponential" | "linear" | "constant"; // Default: "exponential"
  baseDelay: number;         // Default: 1000ms
  maxDelay: number;          // Default: 30000ms
  jitter: boolean;           // Default: true (adds random 0-baseDelay ms to prevent thundering herd)
}
```

Default policy: up to 3 retries, exponential backoff starting at 1s, max 30s, with jitter, on statuses [429, 500, 502, 503, 504]. For 429 responses, the `Retry-After` header overrides the computed backoff delay.

Non-retryable errors (4xx except 429) are thrown immediately without retrying.

#### Real-Time Subscriptions

```typescript
interface SubscriptionOptions {
  events: string[];           // Event type patterns (same as webhook events array)
  filter?: Record<string, unknown>; // Event-specific filter (e.g., { entityType: "Product" })
  lastEventId?: string;       // Resume from this event ID (replay)
}

interface Subscription {
  unsubscribe(): void;
  get isActive(): boolean;
}

// Usage
const sub = client.events.subscribe(
  { events: ["data.created", "pipeline.*"], filter: { entityType: "Order" } },
  (event: PlatformEvent) => {
    console.log("Received:", event.eventType, event.data);
  }
);

// Stop listening
sub.unsubscribe();
```

**Implementation:** The `EventsClient` opens an SSE connection to `GET /api/v1/events/stream`. On disconnect, it automatically reconnects with `Last-Event-ID` set to the last received `eventId`. Reconnect uses exponential backoff (1s, 2s, 4s, max 30s). The `filter` option is serialized to query parameters.

**Browser PKCE integration:** In browser environments, `EventsClient` uses the access token from the OAuth session. Token refresh is handled automatically — when the access token expires (15 minutes per Decision 7), the SDK refreshes it before the SSE connection drops.

**SSE subscription multiplexing:** The `EventsClient` maintains one SSE connection per client instance. When a new subscription is added (`subscribe()` called while connected), the client CLOSES the current SSE connection and RECONNECTS with the updated `?events=...` filter that includes all active subscriptions. The server uses `Last-Event-ID` to replay missed events during the brief reconnection window. Subscription removal similarly reconnects with the reduced filter set. The reconnection is debounced (100ms) to batch multiple rapid subscribe/unsubscribe calls into a single reconnection. In Node.js, `EventsClient` uses the `eventsource` package (MIT) with keep-alive settings.

---

## ADR-36: Supporting Infrastructure

### Decision

This decision specifies six infrastructure components that were unspecified but required for a complete platform: API key scoping (least-privilege programmatic access), email delivery with a configurable fallback mode, a predefined role taxonomy, config export/import (the IaC use case), MinIO for S3-compatible object storage, CORS policy enforcement, and password reset/email verification flows.

### Rationale

Each of these was identified as a critical or high friction point: API key scoping (API-C04) violates least privilege by giving all programmatic clients full admin access. Email delivery (API-M02) is required for invitations, password resets, and verification but is entirely absent. Config export/import (API-C03) blocks the DevOps IaC use case. MinIO (APP-H06) is the missing destination for app build artifacts and file uploads — without it, app builds have nowhere to store their output. CORS (not identified explicitly) is a fundamental browser security requirement. Password reset (APP-H13) is table-stakes auth functionality.

### Implementation

#### API Key Scoping

API keys are scoped to a minimum-privilege set of permissions. Every key has an explicit `scopes` array that limits what it can do. The `admin` scope is the only way to access all operations.

**Defined scope values:**

| Scope | Grants access to |
|-------|-----------------|
| `data:read` | `GET /api/v1/data/**` |
| `data:write` | `POST /api/v1/data/**`, `PATCH /api/v1/data/**`, `DELETE /api/v1/data/**` |
| `ontology:read` | `GET /api/v1/ontology/**` |
| `ontology:write` | `POST /api/v1/ontology/**`, `PATCH /api/v1/ontology/**`, `DELETE /api/v1/ontology/**` |
| `pipelines:read` | `GET /api/v1/pipelines/**`, `GET /api/v1/pipeline-runs/**` |
| `pipelines:trigger` | `POST /api/v1/pipelines/{id}/trigger`, `POST /api/v1/pipelines/{id}/runs/{runId}/cancel` |
| `pipelines:manage` | All pipeline CRUD + trigger + cancel |
| `apps:read` | `GET /api/v1/apps/**` |
| `apps:deploy` | `POST /api/v1/apps/{slug}/deploy`, `POST /api/v1/apps/{slug}/rollback` |
| `apps:manage` | All app CRUD + deploy + rollback |
| `plugins:read` | `GET /api/v1/plugins/**` |
| `plugins:manage` | All plugin lifecycle operations |
| `users:read` | `GET /api/v1/users/**` |
| `users:manage` | All user and role management |
| `logs:read` | `GET /api/v1/logs/**` |
| `webhooks:manage` | All outbound webhook CRUD |
| `execution:run` | Direct code execution via sandbox (`POST /api/v1/exec/**`) |
| `admin` | All of the above (full platform access) |

**Key creation API:**

```
POST /api/v1/auth/keys
```

Request:
```typescript
interface CreateKeyRequest {
  name: string;
  scopes: string[];          // Must be a subset of valid scope values
  expiresAt?: string;        // ISO 8601. If omitted, key never expires.
  description?: string;
}
```

Response:
```typescript
interface ApiKeyResponse {
  id: string;
  name: string;
  key: string;               // Full key value — returned ONLY on creation (bcrypt-hashed in storage)
  keyPrefix: string;         // First 8 chars — displayed in key lists for identification
  scopes: string[];
  expiresAt?: string;
  description?: string;
  createdAt: string;
  lastUsedAt?: string;
}
```

**Key format:** `op_{env}_{32-char-random}`. Prefixes: `op_live_` (production), `op_test_` (test/staging). This allows accidental key commits to be detected by secret scanning tools (GitHub has a generic secret scanner pattern; we publish a custom pattern for `op_live_`).

**Scope enforcement:** The Gateway Service middleware validates the bearer token's scopes on every request. If the key does not have the required scope for the endpoint, the request is rejected with HTTP 403: `{"error": {"code": "INSUFFICIENT_SCOPE", "message": "This operation requires scope: {scope}.", "requestId": "..."}}`.

#### API Key Rotation

Key rotation is supported without interruption via an overlap period:

```
POST /api/v1/auth/keys/{id}/rotate
```

Request:
```typescript
interface RotateKeyRequest {
  overlapDuration?: string;  // ISO 8601 duration, e.g., "PT1H" (1 hour). Default: "PT1H".
  newScopes?: string[];      // If provided, new key gets different scopes. Default: same scopes.
  newName?: string;
  newExpiresAt?: string;
}
```

Response:
```typescript
interface RotateKeyResponse {
  newKey: ApiKeyResponse;    // New key (full key value returned once)
  oldKeyId: string;
  oldKeyExpiresAt: string;   // When the old key will be automatically revoked
}
```

**Rotation mechanics:** The old key remains valid for the overlap duration. After the overlap, the Auth Service automatically revokes it via a scheduled BullMQ job queued at rotation time. This allows the consumer to update their credential and verify it works before the old key stops working. Overlap durations from 0 (immediate) to 7 days are accepted.

**`op auth rotate-key` CLI command** wraps this API with interactive prompts confirming the key ID and overlap period.

#### Email Delivery

Email is required for:
- User invitations (link to set initial password)
- Password reset flows
- Email verification on registration
- Alert notifications (optional, for system health degraded events)

**SMTP configuration** (via environment variables):

| Variable | Description | Default |
|----------|-------------|---------|
| `OP_SMTP_HOST` | SMTP server hostname | (unset) |
| `OP_SMTP_PORT` | SMTP server port | `587` |
| `OP_SMTP_USER` | SMTP username | (unset) |
| `OP_SMTP_PASS` | SMTP password | (unset) |
| `OP_SMTP_FROM` | From address | `noreply@{OP_PLATFORM_HOST}` |
| `OP_SMTP_SECURE` | Use STARTTLS (`true`) or plaintext (`false`) | `true` |

If `OP_SMTP_HOST` is unset, the Auth Service operates in **link-copy mode**: instead of sending an email, the Auth Service generates a one-time link and:
1. Returns it in the API response body (for CLI usage).
2. Displays it in the admin dashboard under "Pending Invitations" or "Password Reset Requests."
3. The admin copies the link and sends it to the user via any out-of-band channel.

Link-copy mode is the default for self-hosted deployments where SMTP is not configured. It is explicitly documented as a first-class mode, not a workaround — many self-hosted deployments prefer not to configure outbound email.

**Email templates** are HTML with plain-text fallback, stored in the Auth Service's `templates/` directory. Templating uses Handlebars (MIT). Templates are customizable by overriding files in a mounted volume (`/app/templates`).

**Password Reset flow:**

```
POST /api/v1/auth/forgot-password
Body: { "email": "user@example.com" }
Response: 200 OK (always — never reveal whether email exists)
```

The Auth Service:
1. Looks up the user by email. If not found, silently returns success (prevents email enumeration).
2. Generates a password reset token: a signed JWT with `{ sub: userId, purpose: "password-reset", jti: uuid }`, expiry 1 hour.
3. Stores the `jti` in Redis with key `reset:{jti}` and value `1`, TTL 3600s.
4. Sends reset email (or records link in link-copy mode).

```
POST /api/v1/auth/reset-password/{token}
Body: { "newPassword": "...", "confirmPassword": "..." }
```

The Auth Service:
1. Validates JWT signature and expiry.
2. Checks Redis for `reset:{jti}` — if not found (already used or expired), returns 410 Gone.
3. Deletes `reset:{jti}` from Redis (single-use enforcement).
4. Updates password hash in `auth.users` table.
5. Revokes all existing refresh tokens for this user (forces re-login everywhere).

**Redis ACL update:** The Auth Service's Redis ACL must be extended to include `~reset:*` for password reset token storage, in addition to the existing `~auth:* ~revocation:*` prefixes from Decision 5.

**Email Verification:**

On registration (`POST /api/v1/auth/register`), if `OP_REQUIRE_EMAIL_VERIFICATION=true` (default: `false`):
1. User is created in `auth.users` with `emailVerified: false`.
2. Verification token generated (same JWT + Redis pattern as password reset, purpose: `"email-verify"`, TTL 24 hours).
3. Verification email sent (or link-copy mode).
4. Unverified users can authenticate but receive a reduced-privilege access token with a `unverified: true` claim.
5. The Gateway middleware downgrades unverified users to `viewer` role maximum and injects a `X-OnePlatform-Verify-Email: required` response header on every request.

**Bootstrap exception:** The admin user created via the bootstrap wizard (ADR-24) is automatically marked as `email_verified = true` regardless of the `OP_REQUIRE_EMAIL_VERIFICATION` setting. This prevents the platform admin from being locked into a reduced-privilege state on a system that may not yet have SMTP configured.

```
GET /api/v1/auth/verify-email/{token}
Response: 200 OK (redirects to platform with success banner)
```

#### Predefined Role Taxonomy

The platform ships with these built-in roles:

| Role Name | Scope | Permissions |
|-----------|-------|-------------|
| `platform-admin` | Global | Full access to all platform operations, all tenants, service administration |
| `tenant-admin` | Per-tenant | Full access within their tenant: all data, pipelines, apps, plugins, users |
| `developer` | Per-tenant | editor permissions + `apps:deploy` + `execution:run` (requires `execution:run` scope on API keys) + `plugins:read` |
| `editor` | Per-tenant | `data:write`, `ontology:read`, `pipelines:manage`, `apps:manage` (no deploy), `data:import` |
| `viewer` | Per-tenant | `data:read`, `ontology:read`, `pipelines:read`, `apps:read`, `logs:read` (own actions only) |

**Custom roles:** Tenant admins can create custom roles by composing permission primitives:

```
POST /api/v1/roles
Body: {
  "name": "data-reviewer",
  "permissions": ["data:read", "data:write", "ontology:read"],
  "description": "Can read and update data records but not manage pipelines or apps"
}
```

Custom role permissions are a subset of the full permission set. Platform-admin permissions cannot be delegated to custom roles within a tenant.

**RBAC enforcement:** The Auth Service embeds user roles and tenant ID in the JWT access token. The Gateway validates the token and enforces scope on every request. The ontology-aware RBAC (from Decision 7) extends this: entity-level permissions (e.g., `data:read:Product` but not `data:read:Order`) are stored in `auth.entity_permissions` and checked by the Ontology Service on data queries.

#### Config Export/Import

The config system provides declarative representation of all platform configuration for IaC and environment promotion.

**Export:**
```
GET /api/v1/config/export?format=yaml&include=ontologies,connectors,pipelines,apps,roles,webhooks
```

CLI:
```
op config export [--format yaml|json] [--include-credentials --passphrase <pass>] > config.yaml
```

**YAML format:** multiple YAML documents separated by `---`, one document per resource. Each document has a `kind` and `spec`:

```yaml
kind: Ontology
spec:
  name: Product
  version: 3
  fields:
    - name: sku
      type: string
      required: true
---
kind: Pipeline
spec:
  name: sync-products
  trigger:
    type: schedule
    cron: "0 * * * *"
  steps:
    - type: connector
      connector: com.example.shopify-connector
```

**Credentials:** by default, credentials are excluded from export. With `--include-credentials --passphrase <pass>`:
- Credential values are AES-256-GCM encrypted using a key derived from the passphrase.
- The encrypted values are embedded in the YAML as `"encrypted:{base64}"`.
- On import, the same passphrase must be provided to decrypt.
- This allows safe transmission of complete configs including credentials.

**Import:**
```
op config import --file config.yaml [--on-conflict fail|skip|overwrite|merge] [--dry-run]
```

**Topological sort on import:** Resources are imported in dependency order:
1. Roles (no dependencies)
2. Ontologies (no dependencies)
3. Connectors (depend on ontologies for schema mapping)
4. Pipelines (depend on connectors and ontologies)
5. Apps (depend on pipelines and ontologies)
6. Webhooks (depend on nothing, but listed last for clarity)

The importer builds a dependency graph and performs Kahn's algorithm topological sort before beginning import. Circular dependency detection reports an error before any writes occur.

**Conflict resolution modes:**

| Mode | Behavior when resource already exists |
|------|--------------------------------------|
| `fail` (default) | Abort the import, report the conflict |
| `skip` | Leave existing resource unchanged, continue importing others |
| `overwrite` | Replace the existing resource completely |
| `merge` | Deep-merge the spec (additive only — removes are not applied) |

**Dry-run:** `--dry-run` runs the full import process including dependency resolution, conflict detection, and validation — but does NOT write to the database. Output shows exactly what would be created, updated, or skipped.

**Idempotency:** Resources are identified by a stable key: `kind:spec.name` (e.g., `Ontology:Product`, `Pipeline:sync-products`). Internal database IDs are never used in config files. Importing the same config twice (with `--on-conflict skip`) is a no-op.

**`op config diff`:**
```
op config diff --file config.yaml
```
Shows what would change without importing. Output format mirrors `kubectl diff` — resources to be created are prefixed with `+`, modified with `~`, unchanged with ` `.

#### MinIO (S3-Compatible Object Storage)

MinIO is added to Docker Compose as the object storage backend. It provides S3-compatible API for storing binary artifacts that cannot go in Postgres.

```yaml
# docker-compose.yml addition
minio:
  image: minio/minio:RELEASE.2024-05-10T01-41-38Z  # Pinned version
  command: server /data --console-address ":9001"
  environment:
    MINIO_ROOT_USER: ${OP_MINIO_USER:-minioadmin}
    MINIO_ROOT_PASSWORD: ${OP_MINIO_PASSWORD}      # Required; no default
  volumes:
    - minio-data:/data
  ports:
    - "127.0.0.1:9000:9000"    # S3 API — loopback only (not exposed to public)
    - "127.0.0.1:9001:9001"    # MinIO Console — loopback only
  networks:
    - oneplatform-internal
  healthcheck:
    test: ["CMD", "curl", "-f", "http://localhost:9000/minio/health/live"]
    interval: 30s
    timeout: 10s
    retries: 3
```

**Bucket layout:**

| Bucket | Contents | Owner service | Retention |
|--------|----------|--------------|-----------|
| `app-builds` | Compiled app bundles (esbuild output) | App Service | Last 10 versions per app |
| `file-uploads` | User file uploads via ingestion | Ingestion Service | Configurable, default 30 days |
| `plugin-bundles` | Plugin `.oppkg` files | Plugin Service | Until uninstalled + 7 days |
| `config-exports` | Encrypted config export archives | Gateway Service | 24 hours (presigned URL) |

**Service access:** all services access MinIO using the S3-compatible SDK (`@aws-sdk/client-s3`, MIT licensed). The internal endpoint is `http://minio:9000`. Each service uses its own IAM-policy-scoped credentials (MinIO supports IAM policies for bucket-level access control). The Plugin Service can only write to `plugin-bundles`. The App Service can only write to `app-builds`. Postgres stores references (bucket + key) to MinIO objects — not the objects themselves.

**MinIO license note:** MinIO Server is licensed under AGPL-3.0. AGPL requires that modifications to MinIO itself be open-sourced. OnePlatform uses MinIO as unmodified infrastructure (not incorporated into OnePlatform's codebase) — the same relationship as using PostgreSQL or Redis. No OnePlatform code runs inside the MinIO process. AGPL does not apply to applications that merely use MinIO's S3 API over HTTP. However, organizations with strict AGPL aversion may substitute any S3-compatible storage:
- **On-premises alternative:** SeaweedFS (Apache 2.0) or GarageHQ (AGPL — same concern) or a bare Docker volume with the App Service's built-in file API.
- **Cloud alternative:** AWS S3, Cloudflare R2, Backblaze B2 (set `OP_S3_ENDPOINT` accordingly).

The `OP_S3_ENDPOINT`, `OP_S3_ACCESS_KEY`, `OP_S3_SECRET_KEY`, and `OP_S3_REGION` environment variables allow swapping MinIO for any S3-compatible service with no code changes.

#### CORS Policy

The Gateway Service enforces CORS headers on all responses.

**Configuration:**

| Variable | Description | Default |
|----------|-------------|---------|
| `OP_ALLOWED_ORIGINS` | Comma-separated list of allowed origins | `http://localhost:3000` (development) |
| `OP_ALLOWED_ORIGINS_PRODUCTION_WARNING` | `true` by default | `true` |

**Behavior:**
- Default: `OP_ALLOWED_ORIGINS=http://localhost:3000` (development). For production deployments, this MUST be explicitly set to the platform's domain. If `NODE_ENV=production` and `OP_ALLOWED_ORIGINS` is unset, the Gateway logs a CRITICAL warning and defaults to the value of `OP_BASE_URL` (single origin). Wildcard `*` is rejected in production.
- In development (`NODE_ENV=development`): all configured origins allowed. The Gateway logs a warning on startup if wildcard is used: `"CORS: Wildcard origin (*) is configured. This is insecure in production. Set OP_ALLOWED_ORIGINS to your specific domains."`
- In production: only the listed origins are allowed. Requests from unlisted origins receive a 403 with no CORS headers.

**Headers set by Gateway:**
```
Access-Control-Allow-Origin: {matching origin or first configured origin}
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Headers: Authorization, Content-Type, X-API-Key, X-Requested-With
Access-Control-Expose-Headers: X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, X-OnePlatform-Request-ID
Access-Control-Max-Age: 86400
Access-Control-Allow-Credentials: true  (only when a specific origin is configured, not wildcard)
```

**Preflight caching:** `Access-Control-Max-Age: 86400` caches preflight responses for 24 hours in modern browsers, reducing OPTIONS request overhead for API-heavy clients.

**App Service CORS:** Platform-hosted apps may need custom CORS settings (e.g., an app embedded in an external website). App deployments support an `cors` configuration in the app manifest:
```json
{
  "cors": {
    "allowedOrigins": ["https://external-site.example.com"]
  }
}
```
These app-specific CORS rules are enforced by the Gateway when routing to the App Service, with additional restriction: app-specific origins must be a subset of or equal to the platform's `OP_ALLOWED_ORIGINS`. An app cannot grant broader CORS access than the platform-wide policy.

---

## Consistency Notes (Cross-Reference with ADR 1–23)

The following cross-references confirm these new decisions extend rather than contradict the existing 23:

- **ADR-30** uses Redis pub/sub (Decision 5) and BullMQ (Decision 13) — no new infrastructure required.
- **ADR-30** adds Redis key prefix `webhook:*` for Gateway Service ACL (extends Decision 5's ACL table).
- **ADR-31** plugin interfaces execute through Execution Service sandbox (consistent with Decision 16's "all plugin hook code runs through the Execution Service sandbox").
- **ADR-31** hook stages extend Decision 16's hook point definitions (`before:{stage}`, `after:{stage}`).
- **ADR-32** plugin bundles stored on Docker volumes (consistent with Decision 3's self-hosted Docker Compose model).
- **ADR-33** service RBAC matrix additions are additive to the matrix in Decision 19 — no existing entries are modified.
- **ADR-33** connector timeout (5 minutes, configurable) is explicitly separate from the 30-second hook timeout (Decision 16).
- **ADR-34** CLI credentials encrypted with AES-256-GCM (same primitive as Decision 11's credential encryption).
- **ADR-34** `op auth emergency-rotate` maps to the emergency re-key mechanism in Decision 7.
- **ADR-35** SDK uses `@hey-api/openapi-ts` against the OpenAPI spec that is generated from Hono routes + Zod (consistent with Decision 22 and Decision 23).
- **ADR-35** browser SDK uses PKCE OAuth flow (consistent with Decision 22's browser security requirement).
- **ADR-36** password reset token stored in Redis with single-use enforcement (extends Decision 7's Redis auth patterns).
- **ADR-36** MinIO added to Docker Compose under `oneplatform-internal` network (consistent with Decision 10's network topology).
- **ADR-36** `OP_S3_ENDPOINT` abstraction allows MinIO swap without code changes (consistent with Decision 3's self-hosted-first design).
- **ADR-36** predefined roles are enforced at the Auth Service layer (consistent with Decision 7's ontology-aware RBAC).
