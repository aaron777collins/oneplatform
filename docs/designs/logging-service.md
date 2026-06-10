# Logging Service — L2 Service Design

**Document status:** Approved for implementation  
**Service:** Logging Service  
**Port:** 3007  
**Schema:** `logging`  
**ADR references:** ADR-17 (Logging Architecture), ADR-18 (Redis Resilience), ADR-19 (Service-to-Service Auth), ADR-21 (Observability), ADR-29 (API Contract Standard)  
**L1 reference:** `docs/superpowers/specs/2026-06-10-oneplatform-design.md` sections 7.8 and 12

---

## Table of Contents

1. [Service Overview](#1-service-overview)
2. [Database Schema](#2-database-schema)
3. [Log Ingestion Pipeline](#3-log-ingestion-pipeline)
4. [Audit Event Pipeline](#4-audit-event-pipeline)
5. [API Endpoints](#5-api-endpoints)
6. [Query API](#6-query-api)
7. [SSE Streaming](#7-sse-streaming)
8. [Export](#8-export)
9. [Internal Endpoint](#9-internal-endpoint)
10. [Retention Management](#10-retention-management)
11. [Trace Correlation](#11-trace-correlation)
12. [Observability](#12-observability)
13. [Error Handling](#13-error-handling)
14. [Scale Path](#14-scale-path)
15. [Testing Strategy](#15-testing-strategy)
16. [Configuration Reference](#16-configuration-reference)

---

## 1. Service Overview

### Responsibility

The Logging Service is the single write destination for all structured log events and all audit events across the platform. It is a pure consumer: it emits nothing to other services. Its responsibilities are:

- Subscribe to `logs:*` Redis pub/sub channels published by all 9 services and persist events to Postgres in time-batched bulk inserts.
- Consume the `audit` BullMQ queue with guaranteed-delivery semantics and persist events to `logging.audit_events`.
- Provide a query API for the frontend log viewer, the CLI (`op logs`), and the App Service (which calls `/internal/logging/query` on behalf of the dashboard trace viewer).
- Provide SSE streaming for live log tailing.
- Provide JSONL and CSV export for bulk log extraction.
- Manage retention by dropping old partitions on a scheduled basis.

### Network Placement

The service runs exclusively on the `oneplatform-internal` Docker network. It has no presence on `oneplatform-public` or `oneplatform-sandbox`. External traffic reaches it only through the Gateway.

```
oneplatform-public  (Gateway, Frontend)
        |
oneplatform-internal:
  Gateway :3000 → Logging :3007   (proxied API calls)
  App     :3006 → Logging :3007   (internal/logging/query)
  All 9 services → Redis pub/sub  (logs:*)
  All 9 services → BullMQ queue   (audit)
  Logging :3007 → Postgres        (writes + queries)
  Logging :3007 → Redis           (PSUBSCRIBE + BullMQ consumer)
```

### Startup Dependencies

The Logging Service must not accept traffic until the following are ready (enforced via Docker Compose `depends_on` conditions):

| Dependency | Condition | Reason |
|---|---|---|
| Postgres | `service_healthy` | Schema migrations run at startup |
| Redis | `service_healthy` | pub/sub subscription and BullMQ consumer |
| `op-init` | `service_completed_successfully` | Ensures `OP_MASTER_KEY` and service keys are written before startup |

The service's own `readyz` probe verifies both the Postgres connection pool and the Redis subscription are active before the service reports ready.

### Startup Sequence

1. Load and validate all `OP_*` environment variables (via `@oneplatform/core` config loader). Fatal exit on missing required vars.
2. Run Postgres migrations: create `logging` schema, create tables, create indexes, create initial monthly partition for the current month and the next month.
3. Register the Ed25519 service keypair from `/data/service.key`.
4. Open the Redis connection, issue `PSUBSCRIBE logs:*`.
5. Start the BullMQ audit worker with concurrency 5.
6. Start the retention scheduler (daily at 02:00 UTC).
7. Start the partition pre-creation scheduler (first day of each month at 00:05 UTC).
8. Start the Hono HTTP server on port 3007.
9. Report `/readyz` healthy.

---

## 2. Database Schema

### Schema Setup

```sql
CREATE SCHEMA IF NOT EXISTS logging;
GRANT USAGE ON SCHEMA logging TO logging_service_role;
```

### 2.1 logging.events (Time-Partitioned)

```sql
CREATE TABLE logging.events (
  id          UUID        NOT NULL DEFAULT gen_random_uuid(),
  trace_id    TEXT        NOT NULL DEFAULT '',
  service     TEXT        NOT NULL,
  level       TEXT        NOT NULL CHECK (level IN ('debug','info','warn','error')),
  message     TEXT        NOT NULL,
  metadata    JSONB       NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Full-text search vector, populated by trigger
  search_vec  TSVECTOR    GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(message, '') || ' ' || coalesce(metadata::text, ''))
  ) STORED
) PARTITION BY RANGE (created_at);
```

**Rationale for `search_vec` as a generated column:** The tsvector is computed once at insert time and stored. Query-time `to_tsvector()` calls on large partitions are prohibitively slow. Storing it means the GIN index below covers all rows without per-query overhead.

**Rationale for `DEFAULT ''` on `trace_id`:** System startup events (e.g., database migration logs) are emitted before a trace context exists. An empty string is cheaper to store and index than NULL and avoids NULLable index semantics.

#### Monthly Partitions

Partitions are named `logging.events_YYYY_MM`. The service pre-creates the current and next month at startup, and pre-creates the next month on the first day of each month.

```sql
-- Example: partition for 2026-06
CREATE TABLE logging.events_2026_06
  PARTITION OF logging.events
  FOR VALUES FROM ('2026-06-01 00:00:00+00')
             TO   ('2026-07-01 00:00:00+00');

-- Example: partition for 2026-07
CREATE TABLE logging.events_2026_07
  PARTITION OF logging.events
  FOR VALUES FROM ('2026-07-01 00:00:00+00')
             TO   ('2026-08-01 00:00:00+00');
```

Partition creation is idempotent: the service uses `CREATE TABLE IF NOT EXISTS ... PARTITION OF ...`. If a partition already exists, the statement is a no-op.

#### Indexes on Each Partition

The following indexes are created on each new partition immediately after the `CREATE TABLE ... PARTITION OF` statement. Indexes on the parent partitioned table are automatically inherited by new partitions in Postgres 13+, but are defined explicitly here for clarity:

```sql
-- Primary key (per-partition BTREE)
ALTER TABLE logging.events_YYYY_MM ADD PRIMARY KEY (id, created_at);

-- Service + level filter (most common dashboard query pattern)
CREATE INDEX ON logging.events_YYYY_MM (service, level, created_at DESC);

-- Trace correlation (full trace chain query)
CREATE INDEX ON logging.events_YYYY_MM (trace_id, created_at DESC)
  WHERE trace_id <> '';

-- Full-text search
CREATE INDEX ON logging.events_YYYY_MM USING GIN (search_vec);

-- Pure time range (for export and retention scan)
CREATE INDEX ON logging.events_YYYY_MM (created_at DESC);
```

**Rationale:** The composite `(service, level, created_at DESC)` index covers the dominant query pattern from the log viewer: "show ERROR logs from service X in the last 24 hours." The partial index on `trace_id` excludes empty-string rows, keeping the index compact.

#### Parent-Level Index Definitions

These are defined on the parent table so Postgres automatically creates them on each new partition:

```sql
CREATE INDEX ON logging.events (service, level, created_at DESC);
CREATE INDEX ON logging.events (trace_id, created_at DESC) WHERE trace_id <> '';
CREATE INDEX ON logging.events USING GIN (search_vec);
CREATE INDEX ON logging.events (created_at DESC);
```

### 2.2 logging.audit_events

Audit events are never partitioned or dropped within their minimum retention window. They use a simple append-only table with a covering index for compliance queries.

```sql
CREATE TABLE logging.audit_events (
  id            UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  trace_id      TEXT        NOT NULL DEFAULT '',
  actor_id      TEXT        NOT NULL,
  actor_type    TEXT        NOT NULL CHECK (actor_type IN ('user','service','system')),
  tenant_id     TEXT        NOT NULL,
  action        TEXT        NOT NULL,
  resource_type TEXT        NOT NULL,
  resource_id   TEXT        NOT NULL,
  result        TEXT        NOT NULL CHECK (result IN ('success','failure')),
  metadata      JSONB       NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Soft-delete flag: audit rows are never hard-deleted within retention window.
  -- Set to TRUE only by the retention job AFTER the 1-year minimum has elapsed.
  archived      BOOLEAN     NOT NULL DEFAULT FALSE
);

-- Compliance query: all actions on a resource
CREATE INDEX ON logging.audit_events (resource_type, resource_id, created_at DESC);

-- Actor audit trail: all actions by a user or service
CREATE INDEX ON logging.audit_events (actor_id, created_at DESC);

-- Tenant-scoped compliance queries
CREATE INDEX ON logging.audit_events (tenant_id, created_at DESC);

-- Trace correlation: find audit events in a distributed trace
CREATE INDEX ON logging.audit_events (trace_id, created_at DESC) WHERE trace_id <> '';

-- Retention job: find eligible rows
CREATE INDEX ON logging.audit_events (created_at DESC) WHERE archived = FALSE;
```

### 2.3 logging.archive (Cold Storage — Phase 2)

This table is created during the cold storage migration phase (see Scale Path section). It is not created at initial deployment.

```sql
-- Created only when cold storage migration is activated
CREATE TABLE logging.archive (
  LIKE logging.events INCLUDING ALL
);
-- Populated by the partition migration job; no new inserts from the ingestion pipeline.
```

### 2.4 Partition Management Table

Used by the retention and partition pre-creation jobs to track state without relying on `information_schema` queries in hot paths.

```sql
CREATE TABLE logging.partition_registry (
  partition_name  TEXT        NOT NULL PRIMARY KEY,
  table_name      TEXT        NOT NULL,  -- e.g. 'events'
  period_start    TIMESTAMPTZ NOT NULL,
  period_end      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  dropped_at      TIMESTAMPTZ,
  archived_at     TIMESTAMPTZ
);

CREATE INDEX ON logging.partition_registry (table_name, period_start);
```

### 2.5 Grants

```sql
GRANT SELECT, INSERT ON logging.events         TO logging_service_role;
GRANT SELECT, INSERT, UPDATE ON logging.audit_events TO logging_service_role;
GRANT SELECT, INSERT, UPDATE ON logging.partition_registry TO logging_service_role;
-- DROP PARTITION requires superuser or table owner; the logging_service_role owns
-- the logging schema so it inherits ownership of tables it creates.
ALTER SCHEMA logging OWNER TO logging_service_role;
```

---

## 3. Log Ingestion Pipeline

### 3.1 Redis Subscription

On startup the service issues one PSUBSCRIBE command:

```
PSUBSCRIBE logs:*
```

This single subscription receives events from all 9 services. The channel name embeds the service name (`logs:gateway`, `logs:auth`, etc.) as a free filter dimension. The Logging Service does not connect to a separate subscriber Redis client — it uses the same ioredis connection dedicated to pub/sub (ioredis requires a connection in subscriber mode cannot issue regular commands; a second connection handles all other Redis operations).

**Two Redis connections are maintained:**
- `redisSubscriber`: `PSUBSCRIBE logs:*` — subscriber mode, receive-only.
- `redisClient`: all other commands (BullMQ, health checks, in-memory buffer flush).

### 3.2 Message Parsing

Each message arriving on `logs:*` is a JSON string matching the `LogEvent` type from `@oneplatform/core`:

```typescript
// From @oneplatform/core/src/logger.ts
interface LogEvent {
  timestamp: string;            // ISO 8601
  traceId: string;
  service: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  metadata: Record<string, unknown>;
}
```

The ingestion pipeline validates each message with Zod before buffering it. Malformed messages (invalid JSON, missing required fields, unknown level) are counted in the `log_parse_errors_total` metric and discarded — they are not retried. The channel name provides a redundant `service` value; the parsed `event.service` field takes precedence. If the two disagree, the parsed field is used and a `warn` event is emitted on the internal logger (avoiding a publish loop by using `console.warn` for this specific case).

```typescript
const LogEventSchema = z.object({
  timestamp: z.string().datetime(),
  traceId:   z.string().default(''),
  service:   z.string().min(1).max(64),
  level:     z.enum(['debug', 'info', 'warn', 'error']),
  message:   z.string().max(32_768),  // 32KB cap per message
  metadata:  z.record(z.unknown()).default({}),
});
```

The `metadata` field is accepted as-is (no deep validation). Any value that does not serialize to valid JSONB (e.g., circular references — impossible in a JSON parse result) is replaced with `{ _truncated: true, _reason: 'not_serializable' }`.

### 3.3 Batch Accumulator

The batch accumulator buffers parsed events in memory and flushes them to Postgres using a single `INSERT ... SELECT unnest($1, ...)` bulk insert. Two flush triggers fire whichever comes first:

| Trigger | Threshold | Rationale |
|---|---|---|
| Time elapsed | 1 second | Caps end-to-end latency for live log viewers |
| Buffer size | 1,000 events | Caps per-transaction row count for Postgres throughput |

Implementation:

```typescript
class BatchAccumulator {
  private buffer: ParsedLogEvent[] = [];
  private timer: NodeJS.Timeout | null = null;

  push(event: ParsedLogEvent): void {
    this.buffer.push(event);
    if (this.buffer.length >= BATCH_SIZE_LIMIT) {
      this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), BATCH_INTERVAL_MS);
    }
  }

  private flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0, this.buffer.length);
    // Non-blocking: flush runs in the background; failures go to error handler
    this.insertBatch(batch).catch(err => this.handleInsertFailure(batch, err));
  }
}
```

Constants (configurable via environment variables):

| Constant | Default | Env var |
|---|---|---|
| `BATCH_SIZE_LIMIT` | 1000 | `OP_LOG_BATCH_SIZE` |
| `BATCH_INTERVAL_MS` | 1000 | `OP_LOG_BATCH_INTERVAL_MS` |
| `IN_MEMORY_BUFFER_MAX` | 10000 | `OP_LOG_MEMORY_BUFFER_MAX` |

### 3.4 Postgres Bulk Insert

The flush operation uses a single unnest-based insert for efficiency. Wrapping each event in a separate `INSERT` would produce 1,000 individual round-trips per batch.

```sql
INSERT INTO logging.events
  (trace_id, service, level, message, metadata, created_at)
SELECT
  unnest($1::text[])        AS trace_id,
  unnest($2::text[])        AS service,
  unnest($3::text[])        AS level,
  unnest($4::text[])        AS message,
  unnest($5::jsonb[])       AS metadata,
  unnest($6::timestamptz[]) AS created_at
ON CONFLICT DO NOTHING;
```

`ON CONFLICT DO NOTHING` is the idempotency guard for the rare case where a buffer is flushed twice (e.g., a retry after a transient Postgres error on a batch that partially committed). Because `id` is not in the insert list, Postgres generates a new UUID on each row — `ON CONFLICT DO NOTHING` operates on the primary key, so this is only relevant if the same batch is submitted twice. The more important safety net is the fallback buffer logic described below.

### 3.5 In-Memory Fallback Buffer

When the Redis subscription drops (network partition, Redis restart), events stop arriving and the service cannot flush to Postgres. When Redis reconnects, the backlog resumes. The in-memory buffer handles the reconnect surge.

When a batch insert to Postgres fails (not a Redis failure), the batch is placed into the in-memory fallback buffer:

```typescript
private handleInsertFailure(batch: ParsedLogEvent[], err: Error): void {
  metrics.increment('log_batch_insert_failures_total');
  logger.error('Batch insert failed', { batchSize: batch.length, error: err.message });

  const available = IN_MEMORY_BUFFER_MAX - this.memoryBuffer.length;
  if (available <= 0) {
    // Buffer full: emit to fallback file, then discard
    this.fallbackFile.write(batch);
    metrics.increment('log_memory_buffer_overflow_total', batch.length);
    return;
  }
  const toBuffer = batch.slice(0, available);
  const toFile    = batch.slice(available);
  this.memoryBuffer.push(...toBuffer);
  if (toFile.length > 0) {
    this.fallbackFile.write(toFile);
  }
  this.scheduleRetry();
}
```

The in-memory buffer drains via exponential backoff retries (initial 2s, max 60s, factor 2) against Postgres. On successful reconnect the entire buffer is flushed in chunks of `BATCH_SIZE_LIMIT`.

### 3.6 Fallback File Writer

When the in-memory buffer is full (10,000 events), overflow events are appended to a fallback file. This is also the path for Redis-down scenarios where the @oneplatform/core logger writes its own fallback file on the producer side; the Logging Service's fallback file is for its own Postgres write failures.

```
File path: /data/log-fallback.jsonl
Max size:  100 MB
Rotation:  On reaching 100 MB, rename to /data/log-fallback.jsonl.1 (overwriting any
           existing .1 file), then open a new /data/log-fallback.jsonl.
           The .1 file is the oldest surviving overflow data.
```

**Write format:** one JSON object per line (JSONL), matching the `LogEvent` schema. Writes use `fs.appendFileSync` for atomic line-level durability. On startup, the service checks for `/data/log-fallback.jsonl` and `/data/log-fallback.jsonl.1` and replays them into Postgres before accepting new events, then truncates both files.

**Fallback file replay on startup:**

```typescript
async function replayFallbackFiles(): Promise<void> {
  for (const path of ['/data/log-fallback.jsonl.1', '/data/log-fallback.jsonl']) {
    if (!existsSync(path)) continue;
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    const parsed = lines.flatMap(line => {
      const result = LogEventSchema.safeParse(JSON.parse(line));
      return result.success ? [result.data] : [];
    });
    // Insert in batches of BATCH_SIZE_LIMIT
    for (let i = 0; i < parsed.length; i += BATCH_SIZE_LIMIT) {
      await insertBatch(parsed.slice(i, i + BATCH_SIZE_LIMIT));
    }
    unlinkSync(path);
  }
}
```

---

## 4. Audit Event Pipeline

### 4.1 BullMQ Queue

Audit events are published by services via `@oneplatform/core`'s `auditQueue.add('audit.event', full, { attempts: 5, backoff: { type: 'exponential', delay: 1000 } })`. The Logging Service consumes the `audit` queue.

Queue name: `audit`  
Worker concurrency: 5 (configurable via `OP_AUDIT_WORKER_CONCURRENCY`)  
Job name pattern: `audit.event`

### 4.2 Job Schema Validation

```typescript
const AuditEventJobSchema = z.object({
  timestamp:    z.string().datetime(),
  traceId:      z.string().default(''),
  actorId:      z.string().min(1).max(255),
  actorType:    z.enum(['user', 'service', 'system']),
  tenantId:     z.string().min(1).max(255),
  action:       z.string().min(1).max(255),
  resourceType: z.string().min(1).max(255),
  resourceId:   z.string().min(1).max(255),
  result:       z.enum(['success', 'failure']),
  metadata:     z.record(z.unknown()).default({}),
});
```

Jobs that fail schema validation are moved to the dead-letter queue (`audit-dlq`) immediately — they are never retried because retry would produce the same validation failure. A `log_audit_schema_failures_total` metric is incremented and an alert fires if this counter is non-zero (schema failures indicate a producer bug that must be fixed, not retried).

### 4.3 Guaranteed Delivery Semantics

BullMQ provides at-least-once delivery. The Logging Service must be idempotent for audit jobs. Idempotency is enforced by a unique constraint on the BullMQ job ID stored in metadata:

```sql
ALTER TABLE logging.audit_events
  ADD COLUMN job_id TEXT;
CREATE UNIQUE INDEX ON logging.audit_events (job_id) WHERE job_id IS NOT NULL;
```

The worker extracts `job.id` from BullMQ and passes it as `job_id`:

```typescript
worker.on('active', async (job) => {
  const event = AuditEventJobSchema.parse(job.data);
  await db.query(`
    INSERT INTO logging.audit_events
      (trace_id, actor_id, actor_type, tenant_id, action, resource_type,
       resource_id, result, metadata, created_at, job_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT (job_id) DO NOTHING
  `, [event.traceId, event.actorId, event.actorType, event.tenantId,
      event.action, event.resourceType, event.resourceId, event.result,
      event.metadata, event.timestamp, job.id]);
});
```

`ON CONFLICT (job_id) DO NOTHING` makes replayed jobs safe. Because BullMQ marks a job complete only after the worker function resolves, a Postgres failure causes BullMQ to retry the job — and the deduplication key prevents a duplicate row.

### 4.4 WAL Backup File (Producer Side)

The WAL file is written by the producer service's `@oneplatform/core` logger when BullMQ itself cannot enqueue (Redis is down). The Logging Service does not write this file. On Redis reconnect, the producer's `core` library replays the WAL into BullMQ, which then delivers the jobs to the Logging Service's worker normally.

This is documented here because the audit delivery guarantee depends on understanding the full chain:

```
producer service
  → BullMQ add (Redis) --[Redis down]--> WAL file /data/job-buffer.wal
  → [Redis up] WAL replay → BullMQ add (Redis) → Logging Service worker
  → INSERT logging.audit_events ON CONFLICT (job_id) DO NOTHING
```

No audit event is lost as long as the producer service's data volume is intact when Redis recovers.

### 4.5 Dead-Letter Queue

Jobs that exhaust all 5 retry attempts land in `audit-dlq`. The Logging Service exposes an admin endpoint to inspect and replay DLQ jobs (see Section 5). The DLQ is monitored: if depth exceeds 100, a `CRITICAL` alert fires.

---

## 5. API Endpoints

### 5.1 Endpoint Summary

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/v1/logs` | User JWT / API key | Query log events |
| `GET` | `/api/v1/logs/stream` | User JWT / API key | SSE live tail |
| `GET` | `/api/v1/logs/export` | User JWT / API key | JSONL or CSV export |
| `GET` | `/api/v1/audit` | User JWT / API key (admin scope) | Query audit events |
| `GET` | `/api/v1/audit/export` | User JWT / API key (admin scope) | Audit export |
| `GET` | `/internal/logging/query` | X-Service-Token | Service-to-service log query |
| `GET` | `/healthz` | None | Liveness probe |
| `GET` | `/readyz` | None | Readiness probe |
| `GET` | `/metrics` | None (internal network) | Prometheus metrics |

### 5.2 Authentication and Authorization

All `/api/v1/` endpoints require a valid user JWT or API key in the `Authorization: Bearer <token>` header. This is enforced by the standard `auth` middleware from `@oneplatform/core`.

**Required scopes/roles:**

| Endpoint group | Required role | Notes |
|---|---|---|
| `GET /api/v1/logs` | `logs:read` | Tenant-scoped: users see only logs from their tenant's services |
| `GET /api/v1/logs/stream` | `logs:read` | Same scoping as query |
| `GET /api/v1/logs/export` | `logs:export` | Subset of `logs:read`; separate scope to control bulk access |
| `GET /api/v1/audit` | `audit:read` | Admin-only scope; non-admins receive 403 |
| `GET /api/v1/audit/export` | `audit:export` | Admin-only scope |

**Tenant scoping:** the `logs` table does not have a `tenant_id` column — services are platform-level concerns. Log access is therefore scoped by which services a user's role permits them to view. The `service` filter in each query is validated against the user's allowed services from the RBAC system. A user with no explicit service permissions sees only the services they own (their app's service name). Platform admins see all services.

**Internal endpoint:** `GET /internal/logging/query` validates `X-Service-Token` and the service RBAC matrix. Only `app-service` is in the allowed caller list for this endpoint (per ADR-19 service permission matrix).

### 5.3 Standard Response Envelopes

All responses follow the platform standard (ADR-29):

```typescript
// Success
{ data: T }

// Collection
{ data: T[], pagination: { cursor: string | null, limit: number, hasMore: boolean } }

// Error
{ error: { code: string, message: string, requestId: string } }
```

### 5.4 Zod Request Schemas

#### GET /api/v1/logs

```typescript
const LogQuerySchema = z.object({
  // Filtering
  service:   z.string().min(1).max(64).optional(),
  level:     z.enum(['debug','info','warn','error']).optional(),
  traceId:   z.string().max(128).optional(),
  query:     z.string().max(512).optional(),   // full-text search
  startTime: z.string().datetime().optional(), // ISO 8601
  endTime:   z.string().datetime().optional(), // ISO 8601
  // Pagination
  cursor:    z.string().max(512).optional(),
  limit:     z.number().int().min(1).max(500).default(100),
});

type LogQueryParams = z.infer<typeof LogQuerySchema>;
```

#### GET /api/v1/logs/stream

```typescript
const LogStreamSchema = z.object({
  service: z.string().min(1).max(64).optional(),
  level:   z.enum(['debug','info','warn','error']).optional(),
  traceId: z.string().max(128).optional(),
});
```

#### GET /api/v1/logs/export

```typescript
const LogExportSchema = z.object({
  service:   z.string().min(1).max(64).optional(),
  level:     z.enum(['debug','info','warn','error']).optional(),
  traceId:   z.string().max(128).optional(),
  startTime: z.string().datetime(),    // required for export
  endTime:   z.string().datetime(),    // required for export
  format:    z.enum(['jsonl','csv']).default('jsonl'),
});
```

`startTime` and `endTime` are required for export to prevent unbounded full-table scans. Maximum export window is 7 days per request (enforced: `endTime - startTime <= 7 days`). Larger exports require multiple requests with sequential time windows.

#### GET /api/v1/audit

```typescript
const AuditQuerySchema = z.object({
  actorId:      z.string().max(255).optional(),
  actorType:    z.enum(['user','service','system']).optional(),
  tenantId:     z.string().max(255).optional(),
  action:       z.string().max(255).optional(),
  resourceType: z.string().max(255).optional(),
  resourceId:   z.string().max(255).optional(),
  result:       z.enum(['success','failure']).optional(),
  traceId:      z.string().max(128).optional(),
  startTime:    z.string().datetime().optional(),
  endTime:      z.string().datetime().optional(),
  cursor:       z.string().max(512).optional(),
  limit:        z.number().int().min(1).max(500).default(100),
});
```

### 5.5 Error Codes

| HTTP status | Code | When |
|---|---|---|
| 400 | `INVALID_QUERY` | Query parameter validation failed |
| 400 | `INVALID_CURSOR` | Cursor HMAC signature invalid |
| 400 | `INVALID_TIME_RANGE` | `endTime` before `startTime`, or export window exceeds 7 days |
| 401 | `UNAUTHORIZED` | Missing or invalid auth token |
| 403 | `FORBIDDEN` | Insufficient scope (e.g., non-admin accessing audit) |
| 410 | `CURSOR_EXPIRED` | Cursor older than 24 hours |
| 429 | `RATE_LIMITED` | Rate limit exceeded (standard platform headers) |
| 500 | `INTERNAL_ERROR` | Unexpected server error |
| 503 | `SERVICE_UNAVAILABLE` | Postgres unavailable (query path) |

---

## 6. Query API

### 6.1 SQL Generation

The query handler translates validated `LogQueryParams` into a parameterized SQL query. Dynamic SQL construction is done via a safe query builder (no string interpolation of user values):

```typescript
function buildLogQuery(params: LogQueryParams, tenantServices: string[]): {
  sql: string;
  args: unknown[];
} {
  const conditions: string[] = [];
  const args: unknown[] = [];
  let n = 1;

  // Tenant service scope — always applied
  conditions.push(`service = ANY($${n++})`);
  args.push(tenantServices);

  if (params.service) {
    // Validate params.service is within tenantServices — done at auth layer
    conditions.push(`service = $${n++}`);
    args.push(params.service);
  }
  if (params.level) {
    conditions.push(`level = $${n++}`);
    args.push(params.level);
  }
  if (params.traceId) {
    conditions.push(`trace_id = $${n++}`);
    args.push(params.traceId);
  }
  if (params.query) {
    conditions.push(`search_vec @@ plainto_tsquery('english', $${n++})`);
    args.push(params.query);
  }
  if (params.startTime) {
    conditions.push(`created_at >= $${n++}`);
    args.push(params.startTime);
  }
  if (params.endTime) {
    conditions.push(`created_at < $${n++}`);
    args.push(params.endTime);
  }

  const where = conditions.length > 0
    ? `WHERE ${conditions.join(' AND ')}`
    : '';

  // Cursor decode and inject
  let cursorClause = '';
  if (params.cursor) {
    const decoded = decodeCursor(params.cursor); // HMAC-verified
    cursorClause = `AND (created_at, id) < ($${n++}::timestamptz, $${n++}::uuid)`;
    args.push(decoded.createdAt, decoded.id);
  }

  args.push(params.limit + 1); // fetch one extra to determine hasMore

  return {
    sql: `
      SELECT id, trace_id, service, level, message, metadata, created_at
      FROM logging.events
      ${where} ${cursorClause}
      ORDER BY created_at DESC, id DESC
      LIMIT $${n}
    `,
    args,
  };
}
```

The `(created_at, id)` keyset cursor is stable under concurrent inserts (new inserts have newer `created_at` values and do not shift existing page windows). The `id` tiebreaker handles the rare case of multiple events with the same millisecond timestamp.

### 6.2 Cursor Encoding

Cursors are signed with `OP_CURSOR_SECRET` (HMAC-SHA256) and base64url-encoded per ADR-29:

```typescript
interface LogCursor {
  createdAt: string; // ISO 8601
  id: string;        // UUID of last returned row
}

function encodeCursor(row: { created_at: Date; id: string }): string {
  const payload: LogCursor = {
    createdAt: row.created_at.toISOString(),
    id: row.id,
  };
  const json = JSON.stringify(payload);
  const sig = hmacSha256(json, process.env.OP_CURSOR_SECRET!);
  return base64url.encode(JSON.stringify({ payload: json, sig }));
}

function decodeCursor(cursor: string): LogCursor {
  const { payload, sig } = JSON.parse(base64url.decode(cursor));
  const expected = hmacSha256(payload, process.env.OP_CURSOR_SECRET!);
  if (!timingSafeEqual(sig, expected)) throw new AppError('INVALID_CURSOR', 400);
  const decoded: LogCursor = JSON.parse(payload);
  const age = Date.now() - new Date(decoded.createdAt).getTime();
  if (age > 24 * 60 * 60 * 1000) throw new AppError('CURSOR_EXPIRED', 410);
  return decoded;
}
```

### 6.3 Full-Text Search

When `params.query` is provided, the `search_vec` GIN index is used. The search uses `plainto_tsquery` (not `to_tsquery`) to handle unstructured user input safely — `plainto_tsquery` normalizes the input and never throws a syntax error on special characters.

If the caller wants exact phrase matching, they enclose the phrase in double quotes: `query="pipeline failed"`. The handler detects quoted phrases and uses `phraseto_tsquery` instead.

**Interaction with other filters:** full-text search ANDs with all other filters. A query of `?service=gateway&query=rate+limit` returns only gateway service events containing "rate limit."

### 6.4 Response Structure

```typescript
interface LogsResponse {
  data: LogEvent[];
  pagination: {
    cursor: string | null;  // null when hasMore is false
    limit: number;
    hasMore: boolean;
  };
}

interface LogEvent {
  id: string;
  traceId: string;
  service: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  metadata: Record<string, unknown>;
  createdAt: string; // ISO 8601
}
```

### 6.5 Audit Query Response

```typescript
interface AuditEventsResponse {
  data: AuditEvent[];
  pagination: {
    cursor: string | null;
    limit: number;
    hasMore: boolean;
  };
}

interface AuditEvent {
  id: string;
  traceId: string;
  actorId: string;
  actorType: 'user' | 'service' | 'system';
  tenantId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  result: 'success' | 'failure';
  metadata: Record<string, unknown>;
  createdAt: string;
}
```

---

## 7. SSE Streaming

### 7.1 Endpoint

```
GET /api/v1/logs/stream
```

Query parameters validated by `LogStreamSchema` (see Section 5.4).

### 7.2 Protocol

The response is `Content-Type: text/event-stream; charset=utf-8` with `Cache-Control: no-cache` and `X-Accel-Buffering: no` (disables Nginx buffering for reverse-proxy deployments).

Each event is formatted per the SSE specification:

```
event: log\n
data: {"id":"...","traceId":"...","service":"gateway","level":"info","message":"...","metadata":{},"createdAt":"..."}\n
\n
```

A heartbeat comment is sent every 30 seconds to prevent proxy timeout disconnection:

```
: heartbeat\n
\n
```

The `id` field in each SSE event is set to the log event's `created_at` timestamp (ISO 8601). Clients that reconnect with `Last-Event-ID` use this value as a `startTime` filter to resume without gaps.

### 7.3 Implementation

The SSE stream does not read from Postgres directly — it taps the in-process `BatchAccumulator`'s pre-insert buffer via an event emitter. This means:

1. Events appear in the SSE stream within milliseconds of being published to Redis.
2. The stream shows events that have not yet been persisted to Postgres (they are in the 1-second batch window).
3. On reconnect, the client should replay from Postgres using `GET /api/v1/logs` with `startTime` from `Last-Event-ID` to fill any gap.

The `BatchAccumulator` emits a `batch` event on each flush trigger (both the 1-second timer and the 1000-event threshold):

```typescript
// Inside BatchAccumulator
private flush(): void {
  const batch = this.buffer.splice(0, this.buffer.length);
  this.emit('batch', batch);          // SSE subscribers receive this
  this.insertBatch(batch).catch(...); // Postgres write (non-blocking)
}
```

Each active SSE connection registers a listener on `batchAccumulator.on('batch', ...)` and filters by the connection's query parameters before writing to the SSE response stream.

### 7.4 Connection Limits

Each SSE connection holds an HTTP connection open. The service enforces a limit of 200 concurrent SSE connections (`OP_SSE_MAX_CONNECTIONS`, default 200). When the limit is reached, new SSE requests receive `429 Too Many Requests` with `Retry-After: 60`. The active count is tracked in the `sse_active_connections` gauge metric.

### 7.5 Connection Lifecycle

```
Client connects → validate auth → validate filters → register batch listener
Client disconnects (or error) → remove batch listener → close response
Heartbeat timer fires every 30s → write `: heartbeat\n\n`
Server shutdown → drain SSE clients (send `event: close\ndata: {}\n\n`) → close connections
```

On graceful shutdown, the service sends a final `event: close` event so well-behaved clients know to reconnect rather than waiting for a timeout.

---

## 8. Export

### 8.1 Endpoint

```
GET /api/v1/logs/export
GET /api/v1/audit/export
```

### 8.2 Response Format

**JSONL (default):**
```
Content-Type: application/x-ndjson
Content-Disposition: attachment; filename="logs-{startTime}-{endTime}.jsonl"
```

One JSON object per line, same schema as the query API `LogEvent`.

**CSV:**
```
Content-Type: text/csv
Content-Disposition: attachment; filename="logs-{startTime}-{endTime}.csv"
```

CSV columns: `id,trace_id,service,level,message,created_at,metadata`  
The `metadata` column is JSON-encoded as a double-quoted string. This is the standard approach for embedding structured data in CSV.

### 8.3 Large Export Handling

Exports are streamed as chunked HTTP responses — the entire result set is never held in memory. Implementation:

```typescript
app.get('/api/v1/logs/export', authMiddleware, async (c) => {
  const params = LogExportSchema.parse(c.req.query());
  // Validation: endTime - startTime <= 7 days
  validateExportWindow(params.startTime, params.endTime);

  c.header('Content-Type', params.format === 'csv'
    ? 'text/csv'
    : 'application/x-ndjson');
  c.header('Transfer-Encoding', 'chunked');

  const stream = new ReadableStream({
    async start(controller) {
      if (params.format === 'csv') {
        controller.enqueue(encoder.encode(CSV_HEADER + '\n'));
      }
      // Stream rows from Postgres using a cursor (server-side cursor, not pagination cursor)
      const pgCursor = db.query(
        new Cursor(buildExportSql(params), buildExportArgs(params))
      );
      let rows: DbLogRow[];
      do {
        rows = await pgCursor.read(EXPORT_CHUNK_SIZE); // 1000 rows per read
        for (const row of rows) {
          const line = params.format === 'csv'
            ? formatCsvRow(row)
            : JSON.stringify(mapToLogEvent(row));
          controller.enqueue(encoder.encode(line + '\n'));
        }
      } while (rows.length === EXPORT_CHUNK_SIZE);
      controller.close();
    }
  });

  return c.body(stream);
});
```

A Postgres server-side cursor (`pg-cursor`) is used so rows are fetched from Postgres in pages of 1,000, not loaded into memory all at once. This keeps the Logging Service memory footprint flat regardless of export size.

The export SQL does not use `created_at DESC` ordering (unlike the query API) because export is batch-oriented and ascending order matches the natural write pattern for log analysis tools.

### 8.4 Export Rate Limiting

Export requests are subject to a separate, stricter rate limit: 5 export requests per minute per API key. This is enforced by a dedicated rate limit key prefix (`export:{apiKey}`) in Redis. The standard `X-RateLimit-*` headers are included in the response.

---

## 9. Internal Endpoint

### 9.1 GET /internal/logging/query

Used exclusively by the App Service for the dashboard trace viewer.

**Auth:** `X-Service-Token` validated by `@oneplatform/core` service auth middleware. Only `app-service` is in the allowed caller list.

**Request schema:** same as `LogQuerySchema` (Section 5.4) plus an additional `services` array parameter that the App Service uses to fetch logs for multiple services in one call:

```typescript
const InternalLogQuerySchema = LogQuerySchema.extend({
  services: z.array(z.string().min(1).max(64)).max(9).optional(),
});
```

The `services` array bypasses the tenant service scope check that applies on the public API — the App Service is trusted to pass the correct service list for its tenant context. If `services` is absent, all services are queried (admin use case from dashboard).

**Response:** same `LogsResponse` envelope as the public query API.

---

## 10. Retention Management

### 10.1 Retention Policy

| Log level | Retention | Mechanism |
|---|---|---|
| `error` | 90 days | Partition drop |
| `warn` | 90 days | Partition drop (same as error) |
| `info` | 30 days | Partition drop |
| `debug` | 7 days | Row-level delete within partition |
| Audit events | 365 days minimum | Soft-delete flag, then hard-delete after 365d |

**Rationale for mixing partition drop and row-level delete for debug:** monthly partitions cover all levels. Dropping a partition drops all levels in that month. To achieve 7-day retention for `debug` without affecting `info`/`error` rows in the same month, the service runs a row-level `DELETE FROM logging.events WHERE level = 'debug' AND created_at < now() - INTERVAL '7 days'` on a daily schedule. This delete operates only on recent partitions (at most the current and previous month), so it is fast and operates on a small index-covered range.

**Partition drops:** when an entire month's partition falls completely outside the longest retention window (90 days), the partition is dropped:

```sql
-- Check: is the entire partition older than 90 days?
-- If period_end < now() - INTERVAL '90 days', drop it.
DROP TABLE IF EXISTS logging.events_YYYY_MM;
UPDATE logging.partition_registry
  SET dropped_at = now()
  WHERE partition_name = 'events_YYYY_MM';
```

Dropping a partition is a metadata-only operation in Postgres — it is instantaneous regardless of row count. This is the primary reason for time-partitioning.

### 10.2 Retention Job Schedule

The retention job runs daily at 02:00 UTC (off-peak for most deployments). It is implemented as a `node-cron` task inside the Logging Service process:

```typescript
cron.schedule('0 2 * * *', async () => {
  await runRetentionJob();
}, { timezone: 'UTC' });

async function runRetentionJob(): Promise<void> {
  const span = tracer.startSpan('retention_job');
  try {
    // 1. Delete debug rows older than 7 days in recent partitions
    await db.query(`
      DELETE FROM logging.events
      WHERE level = 'debug'
        AND created_at < now() - INTERVAL '7 days'
    `);

    // 2. Delete info rows older than 30 days
    await db.query(`
      DELETE FROM logging.events
      WHERE level = 'info'
        AND created_at < now() - INTERVAL '30 days'
    `);

    // 3. Drop partitions entirely outside the 90-day window
    const oldPartitions = await db.query<{ partition_name: string }>(`
      SELECT partition_name FROM logging.partition_registry
      WHERE table_name = 'events'
        AND dropped_at IS NULL
        AND period_end < now() - INTERVAL '90 days'
    `);
    for (const { partition_name } of oldPartitions.rows) {
      await db.query(`DROP TABLE IF EXISTS logging.${partition_name}`);
      await db.query(`
        UPDATE logging.partition_registry
        SET dropped_at = now()
        WHERE partition_name = $1
      `, [partition_name]);
    }

    // 4. Hard-delete audit events past 365-day retention
    await db.query(`
      DELETE FROM logging.audit_events
      WHERE archived = FALSE
        AND created_at < now() - INTERVAL '365 days'
    `);

    metrics.gauge('retention_job_last_run_at', Date.now());
    span.setStatus({ code: SpanStatusCode.OK });
  } catch (err) {
    span.recordException(err as Error);
    span.setStatus({ code: SpanStatusCode.ERROR });
    logger.error('Retention job failed', { error: (err as Error).message });
  } finally {
    span.end();
  }
}
```

### 10.3 Partition Pre-Creation

New monthly partitions are created on the first day of each month at 00:05 UTC, creating the partition for the following month. This ensures there is always a partition ready when new month's events begin arriving.

```typescript
// Runs on startup (for current + next month) and on 1st of each month
async function ensurePartitions(): Promise<void> {
  const now = new Date();
  const months = [
    startOfMonth(now),
    startOfMonth(addMonths(now, 1)),
  ];
  for (const start of months) {
    const end = addMonths(start, 1);
    const name = `events_${format(start, 'yyyy_MM')}`;
    await db.query(`
      CREATE TABLE IF NOT EXISTS logging.${name}
      PARTITION OF logging.events
      FOR VALUES FROM ($1) TO ($2)
    `, [start.toISOString(), end.toISOString()]);
    await db.query(`
      INSERT INTO logging.partition_registry
        (partition_name, table_name, period_start, period_end)
      VALUES ($1, 'events', $2, $3)
      ON CONFLICT (partition_name) DO NOTHING
    `, [name, start.toISOString(), end.toISOString()]);
  }
}
```

### 10.4 Missing Partition Guard

If an event arrives for a month that has no partition (e.g., the first day of a new month before the cron has run), Postgres raises `ERROR: no partition of relation "events" found for row`. The batch insert's error handler catches this, calls `ensurePartitions()` synchronously, and retries the batch once. If the retry also fails, the batch goes to the in-memory fallback buffer.

---

## 11. Trace Correlation

### 11.1 Correlation Model

The `traceId` field in every log event is the W3C Trace Context `trace-id` (128-bit hex, 32 hex characters). This is the same identifier as:

- The OTEL trace ID attached to all spans for a request.
- The `X-Request-ID` header returned in every API response to the client.
- The `requestId` field in every error response.

The Logging Service does not generate or modify trace IDs. It stores and indexes them as received.

### 11.2 Trace Chain Query

A full cross-service trace chain is retrieved with a single query:

```
GET /api/v1/logs?traceId={traceId}&limit=500
```

This returns all log events from all services that participated in the distributed trace, ordered by `created_at DESC`. The `(trace_id, created_at DESC)` index on each partition makes this query efficient.

The CLI exposes this as:

```bash
op logs --trace-id {traceId}
```

### 11.3 Correlation Flow for Operators

```
1. User receives an error response:
   HTTP 500 { error: { code: "INTERNAL_ERROR", message: "...", requestId: "4bf92f3577b34da6" } }

2. Operator queries logs:
   GET /api/v1/logs?traceId=4bf92f3577b34da6
   → Returns all log events from all services for that trace

3. Operator opens Jaeger UI:
   Search by trace ID: 4bf92f3577b34da6
   → Full distributed trace with timings, span details, service call graph

4. Operator queries metrics (optional):
   Prometheus: {trace_id="4bf92f3577b34da6"} if exemplars are enabled
```

### 11.4 Audit Events and Trace IDs

Audit events also carry `trace_id`. When an authorization failure occurs mid-request, the audit event for that failure is queryable alongside the log events for the same trace ID, providing a unified view of security events and application behavior for a given request.

---

## 12. Observability

### 12.1 Prometheus Metrics

The following metrics are exposed on `GET /metrics` (Prometheus text format):

**Standard platform metrics (auto-provided by `@oneplatform/core`):**

| Metric | Type | Labels |
|---|---|---|
| `http_request_duration_seconds` | Histogram | `method`, `route`, `status` |
| `http_requests_total` | Counter | `method`, `route`, `status` |
| `active_connections` | Gauge | — |
| `memory_usage_bytes` | Gauge | — |
| `cpu_usage_ratio` | Gauge | — |
| `queue_depth` | Gauge | `queue_name` |
| `queue_processing_duration_seconds` | Histogram | `queue_name` |

**Logging Service-specific metrics:**

| Metric | Type | Description |
|---|---|---|
| `log_events_received_total` | Counter | Total events received from Redis pub/sub |
| `log_events_parsed_errors_total` | Counter | Events that failed Zod schema validation |
| `log_batch_size` | Histogram | Number of events per batch insert (p50/p95/p99) |
| `log_batch_insert_duration_seconds` | Histogram | Time to execute batch INSERT |
| `log_batch_insert_failures_total` | Counter | Batch insert failures |
| `log_memory_buffer_size` | Gauge | Current in-memory fallback buffer depth |
| `log_memory_buffer_overflow_total` | Counter | Events dropped to fallback file due to full buffer |
| `audit_queue_depth` | Gauge | BullMQ audit queue depth (polled every 10s) |
| `audit_dlq_depth` | Gauge | BullMQ audit DLQ depth |
| `audit_insert_failures_total` | Counter | Audit INSERT failures |
| `audit_schema_failures_total` | Counter | Audit jobs failing Zod validation (moved to DLQ) |
| `sse_active_connections` | Gauge | Active SSE streaming connections |
| `retention_job_last_run_at` | Gauge | Unix timestamp of last successful retention job |
| `export_requests_total` | Counter | Export requests by format |
| `partition_count` | Gauge | Active partition count in `partition_registry` |

### 12.2 OTEL Tracing

Spans are created for:

- Each HTTP route handler (auto via `@oneplatform/core`).
- Each BullMQ audit job (auto via core's BullMQ instrumentation).
- Each Postgres batch insert (manual span: `log.batch.insert`).
- The retention job (manual span: `retention_job`).
- Each partition creation/drop (manual span: `partition.manage`).

All spans carry the service name `logging` and the standard OTEL resource attributes.

### 12.3 Structured Logging

The Logging Service uses `console.warn` and `console.error` directly for its own internal log events (not via the Redis pub/sub channel — that would create a self-referential loop). These internal logs are collected by the container runtime and are visible in `docker compose logs logging-service`.

The service sets `NODE_ENV=production` log format to JSON for structured ingestion by log shippers if operators add a centralized logging layer above OnePlatform.

### 12.4 Health Checks

**GET /healthz** (liveness):

Returns `200 { status: "ok" }` if the process is running. Does not check dependencies. Used by Docker Compose health check.

**GET /readyz** (readiness):

Checks:
1. Postgres: execute `SELECT 1` via the connection pool.
2. Redis: issue `PING` on `redisClient`.
3. Pub/sub subscription: verify `redisSubscriber` is in subscribed state.
4. BullMQ worker: verify the audit worker is in `running` state.

Returns:
```json
{
  "status": "ready",
  "checks": {
    "postgres": "ok",
    "redis": "ok",
    "pubsub": "ok",
    "auditWorker": "ok"
  }
}
```

If any check fails, returns `503` with `status: "degraded"` and the failing check identified.

---

## 13. Error Handling

### 13.1 Batch Insert Failure

**Scenario:** Postgres is temporarily unavailable or returns an error during a batch insert.

**Handling:**
1. The failed batch is placed into the in-memory fallback buffer (up to 10,000 events).
2. A retry is scheduled with exponential backoff: 2s → 4s → 8s → 16s → 32s → 60s (capped).
3. If the in-memory buffer is full, overflow goes to `/data/log-fallback.jsonl`.
4. The `log_batch_insert_failures_total` metric is incremented.
5. An `error` log is emitted (to `console.error`, not Redis pub/sub).

**Recovery:** when the retry succeeds, the in-memory buffer is flushed to Postgres in order. Normal operation resumes without data loss up to the 10,000-event in-memory cap plus the 100MB file cap.

**Unrecoverable:** if both the in-memory buffer and the fallback file are full, events are discarded. A `log_memory_buffer_overflow_total` metric counter and a `CRITICAL` console error are emitted. This represents accepted non-audit data loss (per ADR-17) but is reported clearly.

### 13.2 Partition Creation Failure

**Scenario:** `CREATE TABLE IF NOT EXISTS ... PARTITION OF` fails (e.g., Postgres is temporarily unavailable).

**Handling:**
1. The error is caught, logged, and the batch insert error path (Section 13.1) handles the resulting batch failure.
2. The partition creation is retried on the next batch flush cycle.
3. If the Logging Service cannot create partitions for an extended period, the retention job will not drop old partitions either (it queries `partition_registry` which will not have new entries). This is safe — the service degrades gracefully by buffering events.

### 13.3 Audit Worker Failure

**Scenario:** An audit job fails after 5 BullMQ retry attempts.

**Handling:**
1. BullMQ moves the job to `audit-dlq`.
2. The `audit_dlq_depth` metric is incremented.
3. If `audit_dlq_depth > 100`, a `CRITICAL` log is emitted (visible in container logs and metrics dashboards).
4. The platform operator can inspect and replay DLQ jobs via BullMQ Board or the CLI.

No audit event is silently discarded. The DLQ is the permanent hold for events that could not be processed.

### 13.4 Redis Subscriber Disconnect

**Scenario:** `redisSubscriber` loses its connection.

**Handling:**
1. ioredis automatically attempts reconnection with a built-in exponential backoff.
2. While disconnected, no new log events arrive (producers continue publishing to Redis but nobody is subscribed).
3. Events buffered in Redis pub/sub channels are not persisted (pub/sub is fire-and-forget per ADR-17). This is the acknowledged non-audit data loss window.
4. Producers' own in-memory buffers (10,000 events per service, in `@oneplatform/core`) capture events during the outage window.
5. On reconnect, the service re-issues `PSUBSCRIBE logs:*` and resumes.

### 13.5 Storage Limit Warning

**Scenario:** The Postgres data volume approaches capacity.

**Detection:** the retention job emits a `storage_used_bytes` metric (via `SELECT pg_total_relation_size('logging.events')` plus `pg_total_relation_size('logging.audit_events')`). A Prometheus alert rule (provided in the optional observability profile) fires when this exceeds 80% of the configured volume size.

**Response:** operators should either increase the volume, enable cold storage archival (Phase 2 scale path), or reduce retention windows via environment variables.

### 13.6 Missing Partition on Insert

**Scenario:** An event arrives for a time value that has no partition (e.g., a clock skew produces a future timestamp, or the first event of a new month arrives before partition pre-creation runs).

**Handling:**
1. Postgres raises `ERROR 23514: no partition of relation "events" found for row`.
2. The batch insert error handler catches this specific error code.
3. `ensurePartitions()` is called, which creates the missing partition.
4. The batch is retried once.
5. If the timestamp is more than 2 months in the future, the event is discarded with a `CRITICAL` log (likely a misconfigured producer clock).

---

## 14. Scale Path

This section describes the planned scaling stages in order. Each stage is triggered by a specific operational threshold.

### Stage 0: Baseline (Shipped)

Monthly time-partitioned `logging.events` table on the shared Postgres instance. All reads and writes use the same pool of 30 connections. Adequate for platforms ingesting up to approximately 10,000 log events per minute.

**Trigger to advance:** query latency on the log viewer exceeds 500ms p95, or batch insert lag exceeds 2 seconds.

### Stage 1: Read Replica

Add a Postgres streaming replica. The query API (all `GET /api/v1/logs` and `/internal/logging/query` calls) routes reads to the replica. Batch inserts and retention job writes remain on the primary.

**Implementation:** `OP_DATABASE_READ_URL` environment variable. The connection pool in `@oneplatform/core` supports a separate read URL; when set, `db.query()` uses the primary pool and a `dbRead.query()` helper uses the replica pool.

**Trigger to advance:** write volume saturates the primary or the replica lags during peak write periods.

### Stage 2: Cold Storage Archival

Partitions older than 30 days are compressed and moved to `logging.archive`. The archive table has reduced indexes (only `created_at DESC` and `trace_id`). Query requests that span the archive range use a `UNION ALL` across `logging.events` and `logging.archive`.

This is transparent to API clients — the query builder handles the table routing based on the requested time range.

**Archive migration job:** runs weekly, moves one partition at a time during off-peak hours, updates `partition_registry.archived_at`.

### Stage 3: Dedicated Postgres Instance

Split the `logging` schema to its own Postgres instance. This is the first service to split, per ADR-5 (Logging is the highest-write-volume service). The connection string changes from the shared Postgres to a dedicated instance. No schema changes are required.

This is a deployment-level change: update `OP_DATABASE_URL` for the Logging Service, provision a dedicated Postgres container or managed instance, and run a one-time data migration.

### Stage 4: Clickhouse / OLAP Backend (Future)

For extreme analytics workloads (billions of events, complex aggregate queries), the `logging.events` storage backend can be replaced with ClickHouse. The write pipeline (batch accumulator) and the read API contract remain unchanged — only the storage layer changes. ClickHouse's native time-series partitioning and columnar compression are a better fit than Postgres at this scale.

This is a future option, not a committed roadmap item. The interface boundary between the pipeline and storage is clean enough to support this substitution.

---

## 15. Testing Strategy

### 15.1 Unit Tests

**Target:** pure functions and classes with no I/O dependencies.

| Component | Test focus |
|---|---|
| `BatchAccumulator` | Buffer accumulation, flush trigger on size, flush trigger on timer, concurrent push safety |
| `buildLogQuery()` | SQL generation for each filter combination, no SQL injection on adversarial inputs |
| `encodeCursor()` / `decodeCursor()` | Round-trip encoding, HMAC tamper detection, expiry enforcement |
| `LogEventSchema.parse()` | Valid events, invalid JSON, missing fields, oversized message, unknown level |
| `AuditEventJobSchema.parse()` | Valid jobs, schema violations route to DLQ |
| `FallbackFileWriter` | Write, rotation at 100MB, startup replay |
| `buildExportSql()` | Window validation (7-day limit), JSONL and CSV format headers |

Test runner: Vitest. No network or database calls in unit tests (use mocks for `db` and `redis`).

### 15.2 Integration Tests

**Target:** components that interact with real Postgres and Redis, running in a Docker Compose test environment.

| Test | What it verifies |
|---|---|
| Redis pub/sub → batch accumulator → Postgres insert | End-to-end ingestion of 10 events; verify rows in `logging.events` |
| Batch size trigger (1000 events) | Publish 1000+ events; verify flush happens before 1 second |
| Batch time trigger (1 second) | Publish 1 event; verify flush within 1.5 seconds |
| Fallback buffer on Postgres failure | Simulate Postgres `pg.end()`; publish events; restore Postgres; verify events are inserted after reconnect |
| Fallback file on memory buffer overflow | Simulate 10,001 events with Postgres down; verify file written and replayed on restart |
| BullMQ audit worker → `logging.audit_events` | Enqueue 5 audit jobs; verify all 5 rows inserted |
| Duplicate audit job (BullMQ replay) | Enqueue same job ID twice; verify only 1 row in `audit_events` |
| Cursor pagination | Insert 250 rows; paginate with `limit=100`; verify 3 pages, last cursor is null |
| SSE stream | Connect SSE client; publish 5 events; verify 5 SSE events received before batch flush |
| Export JSONL | Insert 5000 rows in a time range; export; verify all 5000 lines in response |
| Export CSV | Same as above, CSV format |
| Retention job | Insert rows across 3 months; run retention job; verify old partition dropped |
| Partition pre-creation on startup | Fresh database; start service; verify 2 partitions created |
| Missing partition guard | Insert event with timestamp in future month without partition; verify partition auto-created and event inserted |
| Trace correlation query | Insert 10 events with same `traceId` across 3 services; query by traceId; verify all 10 returned |
| Full-text search | Insert events with known phrases; search; verify match |
| Auth scope enforcement | Call `/api/v1/audit` without `audit:read` scope; verify 403 |

### 15.3 Batch Performance Tests

**Goal:** verify batch throughput meets the design targets.

| Test | Target |
|---|---|
| Sustained ingestion at 10,000 events/min | Batch insert lag < 1 second p99 |
| Single batch of 1,000 events | INSERT completes in < 200ms p99 |
| 100,000 event export (JSONL, 7-day window) | Streaming starts within 500ms, completes at memory plateau < 100MB |
| Query with full-text search on 1M rows | Response time < 500ms p95 |
| SSE stream with 100 concurrent connections | No connection drops, events delivered within 1.5 seconds of publish |

Performance tests use `k6` or a Vitest test that publishes events via Redis and measures end-to-end database insertion lag using database `created_at` vs. publish timestamp.

### 15.4 Contract Tests

`@oneplatform/core`'s `testApiContract(app, spec)` utility runs against the Logging Service in CI:

- Every path in the OpenAPI spec has a corresponding route.
- Every response matches its declared schema.
- Every error response uses the standard envelope.

The OpenAPI spec is generated from the Hono route definitions + Zod schemas at build time.

---

## 16. Configuration Reference

All environment variables are prefixed `OP_` per platform convention. All are loaded and validated at startup; missing required variables cause a fatal exit with a descriptive error message.

| Variable | Required | Default | Description |
|---|---|---|---|
| `OP_DATABASE_URL` | Yes | — | Postgres connection string (PgBouncer URL) |
| `OP_DATABASE_READ_URL` | No | `OP_DATABASE_URL` | Read replica URL (Stage 1 scale path) |
| `OP_REDIS_URL` | Yes | — | Redis connection string |
| `OP_CURSOR_SECRET` | Yes | — | HMAC-SHA256 secret for cursor signing |
| `OP_MASTER_KEY` | Yes | — | Platform master key (used for service key derivation) |
| `OP_LOG_BATCH_SIZE` | No | `1000` | Events per batch insert |
| `OP_LOG_BATCH_INTERVAL_MS` | No | `1000` | Maximum batch accumulation time (ms) |
| `OP_LOG_MEMORY_BUFFER_MAX` | No | `10000` | In-memory fallback buffer capacity |
| `OP_AUDIT_WORKER_CONCURRENCY` | No | `5` | BullMQ audit worker concurrency |
| `OP_SSE_MAX_CONNECTIONS` | No | `200` | Maximum concurrent SSE connections |
| `OP_EXPORT_CHUNK_SIZE` | No | `1000` | Rows per Postgres cursor read during export |
| `OP_EXPORT_MAX_WINDOW_DAYS` | No | `7` | Maximum export time window |
| `OP_RETENTION_DEBUG_DAYS` | No | `7` | debug log retention (days) |
| `OP_RETENTION_INFO_DAYS` | No | `30` | info log retention (days) |
| `OP_RETENTION_ERROR_DAYS` | No | `90` | error/warn log retention (days) |
| `OP_RETENTION_AUDIT_DAYS` | No | `365` | audit event minimum retention (days) |
| `PORT` | No | `3007` | HTTP server port |

---

## Appendix A: Data Flow Diagram

```
                    ┌─────────────────────────────────────────────────┐
                    │                  ALL SERVICES                    │
                    │  gateway, auth, ingestion, ontology, pipeline,   │
                    │        execution, app, plugin (+ logging)        │
                    └────────────────┬───────────────────┬────────────┘
                                     │                   │
                         PSUBSCRIBE  │  logs:*           │  BullMQ
                         (pub/sub)   │                   │  audit queue
                                     ▼                   ▼
                    ┌────────────────────────────────────────────────┐
                    │               LOGGING SERVICE :3007            │
                    │                                                │
                    │  ┌──────────────┐     ┌────────────────────┐  │
                    │  │  Redis Sub   │     │  BullMQ Worker (5) │  │
                    │  │  PSUBSCRIBE  │     │  concurrency       │  │
                    │  │  logs:*      │     └────────┬───────────┘  │
                    │  └──────┬───────┘              │              │
                    │         │ parse + validate      │ validate     │
                    │         ▼                       ▼              │
                    │  ┌──────────────┐     ┌────────────────────┐  │
                    │  │  Batch       │     │  Audit Insert      │  │
                    │  │  Accumulator │     │  ON CONFLICT       │  │
                    │  │  1s / 1000   │     │  (job_id) DO NOTHING│  │
                    │  └──────┬───────┘     └────────┬───────────┘  │
                    │         │ flush                 │              │
                    │         │──── emit('batch') ────┤              │
                    │         │         (SSE tap)     │              │
                    │         ▼                       ▼              │
                    │  ┌──────────────────────────────────────────┐  │
                    │  │            PostgreSQL (logging schema)    │  │
                    │  │  logging.events (monthly partitioned)    │  │
                    │  │  logging.audit_events                    │  │
                    │  │  logging.partition_registry              │  │
                    │  └──────────────────────────────────────────┘  │
                    │                                                │
                    │  ┌──────────────────────────────────────────┐  │
                    │  │            HTTP API                       │  │
                    │  │  GET /api/v1/logs         (query)         │  │
                    │  │  GET /api/v1/logs/stream  (SSE)           │  │
                    │  │  GET /api/v1/logs/export  (JSONL/CSV)     │  │
                    │  │  GET /api/v1/audit        (query)         │  │
                    │  │  GET /api/v1/audit/export                 │  │
                    │  │  GET /internal/logging/query              │  │
                    │  └──────────────────────────────────────────┘  │
                    └────────────────────────────────────────────────┘
                                         │
                              ┌──────────┴──────────┐
                              │                     │
                         ┌────▼─────┐         ┌─────▼────┐
                         │ Gateway  │         │  App     │
                         │ (proxied │         │  Service │
                         │  user    │         │  /intern │
                         │  calls)  │         │  al/log  │
                         └──────────┘         └──────────┘
```

---

## Appendix B: Fallback Chain Summary

| Event type | Failure mode | Fallback 1 | Fallback 2 | Fallback 3 | Data loss? |
|---|---|---|---|---|---|
| Non-audit log | Redis pub/sub down | Events not received | Producer in-memory buffer (10k/service) | Producer fallback file | Possible (accepted, ADR-17) |
| Non-audit log | Postgres down | In-memory buffer (10k events) | Fallback file (/data/log-fallback.jsonl, 100MB) | Overflow discarded | Possible if all tiers exhausted |
| Audit event | Redis/BullMQ down | Producer WAL file (/data/job-buffer.wal) | WAL replay on reconnect | — | None (WAL prevents loss) |
| Audit event | Postgres down | BullMQ retry (5x, exponential) | DLQ (permanent hold) | — | None (DLQ prevents discard) |

---

*Document authored: 2026-06-10*  
*Author: Aaron Collins (Principal Architect)*
