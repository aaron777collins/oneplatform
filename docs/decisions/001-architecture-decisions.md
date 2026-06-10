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
**Decision:** Full TypeScript monorepo — React + Tailwind v4 + shadcn/ui frontend, Fastify/Hono backend services.

**Rationale:** Same language front and back, shared types, huge ecosystem. Code generation is central to the platform — generating TypeScript that runs natively in the same runtime is the most cohesive approach.

### 5. Database Strategy
**Decision:** PostgreSQL + PgBouncer + Redis. Postgres for persistent storage with PgBouncer for connection pooling, Redis for job queues (BullMQ), caching, and real-time pipeline state.

**Rationale:** Postgres handles structured platform metadata and dynamic user data (JSONB). PgBouncer prevents connection pool exhaustion across 9 services sharing one Postgres instance — critical for stability. Redis is needed for BullMQ job queues regardless.

### 6. Code Execution Sandbox
**Decision:** `isolated-vm` for JavaScript/TypeScript (fast path, ~1ms), Docker containers for other languages (Python, Go, etc.) accessed via a restricted Docker socket proxy.

**Rationale:** Most auto-generated code is JS/TS and benefits from near-instant execution. Docker containers provide full language support for heavy processing. Platform injects controlled APIs (fetch, db, cache) into both environments.

**Security model:**
- Docker socket is NEVER mounted directly into the Execution Service container
- A Docker socket proxy (tecnativa/docker-socket-proxy) sits between the Execution Service and Docker Engine with restricted permissions: only `POST /containers/create`, `POST /containers/{id}/start`, `GET /containers/{id}/logs`, `DELETE /containers/{id}` are allowed
- Sandbox containers run with `--network=oneplatform-sandbox` (isolated network), `--read-only` filesystem, no capabilities (`--cap-drop=ALL`), memory/CPU limits, and a hard timeout enforced by the Execution Service
- The `fetch()` API injected into isolated-vm routes through a platform proxy that enforces an outbound allowlist — internal service URLs (`http://*-service:*`) are blocked by default; only user-configured external URLs are permitted
- Sandbox containers get the same outbound proxy with the same allowlist

### 7. Authentication Model
**Decision:** Built-in email/password auth + optional OAuth (GitHub, Google). API keys for programmatic access. Short-lived access tokens + refresh tokens with Redis-backed revocation.

**Rationale:** Self-hosted users need offline auth. OAuth is table stakes for modern platforms. Both available via configuration.

**Token strategy:**
- Access tokens: JWT, 15-minute expiry, contain user ID + roles + tenant ID
- Refresh tokens: opaque, stored in Redis, 7-day expiry, rotated on each use
- Token revocation: Redis SET of revoked token JTIs checked on every request via auth middleware in @oneplatform/core — O(1) lookup
- API keys: hashed with bcrypt, stored in Postgres, never expire but can be revoked instantly via the revocation set
- On compromise: revoke refresh token in Redis → access token expires within 15 minutes max; or add access token JTI to revocation set for immediate invalidation

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
- Master encryption key: loaded from `OP_MASTER_KEY` environment variable (generated on first setup)
- Key derivation: HKDF-SHA256 from master key + per-credential salt
- Storage: `encrypted_blob` (AES-256-GCM ciphertext) + `key_version` (integer) + `salt` (random bytes) in the `ingestion.credentials` table
- Key rotation: new key version bumps `key_version`; background job re-encrypts all credentials with new key; old key retained until migration completes
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
- Rollback: if migration fails, old schema version is restored; partially migrated data is reverted via the audit trail

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
- Hooks run with a `hookDepth=1` flag in the execution context; any attempt to enqueue a job or trigger a pipeline stage from within a hook is rejected with `HookRecursionError`
- Hook timeout: 30s default per hook; exceeded hooks are killed and the chain continues with the pre-hook payload (fail-open for non-critical hooks, fail-closed configurable per hook)

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
| Redis 7 | `redis:7-alpine` | Job queues (BullMQ), pub/sub, caching |
| Docker Socket Proxy | `tecnativa/docker-socket-proxy` | Restricted Docker API access for Execution Service |
| Frontend | Custom (Nginx) | React dashboard SPA |

## Shared Packages

| Package | Purpose |
|---------|---------|
| `@oneplatform/core` | DB clients, auth middleware, queue helpers, shared types, logging/tracing, error handling, config loader, health checks, encryption utilities |
| `@oneplatform/sdk` | External app SDK — connect to OnePlatform from outside |
| `@oneplatform/app-sdk` | Platform app SDK — for apps built inside OnePlatform |
| `@oneplatform/plugin-sdk` | Plugin development SDK — interfaces for connectors, transformers, destinations, auth providers |

## Monorepo Structure

```
oneplatform/
├── packages/
│   ├── core/                  # @oneplatform/core — shared engine library
│   ├── sdk/                   # @oneplatform/sdk — external app SDK
│   ├── app-sdk/               # @oneplatform/app-sdk — platform app SDK
│   └── plugin-sdk/            # @oneplatform/plugin-sdk — plugin development
├── services/
│   ├── gateway/               # API Gateway
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
│   ├── Dockerfile.frontend    # Nginx + React build
│   └── docker-compose.yml     # Full stack orchestration
├── docs/
│   └── decisions/             # Architecture Decision Records
├── turbo.json                 # Turborepo config
├── pnpm-workspace.yaml
└── package.json
```

## Tech Stack Summary

| Layer | Technology | License |
|-------|-----------|---------|
| Frontend | React 18, TypeScript, Tailwind v4, shadcn/ui | MIT |
| Backend Framework | Fastify or Hono | MIT |
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

All dependencies are MIT/Apache/BSD/ISC/permissive — safe for commercial use under BSL.
