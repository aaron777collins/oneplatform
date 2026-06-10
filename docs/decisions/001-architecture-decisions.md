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

It aims to be a free, open-source alternative to tools like Fivetran, n8n, and Retool — combined into one cohesive platform.

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
- **Redis access control:** Redis is configured with ACL rules — each service authenticates with its own Redis user that has access ONLY to its assigned logical database(s). The Execution Service has NO Redis access at all (it communicates only via the Unix socket to sandbox-vm and via the internal service network to other services). This prevents a compromised service from issuing `FLUSHDB` on another service's database.

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
- The `op-sandbox-vm` container is recycled (destroyed and recreated) every 1000 executions or every 1 hour (whichever comes first) to limit the window of any in-memory compromise
- Resource limits: 512MB memory, 1 CPU core, 30s execution timeout per invocation

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
- Rollback: if migration fails, old schema version is restored; partially migrated data is reverted using shadow tables (pre-migration snapshots of affected rows, created before each batch begins). Each batch creates its own shadow table (`shadow_{entity}_{batch_id}`), so a failure at batch 6 rolls back batches 1-6 individually in reverse order. Shadow tables are dropped after successful migration or used for restoration on failure.

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
- Hooks run with a `hookDepth=1` flag in the execution context; any attempt to enqueue a job or trigger a pipeline stage from within a hook is rejected with `HookRecursionError`
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
  - BullMQ queues: if Redis is down, producers buffer up to 100 jobs in-memory and retry connection every 2s; pipeline status shows "queuing paused" in the UI
  - JWT revocation blocklist: if Redis is unreachable, auth middleware falls back to rejecting all requests with expired refresh tokens (fail-closed) and allowing access tokens until their 15-min expiry — conservative but safe
  - Refresh tokens: if Redis is down, new logins fail (cannot store refresh token) but existing access tokens continue working until expiry
  - Ontology pub/sub: consumers fall back to polling the Ontology Service every 15s (configurable via `OP_ONTOLOGY_POLL_INTERVAL`, default 15s) instead of relying on pub/sub notifications — 15s is aggressive enough to catch schema changes quickly while not overloading the Ontology Service during Redis outages
  - Log delivery: the @oneplatform/core log helper buffers up to 10,000 events in-memory and flushes when Redis reconnects; audit events are additionally written to a local fallback file (max 100MB, rotated to `.1` suffix at cap — oldest rotated file is deleted) that the Logging Service picks up on recovery
- **Production recommendation:** Docker Compose includes a commented-out Redis Sentinel configuration (1 master + 2 replicas) that users can enable for high availability; the architecture guide documents when and why to enable it
- **Health monitoring:** the Gateway Service health check includes Redis connectivity; if Redis is unreachable for >30s, the health endpoint returns degraded status, allowing external load balancers or monitoring to alert

### 19. Service-to-Service Authentication
**Decision:** All inter-service communication is authenticated using mutual TLS (mTLS) or shared service tokens. No service trusts another service based solely on network proximity.

**Rationale:** In a microservices architecture, any container on the Docker network can reach any other container. A compromised sandbox container, a malicious plugin, or a misconfigured service could call the Auth Service to issue tokens or the Ingestion Service to read credentials. Network adjacency is not trust.

**Implementation:**
- **Service tokens:** each service is issued a service-level JWT at startup, signed by a shared secret (`OP_SERVICE_SECRET` env var). This token contains the service name and a `role: "service"` claim. Services include this token in all inter-service requests via the `X-Service-Token` header.
- **Validation:** the auth middleware in @oneplatform/core validates `X-Service-Token` on every request. Requests without a valid service token from within the Docker network are rejected with 403. The Gateway is the ONLY service that accepts external (user) requests without a service token.
- **Service RBAC:** each service has a defined set of endpoints it's allowed to call on other services. For example, the Pipeline Service can call `Execution.execute()` and `Ontology.getSchema()` but NOT `Auth.createUser()` or `Ingestion.getCredentials()`. This is enforced via a service-level permission matrix in @oneplatform/core.
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
- **Redis outage behavior:** rate limiting falls back to a LOCAL in-memory sliding window counter per Gateway instance with conservative limits (50% of normal limits). This prevents both extremes: complete no-limit (security hole for multi-tenant) and complete blocking (availability disaster). The in-memory counter is approximate and per-process (not shared across Gateway replicas), so it's less precise but still protective. When Redis reconnects, counters are re-synced.
- **Burst allowance:** each limit allows a 2x burst for 5 seconds to handle legitimate traffic spikes

### 20. Observability Stack
**Decision:** OpenTelemetry (OTEL) is the standard for distributed tracing and metrics. All services are instrumented with OTEL SDK. Traces and metrics are exported to a configurable backend (default: Prometheus for metrics, Jaeger for traces, both optional).

**Rationale:** A 9-service system is impossible to debug in production without distributed tracing and metrics. Logs alone are insufficient — you need to trace a request across service boundaries and correlate it with resource metrics.

**Implementation:**
- **Tracing:** every inbound request to the Gateway generates a trace ID (W3C Trace Context format). The trace ID propagates through all inter-service communication (Redis queue job metadata, pub/sub message headers). Each service creates spans for its operations. Trace data is exported via OTLP to a configurable endpoint.
- **Metrics:** each service exports standard metrics via OTEL: request latency (p50/p95/p99), request count by status code, queue depth, active connections, memory/CPU usage, pipeline execution duration, sandbox execution time. Metrics are exposed on a `/metrics` endpoint (Prometheus-compatible) on each service.
- **Default stack (Docker Compose):** includes optional Prometheus (`prom/prometheus:latest`, Apache 2.0) and Jaeger (`jaegertracing/all-in-one:latest`, Apache 2.0) containers, commented-out by default. Users enable with `docker compose --profile observability up`.
- **@oneplatform/core integration:** the core library auto-instruments all Hono routes, BullMQ workers, and Redis/Postgres clients with OTEL spans. Services get tracing for free by importing core — zero per-service instrumentation code needed.
- **Frontend:** the dashboard includes a basic trace viewer (search by trace ID, see the full service call chain) and a metrics dashboard (queue depths, error rates, pipeline throughput) backed by the Logging Service query API. Full Grafana-level dashboards available by connecting the optional Prometheus/Jaeger endpoints.
- **Correlation:** the existing `traceId` in log events (Decision #17) IS the OTEL trace ID — logs, traces, and metrics all share the same correlation identifier

### 21. SDK, CLI, and API as First-Class Citizens
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

### 22. Auto-Generated Documentation
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
