# OnePlatform — Architecture Decision Record

## Project Vision

OnePlatform is an open-source data platform that provides:
- Data ingestion from any source
- User-defined ontology/schema mapping
- Automated pipelines with triggers, crons, and event-driven flows
- Sandboxed code execution in multiple languages
- An app platform for building and hosting mini-apps
- API gateway for exposing data via REST endpoints
- Built-in auth and RBAC for multi-tenant security
- Centralized logging, audit trails, and analytics
- Plugin system for extensibility at every layer

It aims to be a free, source-available alternative to tools like Fivetran, n8n, and Retool — combined into one cohesive platform. (Note: OnePlatform uses the Business Source License, which is source-available and free to self-host but is not OSI-approved "open source." It converts to Apache 2.0 after 4 years.)

## Key Decisions

### 1. MVP Scope
**Decision:** Include all core subsystems in MVP — ingestion, ontology, pipelines, code execution, app platform, API gateway, auth/RBAC, logging, and plugin system. Marketplace/pre-built connectors deferred to fast follow.

**Rationale:** The app platform is a key differentiator. Users need the full "ingest → map → build" loop to see the value. The plugin system ensures extensibility from day one.

### 2. App Platform Approach
**Decision:** Code-first with templates and SDK. Visual drag-and-drop builder designed for later.

**Rationale:** Faster to build, more flexible, appeals to technical early adopters. Architecture allows visual builder to be layered on top.

### 3. Deployment Model
**Decision:** Self-hosted first via Docker Compose, with cloud-ready architecture internally.

**Rationale:** Single `docker compose up` for easy adoption. Clean service boundaries allow splitting into hosted SaaS later if monetized.

### 4. Tech Stack
**Decision:** Full TypeScript monorepo — React + Tailwind v4 + shadcn/ui frontend, Hono backend services.

**Rationale:** Same language front and back, shared types, huge ecosystem. Code generation is central to the platform — generating TypeScript that runs natively in the same runtime is the most cohesive approach. Hono chosen over Fastify for its lighter footprint, cleaner TypeScript-first API, and runtime portability (Node, Bun, edge). MIT licensed.

### 5. Database Strategy
**Decision:** PostgreSQL + PgBouncer + Redis. Postgres for persistent storage with PgBouncer for connection pooling, Redis for job queues (BullMQ), caching, and real-time pipeline state. Redis uses logical databases to separate concerns.

**Rationale:** Postgres handles structured platform metadata and dynamic user data (JSONB). PgBouncer prevents connection pool exhaustion across 9 services sharing one Postgres instance — critical for stability. Redis is needed for BullMQ job queues regardless.

**Postgres connection pool sizing:**
- PgBouncer pooling mode: `transaction` mode for all services EXCEPT the Ontology Service and Pipeline Service, which use `session` mode via a separate PgBouncer pool. This is because: (1) transaction mode breaks `LISTEN/NOTIFY` and advisory locks, which the Ontology Service uses for schema migration coordination and the Pipeline Service uses for distributed lock acquisition; (2) session-mode pools for these two services are sized smaller (Ontology: 15, Pipeline: 15) since each connection is held longer
- PgBouncer `max_client_conn`: 200 (total across all services)
- PgBouncer `default_pool_size`: 20 per service (9 services × 20 = 180 server connections max)
- Postgres `max_connections`: 200 (headroom for PgBouncer + direct admin access)
- Per-service allocation: Gateway (15), Auth (20), Ingestion (25), Ontology (15), Pipeline (25), Execution (10), App (15), Logging (30), Plugin (10) — weighted by expected write volume
- **Scaling wall documentation:** at approximately 500 concurrent pipeline jobs or 50 concurrent ontology migrations, the shared Postgres becomes a write bottleneck on the Logging and Pipeline schemas; at this point, the documented upgrade path is to split Logging to its own Postgres instance (highest write volume), then Pipeline, leaving the remaining 7 services on the shared instance

**Redis logical database separation:**
- DB 0: BullMQ job queues (highest traffic)
- DB 1: JWT revocation blocklist + refresh tokens (auth-critical)
- DB 2: Ontology cache invalidation pub/sub
- DB 3: Log/audit delivery pub/sub
- DB 4: General caching (rate limit counters, session data)
- This prevents BullMQ traffic from crowding out auth or ontology pub/sub operations
- **Acknowledged limitation:** Redis logical databases share memory, CPU, and connection pool — they are namespaces, NOT isolation boundaries. A `FLUSHDB` on any DB or a memory-intensive operation on DB 0 (BullMQ) can still affect all other DBs. True isolation requires separate Redis instances, which is documented as the production HA upgrade path (Redis Sentinel per concern group). The logical DB separation is a development/small-deployment reasonable-default that reduces namespace collision, not a security boundary.
- **Redis access control:** Redis is configured with ACL rules using key-prefix conventions exclusively. The `SELECT` command is **denied for ALL service users** (`-select`) — all services operate on DB 0 only, and isolation is enforced entirely via key-prefix ACLs. The logical DB numbers described earlier (DB 0-4) are a conceptual grouping implemented via key prefixes, NOT via `SELECT` commands:
  - Auth Service user: `~auth:* ~revocation:* &auth:* &revocation:*` (only auth-prefixed keys + pub/sub channels)
  - Pipeline Service user: `~queue:pipeline:* ~queue:execution:* &ontology:*` (pipeline queues + ontology pub/sub subscribe)
  - Logging Service user: `~log:* ~audit:* &logs:* &audit:*` (log keys + log/audit pub/sub channels)
  - Gateway Service user: `~ratelimit:* ~gateway:*` (rate limit counters + replica tracking)
  - The `-select -flushdb -flushall -keys -debug` commands are denied for ALL service users (admin-only)
  - The Execution Service has NO Redis access at all (it communicates only via the Unix socket to sandbox-vm and via the internal service network to other services)
  - This eliminates the logical DB isolation gap entirely — services cannot `SELECT` into other databases because `SELECT` is denied, and key-prefix ACLs prevent access to other services' keys within DB 0

### 6. Code Execution Sandbox
**Decision:** `isolated-vm` for JavaScript/TypeScript (fast path, ~1ms), Docker containers for other languages (Python, Go, etc.) accessed via a restricted Docker socket proxy.

**Rationale:** Most auto-generated code is JS/TS and benefits from near-instant execution. Docker containers provide full language support for heavy processing. Platform injects controlled APIs (fetch, db, cache) into both environments.

**Security model:**
- Docker socket is NEVER mounted directly into the Execution Service container
- A Docker socket proxy (tecnativa/docker-socket-proxy) sits between the Execution Service and Docker Engine with restricted permissions: only `POST /containers/create`, `POST /containers/{id}/start`, `GET /containers/{id}/logs`, `DELETE /containers/{id}` are allowed
- Sandbox containers run with `--network=oneplatform-sandbox` (isolated network), `--read-only` filesystem, no capabilities (`--cap-drop=ALL`), memory/CPU limits, and a hard timeout enforced by the Execution Service
- The `fetch()` API injected into isolated-vm routes through a platform proxy that enforces an outbound allowlist — internal service URLs (`http://*-service:*`) are blocked by default; only user-configured external URLs are permitted
- Sandbox containers get the same outbound proxy with the same allowlist

**isolated-vm process isolation:**
- `isolated-vm` does NOT run inside the main Execution Service process — it runs in a dedicated, low-privilege child container (`op-sandbox-vm`) with no Docker socket access, no network access to internal services, and minimal filesystem
- The Execution Service communicates with `op-sandbox-vm` via a Unix socket (mounted as a shared volume) using a simple JSON-RPC protocol: `{method: "execute", code: "...", context: {...}}`. The socket is unidirectional — the Execution Service is the ONLY writer; the sandbox-vm is the ONLY reader. The socket is implemented as a pair: one for requests (Execution→sandbox), one for responses (sandbox→Execution). The sandbox-vm cannot send unsolicited messages or execute arbitrary commands back through the socket. If the sandbox-vm is compromised, it can only send malformed responses to pending requests — it cannot initiate new executions or reach any other resource.
- If a V8 engine vulnerability allows escape from `isolated-vm`, the attacker lands in a container with no capabilities, no Docker socket, no internal network, and read-only filesystem — the blast radius is contained to that single sandbox container
- The `op-sandbox-vm` container is recycled (destroyed and recreated) every 1000 executions or every 1 hour (whichever comes first) to limit the window of any in-memory compromise. **Graceful recycling:** the Execution Service tracks in-flight executions via a counter. When the recycle threshold is reached, the Execution Service stops sending NEW executions to the current sandbox-vm and spins up a REPLACEMENT container. In-flight executions on the old container are given up to 60s to complete. A hard cap of 10 concurrent in-flight executions is enforced on the outgoing container — if new requests arrive while the old container is draining, they are routed to the replacement container only. After all in-flight executions finish (or the 60s grace period expires), the old container is destroyed. This ensures: (1) no mid-execution kills, (2) the overlap period is bounded and cannot become persistent under sustained load.
- Resource limits: 512MB memory, 1 CPU core, 30s execution timeout per invocation
- **isolated-vm maintenance risk:** `isolated-vm` has limited maintenance activity and known compatibility issues with Node.js 22+. Mitigations: (1) the `Dockerfile.sandbox` pins Node to the last confirmed working version (Node 20 LTS initially), independent of the main service Node version; (2) CI includes a dedicated `isolated-vm smoke test` that exercises isolate creation, code execution, and injected API calls — a Node upgrade breaking `isolated-vm` is caught before deployment; (3) **contingency plan:** if `isolated-vm` becomes unloadable or a critical CVE is unpatched, the fallback is to route all JS/TS executions through lightweight Docker containers using a pre-warmed container pool (containers kept warm with 100ms startup instead of cold 500ms-2s). This increases latency from ~1ms to ~100ms but preserves functionality. The warm pool size is configurable via `OP_SANDBOX_POOL_SIZE` (default 5). Alternative libraries to evaluate if `isolated-vm` is abandoned: `workerd` (Cloudflare Workers runtime, Apache 2.0) or Node.js `worker_threads` with `vm` module (built-in, less isolated but functional).

### 7. Authentication Model
**Decision:** Built-in email/password auth + optional OAuth (GitHub, Google). API keys for programmatic access. Short-lived access tokens + refresh tokens with Redis-backed revocation.

**Rationale:** Self-hosted users need offline auth. OAuth is table stakes for modern platforms. Both available via configuration.

**Token strategy:**
- Access tokens: JWT, 15-minute expiry, contain user ID + roles + tenant ID
- Refresh tokens: opaque, stored in Redis, 7-day expiry, rotated on each use
- Token revocation: Redis SET of revoked token JTIs checked on every request via auth middleware in @oneplatform/core — O(1) lookup
- API keys: hashed with bcrypt, stored in Postgres, never expire but can be revoked instantly via the revocation set
- On compromise: revoke refresh token in Redis → access token expires within 15 minutes max; or add access token JTI to revocation set for immediate invalidation
- **Emergency revocation (Redis outage):** if Redis is down and a compromised token cannot be added to the blocklist, operators can trigger an emergency re-key via `op auth emergency-rotate` (CLI) or the admin API. This rotates the JWT signing secret, immediately invalidating ALL access tokens platform-wide. All users must re-authenticate. This is a last-resort nuclear option documented in the ops guide for the combined scenario of Redis outage + active token compromise.

### 8. License
**Decision:** Business Source License (BSL) — source-available, free to self-host, converts to Apache 2.0 after 4 years.

**Rationale:** Protects against competitors re-hosting the project as a competing service. Allows monetization later while keeping source fully visible and self-hosting free.

### 9. Real-Time Communication
**Decision:** SSE for one-way streaming (pipeline logs, status updates, data feeds) + WebSockets for bidirectional communication (app platform).

**Rationale:** SSE is simpler and more reliable for 80% of real-time needs. WebSockets available for apps needing bidirectional communication.

### 10. Architecture Pattern
**Decision:** Full microservices — 9 services, each its own Docker container with clean boundaries. Engine-first design: build the robust core engine, layer extensible parts on top. SOLID principles throughout. Shared PostgreSQL with per-service schemas (via PgBouncer) initially, separable to individual databases later.

**Rationale:** Avoids painful monolith-to-microservices refactoring later. Per-service schemas keep data boundaries clean. PgBouncer keeps connection management sane. Connection string change is all that's needed to split databases.

### 11. Secret Management
**Decision:** All connector credentials (API keys, database passwords, OAuth tokens, FTP credentials) are encrypted at rest using AES-256-GCM with application-level encryption before storage in Postgres. Encryption keys are derived from a master key stored in an environment variable, with support for key rotation.

**Rationale:** Connector credentials are the most sensitive data in the platform. Relying on Postgres-level encryption alone is insufficient — if the database is compromised, all credentials are exposed. Application-level encryption ensures credentials are encrypted in the column itself.

**Implementation:**
- Master encryption key: loaded from `OP_MASTER_KEY` environment variable (generated on first setup via `openssl rand -base64 32`)
- **CRITICAL SECURITY NOTE (documented in ops guide + first-run setup wizard):** `OP_MASTER_KEY` is the single key protecting ALL connector credentials. In a Docker Compose deployment, this key lives in the `.env` file on the host. Compromise of the compose host exposes all credentials. Operators MUST: (1) restrict `.env` file permissions to root/docker group only (`chmod 600`), (2) in production, use Docker secrets or an external secrets manager (HashiCorp Vault, AWS Secrets Manager) instead of `.env`, (3) back up the key securely — loss means all credentials become unrecoverable. The setup wizard generates the key and displays these warnings prominently.
- Key derivation: HKDF-SHA256 from master key + per-credential salt
- Storage: `encrypted_blob` (AES-256-GCM ciphertext) + `key_version` (integer) + `salt` (random bytes) in the `ingestion.credentials` table
- Key rotation: new key version bumps `key_version`; background job re-encrypts all credentials with new key; old key retained until migration completes; job is idempotent — it checks `key_version` before re-encrypting each row, so a crash mid-rotation can be safely re-run without double-encrypting already-migrated rows
- In-memory: decrypted credentials are held only in the Ingestion Service memory for the duration of the connection; never logged, never serialized to Redis

### 12. Ontology Resilience
**Decision:** All services that depend on ontology definitions (Gateway, Auth, Pipeline, Execution, App) cache ontology snapshots locally with versioning. The Ontology Service publishes schema change events via Redis pub/sub; consumers update their cache on notification.

**Rationale:** The Ontology Service is a critical dependency for the entire platform. Without caching, a restart or migration in the Ontology Service would cascade-fail all other services.

**Implementation:**
- Each consumer service maintains an in-memory ontology cache keyed by `{tenantId, schemaVersion}`
- On startup, each service fetches the full ontology snapshot from the Ontology Service and caches it
- The Ontology Service publishes `ontology:changed` events to Redis pub/sub with `{tenantId, newVersion, diff}`
- Consumers receive the event, fetch the updated snapshot, and hot-swap their cache
- If the Ontology Service is down, consumers continue operating with their last-known cache — stale reads are acceptable for availability; writes that depend on the latest schema will fail with a clear error
- Schema versions are monotonically increasing integers; consumers reject any schema older than their current cache
- **Missed pub/sub recovery (normal operation):** under normal operation (Redis healthy), ontology changes propagate via pub/sub only — there is no background polling. If a consumer misses a pub/sub message (e.g., brief network hiccup, consumer restart between pub/sub delivery and reconnect), it would remain on a stale cache indefinitely. To prevent this: each consumer runs a **lightweight version-check poll every 5 minutes** (even when Redis is healthy) that compares its cached `{tenantId, schemaVersion}` against the Ontology Service's current version. If a version gap is detected (e.g., consumer is at v5 but Ontology Service is at v7), the consumer fetches the latest snapshot and hot-swaps. This 5-minute poll is a safety net — pub/sub handles 99.9% of updates within milliseconds; the poll catches the 0.1% missed messages. The poll uses ETag/If-None-Match so it's near-zero cost when the cache is current.

### 13. Queue Reliability (BullMQ)
**Decision:** All BullMQ queues are configured with dead-letter queues (DLQ), backpressure limits, and explicit retry policies.

**Rationale:** Without DLQs, a poison-pill job (e.g., malformed data, infinite loop in user code) will block the pipeline worker indefinitely after exhausting retries. This is the #1 reliability risk for a queue-driven platform.

**Implementation:**
- Retry policy: exponential backoff, max 5 retries, base delay 1s, max delay 60s
- Dead-letter queue: after max retries, job moves to `{queueName}:dlq` with full context (original payload, error stack, retry count, timestamps)
- Backpressure: each queue has a `maxLength` (configurable, default 10,000 jobs); producers receive a `QueueFullError` when exceeded, which surfaces to the user as "pipeline backlogged"
- Queue depth monitoring: the Logging Service polls queue depths every 30s; alerts when depth exceeds 80% of maxLength
- Poison-pill detection: if the same job ID fails 3+ times in under 60s, it's flagged and moved to DLQ immediately (skip remaining retries)
- DLQ dashboard: the frontend provides a UI to inspect, replay, or discard DLQ jobs

### 14. Schema Migration Strategy
**Decision:** Ontology schema changes are versioned and generate migration scaffolding automatically. Backward-compatible changes are applied immediately; breaking changes require explicit user confirmation and generate data migration jobs.

**Rationale:** Users will modify ontology schemas after production data exists. Without a migration strategy, schema changes will corrupt data or break dependent pipelines and apps.

**Implementation:**
- Backward-compatible changes (add nullable field, add new entity, widen type): applied immediately, previous schema version still valid, no migration needed
- Breaking changes (remove field, rename field, narrow type, change relationship): Ontology Service generates a migration plan showing affected data count, dependent pipelines, and dependent apps; user must review and confirm
- On confirmation: a migration job is queued to the Pipeline Service that transforms existing data from old schema to new schema in batches; the old schema version remains active until migration completes
- Generated code (API routes, TypeScript types, validation) is versioned alongside the schema — API endpoints support `?v=2` query parameter during migration window; old version is deprecated after migration completes
- **Dual-schema query handling during migration:** while a migration is in progress, some rows are in the new schema and some in the old. The Ontology Service maintains a `migration_status` enum per entity (`idle`, `migrating`, `complete`). During `migrating` state, queries use a UNION view that normalizes both old-schema and new-schema rows into the new schema format (with defaults for missing fields). This ensures consistent query results across batch boundaries. The view is dropped when migration completes.
- **Migration time bounds:** each migration has a configurable maximum duration (default 1 hour, set via `OP_MIGRATION_TIMEOUT`). If the migration job exceeds this timeout (e.g., stuck in BullMQ backlog), the migration is automatically aborted, shadow tables are rolled back, and the old schema is restored. The UNION view is dropped. An alert is sent via the Logging Service. This prevents indefinite UNION view cost for stuck migrations.
- **UNION view query timeout:** queries hitting the UNION view have a per-query timeout of 10s (vs. normal 30s). If a UNION query times out, the caller receives a 503 with `Retry-After: 5` header, indicating the migration is causing temporary degradation. The Logging Service records these timeouts and alerts if they exceed 10% of queries for that entity. **Logging Service exception:** the Logging Service's audit writes do NOT go through the UNION view — audit events are written to the `logging.audit_events` table directly using the raw payload, not ontology-typed queries. This means the Logging Service cannot be blocked by its own UNION view timeouts, avoiding an observability blind spot where the alerting service is blocked by the condition it's supposed to alert on.
- Rollback: if migration fails, old schema version is restored; partially migrated data is reverted using shadow tables (pre-migration snapshots of affected rows, created before each batch begins). Each batch creates its own shadow table (`shadow_{entity}_{batch_id}`), so a failure at batch 6 rolls back batches 1-6 individually in reverse order. Shadow tables are dropped after successful migration or used for restoration on failure.
- **Orphaned shadow table cleanup:** the Ontology Service runs a background job every hour that uses a three-tier detection strategy:
  - **(1) Registered + valid:** scan the `shadow_table_registry` table; for each entry, verify the corresponding shadow table actually exists in `information_schema.tables` AND has the expected row count (stored in the registry at creation time). Entries with no active migration older than 24 hours are auto-dropped (both the registry entry and the table).
  - **(2) Registered + missing/corrupt:** registry entries where the shadow table does NOT exist or has a row count mismatch (indicating a crash during shadow table creation) are flagged as corrupt. For these entries: the registry entry is removed, and if a partial table exists, it is dropped. The rollback path for this batch is marked as unavailable — the migration system skips this batch during rollback and logs a warning that manual data recovery may be needed for the affected batch.
  - **(3) Unregistered tables (belt-and-suspenders):** scan `information_schema.tables` for tables matching `shadow_{entity}_{batch_id}` that are NOT in the registry. These represent the (unlikely) scenario where a crash happened after table creation but before registry write. Unregistered shadow tables older than 48 hours are logged and auto-dropped.
  - **Operation ordering:** the batch sequence is: (a) BEGIN transaction, (b) create shadow table with data snapshot, (c) write registry entry with row count, (d) COMMIT. Because both operations are in the same transaction, either both succeed or neither does — eliminating the crash-between-write gap. The three-tier cleanup handles the remaining edge cases (transaction timeout, OOM kill, etc.).

### 15. App Routing and TLS
**Decision:** User apps are served via path-based routing by default (`/apps/{app-slug}`), with optional subdomain routing (`{app-slug}.apps.yourdomain.com`) for users who configure wildcard DNS and TLS.

**Rationale:** Path-based routing works out of the box with zero DNS/TLS configuration — critical for self-hosted simplicity. Subdomain routing is available for users who want it but is not required.

**Implementation:**
- Default: Gateway routes `/apps/{app-slug}/*` to the App Service, which serves the correct app build
- Optional subdomain: if `OP_WILDCARD_DOMAIN` is configured, Gateway also matches `{slug}.apps.{domain}` and routes to the App Service
- TLS for subdomains: documentation provides guides for Caddy (automatic wildcard via DNS challenge), Let's Encrypt + cert-manager (Kubernetes), and manual wildcard cert installation
- Self-hosted without TLS: works over HTTP on localhost or private networks; HTTPS is recommended but not required for local dev

### 16. Plugin Hook Linearization
**Decision:** Plugin hooks execute in a strictly linear chain with no circular dependencies. The hook execution order is: Plugin Service resolves hook chain → Execution Service runs each hook sequentially → result passes to the next stage. Hooks cannot trigger other hooks in the same chain.

**Rationale:** The call graph `Plugin → Execution → Pipeline → Plugin hook` could deadlock if hooks can recursively trigger other hooks. Linearization prevents this.

**Implementation:**
- Each pipeline stage has two hook points: `before:{stage}` and `after:{stage}`
- When a stage runs, the Pipeline Service asks the Plugin Service for the ordered list of hooks registered for that stage
- The Plugin Service returns a flat, ordered array of hook references (sorted by priority)
- The Pipeline Service passes each hook to the Execution Service sequentially; each hook receives the current data payload and returns a (possibly modified) payload
- **All plugin hook code runs through the Execution Service sandbox** — plugin hooks are user-supplied or third-party code and MUST be sandboxed. JS/TS hooks run in the `op-sandbox-vm` container via isolated-vm; hooks in other languages run in Docker sandbox containers. Plugins NEVER execute in the Plugin Service process itself — the Plugin Service only manages lifecycle and registry; the Execution Service handles all code execution.
- **Recursion enforcement:** the Pipeline Service (not the hook code) enforces the recursion guard. When the Pipeline Service sends a hook to the Execution Service, it sets a `hookContext: true` flag in the execution request metadata. The Execution Service strips this flag from the user-visible context (hook code never sees it) and uses it internally to block any calls to `pipeline.trigger()` or `queue.enqueue()` from within the execution — returning `HookRecursionError`. The enforcement lives in the Execution Service's injected API layer, not in user-visible flags that could be detected or manipulated by malicious plugin authors.
- Hook timeout: 30s default per hook; exceeded hooks are killed
- Hook criticality: each hook declares `criticality: 'critical' | 'advisory'` at registration time; `advisory` hooks are fail-open (chain continues with pre-hook payload on timeout/error); `critical` hooks are fail-closed (chain aborts and the pipeline stage returns an error) — this prevents security-sensitive hooks (e.g., data masking, compliance filters) from being silently skipped

### 17. Logging Architecture
**Decision:** All log/audit writes from services to the Logging Service are asynchronous and non-blocking via Redis pub/sub. The Logging Service subscribes to log channels and persists to Postgres in batches.

**Rationale:** Synchronous log writes from 9 services would make the Logging Service a bottleneck and add latency to every operation across the platform. Async fire-and-forget via Redis pub/sub decouples log producers from the log consumer.

**Implementation:**
- Each service publishes structured log events to Redis pub/sub channel `logs:{serviceName}` via a non-blocking helper in @oneplatform/core
- Log events include: timestamp, trace ID, service name, level, message, structured metadata
- The Logging Service subscribes to `logs:*` and batches inserts to `logging.events` table every 1s or 1000 events (whichever comes first)
- Audit events (user actions, permission checks, data access) are a separate channel `audit:*` with guaranteed delivery via a BullMQ queue (not pub/sub) — audit trails must not be lost
- Log retention: configurable per-level (ERROR: 90 days, INFO: 30 days, DEBUG: 7 days); audit logs: 1 year minimum
- The Logging Service exposes a query API for the frontend log viewer with filtering by trace ID, service, level, time range
- **Acknowledged tradeoff:** non-audit logs use Redis pub/sub (fire-and-forget, no acknowledgement). If the Logging Service restarts while the in-memory buffer has events, those non-audit log events are lost. This is an accepted tradeoff for performance — audit events use BullMQ with guaranteed delivery and are never lost
- **Horizontal scaling path:** the Logging Service is the highest-write-volume service. Scaling path: (1) table partitioning by time (monthly partitions for `logging.events`, auto-created) — enables fast range queries and efficient partition drops for retention; (2) read replica for the log query API (log viewer reads from replica, writes go to primary); (3) cold storage: partitions older than 30 days are compressed and moved to a `logging.archive` table with reduced indexes; audit logs are never archived until retention expires; (4) at extreme scale, split Logging to its own Postgres instance (first service to split per Decision #5)

## Services

| # | Service | Responsibility | Port |
|---|---------|---------------|------|
| 1 | Gateway | API routing, rate limiting, auth validation, auto-generated REST endpoints | 3000 |
| 2 | Auth | Users, sessions, OAuth, API keys, RBAC, ontology-aware permissions | 3001 |
| 3 | Ingestion | Connectors, webhooks, file uploads, data pull/push, credential vault | 3002 |
| 4 | Ontology | Schema definitions, data models, type validation, mapping rules, code generation | 3003 |
| 5 | Pipeline | Workflow definitions, triggers, cron scheduling, orchestration | 3004 |
| 6 | Execution | Sandboxed code execution (isolated-vm + Docker via socket proxy) | 3005 |
| 7 | App | User app hosting, SDK, build/deploy, app runtime | 3006 |
| 8 | Logging | Centralized logs, trace IDs, audit trail, analytics, alerting | 3007 |
| 9 | Plugin | Plugin lifecycle, hook registry, extension points, plugin SDK | 3008 |

## Infrastructure

| Component | Image | Purpose |
|-----------|-------|---------|
| PostgreSQL 16 | `postgres:16-alpine` | Persistent storage (per-service schemas) |
| PgBouncer | `pgbouncer/pgbouncer` | Connection pooling for Postgres |
| Redis 7 | `redis:7-alpine` | Job queues (BullMQ), pub/sub, caching — configured with `appendonly yes` for AOF persistence; restart-safe for JWT revocation blocklist and BullMQ job state |
| Docker Socket Proxy | `tecnativa/docker-socket-proxy` | Restricted Docker API access for Execution Service |
| Frontend | Custom (Nginx) | React dashboard SPA |

## Shared Packages

| Package | Purpose |
|---------|---------|
| `@oneplatform/core` | DB clients, auth middleware, queue helpers, shared types, logging/tracing, OTEL instrumentation, error handling, config loader, health checks, encryption utilities, rate limit helpers |
| `@oneplatform/sdk` | External app SDK — connect to OnePlatform from outside. Auto-generated from OpenAPI spec. Handles auth, real-time subscriptions, ontology-typed data access. |
| `@oneplatform/app-sdk` | Platform app SDK — for apps built inside OnePlatform. Extends SDK with platform-specific APIs (user context, app storage, inter-app comms). |
| `@oneplatform/plugin-sdk` | Plugin development SDK — interfaces (Connector, Transformer, Destination, AuthProvider, Widget), hook registration, local dev server. |
| `@oneplatform/cli` | CLI tool (`op`) — wraps REST API for all operations. JSON + table output. Auth via API key or interactive login. |

## Monorepo Structure

```
oneplatform/
├── packages/
│   ├── core/                  # @oneplatform/core — shared engine library
│   ├── sdk/                   # @oneplatform/sdk — external app SDK (auto-generated)
│   ├── app-sdk/               # @oneplatform/app-sdk — platform app SDK
│   ├── plugin-sdk/            # @oneplatform/plugin-sdk — plugin development
│   └── cli/                   # @oneplatform/cli — CLI tool (op)
├── services/
│   ├── gateway/               # API Gateway + rate limiting
│   ├── auth/                  # Auth & RBAC
│   ├── ingestion/             # Data ingestion + credential vault
│   ├── ontology/              # Schema & mapping engine + code generation
│   ├── pipeline/              # Workflow orchestration
│   ├── execution/             # Code sandbox (isolated-vm + Docker)
│   ├── app/                   # App hosting & runtime
│   ├── logging/               # Logs, metrics, audit
│   └── plugin/                # Plugin lifecycle & hooks
├── frontend/                  # React dashboard (from websitetemplate)
├── docker/
│   ├── Dockerfile.service     # Multi-stage build for all services
│   ├── Dockerfile.sandbox     # Low-privilege isolated-vm container
│   ├── Dockerfile.frontend    # Nginx + React build
│   └── docker-compose.yml     # Full stack orchestration
├── docs/
│   ├── decisions/             # Architecture Decision Records
│   └── generated/             # Auto-generated API, SDK, CLI, ontology docs
├── turbo.json                 # Turborepo config
├── pnpm-workspace.yaml
└── package.json
```

## Tech Stack Summary

| Layer | Technology | License |
|-------|-----------|---------|
| Frontend | React 18, TypeScript, Tailwind v4, shadcn/ui | MIT |
| Backend Framework | Hono | MIT |
| Database | PostgreSQL 16 | PostgreSQL License (permissive) |
| Connection Pooler | PgBouncer | ISC (permissive) |
| Cache/Queue | Redis 7 + BullMQ | BSD-3 / MIT |
| JS Sandbox | isolated-vm | MIT |
| Container Sandbox | Docker Engine API + tecnativa/docker-socket-proxy | Apache 2.0 / MIT |
| Auth | Custom + Passport.js (OAuth) | MIT |
| Encryption | Node.js crypto (AES-256-GCM, HKDF-SHA256) | Built-in |
| Real-time | SSE + ws (WebSocket) | MIT |
| Testing | Vitest, Playwright, Supertest | MIT |
| Monorepo | Turborepo + pnpm workspaces | MIT |
| Containerization | Docker, Docker Compose | Apache 2.0 |
| Tracing | OpenTelemetry SDK | Apache 2.0 |
| Metrics | Prometheus (optional) | Apache 2.0 |
| Trace Viewer | Jaeger (optional) | Apache 2.0 |
| API Docs | Scalar or Stoplight Elements | MIT |
| SDK Docs | TypeDoc | MIT |
| OpenAPI | Generated from Hono + Zod | N/A (generated) |
| CLI | Commander.js | MIT |

All dependencies are MIT/Apache/BSD/ISC/permissive — safe for commercial use under BSL.

### 18. Redis Resilience
**Decision:** Redis is configured for persistence and graceful degradation. For production deployments, Redis Sentinel or a replica is documented as the recommended setup.

**Rationale:** Redis serves 5 critical functions: BullMQ job queues, JWT revocation blocklist, refresh token storage, ontology pub/sub invalidation, and async log delivery. A Redis failure without mitigation would cascade across the entire platform — pipelines halt, auth degrades, schemas go stale, and audit events are lost. This is the single most critical infrastructure dependency after Postgres.

**Implementation:**
- **Persistence (always-on):** Redis is configured with `appendonly yes` and `appendfsync everysec` in Docker Compose — AOF persistence ensures job state and the revocation blocklist survive restarts with at most 1 second of data loss
- **Graceful degradation per concern:**
  - BullMQ queues: if Redis is down, producers buffer up to 100 jobs in-memory and retry connection every 2s; pipeline status shows "queuing paused" in the UI. **Data loss mitigation:** each producer service writes a WAL (write-ahead log) to its own per-service data volume (`/data/job-buffer.wal`, max 50MB per service). Each service has its own WAL file on its own volume — no shared WAL files between services. WAL format: each record is a length-prefixed JSON blob with a CRC32 checksum trailer. On replay, records with invalid checksums or truncated length prefixes are skipped and logged as warnings (they represent crash-mid-write corruption). Skipped records are counted; if >10% of WAL records are corrupt, an alert is raised. The WAL is replayed into Redis when connectivity is restored, then truncated. Producer services that write WALs: Gateway (webhook ingestion jobs), Ingestion Service (data pull jobs), Pipeline Service (pipeline execution jobs).
  - JWT revocation blocklist: if Redis is unreachable, auth middleware falls back to rejecting all requests with expired refresh tokens (fail-closed) and allowing access tokens until their 15-min expiry — conservative but safe
  - Refresh tokens: if Redis is down, new logins fail (cannot store refresh token) but existing access tokens continue working until expiry
  - Ontology pub/sub: consumers fall back to polling the Ontology Service every 15s (configurable via `OP_ONTOLOGY_POLL_INTERVAL`, default 15s) instead of relying on pub/sub notifications. **Thundering herd prevention:** each consumer adds a random jitter of 0-5s to its poll interval (so 5 consumers poll at 15-20s intervals, spread out rather than synchronized). Additionally, the Ontology Service implements a polling endpoint with ETag/If-None-Match — if the schema hasn't changed, it returns 304 Not Modified with near-zero cost. A circuit breaker trips if the Ontology Service returns errors 3 times consecutively, backing off to 60s polls until it recovers.
  - Log delivery: the @oneplatform/core log helper buffers up to 10,000 events in-memory and flushes when Redis reconnects; audit events are additionally written to a local fallback file (max 100MB, rotated to `.1` suffix at cap — oldest rotated file is deleted) that the Logging Service picks up on recovery
- **Production recommendation:** Docker Compose includes a commented-out Redis Sentinel configuration (1 master + 2 replicas) that users can enable for high availability; the architecture guide documents when and why to enable it
- **Health monitoring:** the Gateway Service health check includes Redis connectivity; if Redis is unreachable for >30s, the health endpoint returns degraded status, allowing external load balancers or monitoring to alert

### 19. Service-to-Service Authentication
**Decision:** All inter-service communication is authenticated using mutual TLS (mTLS) or shared service tokens. No service trusts another service based solely on network proximity.

**Rationale:** In a microservices architecture, any container on the Docker network can reach any other container. A compromised sandbox container, a malicious plugin, or a misconfigured service could call the Auth Service to issue tokens or the Ingestion Service to read credentials. Network adjacency is not trust.

**Implementation:**
- **Service tokens (asymmetric, Ed25519):** each service generates an Ed25519 keypair at first startup. The private key is stored in a Docker volume (`/data/service.key`) and used to sign service-level JWTs. The public key is published to a shared volume (`/data/service-keys/{service-name}.pub`) mounted read-only by all other services. This token contains the service name and a `role: "service"` claim. Services include this token in all inter-service requests via the `X-Service-Token` header.
- **True per-service isolation:** verifying services only hold public keys — they can verify tokens but cannot forge them. If a service's container is compromised, the attacker can forge tokens for THAT service only (they have its private key) but cannot impersonate any other service (they only have other services' public keys). This is the key asymmetric advantage over shared HMAC secrets.
- **Private key protection:** each service's private key (`/data/service.key`) is stored on a per-service named volume that is NOT shared with any other service (e.g., `gateway-data:/data` is mounted ONLY on the Gateway container). In Docker Compose, each service has its own dedicated data volume — no two services share a data volume. For additional hardening in production: (1) use Docker secrets (`docker secret create`) to inject private keys instead of volume files, (2) or mount the key from a tmpfs-backed volume that only persists in memory.
- **Key rotation:** `op service rotate-keys --service pipeline` generates a new keypair, publishes the new public key, and gracefully restarts the service. Other services hot-reload the public key directory (via inotify watch) and accept both old and new public keys for a 5-minute overlap window before dropping the old key.
- **CRITICAL SECURITY NOTE (key volume protection):** the shared public key volume (`/data/service-keys/`) is the trust anchor for all inter-service authentication. If an attacker gains host-level write access to this volume, they can inject a malicious public key and impersonate any service. This volume MUST have the same protection level as `OP_MASTER_KEY`: (1) restrict volume directory permissions to root/docker group only, (2) in production, consider using Docker secrets or a mounted read-only volume from a trusted source, (3) monitor the volume for unexpected file changes via the Logging Service file integrity alerts.
- **Validation:** the auth middleware in @oneplatform/core validates `X-Service-Token` on every request. Requests without a valid service token from within the Docker network are rejected with 403. The Gateway is the ONLY service that accepts external (user) requests without a service token.
- **Service RBAC (enforcement at the receiving service):** each service has a defined set of endpoints it's allowed to call on other services. The permission matrix is defined in `@oneplatform/core/service-rbac.ts` as a static map: `{callerService: {targetService: [allowedEndpoints]}}`. **Enforcement:** every receiving service's auth middleware (provided by @oneplatform/core) performs TWO checks on every incoming inter-service request: (1) validate the `X-Service-Token` JWT signature to prove caller identity, (2) look up the caller's service name in the permission matrix and verify the requested endpoint is in its allowed list. If the endpoint is not allowed, the request is rejected with `403 Forbidden` and an audit event is logged. The permission matrix is compiled into the core library at build time — it is not a config file that can be modified at runtime. Changes to service permissions require a code change in core, a rebuild, and a redeploy. This makes the matrix enforceable, auditable, and immune to runtime tampering.
- **Matrix contents:** Pipeline can call `Execution.execute()`, `Ontology.getSchema()`, `Plugin.getHooks()`; Ingestion can call `Ontology.mapData()`, `Pipeline.trigger()`; App can call `Ontology.getSchema()`, `Auth.validateToken()`, `Pipeline.trigger()`, `Execution.execute()`, `Logging.query()`; Gateway can call ALL services (it's the entry point); Logging has NO outbound inter-service calls (it only receives). Full matrix is in `@oneplatform/core/service-rbac.ts`.
- **Sandbox containers:** the `op-sandbox-vm` container and Docker sandbox containers are on the `oneplatform-sandbox` network, which has NO access to the internal service network (`oneplatform-internal`). They can only communicate with the Execution Service via the Unix socket (sandbox-vm) or the outbound proxy (Docker containers). Lateral movement to other services is network-impossible.
- **Docker network topology:**
  - `oneplatform-internal`: all 9 services + PgBouncer + Redis (services talk to each other here)
  - `oneplatform-sandbox`: Execution Service + sandbox-vm + Docker sandbox containers (isolated from internal)
  - `oneplatform-public`: Gateway + Frontend (exposed to external traffic)
  - The Execution Service is on BOTH `internal` and `sandbox` networks — it's the bridge. No other service touches the sandbox network.

### 20. Rate Limiting
**Decision:** The Gateway Service implements multi-tier rate limiting using Redis-backed sliding window counters. Rate limits are enforced at three levels: global, per-tenant, and per-API-key.

**Rationale:** OnePlatform exposes webhook ingestion endpoints and auto-generated REST APIs to the public internet. Without rate limiting, a single misbehaving client can exhaust resources for all tenants.

**Implementation:**
- **Global rate limit:** 10,000 requests/minute across the entire platform (configurable via `OP_GLOBAL_RATE_LIMIT`). Protects against DDoS. Returns HTTP 429 with `Retry-After` header.
- **Per-tenant rate limit:** 1,000 requests/minute per tenant (configurable per-tier in the Auth Service). Prevents one tenant from starving others.
- **Per-API-key rate limit:** 500 requests/minute per API key (configurable per key at creation time). Allows fine-grained control for machine clients.
- **Webhook ingestion rate limit:** 100 requests/second per webhook endpoint (separate from API rate limits, since webhooks are often bursty)
- **Rate limit headers:** all responses include `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` headers
- **Storage:** sliding window counters in Redis DB 4 (general caching). Counter keys expire automatically.
- **Redis outage behavior:** rate limiting falls back to LOCAL in-memory sliding window counters per Gateway instance. The fallback limit per instance is calculated as `floor(normal_limit / replica_count)`. Replica count is determined by a 3-tier strategy: (1) **Primary:** Redis key `gateway:replicas` (incremented on startup, decremented on shutdown) — accurate during normal operation. (2) **Cached:** on Redis outage, the last-known count is cached in memory from the most recent successful read. (3) **Mandatory env var:** `OP_GATEWAY_REPLICAS` is **REQUIRED** in Docker Compose for any multi-replica deployment (the compose template generates this automatically from the `deploy.replicas` field). For single-instance deployments, the default of 1 is correct and no env var is needed. The startup sequence validates: if Redis is unreachable AND `OP_GATEWAY_REPLICAS` is unset AND no cached value exists, the Gateway logs a **CRITICAL** warning and applies a hard-coded conservative limit of 100 req/min globally (safe default that prevents both no-limit and full-block). This ensures the rate limit is never silently a no-op during cold-start-under-outage scenarios.
- **Burst allowance:** each limit allows a 2x burst for 5 seconds to handle legitimate traffic spikes

### 21. Observability Stack
**Decision:** OpenTelemetry (OTEL) is the standard for distributed tracing and metrics. All services are instrumented with OTEL SDK. Traces and metrics are exported to a configurable backend (default: Prometheus for metrics, Jaeger for traces, both optional).

**Rationale:** A 9-service system is impossible to debug in production without distributed tracing and metrics. Logs alone are insufficient — you need to trace a request across service boundaries and correlate it with resource metrics.

**Implementation:**
- **Tracing:** every inbound request to the Gateway generates a trace ID (W3C Trace Context format). The trace ID propagates through all inter-service communication (Redis queue job metadata, pub/sub message headers). Each service creates spans for its operations. Trace data is exported via OTLP to a configurable endpoint.
- **Metrics:** each service exports standard metrics via OTEL: request latency (p50/p95/p99), request count by status code, queue depth, active connections, memory/CPU usage, pipeline execution duration, sandbox execution time. Metrics are exposed on a `/metrics` endpoint (Prometheus-compatible) on each service.
- **Default stack (Docker Compose):** includes optional Prometheus (`prom/prometheus:v2.53.0`, Apache 2.0) and Jaeger (`jaegertracing/all-in-one:1.58`, Apache 2.0) containers pinned to specific versions, commented-out by default. Users enable with `docker compose --profile observability up`. Version pins prevent silent breaking upgrades on `docker compose pull`.
- **@oneplatform/core integration:** the core library auto-instruments all Hono routes, BullMQ workers, and Redis/Postgres clients with OTEL spans. Services get tracing for free by importing core — zero per-service instrumentation code needed.
- **OTEL Collector:** for production deployments, an optional OTEL Collector (`otel/opentelemetry-collector-contrib:0.104.0`, Apache 2.0) is included in Docker Compose (under the `observability` profile). It buffers, batches, and retries trace/metric exports — so individual services don't hold export state and backends can be swapped without service restarts. In dev mode, services export directly to Jaeger for simplicity.
- **Frontend:** the dashboard includes a basic trace viewer (search by trace ID, see the full service call chain) and a metrics dashboard (queue depths, error rates, pipeline throughput) backed by the Logging Service query API. Full Grafana-level dashboards available by connecting the optional Prometheus/Jaeger endpoints.
- **Correlation:** the existing `traceId` in log events (Decision #17) IS the OTEL trace ID — logs, traces, and metrics all share the same correlation identifier

### 22. SDK, CLI, and API as First-Class Citizens
**Decision:** The platform is API-first. Every operation available in the UI is available via the REST API. The CLI and SDKs are thin wrappers around the API. All three (API, CLI, SDKs) are first-class, fully documented, and tested as rigorously as the services themselves.

**Rationale:** An integration platform must be programmable. If users can only interact through the UI, the platform fails its core purpose. The API is the product; the UI is one client of many.

**Implementation:**
- **REST API:** the Gateway exposes a fully documented REST API. Every endpoint is auto-documented via OpenAPI 3.1 spec generated from Hono route definitions + Zod schemas. The spec is always in sync with the actual code — it's generated, not manually maintained.
- **CLI (`@oneplatform/cli`):** a Node.js CLI tool (`npx @oneplatform/cli` or `op` when installed globally) that wraps the REST API. Covers all operations: manage ontologies, trigger pipelines, deploy apps, view logs, manage users/roles, import/export configurations. Supports JSON and table output formats. Auth via API key or interactive login.
- **SDKs:**
  - `@oneplatform/sdk` — TypeScript/JavaScript SDK for external apps. Handles auth, real-time subscriptions (SSE/WS), ontology-typed data access, pipeline triggers. Works in Node.js and browsers. **Browser security:** browser clients NEVER receive raw API keys. Browser apps authenticate via OAuth flow (authorization code + PKCE) and receive short-lived access tokens. The SDK detects the browser environment and automatically uses the OAuth flow instead of API key auth. For platform-hosted apps, the App Service acts as a BFF (backend-for-frontend) — the browser app calls the App Service, which calls internal APIs with service tokens. API keys are server-side only.
  - `@oneplatform/app-sdk` — SDK for apps built inside the platform. Same as above plus platform-specific APIs: access to the current user, app storage, inter-app communication, UI component library bindings.
  - `@oneplatform/plugin-sdk` — SDK for plugin developers. Provides interfaces (`Connector`, `Transformer`, `Destination`, `AuthProvider`, `Widget`), hook registration helpers, and a local development server for testing plugins.
- **API versioning:** the API is versioned via URL prefix (`/api/v1/...`). Breaking changes increment the version. Old versions are supported for 6 months after deprecation.
- **SDK generation:** SDK methods are auto-generated from the OpenAPI spec using a code generator that produces fully-typed TypeScript. When a new API endpoint is added, the SDK updates automatically.

### 23. Auto-Generated Documentation
**Decision:** All documentation is generated from the actual codebase and kept in sync automatically. There is no separately-maintained documentation that can drift from reality.

**Rationale:** Documentation that drifts from code is worse than no documentation — it actively misleads. In a platform with auto-generated APIs, types, and SDKs, the documentation must be generated from the same source of truth.

**Implementation:**
- **API docs:** generated from OpenAPI 3.1 spec (which itself is generated from Hono routes + Zod schemas). Rendered as an interactive API explorer in the platform UI (using Scalar or Stoplight Elements, both MIT-licensed). Hosted at `/docs/api`.
- **SDK docs:** generated from TypeScript source using TypeDoc (MIT). Published alongside the npm packages and embedded in the platform UI at `/docs/sdk`.
- **Ontology docs:** when a user defines an ontology, the platform auto-generates documentation for their specific data model — entity descriptions, field types, relationships, permission rules, API endpoints for that entity. Accessible per-tenant at `/docs/ontology`.
- **CLI docs:** generated from the CLI command definitions (each command has a description, arguments, examples). Rendered as a man-page-style reference at `/docs/cli` and available via `op --help`.
- **Architecture docs:** the ADR (this document) and design specs are committed to `docs/` in the repo and rendered in the platform UI at `/docs/architecture`.
- **Doc generation pipeline:** a Turborepo task (`turbo run docs:generate`) regenerates all documentation. This runs as part of CI — if a code change would cause a doc drift, the CI check fails. Docs are built artifacts, not manually written files.
- **Versioning:** docs are versioned alongside the API (`/docs/api/v1`, `/docs/api/v2`). Users can view docs for their current API version.

---

### 24. First-Run Experience and Bootstrap

**Decision:** The platform resolves the bootstrap problem — creating the first admin user when no users exist, and generating the master encryption key before any service that needs it starts — through a dedicated `op-init` container that runs to completion before all other services, combined with a single-use `POST /api/v1/auth/bootstrap` endpoint and a setup wizard served at the platform root URL on first access.

**Rationale:** The first-run experience is a critical gap. Without it, `docker compose up` produces 9 running services but no clear entry point, no admin user, and no `OP_MASTER_KEY`. Two problems must be solved in order: (1) the master encryption key must exist before the Ingestion Service (and any other service using AES-256-GCM) starts; (2) the first admin user must be created before the regular auth endpoints are reachable, because regular auth requires an existing user. A dedicated init container solves (1) by running first via Docker Compose `depends_on` + `condition: service_completed_successfully`. Problem (2) is solved by a hardened bootstrap endpoint that only accepts the first call, auto-disables itself, and is protected by the init token generated during init. The entire flow is deterministic, secure, and requires no prior knowledge from the operator.

**Implementation:**

**Init container (`op-init`):**
- A one-shot container (`restart: no`) that runs before all platform services. It performs exactly three operations in order:
  1. **Key generation:** checks whether the Docker-managed secret `op_master_key` already exists (via the secrets volume at `/run/secrets/op_master_key`). If absent, generates `openssl rand -base64 32` and writes to a shared Docker volume at `/data/init/master.key` (permissions `0400`, owned by uid 1000). Services read from this path via a read-only volume mount.
  2. **Bootstrap token generation:** generates a single-use `bootstrap_token` (`openssl rand -hex 32`), writes it to `/data/init/bootstrap.token` (permissions `0400`). This token is required to call `POST /api/v1/auth/bootstrap`. It is a one-time secret: the Auth Service reads it once at startup, holds it in memory (not Postgres), and erases `/data/init/bootstrap.token` immediately after reading. After the bootstrap endpoint is used, the in-memory token is nulled and the endpoint permanently disabled.
  3. **Readiness signal:** writes `/data/init/ready` (empty file) to signal completion.
- The init container exits with code 0 on success, non-zero on any failure. Other services will not start if the init container fails (Docker Compose `condition: service_completed_successfully`).
- The init container image is a minimal Alpine with `openssl` only — no Node.js, no application code, no network access. Its attack surface is the smallest possible.

**Docker Compose startup ordering (complete dependency chain):**
```yaml
op-init:
  image: alpine:3.19
  restart: "no"
  command: ["/bin/sh", "/scripts/init.sh"]
  volumes: [init-data:/data/init]
  healthcheck: { test: ["CMD", "test", "-f", "/data/init/ready"], interval: 2s, retries: 15 }

postgres:
  depends_on:
    op-init: { condition: service_completed_successfully }
  healthcheck: { test: ["CMD-SHELL", "pg_isready -U op"], interval: 5s, retries: 10 }

redis:
  depends_on:
    op-init: { condition: service_completed_successfully }
  healthcheck: { test: ["CMD", "redis-cli", "ping"], interval: 5s, retries: 10 }

auth-service:
  depends_on:
    postgres: { condition: service_healthy }
    redis: { condition: service_healthy }
  volumes: [init-data:/data/init:ro]

ingestion-service:
  depends_on:
    postgres: { condition: service_healthy }
    auth-service: { condition: service_healthy }
  volumes: [init-data:/data/init:ro]

# All other services depend on postgres+redis healthy; services that call auth
# also depend on auth-service healthy. Gateway depends on all 9 services healthy.
gateway-service:
  depends_on:
    auth-service: { condition: service_healthy }
    ontology-service: { condition: service_healthy }
    # ... all other services
```
- Services read `OP_MASTER_KEY` from `/data/init/master.key` via `@oneplatform/core`'s `loadMasterKey()` helper. In production, operators replace the init-volume mechanism with Docker Secrets (`docker secret create op_master_key`) and services read from `/run/secrets/op_master_key` instead — the same helper supports both paths, checked in order.

**Bootstrap endpoint (`POST /api/v1/auth/bootstrap`):**
- Accepts: `{ adminEmail: string, adminPassword: string, tenantName: string, bootstrapToken: string }`
- The Auth Service validates `bootstrapToken` against the in-memory value read from `/data/init/bootstrap.token` at startup. Constant-time comparison (`crypto.timingSafeEqual`) to prevent timing attacks.
- On success: creates the first tenant row in `auth.tenants`; creates the first admin user in `auth.users` with role `platform_admin`; issues a session for the admin; returns `{ data: { tenantId, adminUserId, sessionToken } }`.
- After first use: the in-memory `bootstrapToken` is zeroed; the endpoint handler checks a Postgres flag `auth.bootstrap_completed = true` and returns `410 Gone` on all subsequent calls. **The flag is set in the same database transaction as user creation** — there is no window between user creation and flag set.
- Rate limit: 3 attempts per 10 minutes per IP (independent of standard rate limiting), enforced in the Auth Service itself without Redis (in-memory sliding window per process). This prevents brute-forcing the bootstrap token before the admin configures rate limiting.
- **Re-bootstrap scenario:** if an operator needs to reset the platform (e.g., corrupted admin), they run `op service reset-bootstrap` (admin CLI command) which: requires direct database access to confirm intent, deletes all users and tenants, regenerates the bootstrap token, and restarts the auth service. This is a destructive operation and documented as such.

**Setup wizard flow:**
- The Frontend (Nginx container) detects whether bootstrap has been completed by calling `GET /api/v1/auth/bootstrap/status` (public endpoint, returns `{ completed: boolean }`).
- If `completed: false`, the frontend renders the setup wizard instead of the login page at the root URL.
- **Wizard screens (in order):**
  1. **Welcome screen:** platform name, version, "Let's get started." Single "Begin Setup" button.
  2. **Admin account:** email + password + confirm password. Password policy shown inline (min 12 chars, 1 uppercase, 1 number, 1 symbol). Email validation client-side.
  3. **Organization name:** `tenantName` input. Explains this is the name of the first workspace.
  4. **Master key confirmation:** displays the generated `OP_MASTER_KEY` value in a read-only field with a copy button. Shows the security warning from Decision #11 verbatim. Checkbox: "I have saved this key securely." Blocks progression until checked.
  5. **Review and create:** summary of inputs, "Create Platform" button. POST to `/api/v1/auth/bootstrap`.
  6. **Success screen:** "Platform ready. Your admin account is active." Link to dashboard. Shows first login instructions.
- After wizard completion, `GET /api/v1/auth/bootstrap/status` returns `{ completed: true }` and all subsequent visits to the root URL render the normal login page.

**URL after `docker compose up`:**
- Default: `http://localhost:3000`. The Gateway listens on port 3000 (host-mapped). If `OP_BASE_URL` is set, the wizard uses it for generated callback URLs and the success screen link.
- The setup wizard is served by the Frontend container (Nginx). The Gateway proxies `/*` to the frontend for all non-API paths. No special routing is needed.

**Service readiness coordination:**
- Every service exposes `GET /healthz` (liveness — "am I alive?") and `GET /readyz` (readiness — "am I ready to accept traffic?"). Per Decision #29 (API Contract Standard). Docker Compose health checks call `/healthz` since Docker's health model is liveness-based; the Gateway waits for `/readyz` on its downstream services before accepting external traffic, using a startup probe loop in the Gateway's own startup sequence.
- **Startup timeout:** if any service fails to become healthy within 120s, Docker Compose marks it as failed and dependent services do not start. The operator sees the failed container log output directly. No silent partial-startup states.

**Security considerations:**
- The bootstrap token is single-use, short-lived (erased from disk immediately by the Auth Service at startup), and never logged or included in error responses.
- `/data/init/master.key` is `chmod 0400` and only readable by the service UID. Operators are warned in documentation that the Docker volume backing `/data/init` must be protected with the same care as the `.env` file (Decision #11).
- The bootstrap endpoint is not listed in the OpenAPI spec served at `/api/v1/openapi.json` after `bootstrap_completed = true`. It does not appear in the interactive API docs. This reduces its surface area for exploration attacks.

---

### 25. App Platform Design

**Decision:** User apps are stored as versioned source-file trees in MinIO (S3-compatible object storage, MIT), built by esbuild running inside the Execution Service sandbox (because user app code is untrusted), and served as static bundles by the App Service. The in-browser editor uses Monaco Editor (MIT, VS Code engine). Build artifacts are versioned in MinIO and linked from Postgres; rollback is a pointer change to a prior version ID. Hot-reload preview uses esbuild incremental compilation feeding an iframe. External IDE support is provided by `op app dev --app <slug>`.

**Rationale:** App code is user-supplied and potentially malicious. Building it in the main App Service process would allow arbitrary code execution during the build step. Running esbuild inside the Execution Service sandbox (the same sandbox already hardened for user pipeline code) eliminates this risk. MinIO is added to Docker Compose (MIT license, S3-compatible) to provide object storage for build artifacts and file uploads without a cloud dependency. Monaco Editor is chosen for the in-browser editor because it is the same engine as VS Code (MIT, maintained by Microsoft), supports TypeScript intellisense, and has a React wrapper (`@monaco-editor/react`, MIT) for easy integration. Rollback via pointer change is the simplest correct design: no data is ever deleted, and reverting is an O(1) metadata update.

**Implementation:**

**MinIO addition to Docker Compose:**
```yaml
minio:
  image: minio/minio:RELEASE.2024-06-13T22-53-53Z  # pinned version
  command: server /data --console-address ":9001"
  environment:
    MINIO_ROOT_USER: ${OP_MINIO_ACCESS_KEY}
    MINIO_ROOT_PASSWORD: ${OP_MINIO_SECRET_KEY}
  volumes: [minio-data:/data]
  healthcheck:
    test: ["CMD", "mc", "ready", "local"]
    interval: 10s
    retries: 5
  networks: [oneplatform-internal]
  # NOT on oneplatform-public — MinIO console is internal-only
```
- Two buckets created on first platform startup by the `op-init` script: `op-app-artifacts` (build outputs) and `op-uploads` (user file uploads via ingestion). Bucket policies: private, accessible only via presigned URLs or service tokens. MinIO is not exposed to the public internet.
- The App Service and Ingestion Service communicate with MinIO via the AWS SDK v3 for JavaScript (`@aws-sdk/client-s3`, Apache 2.0) using the MinIO endpoint URL. No MinIO-specific SDK is needed.

**App code storage (virtual file system):**
- Each app has a source file tree stored in Postgres in the `app.files` table: `{ app_id, path, content (text), content_hash (sha256), updated_at, updated_by }`. The path is a normalized POSIX path (e.g., `/src/App.tsx`, `/src/components/Chart.tsx`, `/package.json`).
- This virtual file system (VFS) is managed entirely by the App Service. The in-browser editor and the `op app dev` CLI both read/write through the App Service VFS API (`GET /api/v1/apps/{id}/files/{path}`, `PUT /api/v1/apps/{id}/files/{path}`, `DELETE /api/v1/apps/{id}/files/{path}`, `GET /api/v1/apps/{id}/files` for directory listing).
- App source files are stored in Postgres (not MinIO) because they are small text files that benefit from transactional updates and are queried frequently by the editor. MinIO stores only build artifacts (compiled bundles, typically 50KB–5MB gzipped).

**Build pipeline:**
- Trigger: `POST /api/v1/apps/{id}/builds` (or automatically on each save in preview mode).
- The App Service assembles all source files from the VFS into a temporary in-memory archive and submits a build job to the Execution Service with `executionType: "app-build"`.
- The Execution Service runs esbuild in the `op-sandbox-vm` container. The build context is passed via the existing Unix socket protocol as a JSON-encoded file map: `{ method: "app-build", files: { "/src/App.tsx": "...", ... }, entrypoint: "/src/index.tsx", target: "es2020", format: "esm" }`. The sandbox runs `esbuild.build()` using the `esbuild` npm package (MIT) bundled into the sandbox image.
- **Why esbuild in sandbox:** during the build, esbuild evaluates module resolution. A malicious `package.json` or custom resolver could be crafted to exfiltrate files or make network requests during the build step. Running inside the existing sandbox (no network, read-only filesystem, resource limits) prevents this.
- **Allowed imports:** the sandbox image pre-bundles `react`, `react-dom`, `@oneplatform/app-sdk`, `@oneplatform/core` (UI utilities only), and `recharts` (charting). User code may import any of these. Imports of other modules result in a build error (`ExternalModuleNotAllowedError`) with a clear message listing available packages. The allowed module list is configurable per-tenant by platform admin via `app.allowed_modules` config.
- **Build output:** a single ESM bundle (`bundle.js`) + source map (`bundle.js.map`) + a manifest (`build-manifest.json`: `{ buildId, appId, entrypoint, bundleSizeBytes, buildDurationMs, externalDependencies[] }`). These three files are uploaded to MinIO at `op-app-artifacts/{tenantId}/{appId}/builds/{buildId}/`.
- Build duration target: < 3 seconds for a typical 500-line app. esbuild is fast enough; the sandbox startup is the dominant cost (~200ms on first use, ~10ms subsequent with warm sandbox).
- Build logs are streamed back to the browser via SSE (`GET /api/v1/apps/{id}/builds/{buildId}/logs/stream`).

**Build artifact versioning and rollback:**
- Each build creates a row in `app.builds`: `{ id (uuid), app_id, version_number (integer, auto-increment per app), status (pending|building|success|failed), bundle_path (MinIO key), build_manifest (JSONB), built_at, built_by }`.
- The `app.apps` table has a `current_build_id` foreign key pointing to the active build.
- **Rollback:** `POST /api/v1/apps/{id}/rollback` with body `{ buildId: string }` — the App Service updates `current_build_id` to the specified prior build ID. This is an atomic Postgres UPDATE. Zero downtime: the App Service reads `current_build_id` on each request; the next request after the UPDATE serves the prior bundle. No rebuild needed.
- Old build artifacts are retained in MinIO indefinitely until the user explicitly purges them (`DELETE /api/v1/apps/{id}/builds/{buildId}`, only allowed for non-current builds). A platform-wide retention policy (configurable, default: keep last 20 builds per app) is enforced by a background cleanup job in the App Service running every 24 hours.
- **Build failure isolation:** if the build fails (esbuild error, timeout, sandbox crash), the `app.builds` row is marked `failed` with the error message. `current_build_id` is NOT changed. The app continues serving the last successful build. Build errors are surfaced in the editor as an inline error panel.

**In-browser editor (Monaco Editor):**
- Component: `@monaco-editor/react` v4+ (MIT). Rendered in the frontend as a full-height split-pane layout: file tree (left), editor (center), preview iframe (right).
- **TypeScript intellisense:** the App Service generates a `tsconfig.json` and type declaration files for the app's available imports (`react`, `react-dom`, `@oneplatform/app-sdk` types) and injects them into Monaco's `monaco.languages.typescript.typescriptDefaults.addExtraLib()`. This gives the editor full type checking and autocompletion without a TypeScript server process.
- **Ontology-typed completions:** the Ontology Service's code generation (Decision #14) produces TypeScript interfaces for all tenant entities. These interfaces are injected into Monaco as extra libs, giving app developers typed access to `useQuery<Customer>()`, `useMutation<Order>()`, etc.
- **File operations:** every editor save triggers a `PUT /api/v1/apps/{id}/files/{path}` call to the App Service (debounced 500ms). File creation/deletion/rename go through the VFS API. The file tree panel is driven by `GET /api/v1/apps/{id}/files`.
- **Diff view:** clicking any file in the build history shows a Monaco diff view between the current file and the file content at that build time.

**Hot-reload preview:**
- The preview pane is an `<iframe src="/apps/{slug}/preview">` rendered in the editor layout.
- **Preview mode:** the App Service has a `preview` serving mode separate from `production`. In preview mode, the bundle is served from the latest build (including in-progress incremental builds), not `current_build_id`. This means the developer sees their unsaved/unbundled changes in near-real-time.
- **Incremental compilation:** after the first full build, subsequent builds triggered by saves use esbuild's incremental API (`esbuild.context()` with `rebuild()`). The context is held in the sandbox between builds, reducing rebuild time from ~3s to ~200ms for incremental changes. The context is invalidated when the sandbox is recycled.
- **Iframe refresh:** when a new incremental build completes, the App Service sends an SSE event to the preview iframe (`event: reload, data: { buildId }`). The iframe listens for this event and calls `window.location.reload()`. No WebSocket needed — SSE is sufficient and simpler.
- **Preview isolation:** the preview iframe origin is `http://localhost:3000/apps/{slug}/preview`. It is served with `Content-Security-Policy: frame-ancestors 'self'` to prevent embedding outside the platform. Preview data uses real tenant data (not mocked) because apps need to display realistic content during development. Preview sessions use the developer's own session credentials.

**External IDE support (`op app dev`):**
- `op app dev --app <slug>` starts a local development server on `http://localhost:4000` (configurable via `--port`).
- The CLI syncs files bidirectionally: local filesystem changes are `PUT` to the App Service VFS; remote VFS changes (e.g., from another team member) are pulled and written locally. Sync is file-hash-based (no diff needed — full content per file).
- The local dev server proxies all `@oneplatform/app-sdk` calls to the platform (configured via `OP_PLATFORM_URL` env var or `--platform-url` flag). This means the developer's app runs locally but data comes from the real platform.
- **Conflict resolution:** if the same file is modified locally AND remotely between sync cycles, the CLI surfaces a conflict prompt (or uses `--prefer-local` / `--prefer-remote` flags for non-interactive mode). Conflicts are rare because the platform editor locks files per-session via an optimistic `file_version` integer on each VFS row.
- `op app dev` streams build logs from the platform to the terminal and opens the preview URL in the default browser.

**Auto-generated starter app from ontology:**
- When a user's ontology has at least one entity with at least one field, the App Service can generate a starter app: `POST /api/v1/apps/generate` with body `{ tenantId, appName, entityTypes: string[] }`.
- The Ontology Service provides entity metadata (fields, types, relationships) to the App Service. The App Service renders a template (stored in the App Service codebase, not in MinIO) by substituting entity names, field names, and types into a React component scaffold.
- **Generated starter includes:** (1) a data table component showing all records for each selected entity using `useQuery`; (2) a create/edit form with field inputs matching each entity's field types (string → text input, number → number input, boolean → toggle, enum → select); (3) basic routing (entity list → entity detail); (4) `useUser()` to show the current user in a header.
- The generated code is written to the app's VFS as editable source files — it is a starting point, not a locked template. The developer can edit everything in Monaco immediately after generation.
- **Non-expert path (Casey persona):** upload CSV → Ingestion Service auto-infers schema (Decision #28) → Ontology Service generates draft ontology → user reviews in a simplified "table view" mode (field names, types, toggle nullable) → confirm → `POST /api/v1/apps/generate` → starter app deployed in preview → developer edits or publishes as-is. Target: < 5 minutes from CSV upload to running app.

**App environment variables:**
- Apps may need runtime configuration (API keys for third-party services, feature flags). App environment variables are stored in `app.env_vars`: `{ app_id, key, value (AES-256-GCM encrypted using OP_MASTER_KEY), is_secret (boolean) }`.
- Secret env vars are never returned in API responses — only their key names are returned (value masked as `"***"`). Non-secret env vars are returned in plaintext.
- At build time, non-secret env vars are inlined into the bundle by esbuild's `define` option. Secret env vars are injected at runtime by the App Service BFF (not at build time) — they are passed to the app via a `GET /api/v1/apps/{id}/runtime-config` endpoint that the app-sdk calls during initialization, authenticated by the user's session cookie.

**Security considerations:**
- All app code (source files and build artifacts) is tenant-scoped. The App Service enforces tenant isolation on every VFS and MinIO operation by verifying the requesting user's `tenantId` against the app's `tenantId`.
- Build artifacts in MinIO have server-side encryption enabled (`SSE-S3` mode via MinIO's built-in AES-256 at rest). MinIO itself is not exposed to the public network.
- The Monaco editor does not execute user code in the browser during editing — code is only executed by the Execution Service sandbox when a build is triggered. There is no client-side `eval()` at any point in the app platform.

---

### 26. App-SDK and BFF Design

**Decision:** `@oneplatform/app-sdk` exposes a React hooks-based API that mirrors common data patterns (query, mutation, subscription, user context, permissions, app storage). The App Service acts as a Backend-for-Frontend (BFF), intercepting all SDK calls from the browser, forwarding them to the appropriate internal services with service tokens, and enforcing RBAC before forwarding. Authentication state is carried in httpOnly Secure SameSite=Strict cookies set exclusively by the App Service — the browser never holds a token in JavaScript-accessible storage.

**Rationale:** A React hooks API is the most natural surface for a code-first app platform — developers use the same patterns they already know from React Query and SWR. The BFF pattern is necessary for security: the browser cannot hold service tokens (they would be exposed via XSS), and internal services cannot be directly exposed to browser apps (they lack the CORS and session handling needed for browser clients, and exposing them directly would bypass service RBAC). Centralizing token and RBAC logic in the App Service BFF gives a single auditable enforcement point. httpOnly cookies are the correct browser token storage — they are immune to XSS token theft (the #1 browser authentication vulnerability).

**Implementation:**

**Complete `@oneplatform/app-sdk` API surface:**

```typescript
// Query — read data from an ontology entity
function useQuery<T = unknown>(
  entity: string,
  options?: QueryOptions
): QueryResult<T>

interface QueryOptions {
  filter?: Record<string, FilterValue>;   // { field: { eq: value } }
  sort?: string[];                         // ["name", "-createdAt"]
  fields?: string[];                       // field selection
  cursor?: string;                         // pagination cursor
  limit?: number;                          // default 50, max 100
  enabled?: boolean;                       // conditional fetch (default true)
  staleTime?: number;                      // ms before refetch (default 30_000)
  onError?: (error: AppSDKError) => void;
}

interface QueryResult<T> {
  data: T[] | null;
  pagination: { nextCursor: string | null; total: number } | null;
  isLoading: boolean;
  isError: boolean;
  error: AppSDKError | null;
  refetch: () => Promise<void>;
  fetchNextPage: () => Promise<void>;      // appends to data[]
}

// Mutation — create, update, or delete records
function useMutation<T = unknown>(
  entity: string
): MutationResult<T>

interface MutationResult<T> {
  create: (data: Partial<T>) => Promise<T>;
  update: (id: string, data: Partial<T>) => Promise<T>;
  replace: (id: string, data: T) => Promise<T>;
  remove: (id: string) => Promise<void>;
  bulkCreate: (items: Partial<T>[]) => Promise<BulkResult<T>>;
  isLoading: boolean;
  isError: boolean;
  error: AppSDKError | null;
}

// Subscription — real-time updates for an entity
function useSubscription<T = unknown>(
  entity: string,
  options?: SubscriptionOptions
): SubscriptionResult<T>

interface SubscriptionOptions {
  filter?: Record<string, FilterValue>;
  events?: Array<"created" | "updated" | "deleted">;  // default: all
  onEvent?: (event: EntityEvent<T>) => void;
}

interface SubscriptionResult<T> {
  lastEvent: EntityEvent<T> | null;
  isConnected: boolean;
  reconnectAttempts: number;
}

// User context — current authenticated user
function useUser(): UserContext

interface UserContext {
  id: string;
  email: string;
  displayName: string;
  tenantId: string;
  roles: string[];
  isGuest: boolean;
}

// Permission check — returns boolean synchronously from cached ontology
function usePermission(action: string, resource: string): boolean
// action: "create" | "read" | "update" | "delete" | "admin"
// resource: entity name or "*" for any

// App storage — per-app, per-user key-value store
function useAppStorage<T>(
  key: string,
  defaultValue: T
): [T, (value: T) => Promise<void>]
// Stored in app.user_storage: { app_id, user_id, key, value (JSONB) }
// Key max length: 128 chars. Value max size: 64KB.

// SDK provider (must wrap app root)
function AppProvider(props: {
  children: React.ReactNode;
  appId: string;          // injected by App Service at build time
  tenantId: string;       // injected by App Service at build time
}): JSX.Element
```

**Internal implementation of hooks:**
- All hooks call the App Service BFF endpoints (not internal services directly). The App Service proxies requests to the appropriate internal service using its service token.
- `useQuery` and `useMutation` call `GET|POST|PATCH|DELETE /bff/data/{entity}[/{id}]` on the App Service.
- `useSubscription` opens an SSE connection to `GET /bff/data/{entity}/subscribe` on the App Service (which in turn subscribes to the appropriate Redis pub/sub channel and fans out events to connected browsers).
- `useUser` reads from `GET /bff/me` on the App Service, which extracts user identity from the session cookie.
- `usePermission` is evaluated client-side against a cached permissions snapshot (`GET /bff/permissions`) fetched once at `AppProvider` mount and refreshed every 5 minutes. No network call per check.
- `useAppStorage` reads/writes `GET|PUT /bff/storage/{key}` on the App Service.
- All BFF calls include the session cookie automatically (same-origin, no explicit auth header needed).

**BFF mechanics (request flow):**
```
Browser App
  │  fetch("/bff/data/customers?filter[status][eq]=active")
  │  Cookie: op_session=<httpOnly>
  ▼
App Service (port 3006) — BFF layer
  │  1. Extract session cookie → validate with Auth Service
  │     GET /internal/auth/validate → { userId, tenantId, roles }
  │  2. Check permission: can userId read "customers" in tenantId?
  │     Ontology cache lookup → permission: ALLOW
  │  3. Rewrite request with service token + user context header
  │     GET /internal/data/customers?filter[status][eq]=active
  │     X-Service-Token: <App Service Ed25519 JWT>
  │     X-User-Context: { userId, tenantId, roles } (base64-encoded JSON)
  ▼
Gateway (internal routing — note: for inter-service calls, App Service calls
the target service directly on the internal network, not via the public Gateway)
  ▼
Ontology Service (resolves entity "customers" to tenant_abc.customers table)
  │  SELECT * FROM tenant_abc.customers WHERE status = 'active'
  ▼
App Service — BFF layer (response path)
  │  Strip internal headers, apply field-level permissions from ontology
  │  (hide fields the user's role cannot read)
  ▼
Browser App — receives { data: [...], pagination: {...} }
```

**Token handling:**
- Session cookies are set by the App Service on login: `Set-Cookie: op_session=<token>; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800` (7-day expiry matching refresh token TTL).
- The `op_session` value is the user's refresh token reference (an opaque string). The App Service exchanges it for a short-lived internal access JWT on each BFF request (or uses a cached access JWT until its 15-minute expiry). The browser never sees the access JWT.
- **CSRF protection:** because `SameSite=Strict` cookies are used, cross-site requests cannot include the session cookie. This eliminates CSRF without requiring additional CSRF tokens for same-site apps. For apps served on custom subdomains where `SameSite=Strict` may not apply across subdomains, the App Service additionally checks the `Origin` header against the app's registered origin.
- **Token refresh:** the App Service transparently refreshes the access JWT when it expires. If the refresh token itself expires, the App Service returns `401` to the BFF endpoint, and the `AppProvider` redirects the user to the login page.

**User identity propagation:**
- The App Service extracts `{ userId, tenantId, roles }` from the validated session and passes it downstream as the `X-User-Context` header (base64-encoded JSON). Internal services trust this header only when the request also carries a valid `X-Service-Token` (enforced by the service RBAC middleware in `@oneplatform/core`).
- Internal services NEVER accept `X-User-Context` without a valid `X-Service-Token`. The two headers are validated together — one without the other is rejected with `403`.

**RBAC enforcement at the BFF layer:**
- The App Service performs RBAC checks before forwarding any request. It uses the ontology permission rules (cached locally per Decision #12) to determine whether the requesting user's roles permit the requested action on the requested entity.
- Field-level RBAC is enforced on the RESPONSE path: after receiving data from an internal service, the App Service removes fields that the user's roles cannot read before returning the response to the browser.
- Row-level RBAC is enforced by injecting filter conditions into the request before forwarding: if the ontology defines `row_filter: { ownerId: "$userId" }` for a role, the App Service appends `filter[ownerId][eq]={userId}` to the query. Internal services cannot be bypassed because they require service token authentication.
- Permission check failures return `403 Forbidden` with `{ error: { code: "PERMISSION_DENIED", ... } }` to the browser app. The App Service logs a WARN-level audit event for every permission denial.

**Error handling in SDK:**
```typescript
interface AppSDKError {
  code: string;           // e.g., "PERMISSION_DENIED", "ENTITY_NOT_FOUND"
  message: string;
  statusCode: number;
  isRetryable: boolean;   // true for 429, 503; false for 403, 404
  requestId: string;      // for support/debugging
}
```
- The SDK wraps all BFF errors into `AppSDKError` instances. Network errors (fetch failed) produce an `AppSDKError` with `code: "NETWORK_ERROR"` and `isRetryable: true`.
- `useMutation` operations reject their promise with `AppSDKError` on failure. `useQuery` sets `error` and `isError` on failure without throwing.

**Security considerations:**
- The BFF layer is the single point of trust enforcement for all browser app interactions. No internal service is reachable directly from the browser.
- The session cookie scope is `Path=/` on the App Service origin only. App Service and the main platform share the same origin (`/apps/{slug}` under `localhost:3000`), so the session cookie is valid for both the platform login flow and the app BFF.
- XSS mitigation: the app bundle is served with `Content-Security-Policy: default-src 'self'; script-src 'self'; connect-src 'self'`. No inline scripts. No `eval`. These CSP headers are set by the App Service on every `GET /apps/{slug}/*` response.

---

### 27. App Access Control and OAuth Client Lifecycle

**Decision:** Each deployed app automatically receives an OAuth 2.0 client registration (deterministic client ID scheme `app:{appId}:{tenantId}`) created by the App Service calling the Auth Service at deploy time. Apps default to Platform-User Only access (requires an authenticated platform session). Apps can optionally be configured for Public/Guest Access (anonymous sessions with a guest role). App-level custom roles are defined by the developer and mapped to ontology permissions. Apps are tenant-scoped by default; cross-tenant sharing requires an explicit admin allowlist.

**Rationale:** Without a well-defined OAuth client lifecycle, the question "how does a deployed app identify itself to the auth system?" has no answer. Deterministic client IDs eliminate race conditions and idempotency issues — creating the OAuth client for app `xyz` in tenant `abc` always produces the same client ID `app:xyz:abc`, so re-deploys are safe (upsert, not create). The two-mode access model covers 100% of use cases: most apps are internal tools for platform users; some (customer-facing portals, public dashboards) need external access. Modeling these as two explicit modes with different security properties prevents accidental exposure.

**Implementation:**

**OAuth client auto-registration:**
- Trigger: `POST /api/v1/apps/{id}/deploy` → App Service calls Auth Service: `POST /internal/oauth/clients` with:
  ```json
  {
    "clientId": "app:{appId}:{tenantId}",
    "clientType": "public",
    "redirectUris": [
      "http://localhost:3000/apps/{slug}/auth/callback",
      "http://{slug}.apps.{domain}/auth/callback"
    ],
    "allowedScopes": ["openid", "profile", "data:read", "data:write"],
    "tenantId": "{tenantId}",
    "appId": "{appId}",
    "accessMode": "platform-user"
  }
  ```
- This call is idempotent: the Auth Service uses `INSERT ... ON CONFLICT (client_id) DO UPDATE` — re-deploying an app updates the redirect URIs but does not rotate the client ID or invalidate existing sessions.
- The App Service holds the registration response in `app.oauth_registrations`: `{ app_id, client_id, client_secret_hash (bcrypt), access_mode, created_at, updated_at }`. The client secret (if applicable — public clients don't need one) is generated by the Auth Service and returned once; subsequent requests cannot retrieve it.

**Client ID scheme:**
- Format: `app:{appId}:{tenantId}` where `appId` and `tenantId` are UUID v4 values.
- Example: `app:550e8400-e29b-41d4-a716-446655440000:6ba7b810-9dad-11d1-80b4-00c04fd430c8`
- Deterministic: the App Service can always compute the client ID without a database lookup during request validation.
- Collision-free: UUIDs are globally unique. The `app:` prefix distinguishes app clients from service tokens and user-created OAuth clients.
- The Auth Service enforces that client IDs matching the `app:*:*` pattern may only be created by the App Service (checked via service RBAC). No other service or user can register an `app:` prefixed client.

**Redirect URI management:**
- At registration, both path-based and subdomain redirect URIs are registered (see above). If `OP_WILDCARD_DOMAIN` is not set, only the path-based URI is registered.
- Additional redirect URIs can be added via `PATCH /api/v1/apps/{id}/oauth` — this triggers an update call to the Auth Service. The developer cannot add arbitrary URIs — they must match one of the patterns: `{OP_BASE_URL}/apps/{slug}/*` or `{slug}.apps.{OP_WILDCARD_DOMAIN}/*`. The Auth Service validates this pattern constraint at registration.
- For `op app dev` local development: `http://localhost:{port}/auth/callback` is automatically added to the redirect URI list when the developer starts `op app dev`. It is removed when the local dev server stops (the CLI sends `DELETE /api/v1/apps/{id}/oauth/dev-redirect-uris` on shutdown). This prevents dangling localhost redirect URIs in production configs.

**Two access modes:**

**(1) Platform-User Only (default):**
- The App Service checks for a valid `op_session` cookie on every request to the app. If absent or invalid, the user is redirected to the platform login page (`/login?redirect=/apps/{slug}`). After login, they are redirected back to the app.
- Only users who are members of the app's tenant can authenticate. Cross-tenant logins are rejected.
- The session check uses the Auth Service validation endpoint (`GET /internal/auth/validate`). The result is cached by the App Service for up to 15 seconds (to avoid a validation call on every SDK operation) using the session token as cache key.

**(2) Public/Guest Access:**
- Configured by setting `app.access_mode = "public"` via `PATCH /api/v1/apps/{id}` (requires tenant admin role).
- When a request arrives with no `op_session` cookie, the App Service issues a guest session: calls `POST /internal/auth/guest-sessions` → Auth Service creates a short-lived (24-hour) guest session token and returns it. The App Service sets an `op_guest_session` httpOnly cookie.
- Guest sessions are associated with the `guest` role in the ontology RBAC. The `guest` role is defined in the tenant ontology (Decision #12) and defaults to read-only access on entities the tenant admin has explicitly marked `public: true`. By default, no entities are public.
- Guest sessions do NOT have access to `useUser().email` (it returns `null`) or any personal user data. `useUser().isGuest` returns `true`.
- **Rate limiting for guest sessions:** guest requests are rate-limited more aggressively: 100 requests/minute per IP (vs. 500/minute for authenticated users). The Gateway applies this via a separate rate limit tier keyed on IP address when the `op_guest_session` cookie is present.
- **Preventing abuse:** guest sessions are ephemeral and not tied to any identity. The App Service monitors guest session creation rate per app and alerts if >1000 guest sessions/hour are created (possible scraping). Platform admin can disable guest access for a specific app via `PATCH /api/v1/apps/{id}` without affecting other apps.

**App-level roles:**
- Developers can define custom roles for their app: `POST /api/v1/apps/{id}/roles` with body `{ name: string, permissions: { entity: string, actions: Action[] }[] }`.
- These app-level roles are stored in `app.roles` and registered with the Ontology Service as role definitions scoped to `{ appId, tenantId }`. They follow the same permission inheritance model as platform roles (defined in the ontology RBAC layer).
- At runtime, the App Service resolves a user's effective roles as: `platform_roles UNION app_roles`. A user with platform role `viewer` and app role `dashboard_editor` gets the combined permission set of both.
- App-level roles are visible only within the app context. They do not affect the user's access to other platform resources.

**Cross-tenant sharing:**
- Apps are tenant-scoped by default. A user from tenant B cannot access an app belonging to tenant A, even if they know the app URL.
- **Explicit sharing:** tenant admin can add tenants to an allowlist: `POST /api/v1/apps/{id}/share` with body `{ tenantId: string, roles: string[] }`. This creates an entry in `app.tenant_shares`. The App Service checks this table during session validation for cross-tenant requests.
- The sharing allowlist maps external tenants to specific app-level roles. Users from the external tenant authenticate against their own tenant's auth and receive the mapped role within the shared app.
- Platform admin (not tenant admin) can disable cross-tenant sharing globally via the platform config. The default is disabled.
- **App slug uniqueness:** app slugs are unique per tenant, not globally. Two tenants can have apps with the same slug. The Gateway routes `/apps/{slug}` in the context of the requesting user's tenant (determined from their session). For unauthenticated access to public apps, the slug must be globally unique within public apps — enforced by a partial unique index: `CREATE UNIQUE INDEX ON app.apps (slug) WHERE access_mode = 'public'`.

**Security considerations:**
- OAuth clients for apps are public clients (PKCE flow, no client secret in the browser). The `clientType: "public"` flag in the Auth Service disables client secret validation and requires PKCE with code verifier.
- The Auth Service logs every OAuth authorization attempt (success and failure) to the audit trail.
- Guest sessions use a cryptographically random token (32 bytes, hex-encoded). They are stored in Redis with a `guest-session:` key prefix. When a guest session expires, all associated data (app storage writes within the session) is preserved but the session token is invalidated.
- **Tenant isolation invariant:** the App Service enforces on every request that `session.tenantId === app.tenantId OR app.tenant_shares contains(session.tenantId)`. This check happens before any BFF forwarding, in the App Service's request middleware.

---

### 28. End-to-End Data Flow

**Decision:** The canonical data path is: Connector → Ingestion Service (normalize to a standard envelope, write to raw staging table `ingestion.raw_{connectorId}`) → BullMQ batch job → Ontology Service (validate and map fields to entity schema, write to `tenant_{id}.{entity}` table) → queryable by all platform services. Raw data is retained separately from ontology-mapped data, allowing re-mapping when ontologies change. The `Connector` interface is a typed TypeScript interface (not an abstract class) defined in `@oneplatform/plugin-sdk`, implemented by both built-in connectors and third-party plugins. Auto-inference generates draft ontology suggestions from source schemas.

**Rationale:** The data flow is the #1 value proposition of the platform. Without a fully specified canonical path, each connector will implement its own storage strategy, making re-mapping impossible and data lineage untraceable. Two-stage storage (raw → mapped) is critical because ontologies change: if mapping is destructive (only keeping mapped fields), a schema change means re-ingesting all data. Keeping raw data makes re-mapping a pure read-then-write operation. The `Connector` interface must be defined before any connector is built — it is the contract that makes built-in and third-party connectors interchangeable.

**Implementation:**

**Connector TypeScript interface (canonical, in `@oneplatform/plugin-sdk`):**
```typescript
interface ConnectorMetadata {
  name: string;                    // e.g., "Postgres Source"
  version: string;                 // semver
  configSchema: JSONSchema7;       // JSON Schema for user-provided config
  credentialSchema: JSONSchema7;   // JSON Schema for credential fields
  capabilities: ConnectorCapabilities;
}

interface ConnectorCapabilities {
  supportedSyncModes: Array<"full" | "incremental">;
  supportsCDC: boolean;            // change data capture
  supportsSchemaInference: boolean;
  maxBatchSize: number;            // records per fetchBatch call
}

interface ConnectorHandle {
  connectionId: string;
  metadata: Record<string, unknown>; // connection state (e.g., active DB cursor)
}

interface BatchResult {
  records: Record<string, unknown>[];
  nextCursor: string | null;         // null = sync complete
  hasMore: boolean;
  inferredSchema?: SchemaInference;  // only if supportsSchemaInference
}

interface SchemaInference {
  fields: Array<{
    name: string;
    inferredType: "string" | "number" | "boolean" | "date" | "json" | "unknown";
    nullable: boolean;
    sampleValues: unknown[];         // up to 5 sample values for preview
  }>;
  confidence: number;                // 0-1 confidence of inference
}

interface CredentialAccessor {
  get(key: string): Promise<string>; // decrypts and returns credential field
}

interface Connector {
  metadata(): ConnectorMetadata;
  connect(
    config: ConnectorConfig,
    credentials: CredentialAccessor
  ): Promise<ConnectorHandle>;
  fetchBatch(
    handle: ConnectorHandle,
    cursor?: string
  ): Promise<BatchResult>;
  disconnect(handle: ConnectorHandle): Promise<void>;
}
```
- The `CredentialAccessor` is injected by the Ingestion Service and calls the credential vault (Decision #11) to decrypt credentials. Connectors never receive raw credential values — they receive the `CredentialAccessor` and call `get()` per field. This prevents connectors from logging or serializing credentials inadvertently.
- Built-in connectors (REST API, PostgreSQL, MySQL, CSV, webhook receiver) are implemented in `services/ingestion/src/connectors/` as classes implementing `Connector`. They use the same interface as third-party connector plugins — no special access.

**Data envelope (canonical JSON format for all raw records):**
```typescript
interface DataEnvelope {
  _id: string;              // UUID v7 (time-sortable)
  _source: string;          // connector name (from ConnectorMetadata.name)
  _ingestedAt: string;      // ISO 8601 UTC timestamp
  _connectorId: string;     // UUID of the connector instance in Postgres
  _batchId: string;         // UUID of the BullMQ batch job
  _tenantId: string;        // tenant isolation
  _syncMode: "full" | "incremental";
  _cursor: string | null;   // the cursor value at ingestion time (for tracing)
  data: Record<string, unknown>; // raw source fields, unmodified
}
```
- `_id` is UUID v7 (time-sortable) to allow time-based queries on the raw table without a secondary index.
- The `data` field contains the raw source record exactly as returned by the connector, with no transformation. String, number, boolean, null, nested objects, and arrays are all preserved.

**Raw staging table:**
- Table: `ingestion.raw_{connectorId}` — one table per connector instance, created dynamically when a connector is first activated. Schema: `{ _id uuid PK, _source text, _ingested_at timestamptz, _batch_id uuid, _sync_mode text, _cursor text, data jsonb }`. The `_tenant_id` is enforced via row-level security (RLS) policy on the table.
- JSONB `data` column has a GIN index for field-level JSON queries: `CREATE INDEX ON ingestion.raw_{connectorId} USING GIN (data)`.
- Table creation: `CREATE TABLE IF NOT EXISTS ingestion.raw_{connectorId} (...)` executed by the Ingestion Service with the connector's service credentials. The table name is sanitized: connector ID is a UUID, so `raw_550e8400_e29b_41d4_a716_446655440000` (dashes replaced with underscores) — no SQL injection possible.

**Sync modes:**

*(Full sync):*
- Pull every record from the source using `fetchBatch` in a loop until `hasMore: false`.
- Each batch of 1000 records (configurable via `OP_INGESTION_BATCH_SIZE`, default 1000, max 10000) is inserted into `ingestion.raw_{connectorId}` in a single `INSERT ... ON CONFLICT (_id) DO UPDATE` (upsert based on `_id`).
- After all batches complete, records in the raw table that do NOT appear in the current sync's `_batch_id` are marked as soft-deleted (`deleted_at = now()`). Full sync thus handles source deletions.

*(Incremental sync):*
- The Ingestion Service stores the last successful cursor per connector in `ingestion.sync_state`: `{ connector_id, last_cursor, last_sync_at, sync_mode }`.
- `fetchBatch` is called with the stored `cursor`. The connector returns only records changed since that cursor.
- After each batch completes successfully, `sync_state.last_cursor` is updated atomically (same Postgres transaction as the raw record insert). If the batch fails mid-way, the cursor is NOT updated, and the next sync retry re-fetches the same batch window.
- **Cursor types:** connectors declare their cursor type in `ConnectorMetadata` (timestamp, sequence ID, or opaque string). The Ingestion Service does not interpret cursor values — it stores and passes them opaquely to the connector.

**Batch processing and backpressure:**
- Each sync job is a BullMQ job on the `ingestion:sync` queue. Large syncs (more than one batch) spawn child batch jobs on the `ingestion:batch` queue — one job per batch of 1000 records.
- The `ingestion:batch` queue has `maxLength: 50_000` (50,000 pending batch jobs maximum). If the queue is full, the sync job raises `QueueFullError` and retries after 30s. The user sees "ingestion backlogged" in the UI.
- Each batch job is processed by a worker with concurrency 10 (configurable via `OP_INGESTION_WORKER_CONCURRENCY`, default 10). This means up to 10,000 records are being processed simultaneously.
- **Progress tracking:** the sync job stores progress in Redis: `ingestion:sync:{syncJobId}:progress = { totalBatches, completedBatches, failedBatches, totalRecords, processedRecords }`. The frontend polls `GET /api/v1/ingestion/syncs/{syncJobId}/progress` which reads from Redis. Progress updates are also streamed via SSE to the UI.

**Ontology mapping (raw → tenant entity tables):**
- After each batch is written to the raw table, the Ingestion Service enqueues an `ontology:map` job on the BullMQ queue `ontology:mapping` with `{ connectorId, batchId, tenantId }`.
- The Ontology Service worker picks up the job, reads all records in the batch from `ingestion.raw_{connectorId}` WHERE `_batch_id = {batchId}`, and applies the user-defined mapping rules.
- **Mapping rules** (stored in `ontology.mapping_rules`): each rule is `{ connector_id, source_field_path (JSONPath), target_entity, target_field, transform?: string (JS expression) }`. The Ontology Service evaluates transforms in the Execution Service sandbox for safety (transforms are user-supplied code).
- **Validation:** each mapped record is validated against the entity schema (Zod-generated from the ontology definition). Records that fail validation are written to `ontology.mapping_errors`: `{ connector_id, raw_id, entity_type, error_fields: string[], error_messages: string[], raw_data: jsonb }`. Validation errors do NOT stop the batch — partial success is allowed. The user sees a mapping error count in the UI.
- **Write to tenant table:** valid mapped records are upserted into `tenant_{tenantId}.{entityType}`: `INSERT INTO ... ON CONFLICT (id) DO UPDATE`. The `id` field is derived from the mapping rules (typically the source primary key, mapped to the entity's `id` field).

**Auto-inference:**
- When a connector has `supportsSchemaInference: true`, the Ingestion Service calls `fetchBatch` once (just the first batch), inspects the `inferredSchema` from the `BatchResult`, and sends a `SchemaSuggestion` event to the Ontology Service: `POST /internal/ontology/infer` with `{ tenantId, connectorId, inferredSchema }`.
- For CSV uploads: the Ingestion Service parses the first 200 rows, infers field types using heuristics (ISO date patterns, numeric patterns, boolean strings), and produces a `SchemaSuggestion`.
- The Ontology Service generates a draft ontology from the suggestion: one entity with the inferred field names and types, all fields nullable, no relationships. The draft is written to `ontology.draft_ontologies` and surfaced to the user as "Review suggested schema" in the UI.
- **Non-destructive:** the draft is never applied automatically. The user reviews, edits field names/types, and confirms. Only on confirmation does the Ontology Service promote the draft to a live entity definition and generate the tenant table.

**Large dataset handling:**
- Datasets over 1 million records are treated as "large syncs". The Ingestion Service automatically lowers concurrency for large sync jobs (`OP_LARGE_SYNC_CONCURRENCY`, default 3) to avoid overwhelming Postgres.
- Memory pressure: the Ingestion Service processes each batch by streaming records from the connector into the raw table using Postgres COPY (for bulk inserts). It does NOT hold the entire batch in memory — records are streamed via a Node.js `Transform` stream from the connector's batch response to the Postgres COPY stream. Peak memory for a batch worker is bounded at approximately 50MB per batch.
- **Estimated time remaining:** the sync job calculates ETA based on `(completedRecords / elapsedSeconds) * remainingRecords`. The ETA is included in the progress response and displayed in the UI.

**Security considerations:**
- Raw tables are per-connector and have RLS policies enforcing `_tenant_id = current_setting('app.tenant_id')::uuid`. The Ingestion Service sets this session variable before executing queries.
- The `CredentialAccessor` interface means connector code never receives plaintext credentials as function arguments — only a getter function. This means `JSON.stringify(handle)` or console logging the handle does not leak credentials.
- Mapping transforms (user JS expressions) run through the Execution Service sandbox (no network, resource-limited). A malicious transform cannot read other tenants' data or make external requests.
- Connector code (third-party plugins) runs in the plugin sandbox, not in the Ingestion Service process. The Ingestion Service invokes the connector via the Plugin Service + Execution Service chain. Built-in connectors run in-process (they are trusted code compiled into the service).

---

### 29. API Contract Standard

**Decision:** All platform services expose a uniform API contract: RESTful resource URLs under `/api/v1/`, consistent request/response envelopes, cursor-based pagination, a structured filter/sort DSL, standard error format with typed error codes, OpenAPI 3.1 spec at a well-known URL, RFC 8594 deprecation headers, and health check endpoints. This contract is enforced by shared middleware and Zod schema generators in `@oneplatform/core`. No service may deviate from this contract.

**Rationale:** Without a standard API contract, each of 9 services will implement its own URL scheme, error format, and pagination strategy. This makes the SDK impossible to generate correctly, makes the CLI error handling inconsistent, and makes every new service a UX surprise. Defining the contract in `@oneplatform/core` shared middleware means compliance is automatic for any service that imports core. The contract also resolves concrete friction points: APP-H01 (API spec URL), API-H06 (pagination), API-H07 (error format), API-H09 (deprecation headers), API-H10 (bulk operations).

**Implementation:**

**URL convention:**
- Single resource: `GET /api/v1/{resource}/{id}`
- Collection: `GET /api/v1/{resource}`
- Create: `POST /api/v1/{resource}`
- Partial update: `PATCH /api/v1/{resource}/{id}`
- Full replace: `PUT /api/v1/{resource}/{id}`
- Delete: `DELETE /api/v1/{resource}/{id}`
- Sub-resource: `GET /api/v1/{resource}/{id}/{sub-resource}`
- Sub-resource item: `GET /api/v1/{resource}/{id}/{sub-resource}/{subId}`
- Bulk operation: `POST /api/v1/{resource}/bulk`
- Entity data (ontology-typed): `GET /api/v1/data/{entityType}` and `GET /api/v1/data/{entityType}/{id}`
- Resource names are plural, lowercase, hyphenated (e.g., `/api/v1/connector-instances`, `/api/v1/pipeline-runs`, `/api/v1/api-keys`).
- The keyword `bulk` is reserved and cannot be used as a resource ID. Validated by `@oneplatform/core` route registration.

**Request/response envelope:**

*Single resource response (success):*
```json
{
  "data": { "id": "...", "name": "...", ... }
}
```

*Collection response (success):*
```json
{
  "data": [ { "id": "...", ... }, ... ],
  "pagination": {
    "nextCursor": "eyJpZCI6IjEyMyJ9",
    "total": 1543
  }
}
```
- `total` reflects the total matching count (before pagination). For large collections (>100k rows), `total` may be `null` (the query would be too expensive). Services declare which collections support exact totals in their OpenAPI spec.
- `nextCursor` is `null` when there are no more pages.

*Error response (all 4xx and 5xx):*
```json
{
  "error": {
    "code": "ENTITY_NOT_FOUND",
    "message": "Customer with id '123' does not exist in this tenant.",
    "details": {
      "entityType": "customer",
      "id": "123"
    },
    "requestId": "01J4WZJHK8GN9..."
  }
}
```
- `code` is a SCREAMING_SNAKE_CASE string. The full error code registry is defined in `@oneplatform/core/errors.ts`. Services may add their own codes to the registry (following the `{SERVICE}_{ERROR}` naming convention, e.g., `INGESTION_CONNECTOR_TIMEOUT`).
- `message` is human-readable and safe to display in a UI. It does NOT include stack traces, internal paths, or implementation details.
- `details` is optional and contains structured key-value data relevant to the error (e.g., validation field errors). Field validation errors use `details.fields: { fieldName: [errorMessages] }`.
- `requestId` is the W3C trace ID from the request (Decision #21). Every error response includes it. Users can provide this to support for log correlation.
- **Stack traces:** NEVER included in API error responses. Logged internally (DEBUG level) by the Logging Service, accessible only to platform admins via `GET /api/v1/logs?filter[traceId][eq]={requestId}`.

**HTTP method semantics:**
- `GET`: read-only, idempotent, safe. No request body. Query parameters for filtering/sorting.
- `POST`: create a new resource. Request body: JSON. Response: `201 Created` with the created resource.
- `PATCH`: partial update. Request body: only the fields to change. Response: `200 OK` with the full updated resource.
- `PUT`: full replace. Request body: complete resource representation. Response: `200 OK`. Rarely used — prefer `PATCH`.
- `DELETE`: remove. No request body. Response: `204 No Content`. Soft deletes return `200 OK` with the soft-deleted state.
- `HEAD`: same as `GET` but no response body. Used for existence checks (e.g., `HEAD /api/v1/apps/{slug}` to check if a slug is taken).

**Pagination:**
- All collection endpoints support cursor-based pagination: `?cursor={base64-encoded-cursor}&limit={n}`.
- Default `limit`: 50. Maximum `limit`: 100. Requests with `limit > 100` return `400 Bad Request` with `code: "PAGINATION_LIMIT_EXCEEDED"`.
- The cursor is a base64-encoded JSON object containing the sort key values of the last returned item (e.g., `{ "id": "last-id", "createdAt": "2026-01-01T00:00:00Z" }`). Cursors are opaque to clients — their internal structure is not part of the API contract and may change between API versions.
- Cursors are signed with an HMAC-SHA256 using the service's Ed25519 private key to prevent cursor tampering (injecting arbitrary values into the pagination query). An invalid cursor signature returns `400 Bad Request` with `code: "INVALID_CURSOR"`.
- **Cursor expiry:** cursors expire after 24 hours. An expired cursor returns `410 Gone` with `code: "CURSOR_EXPIRED"`, prompting the client to restart pagination from the beginning.
- **Offset pagination:** explicitly NOT supported. Offset pagination (`?page=5&limit=50`) has O(n) database cost and inconsistent results under concurrent writes. All clients MUST use cursor pagination.

**Filter DSL:**
- Syntax: `?filter[{field}][{op}]={value}` where `op` is one of:
  - `eq` — exact match
  - `neq` — not equal
  - `gt` — greater than
  - `gte` — greater than or equal
  - `lt` — less than
  - `lte` — less than or equal
  - `like` — SQL ILIKE pattern (% and _ wildcards)
  - `in` — comma-separated list of values (e.g., `filter[status][in]=active,pending`)
  - `null` — value is `filter[field][null]=true` (IS NULL) or `filter[field][null]=false` (IS NOT NULL)
- Multiple filters on different fields are ANDed. Multiple values for `in` are treated as OR within that field.
- **Filter injection protection:** filter field names are validated against the entity's known field list (from the ontology schema). Unknown field names return `400 Bad Request` with `code: "UNKNOWN_FILTER_FIELD"`. Values are parameterized in all SQL queries — no string interpolation of filter values into SQL.
- **Deep field filters:** for JSONB fields, dot notation is supported: `filter[data.address.city][eq]=London`. Depth is limited to 3 levels to prevent unbounded JSONB extraction.

**Sorting:**
- Syntax: `?sort=field1,-field2` where a `-` prefix means descending.
- Multiple sort fields are comma-separated.
- Default sort: `createdAt DESC` (newest first) unless the endpoint specifies otherwise.
- Sort fields must be in the entity's indexed column list (enforced by the service to prevent unindexed sort queries). Requesting a sort on a non-indexed field returns `400 Bad Request` with `code: "UNSORTABLE_FIELD"` and a `hint` field listing valid sort fields.

**Field selection:**
- Syntax: `?fields=id,name,status` — only the listed fields are returned in the response.
- Relationships (e.g., `fields=id,name,owner.email`) resolve the `owner` relationship and include only `email` from it. Relationship depth is limited to 1 level (no nested relationships via field selection — use sub-resource endpoints for deeper traversal).
- Unknown field names in `?fields` are silently ignored (not an error) to allow forward-compatible clients that specify fields from a newer API version.

**Bulk operations:**
- Endpoint: `POST /api/v1/{resource}/bulk`
- Request body:
  ```json
  {
    "operation": "create" | "update" | "delete",
    "items": [
      { ...resource fields... },
      ...
    ]
  }
  ```
- Response (always `207 Multi-Status`):
  ```json
  {
    "results": [
      { "index": 0, "id": "created-id", "status": "success" },
      { "index": 1, "status": "error", "error": { "code": "...", "message": "..." } }
    ],
    "summary": {
      "total": 100,
      "succeeded": 98,
      "failed": 2
    }
  }
  ```
- Maximum bulk items: 500 per request. Exceeding returns `400 Bad Request` with `code: "BULK_LIMIT_EXCEEDED"`.
- Bulk operations are NOT transactional by default — each item is processed independently. If transactional behavior is needed, add `"transactional": true` to the request body. Only services that support it will honor this flag; others return `400 Bad Request` with `code: "TRANSACTIONAL_BULK_NOT_SUPPORTED"`.
- Each item in a bulk request is validated independently before any are executed. If ANY item fails validation, the entire request returns `400 Bad Request` with per-item validation errors in `results`. No items are processed if validation fails (fail-all-or-none for the validation pass, fail-per-item for execution).

**OpenAPI spec:**
- URL: `GET /api/v1/openapi.json` — returns the full OpenAPI 3.1 spec for the requesting tenant's API surface.
- Tenant-aware: the spec includes auto-generated routes for all ontology-defined entity types belonging to the requesting tenant (e.g., `/api/v1/data/customer`, `/api/v1/data/order`). These are generated at request time from the ontology cache — the spec reflects the tenant's current schema.
- The spec is generated by `@oneplatform/core/openapi-generator.ts` which introspects all registered Hono routes and their Zod schemas. No manual spec maintenance.
- **Spec caching:** the generated spec is cached in Redis with a TTL of 5 minutes, keyed by `{tenantId}:{schemaVersion}`. Ontology changes (which bump `schemaVersion`) automatically invalidate the cache. The 5-minute TTL is a safety net.
- The spec is also served as a rendered interactive API explorer at `GET /docs/api` (Scalar or Stoplight Elements, per Decision #23).

**Rate limit headers (all responses):**
All API responses include the following headers (per Decision #20 and friction point API-H11):
```
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 987
X-RateLimit-Reset: 1735689600
X-RateLimit-Policy: per-tenant
```
- `X-RateLimit-Reset` is a Unix timestamp (seconds) when the current window resets.
- `X-RateLimit-Policy` is one of `global`, `per-tenant`, `per-api-key`, `webhook` — indicates which limit was applied (the most restrictive active limit).
- When a rate limit is hit (`429 Too Many Requests`), the response also includes `Retry-After: {seconds}`.

**Deprecation headers (RFC 8594):**
- Deprecated endpoints include:
  ```
  Deprecation: true
  Sunset: Sat, 01 Jan 2028 00:00:00 GMT
  Link: <https://docs.oneplatform.dev/api/v2/endpoint>; rel="successor-version"
  ```
- The `Sunset` date is the date after which the endpoint will return `410 Gone`. Clients that receive `Deprecation: true` MUST update before the `Sunset` date.
- The API versioning SLA is: deprecated endpoints are supported for minimum 6 months after the `Deprecation` header first appears (Decision #22).
- `@oneplatform/core` provides a route decorator `@deprecated({ sunset: Date, successorUrl: string })` that automatically adds these headers to responses.

**Health check endpoints:**
- Every service exposes:
  - `GET /healthz` (liveness): returns `200 OK` with `{ status: "ok", service: "{name}", version: "{semver}" }` as long as the process is running. Returns `503` only if the process is in a fatal state (e.g., crashed event loop, OOM). Docker Compose health checks use this endpoint.
  - `GET /readyz` (readiness): returns `200 OK` with `{ status: "ready", checks: { postgres: "ok", redis: "ok", ... } }` when the service is ready to handle traffic. Returns `503` with `{ status: "not-ready", checks: { postgres: "degraded", ... } }` if any dependency is unhealthy. The Gateway waits for this endpoint before routing traffic to a service.
  - Both endpoints are NOT rate-limited and are excluded from auth middleware — they must always be reachable.
  - Health check responses include `X-Response-Time: {ms}` for the Gateway's readiness probe timeout calculation.

**CORS policy:**
- Configured via `OP_ALLOWED_ORIGINS` environment variable (comma-separated list of origins).
- Default (development): `OP_ALLOWED_ORIGINS=http://localhost:3000,http://localhost:4000`
- Production: set to the platform's base URL and any registered app domains.
- The Gateway enforces CORS for all public-facing endpoints. Internal service endpoints (on `oneplatform-internal` network) are not exposed externally and do not have CORS headers.
- CORS headers added to all responses: `Access-Control-Allow-Origin`, `Access-Control-Allow-Methods`, `Access-Control-Allow-Headers`, `Access-Control-Max-Age: 86400` (24-hour preflight cache).
- Requests from origins not in `OP_ALLOWED_ORIGINS` receive `403 Forbidden` (not a CORS error, a proper 403) with `code: "ORIGIN_NOT_ALLOWED"`. This prevents leaking information via CORS error messages.
- **Credentials mode:** `Access-Control-Allow-Credentials: true` is set when the origin is in the allowlist. This is required for the session cookie to be included in cross-origin requests from the app editor (frontend on `:3000` calling app BFF on `:3000` — same origin; but `op app dev` local server on `:4000` calling platform on `:3000` — cross-origin, needs credentials mode).

**Error code registry (partial, defined in `@oneplatform/core/errors.ts`):**

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `UNAUTHORIZED` | 401 | Missing or invalid authentication |
| `FORBIDDEN` / `PERMISSION_DENIED` | 403 | Authenticated but insufficient permissions |
| `NOT_FOUND` / `ENTITY_NOT_FOUND` | 404 | Resource does not exist |
| `CONFLICT` | 409 | Unique constraint violation |
| `VALIDATION_ERROR` | 422 | Request body failed Zod validation |
| `RATE_LIMIT_EXCEEDED` | 429 | Rate limit hit |
| `INTERNAL_ERROR` | 500 | Unexpected server error (safe message, trace ID only) |
| `SERVICE_UNAVAILABLE` | 503 | Dependency unavailable (Postgres, Redis down) |
| `PAGINATION_LIMIT_EXCEEDED` | 400 | `limit` exceeds max |
| `INVALID_CURSOR` | 400 | Cursor signature invalid |
| `CURSOR_EXPIRED` | 410 | Cursor older than 24 hours |
| `BULK_LIMIT_EXCEEDED` | 400 | Bulk items exceeds 500 |
| `ORIGIN_NOT_ALLOWED` | 403 | CORS origin not in allowlist |
| `UNKNOWN_FILTER_FIELD` | 400 | Filter on non-existent field |
| `UNSORTABLE_FIELD` | 400 | Sort on non-indexed field |

- Services add service-specific codes with the `{SERVICE}_` prefix. All codes are registered in `@oneplatform/core/errors.ts` — unregistered codes are rejected by the linter.

**Middleware enforcement in `@oneplatform/core`:**
- `@oneplatform/core` exports a `createApp(config)` factory that returns a pre-configured Hono app with the following middleware stack (in order):
  1. `requestId` — generates W3C trace ID if not present in incoming headers
  2. `otelInstrumentation` — starts OTEL span per request
  3. `cors` — enforces `OP_ALLOWED_ORIGINS`
  4. `rateLimit` — delegates to Gateway rate limiter via Redis (internal calls skip this)
  5. `auth` — validates session cookie or API key, sets `c.var.user`
  6. `serviceAuth` — on internal routes, validates `X-Service-Token` and service RBAC
  7. `responseEnvelope` — wraps all route responses in `{ data: T }` envelope
  8. `errorHandler` — catches all thrown errors and formats them as `{ error: {...} }` envelope
  9. `rateLimitHeaders` — adds `X-RateLimit-*` headers to all responses
  10. `deprecationHeaders` — adds deprecation headers if route is marked deprecated
- Services compose their route handlers into this stack. A service that calls `createApp()` and registers its routes is automatically compliant with the API contract. Compliance cannot be accidentally bypassed because the envelope and error handling are middleware, not opt-in per-route.

**Testing the contract:**
- `@oneplatform/core` exports a `testApiContract(app, spec)` utility that takes a Hono app and an OpenAPI spec and runs contract tests: every path in the spec has a corresponding route; every response matches its declared schema; every error response uses the standard envelope. This runs in CI for all 9 services.
- Pact contract tests (consumer-driven) are maintained for the three most critical service-to-service contracts: App Service ↔ Auth Service, Gateway ↔ Auth Service, Ingestion ↔ Ontology Service.
