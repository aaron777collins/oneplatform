# Ingestion Service — L2 Service-Level Design

**Version:** 1.0  
**Date:** 2026-06-10  
**Status:** Approved for implementation  
**Authoritative ADRs:** ADR-11 (Secret Management), ADR-13 (Queue Reliability), ADR-17 (Logging), ADR-19 (Service Auth), ADR-21 (Observability), ADR-28 (End-to-End Data Flow), ADR-29 (API Contract Standard), ADR-31 (Plugin Interfaces), ADR-32 (Plugin Packages)

---

## 1. Service Overview

### Responsibility

The Ingestion Service is the sole entry point for all data entering OnePlatform. It owns:

- **Pull connectors** — scheduled or manual syncs from external sources (REST APIs, PostgreSQL, MySQL, CSV, files) via the `Connector` plugin interface
- **Push receivers** — inbound webhook endpoints and file uploads that external systems push data to
- **Credential vault** — AES-256-GCM encrypted storage of all connector credentials with per-credential HKDF-SHA256 key derivation
- **Raw data staging** — writes every ingested record to `ingestion.raw_{connectorId}` before any mapping occurs, enabling schema remapping without re-ingestion
- **Sync job orchestration** — BullMQ-backed scheduler for batch/incremental syncs with cursor atomicity, progress tracking, and backpressure management

The Ingestion Service does NOT perform ontology mapping. After staging raw data, it enqueues an `ontology:map` BullMQ job and returns. Mapping is the responsibility of the Ontology Service.

### Port and Network Placement

```
Port:    3002 (internal only)
Network: oneplatform-internal
         NOT on oneplatform-public — the Gateway is the external boundary
         NOT on oneplatform-sandbox
```

One exception: the webhook receive endpoint (`POST /api/v1/webhooks/inbound/{id}/receive`) is exposed externally but exclusively through the Gateway, which proxies the request. The Ingestion Service never has a public port.

### Startup Dependencies

Per the Docker Compose dependency chain (ADR-24):

```
op-init          condition: service_completed_successfully  (provides OP_MASTER_KEY)
postgres         condition: service_healthy                 (schema migrations)
redis            condition: service_healthy                 (BullMQ queues, sync progress)
auth-service     condition: service_healthy                 (service token validation)
minio            condition: service_healthy                 (file upload storage)
```

On startup the service performs exactly these steps in order:

1. Load `OP_MASTER_KEY` from `/data/init/master.key` via `loadMasterKey()` (packages/core/src/encryption.ts) — throws and aborts if absent
2. Load Ed25519 service private key from `/data/service.key` for service-to-service JWT signing
3. Run Drizzle ORM database migrations against the `ingestion` schema
4. Connect BullMQ workers for `ingestion:sync` and `ingestion:batch` queues
5. Begin ontology version polling (every 5 minutes with jitter, per ADR-12 resilience policy)
6. Mark `/readyz` healthy once all five checks pass

### Health Endpoints

```
GET /healthz   Liveness: event loop not blocked, process alive
GET /readyz    Readiness: Postgres reachable, Redis reachable, MinIO reachable, master key loaded
```

Both are unauthenticated, not rate-limited, and respond with `X-Response-Time`.

---

## 2. Database Schema

All tables live in the `ingestion` schema, owned by `ingestion_service_role`. The Ontology Service has `SELECT` on all tables in this schema (cross-schema exception, ADR-28 §Security).

### 2.1 ingestion.connectors

```sql
CREATE TABLE ingestion.connectors (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid        NOT NULL,
  plugin_id       text        NOT NULL,   -- manifest.id of the connector plugin
  instance_id     uuid        NOT NULL,   -- plugin_instances.id in plugin schema
  name            text        NOT NULL,
  description     text,
  config          jsonb       NOT NULL DEFAULT '{}',
  sync_mode       text        NOT NULL DEFAULT 'incremental'
                              CHECK (sync_mode IN ('full', 'incremental')),
  schedule_cron   text,                   -- NULL means manual-only
  is_enabled      boolean     NOT NULL DEFAULT true,
  created_by      uuid        NOT NULL,   -- auth.users.id
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,            -- soft delete
  CONSTRAINT connectors_name_tenant_unique UNIQUE (tenant_id, name)
);

CREATE INDEX idx_connectors_tenant_id
  ON ingestion.connectors (tenant_id)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_connectors_plugin_id
  ON ingestion.connectors (plugin_id)
  WHERE deleted_at IS NULL;

-- Row-level security: tenants see only their own connectors
ALTER TABLE ingestion.connectors ENABLE ROW LEVEL SECURITY;

CREATE POLICY connectors_tenant_isolation ON ingestion.connectors
  USING (tenant_id = current_setting('app.tenant_id')::uuid);

-- Ingestion service bypasses RLS (owns the table)
ALTER TABLE ingestion.connectors FORCE ROW LEVEL SECURITY;
```

`config` holds non-sensitive connector configuration (base URL, table names, file paths, etc.). Sensitive values (API keys, passwords, tokens) are stored only in `ingestion.credentials` and never in this column.

### 2.2 ingestion.credentials

```sql
CREATE TABLE ingestion.credentials (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_id    uuid        NOT NULL REFERENCES ingestion.connectors(id) ON DELETE CASCADE,
  field_name      text        NOT NULL,   -- e.g., "api_key", "password", "oauth_token"
  encrypted_blob  text        NOT NULL,   -- base64(salt[32] | iv[12] | authTag[16] | ciphertext)
  key_version     integer     NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credentials_connector_field_unique UNIQUE (connector_id, field_name)
);

CREATE INDEX idx_credentials_connector_id
  ON ingestion.credentials (connector_id);

CREATE INDEX idx_credentials_key_version
  ON ingestion.credentials (key_version)
  WHERE key_version < (SELECT max(key_version) FROM ingestion.credentials);
  -- Partial index for key rotation: quickly find rows needing re-encryption

-- No RLS on credentials: only ingestion_service_role can access this table.
-- The Ontology cross-schema grant explicitly excludes credentials:
--   GRANT SELECT ON ALL TABLES IN SCHEMA ingestion TO ontology_service_role;
-- is followed by:
--   REVOKE SELECT ON ingestion.credentials FROM ontology_service_role;
```

The `encrypted_blob` column format matches exactly what `packages/core/src/encryption.ts` produces: `base64(salt[32] | iv[12] | authTag[16] | ciphertext)`. No salt column is needed separately — the salt is embedded in the blob and extracted at decrypt time.

The `key_version` integer tracks which master key generation was used for encryption. On key rotation, a background job increments `key_version` as rows are re-encrypted and uses the partial index to find outstanding rows efficiently.

### 2.3 ingestion.sync_state

```sql
CREATE TABLE ingestion.sync_state (
  connector_id    uuid        PRIMARY KEY REFERENCES ingestion.connectors(id) ON DELETE CASCADE,
  last_cursor     text,                   -- opaque to the service; passed directly to connector
  last_sync_at    timestamptz,
  last_sync_job_id uuid,                  -- BullMQ job ID of the last completed sync
  sync_mode       text        NOT NULL DEFAULT 'incremental'
                              CHECK (sync_mode IN ('full', 'incremental')),
  status          text        NOT NULL DEFAULT 'never_run'
                              CHECK (status IN ('never_run', 'running', 'success', 'failed', 'cancelled')),
  last_error      text,                   -- human-readable error from last failed sync
  last_error_code text,                   -- machine-readable PluginError.code
  rows_last_sync  bigint      DEFAULT 0,
  rows_total      bigint      DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_sync_state_status ON ingestion.sync_state (status);
```

One row per connector. `last_cursor` is stored as text and passed opaquely to the connector. The service never parses or transforms cursor values — doing so would break connectors that use timestamp cursors, opaque pagination tokens, or sequence numbers.

### 2.4 ingestion.webhook_receivers

```sql
CREATE TABLE ingestion.webhook_receivers (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid        NOT NULL,
  connector_id    uuid        REFERENCES ingestion.connectors(id) ON DELETE SET NULL,
  name            text        NOT NULL,
  description     text,
  path_suffix     text        NOT NULL UNIQUE,
                              -- The public URL is /api/v1/webhooks/inbound/{id}/receive
                              -- path_suffix is the id segment for routing
  secret_hash     text        NOT NULL,   -- bcrypt hash of the webhook secret
  hmac_algorithm  text        NOT NULL DEFAULT 'sha256'
                              CHECK (hmac_algorithm IN ('sha256', 'sha512')),
  header_name     text        NOT NULL DEFAULT 'X-Webhook-Signature',
                              -- Which header carries the HMAC signature
  is_enabled      boolean     NOT NULL DEFAULT true,
  created_by      uuid        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  last_received_at timestamptz,
  events_received bigint      NOT NULL DEFAULT 0
);

CREATE INDEX idx_webhook_receivers_tenant_id
  ON ingestion.webhook_receivers (tenant_id)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX idx_webhook_receivers_path_suffix
  ON ingestion.webhook_receivers (path_suffix)
  WHERE deleted_at IS NULL;

ALTER TABLE ingestion.webhook_receivers ENABLE ROW LEVEL SECURITY;

CREATE POLICY webhook_receivers_tenant_isolation ON ingestion.webhook_receivers
  USING (tenant_id = current_setting('app.tenant_id')::uuid);
```

`path_suffix` is stored as the UUID in the URL `POST /api/v1/webhooks/inbound/{id}/receive`. The Gateway routes this to the Ingestion Service regardless of auth (it is a public endpoint) but the Ingestion Service performs HMAC verification before processing the payload.

`secret_hash` is a bcrypt hash of the webhook secret. The raw secret is returned only once at creation time, following the same pattern as API keys (ADR-7). Secret comparison uses `crypto.timingSafeEqual` to prevent timing attacks.

### 2.5 ingestion.upload_jobs

```sql
CREATE TABLE ingestion.upload_jobs (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid        NOT NULL,
  connector_id    uuid        REFERENCES ingestion.connectors(id) ON DELETE SET NULL,
  filename        text        NOT NULL,
  content_type    text        NOT NULL,   -- e.g., "text/csv", "application/json"
  file_size_bytes bigint,
  minio_key       text,                   -- file-uploads/{tenantId}/{jobId}/{filename}
  status          text        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'uploading', 'parsing',
                                                'staging', 'complete', 'failed')),
  rows_parsed     bigint      NOT NULL DEFAULT 0,
  rows_staged     bigint      NOT NULL DEFAULT 0,
  rows_failed     bigint      NOT NULL DEFAULT 0,
  error           text,
  inferred_schema jsonb,                  -- populated after parsing first 200 rows
  created_by      uuid        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz
);

CREATE INDEX idx_upload_jobs_tenant_id
  ON ingestion.upload_jobs (tenant_id, created_at DESC);

CREATE INDEX idx_upload_jobs_status
  ON ingestion.upload_jobs (status)
  WHERE status NOT IN ('complete', 'failed');
  -- Partial index for in-flight jobs only

ALTER TABLE ingestion.upload_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY upload_jobs_tenant_isolation ON ingestion.upload_jobs
  USING (tenant_id = current_setting('app.tenant_id')::uuid);
```

### 2.6 Schema Migrations

Database migrations are managed by Drizzle ORM, stored in `services/ingestion/src/db/migrations/`. The Ingestion Service runs migrations at startup before accepting traffic. The `ingestion_service_role` owns the schema and has full DML + DDL rights within it. Migration files are numbered sequentially (`0001_initial.sql`, `0002_add_webhook_receivers.sql`, etc.).

---

## 3. Dynamic Raw Tables

### 3.1 Table Naming and Creation

Each connector instance has its own raw staging table. Tables are created on first connector activation (when the first sync job runs or the connector is explicitly tested).

```sql
-- Template for dynamic table creation
-- Connector ID is a UUID: 550e8400-e29b-41d4-a716-446655440000
-- Table name: raw_550e8400_e29b_41d4_a716_446655440000 (dashes → underscores)

CREATE TABLE IF NOT EXISTS ingestion.raw_{connectorId_underscored} (
  _id             uuid        PRIMARY KEY,    -- UUID v7 (time-sortable)
  _source         text        NOT NULL,       -- ConnectorMetadata.name
  _ingested_at    timestamptz NOT NULL DEFAULT now(),
  _connector_id   uuid        NOT NULL,       -- FK to ingestion.connectors.id
  _tenant_id      uuid        NOT NULL,       -- tenant isolation (also enforced by RLS)
  _batch_id       uuid        NOT NULL,       -- BullMQ batch job ID
  _sync_mode      text        NOT NULL CHECK (_sync_mode IN ('full', 'incremental')),
  _cursor         text,                       -- cursor value at time of ingestion (nullable)
  _source_id      text        NOT NULL,       -- DataRecord.sourceId from connector
  deleted_at      timestamptz,               -- soft-delete for full sync deletion detection
  data            jsonb       NOT NULL        -- raw source fields, unmodified
);
```

**SQL injection prevention:** connector IDs are UUID v4 values enforced at creation time (`ingestion.connectors.id DEFAULT gen_random_uuid()`). The table name construction replaces hyphens with underscores, resulting in a 39-character string of hex digits and underscores. The service validates the UUID format before constructing the DDL statement. No user-supplied strings ever appear in DDL.

**Existence check:** `CREATE TABLE IF NOT EXISTS` is idempotent. The Ingestion Service executes it on every sync job start. The `IF NOT EXISTS` path is the hot path — table creation overhead only occurs on the first activation.

**Cross-schema grant:** After creating each new raw table, the service executes:

```sql
GRANT SELECT ON ingestion.raw_{connectorId_underscored} TO ontology_service_role;
```

This extends the cross-schema read grant to the new table. The `ALTER DEFAULT PRIVILEGES` grant set at schema level handles this automatically but the explicit grant is added for defense-in-depth.

### 3.2 Indexing Strategy

```sql
-- GIN index on data JSONB for field-level queries
-- Enables: WHERE data->>'email' = '...' and path-based queries by Ontology mapping workers
CREATE INDEX IF NOT EXISTS idx_raw_{connectorId_underscored}_data
  ON ingestion.raw_{connectorId_underscored} USING GIN (data);

-- B-tree index on _batch_id for Ontology Service batch reads
-- Enables: WHERE _batch_id = $1 (the mapping job query)
CREATE INDEX IF NOT EXISTS idx_raw_{connectorId_underscored}_batch_id
  ON ingestion.raw_{connectorId_underscored} (_batch_id);

-- B-tree index on _ingested_at for time-range queries and retention cleanup
CREATE INDEX IF NOT EXISTS idx_raw_{connectorId_underscored}_ingested_at
  ON ingestion.raw_{connectorId_underscored} (_ingested_at DESC);

-- Partial index on deleted_at for full sync deletion queries
CREATE INDEX IF NOT EXISTS idx_raw_{connectorId_underscored}_not_deleted
  ON ingestion.raw_{connectorId_underscored} (deleted_at)
  WHERE deleted_at IS NULL;
```

All four indexes are created together in a single DDL transaction with the table. Index creation is concurrent (`CREATE INDEX CONCURRENTLY`) only for tables that already exist and have data — for new tables the non-concurrent form is used since the table is empty.

### 3.3 Row-Level Security on Raw Tables

```sql
ALTER TABLE ingestion.raw_{connectorId_underscored} ENABLE ROW LEVEL SECURITY;

CREATE POLICY raw_tenant_isolation ON ingestion.raw_{connectorId_underscored}
  USING (_tenant_id = current_setting('app.tenant_id')::uuid);
```

The Ingestion Service sets `SET LOCAL app.tenant_id = $tenantId` at the start of every database transaction that touches a raw table. The Ontology Service mapping worker does the same when reading from raw tables. This ensures cross-tenant queries are impossible at the database level even if application-layer bugs occur.

### 3.4 Retention and Cleanup

A background job runs daily in the Ingestion Service:

1. Reads active retention policies from connector config (default: 30 days)
2. For each connector: `DELETE FROM ingestion.raw_{connectorId_underscored} WHERE _ingested_at < now() - INTERVAL '{retentionDays} days'`
3. Logs rows deleted to the Logging Service

Raw tables are never dropped unless the connector is deleted. On connector deletion:

1. All associated raw table rows are soft-deleted (`deleted_at = now()`) in a background job
2. After 7 days, the table is dropped: `DROP TABLE IF EXISTS ingestion.raw_{connectorId_underscored}`
3. Credentials are deleted immediately (synchronously) on connector deletion

---

## 4. API Endpoints

All endpoints follow the ADR-29 API Contract Standard. Request validation uses Zod schemas. Responses use the standard `{ data }` or `{ error }` envelopes.

### 4.1 Authentication Requirements

| Endpoint pattern | Auth required | Scope |
|---|---|---|
| `GET/POST/PATCH/DELETE /api/v1/connectors*` | JWT or API key | `ingestion:read` or `ingestion:write` |
| `POST /api/v1/connectors/{id}/test` | JWT or API key | `ingestion:write` |
| `POST /api/v1/connectors/{id}/trigger` | JWT or API key | `ingestion:write` |
| `GET /api/v1/connectors/{id}/syncs` | JWT or API key | `ingestion:read` |
| `GET /api/v1/connectors/{id}/syncs/{syncId}/progress` | JWT or API key | `ingestion:read` |
| `POST/GET /api/v1/webhooks/inbound*` (management) | JWT or API key | `ingestion:write` / `ingestion:read` |
| `POST /api/v1/webhooks/inbound/{id}/receive` | **None** (public) | Authenticated by HMAC |
| `POST /api/v1/uploads` | JWT or API key | `ingestion:write` |
| `GET /api/v1/uploads/{id}/status` | JWT or API key | `ingestion:read` |
| `POST /internal/ingestion/connectors` | Service token only | Plugin → Ingestion |
| `DELETE /internal/ingestion/connectors/{id}` | Service token only | Plugin → Ingestion |

### 4.2 Connector Management

#### GET /api/v1/connectors

```typescript
// Query parameters (all optional)
const ListConnectorsQuery = z.object({
  cursor:                z.string().optional(),
  limit:                 z.coerce.number().int().min(1).max(100).default(50),
  "filter[status][eq]":  z.enum(["enabled", "disabled"]).optional(),
  "filter[pluginId][eq]": z.string().optional(),
  sort:                  z.string().default("-createdAt"),
});

// Response: 200 OK
interface ListConnectorsResponse {
  data: ConnectorSummary[];
  pagination: { nextCursor: string | null; total: number };
}

interface ConnectorSummary {
  id: string;
  tenantId: string;
  pluginId: string;
  instanceId: string;
  name: string;
  description: string | null;
  syncMode: "full" | "incremental";
  scheduleCron: string | null;
  isEnabled: boolean;
  createdAt: string;
  updatedAt: string;
  syncState: {
    status: "never_run" | "running" | "success" | "failed" | "cancelled";
    lastSyncAt: string | null;
    rowsTotal: number;
    lastError: string | null;
  };
}
```

#### POST /api/v1/connectors

```typescript
const CreateConnectorBody = z.object({
  pluginId:     z.string().min(1),
  name:         z.string().min(1).max(200),
  description:  z.string().max(1000).optional(),
  config:       z.record(z.unknown()),
  credentials:  z.record(z.string()),   // { fieldName: plaintextValue }
  syncMode:     z.enum(["full", "incremental"]).default("incremental"),
  scheduleCron: z.string().optional(),  // validated as valid cron expression
  isEnabled:    z.boolean().default(true),
});

// Response: 201 Created
interface CreateConnectorResponse {
  data: ConnectorDetail;
}
```

Credentials are encrypted immediately during request handling before the row is written. The plaintext credential values are never stored anywhere — they exist only in the request body buffer during the handler execution.

#### GET /api/v1/connectors/{id}

```typescript
// Response: 200 OK
interface ConnectorDetail extends ConnectorSummary {
  config: Record<string, unknown>;
  // credentials field names returned, values masked as "***"
  credentialFields: string[];
}
```

Credential values are never returned in API responses. Only the field names are returned so the UI can display which credentials are configured.

#### PATCH /api/v1/connectors/{id}

```typescript
const PatchConnectorBody = z.object({
  name:         z.string().min(1).max(200).optional(),
  description:  z.string().max(1000).nullable().optional(),
  config:       z.record(z.unknown()).optional(),
  credentials:  z.record(z.string()).optional(),  // partial update: only listed fields updated
  syncMode:     z.enum(["full", "incremental"]).optional(),
  scheduleCron: z.string().nullable().optional(),
  isEnabled:    z.boolean().optional(),
});

// Response: 200 OK — full ConnectorDetail
```

When `credentials` is provided, only the listed field names are updated. Omitted credential fields retain their existing encrypted values. The handler re-encrypts only the fields present in the request.

#### DELETE /api/v1/connectors/{id}

```
Response: 204 No Content
```

Soft-deletes the connector row. Enqueues a background job to delete credentials immediately and schedule raw table cleanup after 7 days.

#### POST /api/v1/connectors/{id}/test

```typescript
// Request body: optional override config (for testing before saving)
const TestConnectorBody = z.object({
  config:      z.record(z.unknown()).optional(),
  credentials: z.record(z.string()).optional(),
}).optional();

// Response: 200 OK
interface TestConnectorResponse {
  data: {
    success: boolean;
    latencyMs: number;
    message: string;           // human-readable result
    sampleRecords?: unknown[]; // first 3 records from fetchBatch, if available
    error?: {
      code: string;
      message: string;
    };
  };
}
```

Invokes `connector.connect()` + `connector.fetchBatch(cursor: undefined)` through the Execution Service sandbox with a 30-second timeout. Does not persist any data.

#### POST /api/v1/connectors/{id}/trigger

```typescript
const TriggerSyncBody = z.object({
  mode:    z.enum(["full", "incremental"]).optional(),  // overrides connector default
  force:   z.boolean().default(false),                   // bypass "already running" guard
}).optional();

// Response: 202 Accepted
interface TriggerSyncResponse {
  data: {
    syncJobId: string;
    status: "queued";
    estimatedStartMs: number;  // ms until job is likely to start
  };
}
```

Enqueues an `ingestion:sync` BullMQ job. Returns immediately with the job ID. The client polls `GET /api/v1/connectors/{id}/syncs/{syncJobId}/progress` for status.

If the connector is already running and `force: false`, returns `409 Conflict` with `code: "SYNC_ALREADY_RUNNING"`.

#### GET /api/v1/connectors/{id}/syncs

```typescript
// Query parameters
const ListSyncsQuery = z.object({
  cursor:                   z.string().optional(),
  limit:                    z.coerce.number().int().min(1).max(100).default(20),
  "filter[status][eq]":    z.enum(["running", "success", "failed", "cancelled"]).optional(),
});

// Response: 200 OK
interface ListSyncsResponse {
  data: SyncJobSummary[];
  pagination: { nextCursor: string | null; total: number };
}

interface SyncJobSummary {
  syncJobId: string;
  connectorId: string;
  status: "running" | "success" | "failed" | "cancelled";
  syncMode: "full" | "incremental";
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  rowsIngested: number;
  rowsFailed: number;
  error: string | null;
}
```

Sync job history is read from BullMQ job records, not from Postgres. Jobs are retained in BullMQ for 7 days after completion.

#### GET /api/v1/connectors/{id}/syncs/{syncId}/progress

```typescript
// Response: 200 OK
interface SyncProgressResponse {
  data: {
    syncJobId: string;
    status: "queued" | "running" | "success" | "failed" | "cancelled";
    totalBatches: number;
    completedBatches: number;
    failedBatches: number;
    totalRecords: number;
    processedRecords: number;
    percentComplete: number;        // 0-100
    estimatedSecondsRemaining: number | null;
    startedAt: string | null;
    completedAt: string | null;
    errors: Array<{
      batchId: string;
      message: string;
      code: string;
      recordCount: number;
    }>;
  };
}
```

Progress data is read from Redis key `ingestion:sync:{syncJobId}:progress`. If the key is expired or absent (job too old), the endpoint reads the final status from BullMQ job history and returns a static completed/failed response.

This endpoint also supports SSE streaming via `Accept: text/event-stream`. When the Accept header is present, the Ingestion Service subscribes to `ingestion:sync:{syncJobId}:events` Redis pub/sub channel and streams progress updates until the job completes.

### 4.3 Webhook Receiver Management

#### POST /api/v1/webhooks/inbound

```typescript
const CreateWebhookBody = z.object({
  name:          z.string().min(1).max(200),
  description:   z.string().max(1000).optional(),
  connectorId:   z.string().uuid().optional(),  // link to a connector if desired
  hmacAlgorithm: z.enum(["sha256", "sha512"]).default("sha256"),
  headerName:    z.string().default("X-Webhook-Signature"),
  // secret: auto-generated 32-byte hex. Returned once in the response. Never again.
});

// Response: 201 Created
interface CreateWebhookResponse {
  data: {
    id: string;
    name: string;
    receiveUrl: string;    // Full public URL: {baseUrl}/api/v1/webhooks/inbound/{id}/receive
    secret: string;        // Raw secret — returned ONLY on creation
    hmacAlgorithm: "sha256" | "sha512";
    headerName: string;
    connectorId: string | null;
    createdAt: string;
  };
}
```

The generated `secret` is 32 cryptographically random bytes encoded as lowercase hex (`crypto.randomBytes(32).toString('hex')`). The service stores only the bcrypt hash (`await bcrypt.hash(secret, 12)`). The raw secret is never stored and cannot be retrieved.

#### GET /api/v1/webhooks/inbound

Returns a paginated list. `secret` is never included in list or get responses.

#### POST /api/v1/webhooks/inbound/{id}/receive (Public Endpoint)

```typescript
// No authentication header required.
// Authenticated by HMAC signature in the configured header.

// Request:
// - Any content body (the platform treats it as opaque bytes for HMAC verification)
// - Header: X-Webhook-Signature: sha256={hex-encoded-hmac}  (or configured header)
// - Header: Content-Type (preserved in the staged record)

// Response: 200 OK (always, to prevent timing-based enumeration of valid IDs)
interface WebhookReceiveResponse {
  received: true;
  eventId: string;  // UUID of the staged record, for idempotency tracking by sender
}

// If HMAC verification fails: still returns 200 OK but stages nothing and logs
// a security event. Returning 401/403 would allow attackers to enumerate valid IDs.
// The security event is: { level: "WARN", code: "WEBHOOK_HMAC_FAILED", webhookId }
```

**HMAC verification flow:**

1. Read the raw request body as `Buffer` — do not JSON-parse yet
2. Look up `webhook_receivers` by `id` in the URL path — read `secret_hash` and `hmac_algorithm`
3. Compute `expectedHmac = crypto.createHmac(algorithm, rawSecret).update(rawBody).digest('hex')`

   Wait — the service does not have `rawSecret`. It stored `secret_hash` (bcrypt). This is the deliberate design: HMAC verification requires the raw secret, but bcrypt comparison requires only the hash.

   **Resolution:** The raw secret is stored separately in the credential vault (`ingestion.credentials` with `connector_id` set to a synthetic row and `field_name = 'webhook_secret'`). `secret_hash` remains a bcrypt hash for API-level verification (confirming the user knows the secret). For HMAC verification, `context.credentials.get('webhook_secret')` fetches the AES-256-GCM decrypted raw secret.

   This means webhook secrets are stored in two forms:
   - AES-256-GCM encrypted blob in `ingestion.credentials` (for HMAC computation on inbound events)
   - bcrypt hash in `ingestion.webhook_receivers.secret_hash` (for user-facing "rotate secret" verification flows)

4. Compare `expectedHmac` with the header value using `crypto.timingSafeEqual`
5. If mismatch: log security event, return `200 OK` with `{ received: true }` (no event ID)
6. If match: parse body as JSON (or treat as raw bytes if not JSON), normalize to `DataEnvelope`, write to raw table, enqueue `ontology:map`

**Rate limiting:** the Gateway applies 100 req/s per webhook endpoint (ADR-20). The Ingestion Service applies no additional rate limit on this endpoint.

### 4.4 File Upload

#### POST /api/v1/uploads

```
Content-Type: multipart/form-data

Fields:
  file        (required) binary file data
  connectorId (optional) uuid — associate with an existing connector
  filename    (optional) override detected filename
```

```typescript
// Response: 202 Accepted
interface CreateUploadResponse {
  data: {
    uploadJobId: string;
    status: "pending";
    filename: string;
    contentType: string;
    fileSizeBytes: number;
  };
}
```

The upload handler:
1. Validates MIME type (allowed: `text/csv`, `application/json`, `text/tab-separated-values`)
2. Streams the file directly to MinIO bucket `file-uploads` at key `{tenantId}/{uploadJobId}/{filename}` using the AWS SDK v3 multipart upload API. File is NOT buffered in memory.
3. Inserts a row into `ingestion.upload_jobs` with `status: 'pending'` and the MinIO key
4. Enqueues a `ingestion:file-parse` BullMQ job with the upload job ID
5. Returns 202 immediately

Maximum file size: 5 GB (configurable via `OP_UPLOAD_MAX_SIZE_BYTES`). Files exceeding this limit receive `413 Payload Too Large` with `code: "UPLOAD_FILE_TOO_LARGE"`.

#### GET /api/v1/uploads/{id}/status

```typescript
// Response: 200 OK
interface UploadStatusResponse {
  data: {
    uploadJobId: string;
    status: "pending" | "uploading" | "parsing" | "staging" | "complete" | "failed";
    filename: string;
    fileSizeBytes: number | null;
    rowsParsed: number;
    rowsStaged: number;
    rowsFailed: number;
    percentComplete: number;
    error: string | null;
    inferredSchema: Record<string, unknown> | null;  // populated after parsing
    createdAt: string;
    completedAt: string | null;
  };
}
```

### 4.5 Internal Endpoints (Service-Only)

These endpoints are not exposed through the Gateway. They require the `X-Service-Token` header with a valid Ed25519 service JWT (ADR-19). The caller must be the Plugin Service.

#### POST /internal/ingestion/connectors

Called by the Plugin Service when a connector plugin is installed. Registers the connector type so the Ingestion Service is aware of its capabilities.

```typescript
const RegisterConnectorBody = z.object({
  pluginId:    z.string(),
  instanceId:  z.string().uuid(),
  metadata:    ConnectorMetadataSchema,  // from @oneplatform/plugin-sdk
});

// Response: 200 OK
interface RegisterConnectorResponse {
  registered: true;
}
```

#### DELETE /internal/ingestion/connectors/{pluginId}

Called by the Plugin Service when a connector plugin is uninstalled. Disables all connectors using this plugin ID.

```typescript
// Response: 200 OK
interface UnregisterConnectorResponse {
  disabledCount: number;
}
```

---

## 5. Credential Vault

### 5.1 Design Overview

The credential vault uses AES-256-GCM with HKDF-SHA256 per-credential key derivation. The implementation is in `packages/core/src/encryption.ts` and is imported directly by the Ingestion Service. No separate vault service exists — the vault is the `ingestion.credentials` table plus the encryption logic in core.

**Wire format** (from encryption.ts):

```
base64( salt[32 bytes] | iv[12 bytes] | authTag[16 bytes] | ciphertext[variable] )
```

- `salt` — 32 random bytes, unique per encryption call, used as HKDF input material
- `iv` — 12-byte nonce for AES-GCM (96-bit, the standard GCM recommendation)
- `authTag` — 16-byte GCM authentication tag that detects both tampering and wrong-key decryption
- `ciphertext` — AES-256-GCM ciphertext of the UTF-8 encoded plaintext credential value

### 5.2 Key Derivation

```
masterKey (32 bytes, from OP_MASTER_KEY)
    |
    +--> HKDF-SHA256(ikm=masterKey, salt=credentialSalt, info="oneplatform-credential-v1", length=32)
    |
    +--> derivedKey (32 bytes, unique per credential)
```

`HKDF-SHA256` ensures that each stored credential uses a distinct AES key. Compromising one credential's ciphertext in isolation (e.g., a targeted SQL injection that returns one row) does not help an attacker decrypt other credentials — the derived keys are independent.

The `info` string `"oneplatform-credential-v1"` is a domain separator that prevents key material from one use case (credentials) being reused for another. The `v1` suffix allows the domain separator to be incremented on key algorithm changes.

### 5.3 Encrypt Flow

```
1. Generate salt = crypto.randomBytes(32)
2. Generate iv   = crypto.randomBytes(12)
3. derivedKey    = HKDF-SHA256(masterKey, salt, "oneplatform-credential-v1", 32)
4. cipher        = AES-256-GCM(key=derivedKey, iv=iv)
5. ciphertext    = cipher.update(plaintext, 'utf8') + cipher.final()
6. authTag       = cipher.getAuthTag()
7. blob          = base64(salt + iv + authTag + ciphertext)
8. INSERT INTO ingestion.credentials (connector_id, field_name, encrypted_blob, key_version)
   VALUES ($1, $2, $3, $currentKeyVersion)
```

The master key is loaded once at service startup and held in a `Buffer` in process memory. It is never written to any log, never serialized to Redis, and never included in any response body or error message.

### 5.4 Decrypt Flow

```
1. SELECT encrypted_blob FROM ingestion.credentials
   WHERE connector_id = $1 AND field_name = $2
2. raw = Buffer.from(encrypted_blob, 'base64')
3. salt    = raw[0..31]
4. iv      = raw[32..43]
5. authTag = raw[44..59]
6. cipher  = raw[60..]
7. derivedKey = HKDF-SHA256(masterKey, salt, "oneplatform-credential-v1", 32)
8. decipher   = AES-256-GCM(key=derivedKey, iv=iv)
9. decipher.setAuthTag(authTag)
10. plaintext = decipher.update(cipher) + decipher.final()
    -- decipher.final() throws if authTag mismatch (tampering or wrong key)
11. Return plaintext
```

On `decipher.final()` throwing, the Ingestion Service catches the error and throws `CredentialDecryptionError` with the field name included in the error but the plaintext excluded. This error is treated as non-retryable and surfaces to the user as `code: "CREDENTIAL_DECRYPT_FAILED"`.

### 5.5 CredentialAccessor Injection

Connector plugin code never receives plaintext credentials as function arguments. The Ingestion Service constructs a `CredentialAccessor` object that lazily decrypts on demand:

```typescript
class InMemoryCredentialAccessor implements CredentialAccessor {
  // Decrypted values are cached in memory for the duration of the sync job.
  // The cache is not shared between sync jobs — each job gets a fresh accessor.
  private cache = new Map<string, string>();

  async get(name: string): Promise<string> {
    if (this.cache.has(name)) return this.cache.get(name)!;
    const value = await this.vaultDecrypt(this.connectorId, name);
    this.cache.set(name, value);
    return value;
  }

  async list(): Promise<string[]> {
    return this.vaultListFields(this.connectorId);
  }
}
```

The accessor object is passed to `connector.connect()` and `connector.fetchBatch()`. When the sync job completes (success or failure), the accessor object is garbage collected. Decrypted values exist in memory only for the duration of the sync job — they are not held in any long-lived structure.

### 5.6 Key Rotation

Key rotation is triggered by an operator action: calling `POST /api/v1/admin/credential-vault/rotate` with the new master key.

```
1. Operator generates new key: openssl rand -base64 32
2. Operator calls POST /api/v1/admin/credential-vault/rotate
   { newMasterKey: "<base64>", keyVersion: 2 }
   -- Protected by platform_admin role
3. The Ingestion Service:
   a. Stores the new key in memory alongside the old key
   b. Enqueues a BullMQ job on ingestion:key-rotation queue
   c. Returns 202 Accepted with { jobId, pendingCount }
4. The rotation job (idempotent):
   a. SELECT * FROM ingestion.credentials WHERE key_version < $newKeyVersion
      -- Uses partial index for efficiency
   b. For each row:
      i.  Decrypt with old key (key_version determines which master key to use)
      ii. Re-encrypt with new key
      iii. UPDATE ingestion.credentials SET encrypted_blob=$newBlob, key_version=$newVersion
           WHERE id=$rowId AND key_version=$oldVersion  -- optimistic lock
   c. If step b.iii updates 0 rows (concurrent rotation), skip the row (already rotated)
   d. Log progress to Redis: ingestion:rotation:{jobId}:progress
5. On completion: old master key is zeroed in memory
6. Operator updates OP_MASTER_KEY in .env / Docker secret for persistence across restarts
```

The rotation job is idempotent because the `WHERE key_version=$oldVersion` condition in step 4b.iii prevents double-re-encryption. If the rotation job crashes and is restarted, it re-processes only rows not yet migrated.

---

## 6. Sync Engine

### 6.1 Job Hierarchy

```
ingestion:sync queue
  └── SyncJob (one per connector trigger)
        ├── Calls connector.connect()
        ├── Fetches first batch
        └── For each batch (while hasMore = true):
              └── ingestion:batch queue
                    └── BatchJob (one per 1000-record batch)
                          ├── Upserts to raw table
                          └── Enqueues ontology:map job
```

The parent SyncJob is a BullMQ parent job that tracks completion of all child BatchJobs via BullMQ's flow/producer API. Progress is maintained in Redis under `ingestion:sync:{syncJobId}:progress`.

### 6.2 Full Sync Mode

```
1. connector.connect(config, credentialAccessor)
   → ConnectorHandle

2. cursor = undefined  (start from beginning)
   batchId = uuidv4()  (shared across all batches in this sync)

3. LOOP:
   a. result = connector.fetchBatch(handle, cursor, context)
   b. Normalize result.records → DataEnvelope[]  (see §10)
   c. Upsert batch to ingestion.raw_{connectorId}:
      For batch sizes ≤ 5,000:
        BEGIN
          INSERT INTO ingestion.raw_{connectorId} (...)
          SELECT unnest($records)
          ON CONFLICT (_id) DO UPDATE SET data = EXCLUDED.data, _batch_id = EXCLUDED._batch_id
          UPDATE ingestion.sync_state SET last_cursor = $cursor WHERE connector_id = $id
        COMMIT
      For batch sizes > 5,000:
        COPY ingestion.raw_{connectorId} FROM stdin (binary)
        UPDATE ingestion.sync_state SET last_cursor = $cursor WHERE connector_id = $id
   d. Enqueue ontology:map job { connectorId, batchId, tenantId, batchSeqNum }
   e. Update Redis progress: ingestion:sync:{syncJobId}:progress
   f. cursor = result.nextCursor
   g. IF result.hasMore = false: BREAK

4. Soft-delete records not in current batchId (full sync deletion detection):
   UPDATE ingestion.raw_{connectorId}
   SET deleted_at = now()
   WHERE _connector_id = $connectorId
   AND _batch_id != $currentBatchId
   AND deleted_at IS NULL

5. connector.disconnect(handle, context)
6. UPDATE ingestion.sync_state SET status='success', last_sync_at=now()
```

### 6.3 Incremental Sync Mode

```
1. Read last_cursor from ingestion.sync_state WHERE connector_id = $id
2. connector.connect(config, credentialAccessor)
3. cursor = last_cursor (may be null for first-ever incremental sync)
4. LOOP: same as full sync steps 3a-3g
   EXCEPT: no deletion detection (incremental does not detect deletes unless
   the connector returns deleted records with DataRecord.metadata.deletedAt set)
5. connector.disconnect(handle, context)
6. UPDATE ingestion.sync_state SET status='success', last_sync_at=now(), last_cursor=$finalCursor
```

**Cursor atomicity decision (ADR-28):**

| Batch size | Insert method | Cursor update | Atomicity |
|---|---|---|---|
| ≤ 5,000 records | `INSERT ... SELECT unnest()` | Same `BEGIN...COMMIT` | Fully atomic |
| > 5,000 records | `COPY` (outside transaction) | Separate transaction | At-least-once (idempotent) |

The at-least-once case is safe because the upsert `ON CONFLICT (_id) DO UPDATE` ensures re-ingesting the same records is idempotent. The `_id` for each record is deterministic: `uuidv7()` seeded from `{connectorId}:{sourceId}` — same source record always produces the same `_id`.

Actually, the correct design for deterministic `_id` is a hash-based UUID: `uuid5(CONNECTOR_NAMESPACE, sourceRecord.sourceId)`. This ensures:
- Same source record → same `_id` → upsert ON CONFLICT works correctly
- Different connectors producing records with the same `sourceId` → different `_id` values (namespace includes connectorId)

The UUID v5 (namespace-UUID based) generation is done in the normalization step (§10).

### 6.4 BullMQ Queue Configuration

```typescript
// ingestion:sync queue — parent jobs
const syncQueue = new Queue('ingestion:sync', {
  connection: redisClient,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },  // 5s, 25s, 125s
    removeOnComplete: { age: 604800 },               // retain 7 days
    removeOnFail: { age: 2592000 },                  // retain 30 days
  },
});

// ingestion:batch queue — child jobs spawned by sync jobs
const batchQueue = new Queue('ingestion:batch', {
  connection: redisClient,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 1000 },  // 1s, 5s, 25s, 125s, 625s
    removeOnComplete: { age: 86400 },                // retain 1 day
    removeOnFail: { age: 604800 },                   // retain 7 days
  },
});

// ingestion:sync worker configuration
const syncWorker = new Worker('ingestion:sync', syncJobProcessor, {
  connection: redisClient,
  concurrency: 5,                    // 5 concurrent sync jobs (connector-level parallelism)
  limiter: { max: 5, duration: 1000 }, // rate limit for queue polling
});

// ingestion:batch worker configuration
const batchWorker = new Worker('ingestion:batch', batchJobProcessor, {
  connection: redisClient,
  concurrency: 10,                   // OP_INGESTION_WORKER_CONCURRENCY, default 10
});
```

**Dead-letter queue (ADR-13):** after 5 failed attempts, batch jobs move to `ingestion:batch:dlq`. The Ingestion Service emits an `ingestion.failed` platform event and updates the sync state to `failed`. DLQ jobs appear in the UI with full error context and can be replayed.

**Poison-pill detection (ADR-13):** if the same batch job fails 3 times within 60 seconds, it is moved to DLQ immediately (poison-pill pattern), bypassing remaining retries.

**Queue backpressure (ADR-13):**

```typescript
const BATCH_QUEUE_MAX = 50_000;  // maximum pending batch jobs

async function enqueueBatch(batchPayload: BatchJobPayload): Promise<void> {
  const waiting = await batchQueue.count();
  if (waiting >= BATCH_QUEUE_MAX) {
    throw new QueueFullError('ingestion:batch queue at capacity');
  }
  await batchQueue.add('batch', batchPayload);
}
```

The sync job catches `QueueFullError` and reschedules itself with a 30-second delay. The user sees `status: "backlogged"` in the progress UI.

**Redis outage WAL:** the Ingestion Service maintains a WAL file at `/data/job-buffer.wal` (max 50MB). If Redis is unreachable, sync trigger requests write to the WAL. On Redis reconnect, the WAL is replayed into the queue and truncated (ADR-18).

### 6.5 Memory-Bounded Streaming

Large syncs do not buffer complete batches in memory. The Ingestion Service streams records from the connector response through a Node.js `Transform` stream pipeline to the Postgres COPY stream:

```
connector.fetchBatch() → AsyncGenerator<DataRecord>
    |
    +--> NormalizationTransform   (DataRecord → DataEnvelope, adds _id, _source, etc.)
    |
    +--> PostgresCopyTransform    (DataEnvelope → binary Postgres COPY format)
    |
    +--> pg.copyFromStream()      (streams directly to Postgres over wire)
```

For connectors that return a complete array from `fetchBatch()` (not a stream), the Ingestion Service wraps the array in a readable stream before piping.

Peak memory per batch worker is bounded at approximately 50MB (ADR-28 §Large dataset handling):
- The Transform pipeline holds at most 2 records in flight (highWaterMark: 2 objects)
- Postgres binary COPY format is written 8KB at a time
- No full-batch array is ever materialized in memory

For large syncs (> 1 million records), concurrency drops to `OP_LARGE_SYNC_CONCURRENCY` (default 3) to limit simultaneous Postgres COPY streams.

### 6.6 Progress Tracking

Progress is stored in Redis at `ingestion:sync:{syncJobId}:progress`:

```typescript
interface SyncProgress {
  syncJobId: string;
  connectorId: string;
  tenantId: string;
  status: "queued" | "running" | "success" | "failed" | "cancelled";
  syncMode: "full" | "incremental";
  totalBatches: number;        // estimated from connector.estimatedTotal / batchSize
  completedBatches: number;
  failedBatches: number;
  totalRecords: number;        // updated as connector returns estimatedTotal
  processedRecords: number;
  startedAt: string | null;
  completedAt: string | null;
  lastBatchAt: string | null;
  errors: Array<{
    batchId: string;
    message: string;
    code: string;
    recordCount: number;
  }>;
}
```

Progress is updated in Redis via `SET` after each batch completes. The TTL on the Redis key is 7 days.

The `GET /api/v1/connectors/{id}/syncs/{syncId}/progress` endpoint reads this key directly. When the SSE transport is used, the Ingestion Service subscribes to `ingestion:sync:{syncJobId}:events` pub/sub channel and pushes each progress update as an SSE event.

---

## 7. Connector Plugin Integration

### 7.1 Built-in Connectors

Built-in connectors are compiled into the Ingestion Service binary and run in-process. They implement the same `Connector` interface as third-party plugins but are trusted code:

| Connector | File | Supported modes |
|---|---|---|
| REST API | `src/connectors/rest.ts` | full, incremental (cursor types: timestamp, page token) |
| PostgreSQL | `src/connectors/postgres.ts` | full, incremental (cursor: timestamp column or sequence) |
| MySQL | `src/connectors/mysql.ts` | full, incremental (cursor: timestamp column or sequence) |
| CSV | `src/connectors/csv.ts` | full only (CSV has no incremental concept) |
| File (JSON, NDJSON) | `src/connectors/file.ts` | full only |
| Webhook receiver | N/A — handled by the receive endpoint | push (no cursor) |

Built-in connectors bypass the Execution Service sandbox. Third-party connector plugins are always sandboxed (§7.2).

### 7.2 Third-Party Plugin Connector Invocation

When a connector's plugin type is third-party (i.e., the `plugin_id` in `ingestion.connectors` matches a plugin installed via the Plugin Service), the Ingestion Service does NOT execute the connector code in-process. Instead:

```
Ingestion Service (sync job)
    |
    | POST /internal/execution/run
    | {
    |   pluginId: "com.example.shopify-connector",
    |   instanceId: "...",
    |   method: "connect" | "fetchBatch" | "disconnect",
    |   args: { config, cursor, ... },
    |   credentials: { /* injected by Execution Service via CredentialAccessor */ },
    |   timeoutMs: 30000
    | }
    |
    v
Execution Service (op-sandbox-vm)
    |
    | 1. Loads plugin bundle from MinIO (plugin-bundles/{pluginId}-{version}.oppkg)
    | 2. Instantiates plugin in isolated-vm
    | 3. Injects PluginContext (credentials, fetch proxy, cache, logger, tenant, ontology)
    | 4. Calls method(args, context)
    | 5. Returns { result } or { error }
    |
    v
Ingestion Service receives ConnectorHandle or BatchResult or void
```

**Credential proxy:** the Execution Service does not decrypt credentials itself. It calls back to the Ingestion Service via a special internal endpoint `GET /internal/ingestion/credentials/{connectorId}/{fieldName}` to fetch decrypted values. This means credentials are decrypted in the Ingestion Service (which holds the master key) and passed to the sandbox as plaintext strings through the Unix socket. The sandbox receives only the credential value for the duration of the execution — it is not stored in the sandbox context between invocations.

**Timeout:** 30 seconds for `connect()`, 60 seconds for `fetchBatch()`, 10 seconds for `disconnect()`. These are enforced by the Execution Service and cannot be overridden by plugin code.

**Error mapping:** the Execution Service maps sandbox exceptions to `PluginError` subtypes before returning. The Ingestion Service reads `error.isRetryable` to decide whether to retry the batch job or fail immediately.

### 7.3 Plugin Registration Flow

When a Connector plugin is installed via the Plugin Service:

```
Plugin Service (install job completes)
    |
    | POST /internal/ingestion/connectors
    | { pluginId, instanceId, metadata: ConnectorMetadata }
    |
    v
Ingestion Service
    |
    | 1. Validates metadata against ConnectorMetadataSchema from @oneplatform/plugin-sdk
    | 2. Registers the plugin ID as a known connector type (in-memory registry)
    | 3. Returns { registered: true }
```

The in-memory registry is populated at startup from the Plugin Service: `GET /internal/plugin/connectors` returns all installed connector plugins. This ensures the Ingestion Service survives restart without losing plugin registrations.

---

## 8. Webhook Receivers

### 8.1 Receive Flow (Detailed)

```
External system
    |
    | POST /api/v1/webhooks/inbound/{id}/receive
    | Headers: X-Webhook-Signature: sha256=abc123...
    | Body: { "event": "order.created", "data": { ... } }
    |
    v
Gateway (rate limit: 100 req/s per webhook ID)
    |
    | Proxies to Ingestion Service (no auth check — public endpoint)
    |
    v
Ingestion Service webhook handler
    |
    | 1. Parse {id} from URL path
    | 2. SELECT id, secret_hash, hmac_algorithm, header_name, connector_id, is_enabled
    |    FROM ingestion.webhook_receivers WHERE id = $id AND deleted_at IS NULL
    |    -- Cached in memory with 30-second TTL (bcrypt verification is expensive)
    | 3. If not found: return 200 OK (prevents enumeration)
    | 4. If is_enabled = false: return 200 OK, log and drop
    | 5. Read raw body as Buffer (do not parse)
    | 6. Fetch HMAC signing secret via CredentialAccessor
    |    GET ingestion.credentials WHERE connector_id = $syntheticConnectorId AND field_name = 'webhook_secret'
    |    Decrypt via AES-256-GCM
    | 7. Compute expectedSig = crypto.createHmac(algorithm, rawSecret).update(rawBody).digest('hex')
    | 8. headerValue = req.header(header_name)
    |    Normalize: strip "sha256=" or "sha512=" prefix if present
    | 9. timingSafeEqual(Buffer.from(expectedSig, 'hex'), Buffer.from(headerValue, 'hex'))
    |    If mismatch: log security event, return 200 OK (no eventId)
    | 10. Parse body as JSON (if Content-Type: application/json)
    |     OR treat as raw bytes if other content type
    | 11. Normalize to DataEnvelope (§10)
    |     _id = uuidv7()
    |     _source = webhook_receivers.name
    |     _sync_mode = 'full' (webhooks are always full, single-record ingestion)
    | 12. INSERT INTO ingestion.raw_{connectorId} (single row)
    |     connectorId = webhook_receivers.connector_id ?? synthetic_webhook_connector_id
    | 13. Enqueue ontology:map job
    | 14. UPDATE ingestion.webhook_receivers SET events_received++, last_received_at=now()
    | 15. Return 200 OK { received: true, eventId: _id }
```

### 8.2 Caching Webhook Configuration

Step 2 in the flow above uses an in-memory LRU cache (capacity: 1000 webhook receivers, TTL: 30 seconds). This avoids a Postgres read on every inbound webhook event. The cache is invalidated on any `PATCH` or `DELETE` to the webhook receiver via the management API.

The bcrypt hash in `secret_hash` is NOT used for HMAC verification (bcrypt is a one-way function; HMAC requires the raw secret). It is used only if the platform adds a "rotate secret" flow where the user must confirm the old secret.

### 8.3 Webhook Secret Rotation

```
POST /api/v1/webhooks/inbound/{id}/rotate-secret
Body: { currentSecret: string }  // user must provide current secret to confirm

1. Fetch webhook receiver
2. bcrypt.compare(currentSecret, secret_hash)  // verify caller knows the current secret
3. If mismatch: return 403
4. Generate new secret = crypto.randomBytes(32).toString('hex')
5. new_hash = bcrypt.hash(newSecret, 12)
6. Re-encrypt new secret in ingestion.credentials
7. UPDATE ingestion.webhook_receivers SET secret_hash = $newHash
8. Return { newSecret: string }  -- returned ONCE, never again

Response: 200 OK
{
  data: {
    newSecret: "abc123..."  // operator must update the sending system immediately
  }
}
```

---

## 9. File Upload Pipeline

### 9.1 Upload Flow

```
Browser or API client
    |
    | POST /api/v1/uploads (multipart/form-data)
    |
    v
Ingestion Service upload handler
    |
    | 1. Extract file from multipart stream (busboy library)
    | 2. Validate MIME type (allowed: text/csv, application/json, text/tab-separated-values)
    | 3. Generate uploadJobId = uuidv7()
    | 4. INSERT INTO ingestion.upload_jobs { status: 'uploading', ... }
    | 5. Stream file → MinIO bucket 'file-uploads'
    |    Key: {tenantId}/{uploadJobId}/{filename}
    |    AWS SDK v3 multipart upload (parts: 5MB each, max 10,000 parts = 50GB theoretical max)
    | 6. UPDATE ingestion.upload_jobs SET minio_key = $key, file_size_bytes = $size, status = 'pending'
    | 7. Enqueue ingestion:file-parse BullMQ job { uploadJobId }
    | 8. Return 202 { uploadJobId, status: 'pending' }
```

### 9.2 File Parse Worker

The file parse worker processes uploads asynchronously:

```
ingestion:file-parse BullMQ job
    |
    | 1. SELECT * FROM ingestion.upload_jobs WHERE id = $uploadJobId
    | 2. UPDATE status = 'parsing'
    | 3. Stream file from MinIO (GetObjectCommand → ReadableStream)
    | 4. Parse based on content_type:
    |
    |    CSV:
    |      csv-parse library (streaming, not buffered)
    |      Header row → field names
    |      Heuristic type inference on first 200 rows:
    |        - ISO 8601 pattern → timestamptz
    |        - Integer pattern → bigint
    |        - Float pattern → numeric
    |        - "true"/"false" → boolean
    |        - Everything else → text
    |      Produce DataRecord[] stream
    |
    |    JSON (array root):
    |      streaming-json-parser (e.g., stream-json library)
    |      Each element → DataRecord
    |
    |    NDJSON / JSON Lines:
    |      readline stream, JSON.parse each line → DataRecord
    |
    | 5. UPDATE ingestion.upload_jobs SET inferred_schema = $schema (after 200 rows)
    |    Send POST /internal/ontology/infer with inferred schema (async, non-blocking)
    | 6. UPDATE status = 'staging'
    | 7. Batch records into groups of 1000
    | 8. For each batch:
    |    a. Normalize to DataEnvelope[]
    |    b. Upsert to ingestion.raw_{connectorId} (same upsert logic as sync batches)
    |    c. Enqueue ontology:map job
    |    d. UPDATE ingestion.upload_jobs SET rows_staged += 1000, rows_parsed += 1000
    | 9. UPDATE status = 'complete', completed_at = now()
    |10. Emit ingestion.completed platform event
```

**Error handling:** parse errors (malformed CSV, invalid JSON) are counted in `rows_failed` but do not abort the job. If more than 50% of rows fail to parse, the job is marked `failed` to prevent silently staging garbage data. The threshold is configurable via `OP_UPLOAD_MAX_FAILURE_RATE` (default 0.5).

**Memory bound:** the file parse worker reads from MinIO as a stream and processes one row at a time. No file is buffered in memory. The parser's internal buffer is bounded at 64KB.

### 9.3 Schema Inference

After parsing the first 200 rows, the service has:

```typescript
interface InferredSchema {
  fields: Array<{
    name: string;
    inferredType: "text" | "integer" | "numeric" | "boolean" | "timestamptz" | "jsonb";
    nullable: boolean;         // true if any of the 200 rows has null/empty for this field
    sampleValues: unknown[];   // first 3 non-null values for UI preview
  }>;
}
```

This schema is:
1. Stored in `ingestion.upload_jobs.inferred_schema` (for display in the upload status endpoint)
2. Sent to `POST /internal/ontology/infer` (for draft ontology generation by the Ontology Service)
3. Displayed to the user in the upload status UI as "Review suggested schema"

The Ontology Service generates a draft ontology from the inference but never applies it automatically. The user must review and confirm.

---

## 10. DataEnvelope Format

Per ADR-28, every record staged in `ingestion.raw_{connectorId}` conforms to this canonical envelope:

```typescript
interface DataEnvelope {
  _id: string;           // UUID v5(CONNECTOR_NAMESPACE, connectorId + ':' + sourceId)
                         // Deterministic: same source record always → same _id
                         // Enables ON CONFLICT (_id) upsert idempotency
  _source: string;       // ConnectorMetadata.name (e.g., "Shopify Orders")
  _ingested_at: string;  // ISO 8601 UTC, set at normalization time
  _connector_id: string; // UUID of the connector instance (ingestion.connectors.id)
  _batch_id: string;     // UUID v4 of the BullMQ batch job
  _tenant_id: string;    // UUID of the tenant (for cross-service reads + RLS)
  _sync_mode: "full" | "incremental";
  _cursor: string | null;// The cursor value in effect when this record was fetched
                         // Null for webhook and file upload ingestion
  _source_id: string;    // DataRecord.sourceId — the record's ID in the source system
  data: Record<string, unknown>; // Raw source fields, exactly as returned by connector
                                 // No transformation, no field removal
}
```

**_id determinism:** using UUID v5 (namespace + name → deterministic UUID) means the same source record always produces the same `_id`. This enables the `ON CONFLICT (_id) DO UPDATE` upsert to be safe and idempotent. The namespace UUID for each connector is stored in `ingestion.connectors.id` (the connector's own UUID serves as the namespace). The name is `DataRecord.sourceId`.

```typescript
import { v5 as uuidv5 } from 'uuid';

function deriveEnvelopeId(connectorId: string, sourceId: string): string {
  // connectorId is the namespace UUID; sourceId is the name
  return uuidv5(sourceId, connectorId);
}
```

**data field:** the `data` field contains the exact fields returned by `DataRecord.data`, with no transformation. Nested objects and arrays are preserved as-is. The Ontology Service is responsible for all field mapping and type coercion — the Ingestion Service is a faithful messenger.

**Webhook records:** for webhook receivers, `_cursor` is `null`, `_sync_mode` is `"full"`, and `_source_id` is a field extracted from the webhook payload (configurable per receiver, defaults to a hash of the entire payload if no ID field is configured).

**File upload records:** `_cursor` is `null`, `_sync_mode` is `"full"`, and `_source_id` is the row number prefixed with the upload job ID (`{uploadJobId}:row:{n}`).

---

## 11. Inter-Service Communication

### 11.1 Calls Made by Ingestion Service

All inter-service calls use `X-Service-Token` (Ed25519 JWT per ADR-19). The service RBAC matrix permits Ingestion to call Ontology (mapData, infer schema), Pipeline (trigger), and Execution (connector runs).

| Target | Endpoint | When | Purpose |
|---|---|---|---|
| Ontology | `POST /internal/ontology/infer` | After first batch of new connector or CSV upload | Draft ontology generation from inferred schema |
| Ontology | Redis pub/sub `ontology:map` via BullMQ | After each batch upsert | Trigger Ontology Service to map raw batch to tenant entity tables |
| Pipeline | `POST /internal/pipeline/trigger` | After sync completes (if connector has `triggerPipelineId` set) | Trigger pipeline on data arrival |
| Execution | `POST /internal/execution/run` | During sync job, per-batch (for third-party connectors only) | Run third-party connector code in sandbox |
| Plugin | `GET /internal/plugin/connectors` | At startup | Load known connector plugin types |
| Logging | Redis pub/sub `logs:ingestion` | All operations | Non-blocking structured logging |
| Auth | `GET /internal/auth/validate` | On every API request (via Gateway middleware) | JWT/API key validation (handled by core middleware) |

### 11.2 Calls Received from Other Services

| Caller | Endpoint | Purpose |
|---|---|---|
| Plugin Service | `POST /internal/ingestion/connectors` | Register new connector plugin type |
| Plugin Service | `DELETE /internal/ingestion/connectors/{pluginId}` | Unregister removed connector plugin |
| Execution Service | `GET /internal/ingestion/credentials/{connectorId}/{field}` | Fetch decrypted credential for third-party connector execution |
| Ontology Service | Direct SQL reads on `ingestion.raw_*` tables | Mapping batch reads (cross-schema SQL, not HTTP) |

### 11.3 Ontology Version Cache

The Ingestion Service maintains an in-memory cache of the current ontology schema per tenant (ADR-12). This is used for:
- Validating connector output schema against expected entity schema
- Providing `OntologyAccessor` to third-party connector plugins via `PluginContext`

Cache is populated at startup and updated via:
1. Redis pub/sub `ontology:*` channel (real-time, primary path)
2. Polling `GET /internal/ontology/schema?tenantId={id}` every 5 minutes with jitter 0-30s (safety net for missed pub/sub)

Cache misses (tenant with no ontology) are treated as "schema not yet defined" — records are staged in raw tables but the `ontology:map` job will wait until a mapping rule exists.

---

## 12. Error Handling

### 12.1 Error Code Registry

All error codes follow the `INGESTION_{ERROR}` convention per ADR-29:

| Code | HTTP Status | Retryable | Description |
|---|---|---|---|
| `INGESTION_CONNECTOR_NOT_FOUND` | 404 | No | Connector ID not found in tenant |
| `INGESTION_CONNECTOR_DISABLED` | 409 | No | Connector is disabled |
| `INGESTION_SYNC_ALREADY_RUNNING` | 409 | No | Sync is already in progress |
| `INGESTION_CONNECTOR_TIMEOUT` | 502 | Yes | Connector fetchBatch exceeded timeout |
| `INGESTION_CONNECTOR_AUTH_FAILED` | 502 | No | Connector credentials rejected by source |
| `INGESTION_CONNECTOR_RATE_LIMITED` | 502 | Yes | Source system rate limited the connector |
| `INGESTION_CONNECTOR_DATA_ERROR` | 502 | No | Source returned malformed or unprocessable data |
| `INGESTION_CONNECTOR_CONFIG_ERROR` | 400 | No | Connector configuration is invalid |
| `INGESTION_QUEUE_FULL` | 503 | Yes | BullMQ ingestion:batch queue at capacity |
| `INGESTION_WEBHOOK_HMAC_FAILED` | 200 | No | HMAC signature mismatch (always returns 200) |
| `INGESTION_WEBHOOK_NOT_FOUND` | 200 | No | Webhook ID not found (always returns 200) |
| `CREDENTIAL_DECRYPT_FAILED` | 500 | No | AES-256-GCM decryption failed (wrong key or tampered data) |
| `CREDENTIAL_NOT_FOUND` | 400 | No | Named credential field not configured for this connector |
| `UPLOAD_FILE_TOO_LARGE` | 413 | No | File exceeds OP_UPLOAD_MAX_SIZE_BYTES |
| `UPLOAD_UNSUPPORTED_TYPE` | 415 | No | MIME type not supported for upload |
| `UPLOAD_PARSE_FAILED` | 422 | No | File could not be parsed (>50% rows failed) |
| `UPLOAD_JOB_NOT_FOUND` | 404 | No | Upload job ID not found in tenant |

### 12.2 Connector Failure Handling

Connector failures during sync are classified by `PluginError` subtype:

| Error type | Retry behavior | User notification |
|---|---|---|
| `PluginAuthError` (401/403 from source) | No retry — fail immediately | "Connector credentials are invalid. Please update." |
| `PluginRateLimitError` | Delay by `retryAfterSeconds` or exponential backoff | "Connector rate limited by source. Retrying." |
| `PluginTimeoutError` | Retry with exponential backoff (max 5 attempts) | "Connector timed out. Retrying." |
| `PluginDataError` | No retry — move batch to DLQ | "Source returned unprocessable data. Review DLQ." |
| `PluginConfigError` | No retry — fail immediately | "Connector configuration error: {field}" |
| Generic `Error` | Retry with exponential backoff (treated as transient) | "Connector encountered an error. Retrying." |

### 12.3 Partial Batch Failures

A batch can partially succeed: some records upsert correctly and some fail to normalize (e.g., a required field is null in the source data). The Ingestion Service handles this as follows:

```
For each record in the batch:
  try:
    normalized = normalizeToDataEnvelope(record)
    stagingBuffer.push(normalized)
  catch NormalizationError:
    failedBuffer.push({ sourceId: record.sourceId, error: error.message })

INSERT stagingBuffer into raw table (bulk upsert)
Store failedBuffer in ingestion.batch_errors (new table not yet in §2 — see note below)
Update progress: rows_staged += stagingBuffer.length, rows_failed += failedBuffer.length
```

Partial batch failures do NOT abort the sync job. The sync completes with `status: 'success'` (if at least one record was staged) or `status: 'failed'` (if no records could be staged from any batch).

**Note:** `ingestion.batch_errors` is a supporting table for failure inspection:

```sql
CREATE TABLE ingestion.batch_errors (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_job_id  text        NOT NULL,     -- BullMQ job ID
  batch_id     uuid        NOT NULL,
  connector_id uuid        NOT NULL,
  source_id    text        NOT NULL,
  error_code   text        NOT NULL,
  error_message text       NOT NULL,
  raw_record   jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_batch_errors_sync ON ingestion.batch_errors (sync_job_id, batch_id);
-- Retention: 30 days
```

### 12.4 Credential Decryption Errors

If `decipher.final()` throws (auth tag mismatch), the Ingestion Service:

1. Logs `CRITICAL` security event: `{ code: "CREDENTIAL_DECRYPT_FAILED", connectorId, fieldName, reason: "auth_tag_mismatch" }` — this is an audit event using BullMQ delivery (never lost)
2. Does NOT reveal the reason in the API error response (only `code: "CREDENTIAL_DECRYPT_FAILED"`)
3. Aborts the sync job immediately (non-retryable)
4. Sets `ingestion.sync_state.status = 'failed'`, `last_error_code = 'CREDENTIAL_DECRYPT_FAILED'`
5. Notifies the tenant via platform event `ingestion.failed`

Auth tag mismatch indicates either:
- The encrypted blob was tampered with in the database
- The master key was rotated without completing key rotation (stale `key_version`)
- Data corruption

The operator must investigate via audit logs. The service does not attempt to self-heal.

---

## 13. Observability

### 13.1 Structured Logging

All log events are published to Redis pub/sub channel `logs:ingestion` using the `@oneplatform/core` log helper. Each event includes:

```typescript
interface LogEvent {
  timestamp: string;          // ISO 8601 UTC
  traceId: string;            // W3C Trace Context trace ID
  spanId: string;             // OTEL span ID
  service: "ingestion";
  level: "DEBUG" | "INFO" | "WARN" | "ERROR" | "CRITICAL";
  message: string;
  tenantId?: string;
  connectorId?: string;
  syncJobId?: string;
  uploadJobId?: string;
  webhookId?: string;
  [key: string]: unknown;     // structured metadata
}
```

Audit events (credential access, connector deletion, security events) use BullMQ delivery to `audit:ingestion` queue (guaranteed delivery, per ADR-17).

### 13.2 OTEL Instrumentation

The `@oneplatform/core` auto-instrumentation (ADR-21) instruments all Hono routes, BullMQ workers, Postgres queries, and Redis operations. The Ingestion Service gets the following spans automatically:

- `ingestion.connector.sync` — parent span for full sync job
- `ingestion.connector.batch` — child span per batch
- `ingestion.connector.connect` — `connector.connect()` call
- `ingestion.connector.fetchBatch` — `connector.fetchBatch()` call
- `ingestion.credential.decrypt` — credential decryption (no credential value in span attributes)
- `ingestion.raw.upsert` — Postgres bulk upsert
- `ingestion.webhook.receive` — inbound webhook processing
- `ingestion.webhook.hmac_verify` — HMAC verification
- `ingestion.upload.parse` — file parse worker

All spans include `tenantId`, `connectorId` (where applicable), and BullMQ job IDs as span attributes. Credential values and raw data samples are never included in span attributes.

### 13.3 Metrics

Prometheus metrics exposed at `GET /metrics`:

```
ingestion_syncs_total{status="success"|"failed"|"cancelled",connector_plugin_id="..."}
ingestion_batches_total{status="success"|"failed",connector_plugin_id="..."}
ingestion_records_staged_total{connector_plugin_id="..."}
ingestion_records_failed_total{connector_plugin_id="..."}
ingestion_sync_duration_seconds{quantile="0.5"|"0.95"|"0.99",connector_plugin_id="..."}
ingestion_batch_duration_seconds{quantile="0.5"|"0.95"|"0.99"}
ingestion_credential_decrypt_errors_total
ingestion_webhook_events_total{status="success"|"hmac_failed"|"dropped"}
ingestion_queue_depth{queue="ingestion:sync"|"ingestion:batch"}
ingestion_upload_jobs_total{status="complete"|"failed"}
ingestion_upload_bytes_total
```

---

## 14. Security Design

### 14.1 Threat Model

| Threat | Mitigation |
|---|---|
| SQL injection via connector ID | Connector IDs are UUID v4 (validated at creation). Table names derived only from validated UUIDs. |
| SQL injection via filter DSL | Filter field names validated against known field list. Values parameterized (never interpolated). |
| Credential theft via API | Credential values never returned in any API response. Only field names returned. |
| Credential theft via log leakage | `@oneplatform/core` redacts any key matching `*secret*`, `*password*`, `*token*`, `*credential*`, `*key*` from structured log metadata. |
| Credential theft via memory dump | Credentials cached only for sync job duration. No long-lived credential cache. |
| Master key compromise | OP_MASTER_KEY is a Docker secret or init volume, not in application code. Loss of master key means all credentials become unrecoverable (documented). |
| Credential tampering detection | AES-256-GCM auth tag detects byte-level tampering. `decipher.final()` throws on mismatch. |
| Cross-tenant data access | RLS policies on all tables keyed to `app.tenant_id` session variable. Set via `SET LOCAL` in every transaction. |
| Webhook spoofing | HMAC-SHA256 (or SHA-512) signature verification using the stored raw secret. Timing-safe comparison. |
| Webhook ID enumeration | Receiver endpoint always returns 200 OK regardless of whether the ID exists or the HMAC matches. |
| SSRF via connector config | Third-party connector fetch() calls proxied through FetchProxy, which enforces `manifest.requiredExternalUrls` allowlist and blocks all internal OnePlatform service URLs. |
| Plugin code escape | Third-party connector code runs in Execution Service sandbox (isolated-vm + op-sandbox-vm), never in Ingestion Service process. Built-in connectors are trusted compiled code. |
| Large upload DoS | 5GB file size limit. Streaming upload to MinIO (no in-memory buffering). Multipart rate-limited by Gateway. |
| Service impersonation | All internal endpoints require `X-Service-Token` Ed25519 JWT (ADR-19). Validated by `@oneplatform/core` service auth middleware. |

### 14.2 Least Privilege

| Resource | Ingestion Service access |
|---|---|
| `ingestion` schema | Full DML + DDL (owns schema) |
| `ontology`, `auth`, `pipeline`, `execution`, `plugin`, `app`, `logging`, `gateway` schemas | No access |
| Redis | `~queue:ingestion:* ~ingestion:sync:* &ontology:*` only |
| MinIO | `file-uploads` bucket: read/write. All other buckets: no access. |
| External network | No direct external access. Connector fetch goes via Execution Service FetchProxy with allowlist. |
| Docker socket | No access |

---

## 15. Testing Strategy

### 15.1 Unit Tests (Vitest)

| Module | Test scope |
|---|---|
| `src/vault/encrypt.ts` | Encrypt → decrypt roundtrip. Auth tag tamper detection. Wrong-key detection. Short-blob rejection. Key rotation idempotency. |
| `src/sync/normalize.ts` | DataRecord → DataEnvelope normalization. Deterministic _id derivation. Null cursor handling. |
| `src/sync/cursor.ts` | Cursor atomicity threshold logic (≤5000 vs >5000). Cursor update in transaction. |
| `src/webhooks/hmac.ts` | HMAC-SHA256 and SHA-512 verification. Timing-safe comparison. Signature prefix stripping. |
| `src/connectors/csv.ts` | CSV parsing (header row, type inference, empty fields, quoted commas). Large file streaming (no memory accumulation test). |
| `src/connectors/rest.ts` | fetchBatch pagination loop. Cursor extraction from response headers and body. Rate limit error propagation. |
| `src/queue/backpressure.ts` | QueueFullError when queue at maxLength. WAL write on Redis outage. WAL replay on reconnect. |
| `src/errors/classifier.ts` | PluginError subtype → retry/no-retry classification. |

Coverage target: 90% line coverage for vault and normalization modules (security-critical). 80% for other modules.

### 15.2 Integration Tests (Vitest + Testcontainers)

Integration tests spin up real infrastructure via Testcontainers:

```
Postgres (postgres:16-alpine)   — runs actual migrations, tests RLS policies
Redis (redis:7-alpine)          — tests BullMQ job lifecycle
MinIO (minio/minio)             — tests file upload streaming
```

Key integration test scenarios:

| Scenario | Verifies |
|---|---|
| Full sync job end-to-end | Connector → raw table upsert → `ontology:map` job enqueued |
| Incremental sync with cursor | Cursor stored atomically with batch insert (single transaction) |
| Sync retry on transient error | BatchJob fails twice, succeeds on third attempt, no duplicate records |
| DLQ routing after max retries | BatchJob moved to `ingestion:batch:dlq` after 5 failures |
| RLS cross-tenant isolation | Tenant A cannot read Tenant B's raw records via SQL |
| Credential encrypt/decrypt via DB | Insert encrypted credential, read and decrypt, verify plaintext matches |
| Webhook receive + HMAC pass | Record staged, `ontology:map` enqueued |
| Webhook receive + HMAC fail | No record staged, security audit event logged |
| File upload CSV end-to-end | Multipart POST → MinIO → parse job → raw table rows |
| Key rotation job | All credentials re-encrypted to new version, old key version updated |
| Large sync streaming | 100,000-record sync completes without memory growth beyond 100MB |

### 15.3 Connector Mocking

Third-party connector calls go through the Execution Service. In test environments, the Execution Service is replaced by a mock that returns configurable `BatchResult` payloads:

```typescript
class MockConnectorExecutor implements ConnectorExecutor {
  private scenarios: Map<string, BatchResult[]> = new Map();

  configure(connectorId: string, batches: BatchResult[]): void {
    this.scenarios.set(connectorId, batches);
  }

  async executeFetchBatch(connectorId: string, cursor: string | undefined): Promise<BatchResult> {
    const batches = this.scenarios.get(connectorId) ?? [];
    const index = cursor ? parseInt(cursor, 10) : 0;
    return batches[index] ?? { records: [], nextCursor: null, hasMore: false, fetchedAt: new Date().toISOString() };
  }
}
```

This mock is used in integration tests to:
- Simulate paginated responses (multiple batches)
- Simulate errors at specific batch numbers (e.g., fail on batch 3)
- Simulate rate limit errors with `retryAfterSeconds`
- Simulate very large responses (test backpressure)

Built-in connector tests (REST, PostgreSQL, CSV) use actual test servers:
- REST: `nock` HTTP interceptor library (no real network calls)
- PostgreSQL: Testcontainers `postgres:16-alpine` instance with test data
- CSV: fixture files in `tests/fixtures/`

### 15.4 Property-Based Tests

The normalization pipeline uses `fast-check` for property-based testing:

```typescript
// Property: for any valid DataRecord, deriveEnvelopeId is deterministic
fc.assert(fc.property(
  fc.record({ connectorId: fc.uuid(), sourceId: fc.string() }),
  ({ connectorId, sourceId }) => {
    const id1 = deriveEnvelopeId(connectorId, sourceId);
    const id2 = deriveEnvelopeId(connectorId, sourceId);
    return id1 === id2;  // must be deterministic
  }
));

// Property: encrypt then decrypt returns original plaintext for any string
fc.assert(fc.property(
  fc.string(),
  async (plaintext) => {
    const masterKey = crypto.randomBytes(32);
    const blob = await encrypt(plaintext, masterKey);
    const recovered = await decrypt(blob, masterKey);
    return recovered === plaintext;
  }
));
```

---

## 16. Deployment

### 16.1 Service Container

```dockerfile
# services/ingestion/Dockerfile (extends docker/Dockerfile.service)
FROM node:20-alpine AS build
WORKDIR /app
COPY pnpm-workspace.yaml package.json turbo.json ./
COPY packages/core/package.json packages/core/
COPY services/ingestion/package.json services/ingestion/
RUN corepack enable && pnpm install --frozen-lockfile
COPY packages/core/src packages/core/src/
COPY services/ingestion/src services/ingestion/src/
RUN pnpm turbo build --filter=ingestion-service

FROM node:20-alpine AS runtime
RUN addgroup -S ingestion && adduser -S ingestion -G ingestion
WORKDIR /app
COPY --from=build /app/services/ingestion/dist ./dist
COPY --from=build /app/node_modules ./node_modules
USER ingestion
EXPOSE 3002
HEALTHCHECK --interval=10s --timeout=5s --retries=12 CMD wget -qO- http://localhost:3002/healthz || exit 1
CMD ["node", "dist/index.js"]
```

### 16.2 Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `OP_MASTER_KEY` | Yes | — | Base64-encoded 32-byte AES master key (from init volume) |
| `OP_DATABASE_URL` | Yes | — | PgBouncer connection string for ingestion_service_role |
| `OP_REDIS_URL` | Yes | — | Redis connection string |
| `OP_MINIO_ENDPOINT` | Yes | — | MinIO endpoint URL (`http://minio:9000`) |
| `OP_MINIO_ACCESS_KEY` | Yes | — | MinIO access key for ingestion-service user |
| `OP_MINIO_SECRET_KEY` | Yes | — | MinIO secret key |
| `OP_SERVICE_PRIVATE_KEY_PATH` | Yes | `/data/service.key` | Path to Ed25519 private key for service token signing |
| `OP_SERVICE_KEYS_DIR` | Yes | `/data/service-keys` | Directory of other services' Ed25519 public keys |
| `OP_PORT` | No | `3002` | HTTP listening port |
| `OP_INGESTION_BATCH_SIZE` | No | `1000` | Records per batch (max 10000) |
| `OP_INGESTION_WORKER_CONCURRENCY` | No | `10` | Concurrent batch workers |
| `OP_LARGE_SYNC_CONCURRENCY` | No | `3` | Concurrency for syncs >1M records |
| `OP_UPLOAD_MAX_SIZE_BYTES` | No | `5368709120` (5GB) | Maximum upload file size |
| `OP_UPLOAD_MAX_FAILURE_RATE` | No | `0.5` | Max fraction of parse failures before aborting |
| `OP_CURSOR_SECRET` | Yes | — | HMAC-SHA256 secret for pagination cursor signing |
| `OP_BASE_URL` | No | `http://localhost:3000` | Platform base URL (for webhook receive URLs) |
| `OP_LOG_LEVEL` | No | `INFO` | Minimum log level (DEBUG/INFO/WARN/ERROR) |
| `OP_OTEL_ENDPOINT` | No | — | OTEL exporter endpoint (omit to disable tracing) |
| `OP_WEBHOOK_ALLOW_HTTP` | No | `false` | Allow HTTP (non-HTTPS) webhook sources in dev mode |

### 16.3 Docker Compose Service Definition

```yaml
ingestion-service:
  build:
    context: .
    dockerfile: services/ingestion/Dockerfile
  image: oneplatform/ingestion-service:latest
  container_name: ingestion-service
  restart: unless-stopped
  networks:
    - oneplatform-internal
  ports: []                          # No host-mapped port — internal only
  environment:
    OP_DATABASE_URL: postgres://ingestion_service_role:${INGESTION_DB_PASS}@pgbouncer:5432/oneplatform?sslmode=disable
    OP_REDIS_URL: redis://:${REDIS_PASS}@redis:6379/0
    OP_MINIO_ENDPOINT: http://minio:9000
    OP_MINIO_ACCESS_KEY: ingestion-service
    OP_MINIO_SECRET_KEY: ${MINIO_INGESTION_PASS}
    OP_CURSOR_SECRET: ${OP_CURSOR_SECRET}
    OP_BASE_URL: ${OP_BASE_URL:-http://localhost:3000}
  volumes:
    - init-data:/data/init:ro          # read OP_MASTER_KEY
    - ingestion-service-data:/data     # service key + WAL file
    - service-keys:/data/service-keys:ro # other services' public keys
  depends_on:
    postgres:
      condition: service_healthy
    redis:
      condition: service_healthy
    auth-service:
      condition: service_healthy
    minio:
      condition: service_healthy
  healthcheck:
    test: ["CMD", "wget", "-qO-", "http://localhost:3002/healthz"]
    interval: 10s
    timeout: 5s
    retries: 12
    start_period: 30s
  deploy:
    resources:
      limits:
        memory: 1024M
        cpus: "2.0"
      reservations:
        memory: 256M
        cpus: "0.5"
```

### 16.4 Data Volume Layout

```
/data/
  service.key          Ed25519 private key (600, owned by ingestion user)
  job-buffer.wal       BullMQ WAL for Redis outage recovery (max 50MB)

/data/init/            (read-only mount from init container)
  master.key           OP_MASTER_KEY base64 value

/data/service-keys/    (read-only mount)
  auth-service.pub     Ed25519 public keys for all other services
  gateway-service.pub
  ontology-service.pub
  pipeline-service.pub
  execution-service.pub
  app-service.pub
  logging-service.pub
  plugin-service.pub
```

---

## 17. Open Questions and Future Work

These items are known gaps deferred from this design for explicit decision:

1. **Incremental delete detection for connectors without soft-delete support.** The current design detects source deletions only in full sync mode (by marking records not in current `_batch_id`). Connectors that use incremental mode but whose source systems delete records without emitting a change event will miss deletes. Resolution requires either (a) periodic full syncs as a reconciliation step, or (b) a connector-declared `supportsDeletionDetection` capability that tells the platform to run a periodic full sync alongside incremental.

2. **Webhook replay for missed events.** If the Ingestion Service is down when an external system sends a webhook event, the event is lost. Resolution options: (a) partner with a webhook relay service, (b) document that critical webhook sources should implement retry with exponential backoff, or (c) implement an optional webhook queue (BullMQ-backed receive endpoint) that buffers events in Redis during outages.

3. **Multi-region raw table access.** As tenants grow, raw tables may need to be sharded or moved to tenant-specific databases. The current design (single shared Postgres with per-connector tables) will hit write throughput limits for very high-volume connectors. The documented upgrade path (ADR-5) is to split the ingestion schema to its own Postgres instance — this document will need a revision when that split occurs.

4. **Real-time connector support.** Connectors with `supportsRealtime: true` and a `subscribeToEvents()` method are not yet handled by the sync engine. The current design covers only batch `fetchBatch()` connectors. Real-time connector support requires a persistent subscription worker design (long-running BullMQ job or dedicated process) and is deferred to a follow-on design document.

5. **Credential field-level audit log.** Currently, credential access is logged at the connector level. For compliance requirements (SOC 2, GDPR), field-level audit logs (which field was accessed, when, by which sync job) may be required. This would add one `ingestion.credential_access_log` row per `CredentialAccessor.get()` call — acceptable overhead but not yet designed.
