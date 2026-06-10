# Execution Service — L2 Service Design

**Date:** 2026-06-10
**Status:** APPROVED
**Authors:** Architecture Team
**Service port:** 3005
**Reference hierarchy:**
- L0: `docs/decisions/001-architecture-decisions.md` (ADR-6, ADR-16, ADR-19)
- L0: `docs/decisions/002-expanded-architecture-decisions.md` (ADR-28, ADR-31)
- L1: `docs/superpowers/specs/2026-06-10-oneplatform-design.md` (§7.6, §8 Sandbox Execution Model)
- **L2: This document**
- L3: `services/execution/src/` — implementation

---

## Table of Contents

1. [Service Overview](#1-service-overview)
2. [Network Placement and Startup Dependencies](#2-network-placement-and-startup-dependencies)
3. [Database Schema](#3-database-schema)
4. [API Endpoints](#4-api-endpoints)
5. [Sandbox Architecture](#5-sandbox-architecture)
6. [Execution Types](#6-execution-types)
7. [Unix Socket Protocol](#7-unix-socket-protocol)
8. [Resource Limits](#8-resource-limits)
9. [Sandbox Recycling](#9-sandbox-recycling)
10. [Plugin Code Delivery](#10-plugin-code-delivery)
11. [PluginContext Injection](#11-plugincontext-injection)
12. [HookRecursionError](#12-hookrecursionerror)
13. [Contingency Plan — Docker Warm Pool](#13-contingency-plan--docker-warm-pool)
14. [Error Handling](#14-error-handling)
15. [Observability](#15-observability)
16. [Security Design](#16-security-design)
17. [Testing Strategy](#17-testing-strategy)
18. [Technology Choices](#18-technology-choices)
19. [Open Questions / Known Limitations](#19-open-questions--known-limitations)

---

## 1. Service Overview

The Execution Service is the sandboxed code execution engine for the entire platform. It is the only service that executes user-supplied or plugin-supplied code. No other service runs arbitrary code in-process.

**Responsibilities:**

- Accept execution requests from authorized services (Pipeline, App, Ontology, Ingestion via Pipeline).
- Route JS/TS code to the `op-sandbox-vm` container via a Unix socket pair.
- Route non-JS languages (Python, Go, etc.) to short-lived Docker sandbox containers via a restricted Docker socket proxy.
- Enforce per-execution resource limits: 512 MB memory, 1 CPU core, 30 s timeout (connectors: up to 5 min).
- Inject the `PluginContext` API into each execution (controlled fetch, credential access, cache, logger, tenant context, ontology snapshot, tracing).
- Record execution metadata and log lines to Postgres.
- Stream execution logs via SSE to callers or the frontend.
- Detect and block `HookRecursionError` at the API boundary.
- Recycle the `op-sandbox-vm` container every 1000 executions or 1 hour (whichever comes first), with a graceful drain.
- Maintain an LRU cache of 100 plugin bundles (1 h TTL) fetched from the Plugin Service.
- Serve a plugin bundle cache-invalidation endpoint for the Plugin Service to call on bundle updates.

**What this service does NOT do:**

- It has no Redis access (enforced by network ACLs and per ADR-5, confirmed in ADR-19).
- It does not manage plugin lifecycle or the plugin registry (that is the Plugin Service).
- It does not evaluate data mapping rules outside of expression-type transforms (those are dispatched to it BY the Ontology Service).
- It does not hold long-lived connections to the database other than for writing execution records.

---

## 2. Network Placement and Startup Dependencies

### Network Membership

The Execution Service container is attached to TWO Docker networks simultaneously. This is the only service with dual-network membership and it is the explicit bridge between them.

```
oneplatform-internal   — communicates with all other platform services
oneplatform-sandbox    — communicates with op-sandbox-vm and Docker sandbox containers
```

No other service is on `oneplatform-sandbox`. The sandbox containers have no route to `oneplatform-internal`. The Execution Service is the sole conduit between the two networks.

### Volume Mounts

```
execution-data:/data         (rw) Ed25519 keypair, LRU bundle cache on-disk overflow
sandbox-socket:/run/sandbox  (rw) Unix socket pair shared with op-sandbox-vm
shared-pubkeys:/data/service-keys (ro) Public keys of all other services
init-data:/data/init         (ro) Master key path (not used directly, but available for future key derivation)
```

The `sandbox-socket` volume is mounted read-write by ONLY the Execution Service and op-sandbox-vm. No other service mounts this volume.

### Startup Dependencies (Docker Compose)

```yaml
execution-service:
  depends_on:
    postgres:
      condition: service_healthy
    auth-service:
      condition: service_healthy
    plugin-service:
      condition: service_healthy
    op-sandbox-vm:
      condition: service_healthy
```

The `op-sandbox-vm` container must be running before the Execution Service accepts traffic, because the first execution request must be able to dispatch to the sandbox. The Execution Service readiness probe (`GET /readyz`) returns 503 until the Unix socket handshake with the sandbox succeeds.

### op-sandbox-vm Startup

```yaml
op-sandbox-vm:
  build:
    dockerfile: docker/Dockerfile.sandbox
  networks:
    - oneplatform-sandbox    # sandbox network ONLY — no internal access
  volumes:
    - sandbox-socket:/run/sandbox
  healthcheck:
    test: ["CMD", "node", "-e", "require('net').createConnection('/run/sandbox/op.sock').on('connect', () => process.exit(0)).on('error', () => process.exit(1))"]
    interval: 5s
    retries: 10
  restart: unless-stopped
  deploy:
    resources:
      limits:
        memory: 512M
        cpus: "1.0"
```

The sandbox container runs as a non-root user (uid 1001), with a read-only root filesystem, no capabilities, and no network access to internal services.

---

## 3. Database Schema

### Schema: `execution`

All Execution Service tables live in the `execution` Postgres schema. The service connects with the `execution_service_role` database user, which has `SELECT`, `INSERT`, `UPDATE` on this schema only.

### Table: `execution.executions`

```sql
CREATE TABLE execution.executions (
    id              UUID         NOT NULL DEFAULT gen_random_uuid(),
    tenant_id       UUID         NOT NULL,
    type            TEXT         NOT NULL,        -- 'code' | 'connector-run' | 'app-build' | 'expression' | 'plugin-drain'
    status          TEXT         NOT NULL DEFAULT 'pending',  -- 'pending' | 'running' | 'success' | 'error' | 'timeout' | 'killed'
    language        TEXT         NOT NULL DEFAULT 'js',       -- 'js' | 'ts' | 'python' | 'go'
    sandbox_type    TEXT         NOT NULL DEFAULT 'isolated-vm',  -- 'isolated-vm' | 'docker'
    plugin_id       UUID,                         -- NULL for non-plugin executions
    pipeline_id     UUID,                         -- NULL if not triggered by a pipeline
    pipeline_run_id UUID,                         -- NULL if not triggered by a pipeline run
    hook_context    BOOLEAN      NOT NULL DEFAULT FALSE,      -- TRUE if running inside a hook chain
    code_hash       TEXT,                         -- SHA-256 of the code that was executed (for dedup/audit)
    started_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    completed_at    TIMESTAMPTZ,
    duration_ms     INTEGER,                      -- NULL until completed
    memory_peak_mb  REAL,                         -- NULL until completed; recorded from sandbox report
    exit_code       INTEGER,                      -- NULL until completed; 0=success, non-zero=error
    error_code      TEXT,                         -- NULL on success; e.g. 'EXECUTION_TIMEOUT', 'EXECUTION_OOM'
    error_message   TEXT,                         -- NULL on success; human-readable
    error_stack     TEXT,                         -- NULL on success; sanitized stack trace
    trace_id        TEXT         NOT NULL,        -- W3C trace context propagated from caller
    initiated_by    TEXT         NOT NULL,        -- 'pipeline-service' | 'app-service' | 'ontology-service' | 'api'
    sandbox_vm_run  INTEGER,                      -- sandbox-vm execution counter at time of dispatch
    PRIMARY KEY (id, started_at)                  -- partition key included in PK for PG partitioning
) PARTITION BY RANGE (started_at);

-- Monthly partitions, auto-created by a background job in the service
-- Example first partitions:
CREATE TABLE execution.executions_2026_01 PARTITION OF execution.executions
    FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE execution.executions_2026_06 PARTITION OF execution.executions
    FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

-- Indexes (applied on each partition via inheritance)
CREATE INDEX ON execution.executions (tenant_id, started_at DESC);
CREATE INDEX ON execution.executions (status) WHERE status IN ('pending', 'running');
CREATE INDEX ON execution.executions (plugin_id) WHERE plugin_id IS NOT NULL;
CREATE INDEX ON execution.executions (pipeline_run_id) WHERE pipeline_run_id IS NOT NULL;
CREATE INDEX ON execution.executions (trace_id);
```

**Partitioning rationale:** Execution records are high-volume and primarily queried by recency. Range partitioning by `started_at` (monthly) enables fast range scans, efficient retention-based partition drops (no DELETE scan needed), and parallelized vacuum. The partition creation job runs at service startup and at the start of each calendar month.

**Design decisions:**
- `code_hash` enables deduplication auditing and security alerting (alert if the same unusual code hash executes repeatedly across tenants).
- `hook_context` is stored for audit trail and post-incident forensics.
- `sandbox_vm_run` tracks which sandbox lifecycle cycle the execution ran in; useful for diagnosing correlation between sandbox recycles and execution anomalies.
- `memory_peak_mb` is reported by the sandbox at completion; for `isolated-vm` this comes from `v8.getHeapStatistics()` sampled at completion; for Docker containers it comes from the container stats API.

### Table: `execution.execution_logs`

```sql
CREATE TABLE execution.execution_logs (
    id              BIGSERIAL,
    execution_id    UUID         NOT NULL,
    execution_date  TIMESTAMPTZ  NOT NULL,        -- denormalized for partition routing
    timestamp       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    level           TEXT         NOT NULL DEFAULT 'info',  -- 'debug' | 'info' | 'warn' | 'error'
    message         TEXT         NOT NULL,
    line_number     INTEGER      NOT NULL,        -- sequential 1-based line counter within the execution
    stream          TEXT         NOT NULL DEFAULT 'stdout',  -- 'stdout' | 'stderr'
    metadata        JSONB,                        -- optional structured metadata attached by logger
    PRIMARY KEY (id, execution_date)              -- partition key in PK
) PARTITION BY RANGE (execution_date);

-- Co-partitioned with executions (same monthly boundaries)
CREATE TABLE execution.execution_logs_2026_01 PARTITION OF execution.execution_logs
    FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE execution.execution_logs_2026_06 PARTITION OF execution.execution_logs
    FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

-- Indexes
CREATE INDEX ON execution.execution_logs (execution_id, line_number);
CREATE INDEX ON execution.execution_logs (execution_id, timestamp);
-- No GIN on metadata by default — add per-tenant if needed for log search features
```

**Co-partitioning rationale:** `execution_logs` uses the same monthly boundary as `executions`. Because `execution_date` is denormalized from the parent execution's `started_at`, both tables' partitions can be dropped together during retention cleanup. This avoids orphaned log rows in an old partition referencing a non-existent execution in a dropped partition.

**Log volume management:**
- Maximum 10 000 log lines per execution. Lines beyond this limit are discarded with a terminal `[truncated after 10000 lines]` message appended.
- Log lines exceeding 4 KB are truncated at 4 KB with `[truncated]` suffix.
- Retention: execution records and logs are retained for 30 days by default (`OP_EXECUTION_LOG_RETENTION_DAYS`, minimum 7, maximum 365). Monthly partitions older than the retention window are dropped by the service's background cleanup job (runs at 03:00 UTC daily).

---

## 4. API Endpoints

All endpoints follow the standard API contract from ADR-29.

### Authentication Modes

| Endpoint prefix | Auth mode |
|---|---|
| `POST /api/v1/exec/run` | User JWT or API key (`execution:run` scope required) |
| `GET /api/v1/exec/{id}` | User JWT or API key (`execution:read` scope) |
| `GET /api/v1/exec/{id}/logs` | User JWT or API key (`execution:read` scope) — SSE stream |
| `/internal/*` | Service token only (`X-Service-Token` header, Ed25519 JWT validated against `shared-pubkeys`) |

The `/internal/*` routes have service RBAC enforcement: only Pipeline Service, App Service, and Ontology Service (via Pipeline Service) are in the allowed-callers list for `/internal/execution/run`. Only Plugin Service is allowed to call `/internal/execution/plugin-cache-invalidate`. See `@oneplatform/core/service-rbac.ts`.

### 4.1 `POST /api/v1/exec/run` — Direct execution (user-facing)

For power users running code snippets directly. Requires scope `execution:run`.

**Request Zod schema:**

```typescript
const RunRequestSchema = z.object({
  code: z.string().min(1).max(524_288),     // max 512 KB of source code
  language: z.enum(['js', 'ts']),           // user-facing only supports JS/TS
  timeout: z.number().int().min(1000).max(30_000).optional().default(30_000),
  context: z.record(z.unknown()).optional().default({}),  // passed to the execution context
  label: z.string().max(128).optional(),    // human-readable label for the execution record
});
```

**Response (202 Accepted):**

```typescript
const RunResponseSchema = z.object({
  data: z.object({
    executionId: z.string().uuid(),
    status: z.literal('pending'),
    logsUrl: z.string().url(),   // SSE stream URL: /api/v1/exec/{id}/logs
  }),
});
```

**Errors:**

| HTTP | Code | Condition |
|---|---|---|
| 400 | `EXECUTION_CODE_TOO_LARGE` | `code.length > 524_288` |
| 400 | `EXECUTION_INVALID_LANGUAGE` | language not in allowed list |
| 400 | `EXECUTION_TIMEOUT_EXCEEDED_LIMIT` | timeout > 30 000 ms |
| 403 | `FORBIDDEN` | missing `execution:run` scope |
| 429 | `RATE_LIMIT_EXCEEDED` | tenant limit hit |
| 503 | `EXECUTION_SANDBOX_UNAVAILABLE` | sandbox-vm unreachable |

### 4.2 `GET /api/v1/exec/{id}` — Get execution record

**Path parameter:** `id` — UUID of the execution.

**Response (200 OK):**

```typescript
const ExecutionResponseSchema = z.object({
  data: z.object({
    id: z.string().uuid(),
    tenantId: z.string().uuid(),
    type: z.enum(['code', 'connector-run', 'app-build', 'expression', 'plugin-drain']),
    status: z.enum(['pending', 'running', 'success', 'error', 'timeout', 'killed']),
    language: z.enum(['js', 'ts', 'python', 'go']),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime().nullable(),
    durationMs: z.number().int().nullable(),
    memoryPeakMb: z.number().nullable(),
    exitCode: z.number().int().nullable(),
    errorCode: z.string().nullable(),
    errorMessage: z.string().nullable(),
    // errorStack is intentionally omitted from user-facing response
    traceId: z.string(),
  }),
});
```

**Errors:**

| HTTP | Code | Condition |
|---|---|---|
| 404 | `EXECUTION_NOT_FOUND` | ID does not exist in this tenant |
| 403 | `FORBIDDEN` | execution belongs to different tenant |

### 4.3 `GET /api/v1/exec/{id}/logs` — SSE log stream

Returns an SSE stream of log lines for an execution. If the execution is still running, log lines are streamed in real time. If already completed, all stored lines are sent immediately then the stream closes.

**Response headers:**

```
Content-Type: text/event-stream
Cache-Control: no-cache
X-Accel-Buffering: no      (disables Nginx buffering for SSE)
```

**SSE event format:**

```
event: log
data: {"line":1,"level":"info","stream":"stdout","message":"Starting connector...","timestamp":"2026-06-10T12:00:00.123Z"}

event: log
data: {"line":2,"level":"warn","stream":"stderr","message":"Retrying after 429...","timestamp":"2026-06-10T12:00:01.456Z"}

event: complete
data: {"status":"success","durationMs":1234,"exitCode":0}

event: error
data: {"status":"error","errorCode":"EXECUTION_TIMEOUT","errorMessage":"Execution exceeded 30000ms timeout"}
```

**Behavior:**
- The stream ALWAYS ends with either a `complete` or `error` event, never hangs indefinitely.
- If the execution never started (e.g., sandbox was unavailable), an `error` event is emitted immediately.
- Clients should reconnect using the `Last-Event-ID` header (set to the last received `line` number) to resume a dropped stream. The service resumes from that line number.
- Maximum stream duration matches the execution timeout plus a 5 s buffer. After this the SSE connection is closed from the server side.

**Errors:**

| HTTP | Code | Condition |
|---|---|---|
| 404 | `EXECUTION_NOT_FOUND` | No execution with this ID for this tenant |
| 403 | `FORBIDDEN` | Cross-tenant access attempt |

### 4.4 `POST /internal/execution/run` — Internal execution (service-to-service)

Called by Pipeline Service and App Service. Not exposed through Gateway.

**Request Zod schema:**

```typescript
const InternalRunRequestSchema = z.object({
  tenantId: z.string().uuid(),
  type: z.enum(['code', 'connector-run', 'app-build', 'expression']),
  language: z.enum(['js', 'ts', 'python', 'go']),
  code: z.string().min(1).max(10_485_760),   // max 10 MB for app-build payloads
  timeout: z.number().int().min(1000).max(300_000),  // up to 5 min for connectors
  context: z.object({
    pluginId: z.string().uuid().optional(),
    pipelineId: z.string().uuid().optional(),
    pipelineRunId: z.string().uuid().optional(),
    hookContext: z.boolean().optional().default(false),  // set by Pipeline Service for hook executions
    traceId: z.string(),
    tenantId: z.string().uuid(),
    label: z.string().max(128).optional(),
    // Additional fields passed through to PluginContext (see §11)
    ontologySnapshot: z.unknown().optional(),
    credentialBundleId: z.string().uuid().optional(),
  }),
  // For app-build: pass source files instead of code string
  files: z.record(z.string()).optional(),     // path -> content map, max 100 entries, each max 256 KB
  entrypoint: z.string().optional(),
});
```

**Response (202 Accepted):** Same as `POST /api/v1/exec/run`.

**Errors:** Same set as user-facing endpoint plus:

| HTTP | Code | Condition |
|---|---|---|
| 403 | `FORBIDDEN` | Caller service not in RBAC allowlist |
| 400 | `EXECUTION_HOOK_RECURSION` | `hookContext: true` AND code attempts `pipeline.trigger()` (detected early via static analysis heuristic; definitive enforcement is at runtime — see §12) |

### 4.5 `POST /internal/execution/connector-run` — Connector plugin invocation

Specialized variant for invoking a connector plugin's `fetchBatch` or `push` methods. The pipeline for this is: Ingestion Service → Pipeline Service → Execution Service (connector-run).

**Request Zod schema:**

```typescript
const ConnectorRunRequestSchema = z.object({
  tenantId: z.string().uuid(),
  pluginId: z.string().uuid(),
  method: z.enum(['fetchBatch', 'push', 'getSchema', 'testConnection']),
  cursor: z.string().nullable(),
  credentialBundleId: z.string().uuid(),   // ID of the credential bundle in Ingestion Service; resolved via PluginContext
  timeout: z.number().int().min(5000).max(300_000).default(300_000),  // 5-minute default for connectors
  traceId: z.string(),
  pipelineRunId: z.string().uuid().optional(),
});
```

**Response (200 OK — synchronous for connectors):**

```typescript
const ConnectorRunResponseSchema = z.object({
  data: z.object({
    executionId: z.string().uuid(),
    status: z.enum(['success', 'error', 'timeout']),
    result: z.unknown().nullable(),         // the connector method's return value on success
    errorCode: z.string().nullable(),
    errorMessage: z.string().nullable(),
    durationMs: z.number().int(),
    memoryPeakMb: z.number().nullable(),
  }),
});
```

**Note:** `connector-run` is synchronous (waits for completion) unlike the other run endpoints which return 202. Rationale: the Ingestion pipeline needs the batch result synchronously to proceed. The 5-minute timeout covers the largest expected batch fetch.

### 4.6 `POST /internal/execution/plugin-drain` — Graceful plugin shutdown

Called by Plugin Service when a plugin is being disabled or updated. Signals the Execution Service to stop routing new executions to this plugin, wait for in-flight executions to finish, and then confirm drain completion.

**Request Zod schema:**

```typescript
const PluginDrainRequestSchema = z.object({
  tenantId: z.string().uuid(),
  pluginId: z.string().uuid(),
  gracePeriodMs: z.number().int().min(1000).max(120_000).default(60_000),
});
```

**Response (200 OK):**

```typescript
const PluginDrainResponseSchema = z.object({
  data: z.object({
    pluginId: z.string().uuid(),
    drainedAt: z.string().datetime(),
    inflightAtDrainStart: z.number().int(),
    inflightAtCompletion: z.number().int(),   // 0 = all drained; >0 = some were killed at grace period
    killedExecutions: z.string().uuid().array(),  // execution IDs that were force-killed after grace period
  }),
});
```

**Behavior:**
- Sets a `DRAINING` flag for the plugin in an in-memory map. New requests for this plugin receive `503 SERVICE_DRAINING`.
- Waits up to `gracePeriodMs` for in-flight executions to finish.
- Any in-flight executions still running at the grace period are force-killed (SIGKILL to the sandbox process or Docker stop).
- The plugin's bundle is evicted from the LRU cache.
- Returns 200 regardless of whether force-kills were necessary; `killedExecutions` reports which were not clean.

### 4.7 `POST /internal/execution/plugin-cache-invalidate` — Bundle cache invalidation

Called by Plugin Service when a plugin bundle is updated and the cached version must be evicted.

**Request Zod schema:**

```typescript
const CacheInvalidateRequestSchema = z.object({
  pluginId: z.string().uuid(),
  tenantId: z.string().uuid(),
  newBundleVersion: z.string(),
});
```

**Response (200 OK):**

```typescript
const CacheInvalidateResponseSchema = z.object({
  data: z.object({
    evicted: z.boolean(),          // true if a cached entry existed and was removed
    pluginId: z.string().uuid(),
  }),
});
```

---

## 5. Sandbox Architecture

### 5.1 op-sandbox-vm (JS/TS Fast Path)

The `op-sandbox-vm` container runs the `isolated-vm` library on Node.js 20 LTS. It listens on a Unix socket at `/run/sandbox/op.sock`. The Execution Service is the sole client of this socket.

**Container characteristics:**

```
Image:          Built from docker/Dockerfile.sandbox
Base:           node:20-alpine (pinned to specific digest)
User:           uid 1001 (non-root)
Filesystem:     read-only root (tmpfs for /tmp only)
Capabilities:   none (--cap-drop=ALL)
Networks:       oneplatform-sandbox only
                No route to oneplatform-internal
Resource limit: 512 MB memory, 1.0 CPU (enforced at Docker level)
Restart policy: unless-stopped (auto-restart on crash; counter tracked by Execution Service)
```

**Dockerfile.sandbox key characteristics:**

```dockerfile
FROM node:20-alpine AS base
# Pin Node version at the Dockerfile level to prevent silent upgrades
# that could break isolated-vm compatibility (see ADR-6)

WORKDIR /app
COPY docker/sandbox/package.json docker/sandbox/package-lock.json ./
RUN npm ci --omit=dev

# Pre-bundle allowed modules into the sandbox image
# These are available for import from within user code
COPY docker/sandbox/src/ ./src/
RUN npm run build   # esbuild bundles the sandbox server + all allowed modules

# Minimal runtime — no shell, no package manager, no debug tools
FROM node:20-alpine AS runtime
WORKDIR /app
COPY --from=base /app/dist ./dist
COPY --from=base /app/node_modules ./node_modules

USER 1001
VOLUME ["/run/sandbox"]
CMD ["node", "dist/server.js", "--socket", "/run/sandbox/op.sock"]
```

**Pre-bundled modules available to user code:**

| Module | Purpose |
|---|---|
| `node:crypto` (subset) | `randomUUID`, `createHash`, `timingSafeEqual` |
| `date-fns` | Date manipulation |
| `zod` | Runtime validation in user code |
| `lodash-es` | Utility functions |
| `esbuild` | For `app-build` execution type only |
| `react`, `react-dom` | For `app-build` execution type only |
| `@oneplatform/app-sdk` (UI utilities) | For `app-build` execution type only |

Modules NOT listed above are unavailable. Attempting to import an unlisted module throws `ExternalModuleNotAllowedError`.

**isolated-vm Isolate lifecycle:**

Each execution request creates a new `isolated-vm` Isolate. Isolates are NOT reused between executions — a fresh Isolate per request eliminates state leakage between executions. The cost is ~0.5 ms per Isolate creation on Node 20, which is acceptable.

The Isolate is created with:
- `memoryLimit: 128` (128 MB per Isolate, in addition to the 512 MB container limit)
- `inspector: false`

The `PluginContext` API is injected as a set of synchronous and asynchronous `Reference` callbacks (see §11).

### 5.2 Docker Sandbox (Non-JS Languages)

For Python, Go, and other languages, the Execution Service creates a short-lived Docker container via the Docker socket proxy (ADR-6).

**Allowed Docker API endpoints via socket proxy:**

```
POST /containers/create
POST /containers/{id}/start
POST /containers/{id}/attach  (for stdin/stdout piping)
GET  /containers/{id}/logs
GET  /containers/{id}/wait
DELETE /containers/{id}
GET  /containers/{id}/stats   (for memory reporting)
```

No other Docker API calls are permitted. The proxy (tecnativa/docker-socket-proxy) enforces this via environment variable configuration.

**Container creation parameters:**

```json
{
  "Image": "oneplatform-sandbox-python:latest",
  "Cmd": ["python3", "/sandbox/entrypoint.py"],
  "NetworkingConfig": {
    "EndpointsConfig": { "oneplatform-sandbox": {} }
  },
  "HostConfig": {
    "Memory": 536870912,
    "NanoCpus": 1000000000,
    "NetworkMode": "oneplatform-sandbox",
    "ReadonlyRootfs": true,
    "CapDrop": ["ALL"],
    "AutoRemove": false,
    "Binds": []
  },
  "Env": [
    "OP_EXECUTION_ID=<uuid>",
    "OP_TIMEOUT_MS=30000"
  ]
}
```

The code to execute is passed via stdin (piped via the `/containers/{id}/attach` endpoint). Results are returned via stdout. Logs (stderr) are captured separately.

**Docker sandbox images:**

| Language | Image | Base |
|---|---|---|
| Python 3 | `oneplatform-sandbox-python:latest` | `python:3.12-alpine` |
| Go | `oneplatform-sandbox-go:latest` | `golang:1.22-alpine` |

These images are pre-built as part of the platform build pipeline. They include only the standard library and the platform's context-injection shim. No pip/go package installation is allowed at execution time.

**Docker sandbox lifecycle per request:**

```
1. Execution Service calls POST /containers/create → containerID
2. Execution Service calls POST /containers/{id}/start
3. Execution Service writes code + context JSON to stdin via /containers/{id}/attach
4. Container exits (or is killed after timeout)
5. Execution Service calls GET /containers/{id}/logs to collect stdout/stderr
6. Execution Service calls GET /containers/{id}/stats (before cleanup) to record peak memory
7. Execution Service calls DELETE /containers/{id} to remove the container
```

**Timeout enforcement:** The Execution Service sets a Node.js `setTimeout` that calls `DELETE /containers/{id}` with `force: true` if the container has not exited by the deadline. A separate goroutine / async task in the container itself also has an internal watchdog that self-terminates.

---

## 6. Execution Types

Five execution types are supported. The type is set by the caller and determines how the request is dispatched and what is injected into the execution context.

### 6.1 `code` — Pipeline step code

General-purpose code execution for user-defined pipeline steps. The code receives the pipeline step's input payload and must return an output payload.

**Context injected:** full `PluginContext` (fetch proxy, cache, logger, tenant, ontology, tracing).

**Calling convention:**

```typescript
// User code receives these as globals:
// - context: PluginContext
// - input: unknown (the step's input payload from the pipeline)
// - module.exports = output  OR  return output
async function execute(input: unknown, context: PluginContext): Promise<unknown> {
  const customers = await context.data.query('customer', { filter: { active: true } });
  return { processedCount: customers.length };
}
```

The sandbox wraps the user code in an async IIFE, calls `execute(input, context)`, and awaits the result. The result is serialized as JSON and returned via the socket response.

### 6.2 `connector-run` — Connector plugin invocation

Executes a specific method (`fetchBatch`, `push`, `getSchema`, or `testConnection`) of a connector plugin. The plugin bundle is loaded from the LRU cache (or fetched from Plugin Service) and the method is invoked.

**Context injected:** `PluginContext` with `credentials.get()` resolving against the `credentialBundleId` passed in the request.

**Code structure in sandbox:** The connector plugin bundle exports a class implementing the `Connector` interface. The sandbox instantiates the class, injects the context, and calls the requested method.

**Return value:** The method's return value (e.g., `BatchResult` for `fetchBatch`) is serialized and returned.

### 6.3 `app-build` — esbuild in sandbox

Runs an esbuild compilation of user app source files. This execution type accepts a `files` map instead of a `code` string.

**Context injected:** none (build context only, no PluginContext API). esbuild itself is the runtime.

**Execution flow:**

```
1. Sandbox receives: { method: "app-build", files: {"/src/App.tsx": "..."}, entrypoint: "/src/index.tsx", target: "es2020", format: "esm" }
2. Sandbox writes files to an in-memory virtual filesystem (using esbuild's in-memory plugin API — no disk writes)
3. esbuild.build({ ... }) runs with the virtual filesystem
4. Output: { bundle: "<js content>", sourceMap: "<map content>", bundleSizeBytes: N, buildDurationMs: N, errors: [], warnings: [] }
5. App Service uploads output to MinIO
```

**Allowed imports in app build:** `react`, `react-dom`, `@oneplatform/app-sdk`, `recharts`. Custom imports trigger `ExternalModuleNotAllowedError`.

**Hot-rebuild (incremental):** After the first build for an app session, the sandbox returns an `incrementalContextId`. Subsequent build requests with the same `incrementalContextId` use esbuild's `context.rebuild()` API for ~200 ms rebuilds. The context is stored in the sandbox's process memory and is invalidated on sandbox recycle.

### 6.4 `expression` — Ontology transform expression

Executes user-defined field-level transform expressions as part of ontology mapping (ADR-28). Expressions receive a batch of records and a map of transform functions.

**Context injected:** limited context — logger only. No fetch, no credentials, no data API. Expressions are pure transformations.

**Execution is batched:** the Ontology Service sends all records and all mapping expressions in a single call rather than per-record invocations, to amortize the ~0.5 ms Isolate creation cost.

**Memory budget per batch:** 64 MB Isolate memory limit (lower than the default 128 MB, since expressions are expected to be lightweight).

### 6.5 `plugin-drain` — Graceful plugin shutdown

An administrative execution type that is not actually executed in the sandbox. The `plugin-drain` request type is recorded in `execution.executions` as a metadata record for audit purposes (no actual code runs). The drain logic lives in the Execution Service process itself (see §4.6).

---

## 7. Unix Socket Protocol

### 7.1 Transport

- **Protocol:** Length-delimited newline-terminated JSON (NDJSON).
- **Socket path:** `/run/sandbox/op.sock` (Unix domain socket, mounted from `sandbox-socket` volume).
- **Direction:** Unidirectional pair — the Execution Service WRITES requests; the sandbox WRITES responses. They use separate channels within the same socket connection.
- **Actual implementation:** a single persistent TCP-style Unix socket with request/response multiplexing. Each message carries a correlation `id`. The socket is NEVER used for unsolicited messages from the sandbox — the sandbox only writes a response to a pending request.

**Security properties of this design:**
- The sandbox cannot initiate new executions (it is not a client of the Execution Service).
- The sandbox cannot replay a previous request (each request has a UUID `id`, responses must match).
- A compromised sandbox can only send malformed or malicious responses to pending requests — it cannot affect any other service.

### 7.2 Request Message Format

```typescript
interface SandboxRequest {
  id: string;              // UUID v4, correlation ID
  method: 'execute' | 'app-build' | 'ping' | 'drain';
  timeout: number;         // milliseconds; sandbox enforces its own internal watchdog
  payload: {
    code?: string;                    // source code string (execute method)
    language?: 'js' | 'ts';
    context?: SerializedPluginContext; // JSON-serializable subset of PluginContext
    files?: Record<string, string>;   // app-build: path → content
    entrypoint?: string;              // app-build
    target?: string;                  // app-build: esbuild target
    format?: string;                  // app-build: esbuild format
    incrementalContextId?: string;    // app-build: for incremental rebuild
    batchRecords?: unknown[];         // expression: records to transform
    transforms?: TransformRule[];     // expression: rules to apply
  };
}
```

**Framing:** Each message is a single JSON object followed by `\n`. Messages are length-prefixed for robustness: a 4-byte big-endian uint32 precedes each JSON string to allow the receiver to read the exact byte count before attempting JSON.parse. The newline acts as an additional delimiter for debugging/logging.

```
[4 bytes: uint32 length][JSON bytes]['\n']
```

**Maximum request size:** 12 MB (covers largest `app-build` payload of up to 100 files × 256 KB each = ~25 MB theoretical max, but the socket limit serves as a hard enforcement layer below the Zod schema limit). If a request exceeds 12 MB, the Execution Service rejects it before sending, returning `EXECUTION_PAYLOAD_TOO_LARGE`.

### 7.3 Response Message Format

```typescript
interface SandboxResponse {
  id: string;                        // matches request id
  status: 'ok' | 'error' | 'timeout' | 'oom';
  result?: unknown;                  // present on status 'ok'; JSON-serializable execution return value
  error?: {
    code: string;                    // 'EXECUTION_ERROR' | 'EXECUTION_TIMEOUT' | 'EXECUTION_OOM' | 'SANDBOX_INTERNAL'
    message: string;
    stack?: string;                  // sanitized — no absolute paths, no internal implementation details
  };
  meta: {
    durationMs: number;
    memoryPeakMb: number;            // from v8.getHeapStatistics() at completion
    exitCode: number;                // 0 = success
    lineCount: number;               // total log lines emitted
    incrementalContextId?: string;   // app-build: returned for subsequent incremental rebuilds
  };
}
```

**Result size limit:** Response `result` payloads are capped at 4 MB. If the serialized result exceeds 4 MB, the sandbox returns `status: 'error'` with code `EXECUTION_RESULT_TOO_LARGE`. This prevents runaway code from filling the Execution Service's receive buffer.

### 7.4 Log Line Streaming

Log lines produced by `context.logger.*` calls within user code are NOT batched in the final response. They are sent as intermediate messages on the same socket connection:

```typescript
interface SandboxLogLine {
  id: string;                  // matches the request id this log belongs to
  type: 'log';
  line: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  stream: 'stdout' | 'stderr';
  message: string;
  timestamp: string;           // ISO 8601
}
```

The Execution Service receives log line messages interleaved with the normal request/response cycle. It writes log lines to `execution.execution_logs` and fans them out to any active SSE subscribers for that execution ID in real time.

### 7.5 Ping / Health Check

```typescript
// Request
{ id: "<uuid>", method: "ping", timeout: 1000, payload: {} }

// Response
{ id: "<uuid>", status: "ok", result: { pong: true, runCount: 42 }, meta: { durationMs: 0, memoryPeakMb: 0, exitCode: 0, lineCount: 0 } }
```

The Execution Service sends a `ping` to the sandbox on startup and every 10 seconds thereafter. Three consecutive missed pings trigger sandbox restart.

### 7.6 Drain Command

Before recycling the sandbox-vm container, the Execution Service sends a `drain` message. The sandbox responds after completing all in-flight Isolate executions. This ensures no executions are mid-flight when the container is destroyed.

```typescript
// Request
{ id: "<uuid>", method: "drain", timeout: 60000, payload: {} }

// Response — after all in-flight executions complete or timeout
{ id: "<uuid>", status: "ok", result: { drainedCount: N, timedOutCount: M }, meta: { ... } }
```

---

## 8. Resource Limits

### 8.1 Per-Execution Limits

| Resource | Limit | Enforcement mechanism |
|---|---|---|
| Memory | 512 MB total container / 128 MB per Isolate | Docker `--memory` flag for container; `memoryLimit` in Isolate constructor |
| CPU | 1 core | Docker `--cpus=1.0` flag (`NanoCpus: 1000000000`) |
| Execution timeout (default) | 30 000 ms | Execution Service timer + sandbox internal watchdog |
| Execution timeout (connector-run) | 300 000 ms (5 min) | Same mechanism; configurable per-plugin in manifest up to 300 s |
| Code size | 512 KB (user-facing), 10 MB (internal) | Zod schema validation before dispatch |
| Result size | 4 MB | Sandbox enforces on serialization |
| Log lines | 10 000 | Counted by sandbox logger; excess discarded |
| Log line length | 4 KB | Truncated by sandbox logger |
| App-build file count | 100 files | Zod validation |
| App-build file size | 256 KB per file | Zod validation |

### 8.2 Timeout Enforcement

Three layers of timeout enforcement exist, each acting as a safety net for the layer above:

**Layer 1 — Execution Service timer (primary):**
The Execution Service sets a `setTimeout` immediately after dispatching to the sandbox. When it fires:
- For `isolated-vm`: the Isolate is terminated via the `isolate.dispose()` API.
- For Docker: `DELETE /containers/{id}?force=true` is called.
- The execution record is updated to `status: 'timeout'`, `error_code: 'EXECUTION_TIMEOUT'`.
- Any pending SSE subscribers receive an `error` event.

**Layer 2 — Sandbox internal watchdog:**
The `op-sandbox-vm` server tracks each in-flight Isolate with its own timer. If the Isolate does not resolve within `timeout + 2000 ms`, the sandbox forcibly disposes the Isolate and returns a timeout response. The 2 000 ms buffer ensures the Execution Service timer fires first under normal conditions.

**Layer 3 — `isolated-vm` CPU timeout:**
For Isolates executing synchronous code (tight loops), `isolated-vm` supports a CPU time limit via the `cpuTime` option on `isolate.run()`. This is set to `timeout` milliseconds and provides a backstop against busy-wait loops that would not yield to the Node.js event loop.

### 8.3 Memory Limit Enforcement

**Container level (Docker):** Docker enforces the 512 MB container memory limit via cgroups. When the container approaches the limit, the OOM killer terminates the container process. The Execution Service's sandbox health monitor (§9.1) detects the crash and marks the current execution as `status: 'killed'`, `error_code: 'EXECUTION_OOM'`. The sandbox container is automatically restarted by Docker Compose's `restart: unless-stopped` policy; the Execution Service receives a ECONNRESET on the Unix socket and initiates its reconnect sequence.

**Isolate level (`isolated-vm`):** Each Isolate is created with `memoryLimit: 128` (128 MB). Exceeding this limit causes `isolated-vm` to throw a `MemoryExceededError` in the sandbox server code. The sandbox returns `status: 'oom'` in the response, and the Execution Service marks the execution accordingly. The container does not crash in this case — the Isolate is disposed cleanly and the sandbox continues serving new requests.

**Reported memory:** Peak memory is recorded from `v8.getHeapStatistics().used_heap_size` sampled at execution completion and stored in `execution.executions.memory_peak_mb`.

---

## 9. Sandbox Recycling

### 9.1 Recycle Triggers

The Execution Service maintains a counter `sandboxRunCount` (in-process atomic integer) that increments on each dispatch to `op-sandbox-vm`. Recycling is triggered when EITHER condition is met:

- `sandboxRunCount >= 1000` (configurable via `OP_SANDBOX_RECYCLE_COUNT`, default 1000)
- Time since last recycle >= 3600 000 ms (1 hour) (configurable via `OP_SANDBOX_RECYCLE_INTERVAL_MS`)

Recycling is also triggered on sandbox crash (detected by ECONNRESET on the socket or three consecutive missed pings).

### 9.2 Graceful Drain Sequence

```
State: ACTIVE (accepting new executions)
                │
                │ recycle trigger fires
                ▼
State: DRAINING_OLD (existing sandbox still running, new executions routed to replacement)
  - sandboxRunCount reset to 0
  - old sandbox: no new requests sent
  - in-flight executions on old sandbox: given up to 60 s to complete
  - replacement sandbox: spun up via Docker Compose restart signal
    (Execution Service calls POST /containers/sandbox-vm/restart via socket proxy)
  - OR: replacement is always warm (see §13 contingency)

  Hard constraints during drain:
  - Max 10 concurrent in-flight executions on the old sandbox at drain start
    (if >10 were in flight, the drain waits for count to drop to 10 before proceeding)
  - New executions arriving during drain are routed to replacement immediately
  - If replacement is not yet healthy within 30 s, new executions queue (max 100)
    before failing with EXECUTION_SANDBOX_UNAVAILABLE

                │ all in-flight complete OR 60 s grace period expires
                ▼
State: ACTIVE (replacement sandbox is now primary)
  - Old sandbox: SIGTERM sent to container
  - Docker Compose removes the old container after graceful shutdown
  - If 60 s expires with in-flight remaining: SIGKILL, log execution IDs as killed
```

### 9.3 Warm Replacement Pool

For minimal recycle downtime, the Execution Service maintains a single warm replacement sandbox container. This container is started immediately after a new primary sandbox becomes active, so it is always ready when the next recycle triggers.

The warm container receives periodic `ping` messages to keep it healthy. It does NOT process any real executions until promoted to primary.

**Configuration:**
- `OP_SANDBOX_WARM_POOL_SIZE`: number of warm containers to maintain (default 1; set to 0 to disable warm pool if Docker resource constraints are tight).

### 9.4 Sandbox Crash Recovery

When the sandbox crashes (container OOM, SIGKILL, process panic), the Execution Service:

1. Detects crash via ECONNRESET or failed ping.
2. Marks all currently in-flight executions on the crashed sandbox as `status: 'killed'`, `error_code: 'EXECUTION_SANDBOX_CRASH'`.
3. Fans out `error` events to all SSE subscribers for affected executions.
4. Promotes the warm replacement to primary (if available) or waits for Docker to restart the sandbox container.
5. Increments an `execution_service_sandbox_crashes_total` Prometheus counter.
6. Emits a `CRITICAL` log event to the Logging Service.

---

## 10. Plugin Code Delivery

### 10.1 Bundle Fetch

When an execution request requires a plugin (types `connector-run` or any execution with a `pluginId`), the Execution Service fetches the plugin's compiled JS bundle from the Plugin Service:

```
GET /internal/plugins/{pluginId}/bundle
X-Service-Token: <Execution Service Ed25519 JWT>
```

The Plugin Service returns:
```json
{
  "data": {
    "pluginId": "...",
    "version": "1.2.3",
    "bundleHash": "sha256:abc123...",
    "bundleBase64": "...",      // base64-encoded compiled bundle, max 10 MB
    "language": "js"
  }
}
```

### 10.2 LRU Cache

**Cache implementation:** An in-process LRU cache (using `lru-cache` npm package, MIT) keyed by `{tenantId}:{pluginId}:{version}`.

**Cache parameters:**

| Parameter | Value | Rationale |
|---|---|---|
| Max entries | 100 | Covers a realistic number of active plugins per platform instance |
| TTL per entry | 3 600 000 ms (1 hour) | Balances freshness against Plugin Service request load |
| Max bundle size | 10 MB | Prevents cache from being dominated by one large plugin |
| Total max memory | 200 MB | Soft cap; `lru-cache` tracks size via `sizeCalculation` option |

**Cache key:** `${tenantId}:${pluginId}:${version}` — version is included so that deploying a new bundle version automatically bypasses the old cache entry without requiring explicit invalidation. The old entry expires after 1 hour.

**Cache invalidation:** The Plugin Service calls `POST /internal/execution/plugin-cache-invalidate` when a new bundle is deployed (see §4.7). This allows immediate eviction before the TTL expires, so the next execution uses the updated bundle.

**Cache miss flow:**

```
1. Cache miss: fetch from Plugin Service
2. Verify bundleHash matches SHA-256 of the decoded bundle bytes
3. Store in cache
4. Inject bundle code into sandbox Isolate for execution
```

**Bundle hash verification:** If the hash does not match, the bundle is discarded and `EXECUTION_BUNDLE_INTEGRITY_ERROR` is returned. The Plugin Service is alerted via a log event. This prevents a compromised or corrupted bundle from executing.

### 10.3 On-Disk Overflow Cache

For resilience during Plugin Service restarts, bundles in the LRU cache are also written to disk at `/data/bundle-cache/{pluginId}-{version}.bundle.enc`. The file is AES-256-GCM encrypted using a key derived from `OP_MASTER_KEY` + the service's Ed25519 private key (so it is only readable by this service instance). The disk cache is used as a fallback ONLY if the Plugin Service returns a 503 or connection error. The TTL on disk matches the in-memory TTL. Maximum disk usage for the bundle cache: 500 MB.

---

## 11. PluginContext Injection

Every execution that runs plugin code receives a `PluginContext` object injected as a global. The context API is the ONLY way plugin code interacts with the rest of the platform. Direct imports of database clients, HTTP clients, or other service SDKs are blocked by the module allowlist.

### 11.1 PluginContext Interface

```typescript
interface PluginContext {
  // Tenant identity
  tenantId: string;
  executionId: string;
  traceId: string;

  // Credential access (connector-run only; throws in other execution types)
  credentials: {
    get(key: string): Promise<string>;          // fetch a single credential value
    list(): Promise<string[]>;                  // list available credential keys (names only, no values)
  };

  // Outbound HTTP fetch (allowlist-enforced, no internal service URLs)
  fetch(url: string, init?: RequestInit): Promise<Response>;

  // Key-value cache (scoped per tenantId + pluginId)
  cache: {
    get<T>(key: string): Promise<T | null>;
    set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
    delete(key: string): Promise<void>;
  };

  // Structured logger
  logger: {
    debug(message: string, meta?: Record<string, unknown>): void;
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
    error(message: string, meta?: Record<string, unknown>): void;
  };

  // Ontology snapshot (read-only; reflects schema at execution start time)
  ontology: {
    getEntity(name: string): OntologyEntity | null;
    getEntities(): OntologyEntity[];
  };

  // Pipeline trigger (blocked when hookContext = true; throws HookRecursionError)
  pipeline: {
    trigger(pipelineId: string, payload?: unknown): Promise<void>;
  };

  // Tracing helpers
  tracing: {
    startSpan(name: string): Span;
    currentSpan(): Span;
  };
}
```

### 11.2 Implementation: Proxied APIs

Each `PluginContext` method is implemented as an `isolated-vm` `Reference` callback in the sandbox server. The callback crosses the isolate boundary and is handled by the sandbox server process. The sandbox server in turn makes calls BACK to the Execution Service process via a secondary channel (not the main Unix socket, to avoid deadlock). The secondary channel is an in-process queue — the sandbox server calls a Node.js callback that the Execution Service registered when it dispatched the execution.

**Why a secondary in-process channel rather than a second socket?** The `op-sandbox-vm` process IS the Node.js process running both `isolated-vm` and the socket server. The `Reference` callback exits the Isolate into the host Node.js process, where the callback implementation runs normally. There is no second socket — the callback directly accesses a request-scoped object passed from the Execution Service via the sandbox server's own logic. The sandbox server and Execution Service are separate Docker containers communicating via the Unix socket, so the "in-process queue" model applies within the Execution Service: it receives the callback call as a special `contextCall` message type on the same Unix socket.

**ContextCall message format (sandbox → Execution Service):**

```typescript
interface ContextCallRequest {
  id: string;               // correlation ID of the parent execution request
  callId: string;           // unique ID for this specific context call
  type: 'contextCall';
  method: 'fetch' | 'credentials.get' | 'credentials.list' | 'cache.get' | 'cache.set' | 'cache.delete' | 'pipeline.trigger' | 'ontology.getEntity';
  args: unknown[];
}

interface ContextCallResponse {
  callId: string;
  type: 'contextCallResponse';
  result?: unknown;
  error?: { code: string; message: string };
}
```

The Execution Service handles `contextCall` messages and fulfills them by:
- `fetch`: proxies the request through the platform's outbound allowlist proxy. Internal service URLs are blocked. The allowlist is configured per-tenant.
- `credentials.get`: calls the Ingestion Service credential vault via the internal service network (the Execution Service is on `oneplatform-internal`): `GET /internal/ingestion/credentials/{credentialBundleId}/field/{key}`. The Ingestion Service decrypts and returns the value. The value is NEVER logged by the Execution Service — it is passed immediately to the sandbox response and no copy is retained.
- `cache.get/set/delete`: calls the Plugin Service cache API: `GET/PUT/DELETE /internal/plugins/cache/{tenantId}/{pluginId}/{key}`. The Plugin Service manages plugin cache storage in Redis (the Execution Service has no direct Redis access).
- `pipeline.trigger`: blocked if `hookContext = true` (see §12). Otherwise, calls the Pipeline Service: `POST /internal/pipeline/trigger`.
- `ontology.getEntity`: served from the local ontology snapshot passed into the execution context at request time. No network call needed.

### 11.3 fetch() Security

The injected `fetch()` is NOT the native `fetch`. It is a wrapper that:

1. Validates the URL against the tenant's outbound allowlist (stored in the Execution Service's local config cache, fetched from the Ontology/Plugin Service at startup and refreshed every 5 minutes).
2. Blocks all URLs matching `http://*.service:*` or `http://10.*`, `http://172.*`, `http://192.168.*` (RFC 1918 ranges) — internal service URLs are never reachable.
3. Blocks `file://`, `data://`, and other non-HTTP/HTTPS schemes.
4. Enforces a timeout of 10 000 ms per fetch call.
5. Disallows following redirects to blocked domains (redirect chain is validated at each hop).
6. The actual HTTP call is made BY the Execution Service process (on the `oneplatform-internal` network), NOT by the sandbox. The sandbox requests a `fetch` via the `contextCall` mechanism and receives the response body.

This design ensures that even if a malicious plugin attempts to probe the internal network via `fetch()`, the call is rejected before it leaves the Execution Service process. The sandbox itself has no network access whatsoever.

---

## 12. HookRecursionError

### 12.1 Problem

When the Pipeline Service invokes a plugin hook through the Execution Service, the hook code has access to `context.pipeline.trigger()`. If allowed, this could create an unbounded recursion: hook → trigger pipeline → run hook → trigger pipeline → ...

### 12.2 Detection

**How it works:**

1. When the Pipeline Service calls `POST /internal/execution/run` with `context.hookContext = true`, the Execution Service records this flag on the execution record and in the per-request execution context.

2. The Execution Service DOES NOT expose `hookContext` to the user code — it is stripped before the `PluginContext` is serialized and injected into the Isolate. Plugin code cannot detect or query whether it is running in a hook context.

3. When the sandbox code calls `context.pipeline.trigger()`, this resolves as a `contextCall` back to the Execution Service.

4. The Execution Service looks up the execution record for the `id` in the `contextCall` and checks `hookContext === true`.

5. If `hookContext === true`, the Execution Service returns a `contextCallResponse` with error code `HOOK_RECURSION_ERROR` instead of forwarding to the Pipeline Service. The error propagates back to the Isolate, which throws it as an exception. The execution completes with `status: 'error'`, `error_code: 'EXECUTION_HOOK_RECURSION'`.

### 12.3 Coverage

This enforcement covers both `pipeline.trigger()` AND any other pipeline-triggering API that may be added to `PluginContext` in the future. Any method that ultimately calls the Pipeline Service must be guarded by the `hookContext` check in the `contextCall` handler. This is documented as an invariant in the handler's code comments and enforced by a unit test that verifies all pipeline-adjacent `contextCall` methods are listed in the guard list.

### 12.4 Advisory vs Critical Hooks

For advisory hooks, a `HookRecursionError` causes the hook to fail and the chain to continue with the pre-hook payload (fail-open). For critical hooks, a `HookRecursionError` causes the entire pipeline stage to abort (fail-closed). This behavior is determined by the Pipeline Service, which interprets the `EXECUTION_HOOK_RECURSION` error code according to the hook's declared criticality.

---

## 13. Contingency Plan — Docker Warm Pool

ADR-6 defines the contingency for `isolated-vm` becoming unloadable (CVE, Node.js incompatibility, or maintenance abandonment).

### 13.1 Trigger Condition

The contingency is activated via environment variable:

```
OP_SANDBOX_MODE=docker-pool  (default: isolated-vm)
```

When `OP_SANDBOX_MODE=docker-pool`, the Execution Service routes ALL JS/TS executions through pre-warmed Docker containers instead of `op-sandbox-vm`. The `op-sandbox-vm` container is still started (for health-check purposes) but receives no traffic.

### 13.2 Pre-Warmed Pool

The pool size is configured via:

```
OP_SANDBOX_POOL_SIZE=5   (default 5 warm containers)
```

At startup, the Execution Service creates `OP_SANDBOX_POOL_SIZE` Docker sandbox containers (using `oneplatform-sandbox-js:latest` — a Node.js 20 container with isolated-vm removed, running the code via `node:vm` module as the fallback runtime). These containers sit idle, connected to the sandbox network, waiting for execution requests.

**Warm container lifecycle:**
- Container is acquired from pool when a request arrives.
- Code is piped via stdin.
- Result is returned via stdout.
- Container is recycled: if it has handled fewer than 1000 executions and its uptime is under 1 hour, it is returned to the pool. Otherwise it is destroyed and a new container is added to the pool.
- The pool manager maintains pool size by adding new containers when one is destroyed.

**Latency characteristics:**
- Cold container startup: 500 ms – 2 000 ms.
- Warm container (from pool): ~100 ms (measured from execution dispatch to first byte of response).
- This is ~100x slower than the ~1 ms isolated-vm path but functional.

### 13.3 CI Smoke Test

A dedicated CI job (`vitest run sandbox-smoke`) runs on every push to the `main` branch. It:

1. Builds the `Dockerfile.sandbox` image.
2. Starts `op-sandbox-vm`.
3. Sends a `ping` via the Unix socket.
4. Executes a simple code snippet.
5. Verifies the result is correct.
6. Executes a code snippet that uses the `context.logger.info()` API.
7. Verifies log lines are received.

If this CI job fails, the build is blocked. This ensures that any Node.js upgrade or `isolated-vm` version change that breaks the sandbox is caught before deployment.

---

## 14. Error Handling

### 14.1 Error Code Registry

All error codes are registered in `@oneplatform/core/errors.ts`. Execution Service specific codes:

| Code | HTTP status | Description |
|---|---|---|
| `EXECUTION_NOT_FOUND` | 404 | Execution record not found for tenant |
| `EXECUTION_SANDBOX_UNAVAILABLE` | 503 | Cannot dispatch — no healthy sandbox |
| `EXECUTION_TIMEOUT` | 200 (in SSE `error` event) | Execution exceeded timeout |
| `EXECUTION_OOM` | 200 (in SSE `error` event) | Execution exceeded memory limit |
| `EXECUTION_SANDBOX_CRASH` | 200 (in SSE `error` event) | Sandbox container crashed unexpectedly |
| `EXECUTION_HOOK_RECURSION` | 200 (in SSE `error` event) | `pipeline.trigger()` called from hook context |
| `EXECUTION_CODE_TOO_LARGE` | 400 | Code payload exceeds size limit |
| `EXECUTION_PAYLOAD_TOO_LARGE` | 400 | Total request payload exceeds 12 MB |
| `EXECUTION_RESULT_TOO_LARGE` | 200 (in SSE `error` event) | Result serialized to >4 MB |
| `EXECUTION_INVALID_LANGUAGE` | 400 | Unsupported language for this execution type |
| `EXECUTION_TIMEOUT_EXCEEDED_LIMIT` | 400 | Requested timeout exceeds maximum |
| `EXECUTION_BUNDLE_INTEGRITY_ERROR` | 500 | Plugin bundle hash mismatch |
| `EXECUTION_MODULE_NOT_ALLOWED` | 200 (in SSE `error` event) | User code attempted to import a non-allowlisted module |
| `EXECUTION_FETCH_BLOCKED` | 200 (in SSE `error` event) | `context.fetch()` attempted to reach a blocked URL |
| `EXECUTION_CREDENTIALS_DENIED` | 200 (in SSE `error` event) | `credentials.get()` called outside `connector-run` type |
| `SERVICE_DRAINING` | 503 | Plugin is being drained; retry after drain completes |

### 14.2 Sandbox Crash Response

When a sandbox crash is detected mid-execution:

1. All in-flight executions are marked `status: 'killed'`, `error_code: 'EXECUTION_SANDBOX_CRASH'`.
2. SSE streams for affected executions emit an `error` event immediately.
3. The Execution Service emits a `CRITICAL` structured log event: `{ event: 'sandbox_crash', sandboxRunCount, inflightCount, traceIds: [...] }`.
4. The `execution_service_sandbox_crashes_total` Prometheus counter is incremented.
5. The Execution Service initiates the recycle sequence to bring the replacement sandbox online.
6. Callers (Pipeline Service, App Service) receive the error response and should NOT retry automatically — they should surface the error to the user with context about which execution failed.

### 14.3 Timeout Kill Flow

```
1. Execution Service timer fires (timeout ms after dispatch)
2. For isolated-vm: send { method: "drain", targetExecutionId: "<id>" } to sandbox
   Sandbox disposes the specific Isolate immediately.
   If sandbox is unresponsive: send SIGKILL to op-sandbox-vm via Docker API.
3. For Docker containers: DELETE /containers/{id}?force=true
4. Update execution record: status='timeout', error_code='EXECUTION_TIMEOUT', completed_at=now()
5. Emit SSE 'error' event to subscribers
6. Increment execution_service_timeouts_total counter
```

### 14.4 Plugin Error vs Sandbox Error

Distinction is important for debugging:

- **Plugin error:** user code threw an exception that propagated normally through the Isolate. Status is `error`, `exit_code` is non-zero. The `error_stack` is the user code's stack trace (sanitized — internal sandbox paths stripped). This should be surfaced to the plugin developer.
- **Sandbox internal error:** the sandbox server itself encountered an unexpected condition. Status is `error`, `error_code` is `SANDBOX_INTERNAL`. The error is opaque to the user — the full stack trace is logged internally (Logging Service) but not returned to the caller.

---

## 15. Observability

### 15.1 Metrics (Prometheus, `/metrics` endpoint)

| Metric name | Type | Labels | Description |
|---|---|---|---|
| `execution_service_executions_total` | Counter | `type`, `status`, `language`, `tenant_id` | Total executions by outcome |
| `execution_service_execution_duration_ms` | Histogram | `type`, `language` | Execution duration (p50/p95/p99) |
| `execution_service_sandbox_run_count` | Gauge | `sandbox_id` | Current run count of active sandbox |
| `execution_service_sandbox_recycles_total` | Counter | `reason` (threshold/time/crash) | Sandbox recycle events |
| `execution_service_sandbox_crashes_total` | Counter | | Sandbox unexpected crashes |
| `execution_service_timeouts_total` | Counter | `type`, `language` | Execution timeouts |
| `execution_service_oom_total` | Counter | | OOM kills |
| `execution_service_bundle_cache_hits_total` | Counter | | Plugin bundle cache hits |
| `execution_service_bundle_cache_misses_total` | Counter | | Plugin bundle cache misses |
| `execution_service_inflight_executions` | Gauge | `sandbox_type` | Current in-flight execution count |
| `execution_service_pool_warm_containers` | Gauge | | Warm Docker pool container count |
| `execution_service_hook_recursion_errors_total` | Counter | | HookRecursionError occurrences |

### 15.2 Distributed Tracing

- Every execution creates a child span under the trace propagated from the calling service.
- The span name format: `execution.{type}.{language}` (e.g., `execution.connector-run.js`).
- Span attributes: `execution.id`, `execution.plugin_id`, `execution.timeout_ms`, `execution.sandbox_type`.
- SSE log streaming creates a separate child span: `execution.log-stream`.
- `contextCall` operations (fetch, credentials, cache) each create their own child spans.

### 15.3 Structured Logging

All Execution Service log events include:
- `traceId`, `executionId`, `tenantId`, `type`, `language`
- No credential values, no user code content, no result payloads (to avoid logging sensitive data).

Critical log events emitted:
- Sandbox crash (CRITICAL)
- Sandbox recycle started/completed (INFO)
- Bundle integrity failure (ERROR)
- Hook recursion detected (WARN)
- OOM kill (WARN)
- Execution timeout (WARN)

### 15.4 Health Endpoints

```
GET /healthz   — liveness: returns 200 if the process is running
GET /readyz    — readiness: returns 200 only if Unix socket connection to sandbox is healthy
               — returns 503 if sandbox is unreachable or in the middle of a recycle with no replacement ready
```

---

## 16. Security Design

### 16.1 Defense-in-Depth Layers

```
Layer 1: Service token authentication on all /internal/* endpoints
         (Ed25519 JWT, validated against shared public keys)

Layer 2: Service RBAC — only Pipeline Service, App Service can call /internal/execution/run

Layer 3: Tenant isolation — executions are scoped to tenantId; cross-tenant
         access is impossible without a valid service token claiming a matching tenantId

Layer 4: Sandbox network isolation — op-sandbox-vm on oneplatform-sandbox only;
         no route to oneplatform-internal; no direct database access

Layer 5: Code isolation — isolated-vm Isolates cannot access host Node.js memory,
         require EXPLICIT reference callbacks for any host interaction

Layer 6: Resource limits — 512 MB memory, 1 CPU, 30 s timeout enforced at Docker level
         (not just at application level)

Layer 7: Module allowlist — user code cannot import arbitrary npm modules

Layer 8: fetch() allowlist — outbound HTTP calls are proxied, internal URLs blocked

Layer 9: Credential isolation — credentials passed as CredentialAccessor, not as values;
         never logged, never in response payloads except as passed directly to sandbox

Layer 10: Sandbox recycling — max 1000-execution window limits any persistent in-memory
          compromise to a bounded time window
```

### 16.2 Principle of Least Privilege

- The `op-sandbox-vm` container has uid 1001, no capabilities, read-only filesystem, no network access to internal services.
- The Execution Service database user (`execution_service_role`) has `SELECT`, `INSERT`, `UPDATE` on `execution.*` only — no access to any other schema.
- The Execution Service has NO Redis access — it cannot write to BullMQ queues or read auth tokens.
- The Docker socket proxy allows only the 6 specific Docker API endpoints needed (create, start, attach, logs, wait, delete + stats). The Execution Service cannot list all containers, cannot access container file systems, cannot read Docker secrets.

### 16.3 Data Not Logged

The following data is explicitly never logged by the Execution Service:
- Credential values returned by `credentials.get()`.
- The full `code` string of an execution (the `code_hash` is logged, not the code itself).
- Result payloads of executions (may contain customer data).
- The `context` object passed to executions (may contain ontology data, pipeline parameters).

---

## 17. Testing Strategy

### 17.1 Unit Tests (`vitest`)

**Location:** `services/execution/src/**/*.test.ts`

Coverage targets:

| Module | Test focus |
|---|---|
| `sandbox-manager.ts` | Recycle threshold logic, drain state machine, in-flight counter, warm pool refill |
| `unix-socket-client.ts` | Message framing (length-prefix + newline), correlation ID matching, ping/pong, reconnect |
| `plugin-cache.ts` | LRU eviction, TTL expiry, bundle hash verification, disk overflow write/read |
| `context-call-handler.ts` | `hookContext` guard for all pipeline-adjacent methods, fetch allowlist enforcement |
| `execution-router.ts` | Request routing to isolated-vm vs Docker based on language, execution type |
| `resource-limiter.ts` | Timeout timer setup/teardown, OOM detection event flow |
| `sse-manager.ts` | SSE subscriber registration, log line fan-out, Last-Event-ID resume |

**Key test cases:**

- Recycle triggers at exactly 1000 executions.
- Recycle triggers at exactly 1 hour.
- Graceful drain waits for in-flight; new requests route to replacement.
- `HookRecursionError` thrown for `pipeline.trigger()` when `hookContext=true`.
- `HookRecursionError` NOT thrown when `hookContext=false`.
- Bundle hash mismatch returns `EXECUTION_BUNDLE_INTEGRITY_ERROR` and does not execute.
- Timeout kills the Isolate and updates execution status.
- OOM from `isolated-vm` (simulated) updates status to `killed`/`oom`.
- SSE stream closes with `complete` event on success.
- SSE stream closes with `error` event on timeout.
- `Last-Event-ID` resumes log stream from correct line.

### 17.2 Sandbox Integration Tests

**Location:** `services/execution/src/__integration__/sandbox.test.ts`

These tests start a real `op-sandbox-vm` process and communicate via the Unix socket. They run in CI as part of the `sandbox-smoke` test suite.

**Coverage:**

| Test | What it verifies |
|---|---|
| `ping round-trip` | Socket framing, length-prefix encoding/decoding |
| `simple execute` | Code executes, result returned correctly |
| `logger API` | Log lines streamed before completion response |
| `fetch blocked` | Internal URL fetch returns `EXECUTION_FETCH_BLOCKED` |
| `module allowlist` | `require('fs')` throws `ExternalModuleNotAllowedError` |
| `memory limit` | Allocating >128 MB in Isolate returns `oom` status |
| `timeout` | Code with infinite loop is killed at timeout + 2 s |
| `app-build` | Simple React component builds without error |
| `incremental build` | Second build with `incrementalContextId` completes in <500 ms |
| `concurrent executions` | 20 simultaneous requests all complete correctly |

### 17.3 Resource Limit Tests

**Location:** `services/execution/src/__integration__/resource-limits.test.ts`

These tests verify that limits are enforced as documented:

- Code allocating 200 MB is killed with `EXECUTION_OOM`.
- Code running for 35 000 ms is killed at the 30 000 ms mark (±500 ms tolerance).
- A connector-run with 300 000 ms timeout runs for the full duration without early kill.
- A tight infinite loop (synchronous busy-wait) is killed by the `isolated-vm` CPU time limit.
- A Docker container (Python sandbox) is killed after the timeout via the Docker API.
- Peak memory is correctly reported in the execution record.

### 17.4 API Contract Tests

**Location:** `services/execution/src/__integration__/api.test.ts`

Using Supertest to verify:

- All endpoints return the correct HTTP status codes.
- Error responses conform to the ADR-29 error envelope format.
- SSE streams emit `complete` and `error` events in the correct format.
- Service token validation rejects malformed or missing tokens on `/internal/*`.
- `Last-Event-ID` header correctly resumes log streaming.

### 17.5 End-to-End (Pipeline Flow)

**Location:** `e2e/pipeline-execution.test.ts` (shared with Pipeline Service)

End-to-end tests that exercise the full path: Pipeline Service → Execution Service → sandbox → result returned to Pipeline Service. These run in the full Docker Compose stack using `docker compose --profile test up`.

---

## 18. Technology Choices

| Component | Choice | Rationale |
|---|---|---|
| Framework | Hono (TypeScript) | Consistent with all other services; TypeScript-first; MIT |
| JS/TS sandbox | `isolated-vm` 4.x | ~1 ms execution, true V8 isolation, explicit API surface; ADR-6 |
| Node version (sandbox) | Node 20 LTS, pinned | Last confirmed `isolated-vm` working version; CI smoke test catches breakage |
| LRU cache | `lru-cache` 10.x | Well-maintained, supports size calculation, TTL per entry; MIT |
| Unix socket framing | Length-prefix (4-byte big-endian) + NDJSON | Robust framing; no partial-read ambiguity; human-readable for debugging |
| Plugin bundle hash | SHA-256 | Sufficient collision resistance for integrity verification; available in Node.js built-in crypto |
| Docker API client | Custom minimal HTTP client over UNIX socket | Avoids `dockerode` dependency; only 6 API calls needed; less attack surface |
| Test runner | Vitest | Consistent with platform; fast; works with TypeScript without config |

**Alternatives considered and rejected:**

- **`vm2`** for sandboxing: archived and abandoned. Known escapes. Rejected.
- **`vm` module (Node built-in)**: insufficient isolation; access to Node.js globals via prototype chain attacks. Acceptable only as the Docker-pool contingency runtime (see §13).
- **`workerd` (Cloudflare Workers runtime)**: evaluated as a contingency for `isolated-vm` abandonment. Better long-term maintenance prospect but requires different API surface. Noted in ADR-6 as the preferred alternative if isolated-vm is abandoned.
- **WebAssembly sandbox**: no good TypeScript execution story; Python/Go compilation to WASM is complex and slow.
- **gVisor or Firecracker**: provides excellent kernel-level isolation but adds 500 ms+ startup per execution and requires host kernel configuration changes — incompatible with a simple `docker compose up` deployment model.

---

## 19. Open Questions / Known Limitations

1. **isolated-vm `require()` shim for TypeScript modules:** TypeScript source is transpiled by the sandbox before execution. The transpiler (esbuild or tsc at sandbox startup) must handle the module allowlist correctly. The implementation must verify that `require()` is fully remapped and cannot reach the host filesystem via edge cases in the transpiler's resolver. This requires a dedicated security test.

2. **Connector 5-minute timeout interaction with sandbox recycle:** A connector-run that runs for 4 minutes could be mid-execution when the 1-hour recycle timer fires. The drain sequence (§9.2) handles this correctly — the old sandbox is not destroyed until the execution finishes or the 60-second grace period expires. However, a 4-minute execution exceeds the 60-second grace period. Resolution: the drain grace period is extended for `connector-run` execution types. When the highest in-flight timeout across all current executions exceeds 60 000 ms, the drain grace period is set to `max_inflight_timeout + 5000 ms`. This is bounded by `OP_SANDBOX_RECYCLE_GRACE_MS` (default 60 000 ms, configurable up to 360 000 ms).

3. **Disk overflow cache encryption key rotation:** The on-disk bundle cache is encrypted with a key derived from `OP_MASTER_KEY`. If `OP_MASTER_KEY` is rotated, existing on-disk cache files become unreadable. This is acceptable — they will simply be treated as cache misses and re-fetched. The service should log a WARNING on startup if it detects cache files that cannot be decrypted.

4. **Docker sandbox image updates:** The Python and Go sandbox images must be updated independently of the main platform build. A process for bumping their base images and re-running security scans needs to be defined. For now, CI scans all Docker images with Trivy on every push and blocks on CRITICAL CVEs.

5. **`incremental build` context invalidation on sandbox recycle:** When the `op-sandbox-vm` container is recycled, all `incrementalContextId` values become invalid. The App Service must handle `EXECUTION_INCREMENTAL_CONTEXT_EXPIRED` errors by triggering a full rebuild. The App Service should suppress this error from the user — it manifests as a single slower rebuild (3 s instead of 200 ms) rather than an error.

6. **Memory peak measurement accuracy for Docker containers:** For Docker sandbox containers, memory peak is measured from the `GET /containers/{id}/stats` endpoint AFTER the container exits. This captures the last-known stats, not the true peak. For accurate peak tracking, the Execution Service would need to poll stats during execution. This is not implemented in Phase 4 — `memory_peak_mb` for Docker executions is marked as approximate (recorded as NULL until a stats implementation is added).
