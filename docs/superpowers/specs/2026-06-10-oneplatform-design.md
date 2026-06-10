# OnePlatform — L1 Design Specification

**Date:** 2026-06-10
**Status:** APPROVED (synthesizes ADR-1 through ADR-36)
**Authors:** Architecture Team
**Reference hierarchy:**
- L0: `docs/decisions/001-architecture-decisions.md` (ADR 1-29)
- L0: `docs/decisions/002-expanded-architecture-decisions.md` (ADR 30-36)
- **L1: This document** — unified system design
- L2: `docs/designs/{service-name}.md` — per-service detailed designs (to be written)
- L3: `services/{service-name}/src/` — implementation

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Infrastructure](#2-infrastructure)
3. [Data Architecture](#3-data-architecture)
4. [Authentication and Authorization](#4-authentication-and-authorization)
5. [Core Library — @oneplatform/core](#5-core-library)
6. [API Design](#6-api-design)
7. [Service Designs (Summary)](#7-service-designs-summary)
8. [Plugin System](#8-plugin-system)
9. [App Platform](#9-app-platform)
10. [CLI and SDKs](#10-cli-and-sdks)
11. [Event System](#11-event-system)
12. [Observability](#12-observability)
13. [Security Summary](#13-security-summary)
14. [Implementation Order](#14-implementation-order)
15. [Config Export/Import](#15-config-exportimport)

---

## 1. System Overview

OnePlatform is a self-hosted, source-available (BSL) data platform that unifies data ingestion, ontology-driven schema mapping, automated pipeline execution, sandboxed code execution, and a hosted app builder into a single cohesive system. It is a free alternative to the combined capabilities of Fivetran, n8n, and Retool, designed so that a team can ingest data from any source, define their own entity schemas, build pipelines to process that data, and create internal apps on top of it — all without leaving the platform. Every platform feature is available via REST API, CLI, and SDK; the dashboard is one client among many.

### System Diagram

```
                          ┌─────────────────────────────────────────────┐
                          │              PUBLIC INTERNET                 │
                          └───────────────────┬─────────────────────────┘
                                              │ HTTPS
                          ┌───────────────────▼─────────────────────────┐
                          │         oneplatform-public network          │
                          │                                              │
                          │  ┌──────────────┐    ┌──────────────────┐  │
                          │  │   Frontend   │    │  Gateway :3000   │  │
                          │  │  (Nginx SPA) │    │ rate-limit, auth │  │
                          │  │  React+Vite  │    │ route, CORS, TLS │  │
                          │  └──────────────┘    └────────┬─────────┘  │
                          └───────────────────────────────│─────────────┘
                                                          │
                          ┌───────────────────────────────▼─────────────┐
                          │        oneplatform-internal network          │
                          │                                              │
                          │  ┌─────────┐ ┌─────────┐ ┌──────────────┐ │
                          │  │ Auth    │ │Ingestion│ │  Ontology    │ │
                          │  │  :3001  │ │  :3002  │ │    :3003     │ │
                          │  └────┬────┘ └────┬────┘ └──────┬───────┘ │
                          │       │            │              │          │
                          │  ┌────▼────┐ ┌────▼────┐ ┌──────▼───────┐ │
                          │  │Pipeline │ │  App    │ │   Logging    │ │
                          │  │  :3004  │ │  :3006  │ │    :3007     │ │
                          │  └────┬────┘ └─────────┘ └──────────────┘ │
                          │       │                                      │
                          │  ┌────▼────┐ ┌─────────┐                   │
                          │  │Execution│ │ Plugin  │                   │
                          │  │  :3005  │ │  :3008  │                   │
                          │  └────┬────┘ └─────────┘                   │
                          │       │                                      │
                          │  ┌────▼────────────────────────────────┐   │
                          │  │ Shared Infrastructure (internal)    │   │
                          │  │  PostgreSQL:5432  PgBouncer:5433    │   │
                          │  │  Redis:6379       MinIO:9000        │   │
                          │  └─────────────────────────────────────┘   │
                          └──────────────────────┬───────────────────────┘
                                                  │ Unix socket + sandbox net
                          ┌───────────────────────▼─────────────────────┐
                          │         oneplatform-sandbox network          │
                          │                                              │
                          │  ┌──────────────────┐ ┌──────────────────┐ │
                          │  │  op-sandbox-vm   │ │  Docker sandbox  │ │
                          │  │ (isolated-vm)    │ │ containers       │ │
                          │  │  Node 20, no-net │ │ Python/Go/etc.   │ │
                          │  └──────────────────┘ └──────────────────┘ │
                          └─────────────────────────────────────────────┘

  Legend:
  ─── HTTP/HTTPS inter-service calls (X-Service-Token required)
  ─── Redis pub/sub channels (async, non-blocking)
  ─── BullMQ job queues (persistent, at-least-once)
  ─── Unix socket (Execution ↔ sandbox-vm, unidirectional JSON-RPC)
```

### User Personas and Primary Workflows

| Persona | Profile | Primary Workflow |
|---------|---------|-----------------|
| **Alex** (Data engineer) | Builds automated pipelines | Connect source → define ontology → configure pipeline → monitor in dashboard |
| **Jordan** (App developer) | Builds internal tools | Review ontology → create app in Monaco editor → test with live data → deploy |
| **Casey** (Non-technical) | Uploads data and needs quick apps | Upload CSV → review auto-inferred schema → confirm → generate starter app → share URL |
| **Sam** (DevOps / Platform admin) | Manages the platform deployment | `docker compose up` → bootstrap wizard → invite team → configure connectors via CLI |
| **Riley** (Plugin developer) | Extends the platform | `op plugin create` → implement TypeScript interface → `op plugin pack` → install on platform |

---

## 2. Infrastructure

### Docker Compose Stack

```
Containers (startup order by dependency layer):
                                                                     
Layer 0 — Init:
  op-init              alpine:3.19      One-shot: generate OP_MASTER_KEY + bootstrap token

Layer 1 — Data stores (depend on op-init success):
  postgres             postgres:16-alpine        Port 5432 (internal)
  redis                redis:7-alpine            Port 6379 (internal)
  minio                minio/minio:pinned        Ports 9000/9001 (loopback only)
  docker-socket-proxy  tecnativa/docker-socket-proxy  Restricted Docker API

Layer 2 — Core services (depend on postgres+redis healthy):
  auth-service         custom:latest     Port 3001 (internal)

Layer 3 — Data services (depend on auth + minio healthy):
  ontology-service     custom:latest     Port 3003 (internal)
  ingestion-service    custom:latest     Port 3002 (internal)
  logging-service      custom:latest     Port 3007 (internal)

Layer 4 — Processing services (depend on ontology + auth healthy):
  pipeline-service     custom:latest     Port 3004 (internal)
  execution-service    custom:latest     Port 3005 (internal, sandbox net)
  plugin-service       custom:latest     Port 3008 (internal)
  app-service          custom:latest     Port 3006 (internal)
  op-sandbox-vm        custom:sandbox    No ports (Unix socket only)

Layer 5 — Entry point (depends on ALL 9 services healthy):
  gateway-service      custom:latest     Port 3000 (public)
  frontend             custom:nginx      Port 80 (public, via Nginx)

Layer 6 — Optional observability profile:
  prometheus           prom/prometheus:v2.53.0
  jaeger               jaegertracing/all-in-one:1.58
  otel-collector       otel/opentelemetry-collector-contrib:0.104.0
```

### Volumes

```
Named volumes:
  postgres-data       PostgreSQL data
  redis-data          Redis AOF persistence
  minio-data          MinIO object storage
  init-data           Shared init data (master key, bootstrap token) — read-only by services
  gateway-data        Gateway service Ed25519 keypair (per-service, never shared)
  auth-data           Auth service keypair + WAL
  ingestion-data      Ingestion service keypair + WAL
  ontology-data       Ontology service keypair
  pipeline-data       Pipeline service keypair + WAL
  execution-data      Execution service keypair
  app-data            App service keypair
  logging-data        Logging service keypair
  plugin-data         Plugin service keypair
  sandbox-socket      Unix socket pair (Execution ↔ sandbox-vm, no other access)
  shared-pubkeys      /data/service-keys/ — Ed25519 public keys, read-only by all services
```

### Startup Sequence

```
1. op-init starts (Alpine, no network)
   a. Check /run/secrets/op_master_key (Docker secret, production)
   b. If absent: openssl rand -base64 32 → /data/init/master.key (0400)
   c. openssl rand -hex 32 → /data/init/bootstrap.token (0400)
   d. touch /data/init/ready → signal completion
   e. Exit 0 (failure = non-zero, blocks all dependents)

2. postgres, redis, minio start (parallel, depend on op-init success)
   - Docker Compose health checks: pg_isready / redis-cli ping / minio health
   - Services do NOT start until their data stores are healthy

3. auth-service starts (depends on postgres+redis healthy)
   - Reads bootstrap token into memory, erases /data/init/bootstrap.token after commit
   - Publishes Ed25519 public key to shared-pubkeys volume
   - Health check: GET /healthz + GET /readyz (checks postgres + redis connectivity)

4. ontology-service, ingestion-service, logging-service start (parallel)
   - Each publishes its public key to shared-pubkeys
   - Each loads ontology-aware role/permission tables on startup

5. pipeline-service, execution-service, plugin-service, app-service start (parallel)
   - op-sandbox-vm starts with execution-service (depends on execution healthy)

6. gateway-service + frontend start last (gateway depends on ALL services readyz)
   - Gateway waits for all 9 services /readyz before accepting external traffic
   - Startup timeout: 120s per service (Docker Compose health check retries)

7. On first request to /: Frontend calls GET /api/v1/auth/bootstrap/status
   - If not completed → render setup wizard
   - If completed → render login page
```

### Health Check Strategy

Every service implements two health endpoints:
- `GET /healthz` — liveness: process is alive, event loop not blocked. Docker Compose uses this.
- `GET /readyz` — readiness: all dependencies (postgres, redis, etc.) reachable. Gateway uses this before routing.

Both endpoints are unauthenticated, not rate-limited, and respond with `X-Response-Time` header. See ADR-29 for the full response schema.

### Network Topology (3-tier)

```
oneplatform-public    Gateway + Frontend only. Receives external traffic.
oneplatform-internal  All 9 services + PgBouncer + Redis + MinIO.
                      Services communicate here. Not externally reachable.
oneplatform-sandbox   Execution Service + op-sandbox-vm + Docker sandbox containers.
                      Completely isolated from internal network.
                      Execution Service bridges both networks (only service that does).
```

---

## 3. Data Architecture

### PostgreSQL: Per-Service Schemas

Single PostgreSQL 16 instance. Each service owns exactly one schema. Service database users have no cross-schema write access (with one documented exception for Ontology → Ingestion read access).

```
Schema          Owner                  Key tables
──────────────────────────────────────────────────────────────────────
auth            auth_service_role      users, sessions, oauth_clients,
                                       api_keys, roles, entity_permissions,
                                       tenants, bootstrap_state

ingestion       ingestion_service_role connectors, credentials (encrypted),
                                       sync_state, raw_{connectorId}*

ontology        ontology_service_role  entities, fields, relationships,
                                       mapping_rules, migrations,
                                       shadow_{entity}_{batch_id}*,
                                       shadow_table_registry,
                                       draft_ontologies

pipeline        pipeline_service_role  pipelines, pipeline_steps, runs,
                                       run_steps, schedules, triggers

execution       execution_service_role executions, execution_logs

app             app_service_role       apps, files, builds, env_vars,
                                       roles, tenant_shares, oauth_registrations,
                                       user_storage

logging         logging_service_role   events (time-partitioned monthly),
                                       audit_events

plugin          plugin_service_role    plugins, plugin_instances, hooks,
                                       approved_urls

gateway         gateway_service_role   webhooks, webhook_deliveries,
                                       rate_limit_config

tenant_{id}     ontology_service_role  {entityType}* (dynamic, per tenant)
                                       Created by Ontology Service during
                                       entity provisioning
```

*Dynamic tables created at runtime.

**Cross-schema access exception:** Ontology Service has `SELECT` on all tables in the `ingestion` schema (for mapping jobs). Enforced via `GRANT SELECT ON ALL TABLES IN SCHEMA ingestion TO ontology_service_role`. All other cross-schema access is forbidden.

**Row-Level Security (RLS):** All tables in `ingestion.raw_*` and `tenant_{id}.*` have RLS policies filtering on `app.tenant_id` session variable. Services set `SET LOCAL app.tenant_id = $1` before every tenant-scoped query.

### PgBouncer Configuration

```
Pool mode:
  Default (transaction mode): Gateway, Auth, Ingestion, App, Logging, Plugin, Execution
  Session mode (separate pool): Ontology, Pipeline
  Reason: LISTEN/NOTIFY and advisory locks require session-mode.

Connection allocation (server connections per service):
  gateway-service:    15
  auth-service:       20
  ingestion-service:  25
  ontology-service:   15  (session mode)
  pipeline-service:   25  (session mode)
  execution-service:  10
  app-service:        15
  logging-service:    30  (highest write volume)
  plugin-service:     10
  Total:             165  (Postgres max_connections: 200, headroom for direct admin)

PgBouncer:
  max_client_conn: 200
  default_pool_size: 20
```

### Redis: Key-Prefix ACL Table (Canonical — ADR-5)

All services operate on Redis DB 0. Logical separation is by key prefix. `SELECT` is denied for all service users.

```
Service           Redis username      Allowed key prefixes              Allowed channels
─────────────────────────────────────────────────────────────────────────────────────────
Auth              op_auth             ~auth:* ~revocation:* ~reset:*    &auth:* &revocation:*
Pipeline          op_pipeline         ~queue:pipeline:* ~queue:execution:* &ontology:*
Logging           op_logging          ~log:* ~audit:*                   &logs:* &audit:*
Gateway           op_gateway          ~ratelimit:* ~gateway:* ~webhook:* &events:*
Ingestion         op_ingestion        ~queue:ingestion:* ~ingestion:sync:* &ontology:*
Ontology          op_ontology         ~ontology:*                       &ontology:*
App               op_app              ~guest-session:*                  &events:*
Plugin            op_plugin           ~plugin:*                         &events:*
Execution         (none)              No Redis access at all
op-sandbox-vm     (none)              No Redis access at all

Denied for ALL service users: SELECT, FLUSHDB, FLUSHALL, KEYS, DEBUG
```

### MinIO: Buckets and IAM

```
Bucket            Owner service     Access                            Retention
──────────────────────────────────────────────────────────────────────────────────
app-builds        App Service       App Service: rw / Others: none   Last 20 builds per app
file-uploads      Ingestion Service Ingestion: rw / Others: none     Configurable (default 30d)
plugin-bundles    Plugin Service    Plugin: rw / Execution: r        Until uninstall + 7d
config-exports    Gateway Service   Gateway: rw / Others: none       24h (presigned URL)
```

Server-side encryption (`SSE-S3`, AES-256) enabled on all buckets. MinIO is on `oneplatform-internal` only — no public port. Services connect via `http://minio:9000`. S3-compatible; set `OP_S3_ENDPOINT` to swap to AWS S3/Cloudflare R2 with no code changes.

### Data Flow: Ingestion to Query

```
External source
      │
      │ Connector.fetchBatch() / webhook POST / file upload
      ▼
Ingestion Service
      │  Normalize to DataEnvelope
      │  Write to ingestion.raw_{connectorId} (JSONB, GIN index)
      │  Enqueue ontology:map BullMQ job
      ▼
Ontology Service (mapping worker)
      │  Read batch from ingestion.raw_{connectorId}
      │  Apply mapping rules (expression transforms via Execution sandbox)
      │  Validate against entity Zod schema
      │  Write valid records to tenant_{tenantId}.{entityType} (upsert)
      │  Write failures to ontology.mapping_errors
      │  Emit data.created / data.updated events via Redis pub/sub
      ▼
tenant_{tenantId}.{entityType} table
      │
      │ Queried by:
      ├─→ Gateway (auto-generated REST endpoints)
      ├─→ App Service BFF (useQuery hooks)
      ├─→ Pipeline Service (step data access)
      └─→ Ontology Service (migration, union views)

Raw data retention: ingestion.raw_{connectorId} rows kept until manually purged or
retention policy expires. This enables schema remapping without re-ingestion.
```

---

## 4. Authentication and Authorization

### Auth Flows

#### Email/Password Registration and Login

```
Registration:
  POST /api/v1/auth/register
    { email, password, tenantId (or new tenant name) }
    → Zod validation → bcrypt hash (cost 12)
    → INSERT auth.users
    → If OP_REQUIRE_EMAIL_VERIFICATION=true: send verification email
    → Return { data: { userId, accessToken, refreshToken } }

Login:
  POST /api/v1/auth/login
    { email, password }
    → Lookup user by email
    → bcrypt.compare(password, hash)
    → If valid: issue access token + refresh token
    → refresh token → Redis SET auth:refresh:{jti} userId TTL=604800
    → Return { data: { accessToken, refreshToken, expiresIn: 900 } }
```

#### OAuth (GitHub, Google)

```
Browser initiates:
  GET /api/v1/auth/oauth/{provider}/authorize
    → Auth Service generates state (CSRF token, stored in Redis TTL=600s)
    → Redirect to provider authorization URL with state + PKCE code_challenge

Callback:
  GET /api/v1/auth/oauth/{provider}/callback?code=...&state=...
    → Validate state from Redis (constant-time comparison)
    → Exchange code for provider tokens
    → Upsert user in auth.users (by provider_id or email)
    → Issue platform access token + refresh token
    → Redirect to platform with tokens in httpOnly cookies
```

#### API Keys

```
Creation:
  POST /api/v1/auth/keys
    { name, scopes[], expiresAt? }
    → Generate: op_live_{32-char-random}
    → bcrypt hash of full key
    → Store hash in auth.api_keys
    → Return full key ONCE (never retrievable again)
    → keyPrefix (first 8 chars) stored for identification

Validation (on every API request):
  Gateway middleware:
    → Extract Bearer token or X-API-Key header
    → Hash incoming key → lookup in auth.api_keys by prefix
    → bcrypt.compare(incoming, stored_hash)
    → Verify scopes cover required endpoint scope
    → Check revocation: Redis SET revocation:{keyId}
    → Set c.var.user = { userId, tenantId, scopes, roles }
```

### JWT Strategy

```
Access tokens:
  - JWT, signed with HMAC-SHA256 (HS256) using OP_JWT_SECRET
  - 15-minute expiry
  - Payload: { sub: userId, tid: tenantId, roles: string[], scopes: string[], jti: uuid, iat, exp }
  - Revocation: checked against Redis SET revocation:{jti} on EVERY request (O(1))

Refresh tokens:
  - Opaque 32-byte random hex string
  - Stored in Redis: auth:refresh:{token} → userId, TTL=604800 (7 days)
  - Rotated on each use: old token deleted, new token issued
  - Never returned in API responses after initial issuance

Revocation strategies:
  - Immediate (compromised key): add jti to Redis revocation:{jti} SET
  - Refresh token compromise: delete auth:refresh:{token} from Redis
  - Emergency (Redis outage + compromise): op auth emergency-rotate
    → Rotate OP_JWT_SECRET → ALL access tokens immediately invalid
    → All users must re-authenticate (nuclear option, ops guide documented)
```

### Service-to-Service Authentication

Every inter-service HTTP request carries `X-Service-Token: {Ed25519 JWT}`.

```
Key lifecycle:
  1. Service starts → generate Ed25519 keypair if /data/service.key absent
  2. Private key: stored at /data/service.key on per-service named volume
  3. Public key: published to shared read-only volume /data/service-keys/{name}.pub
  4. All services load all public keys at startup (inotify watch for hot-reload)

Token structure:
  { sub: "pipeline-service", role: "service", iat, exp: iat+300 (5min), jti: uuid }
  Signed with caller's private key.

Validation by receiving service (in @oneplatform/core serviceAuth middleware):
  1. Verify Ed25519 signature against /data/service-keys/{caller}.pub
  2. Verify sub matches known service name
  3. Check service RBAC matrix: is caller allowed to call this endpoint?
     Matrix is compiled into @oneplatform/core/service-rbac.ts at build time.
     Cannot be modified at runtime.
  4. If X-User-Context header present, validate it came with a valid X-Service-Token
     (headers are validated TOGETHER — neither accepted without the other)

Key rotation:
  op service rotate-keys --service pipeline
  → New keypair generated
  → New public key published
  → 5-minute overlap: both old and new keys accepted
  → Old key removed after overlap
```

### Service RBAC Permission Matrix (Complete)

Defined in `@oneplatform/core/service-rbac.ts`. Compiled at build time.

```
Caller                Target              Allowed endpoints
─────────────────────────────────────────────────────────────────────
gateway-service       ALL services        ALL endpoints (entry point)
auth-service          (none outbound)     N/A
ingestion-service     ontology-service    POST /internal/ontology/map
                                          POST /internal/ontology/infer
                      pipeline-service    POST /internal/pipeline/trigger
                      execution-service   POST /internal/execution/connector-run
                      plugin-service      GET /internal/plugins/connectors
ontology-service      execution-service   POST /internal/execution/run
                                          (expression transforms in sandbox)
pipeline-service      execution-service   POST /internal/execution/run
                      ontology-service    GET /internal/ontology/schema
                      plugin-service      GET /internal/plugins/hooks
app-service           auth-service        GET /internal/auth/validate
                                          POST /internal/auth/guest-sessions
                                          POST /internal/oauth/clients
                      ontology-service    GET /internal/ontology/schema
                      pipeline-service    POST /internal/pipeline/trigger
                      execution-service   POST /internal/execution/run
                      logging-service     GET /internal/logging/query
                      plugin-service      GET /internal/plugins/widgets
execution-service     plugin-service      GET /internal/plugins/{id}/bundle
logging-service       (none outbound)     N/A (receive-only)
plugin-service        execution-service   POST /internal/execution/run
                                          POST /internal/execution/plugin-drain
                                          POST /internal/execution/plugin-cache-invalidate
                      ingestion-service   POST /internal/ingestion/connectors
                                          DELETE /internal/ingestion/connectors/{id}
```

### Browser Auth: OAuth + PKCE + BFF Cookies

```
Browser apps NEVER hold API keys.
Session management:
  - Cookie: op_session={refreshTokenRef}; HttpOnly; Secure; SameSite=Strict; Max-Age=604800
  - App Service BFF exchanges refresh token for short-lived access JWT internally
  - Browser never sees the access JWT

CSRF protection:
  - SameSite=Strict eliminates CSRF for same-domain apps
  - For subdomain apps: Origin header validated against app's registered origin

Guest sessions (Public apps):
  - Cookie: op_guest_session={32-byte random hex}; HttpOnly; Secure; SameSite=Strict
  - Stored in Redis: guest-session:{token} → { tenantId, appId, createdAt }, TTL=86400
  - Rate limit: 100 req/min per IP for guest requests
```

### App Access Modes

```
Platform-User Only (default):
  - op_session cookie required on every request
  - Only members of app.tenantId can authenticate
  - Cross-tenant sharing requires explicit app.tenant_shares entry

Public/Guest Access (opt-in):
  - PATCH /api/v1/apps/{id} with { accessMode: "public" }
  - Requests without op_session receive guest session automatically
  - Guest role: read-only on entities marked public:true in ontology
  - useUser().isGuest === true, useUser().email === null
```

### API Key Scopes

| Scope | Grants |
|-------|--------|
| `data:read` | GET /api/v1/data/** |
| `data:write` | POST/PATCH/DELETE /api/v1/data/** |
| `ontology:read` | GET /api/v1/ontology/** |
| `ontology:write` | POST/PATCH/DELETE /api/v1/ontology/** |
| `pipelines:read` | GET /api/v1/pipelines/**, runs |
| `pipelines:trigger` | Trigger + cancel pipeline runs |
| `pipelines:manage` | Full pipeline CRUD + trigger |
| `apps:read` | GET /api/v1/apps/** |
| `apps:deploy` | Deploy + rollback apps |
| `apps:manage` | Full app CRUD + deploy |
| `plugins:read` | GET /api/v1/plugins/** |
| `plugins:manage` | Full plugin lifecycle |
| `users:read` | GET /api/v1/users/** |
| `users:manage` | Full user + role management |
| `logs:read` | GET /api/v1/logs/** |
| `webhooks:manage` | Full outbound webhook CRUD |
| `execution:run` | POST /api/v1/exec/** |
| `admin` | All of the above |

### Predefined Roles

| Role | Scope | Effective scopes |
|------|-------|-----------------|
| `platform-admin` | Global | `admin` + cross-tenant access |
| `tenant-admin` | Per-tenant | `admin` within tenant |
| `developer` | Per-tenant | `editor` + `apps:deploy` + `execution:run` + `plugins:read` |
| `editor` | Per-tenant | `data:write`, `ontology:read`, `pipelines:manage`, `apps:manage` |
| `viewer` | Per-tenant | `data:read`, `ontology:read`, `pipelines:read`, `apps:read`, `logs:read` (own) |

### Password Reset and Email Verification

```
Password Reset:
  POST /api/v1/auth/forgot-password  { email }
    → Always returns 200 (prevents email enumeration)
    → Generate signed JWT: { sub:userId, purpose:"password-reset", jti:uuid }, exp: 1h
    → Redis SET reset:{jti} 1 TTL=3600
    → Send email (or link-copy mode if SMTP unconfigured)

  POST /api/v1/auth/reset-password/{token}  { newPassword, confirmPassword }
    → Verify JWT signature + expiry
    → Check Redis reset:{jti} exists (single-use)
    → DEL reset:{jti} from Redis
    → Update bcrypt hash in auth.users
    → Delete all refresh tokens for user (forces re-auth everywhere)

Email Verification (if OP_REQUIRE_EMAIL_VERIFICATION=true):
  → On register: create user with emailVerified:false
  → Issue JWT: { purpose:"email-verify", jti }, TTL 24h
  → Unverified users get access tokens with unverified:true claim
  → Gateway downgrades unverified users to viewer role maximum
  → GET /api/v1/auth/verify-email/{token} → mark emailVerified:true

Bootstrap exception:
  First admin created via bootstrap wizard is auto-verified regardless of setting.
```

### First-Run Bootstrap

```
op-init generates:
  /data/init/master.key      (AES-256-GCM master key, chmod 0400)
  /data/init/bootstrap.token (32-byte hex, chmod 0400)
  /data/init/ready           (signals completion)

Auth Service startup:
  1. Read bootstrap.token into memory
  2. Erase /data/init/bootstrap.token (after first successful DB commit)
  3. Check auth.bootstrap_completed flag in Postgres

Bootstrap endpoint (one-time):
  POST /api/v1/auth/bootstrap
    { adminEmail, adminPassword, tenantName, bootstrapToken }
    → Constant-time compare bootstrapToken vs in-memory value
    → In single transaction: create tenant + admin user + set bootstrap_completed=true
    → Return { data: { tenantId, adminUserId, sessionToken } }
    → Zero bootstrapToken from memory
    → All subsequent calls return 410 Gone
    → Rate limit: 3 attempts per 10min per IP (in-memory, no Redis dependency)

Setup wizard (served by Frontend):
  1. GET /api/v1/auth/bootstrap/status → { completed: boolean }
  2. If false → render 6-screen wizard (Welcome, Admin account, Org name,
     Master key confirmation with 60s auto-clear, Review, Success)
  3. POST /api/v1/auth/bootstrap → create platform
  4. Redirect to login page
```

---

## 5. Core Library

### What @oneplatform/core Provides

`@oneplatform/core` is the zero-boilerplate backbone for all 9 services. A new service imports it once and immediately has:

```
DB clients          Postgres (per-service schema), Redis (per-service ACL user)
Auth middleware     User session validation + API key validation + scope enforcement
Service auth        X-Service-Token validation + service RBAC matrix enforcement
Queue helpers       BullMQ client factory, DLQ setup, WAL writer, retry policies
Log/audit helpers   Structured log publisher (async Redis pub/sub), audit queue writer
OTEL instrumentation Auto-instrumented Hono routes, BullMQ workers, Postgres, Redis
Error handling      Typed error registry, envelope serializer, stack trace suppression
Config loader       OP_* env var loader with validation, OP_MASTER_KEY reader
Health checks       /healthz and /readyz endpoint factories
Encryption          AES-256-GCM encrypt/decrypt, HKDF-SHA256 key derivation
Rate limit helpers  Redis sliding window counter helpers
Ontology cache      In-memory ontology snapshot with pub/sub + 5min poll fallback
OpenAPI generator   Introspects Hono routes + Zod schemas → OpenAPI 3.1 spec
Cursor helpers      Cursor encode/decode with HMAC-SHA256 signing
Event publisher     Redis pub/sub event emitter for platform events
```

### The Middleware Stack (createApp())

Every service calls `createApp(config)` from `@oneplatform/core`. The resulting Hono app has this middleware stack, applied in order, to every request:

```
1.  requestId           W3C Trace Context: propagate or generate X-Request-ID
2.  otelInstrumentation Start OTEL span per request, propagate trace context
3.  cors                Enforce OP_ALLOWED_ORIGINS (origin validation + headers)
4.  rateLimit           Delegate to Gateway rate limiter via Redis (skip for internal)
5.  auth                Validate Bearer token / API key / session cookie → c.var.user
6.  serviceAuth         On internal routes: validate X-Service-Token + service RBAC check
7.  responseEnvelope    Wrap route return value in { data: T } envelope
8.  errorHandler        Catch all thrown errors → { error: { code, message, requestId } }
9.  rateLimitHeaders    Append X-RateLimit-* headers to response
10. deprecationHeaders  Append Deprecation/Sunset/Link headers if route marked deprecated
```

Services register their routes. Middleware compliance is automatic. Routes cannot accidentally bypass the envelope or error format because they are middleware, not opt-in decorators.

### Service RBAC Permission Matrix

See section 4. The matrix is in `@oneplatform/core/service-rbac.ts`. It is compiled into the core library at build time. Modifying inter-service permissions requires: (1) update the matrix in `core/service-rbac.ts`, (2) rebuild core, (3) redeploy all services. No runtime modification is possible.

### Shared Types and Utilities

```typescript
// Canonical types exported from @oneplatform/core

// API contract types
interface ApiResponse<T> { data: T }
interface ApiError { error: { code: string; message: string; details?: unknown; requestId: string } }
interface PaginatedResponse<T> { data: T[]; pagination: { nextCursor: string | null; total: number | null } }

// User context (populated by auth middleware)
interface UserContext {
  userId: string; tenantId: string; roles: string[];
  scopes: string[]; isGuest: boolean; isService: boolean; emailVerified: boolean;
}

// Event envelope (canonical event schema — ADR-30)
interface PlatformEvent {
  eventId: string; eventType: string; eventVersion: string;
  tenantId: string; timestamp: string;
  actor: { type: "user" | "service" | "system"; id: string; displayName?: string };
  data: Record<string, unknown>;
}

// Data envelope (ingestion — ADR-28)
interface DataEnvelope {
  _id: string; _source: string; _ingestedAt: string; _connectorId: string;
  _batchId: string; _tenantId: string; _syncMode: "full" | "incremental";
  _cursor: string | null; data: Record<string, unknown>;
}

// Error registry (all codes in @oneplatform/core/errors.ts)
// See Section 6 for full error code table
```

---

## 6. API Design

### URL Conventions

```
Base prefix:        /api/v1/
Single resource:    GET    /api/v1/{resource}/{id}
Collection:         GET    /api/v1/{resource}
Create:             POST   /api/v1/{resource}            → 201 Created
Partial update:     PATCH  /api/v1/{resource}/{id}       → 200 OK
Full replace:       PUT    /api/v1/{resource}/{id}        → 200 OK
Delete:             DELETE /api/v1/{resource}/{id}        → 204 No Content
Sub-resource:       GET    /api/v1/{resource}/{id}/{sub}
Sub-resource item:  GET    /api/v1/{resource}/{id}/{sub}/{subId}
Bulk operation:     POST   /api/v1/{resource}/bulk       → 207 Multi-Status
Entity data:        GET    /api/v1/data/{entityType}
Entity record:      GET    /api/v1/data/{entityType}/{id}

Resource names: plural, lowercase, hyphenated.
  Examples: /api/v1/connector-instances, /api/v1/pipeline-runs, /api/v1/api-keys
  Reserved keyword: "bulk" (cannot be a resource ID — validated by core)
```

### Request/Response Envelopes

```json
// Single resource success:
{ "data": { "id": "abc", "name": "..." } }

// Collection success:
{
  "data": [{ "id": "abc", ... }, ...],
  "pagination": { "nextCursor": "eyJpZCI6...", "total": 1543 }
}
// total is null for collections > 100k rows (cost-prohibitive COUNT)

// Error (all 4xx and 5xx):
{
  "error": {
    "code": "ENTITY_NOT_FOUND",
    "message": "Customer with id '123' does not exist in this tenant.",
    "details": { "entityType": "customer", "id": "123" },
    "requestId": "01J4WZJHK8GN9..."
  }
}
```

### Error Code Registry

Defined in `@oneplatform/core/errors.ts`. Services may extend with `{SERVICE}_` prefix.

| Code | HTTP | Description |
|------|------|-------------|
| `UNAUTHORIZED` | 401 | Missing or invalid authentication |
| `FORBIDDEN` / `PERMISSION_DENIED` | 403 | Authenticated, insufficient permissions |
| `INSUFFICIENT_SCOPE` | 403 | API key missing required scope |
| `NOT_FOUND` / `ENTITY_NOT_FOUND` | 404 | Resource does not exist |
| `CONFLICT` | 409 | Unique constraint violation |
| `VALIDATION_ERROR` | 422 | Request body failed Zod validation |
| `RATE_LIMIT_EXCEEDED` | 429 | Rate limit hit |
| `INTERNAL_ERROR` | 500 | Unexpected server error (safe message only) |
| `SERVICE_UNAVAILABLE` | 503 | Dependency (Postgres, Redis) unavailable |
| `PAGINATION_LIMIT_EXCEEDED` | 400 | limit > 100 |
| `INVALID_CURSOR` | 400 | Cursor HMAC signature invalid |
| `CURSOR_EXPIRED` | 410 | Cursor older than 24 hours |
| `BULK_LIMIT_EXCEEDED` | 400 | Bulk items > 500 |
| `ORIGIN_NOT_ALLOWED` | 403 | CORS origin not in allowlist |
| `UNKNOWN_FILTER_FIELD` | 400 | Filter on non-existent field |
| `UNSORTABLE_FIELD` | 400 | Sort on non-indexed field |

Stack traces are NEVER included in API error responses. Logged internally at DEBUG level, accessible to admins by requestId.

### Pagination (Cursor-Based)

```
Request:  GET /api/v1/{resource}?cursor={base64}&limit={n}
Default limit: 50. Maximum limit: 100.

Cursor: base64-encoded JSON { "id": "last-id", "createdAt": "..." }
  - HMAC-SHA256 signed with OP_CURSOR_SECRET (generated by op-init)
  - Expires 24 hours (returns 410 Gone with CURSOR_EXPIRED on expiry)
  - Opaque to clients: internal structure is not an API contract
  - Offset pagination NOT supported (O(n) database cost)
```

### Filter DSL

```
Syntax: ?filter[{field}][{op}]={value}

Operators:
  eq    exact match
  neq   not equal
  gt    greater than
  gte   greater than or equal
  lt    less than
  lte   less than or equal
  like  SQL ILIKE (% and _ wildcards)
  in    comma-separated OR list: filter[status][in]=active,pending
  null  IS NULL / IS NOT NULL: filter[field][null]=true|false

Multiple field filters: ANDed together.
Deep JSONB: dot notation, max 3 levels: filter[data.address.city][eq]=London
Unknown field names: 400 UNKNOWN_FILTER_FIELD
Values: always parameterized in SQL (no string interpolation)
```

### Sorting

```
Syntax: ?sort=field1,-field2  (- prefix = descending)
Multiple fields: comma-separated
Default: createdAt DESC
Non-indexed field sort: 400 UNSORTABLE_FIELD with hint listing valid fields
```

### Field Selection

```
Syntax: ?fields=id,name,status,owner.email
Relationships: max 1 level deep (owner.email allowed; owner.department.name not)
Unknown fields: silently ignored (forward-compatible)
```

### Bulk Operations

```
POST /api/v1/{resource}/bulk
{
  "operation": "create" | "update" | "delete",
  "transactional": false,   // true = all-or-nothing (if service supports it)
  "items": [ {...}, {...} ]
}

Response 207 Multi-Status:
{
  "results": [
    { "index": 0, "id": "...", "status": "success" },
    { "index": 1, "status": "error", "error": { "code": "...", "message": "..." } }
  ],
  "summary": { "total": 100, "succeeded": 98, "failed": 2 }
}

Maximum items: 500. Validation runs on ALL items before any are executed.
```

### Rate Limiting

```
Tiers:
  Global:          10,000 req/min platform-wide (OP_GLOBAL_RATE_LIMIT)
  Per-tenant:      1,000 req/min per tenant (configurable per tier)
  Per-API-key:     500 req/min per key (configurable at key creation)
  Webhook inbound: 100 req/sec per webhook endpoint

Burst: 2x burst allowed for 5 seconds
Storage: Redis sliding window counters (~ratelimit:* prefix)

Headers on every response:
  X-RateLimit-Limit: 1000
  X-RateLimit-Remaining: 987
  X-RateLimit-Reset: 1735689600 (Unix timestamp of window reset)
  X-RateLimit-Policy: global | per-tenant | per-api-key | webhook

On 429: Retry-After: {seconds}

Redis outage fallback:
  Local in-memory sliding window per Gateway instance
  Limit = floor(normal_limit / replica_count)
  Replica count: Redis key > cached value > OP_GATEWAY_REPLICAS env var
  Cold start with no data: 100 req/min global hard limit (safe conservative default)
```

### API Versioning and Deprecation

```
Version prefix: /api/v1/, /api/v2/
Breaking changes increment version. Old versions supported 6 months after deprecation.

Deprecated endpoint headers (RFC 8594):
  Deprecation: true
  Sunset: Sat, 01 Jan 2028 00:00:00 GMT
  Link: <https://docs.oneplatform.dev/api/v2/endpoint>; rel="successor-version"

Core provides: @deprecated({ sunset: Date, successorUrl: string }) route decorator
```

### OpenAPI Spec Generation

```
URL: GET /api/v1/openapi.json
  - Tenant-aware: includes auto-generated routes for tenant's ontology entities
  - Generated at request time from Hono route registry + Zod schemas
  - Cached in Redis: ontology:{tenantId}:{schemaVersion} TTL=300s
  - Invalidated on ontology changes (schemaVersion bump)
  - Rendered as interactive API explorer at GET /docs/api (Scalar or Stoplight Elements)
  - All 9 services contribute their route definitions; Gateway aggregates at /api/v1/openapi.json

Generation pipeline:
  turbo run docs:generate → regenerates all docs
  CI: doc drift check — code change that causes spec drift fails CI
```

### Health Endpoints

```
GET /healthz    Liveness  { status:"ok", service:"{name}", version:"{semver}" }
GET /readyz     Readiness { status:"ready"|"not-ready", checks:{ postgres:"ok", redis:"ok" } }

Not rate-limited. Not auth-protected. Always reachable.
X-Response-Time header on both responses.
Docker Compose uses /healthz. Gateway uses /readyz.
```

### CORS Policy

```
Configured via OP_ALLOWED_ORIGINS (comma-separated origins)
Development default: http://localhost:3000
Production: MUST be set explicitly. Wildcard * rejected in production.

Headers set:
  Access-Control-Allow-Origin: {matching origin}
  Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
  Access-Control-Allow-Headers: Authorization, Content-Type, X-API-Key, X-Requested-With
  Access-Control-Expose-Headers: X-RateLimit-*, X-OnePlatform-Request-ID
  Access-Control-Max-Age: 86400
  Access-Control-Allow-Credentials: true (when specific origin configured)

Unlisted origins: 403 ORIGIN_NOT_ALLOWED (not a CORS error — prevents info leakage)
```

---

## 7. Service Designs (Summary)

Full L2 designs are written to `docs/designs/{service-name}.md` for each service. This section provides the summary reference.

### 7.1 Gateway Service (port 3000)

**Responsibility:** The single external entry point for all API traffic. Handles TLS termination, CORS, multi-tier rate limiting, auth token validation, request routing to internal services, auto-generated REST endpoint routing (for ontology-typed data), outbound webhook delivery, and SSE event streaming.

**Key API endpoints:**
```
/* (all /api/v1/ routes — proxied to respective services)
GET  /api/v1/data/{entityType}         auto-generated by ontology
GET  /api/v1/data/{entityType}/{id}
POST /api/v1/data/{entityType}
POST /api/v1/data/{entityType}/bulk
GET  /api/v1/events/stream             SSE event subscription
POST /api/v1/webhooks/outbound         register outbound webhook
GET  /api/v1/webhooks/outbound/{id}/deliveries
POST /api/v1/webhooks/outbound/{id}/test
GET  /healthz  GET /readyz
GET  /api/v1/openapi.json
```

**Database tables (gateway schema):**
```
gateway.webhooks            Registered outbound webhooks (url, events[], secret_hash)
gateway.webhook_deliveries  Last 100 deliveries per webhook (7-day retention)
gateway.rate_limit_config   Per-tenant rate limit tier overrides
```

**Inter-service dependencies:** Routes to all 9 services. Subscribes to Redis `events:*` channels for webhook fan-out.

**Key design decisions:** Rate limiting with Redis + in-memory fallback (ADR-20). Outbound webhook delivery via BullMQ with 9-attempt retry schedule (ADR-30). SSRF prevention on webhook URLs (ADR-30). SSE per-tenant ring buffer (1000 events, LRU) for replay.

---

### 7.2 Auth Service (port 3001)

**Responsibility:** All authentication and authorization. Email/password and OAuth login, JWT issuance and revocation, refresh token lifecycle, API key management, RBAC role and permission storage, ontology-aware entity/field/row-level permission checks, bootstrap endpoint.

**Key API endpoints:**
```
POST /api/v1/auth/register
POST /api/v1/auth/login
POST /api/v1/auth/logout
POST /api/v1/auth/refresh
POST /api/v1/auth/bootstrap
GET  /api/v1/auth/bootstrap/status
POST /api/v1/auth/forgot-password
POST /api/v1/auth/reset-password/{token}
GET  /api/v1/auth/verify-email/{token}
GET  /api/v1/auth/oauth/{provider}/authorize
GET  /api/v1/auth/oauth/{provider}/callback
POST /api/v1/auth/keys
GET  /api/v1/auth/keys
DELETE /api/v1/auth/keys/{id}
POST /api/v1/auth/keys/{id}/rotate
GET  /api/v1/roles
POST /api/v1/roles
PATCH /api/v1/roles/{id}
GET  /internal/auth/validate    (service-only)
POST /internal/auth/guest-sessions  (service-only)
POST /internal/oauth/clients    (service-only)
GET  /internal/auth/master-key-display  (bootstrap only, disabled after bootstrap)
```

**Database tables (auth schema):**
```
auth.users              id, email, password_hash, email_verified, tenant_id, roles[], created_at
auth.sessions           id, user_id, refresh_token_jti, created_at, expires_at
auth.api_keys           id, user_id, name, key_hash, key_prefix, scopes[], expires_at, last_used_at
auth.oauth_providers    provider, provider_user_id, user_id, tokens (encrypted)
auth.tenants            id, name, created_at
auth.roles              id, tenant_id, name, permissions[], description
auth.entity_permissions tenant_id, entity_type, role, actions[], field_restrictions, row_filter
auth.oauth_clients      client_id, client_type, redirect_uris[], allowed_scopes[], tenant_id, app_id
auth.bootstrap_state    bootstrap_completed (boolean, single row)
```

**Inter-service dependencies:** None (receives calls, makes no outbound service calls). Redis for revocation, refresh tokens, reset tokens, OAuth state.

**Key design decisions:** Ed25519 service tokens for inter-service auth (ADR-19). Bootstrap endpoint single-use with timing-safe comparison (ADR-24). Password reset via signed JWT + Redis single-use (ADR-36). Link-copy mode when SMTP unconfigured (ADR-36).

---

### 7.3 Ingestion Service (port 3002)

**Responsibility:** All data ingestion: pull connectors (REST, PostgreSQL, MySQL, CSV, file), push receivers (webhook endpoints, file uploads), stream listeners, credential vault, raw data staging, sync job orchestration.

**Key API endpoints:**
```
GET  /api/v1/connectors
POST /api/v1/connectors
GET  /api/v1/connectors/{id}
PATCH /api/v1/connectors/{id}
DELETE /api/v1/connectors/{id}
POST /api/v1/connectors/{id}/test
POST /api/v1/connectors/{id}/trigger
GET  /api/v1/connectors/{id}/syncs
GET  /api/v1/connectors/{id}/syncs/{syncId}/progress
POST /api/v1/webhooks/inbound        register webhook receiver
POST /api/v1/webhooks/inbound/{id}/receive   (public, receives events)
POST /api/v1/uploads                 file upload (multipart)
GET  /api/v1/uploads/{id}/status
POST /internal/ingestion/connectors  (plugin registration — service-only)
DELETE /internal/ingestion/connectors/{id}
```

**Database tables (ingestion schema):**
```
ingestion.connectors        id, tenant_id, plugin_id, instance_id, name, config (JSONB)
ingestion.credentials       id, connector_id, encrypted_blob, key_version, salt
ingestion.sync_state        connector_id, last_cursor, last_sync_at, sync_mode
ingestion.raw_{connectorId} _id, _source, _ingested_at, _batch_id, _sync_mode, _cursor, data JSONB
ingestion.webhook_receivers id, tenant_id, path, secret_hash, connector_id
ingestion.upload_jobs       id, tenant_id, filename, status, connector_id, rows_processed
```

**Inter-service dependencies:** Ontology (map data, infer schema), Pipeline (trigger on ingest), Execution (run connector plugin code), Plugin (list available connectors).

**Key design decisions:** AES-256-GCM credential vault with HKDF-SHA256 per-credential salt (ADR-11). DataEnvelope canonical format (ADR-28). Raw data retained for schema remapping. Batch/incremental sync with cursor atomicity (ADR-28). Memory-bounded streaming via Node.js Transform streams.

---

### 7.4 Ontology Service (port 3003)

**Responsibility:** The schema engine. Manages entity definitions, field types, relationships, and mapping rules. Generates TypeScript types, Zod validators, API route definitions, and permission rules from ontology. Handles schema migrations (UNION views, shadow tables). Publishes schema change events.

**Key API endpoints:**
```
GET  /api/v1/ontology
POST /api/v1/ontology
GET  /api/v1/ontology/{entityType}
PATCH /api/v1/ontology/{entityType}
DELETE /api/v1/ontology/{entityType}
POST /api/v1/ontology/{entityType}/validate
GET  /api/v1/ontology/migrations
GET  /api/v1/ontology/migrations/{id}
POST /api/v1/ontology/migrations/{id}/confirm
POST /api/v1/ontology/migrations/{id}/rollback
GET  /api/v1/ontology/migrations/{id}/status
GET  /internal/ontology/schema               (service-only)
POST /internal/ontology/map                  (service-only)
POST /internal/ontology/infer                (service-only)
```

**Database tables (ontology schema):**
```
ontology.entities           id, tenant_id, name, version, description, created_at
ontology.fields             id, entity_id, name, type, required, nullable, default_value
ontology.relationships      id, from_entity, to_entity, type (1:1|1:N|M:N), field_name
ontology.mapping_rules      id, connector_id, source_field_path, target_entity, target_field,
                            transform_type, transform (JS expression)
ontology.migrations         id, entity_id, from_version, to_version, status, started_at,
                            completed_at, migration_job_id
ontology.shadow_table_registry id, entity_type, batch_id, row_count, created_at, migration_id
ontology.mapping_errors     id, connector_id, raw_id, entity_type, error_fields[], raw_data JSONB
ontology.draft_ontologies   id, tenant_id, connector_id, inferred_schema JSONB, status
```

**Inter-service dependencies:** Execution (expression transforms in sandbox). Publishes to Redis `&ontology:*` channels on schema changes.

**Key design decisions:** Backward-compatible vs breaking change detection (ADR-14). UNION view dual-schema during migration with 10s timeout (ADR-14). Per-batch shadow tables in single transaction (ADR-14). Three-tier orphan cleanup with row count verification (ADR-14). Ontology cache pub/sub + 5-min poll safety net (ADR-12). Code generation: produces TS types, Zod validators, API routes.

---

### 7.5 Pipeline Service (port 3004)

**Responsibility:** Workflow orchestration engine. Defines multi-step pipelines with conditional branching, manages cron and event-driven triggers, executes pipeline runs via BullMQ, coordinates hook resolution and execution, tracks run state.

**Key API endpoints:**
```
GET  /api/v1/pipelines
POST /api/v1/pipelines
GET  /api/v1/pipelines/{id}
PATCH /api/v1/pipelines/{id}
DELETE /api/v1/pipelines/{id}
POST /api/v1/pipelines/{id}/trigger
GET  /api/v1/pipelines/{id}/runs
GET  /api/v1/pipeline-runs/{runId}
POST /api/v1/pipeline-runs/{runId}/cancel
GET  /api/v1/pipeline-runs/{runId}/logs        SSE streaming
GET  /api/v1/schedules
POST /api/v1/schedules
PATCH /api/v1/schedules/{id}
DELETE /api/v1/schedules/{id}
POST /internal/pipeline/trigger               (service-only)
```

**Database tables (pipeline schema):**
```
pipeline.pipelines     id, tenant_id, name, definition JSONB (steps, triggers), created_at
pipeline.runs          id, pipeline_id, status, triggered_by, started_at, completed_at, error
pipeline.run_steps     id, run_id, step_id, step_name, status, started_at, completed_at, output JSONB
pipeline.schedules     id, pipeline_id, cron_expr, enabled, last_run_at, next_run_at
pipeline.triggers      id, pipeline_id, trigger_type (event|webhook|manual), config JSONB
```

**Inter-service dependencies:** Execution (run step code + hooks), Ontology (schema lookups), Plugin (resolve hook chains). Uses session-mode PgBouncer for advisory locks (ADR-5).

**Key design decisions:** BullMQ with DLQ, exponential backoff, poison-pill detection (ADR-13). Hook linearization — Pipeline Service resolves flat ordered hook arrays, sends to Execution sequentially (ADR-16). Hook criticality (critical=fail-closed, advisory=fail-open) (ADR-16). HookRecursionError enforcement in Execution Service API layer (ADR-16).

---

### 7.6 Execution Service (port 3005)

**Responsibility:** Sandboxed code execution. Manages op-sandbox-vm (isolated-vm, Node 20) via Unix socket for JS/TS. Manages Docker sandbox containers via socket proxy for Python/Go/etc. Runs connector plugins, transformer plugins, pipeline step code, app build jobs, and expression transforms. Enforces resource limits and timeouts.

**Key API endpoints:**
```
POST /api/v1/exec/run              direct execution (scope: execution:run)
GET  /api/v1/exec/{id}
GET  /api/v1/exec/{id}/logs        SSE streaming
POST /internal/execution/run       (service-only)
POST /internal/execution/connector-run  (service-only)
POST /internal/execution/plugin-drain   (service-only)
POST /internal/execution/plugin-cache-invalidate  (service-only)
```

**Database tables (execution schema):**
```
execution.executions    id, tenant_id, type, status, language, started_at, completed_at,
                        duration_ms, memory_mb, exit_code, error
execution.execution_logs id, execution_id, timestamp, level, message, line_number
```

**Inter-service dependencies:** Plugin Service (fetch plugin bundles, cached LRU 100 bundles 1h TTL). Has NO Redis access — communicates only via Unix socket (sandbox-vm) and HTTP (other services).

**Key design decisions:** op-sandbox-vm in separate container — Execution bridges internal + sandbox networks. No other service touches sandbox network (ADR-19). Unidirectional Unix socket pair (ADR-6). Sandbox recycled every 1000 executions or 1h with graceful drain (10-inflight cap, 60s grace) (ADR-6). isolated-vm contingency: pre-warmed Docker pool (OP_SANDBOX_POOL_SIZE=5), CI smoke test (ADR-6). Resource limits: 512MB memory, 1 CPU, 30s timeout per invocation (connectors: separate 5min configurable timeout).

---

### 7.7 App Service (port 3006)

**Responsibility:** Code-first app builder and runtime. Manages app source files (VFS in Postgres), coordinates esbuild builds via Execution sandbox, serves compiled bundles, acts as BFF for browser app SDK calls (authentication, RBAC enforcement, session cookie management), manages OAuth client lifecycle, handles app deployment and rollback.

**Key API endpoints:**
```
GET  /api/v1/apps
POST /api/v1/apps
GET  /api/v1/apps/{id}
PATCH /api/v1/apps/{id}
DELETE /api/v1/apps/{id}
GET  /api/v1/apps/{id}/files        list files
GET  /api/v1/apps/{id}/files/{path} read file
PUT  /api/v1/apps/{id}/files/{path} write file
DELETE /api/v1/apps/{id}/files/{path}
POST /api/v1/apps/{id}/builds
GET  /api/v1/apps/{id}/builds/{buildId}/logs/stream  SSE
POST /api/v1/apps/{id}/deploy
POST /api/v1/apps/{id}/rollback
GET  /api/v1/apps/{id}/roles
POST /api/v1/apps/{id}/roles
POST /api/v1/apps/generate          starter app from ontology
GET  /apps/{slug}/*                 serve app bundle (production)
GET  /apps/{slug}/preview           serve latest build (preview mode)
GET  /bff/data/{entity}             BFF proxy → Ontology Service
POST /bff/data/{entity}
GET  /bff/me                        current user from session
GET  /bff/permissions               cached permissions snapshot
GET  /bff/storage/{key}
PUT  /bff/storage/{key}
ws://.../apps/{slug}/ws             WebSocket for real-time (App Service fan-out only)
```

**Database tables (app schema):**
```
app.apps                id, tenant_id, name, slug, access_mode, current_build_id, created_at
app.files               id, app_id, path, content, content_hash, file_version, updated_at, updated_by
app.builds              id, app_id, version_number, status, bundle_path (MinIO), build_manifest JSONB
app.env_vars            id, app_id, key, value (AES-256-GCM encrypted), is_secret
app.roles               id, app_id, name, permissions JSONB
app.tenant_shares       id, app_id, external_tenant_id, mapped_roles[]
app.oauth_registrations id, app_id, client_id, client_secret_hash, access_mode
app.user_storage        id, app_id, user_id, key, value JSONB
```

**Inter-service dependencies:** Auth (session validation, guest sessions, OAuth client registration), Ontology (schema for permissions + BFF forwarding), Pipeline (trigger from apps), Execution (build jobs), Logging (query for app).

**Key design decisions:** BFF pattern — browser never sees service tokens (ADR-26). Build pipeline in Execution sandbox (ADR-25). Rollback via current_build_id pointer change (O(1) operation) (ADR-25). Monaco Editor with TypeScript intellisense + ontology-typed completions (ADR-25). SameSite=Strict cookie, CSRF-free (ADR-26). Guest sessions with aggressive rate limiting (ADR-27).

---

### 7.8 Logging Service (port 3007)

**Responsibility:** Centralized log aggregation, audit trail, and analytics. Subscribes to Redis pub/sub log channels from all services (non-audit), persists to Postgres in batches. Guaranteed delivery for audit events via BullMQ. Provides query API for log viewer and trace correlation.

**Key API endpoints:**
```
GET  /api/v1/logs           filter by service, level, traceId, time range
GET  /api/v1/logs/stream    SSE streaming (follow mode)
GET  /api/v1/audit          audit event query
GET  /api/v1/logs/export    JSONL/CSV export (large exports)
GET  /internal/logging/query  (service-only)
```

**Database tables (logging schema):**
```
logging.events       id, trace_id, service, level, message, metadata JSONB, created_at
                     Partitioned monthly (auto-created). Retention: ERROR 90d, INFO 30d, DEBUG 7d.
logging.audit_events id, trace_id, actor_id, actor_type, tenant_id, action, resource_type,
                     resource_id, result, metadata JSONB, created_at
                     Retention: 1 year minimum. Never archived.
```

**Inter-service dependencies:** None (receive-only). Consumes Redis `logs:*` and `audit:*` channels.

**Key design decisions:** Async fire-and-forget for non-audit logs (pub/sub, acceptable loss) (ADR-17). BullMQ guaranteed delivery for audit events (ADR-17). Batch inserts: 1s or 1000 events (ADR-17). Audit fallback file: 100MB cap, rotated to .1 suffix (ADR-18). Scale path: monthly time partitions → read replica → cold storage → split to own Postgres (ADR-17).

---

### 7.9 Plugin Service (port 3008)

**Responsibility:** Plugin lifecycle management. Installs, validates (manifest + bundle checksum + GPG), registers, enables, disables, and uninstalls plugins. Maintains hook registry. Distributes plugin bundles to Execution Service on demand. Registers connectors with Ingestion Service.

**Key API endpoints:**
```
GET  /api/v1/plugins
POST /api/v1/plugins               install (multipart upload)
GET  /api/v1/plugins/{id}
DELETE /api/v1/plugins/{id}        uninstall
GET  /api/v1/plugins/{id}/instances
POST /api/v1/plugins/{id}/instances  enable for tenant
PATCH /api/v1/plugins/{id}/instances/{instanceId}  update config / disable
GET  /internal/plugins/{pluginId}/bundle   (service-only)
GET  /internal/plugins/connectors          (service-only)
GET  /internal/plugins/hooks               (service-only)
GET  /internal/plugins/widgets             (service-only)
```

**Database tables (plugin schema):**
```
plugin.plugins        id, manifest_id, name, version, type, bundle_path (MinIO), manifest JSONB,
                      status (installed|active|disabled|uninstalled)
plugin.instances      id, plugin_id, tenant_id, config JSONB, enabled, instance_id, created_at
plugin.hooks          id, plugin_id, instance_id, stage, criticality, priority, timeout,
                      entrypoint, state (inactive|active|staged|disabled)
plugin.approved_urls  id, plugin_id, url_pattern, approved_by, approved_at
```

**Inter-service dependencies:** Execution (validate entrypoint, drain, cache invalidate), Ingestion (register/deregister connectors).

**Key design decisions:** Plugin state machine: installed → enabled → disabled → uninstalled (ADR-33). Bundle stored in MinIO, not Postgres (ADR-33). Code delivery: on-demand from Execution with LRU cache (ADR-33). Atomic version upgrade swap with hook state transitions in single transaction (ADR-33). Uninstall guard checks active jobs + data orphan warnings (ADR-33).

---

## 8. Plugin System

### Plugin Types

| Type | Interface | Primary Use |
|------|-----------|------------|
| `Connector` | `Connector` | External data source (registers with Ingestion Service) |
| `Transformer` | `Transformer` | Transform records in pipeline steps |
| `Destination` | `Destination` | Write processed data to external system |
| `AuthProvider` | `AuthProvider` | Custom OAuth/SAML/OIDC/LDAP auth integration |
| `Widget` | `Widget` | Dashboard widget (renders in sandboxed iframe) |

### Interface Summary (Key Methods)

**PluginContext (injected into every execution):**
```
credentials.get(name)     → decrypted credential (never logged, never serialized)
credentials.list()        → available credential names
fetch(url, init)          → proxied HTTP (allowlist-only, no internal URLs)
cache.get/set/delete/lock → namespaced KV, scoped to {tenantId}:{instanceId}
logger.debug/info/warn/error
tenant.tenantId, tenant.config, tenant.instanceId
ontology.getSchema(), ontology.getEntitySchema(type)
tracing.injectHeaders(headers), tracing.startSpan(name)
```

**Connector:** `connect(config, ctx)` → handle | `fetchBatch(handle, cursor, ctx)` → BatchResult | `subscribeToEvents?(handle, callback, ctx)` → Subscription | `disconnect(handle, ctx)`

**Transformer:** `transform(record, ctx)` → DataRecord | null | `transformBatch?(records, ctx)` → DataRecord[]

**Destination:** `write(records, ctx)` → WriteResult | `writeStream?(stream, ctx)` → WriteResult

**AuthProvider:** `getAuthorizationUrl(state, options)` → string | `handleCallback(params, ctx)` → AuthResult | `validateToken?(token, ctx)` | `refreshToken?(token, ctx)` | `mapClaimsToRoles(claims)` → string[]

**Widget:** `render(data)` → HTML string | `declareDataRequirements()` → DataQuery[] | `declareSlot()` → WidgetSlotDeclaration

Full TypeScript interfaces in ADR-31 and `@oneplatform/plugin-sdk`.

### Package Format (.oppkg)

```
{plugin-id}-{version}.oppkg     gzip-compressed tar archive
├── plugin.manifest.json        all plugin metadata, capabilities, permissions
├── dist/
│   ├── bundle.js               esbuild single-file ESM output
│   └── bundle.js.sha256        hex-encoded SHA-256 of bundle.js

plugin.manifest.json required fields:
  manifestVersion, id (reverse-domain), name, version (SemVer), type,
  description, author, minPlatformVersion, entrypoint, configSchema,
  hooks[], requiredExternalUrls[], requiredApis[], requiredCredentials[],
  bundleChecksum, license

Build: op plugin pack [--sign <gpg-key-id>]
Validate: op plugin validate <path.oppkg>
```

### Installation and Lifecycle (State Machine)

```
                         op plugin install <source>
                                  │
                         ┌────────▼────────┐
                         │   INSTALLED     │  Platform-wide. Bundle in MinIO.
                         └────────┬────────┘  Manifest validated. Checksum verified.
                                  │ tenant admin: POST /api/v1/plugins/{id}/instances
                         ┌────────▼────────┐
                         │    ENABLED      │  Hooks active. Connector registered.
                         └────────┬────────┘  per-tenant, per-instance config
                                  │ PUT .../instances/{id} { enabled: false }
                         ┌────────▼────────┐
                         │   DISABLED      │  Graceful drain: 60s grace, no new dispatches
                         └────────┬────────┘  Cache invalidation sent to Execution
                                  │ DELETE /api/v1/plugins/{id} (guard check first)
                         ┌────────▼────────┐
                         │  UNINSTALLED    │  Bundle retained 7 days then deleted
                         └─────────────────┘

INSTALLED → UNINSTALLED requires all instances to be DISABLED first.
ENABLED → UNINSTALLED directly: returns 422 ("must disable first").

Version upgrade:
  Install new version → staged state → atomic swap (pointer + hook states in one transaction)
  → Old version drains 60s → DISABLED for 24h rollback window → physical deletion
```

### Sandbox Execution Model

ALL plugin code executes through the Execution Service sandbox. The Plugin Service handles lifecycle only — it never executes plugin code.

```
JS/TS plugins:  op-sandbox-vm (isolated-vm, Node 20, Unix socket, no network)
Other languages: Docker sandbox containers (no internal network, read-only fs, --cap-drop=ALL)

Sandbox recycling: every 1000 executions OR 1 hour (graceful: drain 60s, 10-inflight max)
Resource limits: 512MB memory, 1 CPU, 30s per invocation (connectors: 5min, configurable)
fetch() in sandbox: proxied through platform proxy, allowlist-only, no internal service URLs
HookRecursionError: enforced in Execution Service API layer if pipeline.trigger() called from hook
```

### Hook System

**Stages (complete list — ADR-31):**

```
Ingestion:  ingestion.receive, ingestion.validate, ingestion.enrich, ingestion.stage
Ontology:   ontology.map, ontology.normalize
Pipeline:   pipeline.trigger, pipeline.step (parameterized: pipeline.step:{stepId}), pipeline.complete
Execution:  execution.before, execution.after
Auth:       auth.login, auth.logout, auth.token.issue
App:        app.request, app.build

Each stage has before:{stage} and after:{stage} hook points.
```

**Hook registration:** Declared in manifest `hooks[]`, registered at enable time in `plugin.hooks` table. Not registered via runtime API.

**Hook resolution and execution:**
```
1. Pipeline Service: request hook chain from Plugin Service
   GET /internal/plugins/hooks?stage={stage}&tenantId={tid}
2. Plugin Service: return flat ordered array sorted by priority (lower = earlier)
3. Pipeline Service: call Execution Service sequentially for each hook
   Each hook receives current data payload → returns (possibly modified) payload
4. Criticality enforcement:
   critical: failure/timeout → chain aborts → stage returns error
   advisory: failure/timeout → chain continues with pre-hook payload
5. Timeout: 30s default per hook, configurable up to 300s in manifest
```

**Hook linearization:** No circular dependencies. Plugin Service always returns a flat array. Hooks cannot trigger other hooks in the same chain (enforced by HookRecursionError in Execution API layer).

---

## 9. App Platform

### App Lifecycle

```
create  → POST /api/v1/apps  { name, slug }
          → OAuth client auto-registered with Auth Service
          → Initial file tree created (package.json, src/index.tsx from template)

edit    → Monaco editor in browser OR op app dev locally
          → PUT /api/v1/apps/{id}/files/{path} on every save (debounced 500ms)
          → File version optimistic locking (file_version integer per row)

build   → POST /api/v1/apps/{id}/builds (or auto-trigger on save in preview mode)
          → App Service assembles VFS → submits app-build job to Execution sandbox
          → esbuild in sandbox: ESM bundle + source map + build-manifest.json
          → Artifacts uploaded to MinIO: app-builds/{tenantId}/{appId}/builds/{buildId}/
          → Build log streamed via SSE

preview → Serve from latest successful build (not current_build_id)
          → Incremental rebuild: esbuild context held in sandbox between saves (~200ms)
          → Iframe refresh via SSE reload event

deploy  → POST /api/v1/apps/{id}/deploy
          → UPDATE app.apps SET current_build_id = {buildId}  (atomic, O(1))
          → Routes /apps/{slug}/* now serve new bundle

rollback → POST /api/v1/apps/{id}/rollback  { buildId }
           → UPDATE app.apps SET current_build_id = {priorBuildId}
           → Zero downtime: next request serves prior bundle
           → Old builds retained until manually purged or retention policy (last 20)
```

### In-Browser Editor (Monaco)

```
Component: @monaco-editor/react v4+ (MIT)
Layout:    file tree (left) | editor (center) | preview iframe (right)

TypeScript intellisense:
  - App Service generates tsconfig.json + type declarations for allowed imports
  - Types injected via monaco.languages.typescript.typescriptDefaults.addExtraLib()
  - Ontology-typed completions: Ontology Service code generation → TS interfaces
    injected as extra libs: useQuery<Customer>(), useMutation<Order>()

Allowed imports (pre-bundled in sandbox):
  react, react-dom, @oneplatform/app-sdk, @oneplatform/core (UI utils), recharts
  Additional imports: PluginError (ExternalModuleNotAllowedError with list)
  Per-tenant admin can extend allowed_modules list

File operations:
  - Save: PUT /api/v1/apps/{id}/files/{path} (debounced 500ms)
  - Create/delete/rename: VFS API calls
  - Diff view: Monaco diff between current and any prior build's file snapshot

Build failure isolation:
  - Failure marks app.builds row as 'failed'
  - current_build_id NOT changed — app continues serving last successful build
  - Build errors surfaced as inline error panel in editor (esbuild error + source position)
```

### Build Pipeline

```
Trigger: POST /api/v1/apps/{id}/builds

1. App Service: assemble all VFS source files into in-memory file map
2. Submit to Execution Service: executionType: "app-build"
3. Execution sandbox (op-sandbox-vm):
   - esbuild.build({
       entryPoints: ["/src/index.tsx"],
       bundle: true, format: "esm", target: "es2020",
       platform: "browser"
     })
   - Output: bundle.js + bundle.js.map + build-manifest.json
4. Upload artifacts to MinIO: app-builds/{tenantId}/{appId}/builds/{buildId}/
5. Insert app.builds row (status: success|failed)
6. If success: optionally update current_build_id

Build duration target: < 3s (500-line app). Sandbox warm: ~10ms startup.
Incremental after first build: esbuild.context().rebuild() → ~200ms.
Context invalidated on sandbox recycle.
```

### BFF Pattern (App Service as Proxy)

```
Browser App
  │  fetch("/bff/data/customers?filter[status][eq]=active", { credentials:"include" })
  │  Cookie: op_session=<httpOnly>  ← never exposed to JavaScript
  ▼
App Service BFF
  1. Extract op_session cookie → GET /internal/auth/validate → { userId, tenantId, roles }
     (cached 15s per session token)
  2. Check RBAC: can userId read "customers"?
     (ontology cache lookup, field/row filters applied)
  3. Build internal request:
     X-Service-Token: <App Service Ed25519 JWT>
     X-User-Context: <base64(JSON { userId, tenantId, roles })>
  4. Forward to Ontology Service directly on internal network
  5. Receive response → strip internal headers → apply field-level permissions
  6. Return { data: [...], pagination: {...} } to browser
```

**Security invariants:**
- Browser never receives service tokens
- Internal services only accept X-User-Context when accompanied by valid X-Service-Token
- BFF enforces RBAC before forwarding (fail-closed on permission error)
- httpOnly, Secure, SameSite=Strict cookies — immune to XSS token theft

### App-SDK API Surface

Primary hooks (see ADR-26 for complete TypeScript interface signatures):

```typescript
useQuery(entity, options?)     → { data, pagination, isLoading, isError, error, refetch, fetchNextPage }
useMutation(entity)            → { create, update, replace, remove, bulkCreate, isLoading, isError }
useSubscription(entity, opts?) → { lastEvent, isConnected, reconnectAttempts }
useUser()                      → { id, email, displayName, tenantId, roles, isGuest }
usePermission(action, resource) → boolean (synchronous, from cached permissions)
useAppStorage(key, default)    → [value, setValue] (per-app, per-user, JSONB, max 64KB)
AppProvider(props)             → wraps app root, reads from window.__OP_APP_CONFIG__
```

Window injection by App Service: `window.__OP_APP_CONFIG__ = { appId, tenantId }` — runtime injection, no rebuild needed across environments.

### Real-Time (SSE + WebSocket)

```
SSE (one-way streaming, app platform):
  - App Service maintains ONE SSE connection to Gateway per active app
  - App Service fans out to browsers via WebSocket
  - Browser connects: wss://{platform}/apps/{slug}/ws (routed to App Service)
  - One Gateway SSE → many browser WebSockets (fan-out in App Service)

SSE (pipeline logs, build logs):
  - GET /api/v1/apps/{id}/builds/{buildId}/logs/stream
  - GET /api/v1/pipeline-runs/{runId}/logs  (follow mode)

Preview hot-reload:
  - App Service sends SSE { event:"reload", data:{buildId} } to preview iframe
  - Iframe listens: window.location.reload() on receipt
```

### OAuth Client Lifecycle

```
Auto-registration at deploy:
  POST /internal/oauth/clients
  { clientId: "app:{appId}:{tenantId}", clientType:"public",
    redirectUris:[...], allowedScopes:[...], tenantId, appId, accessMode }
  → UPSERT by client_id (redeploy-safe, idempotent)

Client ID format: app:{appId}:{tenantId}  (deterministic, collision-free)
Redirect URI management:
  - Path-based: {OP_BASE_URL}/apps/{slug}/auth/callback
  - Subdomain: https://{slug}.apps.{domain}/auth/callback (if OP_WILDCARD_DOMAIN set)
  - Dev URIs: http://localhost:{port}/auth/callback (added by op app dev, TTL 24h auto-cleanup)
  - No wildcards in redirect URIs

Public client (PKCE):
  - No client secret in browser
  - PKCE code_verifier required at token exchange
  - Auth Service enforces "app:" prefix clients may only be created by App Service (service RBAC)
```

---

## 10. CLI and SDKs

### CLI (@oneplatform/cli — `op`)

The CLI is a thin wrapper around the REST API. No privileged access.

**Command groups (20 groups, ~95 commands total):**

```
auth      login, logout, status, whoami, generate-key, list-keys, revoke-key,
          rotate-key, emergency-rotate
profile   add, list, use, remove
user      list, invite, get, update, deactivate, import
role      list, create, assign, remove
ontology  list, get, create, update, delete, validate, diff, migrate,
          migration-status, migration-rollback, export, import
data      query, get, create, update, delete, import, export
connector list, create, get, update, delete, test, trigger
webhook-out list, create, update, delete, test, logs
pipeline  list, get, create, update, delete, trigger, runs, run-status,
          run-cancel, run-logs
schedule  list, create, pause, resume, delete
dlq       list, replay, discard
exec      run, history, logs
app       list, get, create, deploy, dev, logs, delete, env-set, env-list, rollback
plugin    list, install, enable, disable, uninstall, info, create, pack, validate,
          simulate-hook
logs      query, tail, audit, export
config    export, import, diff, validate
status    (+ --watch)
service   rotate-keys, health
sdk       generate
version
completion  bash, zsh, fish
```

**Credential storage:**
```
File: ~/.config/oneplatform/credentials.json  (mode 600)
Encryption:
  1. Primary: system keychain via keytar (macOS Keychain, GNOME Keyring, Windows Credential Manager)
  2. Fallback: HKDF-SHA256 of machine-id (headless servers, CI)
  3. Override: OP_API_KEY + OP_PLATFORM_URL env vars (for CI, bypasses file entirely)

Profile files: ~/.config/oneplatform/profiles/{name}.json
Active profile: ~/.config/oneplatform/config.json { activeProfile: "..." }
Precedence: --profile flag > OP_PROFILE > activeProfile config
```

**Output formats:**
- TTY: table (aligned columns, 60-char truncation with ...)
- Pipe: JSON (auto-detected), JSONL for list commands
- `--output json|table|tsv` override
- `--quiet` / `--no-color` / `--yes` for CI scripting

**Distribution:**
```
Standalone binaries (bun build --compile, no Node.js required):
  op-linux-amd64, op-linux-arm64, op-darwin-arm64, op-darwin-amd64, op-windows-amd64.exe
  Published to GitHub Releases. SHA-256 checksums alongside.

npm package: npm install -g @oneplatform/cli  (npx @oneplatform/cli for one-off use)
```

### SDK (@oneplatform/sdk — external)

Generated from OpenAPI 3.1 spec using `@hey-api/openapi-ts` with Fetch client adapter.

```typescript
// Client construction
const client = createClient({
  baseUrl: "https://...",
  auth: { apiKey: "op_live_..." }   // Server-only
  // OR: auth: { accessToken: "..." }
  // OR: browser auto-detects → PKCE flow (API keys rejected in browser)
  retry?: RetryPolicy,
  timeout?: number,  // default 30000ms
});

// Auto-retry: 3 retries, exponential backoff, jitter, on [429, 500, 502, 503, 504]
// 429: respects Retry-After header
// 4xx (non-429): thrown immediately, not retried

// Error hierarchy:
OnePlatformError → ClientError → AuthError | NotFoundError | ValidationError
OnePlatformError → RateLimitError (retryable, retryAfterSeconds)
OnePlatformError → ServerError (retryable)
OnePlatformError → NetworkError (retryable)

// Pagination: AsyncIterable<Page<T>>
for await (const page of client.data.Product.list()) { ... }
await client.data.Product.list().collect(maxItems?)  // default max 10k
await client.data.Product.list().take(n)

// Real-time subscriptions (SSE, auto-reconnect with Last-Event-ID)
const sub = client.events.subscribe(
  { events: ["pipeline.*"], filter: { entityType: "Order" } },
  (event) => { ... }
);
sub.unsubscribe();
```

**Ontology-typed SDK generation:**
```
op sdk generate [--out ./src/oneplatform.gen.ts]
  1. Fetch GET /api/v1/openapi.json (tenant-specific, includes entity routes)
  2. Run @hey-api/openapi-ts → oneplatform.gen.ts
  3. Produces: createTypedClient() + typed interfaces for all tenant entities

// Generated usage:
const client = createTypedClient({ baseUrl, auth });
const products = await client.data.Product.list({ filter: { status: "active" } });
// products: PaginatedResult<Product>  — fully typed from ontology
```

**Module format:** Dual ESM/CJS output via tsup. `exports` map for both. Tree-shakeable ESM.

### App-SDK (@oneplatform/app-sdk)

Extends base SDK with platform-specific hooks. See Section 9 for full API surface. Used exclusively inside Monaco editor builds. All calls go through App Service BFF (never to internal services directly).

### Plugin-SDK (@oneplatform/plugin-sdk)

Provides:
- All 5 plugin TypeScript interfaces (`Connector`, `Transformer`, `Destination`, `AuthProvider`, `Widget`)
- `PluginContext` and context sub-interfaces
- Plugin error taxonomy (`PluginError`, `PluginAuthError`, `PluginRateLimitError`, `PluginTimeoutError`, `PluginDataError`, `PluginConfigError`)
- Metadata type definitions (`ConnectorMetadata`, `TransformerMetadata`, etc.)
- `HookDeclaration` interface
- Local development server (`op plugin simulate-hook`)
- `op plugin create` interactive scaffold (produces starter TypeScript template)

---

## 11. Event System

### Outbound Webhooks

**Registration:**
```
POST /api/v1/webhooks/outbound  { url, events[], secret?, description?, headers? }
  - URL validation: HTTPS required (HTTP: OP_WEBHOOK_ALLOW_HTTP=true, dev only)
  - SSRF prevention: IP range checks on DNS resolution (private, loopback, link-local, Docker)
  - IP checked at registration AND on every delivery (prevents DNS rebinding)
  - Connectivity check: synthetic POST to URL — non-2xx = registration fails
  - Secret: returned once (bcrypt-hashed in storage), random 32-byte if not provided
  - Pattern matching: exact strings + prefix wildcards (pipeline.*), trie at delivery time
```

**Delivery mechanism:**
```
Event published → Redis pub/sub events:{tenantId}:{eventType}
Gateway (PSUBSCRIBE events:*) receives → enqueues BullMQ job

HTTP delivery headers:
  X-OnePlatform-Signature: sha256={HMAC-SHA256 over raw body bytes}
  X-OnePlatform-Event: {eventType}
  X-OnePlatform-Delivery: {deliveryId}  (stable across retries = idempotency key)
  X-OnePlatform-Timestamp: {epoch seconds}  (consumers: reject if > 5min old)

Success: any HTTP 2xx within 30s
Retry schedule: immediate, 1s, 5s, 30s, 2m, 10m, 1h, 6h, 24h (9 attempts)
After attempt 9: DLQ, dlq.job.added event emitted (not to failed endpoint)
Backpressure: 5+ consecutive failures → throttle to 1 attempt/hour until success
Delivery log: last 100 deliveries per webhook, 7-day retention
```

### Event Catalog (All Types — ADR-30)

```
Data events:       data.created, data.updated, data.deleted, data.bulk_imported
Pipeline events:   pipeline.started, pipeline.step.completed, pipeline.completed,
                   pipeline.failed, pipeline.cancelled
Ingestion events:  ingestion.started, ingestion.completed, ingestion.failed
Ontology events:   ontology.schema.changed, ontology.migration.started,
                   ontology.migration.completed, ontology.migration.failed
App events:        app.build.started, app.build.completed, app.build.failed,
                   app.deployed, app.crashed, app.rolled_back
Plugin events:     plugin.installed, plugin.enabled, plugin.disabled, plugin.uninstalled
Auth events:       auth.user.created, auth.user.deactivated, auth.key.created, auth.key.revoked
System events:     system.health.degraded, system.health.recovered
DLQ events:        dlq.job.added
```

All events conform to canonical `PlatformEvent` envelope (see Section 5 for schema).

### SSE Streaming

```
GET /api/v1/events/stream?events=pipeline.*,data.created&Last-Event-ID={lastId}

Connection: text/event-stream, scoped to authenticated tenant
Per-tenant ring buffer: 1000 events, LRU eviction (in-memory per Gateway instance)
Replay: Last-Event-ID scans buffer → emits buffered events → enters live mode
Miss (buffer overflow): synthetic replay.overflow event → client must re-fetch entities
Connection limit: 10 concurrent SSE connections per API key
Heartbeat: ": keepalive" comment every 30s (prevents proxy timeout)
Backpressure: write buffer > 512KB → drop DEBUG events; > 1MB → close with 4001

Multi-replica note: ring buffer is per-instance. For guaranteed delivery across replicas,
use webhooks (BullMQ-backed) instead of SSE.
```

---

## 12. Observability

### OTEL Tracing

```
All services: OTEL SDK auto-instrumented via @oneplatform/core
Every inbound request to Gateway: trace ID generated (W3C Trace Context)
Trace ID propagation:
  - Inter-service HTTP: W3C traceparent header
  - BullMQ job metadata: traceId in job payload
  - Redis pub/sub messages: traceId in message header
  - Log events: traceId field (= OTEL trace ID, same correlation ID)

Span creation:
  - HTTP route handlers (auto)
  - BullMQ worker processing (auto)
  - Postgres queries (auto, via OTEL Postgres plugin)
  - Redis commands (auto, via OTEL Redis plugin)
  - Service-specific named spans (explicit startSpan() calls)

Export:
  Dev mode: services → Jaeger directly (OTLP/gRPC)
  Production: services → OTEL Collector → configurable backend
  Config: OTEL_EXPORTER_OTLP_ENDPOINT env var
```

### Prometheus Metrics

```
All services expose: GET /metrics  (Prometheus text format)
Core automatically exports per service:
  http_request_duration_seconds{method, route, status}  histogram (p50/p95/p99)
  http_requests_total{method, route, status}            counter
  queue_depth{queue_name}                               gauge
  queue_processing_duration_seconds{queue_name}         histogram
  active_connections                                     gauge
  memory_usage_bytes                                    gauge
  cpu_usage_ratio                                       gauge
  
Service-specific:
  Pipeline: pipeline_execution_duration_seconds, pipeline_runs_total{status}
  Execution: sandbox_execution_duration_ms, sandbox_recycles_total
  Logging: log_batch_size, audit_queue_depth
  Ingestion: records_ingested_total, sync_duration_seconds, mapping_error_rate
```

### Logging Architecture

```
Non-audit logs (fire-and-forget):
  Service publishes to Redis channel logs:{serviceName}
  @oneplatform/core provides: logger.info/warn/error/debug(message, metadata)
  Logging Service: PSUBSCRIBE logs:* → batch insert to logging.events
  Batch trigger: 1s elapsed OR 1000 events (whichever first)
  On Redis down: in-memory buffer 10,000 events + flush on reconnect
               + fallback file (100MB, .1 rotation)

Audit logs (guaranteed delivery):
  Service publishes to BullMQ queue audit (NOT pub/sub)
  @oneplatform/core: auditLogger.write({ actor, action, resource, result, metadata })
  Logging Service BullMQ worker: consume + INSERT logging.audit_events
  On Redis down: service WAL file per-service for audit events as backup

Log event structure:
  { timestamp, traceId, service, level, message, metadata: Record<string,unknown> }

Retention:
  ERROR: 90 days, INFO: 30 days, DEBUG: 7 days
  Audit: 1 year minimum, never archived
  Partitioning: logging.events partitioned monthly (auto-created), enables fast retention drops
  Scale path: read replica for log viewer queries → cold storage (30d+ compressed) → split Postgres
```

### Trace ID Correlation

```
traceId in log events = OTEL trace ID = X-Request-ID in API responses
Every error response includes requestId = traceId

Correlation flow:
  User sees error → copies requestId from error response
  → op logs query --trace-id {requestId} → full log chain across all services
  → Jaeger UI trace search by traceId → full distributed trace with timings

Dashboard: built-in trace viewer (search by trace ID, service call chain)
           + metrics dashboard (queue depths, error rates, pipeline throughput)
Full Grafana/Jaeger integration via optional observability Docker profile:
  docker compose --profile observability up
```

---

## 13. Security Summary

### Threat Model

| Threat | Severity | Mitigation |
|--------|----------|-----------|
| Sandbox escape (isolated-vm) | Critical | op-sandbox-vm: separate container, no capabilities, no internal network, read-only fs. Unix socket: unidirectional, Execution is only writer. Sandbox recycle: 1000 executions/1h. Contingency: pre-warmed Docker pool fallback. |
| Plugin code exfiltrating credentials | High | CredentialAccessor: getter function only, never raw value. Plugin fetch() proxied through allowlist. Cache scoped to {tenantId}:{instanceId}. |
| Lateral movement via compromised service | High | 3-tier Docker network: sandbox network has no internal access. Service RBAC matrix: each service only calls endpoints it's authorized for. Ed25519 asymmetric: compromised service can only forge its own tokens. |
| SSRF via webhook/plugin | High | Webhook URL validation: DNS-resolved IP checked (not hostname). Private IP ranges blocked. Docker DNS blocked. Re-checked on every delivery. Plugin fetch(): URL parsed per WHATWG spec, hostname exact-match only. |
| Credential exposure (vault compromise) | High | AES-256-GCM + HKDF-SHA256 per-credential salt. Master key on init volume (chmod 0400). In-memory only during use. Never logged or serialized. Key rotation: idempotent background job. |
| Cross-tenant data access | High | Schema-per-service enforced by Postgres user grants. RLS on tenant tables (app.tenant_id session var). App Service BFF: tenantId === app.tenantId invariant on every request. |
| Token theft (XSS) | High | httpOnly cookies: browser JavaScript cannot read op_session. SameSite=Strict: cross-site requests excluded. CSP on app bundles: no inline scripts, no eval. App builds in sandbox (no client-side eval during edit). |
| JWT compromise | Medium | 15-min access token lifetime. Redis revocation blocklist. Emergency re-key (rotates OP_JWT_SECRET, all tokens invalidated). |
| Brute force (bootstrap) | Medium | 3 attempts per 10min per IP (in-memory, no Redis dependency). Single-use token. Constant-time comparison. |
| API key scanning (committed keys) | Low | Key format op_live_{32} allows GitHub secret scanner detection. Custom scanner pattern published. |
| Man-in-the-middle | Low | HTTPS required for webhooks. TLS recommended for all public traffic (self-hosted guide: Caddy/Let's Encrypt). |

### Encryption

```
At rest:
  Connector credentials: AES-256-GCM, HKDF-SHA256(masterKey, credentialSalt) per-credential key
  API keys: bcrypt (cost 12)
  OAuth secrets: AES-256-GCM
  App env vars (secrets): AES-256-GCM
  CLI credentials: AES-256-GCM (keytar-backed or machine-id-derived key)
  MinIO objects: SSE-S3 (AES-256 at rest)

In transit:
  External: HTTPS recommended (self-hosted guide)
  Internal (Docker network): plain HTTP (trusted internal network)
  Production upgrade path: mTLS for inter-service, documented in ops guide

Master key (OP_MASTER_KEY):
  Generated by op-init: openssl rand -base64 32
  Stored: /data/init/master.key chmod 0400 OR Docker secret /run/secrets/op_master_key
  Critical: loss = all connector credentials unrecoverable
  Setup wizard prominently displays security warnings (screen auto-clears after 60s)
```

### Network Isolation

```
oneplatform-public:   Gateway + Frontend only. External internet faces here.
oneplatform-internal: All 9 services + Postgres + Redis + MinIO.
                      Not reachable from public network.
oneplatform-sandbox:  Execution + op-sandbox-vm + Docker sandbox containers.
                      No access to internal network at all.
                      Only path out: Execution Service's outbound proxy (allowlist-enforced).

Docker socket: NEVER mounted directly. tecnativa/docker-socket-proxy allows only:
  POST /containers/create
  POST /containers/{id}/start
  GET  /containers/{id}/logs
  DELETE /containers/{id}
```

### Code Signing

Plugin bundles: SHA-256 checksum (required). GPG detached signature (optional, organizational).
Platform CLI binaries: SHA-256 checksums published alongside GitHub Releases.
Op-init generates: bootstrap.token (single-use, erased immediately after first use).

---

## 14. Implementation Order

### Dependency-Driven Build Order

```
Phase 1: Foundation (everything depends on this)
  1. @oneplatform/core
     - DB clients (Postgres + Redis connection factories)
     - Auth middleware stack (createApp())
     - Service RBAC matrix
     - Error registry + types
     - BullMQ helpers + WAL
     - OTEL auto-instrumentation
     - Encryption utilities
     - Event publisher
     - Health check factories
     - Cursor helpers
     - Config loader

Phase 2: Auth + Schema (all services need auth; most need ontology)
  2. Auth Service
     - JWT issuance/validation
     - bcrypt password management
     - Redis token lifecycle
     - Bootstrap endpoint
     - OAuth (GitHub, Google via Passport.js)
     - API key management
     - RBAC storage
  3. Ontology Service
     - Entity/field/relationship CRUD
     - Migration engine (UNION views, shadow tables)
     - Code generation (TS types, Zod, API routes)
     - Ontology cache pub/sub publisher
     - Cross-schema Postgres grants for Ingestion read

Phase 3: Infrastructure Services
  4. Gateway Service
     - Rate limiting (Redis + in-memory fallback)
     - Auth token validation (delegates to Auth)
     - Service routing
     - OpenAPI aggregation
     - Outbound webhook delivery (BullMQ)
     - SSE event streaming
     - CORS + SSRF prevention
  5. Logging Service
     - Redis pub/sub subscriber (logs:*)
     - BullMQ audit consumer
     - Batch insert to time-partitioned tables
     - Query API (filter, trace correlation)
     - Fallback file writer

Phase 4: Data Processing
  6. Ingestion Service
     - Built-in connectors (REST, PostgreSQL, CSV)
     - Credential vault (AES-256-GCM)
     - Raw staging tables
     - BullMQ sync job orchestration
     - Webhook receiver
     - Schema auto-inference
  7. Pipeline Service
     - Pipeline definition storage
     - Cron scheduler (BullMQ-based)
     - Event-driven triggers
     - Hook resolution (calls Plugin Service)
     - Run state tracking
     - SSE log streaming
  8. Execution Service
     - op-sandbox-vm Unix socket protocol
     - isolated-vm execution path
     - Docker sandbox container management
     - Plugin bundle LRU cache
     - App build handler (esbuild)
     - Resource limit enforcement
     - Graceful sandbox recycling

Phase 5: Extension and Application Layer
  9. Plugin Service
     - .oppkg extraction + validation
     - Manifest Zod schema validation
     - Bundle checksum verification
     - GPG signature support
     - State machine (installed → enabled → disabled → uninstalled)
     - Hook registry
     - Connector registration relay
     - Version upgrade atomic swap
  10. App Service
      - VFS API (files in Postgres)
      - Monaco type injection
      - Build pipeline orchestration
      - BFF layer (session + RBAC + forwarding)
      - OAuth client lifecycle
      - Deployment + rollback
      - Starter app generator
      - WebSocket fan-out

Phase 6: SDKs and CLI
  11. @oneplatform/sdk (generated from OpenAPI, auto-retry, pagination iterator)
  12. @oneplatform/app-sdk (hooks wrapping BFF endpoints)
  13. @oneplatform/plugin-sdk (interfaces + local dev server)
  14. @oneplatform/cli (all command groups, bun compile binaries)

Phase 7: Frontend
  15. Frontend (from websitetemplate: Vite + React 18 + Tailwind v4 + shadcn/ui)
      - Setup wizard (6 screens)
      - Dashboard (pipeline status, log viewer, app editor, DLQ, metrics)
      - Monaco editor integration
      - Real-time SSE/WebSocket status updates

Phase 8: Integration, E2E, Security, and Documentation
  - Docker Compose: full stack integration tests
  - Playwright E2E: full user story flows
  - Security tests: sandbox escape, auth bypass, SQL injection, permission boundaries
  - Auto-generated docs pipeline: turbo run docs:generate
  - Performance tests: pipeline throughput, sandbox latency, ingestion batch size
```

---

## 15. Config Export/Import

### YAML Format

Multiple YAML documents separated by `---`. Each document has `kind` and `spec`.

```yaml
kind: Ontology
spec:
  name: Product
  version: 3
  fields:
    - { name: sku, type: string, required: true }
    - { name: price, type: number, required: true }
---
kind: Pipeline
spec:
  name: sync-products
  trigger:
    type: schedule
    cron: "0 * * * *"
  steps:
    - { type: connector, connector: com.example.shopify-connector }
---
kind: App
spec:
  name: product-dashboard
  accessMode: platform-user
---
kind: Webhook
spec:
  url: https://hooks.slack.com/services/...
  events: ["pipeline.failed", "ingestion.failed"]
```

Supported `kind` values: `Role`, `Ontology`, `Connector`, `Pipeline`, `App`, `Webhook`.

### Credentials in Export

```
Default: credentials excluded (only key names exported)
With credentials: op config export --include-credentials --passphrase <pass>
  - AES-256-GCM encrypted, key derived from passphrase
  - Value format: "encrypted:{base64-ciphertext}"
  - Import requires same passphrase

On import without passphrase: credentials imported as empty (admin must re-enter)
```

### Topological Ordering

Import follows dependency order (Kahn's algorithm):
```
1. Roles           (no dependencies)
2. Ontologies      (no dependencies)
3. Connectors      (depend on ontologies for schema mapping)
4. Pipelines       (depend on connectors + ontologies)
5. Apps            (depend on pipelines + ontologies)
6. Webhooks        (listed last, no dependencies)

Circular dependency: detected before any writes, reported as error with cycle path
```

### Conflict Resolution Modes

| Mode | Behavior on existing resource |
|------|-------------------------------|
| `fail` (default) | Abort import, report all conflicts |
| `skip` | Leave existing unchanged, continue with others |
| `overwrite` | Replace existing resource completely |
| `merge` | Deep-merge spec (additive only, no removals) |

### Dry-Run

```
op config import --file config.yaml --dry-run
  - Full import process: dependency resolution, conflict detection, validation
  - NO writes to database
  - Output: + (create), ~ (update), (space) (no change) per resource
  - Format mirrors: kubectl diff

op config diff --file config.yaml
  - Same as dry-run, focused on diff output
```

### Idempotency

Resources identified by stable key: `kind:spec.name` (e.g., `Ontology:Product`). Internal DB IDs never appear in config files. Importing the same config twice with `--on-conflict skip` is a no-op.

---

## Appendix A: Environment Variables (Key)

```
OP_MASTER_KEY          AES-256-GCM master key (generated by op-init)
OP_JWT_SECRET          JWT signing secret (generated by op-init)
OP_CURSOR_SECRET       Cursor HMAC signing secret (generated by op-init)
OP_BASE_URL            Platform base URL (https://platform.example.com)
OP_ALLOWED_ORIGINS     CORS allowlist (comma-separated)
OP_WILDCARD_DOMAIN     Optional: enables subdomain app routing
OP_GATEWAY_REPLICAS    Required for multi-replica Gateway deployments
OP_GLOBAL_RATE_LIMIT   Global rate limit (default 10000 req/min)
OP_SANDBOX_POOL_SIZE   Pre-warmed Docker container pool size (default 5)
OP_CONNECTOR_TIMEOUT_SECONDS  Default connector timeout (default 300)
OP_INGESTION_BATCH_SIZE  Records per ingestion batch (default 1000, max 10000)
OP_MIGRATION_TIMEOUT   Max migration duration (default 3600s)
OP_ONTOLOGY_POLL_INTERVAL  Fallback poll interval (default 15s)
OP_REQUIRE_EMAIL_VERIFICATION  Enforce email verification (default false)
OP_SMTP_HOST/PORT/USER/PASS/FROM/SECURE  Email delivery config
OP_S3_ENDPOINT         Override MinIO with S3-compatible service
OP_S3_ACCESS_KEY       S3 access key
OP_S3_SECRET_KEY       S3 secret key
OP_S3_REGION           S3 region
OP_MINIO_USER          MinIO admin user (default: minioadmin)
OP_MINIO_PASSWORD      MinIO admin password (required, no default)
OP_WEBHOOK_ALLOW_HTTP  Allow HTTP webhook URLs (dev only, default false)
OP_LARGE_SYNC_CONCURRENCY  Concurrency for syncs >1M records (default 3)
OTEL_EXPORTER_OTLP_ENDPOINT  OTEL collector endpoint
```

## Appendix B: Reference to ADRs

| Section | Primary ADRs |
|---------|-------------|
| Infrastructure | ADR-3, ADR-5, ADR-10, ADR-21, ADR-24, ADR-36 |
| Data Architecture | ADR-5, ADR-11, ADR-14, ADR-28, ADR-36 |
| Auth/Authorization | ADR-7, ADR-19, ADR-22, ADR-24, ADR-27, ADR-36 |
| Core Library | ADR-10, ADR-19, ADR-21, ADR-29 |
| API Design | ADR-22, ADR-29 |
| Service Designs | ADR-10, ADR-28, ADR-29 (all services); ADR-6 (Execution); ADR-11 (Ingestion); ADR-12,14 (Ontology); ADR-13,16 (Pipeline); ADR-17 (Logging); ADR-25,26,27 (App) |
| Plugin System | ADR-16, ADR-31, ADR-32, ADR-33 |
| App Platform | ADR-2, ADR-15, ADR-25, ADR-26, ADR-27 |
| CLI/SDKs | ADR-22, ADR-34, ADR-35 |
| Event System | ADR-9, ADR-30 |
| Observability | ADR-17, ADR-21 |
| Security | ADR-6, ADR-7, ADR-11, ADR-13, ADR-19, ADR-20, ADR-22, ADR-30 |
| Implementation Order | ADR-1, ADR-10 |
| Config Export/Import | ADR-36 |
