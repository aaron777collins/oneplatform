# Pipeline Service — L2 Service-Level Design

**Document status:** Approved
**Last updated:** 2026-06-10
**Author:** Platform Architecture
**Supersedes:** Pipeline Service summary in L1 design (lines 1139-1173)
**ADRs this document implements:** ADR-5, ADR-13, ADR-16, ADR-17, ADR-18, ADR-19, ADR-30, ADR-31

---

## Table of Contents

1. [Service Overview](#1-service-overview)
2. [Database Schema](#2-database-schema)
3. [Redis Key Inventory](#3-redis-key-inventory)
4. [Pipeline Definition Model](#4-pipeline-definition-model)
5. [API Endpoints — Public](#5-api-endpoints--public)
6. [API Endpoints — Internal](#6-api-endpoints--internal)
7. [Execution Engine](#7-execution-engine)
8. [Trigger System](#8-trigger-system)
9. [Hook Linearization](#9-hook-linearization)
10. [DLQ and Reliability](#10-dlq-and-reliability)
11. [Run Logging and SSE Streaming](#11-run-logging-and-sse-streaming)
12. [Session-Mode PgBouncer](#12-session-mode-pgbouncer)
13. [Concurrency Control](#13-concurrency-control)
14. [Inter-Service Communication](#14-inter-service-communication)
15. [Error Handling](#15-error-handling)
16. [Error Codes](#16-error-codes)
17. [Observability](#17-observability)
18. [Testing Strategy](#18-testing-strategy)
19. [Deployment and Configuration](#19-deployment-and-configuration)

---

## 1. Service Overview

### 1.1 Responsibility

The Pipeline Service is the workflow orchestration engine for the platform. It:

- Owns the definition and lifecycle of multi-step pipelines (CRUD, validation, versioning)
- Manages all trigger types: cron schedules, event-driven Redis subscriptions, manual POST triggers, and inbound webhook triggers
- Enqueues pipeline run jobs to BullMQ and tracks run state from `pending` through to terminal states
- Coordinates before/after hook execution at `pipeline.trigger`, `pipeline.step:{stepId}`, and `pipeline.complete` stages by requesting hook chains from the Plugin Service and dispatching them sequentially to the Execution Service
- Emits canonical platform events (`pipeline.started`, `pipeline.step.completed`, `pipeline.completed`, `pipeline.failed`, `pipeline.cancelled`) to the Redis pub/sub events channel
- Exposes SSE log streams for active and completed runs
- Implements distributed mutual exclusion via PostgreSQL advisory locks to prevent concurrent duplicate runs of the same pipeline on the same tenant

No step code executes inside the Pipeline Service process. All code execution happens in the Execution Service sandbox. The Pipeline Service drives the execution graph and interprets results; it never runs arbitrary user code.

### 1.2 Network Placement

| Property | Value |
|---|---|
| Port (internal) | 3004 |
| Docker network | `oneplatform-internal` |
| External exposure | Via Gateway only (`/api/v1/pipelines/**`, `/api/v1/pipeline-runs/**`, `/api/v1/schedules/**`) |
| Internal endpoints | `/internal/pipeline/**` — reachable by service-token-authenticated callers |
| Outbound service calls | Execution Service (step execution + hook dispatch), Ontology Service (schema lookups), Plugin Service (hook chain resolution) |

### 1.3 Startup Dependencies

```yaml
pipeline-service:
  depends_on:
    op-init:
      condition: service_completed_successfully
    postgres:
      condition: service_healthy
    redis:
      condition: service_healthy
    plugin-service:
      condition: service_healthy
    execution-service:
      condition: service_healthy
    ontology-service:
      condition: service_healthy
```

**Startup sequence (in order):**

1. Load `OP_MASTER_KEY` from `/data/init/master.key` (falls back to `/run/secrets/op_master_key`).
2. Run database migrations against the `pipeline` schema (idempotent, version-tracked via `@oneplatform/core` migration runner).
3. Generate Ed25519 keypair if `/data/service.key` is absent; publish public key to `/data/service-keys/pipeline-service.pub`.
4. Begin inotify watch on `/data/service-keys/` for hot-reloading peer public keys.
5. Open session-mode PgBouncer connection pool (`DATABASE_URL`, pool size 25). Verify advisory lock acquisition and release on a test lock key to confirm session-mode is active.
6. Connect to Redis using `op_pipeline` ACL user. Subscribe to ontology change channel (`ontology:*`) for schema cache invalidation.
7. Initialize BullMQ workers: `pipeline:run` worker (step execution) and `pipeline:cron` worker (cron tick dispatch).
8. Load all enabled schedules from `pipeline.schedules` into the in-memory cron scheduler; compute missed `next_run_at` values for schedules whose `next_run_at` is in the past (catch-up on restart).
9. Subscribe to event-driven trigger channels: for each `pipeline.triggers` row with `trigger_type = 'event'`, subscribe to the configured Redis channel.
10. Mark `/readyz` healthy only after steps 1-9 complete without error.

**Startup ordering note:** The Pipeline Service is in startup group 5 (alongside Execution, Plugin, App services) per the L1 startup sequence. This means Postgres, Redis, Ontology, and Plugin are guaranteed healthy before the Pipeline Service starts, which is required for steps 6-9 above.

### 1.4 Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PgBouncer session-mode connection string. Pool size 25. Must NOT be the transaction-mode pool. |
| `REDIS_URL` | Yes | Redis connection string with `op_pipeline` ACL credentials. |
| `EXECUTION_SERVICE_URL` | Yes | Base URL for Execution Service internal API (e.g., `http://execution-service:3005`). |
| `ONTOLOGY_SERVICE_URL` | Yes | Base URL for Ontology Service internal API (e.g., `http://ontology-service:3003`). |
| `PLUGIN_SERVICE_URL` | Yes | Base URL for Plugin Service internal API (e.g., `http://plugin-service:3008`). |
| `OP_SERVICE_PRIVATE_KEY_PATH` | No | Path to Ed25519 private key file. Default `/data/service.key`. |
| `OP_SERVICE_KEYS_DIR` | No | Directory of peer public keys. Default `/data/service-keys/`. |
| `OP_CURSOR_SECRET` | Yes | HMAC key for cursor signing. Generated by `op-init`. |
| `OP_PIPELINE_MAX_CONCURRENT_RUNS` | No | Maximum BullMQ concurrency for the `pipeline:run` worker. Default `20`. |
| `OP_PIPELINE_MAX_QUEUE_LENGTH` | No | BullMQ `maxLength` for `pipeline:run` queue. Default `10000`. |
| `OP_PIPELINE_STEP_DEFAULT_TIMEOUT_MS` | No | Default per-step execution timeout (ms). Default `300000` (5 minutes). |
| `OP_PIPELINE_HOOK_DEFAULT_TIMEOUT_MS` | No | Default per-hook execution timeout (ms). Default `30000` (30 seconds). |
| `OP_PIPELINE_MAX_STEPS` | No | Maximum steps in a single pipeline definition. Default `100`. |
| `OP_PIPELINE_MAX_PARALLEL_BRANCHES` | No | Maximum branches in a single `parallel` step. Default `10`. |
| `OP_LOG_LEVEL` | No | Default `info`. |

---

## 2. Database Schema

All tables live in the `pipeline` schema. The Pipeline Service Postgres role is `pipeline_service_role` with `USAGE` on the `pipeline` schema and `SELECT, INSERT, UPDATE, DELETE` on all tables within it. DDL changes (migrations) run under the separate `pipeline_migrator_role`.

The Pipeline Service uses session-mode PgBouncer (pool `DATABASE_URL`) because:
1. Advisory locks (`pg_try_advisory_lock`) require a persistent session — they are released when the connection is closed, not at transaction commit. Transaction-mode pooling would release the connection (and therefore the lock) after each transaction, defeating the mutual exclusion guarantee.
2. No LISTEN/NOTIFY is used in the pipeline schema, but the session mode is still required for advisory locks per ADR-5.

### 2.1 Row-Level Security

Tables that contain tenant-scoped data have RLS enabled. The session variable is set at the start of every tenant-scoped transaction:

```sql
SET LOCAL app.tenant_id = '<uuid>';
```

The service calls `setTenantContext(client, tenantId)` from `@oneplatform/core/db.ts` before every tenant-scoped query block.

### 2.2 Full Schema

```sql
-- ============================================================
-- Schema setup
-- ============================================================
CREATE SCHEMA IF NOT EXISTS pipeline;

-- ============================================================
-- pipeline.pipelines
-- ============================================================
-- A pipeline definition. The definition JSONB field holds the complete
-- step graph and inline trigger configuration. Triggers that require
-- external registration (cron, event, webhook) additionally have rows
-- in pipeline.schedules or pipeline.triggers respectively.
CREATE TABLE pipeline.pipelines (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL,
    -- FK to auth.tenants(id) not enforced here — cross-schema FK avoided per ADR-5.
    -- Enforcement is at the application layer: tenantId validated against the
    -- auth.tenants table on pipeline creation via Auth Service service call.
    name                TEXT NOT NULL,
    slug                TEXT NOT NULL,
    description         TEXT,
    definition          JSONB NOT NULL DEFAULT '{}',
    -- Structure of definition: see Section 4 (Pipeline Definition Model)
    -- { version: number, steps: Step[], entryStepId: string,
    --   triggers: TriggerConfig[], options: PipelineOptions }
    is_active           BOOLEAN NOT NULL DEFAULT true,
    -- is_active=false disables all triggers; existing runs can still complete.
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by          UUID NOT NULL,
    -- user ID from auth service

    CONSTRAINT pipelines_slug_per_tenant_unique UNIQUE (tenant_id, slug),
    CONSTRAINT pipelines_name_not_empty CHECK (length(trim(name)) > 0),
    CONSTRAINT pipelines_slug_format CHECK (slug ~ '^[a-z0-9][a-z0-9\-]{1,62}[a-z0-9]$'),
    CONSTRAINT pipelines_definition_not_null CHECK (definition IS NOT NULL)
);

CREATE INDEX idx_pipelines_tenant_id ON pipeline.pipelines (tenant_id);
CREATE INDEX idx_pipelines_tenant_slug ON pipeline.pipelines (tenant_id, slug);
CREATE INDEX idx_pipelines_tenant_active ON pipeline.pipelines (tenant_id) WHERE is_active = true;

ALTER TABLE pipeline.pipelines ENABLE ROW LEVEL SECURITY;

CREATE POLICY pipelines_tenant_isolation ON pipeline.pipelines
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid
           OR current_setting('app.bypass_rls', true) = 'true');

-- ============================================================
-- pipeline.runs
-- ============================================================
-- One row per pipeline run attempt. A run is created synchronously when
-- a trigger fires; execution happens asynchronously via BullMQ.
CREATE TABLE pipeline.runs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pipeline_id         UUID NOT NULL REFERENCES pipeline.pipelines(id) ON DELETE CASCADE,
    tenant_id           UUID NOT NULL,
    status              TEXT NOT NULL DEFAULT 'pending',
    -- Allowed values: pending | running | completed | failed | cancelled
    -- Enforced by CHECK constraint below and the state machine in the execution engine.
    triggered_by        TEXT NOT NULL,
    -- Enum: 'manual' | 'schedule' | 'event' | 'webhook' | 'service'
    -- 'service' covers calls from other platform services (e.g. App Service, Ingestion)
    trigger_actor_id    UUID,
    -- For 'manual': user UUID. For 'schedule': schedule UUID. For 'event'/'webhook': NULL.
    -- For 'service': calling service identity (not a UUID, stored as text in trigger_meta).
    trigger_meta        JSONB NOT NULL DEFAULT '{}',
    -- Additional trigger context:
    --   manual: { userId }
    --   schedule: { scheduleId, cronExpr }
    --   event: { channel, eventType, eventId }
    --   webhook: { triggerId, requestId }
    --   service: { callerService, callerRequestId }
    input               JSONB NOT NULL DEFAULT '{}',
    -- Input payload passed to the first step. Provided by the trigger.
    started_at          TIMESTAMPTZ,
    -- Set when status transitions to 'running' (first step begins).
    completed_at        TIMESTAMPTZ,
    -- Set when status reaches any terminal state.
    error               JSONB,
    -- Set on failure: { code: string, message: string, stepId?: string, details?: unknown }
    -- stepId is present if a specific step caused the failure.
    bully_job_id        TEXT,
    -- BullMQ job ID for the pipeline:run queue entry. Used to reference the job
    -- for cancellation (bullmq.Job.remove() or setting a cancellation flag).
    definition_snapshot JSONB NOT NULL DEFAULT '{}',
    -- Snapshot of pipeline.definition at run creation time.
    -- Enables reproducible re-runs and post-hoc debugging even if the
    -- pipeline definition changes after the run starts.
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT runs_status_valid CHECK (
        status IN ('pending', 'running', 'completed', 'failed', 'cancelled')
    ),
    CONSTRAINT runs_triggered_by_valid CHECK (
        triggered_by IN ('manual', 'schedule', 'event', 'webhook', 'service')
    ),
    CONSTRAINT runs_completed_at_after_started CHECK (
        completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at
    )
);

CREATE INDEX idx_runs_pipeline_id ON pipeline.runs (pipeline_id);
CREATE INDEX idx_runs_tenant_id ON pipeline.runs (tenant_id);
CREATE INDEX idx_runs_tenant_status ON pipeline.runs (tenant_id, status);
CREATE INDEX idx_runs_pipeline_created ON pipeline.runs (pipeline_id, created_at DESC);
-- Partial index for active (non-terminal) runs — used by the concurrency mutex check:
CREATE INDEX idx_runs_active ON pipeline.runs (pipeline_id, status)
    WHERE status IN ('pending', 'running');

ALTER TABLE pipeline.runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY runs_tenant_isolation ON pipeline.runs
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid
           OR current_setting('app.bypass_rls', true) = 'true');

-- ============================================================
-- pipeline.run_steps
-- ============================================================
-- One row per step per run. Created eagerly when the run starts (status='pending')
-- so the UI can show the full step graph immediately, with individual steps
-- transitioning to 'running' and then terminal states as execution proceeds.
CREATE TABLE pipeline.run_steps (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id              UUID NOT NULL REFERENCES pipeline.runs(id) ON DELETE CASCADE,
    tenant_id           UUID NOT NULL,
    step_id             TEXT NOT NULL,
    -- The step ID from the pipeline definition (user-defined, unique within a pipeline).
    step_name           TEXT NOT NULL,
    step_type           TEXT NOT NULL,
    -- Mirrors the step type from the definition:
    -- 'code' | 'connector' | 'transformer' | 'conditional' | 'parallel' | 'webhook'
    status              TEXT NOT NULL DEFAULT 'pending',
    -- Allowed values: pending | running | completed | failed | skipped | cancelled
    -- 'skipped': conditional branch not taken. 'cancelled': run cancelled mid-step.
    attempt_count       INTEGER NOT NULL DEFAULT 0,
    -- Incremented each time this step is retried (distinct from BullMQ job retries,
    -- which operate at the full run level — step-level retries are not implemented
    -- in MVP; this field is reserved for future step-level retry policy).
    started_at          TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ,
    input               JSONB NOT NULL DEFAULT '{}',
    -- The resolved input to this step (after input mapping from prior steps' outputs).
    output              JSONB,
    -- The step's return value. NULL if the step is not yet complete or produced no output.
    error               JSONB,
    -- Set on failure: { code: string, message: string, details?: unknown }
    execution_id        UUID,
    -- The Execution Service execution ID, if this step triggered a sandbox execution.
    -- NULL for conditional and parallel steps (which do not directly invoke the sandbox).
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT run_steps_status_valid CHECK (
        status IN ('pending', 'running', 'completed', 'failed', 'skipped', 'cancelled')
    ),
    CONSTRAINT run_steps_step_type_valid CHECK (
        step_type IN ('code', 'connector', 'transformer', 'conditional', 'parallel', 'webhook')
    ),
    CONSTRAINT run_steps_step_id_per_run_unique UNIQUE (run_id, step_id)
);

CREATE INDEX idx_run_steps_run_id ON pipeline.run_steps (run_id);
CREATE INDEX idx_run_steps_run_status ON pipeline.run_steps (run_id, status);

ALTER TABLE pipeline.run_steps ENABLE ROW LEVEL SECURITY;

CREATE POLICY run_steps_tenant_isolation ON pipeline.run_steps
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid
           OR current_setting('app.bypass_rls', true) = 'true');

-- ============================================================
-- pipeline.schedules
-- ============================================================
-- Cron-based trigger registrations. One row per cron trigger per pipeline.
-- A single pipeline may have multiple schedules (e.g., hourly + daily digest).
CREATE TABLE pipeline.schedules (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pipeline_id         UUID NOT NULL REFERENCES pipeline.pipelines(id) ON DELETE CASCADE,
    tenant_id           UUID NOT NULL,
    cron_expr           TEXT NOT NULL,
    -- Standard 5-field cron expression (minute hour dom month dow).
    -- 6-field (with seconds) is NOT supported — minimum granularity is 1 minute.
    -- Validated against the cron-parser library at creation time.
    timezone            TEXT NOT NULL DEFAULT 'UTC',
    -- IANA timezone name. Cron evaluation uses this timezone.
    enabled             BOOLEAN NOT NULL DEFAULT true,
    input_template      JSONB NOT NULL DEFAULT '{}',
    -- Static input payload passed to pipeline runs triggered by this schedule.
    last_run_at         TIMESTAMPTZ,
    next_run_at         TIMESTAMPTZ,
    -- Recomputed after each trigger and on startup. Used by the cron scheduler loop.
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT schedules_cron_not_empty CHECK (length(trim(cron_expr)) > 0),
    CONSTRAINT schedules_timezone_not_empty CHECK (length(trim(timezone)) > 0)
);

CREATE INDEX idx_schedules_pipeline_id ON pipeline.schedules (pipeline_id);
CREATE INDEX idx_schedules_tenant_id ON pipeline.schedules (tenant_id);
-- Index for the cron scheduler loop — finds due schedules efficiently:
CREATE INDEX idx_schedules_next_run_enabled ON pipeline.schedules (next_run_at)
    WHERE enabled = true;

ALTER TABLE pipeline.schedules ENABLE ROW LEVEL SECURITY;

CREATE POLICY schedules_tenant_isolation ON pipeline.schedules
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid
           OR current_setting('app.bypass_rls', true) = 'true');

-- ============================================================
-- pipeline.triggers
-- ============================================================
-- Event-driven and webhook trigger registrations. Not used for cron
-- (which has its own table) or manual triggers (which have no persistent config).
CREATE TABLE pipeline.triggers (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pipeline_id         UUID NOT NULL REFERENCES pipeline.pipelines(id) ON DELETE CASCADE,
    tenant_id           UUID NOT NULL,
    trigger_type        TEXT NOT NULL,
    -- Allowed values: 'event' | 'webhook'
    -- 'event': subscribes to a Redis pub/sub channel
    -- 'webhook': creates a unique inbound webhook URL slug registered with the Gateway
    config              JSONB NOT NULL DEFAULT '{}',
    -- trigger_type='event': { channel: string, eventType?: string, filter?: object }
    --   channel: the Redis pub/sub channel to subscribe to (e.g., 'ontology:updated')
    --   eventType: optional exact match on the eventType field in the platform event
    --   filter: optional JSONPath filter applied to the event data payload
    -- trigger_type='webhook': { slug: string, secret: string (HMAC), allowedMethods: string[] }
    --   slug: unique path segment (generated, e.g., 'whk_abc123'), registered with Gateway
    --   secret: HMAC-SHA256 secret for verifying incoming webhook payloads
    --   allowedMethods: ['POST'] or ['POST','PUT'] — default ['POST']
    enabled             BOOLEAN NOT NULL DEFAULT true,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT triggers_type_valid CHECK (trigger_type IN ('event', 'webhook'))
);

CREATE INDEX idx_triggers_pipeline_id ON pipeline.triggers (pipeline_id);
CREATE INDEX idx_triggers_tenant_id ON pipeline.triggers (tenant_id);
CREATE INDEX idx_triggers_type_enabled ON pipeline.triggers (trigger_type, enabled);

ALTER TABLE pipeline.triggers ENABLE ROW LEVEL SECURITY;

CREATE POLICY triggers_tenant_isolation ON pipeline.triggers
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid
           OR current_setting('app.bypass_rls', true) = 'true');

-- ============================================================
-- pipeline.run_logs
-- ============================================================
-- Append-only log entries for pipeline runs, used for SSE streaming and the
-- run log viewer. Each log line is a structured entry with level, message,
-- and optional step context. Separate from the Logging Service's event table
-- because: (1) pipeline run logs are higher-frequency and run-scoped, not
-- service-scoped; (2) SSE streaming requires the Pipeline Service to own the
-- cursor and write path; (3) retention is tied to run lifetime, not global policy.
CREATE TABLE pipeline.run_logs (
    id                  BIGSERIAL PRIMARY KEY,
    -- BIGSERIAL for efficient ordered SSE cursor (last seen id approach).
    run_id              UUID NOT NULL REFERENCES pipeline.runs(id) ON DELETE CASCADE,
    tenant_id           UUID NOT NULL,
    step_id             TEXT,
    -- NULL for pipeline-level log entries (trigger events, completion events, etc.)
    level               TEXT NOT NULL DEFAULT 'info',
    -- Allowed values: 'debug' | 'info' | 'warn' | 'error'
    message             TEXT NOT NULL,
    details             JSONB,
    -- Structured data attached to the log entry (e.g., step output summary, error details).
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT run_logs_level_valid CHECK (level IN ('debug', 'info', 'warn', 'error'))
);

-- Covering index for SSE streaming: cursor-based poll by (run_id, id > last_seen_id)
CREATE INDEX idx_run_logs_run_id_cursor ON pipeline.run_logs (run_id, id);
CREATE INDEX idx_run_logs_tenant ON pipeline.run_logs (tenant_id);

ALTER TABLE pipeline.run_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY run_logs_tenant_isolation ON pipeline.run_logs
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid
           OR current_setting('app.bypass_rls', true) = 'true');
```

---

## 3. Redis Key Inventory

The Pipeline Service uses the `op_pipeline` Redis ACL user with key prefix access `~queue:pipeline:* ~queue:execution:*` and channel access `&ontology:* &events:* &logs:*`.

| Key Pattern | Type | Purpose | TTL |
|---|---|---|---|
| `queue:pipeline:run` | BullMQ queue | Active pipeline run jobs | Managed by BullMQ |
| `queue:pipeline:run:dlq` | BullMQ queue | Dead-letter entries for `queue:pipeline:run` | Managed by BullMQ |
| `queue:pipeline:cron` | BullMQ queue | Internal cron tick dispatch jobs | Managed by BullMQ |
| `queue:execution:*` | BullMQ queues | Written by Pipeline Service when dispatching hook/step execution; key prefix shared with Execution Service by service RBAC | Managed by BullMQ |
| `ontology:*` | Pub/sub channel | Subscribed (subscribe-only) — ontology schema invalidation signals | N/A |

**WAL file (not a Redis key):** On Redis unavailability, the Pipeline Service buffers pending pipeline run enqueue operations to `/data/job-buffer.wal` (max 50MB). Each WAL record is a length-prefixed JSON blob with a CRC32 checksum trailer per ADR-18. The WAL is replayed and truncated when Redis reconnects.

---

## 4. Pipeline Definition Model

The `pipeline.pipelines.definition` JSONB column stores the complete pipeline specification. The TypeScript types below represent the exact structure; the Zod schema (`PipelineDefinitionSchema`) enforces them at API input time.

### 4.1 Top-Level Definition

```typescript
interface PipelineDefinition {
  version: 1;                    // Schema version — increment when breaking changes are made
  entryStepId: string;           // ID of the first step to execute
  steps: Step[];                 // All steps in the pipeline
  options?: PipelineOptions;     // Optional execution settings
}

interface PipelineOptions {
  maxConcurrentRuns?: number;    // Override for this pipeline; 1 = single-instance. Default: 5
  allowConcurrentRuns?: boolean; // If false, skip trigger if a run is already active. Default: true
  stepTimeout?: number;          // Per-step timeout override (ms). Overrides env default.
  retainRunsCount?: number;      // Number of completed runs to retain. Default: 100. Max: 1000.
}
```

### 4.2 Step Types

All steps share a common base:

```typescript
interface StepBase {
  id: string;          // Unique within the pipeline. Alphanumeric + hyphens. Max 64 chars.
  name: string;        // Human-readable label (display only, not unique-enforced).
  type: StepType;
  inputs?: InputMapping;   // Maps pipeline context / prior step outputs to this step's input
  onError?: 'fail' | 'skip' | 'retry';  // Default: 'fail'. 'retry' is reserved (not MVP).
  condition?: string;  // JSONata expression; if present and evaluates to falsy, step is skipped
  timeout?: number;    // Per-step timeout override (ms). Max 3600000 (1 hour).
}
```

**Step type: `code`**

Executes a user-supplied code snippet in the Execution Service sandbox. Supports JS/TS (fast path via isolated-vm) and Python/Go (Docker sandbox).

```typescript
interface CodeStep extends StepBase {
  type: 'code';
  language: 'javascript' | 'typescript' | 'python' | 'go';
  code: string;            // Inline source code. Max 500KB. Stored in definition JSONB.
  entrypoint?: string;     // Named export to call. Default: 'main'. Must be async function.
}
```

**Step type: `connector`**

Triggers a connector fetch operation managed by the Ingestion Service. The pipeline waits for the ingestion batch to complete before advancing.

```typescript
interface ConnectorStep extends StepBase {
  type: 'connector';
  connectorInstanceId: string;   // ID of the connector instance (from ingestion schema)
  syncMode?: 'full' | 'incremental';   // Override the connector's default sync mode
  waitForCompletion: boolean;    // Default true. If false, step completes immediately after enqueue.
}
```

**Step type: `transformer`**

Applies a registered transformer plugin to the step's input data and returns the transformed output.

```typescript
interface TransformerStep extends StepBase {
  type: 'transformer';
  transformerId: string;         // Installed transformer plugin ID
  config?: Record<string, unknown>;  // Plugin-declared config schema (validated at definition time)
  entityType?: string;           // If present, transformer operates on this entity type's data
}
```

**Step type: `conditional`**

A branching step. Evaluates a JSONata expression against the current pipeline context and routes execution to one of two branches. Does not invoke the Execution Service — the condition is evaluated inside the Pipeline Service process using the `jsonata` library (safe, non-sandboxed, no network access).

```typescript
interface ConditionalStep extends StepBase {
  type: 'conditional';
  expression: string;     // JSONata expression. Evaluated against { input, steps: { [stepId]: output } }
  trueBranchStepId: string;    // Step to execute if expression is truthy
  falseBranchStepId: string;   // Step to execute if expression is falsy (use a terminal step if no false branch)
}
```

**Conditional security note:** JSONata expressions are evaluated against a limited context object (the pipeline's accumulated I/O state). The `jsonata` library provides no built-in I/O or module access. Expressions are limited to 5000 characters and evaluated with a 100ms timeout. If evaluation times out or throws, the step is treated as an `onError` failure.

**Step type: `parallel`**

Executes multiple branches concurrently. Each branch is a sub-sequence of steps identified by their IDs. All branches must reach terminal states before the parallel step is considered complete.

```typescript
interface ParallelStep extends StepBase {
  type: 'parallel';
  branches: ParallelBranch[];    // Max 10 branches (OP_PIPELINE_MAX_PARALLEL_BRANCHES)
  waitMode: 'all' | 'any';
  // 'all': all branches must complete successfully (fail-fast: if one fails, cancel others)
  // 'any': complete as soon as ANY branch completes successfully; cancel remaining branches
  // 'any' is useful for fan-out/race patterns
}

interface ParallelBranch {
  id: string;             // Branch identifier (used in run_steps and logs)
  entryStepId: string;    // First step in this branch
  steps: Step[];          // Steps local to this branch (cannot reference steps outside this branch)
}
```

**Step type: `webhook`**

Sends an outbound HTTP request to a configured URL and optionally waits for a response. This is an outbound call from within a pipeline (not an inbound webhook trigger). The URL is validated against the SSRF allowlist at definition save time and again at execution time.

```typescript
interface WebhookStep extends StepBase {
  type: 'webhook';
  url: string;               // HTTPS only in production. Validated against SSRF blocklist.
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;   // Static headers. Secrets must use input mapping from vault.
  body?: unknown;            // Request body template. JSONata expression if string starts with '='.
  responseMapping?: string;  // JSONata expression to extract the relevant part of the response.
  timeout?: number;          // Default 30000ms. Max 120000ms.
}
```

**SSRF prevention for webhook steps:** Before saving a pipeline definition containing a `webhook` step, the Pipeline Service validates the URL against the same SSRF blocklist as the Gateway Service (RFC-1918 ranges, loopback, link-local, metadata endpoints). A definition with a blocked URL is rejected with `PIPELINE_INVALID_WEBHOOK_URL`. The check is repeated at execution time because the URL may be dynamically resolved via input mapping.

### 4.3 Input/Output Mapping

Input mapping defines how each step receives its input. The source for any field can be:

- The pipeline run's top-level `input` payload
- The `output` of any previously completed step
- A literal value

```typescript
interface InputMapping {
  [fieldName: string]: InputSource;
}

type InputSource =
  | { from: 'pipeline.input'; path?: string }   // JSONPath into the run's input payload
  | { from: 'step'; stepId: string; path?: string }  // JSONPath into a prior step's output
  | { from: 'literal'; value: unknown };              // Hardcoded value

// Path examples:
//   { from: 'step', stepId: 'transform-data', path: '$.records[0].id' }
//   { from: 'pipeline.input', path: '$.entityType' }
//   { from: 'literal', value: 42 }
```

Input mapping is evaluated by the Pipeline Service before each step executes. JSONPath resolution uses the `jsonpath-plus` library. Invalid paths (no match) resolve to `undefined` — not an error unless the step's execution contract requires the field.

### 4.4 Example Pipeline Definition

```json
{
  "version": 1,
  "entryStepId": "check-mode",
  "steps": [
    {
      "id": "check-mode",
      "name": "Check Sync Mode",
      "type": "conditional",
      "expression": "input.mode = 'full'",
      "trueBranchStepId": "full-sync",
      "falseBranchStepId": "incremental-sync"
    },
    {
      "id": "full-sync",
      "name": "Full Connector Sync",
      "type": "connector",
      "connectorInstanceId": "conn_abc123",
      "syncMode": "full",
      "waitForCompletion": true
    },
    {
      "id": "incremental-sync",
      "name": "Incremental Connector Sync",
      "type": "connector",
      "connectorInstanceId": "conn_abc123",
      "syncMode": "incremental",
      "waitForCompletion": true
    },
    {
      "id": "transform-data",
      "name": "Normalize Records",
      "type": "transformer",
      "transformerId": "plugin_normalize_v2",
      "inputs": {
        "connectorOutput": { "from": "step", "stepId": "full-sync", "path": "$.batchId" }
      }
    },
    {
      "id": "notify",
      "name": "Post to Slack",
      "type": "webhook",
      "url": "https://hooks.slack.com/services/...",
      "method": "POST",
      "body": {
        "text": "=('Pipeline complete. Records: ' & $string(steps.transform-data.output.count))"
      }
    }
  ]
}
```

---

## 5. API Endpoints — Public

All public endpoints are prefixed with `/api/v1/` and require a valid bearer token or API key with the appropriate scope. Responses follow the `ApiResponse<T>` / `PaginatedResponse<T>` envelope.

### 5.1 Zod Schemas

```typescript
import { z } from 'zod';

const UUIDSchema = z.string().uuid();

const StepBaseSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9\-]*[a-z0-9]$/),
  name: z.string().min(1).max(255),
  type: z.enum(['code', 'connector', 'transformer', 'conditional', 'parallel', 'webhook']),
  inputs: z.record(z.discriminatedUnion('from', [
    z.object({ from: z.literal('pipeline.input'), path: z.string().optional() }),
    z.object({ from: z.literal('step'), stepId: z.string(), path: z.string().optional() }),
    z.object({ from: z.literal('literal'), value: z.unknown() }),
  ])).optional(),
  onError: z.enum(['fail', 'skip']).default('fail'),
  condition: z.string().max(5000).optional(),
  timeout: z.number().int().min(1000).max(3_600_000).optional(),
});

// Full step discriminated union (abbreviated — each type extends StepBaseSchema)
const StepSchema: z.ZodType<Step> = z.discriminatedUnion('type', [
  StepBaseSchema.extend({ type: z.literal('code'), language: z.enum(['javascript','typescript','python','go']), code: z.string().min(1).max(512_000), entrypoint: z.string().optional() }),
  StepBaseSchema.extend({ type: z.literal('connector'), connectorInstanceId: UUIDSchema, syncMode: z.enum(['full','incremental']).optional(), waitForCompletion: z.boolean().default(true) }),
  StepBaseSchema.extend({ type: z.literal('transformer'), transformerId: z.string(), config: z.record(z.unknown()).optional(), entityType: z.string().optional() }),
  StepBaseSchema.extend({ type: z.literal('conditional'), expression: z.string().max(5000), trueBranchStepId: z.string(), falseBranchStepId: z.string() }),
  StepBaseSchema.extend({ type: z.literal('parallel'), branches: z.array(z.object({ id: z.string(), entryStepId: z.string(), steps: z.array(z.lazy(() => StepSchema)) })).min(2).max(10), waitMode: z.enum(['all','any']) }),
  StepBaseSchema.extend({ type: z.literal('webhook'), url: z.string().url().startsWith('https://'), method: z.enum(['GET','POST','PUT','PATCH','DELETE']), headers: z.record(z.string()).optional(), body: z.unknown().optional(), responseMapping: z.string().optional(), timeout: z.number().int().min(1000).max(120_000).optional() }),
]);

const PipelineDefinitionSchema = z.object({
  version: z.literal(1),
  entryStepId: z.string(),
  steps: z.array(StepSchema).min(1).max(100),  // OP_PIPELINE_MAX_STEPS
  options: z.object({
    maxConcurrentRuns: z.number().int().min(1).max(50).optional(),
    allowConcurrentRuns: z.boolean().optional(),
    stepTimeout: z.number().int().min(1000).max(3_600_000).optional(),
    retainRunsCount: z.number().int().min(1).max(1000).optional(),
  }).optional(),
});

const CreatePipelineSchema = z.object({
  name: z.string().min(1).max(255).trim(),
  slug: z.string().min(3).max(64).regex(/^[a-z0-9][a-z0-9\-]{1,62}[a-z0-9]$/).optional(),
  // If omitted, slug is auto-derived from name (lowercase, spaces replaced with hyphens)
  description: z.string().max(1000).optional(),
  definition: PipelineDefinitionSchema,
  isActive: z.boolean().default(true),
});

const PatchPipelineSchema = z.object({
  name: z.string().min(1).max(255).trim().optional(),
  description: z.string().max(1000).optional(),
  definition: PipelineDefinitionSchema.optional(),
  isActive: z.boolean().optional(),
});

const TriggerPipelineSchema = z.object({
  input: z.record(z.unknown()).default({}),
  // Optional: override which pipeline version to run (reserved, not MVP)
});

const CreateScheduleSchema = z.object({
  pipelineId: UUIDSchema,
  cronExpr: z.string().min(1).max(100),
  timezone: z.string().min(1).max(64).default('UTC'),
  enabled: z.boolean().default(true),
  inputTemplate: z.record(z.unknown()).default({}),
});

const PatchScheduleSchema = z.object({
  cronExpr: z.string().min(1).max(100).optional(),
  timezone: z.string().min(1).max(64).optional(),
  enabled: z.boolean().optional(),
  inputTemplate: z.record(z.unknown()).optional(),
});
```

### 5.2 Pipelines

| Method | Path | Scope | Description |
|---|---|---|---|
| `GET` | `/api/v1/pipelines` | `pipelines:read` | List pipelines for the tenant (paginated) |
| `POST` | `/api/v1/pipelines` | `pipelines:manage` | Create a pipeline |
| `GET` | `/api/v1/pipelines/{id}` | `pipelines:read` | Get a single pipeline |
| `PATCH` | `/api/v1/pipelines/{id}` | `pipelines:manage` | Partial update (name, description, definition, isActive) |
| `DELETE` | `/api/v1/pipelines/{id}` | `pipelines:manage` | Delete pipeline and all associated runs/schedules/triggers |
| `POST` | `/api/v1/pipelines/{id}/trigger` | `pipelines:trigger` | Manually trigger a pipeline run |
| `GET` | `/api/v1/pipelines/{id}/runs` | `pipelines:read` | List runs for a specific pipeline (paginated) |

**`GET /api/v1/pipelines`**

Query params: `cursor`, `limit` (default 50, max 100), `filter[isActive][eq]=true`, `sort=-createdAt`.

Response `data` array items include: `id`, `tenantId`, `name`, `slug`, `description`, `isActive`, `createdAt`, `updatedAt`, `lastRunAt` (derived from most recent run, nullable).

**`POST /api/v1/pipelines`**

Request body: `CreatePipelineSchema`.

Validation steps (beyond Zod schema):
1. Verify `entryStepId` references an existing step in the `steps` array.
2. Verify all `trueBranchStepId` and `falseBranchStepId` in `conditional` steps reference existing steps (or steps within the same `parallel` branch).
3. Detect cycles in the step graph (DFS). A cycle is a `VALIDATION_ERROR`.
4. For `webhook` steps: validate each URL against the SSRF blocklist.
5. For `transformer` steps: verify `transformerId` is an installed, enabled transformer plugin for this tenant (via Plugin Service).

Returns `201 Created` with the created pipeline resource.

**`PATCH /api/v1/pipelines/{id}`**

Partial update. If `definition` is provided, all definition validation rules from POST apply. If `isActive` is set to `false`, all enabled schedules for this pipeline are paused immediately (their `enabled` flag is set to `false` in the database and the in-memory cron entries are removed). They are NOT automatically re-enabled when `isActive` is set back to `true` — operators must re-enable schedules explicitly.

**`DELETE /api/v1/pipelines/{id}`**

Cascade deletes: all `pipeline.runs`, `pipeline.run_steps`, `pipeline.run_logs`, `pipeline.schedules`, `pipeline.triggers`. If any run is in `running` status, the deletion is rejected with `409 Conflict` and error code `PIPELINE_RUNS_ACTIVE`. The operator must cancel active runs first.

**`POST /api/v1/pipelines/{id}/trigger`**

Request body: `TriggerPipelineSchema`.

Behaviour:
1. Load pipeline definition. Return `404 Not Found` if not found in tenant.
2. Check `is_active`. Return `409 Conflict` with `PIPELINE_INACTIVE` if not active.
3. If `options.allowConcurrentRuns = false`, check for active runs. Return `409 Conflict` with `PIPELINE_CONCURRENT_RUN_ACTIVE` if any run is in `pending` or `running` state.
4. Run `before:pipeline.trigger` hooks (see Section 9). If a critical hook fails, return `422 Unprocessable Entity` with the hook error.
5. Create a `pipeline.runs` row (status=`pending`). Snapshot the definition.
6. Enqueue a BullMQ job to `queue:pipeline:run` with the run ID.
7. Return `202 Accepted` with `{ data: { runId, status: 'pending' } }`.

### 5.3 Pipeline Runs

| Method | Path | Scope | Description |
|---|---|---|---|
| `GET` | `/api/v1/pipeline-runs/{runId}` | `pipelines:read` | Get run details including step statuses |
| `POST` | `/api/v1/pipeline-runs/{runId}/cancel` | `pipelines:trigger` | Request cancellation of an active run |
| `GET` | `/api/v1/pipeline-runs/{runId}/logs` | `pipelines:read` | SSE stream of run log entries |

**`GET /api/v1/pipeline-runs/{runId}`**

Returns the run row plus all associated `pipeline.run_steps` rows. The response includes a computed `durationMs` field (null if run is not yet complete).

**`POST /api/v1/pipeline-runs/{runId}/cancel`**

Sets a cancellation flag in Redis (`queue:pipeline:run:{runId}:cancel`, TTL 1 hour) that the BullMQ worker checks between steps. The run transitions to `cancelled` on the next inter-step check (not immediately). If the run is already in a terminal state, returns `409 Conflict` with `PIPELINE_RUN_ALREADY_TERMINAL`.

**`GET /api/v1/pipeline-runs/{runId}/logs`**

Returns an SSE stream (Content-Type: `text/event-stream`). See Section 11 for full streaming design.

### 5.4 Schedules

| Method | Path | Scope | Description |
|---|---|---|---|
| `GET` | `/api/v1/schedules` | `pipelines:read` | List all schedules for the tenant |
| `POST` | `/api/v1/schedules` | `pipelines:manage` | Create a schedule |
| `GET` | `/api/v1/schedules/{id}` | `pipelines:read` | Get a schedule |
| `PATCH` | `/api/v1/schedules/{id}` | `pipelines:manage` | Update cron expression, timezone, enabled state, or input template |
| `DELETE` | `/api/v1/schedules/{id}` | `pipelines:manage` | Delete a schedule |

**`POST /api/v1/schedules`**

Validates `cronExpr` using the `cron-parser` library. Rejects expressions with sub-minute granularity. Computes `next_run_at` using `cron-parser` with the given `timezone`. Adds the schedule to the in-memory cron scheduler immediately.

**`PATCH /api/v1/schedules/{id}`**

If `cronExpr` or `timezone` changes, recomputes `next_run_at`. If `enabled` changes to `false`, removes from the in-memory cron scheduler (existing in-flight runs are unaffected). If `enabled` changes to `true`, adds back to the scheduler.

---

## 6. API Endpoints — Internal

Internal endpoints are under the `/internal/` prefix. They require a valid `X-Service-Token` header validated by the `serviceAuth` middleware. They are not exposed via the Gateway Service.

### 6.1 Trigger Endpoint

**`POST /internal/pipeline/trigger`**

Used by: Ingestion Service, App Service (per service RBAC matrix in `@oneplatform/core/service-rbac.ts`).

Request body:
```typescript
interface InternalTriggerRequest {
  pipelineId: string;          // UUID
  tenantId: string;            // UUID — caller must supply; Pipeline Service validates existence
  triggeredBy: 'service';
  callerService: string;       // Service name from the service token
  callerRequestId?: string;    // Trace propagation
  input?: Record<string, unknown>;
}
```

Response: `202 Accepted` with `{ data: { runId, status: 'pending' } }`.

Behaviour is identical to `POST /api/v1/pipelines/{id}/trigger` except:
- No user auth check (only service token validation)
- `triggered_by` is set to `'service'` in the run row
- The `trigger_meta` JSONB records `{ callerService, callerRequestId }`

---

## 7. Execution Engine

### 7.1 Overview

The execution engine is a BullMQ worker that processes jobs from the `queue:pipeline:run` queue. Each job represents a single pipeline run (identified by `runId`). The worker drives the pipeline's step graph from `entryStepId` to completion by executing one step at a time (except for parallel steps, which fan out).

```
BullMQ job payload:
{
  runId: string;       // UUID — the pipeline.runs row to execute
  tenantId: string;
}
```

### 7.2 Step Execution State Machine

Each `pipeline.run_steps` row transitions through states:

```
             ┌────────────┐
             │  pending   │  (created at run start, before step is reached)
             └─────┬──────┘
                   │ step is about to execute
                   ▼
             ┌────────────┐
             │  running   │  (step is executing in Execution Service sandbox)
             └──┬────┬────┘
                │    │
      success   │    │  error / timeout
                ▼    ▼
          ┌──────┐ ┌────────┐
          │done  │ │ failed │  (terminal)
          └──────┘ └────────┘
                              ┌──────────┐
                              │ skipped  │  (conditional branch not taken)
                              └──────────┘
                              ┌──────────┐
                              │cancelled │  (run-level cancellation received)
                              └──────────┘
```

### 7.3 Worker Algorithm

```
ProcessPipelineRun(runId, tenantId):

1. Load run from DB. If run.status != 'pending', log warning and return (idempotency guard).
2. Acquire advisory lock: pg_try_advisory_lock(hashPipelineId(run.pipeline_id)).
   If lock not acquired: log "concurrent run in progress", set run.status = 'pending',
   re-enqueue with delay 5s. Return.
3. Set run.status = 'running', run.started_at = now().
4. Create run_steps rows for all steps in the definition snapshot (status='pending').
5. Append pipeline-level log: "Pipeline run started, triggered by {triggered_by}".
6. Execute hooks: run 'before:pipeline.trigger' → not repeated here (already ran in trigger).
   Note: 'before:pipeline.trigger' runs synchronously before the run is queued (Section 9.1).
   'after:pipeline.trigger' runs now, at the start of execution. If a critical hook fails:
   set run.status='failed', run.completed_at=now(), release lock, return.
7. Begin step graph traversal starting at entryStepId.

   For each step (recursive traversal via executeStep()):
   a. Check cancellation flag in Redis (queue:pipeline:run:{runId}:cancel).
      If set: mark all remaining steps 'cancelled', set run.status='cancelled',
      run.completed_at=now(). Run 'after:pipeline.complete' hooks (advisory only at cancel).
      Release advisory lock. Return.
   b. Evaluate step.condition if present (JSONata, 100ms timeout, no I/O).
      If condition is falsy: set run_step.status='skipped'. Advance to next step. Continue.
   c. Resolve step inputs via InputMapping (Section 4.3). Collect prior step outputs from run_steps.
   d. Run 'before:pipeline.step:{stepId}' hooks. If critical hook fails:
      set run_step.status='failed', propagate up as step failure.
   e. Set run_step.status='running', run_step.started_at=now().
   f. Execute the step by type:
      - code/transformer: POST /internal/execution/run → Execution Service
        Request body: { pluginId, entrypoint, input, timeoutMs, tenantId, runId, stepId, hookContext: false }
        The Execution Service fetches the plugin bundle itself; Pipeline Service does NOT send bundleUrl.
      - connector: POST /internal/ingestion/sync → Ingestion Service
        Request body: { connectorInstanceId, syncMode, tenantId, runId, stepId, waitForCompletion }
        The Ingestion Service enqueues the sync job and (when waitForCompletion=true) blocks until
        the sync job reaches a terminal state before returning. See ingestion-service.md §4.5 for
        the full endpoint specification. When waitForCompletion=false, the step completes immediately
        after the sync is enqueued (fire-and-forget).
      - conditional: evaluate expression (synchronous, no network call)
      - parallel: fan out to all branches (Section 7.4)
      - webhook: perform HTTP request with SSRF check (Section 4.2)
   g. Set run_step.status='completed' or 'failed' based on result.
      run_step.completed_at=now(). Store output in run_step.output.
   h. If step failed and run_step.onError='skip': log warning, continue to next step.
      If step failed and run_step.onError='fail': propagate failure (goto step 9).
   i. Run 'after:pipeline.step:{stepId}' hooks.
   j. Determine next step ID. For sequential flow: step's 'nextStepId' field (not shown
      in StepBase — implicit: the next step is determined by the traversal engine's
      linear ordering of steps in the definition's steps array, after conditional routing).
      After a conditional step: next step is trueBranchStepId or falseBranchStepId.
      After a parallel step: next step is the step declared after the parallel block.

8. All steps completed:
   Run 'before:pipeline.complete' hooks. If critical hook fails: mark run as failed.
   Set run.status='completed', run.completed_at=now().
   Run 'after:pipeline.complete' hooks (advisory-only; failure logged but does not change run status).
   Release advisory lock.
   Emit platform event: pipeline.completed.
   Append pipeline-level log: "Pipeline run completed in {durationMs}ms".

9. On step failure (propagated from step f/g):
   Set run.status='failed', run.completed_at=now(), run.error={code, message, stepId}.
   Mark all remaining pending steps as 'cancelled'.
   Run 'after:pipeline.complete' hooks (advisory-only).
   Release advisory lock.
   Emit platform event: pipeline.failed.
   Append pipeline-level log: "Pipeline run failed at step {stepId}: {error.message}".

Advisory lock release is always in a finally block — the lock is released even if the
worker process is killed mid-run. On next BullMQ retry, step 2's lock acquisition will succeed.
```

### 7.4 Parallel Step Execution

Parallel branches execute concurrently using `Promise.all()` (for `waitMode: 'all'`) or `Promise.race()` (for `waitMode: 'any'`). Each branch is driven by the same `executeStep()` function called with its own isolated step context. Branch steps share the top-level pipeline context (read-only access to prior step outputs) but write their outputs into namespaced keys (`steps.{branchId}.{stepId}.output`).

If `waitMode: 'all'` and any branch fails, the other branches receive a cancellation signal and are marked `cancelled`. The parallel step itself is marked `failed`.

If `waitMode: 'any'` and a branch completes successfully, all other running branches receive a cancellation signal. The parallel step is marked `completed` with the output of the winning branch.

### 7.5 Execution Service Dispatch

For `code` and `transformer` steps, the Pipeline Service dispatches to the Execution Service:

```typescript
// POST /internal/execution/run
interface ExecutionRequest {
  // For plugin-backed steps (transformer): provide pluginId; Execution Service fetches the bundle.
  // For inline code steps: provide language + code directly.
  pluginId?: string;        // Plugin manifest_id — used for transformer steps
  language?: 'javascript' | 'typescript' | 'python' | 'go';  // Used for inline code steps
  code?: string;            // Inline source code — used for code steps
  entrypoint: string;
  input: Record<string, unknown>;
  timeoutMs: number;        // Resolved step timeout in milliseconds
  tenantId: string;
  runId: string;            // For correlation in Execution Service logs
  stepId: string;           // For correlation
  hookContext: false;       // Always false for step execution (not a hook call)
  // hookContext: true is set when Pipeline Service dispatches a hook (Section 9)
  // The Execution Service uses this to enforce HookRecursionError (ADR-16)
}

interface ExecutionResponse {
  executionId: string;
  output: unknown;
  durationMs: number;
  exitCode: number;
}
```

### 7.6 Step Graph Traversal and Linear Ordering

The Pipeline Service resolves the step execution order at run start by topologically sorting the step graph using a DFS starting from `entryStepId`. This order is stored in the run's `definition_snapshot` as `executionOrder: string[]` so the UI can display steps in the correct sequence without re-traversal.

At runtime, the worker follows the dynamic path determined by conditional branching — not a pre-computed linear order. The `executionOrder` is only used for display purposes.

---

## 8. Trigger System

### 8.1 Cron Triggers

The cron scheduler is an in-memory loop that wakes every 30 seconds. On each tick:

1. Query `pipeline.schedules WHERE enabled = true AND next_run_at <= now()`.
2. For each due schedule: enqueue a pipeline run (same flow as manual trigger), update `last_run_at = now()`, recompute `next_run_at` using `cron-parser`.
3. The database update and run creation happen in a single transaction. If the transaction fails, the schedule is not marked as run and will be retried on the next 30-second tick.

**Missed run handling on restart:** If the service restarts and `next_run_at` is in the past, the schedule is treated as due on the next cron tick (within 30 seconds of startup). A missed cron run is logged as a warning but is not automatically back-filled. The platform does not support catch-up runs for missed cron schedules (explicitly not implemented to avoid thundering-herd on restart).

**Cron expression validation:** The `cron-parser` library validates expressions at schedule creation. Second-level granularity (`*/5 * * * * *` with 6 fields) is rejected with `PIPELINE_CRON_INVALID` — minimum granularity is 1 minute. Expressions are validated for timezone compatibility.

**Next-run computation:**

```typescript
import { parseExpression } from 'cron-parser';

function computeNextRunAt(cronExpr: string, timezone: string): Date {
  const interval = parseExpression(cronExpr, {
    tz: timezone,
    currentDate: new Date(),
  });
  return interval.next().toDate();
}
```

### 8.2 Event-Driven Triggers

Event-driven triggers subscribe to Redis pub/sub channels. The Pipeline Service maintains one Redis subscriber connection per event trigger group (channels are grouped by tenant to reduce connection count).

At startup, all enabled `pipeline.triggers WHERE trigger_type = 'event'` rows are loaded and subscriptions are established. When a new event trigger is created via the API, the subscription is added live without restart.

On receiving a pub/sub message:

1. Deserialize the message as a `PlatformEvent`.
2. Look up all matching triggers: those subscribed to this channel with matching `eventType` (if configured) and passing the `filter` JSONata expression (if configured).
3. For each matching trigger: enqueue a pipeline run with the event payload as `input`. `triggered_by = 'event'`, `trigger_meta = { channel, eventType, eventId }`.
4. If the pipeline's `allowConcurrentRuns = false` and a run is already active, the trigger is silently dropped (logged as info: "event trigger skipped: concurrent run active").

**Event filter evaluation:** The optional `filter` JSONata expression in the trigger config is evaluated against the event's `data` field. If the expression throws or times out (100ms limit), the trigger fires anyway (fail-open for advisory triggers, fail-closed if the pipeline's trigger is marked critical — the trigger row has no criticality field; all event triggers are fail-open by default in MVP).

### 8.3 Webhook Triggers

A `webhook` trigger creates a unique inbound URL at `/api/v1/webhooks/inbound/{slug}` via the Gateway Service. The Pipeline Service registers the slug with the Gateway on trigger creation.

When the Gateway receives a POST to this URL:
1. The Gateway forwards the request to `POST /internal/pipeline/trigger` with the full body, headers, and the trigger ID.
2. The Pipeline Service verifies the HMAC-SHA256 signature (`X-OnePlatform-Signature: sha256={hex}`). The HMAC secret is stored in the trigger's config JSONB.
3. If the signature is valid: enqueue a pipeline run with the request body as `input`. `triggered_by = 'webhook'`, `trigger_meta = { triggerId, requestId }`.
4. Returns `202 Accepted` immediately (does not wait for the run to complete).

HMAC verification uses a constant-time comparison to prevent timing attacks.

### 8.4 Manual Triggers

Manual triggers have no persistent configuration. They are invoked via `POST /api/v1/pipelines/{id}/trigger` (Section 5.2). The `triggered_by` field is `'manual'` and the `trigger_actor_id` is the authenticated user's ID.

---

## 9. Hook Linearization

The Pipeline Service implements hook orchestration at three hook points per ADR-16 and ADR-31.

### 9.1 Hook Points

| Stage | When | Criticality Matters |
|---|---|---|
| `before:pipeline.trigger` | Before run is enqueued (synchronous, in the trigger handler) | Yes — critical hook failure prevents the run from starting |
| `after:pipeline.trigger` | At the start of the BullMQ worker (after run transitions to `running`) | Yes — critical hook failure marks run as `failed` before any steps execute |
| `before:pipeline.step:{stepId}` | Before each step executes | Yes — critical hook failure marks the step as `failed`, propagates up |
| `after:pipeline.step:{stepId}` | After each step completes | Yes — critical hook failure marks step as `failed` even if step succeeded |
| `before:pipeline.complete` | After all steps complete, before run is marked terminal | Yes — critical hook failure marks run as `failed` |
| `after:pipeline.complete` | After run transitions to terminal state | No — hook failures are logged but do not change run status |

### 9.2 Hook Resolution

The Pipeline Service resolves the hook chain from the Plugin Service before each hook point:

```typescript
// GET /internal/plugins/hooks?stage={stage}&tenantId={tenantId}
interface HookChainResponse {
  hooks: HookRef[];
}

interface HookRef {
  hookId: string;
  pluginId: string;
  entrypoint: string;      // Named export in the plugin bundle
  criticality: 'critical' | 'advisory';
  timeoutMs: number;       // ms — set in plugin manifest, max 300000
  priority: number;        // lower = earlier
}
```

The returned array is already sorted by priority (ascending) by the Plugin Service.

### 9.3 Hook Execution

Each hook in the chain is executed sequentially by calling the Execution Service:

```typescript
// POST /internal/execution/run (same endpoint as step execution)
interface HookExecutionRequest {
  // pluginId is the manifest_id; Execution Service fetches the bundle itself from Plugin Service.
  // bundleUrl is NOT sent — the Execution Service is authoritative for bundle fetching (ADR-6).
  pluginId: string;         // Plugin manifest_id (e.g. "com.example.my-plugin")
  entrypoint: string;       // The hook's declared entrypoint
  input: HookPayload;       // The data payload for this hook point
  timeoutMs: number;        // Hook-specific timeout in milliseconds (from HookRef.timeoutMs)
  tenantId: string;
  runId?: string;
  stepId?: string;
  hookContext: true;        // Tells Execution Service to enforce HookRecursionError
}

interface HookPayload {
  stage: string;
  data: Record<string, unknown>;  // The data that the hook may modify and return
  meta: {
    pipelineId: string;
    runId?: string;
    stepId?: string;
    tenantId: string;
  };
}
```

The Execution Service sets `hookContext: true` internally (strips it from user-visible context, per ADR-16) and uses it to block any calls to `pipeline.trigger()` or `queue.enqueue()` from within hook code, returning `HookRecursionError` to the hook caller.

### 9.4 Criticality Enforcement

```
For each hook in the chain:

1. Call Execution Service with hookContext: true and the hook's timeoutMs.
2. If execution succeeds:
   - Replace current payload with the hook's returned payload.
   - Continue to next hook.
3. If execution fails (error or timeout):
   a. criticality = 'critical':
      - Abort the hook chain.
      - Return an error to the caller: PIPELINE_HOOK_CRITICAL_FAILURE
      - Include: { hookId, pluginId, stage, error: { code, message } }
   b. criticality = 'advisory':
      - Log warning: "Advisory hook {hookId} failed: {error.message}. Continuing with pre-hook payload."
      - Continue the chain using the ORIGINAL payload (not the failed hook's partial output).
      - Continue to next hook.
4. After all hooks: return the final payload (modified by successful hooks only).
```

### 9.5 Timeout Handling

Each hook has an individual timeout sourced from the plugin manifest (default 30s, maximum 300s). The Pipeline Service sets this timeout in the Execution Service request. The Execution Service enforces it and returns a timeout error. The Pipeline Service applies criticality logic as in Section 9.4.

The total hook chain timeout is not bounded separately — the sum of individual hook timeouts sets the effective upper bound. For a chain of 10 hooks each with 30s timeout, the chain could take up to 300s. This is acceptable because hook chains are expected to be short (0-5 hooks per stage in practice), and the BullMQ job's `attempts` and `backoff` policy handles retries if the overall job times out at the BullMQ level.

### 9.6 Empty Hook Chains

If the Plugin Service returns an empty hook array for a stage (no plugins registered for that stage), the Pipeline Service proceeds with the original payload immediately. No Execution Service call is made.

---

## 10. DLQ and Reliability

### 10.1 BullMQ Retry Policy

Per ADR-13, the `queue:pipeline:run` queue is configured with:

```typescript
{
  attempts: 5,
  backoff: {
    type: 'exponential',
    delay: 1_000,  // Base delay 1s → retries at ~1s, 2s, 4s, 8s, 16s (total ~31s wait)
  },
}
```

This is provided by `createQueue()` from `@oneplatform/core/queue.ts` which applies `DEFAULT_JOB_OPTIONS` automatically.

### 10.2 Poison-Pill Detection

Per ADR-13, if the same job ID fails 3+ times in under 60 seconds, it is immediately moved to the DLQ without waiting for the remaining retries:

```typescript
// In the BullMQ worker's onFailed handler:
async function onFailed(job: Job, error: Error): Promise<void> {
  const failedAt = Date.now();
  const recentFailures = await job.getFailedReason(); // Check BullMQ's failure log
  // If job.attemptsMade >= 3 and the first attempt was within 60s of now:
  const firstAttemptTimestamp = job.timestamp;
  const elapsed = failedAt - firstAttemptTimestamp;
  if (job.attemptsMade >= 3 && elapsed < 60_000) {
    await moveToDlq(job, error, 'poison_pill_detected');
    return;
  }
  // Otherwise, BullMQ's retry backoff handles the next attempt.
}
```

### 10.3 Dead Letter Queue

After exhausting all retries (or on poison-pill detection), the job is moved to `queue:pipeline:run:dlq` using `createDlqQueue()` from `@oneplatform/core/queue.ts`. The DLQ entry contains:

```typescript
interface DlqEntry {
  originalJobId: string;
  runId: string;
  tenantId: string;
  pipelineId: string;
  originalPayload: unknown;
  errorStack: string;
  failureReason: 'max_retries' | 'poison_pill_detected';
  retryCount: number;
  firstAttemptAt: string;  // ISO timestamp
  movedToDlqAt: string;    // ISO timestamp
}
```

Moving a job to the DLQ also:
1. Sets the `pipeline.runs` row `status = 'failed'` and `error = { code: 'DLQ_MOVED', message: '...' }` if not already set.
2. Emits a `pipeline.failed` platform event.
3. Logs an audit event via the Logging Service: `pipeline.run.dlq_moved`.

### 10.4 DLQ Inspection and Replay

The frontend DLQ dashboard (and CLI `op dlq` commands) use these endpoints:

| Method | Path | Scope | Description |
|---|---|---|---|
| `GET` | `/api/v1/pipeline-runs/dlq` | `pipelines:manage` | List DLQ entries for the tenant |
| `POST` | `/api/v1/pipeline-runs/dlq/{jobId}/replay` | `pipelines:manage` | Move job back to active queue |
| `DELETE` | `/api/v1/pipeline-runs/dlq/{jobId}` | `pipelines:manage` | Discard a DLQ entry |

**Replay mechanism:** `replay` creates a NEW pipeline run row (new UUID) with `triggered_by = 'service'` and `trigger_meta = { replayOf: originalRunId, replayedBy: userId }`. It enqueues a fresh BullMQ job. The original DLQ entry is removed. This preserves the original run's history for audit purposes while starting a clean execution attempt.

### 10.5 Queue Depth Monitoring

Per ADR-13, the Logging Service polls the BullMQ queue depths every 30 seconds. The Pipeline Service exposes queue depth metrics via the `/healthz` response:

```json
{
  "status": "healthy",
  "queues": {
    "pipeline:run": { "active": 3, "waiting": 42, "failed": 1, "dlq": 0 },
    "pipeline:cron": { "active": 0, "waiting": 0, "failed": 0 }
  }
}
```

An alert is generated when `waiting / maxLength > 0.80` (80% of max queue length of 10,000 = 8,000 waiting jobs).

### 10.6 Redis WAL Fallback

When Redis is unavailable, the Pipeline Service cannot enqueue BullMQ jobs. In this state:

1. The service writes pending run enqueue operations to `/data/job-buffer.wal` (max 50MB, per ADR-18).
2. Each WAL record is a length-prefixed JSON blob with a CRC32 checksum trailer.
3. New API trigger calls return `503 Service Unavailable` with `PIPELINE_QUEUE_UNAVAILABLE` after WAL capacity is exceeded.
4. When Redis reconnects, the WAL is replayed in order and then truncated.
5. During the Redis outage, `pipeline.runs` rows are created in Postgres (state `pending`) — these are reconciled during WAL replay.

---

## 11. Run Logging and SSE Streaming

### 11.1 Log Entry Structure

```typescript
interface RunLogEntry {
  id: number;           // BIGSERIAL from pipeline.run_logs — used as SSE cursor
  runId: string;
  stepId?: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  details?: unknown;
  createdAt: string;    // ISO timestamp
}
```

### 11.2 Log Emission

Log entries are written to `pipeline.run_logs` directly from the BullMQ worker as steps execute. This is a synchronous write within the step execution flow (not async pub/sub) to preserve ordering guarantees. Log writes use a dedicated long-lived session-mode connection from the PgBouncer pool.

### 11.3 SSE Endpoint

**`GET /api/v1/pipeline-runs/{runId}/logs`**

Query params:
- `lastEventId` (optional): The `id` value of the last log entry received. If provided, only entries with `id > lastEventId` are returned. Used for SSE reconnection via `Last-Event-ID` header.
- `follow` (optional, default `true`): If `true`, the connection remains open and new log entries are streamed as they are written. If `false`, existing entries are returned and the connection is closed.

**Response headers:**

```
Content-Type: text/event-stream
Cache-Control: no-cache
X-Accel-Buffering: no      (disables Nginx response buffering)
Connection: keep-alive
```

**SSE event format:**

```
id: 42
event: log
data: {"id":42,"runId":"...","stepId":"transform-data","level":"info","message":"Processing 1250 records","details":{"count":1250},"createdAt":"2026-06-10T14:23:11.042Z"}

id: 43
event: log
data: {"id":43,"runId":"...","level":"info","message":"Pipeline run completed in 4231ms","createdAt":"2026-06-10T14:23:15.273Z"}

id: 43
event: done
data: {"runId":"...","status":"completed","durationMs":4231}

```

The `done` event is sent when the run reaches a terminal state (`completed`, `failed`, or `cancelled`). Clients should close the connection on receiving `done`.

**Polling implementation:**

The SSE handler uses a database polling loop (interval 500ms) rather than Postgres `LISTEN/NOTIFY` to avoid complicating the session-mode connection pool. This is acceptable for pipeline log streaming — 500ms polling latency is imperceptible in a workflow monitoring context.

```typescript
async function* streamRunLogs(runId: string, lastId: number): AsyncGenerator<RunLogEntry> {
  let cursor = lastId;
  while (true) {
    const rows = await db.query(
      'SELECT * FROM pipeline.run_logs WHERE run_id = $1 AND id > $2 ORDER BY id ASC LIMIT 100',
      [runId, cursor]
    );
    for (const row of rows) {
      yield row;
      cursor = row.id;
    }
    // Check if run is terminal; if so, yield any remaining logs and stop
    const run = await db.query('SELECT status FROM pipeline.runs WHERE id = $1', [runId]);
    if (['completed', 'failed', 'cancelled'].includes(run.rows[0]?.status) && rows.length === 0) {
      return;
    }
    await sleep(500);
  }
}
```

**Concurrency:** Each SSE connection holds one Postgres connection from the session-mode pool. With a pool size of 25 connections and typical concurrent log streams, the practical limit is ~20 simultaneous SSE log streams per service instance. For larger deployments, horizontal scaling (multiple pipeline service instances) is the primary remedy. Each instance can serve its own SSE connections; clients may need to connect to a specific instance if using a load balancer without sticky sessions. The recommended load balancer configuration uses sticky session routing for SSE endpoints.

---

## 12. Session-Mode PgBouncer

### 12.1 Why Session Mode

The Pipeline Service requires session-mode PgBouncer (as opposed to transaction mode) for two reasons:

1. **Advisory locks:** PostgreSQL advisory locks (`pg_try_advisory_lock`, `pg_advisory_unlock`) are session-scoped. In transaction-mode pooling, the connection is returned to the pool after each transaction commit. An advisory lock acquired in one transaction would be silently released when PgBouncer reassigns the connection to another session. This would make the pipeline concurrency mutex non-functional — two workers could hold locks on the same pipeline simultaneously.

2. **SSE streaming:** Long-lived SSE log streaming holds a Postgres connection open for the duration of the stream. Transaction-mode pooling is incompatible with connections held for multiple seconds to minutes.

### 12.2 Configuration

The Pipeline Service connects to a separate PgBouncer pool configured for session mode:

```ini
# docker/pgbouncer/pgbouncer-session.ini
[databases]
pipeline_session = host=postgres port=5432 dbname=oneplatform

[pgbouncer]
pool_mode = session
max_client_conn = 50
default_pool_size = 25   ; pipeline-service allocation per ADR-5
server_idle_timeout = 600
client_idle_timeout = 0  ; no idle timeout for SSE connections
```

The environment variable `DATABASE_URL` for the Pipeline Service points to this session-mode PgBouncer pool, NOT the transaction-mode pool used by all other services. This is enforced by Docker Compose environment variable configuration.

### 12.3 Advisory Lock Design

```typescript
// Advisory lock key derivation: deterministic, per-tenant per-pipeline
// Uses a 64-bit integer derived from the pipeline UUID to avoid collisions
function advisoryLockKey(pipelineId: string): bigint {
  // Take first 8 bytes of the UUID (remove hyphens, parse as hex bigint)
  const hex = pipelineId.replace(/-/g, '').slice(0, 16);
  return BigInt('0x' + hex);
}

// Acquire lock (non-blocking, returns false if already held)
async function tryAcquireAdvisoryLock(client: pg.PoolClient, pipelineId: string): Promise<boolean> {
  const key = advisoryLockKey(pipelineId);
  const result = await client.query('SELECT pg_try_advisory_lock($1)', [key]);
  return result.rows[0].pg_try_advisory_lock === true;
}

// Release lock — must be called on the SAME client that acquired it
async function releaseAdvisoryLock(client: pg.PoolClient, pipelineId: string): Promise<void> {
  const key = advisoryLockKey(pipelineId);
  await client.query('SELECT pg_advisory_unlock($1)', [key]);
}
```

The BullMQ worker uses a single dedicated long-lived client for advisory lock acquisition. This client is NOT returned to the pool while a run is executing. On run completion (success, failure, or cancellation), the lock is released and the client is returned to the pool.

**Lock collision potential:** Two pipeline IDs could theoretically hash to the same 64-bit lock key (birthday paradox). With 64-bit keys and expected pipeline counts in the thousands, the collision probability is negligible (< 10^-12 for 1 million pipelines). The advisory lock failing to block a true concurrent run is the failure mode — runs would execute concurrently when they should not. The risk is accepted as negligible.

---

## 13. Concurrency Control

### 13.1 Pipeline-Level Mutex

The advisory lock in Section 12.3 ensures that at most one BullMQ worker executes any given pipeline at a time (per tenant). This prevents:
- Duplicate runs triggered by simultaneous cron ticks on multiple service instances
- Race conditions in shared-step output state

The mutex is pipeline-scoped (per `pipeline_id`), not tenant-scoped. Two different pipelines in the same tenant execute concurrently without contention.

### 13.2 Step-Level Parallelism

Within a `parallel` step, branches execute concurrently using Node.js `Promise.all()` or `Promise.race()`. Each branch dispatches its steps to the Execution Service independently. The Execution Service's own concurrency limits (managed by its own BullMQ worker pool) constrain the total parallel execution capacity.

The Pipeline Service enforces `OP_PIPELINE_MAX_PARALLEL_BRANCHES` (default 10) to prevent a single pipeline run from overwhelming the Execution Service.

### 13.3 Queue Concurrency

The `queue:pipeline:run` BullMQ worker is configured with `concurrency: OP_PIPELINE_MAX_CONCURRENT_RUNS` (default 20). This controls how many pipeline runs execute simultaneously across all tenants on this service instance. With multiple pipeline service instances (horizontal scaling), the effective concurrency multiplies.

Each concurrent run holds one session-mode Postgres connection (for the advisory lock) plus additional connections for log writes. With 20 concurrent runs and a pool of 25 session-mode connections, there is headroom for 5 SSE streaming connections before the pool is saturated. In high-SSE-load scenarios, `OP_PIPELINE_MAX_CONCURRENT_RUNS` should be reduced accordingly.

### 13.4 Cross-Instance Coordination

In a multi-instance deployment, multiple pipeline service instances share the same:
- Postgres session-mode pool (bounded by 25 total server connections)
- BullMQ queue (Redis-backed, all instances share the same queue)
- Advisory locks (Postgres-backed, globally exclusive regardless of which instance acquires them)

This means the advisory lock provides correct mutual exclusion across instances. The BullMQ queue ensures each job is processed by exactly one worker instance (BullMQ's at-least-once delivery guarantee handles worker crashes via job visibility timeouts).

---

## 14. Inter-Service Communication

### 14.1 Execution Service

Used for: step code execution (code steps, transformer steps), hook dispatch.

Endpoint: `POST /internal/execution/run` (per service RBAC matrix).

The Pipeline Service is the primary consumer of the Execution Service. All requests carry the `X-Service-Token` and optionally an `X-User-Context` header (for user-triggered runs, forwarding the user's identity for audit purposes).

### 14.2 Ontology Service

Used for: schema lookups when transformer steps reference an `entityType`.

Endpoint: `GET /internal/ontology/schema?entityType={type}&tenantId={tenantId}` (per service RBAC matrix).

The response is cached in-memory with the ontology cache module from `@oneplatform/core` (pub/sub + 5-minute poll fallback). Cache invalidation is triggered by ontology change events on the `ontology:*` Redis channel, which the Pipeline Service is subscribed to.

### 14.3 Plugin Service

Used for: resolving hook chains before each hook point.

Endpoint: `GET /internal/plugins/hooks?stage={stage}&tenantId={tenantId}` (per service RBAC matrix).

Hook chain responses are NOT cached because plugin installations and disablements must take effect immediately on the next hook invocation. The request is lightweight (returns a small JSON array of hook references).

### 14.4 Service Token Issuance

All inter-service requests use Ed25519-signed service JWTs with a 5-minute expiry. The Pipeline Service generates a new service token for each outbound request using its private key at `/data/service.key`. Token generation is synchronous and in-memory (no Redis, no Postgres lookup required).

---

## 15. Error Handling

### 15.1 Step Failures

When a step fails:

1. The `run_step.status` is set to `failed` and `run_step.error` is populated with `{ code, message, details }`.
2. If `step.onError = 'fail'` (default): the failure propagates up. All remaining steps are marked `cancelled`. The run is marked `failed`.
3. If `step.onError = 'skip'`: the failure is logged as a warning. The traversal continues to the next step in the graph. The step's output is `null` — any downstream steps that use this step's output via `InputMapping` will receive `undefined` for those fields.

### 15.2 Timeout Handling

Step timeouts are enforced by the Execution Service. The Pipeline Service sets the `timeout` field in the execution request. If the Execution Service returns a timeout error:
- The step is treated as a failure with error code `STEP_EXECUTION_TIMEOUT`.
- The `onError` policy applies as above.

### 15.3 Cascading Failures

A failed `critical` hook at `before:pipeline.trigger` prevents the run from being created. This is the only hook failure that surfaces synchronously to the API caller (as a 422 response).

All other hook failures and step failures are handled within the BullMQ worker. If the BullMQ worker itself throws an unhandled exception (not a step error, but a worker-level error such as a Postgres connection failure mid-run), BullMQ's retry mechanism kicks in. The `pipeline.runs` row remains in `running` status during the retry window. On the next attempt, the advisory lock re-acquisition step (step 2 in Section 7.3) will succeed (the previous attempt's lock was released on process exit) and execution restarts from the beginning.

**Idempotency concern:** Restarting a run from the beginning after a worker crash means steps that already completed will re-execute. For MVP, this is accepted. A future enhancement would checkpoint the execution state in Redis and resume from the last successfully completed step.

### 15.4 Partial Completion

If a `parallel` step's branches are executing and the BullMQ worker crashes:
- The `run_steps` rows for in-progress parallel branches will be in `running` state.
- On BullMQ retry, the run restarts from the entry step (as per Section 15.3).
- Parallel branches will re-execute from their entry steps.

This idempotency gap is documented as a known limitation for MVP. The workaround is to design pipeline steps to be idempotent (recommended practice).

### 15.5 Pipeline Service Unavailability

If the Pipeline Service restarts:
- Active BullMQ jobs: BullMQ retains job state in Redis. Unfinished jobs (those not acknowledged) are re-queued after the BullMQ visibility timeout (default 30 seconds). Workers on the new instance pick them up.
- Cron schedules: the scheduler is re-initialized from Postgres on startup (Section 1.3, step 8). Missed cron runs are not back-filled.
- Event subscriptions: re-established on startup from Postgres (Section 1.3, step 9). Events received during the restart window are lost (Redis pub/sub is fire-and-forget).
- SSE connections: clients receive a connection error and must reconnect. The `Last-Event-ID` mechanism allows them to resume without missing log entries.

---

## 16. Error Codes

The Pipeline Service extends the base error registry from `@oneplatform/core/errors.ts` with the following `PIPELINE_` prefixed codes:

| Code | HTTP | Description |
|---|---|---|
| `PIPELINE_NOT_FOUND` | 404 | Pipeline ID does not exist in this tenant |
| `PIPELINE_INACTIVE` | 409 | Pipeline `is_active = false`; trigger rejected |
| `PIPELINE_CONCURRENT_RUN_ACTIVE` | 409 | `allowConcurrentRuns = false` and a run is already active |
| `PIPELINE_RUNS_ACTIVE` | 409 | Cannot delete pipeline with active runs |
| `PIPELINE_RUN_NOT_FOUND` | 404 | Pipeline run ID does not exist |
| `PIPELINE_RUN_ALREADY_TERMINAL` | 409 | Cancel requested on a run already in terminal state |
| `PIPELINE_DEFINITION_INVALID` | 422 | Definition validation failed (step references, cycles, SSRF) |
| `PIPELINE_CRON_INVALID` | 422 | Invalid or sub-minute cron expression |
| `PIPELINE_HOOK_CRITICAL_FAILURE` | 422 | A critical hook in the chain returned an error |
| `PIPELINE_QUEUE_UNAVAILABLE` | 503 | Redis unavailable and WAL buffer full; cannot enqueue run |
| `PIPELINE_INVALID_WEBHOOK_URL` | 422 | Webhook step URL failed SSRF validation |
| `STEP_EXECUTION_TIMEOUT` | 500 | Step exceeded its timeout in the Execution Service |
| `STEP_EXECUTION_FAILED` | 500 | Step returned a non-zero exit code |
| `HOOK_RECURSION_ERROR` | 422 | Pipeline trigger attempted from within a hook (enforced by Execution Service) |
| `SCHEDULE_NOT_FOUND` | 404 | Schedule ID does not exist in this tenant |
| `TRIGGER_NOT_FOUND` | 404 | Trigger ID does not exist in this tenant |
| `TRIGGER_SIGNATURE_INVALID` | 401 | Inbound webhook trigger HMAC signature mismatch |

---

## 17. Observability

### 17.1 Structured Logging

All log output uses the structured logger from `@oneplatform/core/logger.ts`. Every log line includes:

```json
{
  "timestamp": "2026-06-10T14:23:11.042Z",
  "level": "info",
  "service": "pipeline-service",
  "traceId": "01J4WZJHK8GN9...",
  "requestId": "01J4WZJHK8GN9...",
  "tenantId": "...",
  "pipelineId": "...",
  "runId": "...",
  "stepId": "...",
  "message": "Step completed",
  "durationMs": 1204
}
```

Log events are published to Redis pub/sub channel `logs:pipeline-service` asynchronously (fire-and-forget). The Logging Service batches and persists them.

### 17.2 Audit Events

The following user and system actions generate audit events (sent via BullMQ, guaranteed delivery):

| Event | Actor | Payload |
|---|---|---|
| `pipeline.created` | user | `{ pipelineId, name, slug }` |
| `pipeline.updated` | user | `{ pipelineId, changes: string[] }` |
| `pipeline.deleted` | user | `{ pipelineId, name }` |
| `pipeline.triggered` | user/service/system | `{ pipelineId, runId, triggeredBy }` |
| `pipeline.run.completed` | system | `{ pipelineId, runId, durationMs, stepCount }` |
| `pipeline.run.failed` | system | `{ pipelineId, runId, error, stepId? }` |
| `pipeline.run.cancelled` | user/system | `{ pipelineId, runId, cancelledBy }` |
| `pipeline.run.dlq_moved` | system | `{ pipelineId, runId, jobId, failureReason }` |
| `pipeline.schedule.created` | user | `{ scheduleId, pipelineId, cronExpr }` |
| `pipeline.schedule.updated` | user | `{ scheduleId, changes }` |
| `pipeline.schedule.deleted` | user | `{ scheduleId, pipelineId }` |

### 17.3 Platform Events

The following platform events are emitted to the Redis `events:pipeline:*` pub/sub channel for consumption by the Gateway Service (outbound webhook fan-out) and other subscribers:

| Event Type | Trigger | Data |
|---|---|---|
| `pipeline.started` | Run transitions to `running` | `{ pipelineId, runId, triggeredBy }` |
| `pipeline.step.completed` | Step transitions to `completed` | `{ pipelineId, runId, stepId, stepName, durationMs }` |
| `pipeline.completed` | Run transitions to `completed` | `{ pipelineId, runId, durationMs, stepCount }` |
| `pipeline.failed` | Run transitions to `failed` | `{ pipelineId, runId, stepId?, error }` |
| `pipeline.cancelled` | Run transitions to `cancelled` | `{ pipelineId, runId, cancelledBy }` |

All events use the `PlatformEvent` envelope from `@oneplatform/core/types.ts`.

### 17.4 OpenTelemetry

The OTEL SDK from `@oneplatform/core` auto-instruments:
- All Hono routes (spans per request, status codes, route pattern)
- BullMQ workers (spans per job, queue name, job ID, attempt count)
- Postgres queries (spans per query, sanitized SQL, row count)
- All outbound HTTP calls to Execution, Ontology, and Plugin services

Custom span attributes added by the Pipeline Service:
- `pipeline.id`, `pipeline.run_id`, `pipeline.step_id`, `pipeline.step_type`, `pipeline.hook_stage`, `pipeline.triggered_by`

### 17.5 Health Endpoints

`GET /healthz` — liveness check. Returns 200 if the process is alive. Used by Docker health check.

`GET /readyz` — readiness check. Returns 200 only when all startup steps complete (Section 1.3). Returns 503 during startup or if critical dependencies (Postgres, Redis) are unreachable. Includes queue depth summary as described in Section 10.5.

---

## 18. Testing Strategy

### 18.1 Unit Tests

Unit tests use Vitest. Mocked dependencies: Postgres client, Redis client, Execution Service HTTP calls, Plugin Service HTTP calls, Ontology Service HTTP calls.

**Key units to test:**

| Unit | What to test |
|---|---|
| `PipelineDefinitionSchema` (Zod) | Valid definitions pass; cycle detection; missing entryStepId; sub-minute cron; SSRF URL in webhook step; max steps exceeded; parallel step min branches |
| Step graph traversal | Linear execution; conditional routing (true/false); parallel wait modes; step skipping via `condition`; step skipping via `onError: 'skip'` |
| Input mapping resolver | `pipeline.input` source; `step` output source; `literal` source; missing path returns `undefined`; nested JSONPath |
| Advisory lock key derivation | Two different UUIDs produce different keys; same UUID produces same key deterministically |
| Cron next-run computation | UTC expression; timezone-aware expression; expression for "every minute"; midnight rollover |
| Hook criticality enforcement | Critical hook failure aborts chain and returns error; advisory hook failure continues with pre-hook payload; empty chain returns original payload |
| Poison-pill detection | 3 failures in < 60s triggers DLQ move; 3 failures over 120s does NOT trigger poison-pill (proceeds with normal backoff) |
| SSE log cursor | `id > lastEventId` returns correct subset; empty result with non-terminal run waits and polls; terminal run with empty result closes stream |
| SSRF validation | RFC-1918 IPs rejected; loopback rejected; valid external HTTPS URL accepted; metadata endpoint rejected |

### 18.2 Integration Tests

Integration tests run against a real Postgres and Redis instance (Docker Compose `test` profile). Execution Service, Plugin Service, and Ontology Service are mocked via `msw` (mock service worker) or `nock`.

**Key integration scenarios:**

| Scenario | What to verify |
|---|---|
| Full pipeline run (code step) | Run created, enqueued, worker picks up, step dispatched to mock Execution Service, run completes, audit event emitted |
| Hook execution flow | `before:pipeline.trigger` hook chain fetched from mock Plugin Service, dispatched to mock Execution Service sequentially, modified payload passed to run |
| Critical hook failure | `before:pipeline.trigger` critical hook returns error → API returns 422, no run row created |
| Advisory lock exclusion | Simulate two concurrent BullMQ workers processing the same `runId`; verify only one proceeds, second is re-queued |
| Cron trigger | Insert enabled schedule with `next_run_at = now()`, wait for cron tick, verify run row created |
| SSE log streaming | Open SSE connection, verify log entries stream in real-time as BullMQ worker writes them, verify `done` event on completion |
| DLQ flow | Mock Execution Service to fail 5 times; verify job moves to DLQ; verify run marked failed; verify DLQ entry retrievable via API |
| Replay from DLQ | POST to replay endpoint; verify new run row created; verify original DLQ entry removed |
| Cancellation | POST to cancel; verify cancellation flag in Redis; verify run worker stops between steps and marks run cancelled |

### 18.3 Orchestration Tests

Orchestration tests run against the full Docker Compose stack (all 9 services live) in CI. These tests are slow (30-90 seconds each) and run as a separate CI stage after unit and integration tests pass.

**Key scenarios:**

| Scenario | Services involved | Acceptance criteria |
|---|---|---|
| End-to-end pipeline run with real execution | Pipeline, Execution, Plugin | Run completes; step output contains expected transformed data |
| Hook execution with real plugin | Pipeline, Plugin, Execution | Plugin hook modifies payload; modified payload reaches step input |
| Cron trigger fires on schedule | Pipeline (cron scheduler) | Cron fires within 35 seconds of `next_run_at`; run row created |
| Event-driven trigger | Pipeline (Redis subscriber), any event producer | Event published to channel triggers run; correct input payload |
| Advisory lock: multi-instance | Two pipeline service instances share one BullMQ queue | Only one run executes at a time for the same pipeline; second run waits and executes after first completes |
| SSE log streaming from UI | Pipeline, Frontend (Playwright) | Browser opens log stream; logs appear in real-time; stream closes on completion |

---

## 19. Deployment and Configuration

### 19.1 Docker Compose Configuration

```yaml
pipeline-service:
  image: pipeline-service:latest
  build:
    context: .
    dockerfile: docker/Dockerfile.service
    args:
      SERVICE: pipeline
  networks:
    - oneplatform-internal
  ports: []          # No external ports; accessed via Gateway only
  volumes:
    - pipeline-data:/data       # Service keypair + WAL file (per ADR-18 + ADR-19)
    - service-keys:/data/service-keys:ro   # Shared public key directory (read-only)
  environment:
    DATABASE_URL: postgres://pipeline_service_role:${PIPELINE_DB_PASS}@pgbouncer-session:5433/oneplatform
    REDIS_URL: redis://:${REDIS_PASS}@redis:6379
    EXECUTION_SERVICE_URL: http://execution-service:3005
    ONTOLOGY_SERVICE_URL: http://ontology-service:3003
    PLUGIN_SERVICE_URL: http://plugin-service:3008
    OP_CURSOR_SECRET: ${OP_CURSOR_SECRET}
    OP_LOG_LEVEL: info
  depends_on:
    op-init:
      condition: service_completed_successfully
    postgres:
      condition: service_healthy
    redis:
      condition: service_healthy
    plugin-service:
      condition: service_healthy
    execution-service:
      condition: service_healthy
    ontology-service:
      condition: service_healthy
  healthcheck:
    test: ["CMD", "wget", "-q", "-O-", "http://localhost:3004/healthz"]
    interval: 30s
    timeout: 5s
    retries: 3
    start_period: 30s
  restart: unless-stopped

volumes:
  pipeline-data:
    name: oneplatform_pipeline_data
```

### 19.2 PgBouncer Session Pool Configuration

The Pipeline Service requires a separate PgBouncer pool configured for session mode. This is a second PgBouncer container in the Docker Compose stack:

```yaml
pgbouncer-session:
  image: pgbouncer/pgbouncer:latest
  networks:
    - oneplatform-internal
  environment:
    DATABASES_HOST: postgres
    DATABASES_PORT: 5432
    DATABASES_DBNAME: oneplatform
    PGBOUNCER_POOL_MODE: session
    PGBOUNCER_MAX_CLIENT_CONN: 50
    PGBOUNCER_DEFAULT_POOL_SIZE: 25
    PGBOUNCER_SERVER_IDLE_TIMEOUT: 600
  depends_on:
    postgres:
      condition: service_healthy
```

The Ontology Service also uses this session-mode PgBouncer pool (per ADR-5). Both services share the 25-connection pool. If contention becomes an issue (ontology migrations + high pipeline run volume simultaneously), the pool size can be increased by adjusting `PGBOUNCER_DEFAULT_POOL_SIZE` and `Postgres max_connections`.

### 19.3 Scaling Notes

**Horizontal scaling:** The Pipeline Service can run as multiple replicas. All state is in Postgres and Redis. Advisory locks provide correct mutual exclusion across instances. BullMQ workers compete for jobs using Redis-based job locking. The only per-instance state is the in-memory cron scheduler and event subscriptions.

**Cron scheduler in multi-instance:** Each pipeline service instance runs its own cron scheduler. To prevent duplicate cron triggers, the cron tick handler uses an optimistic lock: it attempts a conditional UPDATE on the schedule row (`WHERE id = $1 AND next_run_at <= now() AND enabled = true`) and only enqueues a run if the UPDATE affects exactly 1 row. This is an UPDATE-with-check pattern (not an advisory lock) — whichever instance wins the UPDATE first enqueues the run; the others see 0 rows affected and skip.

**Event subscriptions in multi-instance:** Each replica subscribes to all event trigger channels. When an event is published, ALL replicas will attempt to enqueue a run. To prevent duplicate runs from event triggers, the run creation uses an INSERT with an idempotency key: `(pipeline_id, triggered_by, trigger_meta->>'eventId')` has a UNIQUE constraint on `pipeline.runs` to prevent duplicate runs for the same event. Duplicate insert attempts by other replicas return a `CONFLICT` which is silently ignored.

```sql
-- Idempotency constraint for event-triggered runs
ALTER TABLE pipeline.runs ADD CONSTRAINT runs_event_idempotency_unique
    UNIQUE (pipeline_id, (trigger_meta->>'eventId'))
    WHERE triggered_by = 'event' AND trigger_meta->>'eventId' IS NOT NULL;
```

### 19.4 Migration Runner

Database migrations are applied by the Pipeline Service at startup using the `@oneplatform/core` migration runner. The runner uses a `pipeline_migrator_role` with elevated DDL privileges for the duration of migration execution only. The migration runner is idempotent: already-applied migrations (tracked in `pipeline.schema_migrations`) are skipped. Migrations run in a transaction; failed migrations roll back and halt startup.
