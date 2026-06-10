# Gateway Service — L2 Design

**Document level:** L2 (Service Design)
**Status:** APPROVED
**Date:** 2026-06-10
**References:**
- L1: `docs/superpowers/specs/2026-06-10-oneplatform-design.md`
- ADR-20: Rate Limiting (`docs/decisions/001-architecture-decisions.md`)
- ADR-29: API Contract Standard (`docs/decisions/001-architecture-decisions.md`)
- ADR-30: Outbound Event System (`docs/decisions/002-expanded-architecture-decisions.md`)

---

## Table of Contents

1. [Service Overview](#1-service-overview)
2. [Network Placement and Startup](#2-network-placement-and-startup)
3. [Middleware Stack](#3-middleware-stack)
4. [Database Schema](#4-database-schema)
5. [API Endpoints — Full Route Table](#5-api-endpoints--full-route-table)
6. [Request Routing and Proxy Logic](#6-request-routing-and-proxy-logic)
7. [Auth Validation](#7-auth-validation)
8. [Rate Limiting](#8-rate-limiting)
9. [CORS Policy](#9-cors-policy)
10. [Auto-Generated Data Routes](#10-auto-generated-data-routes)
11. [Outbound Webhook System](#11-outbound-webhook-system)
12. [SSE Event Streaming](#12-sse-event-streaming)
13. [OpenAPI Generation](#13-openapi-generation)
14. [Redis Usage](#14-redis-usage)
15. [Error Handling](#15-error-handling)
16. [Observability](#16-observability)
17. [Testing Strategy](#17-testing-strategy)
18. [Deployment](#18-deployment)
19. [Configuration Reference](#19-configuration-reference)

---

## 1. Service Overview

The Gateway Service is the **single external entry point** for all OnePlatform API traffic. No other service is reachable from the public internet. Every API call from browsers, the CLI, SDKs, and third-party integrations passes through the Gateway.

### Responsibilities

| Responsibility | Description |
|---|---|
| TLS termination | Terminated upstream at the reverse proxy (Caddy/nginx); Gateway operates on plain HTTP internally |
| CORS enforcement | Origin allowlist, preflight cache, credential mode |
| Auth token validation | Bearer JWT and API-key validation on every request before routing |
| Multi-tier rate limiting | Global, per-tenant, per-API-key, webhook-inbound tiers with Redis + in-memory fallback |
| Request routing | Reverse-proxy to 9 internal services by route prefix |
| Auto-generated data routes | `/api/v1/data/{entityType}` routes generated from ontology cache |
| Outbound webhook delivery | BullMQ-backed HMAC-signed HTTP fan-out with 9-attempt retry |
| SSE event streaming | Per-tenant ring-buffer, `Last-Event-ID` replay, heartbeat |
| OpenAPI aggregation | Tenant-aware spec including all 9 service route definitions plus dynamic entity routes |
| Health endpoints | `/healthz` (liveness) and `/readyz` (readiness) |

### What the Gateway Does NOT Do

The Gateway does not implement business logic for any domain. It does not write to the database for any purpose other than webhook registration and delivery logging. It does not decrypt credentials. It does not execute user code.

---

## 2. Network Placement and Startup

### Network Topology

```
PUBLIC INTERNET
      │  HTTPS (443)
      ▼
┌─────────────────────────────────┐
│  oneplatform-public network     │
│                                 │
│  [Gateway Service  :3000]       │  ◄── external clients
│  [Frontend SPA     :80]         │
└──────────────┬──────────────────┘
               │  plain HTTP (inter-service)
               ▼
┌─────────────────────────────────────────────────┐
│  oneplatform-internal network                   │
│                                                 │
│  Auth :3001   Ingestion :3002   Ontology :3003  │
│  Pipeline :3004  Execution :3005  App :3006     │
│  Logging :3007   Plugin :3008                   │
│                                                 │
│  PostgreSQL :5432   PgBouncer :5433             │
│  Redis :6379        MinIO :9000                 │
└─────────────────────────────────────────────────┘
```

The Gateway is on **both** networks. It is the only service on the public network that receives inbound traffic. All other services are on the internal network only and are not reachable from outside Docker Compose.

### Startup Dependencies

The Gateway must not serve traffic until its dependencies are ready. Docker Compose `depends_on` conditions:

```yaml
gateway-service:
  depends_on:
    postgres:
      condition: service_healthy
    redis:
      condition: service_healthy
    auth-service:
      condition: service_healthy
    op-init:
      condition: service_completed_successfully
```

The Gateway performs its own readiness check on startup:

1. Verify Postgres connection by running `SELECT 1` on the `gateway` schema.
2. Verify Redis connection with `PING`.
3. Fetch ontology snapshot from the Ontology Service (if the Ontology Service is not yet up, the Gateway starts with an empty ontology cache — data routes are unavailable until the cache is populated).
4. Register Gateway replica in Redis: `INCR gateway:replicas` (decremented on SIGTERM).
5. Start `PSUBSCRIBE events:*` listener.
6. Only then: begin accepting HTTP connections on port 3000.

**Graceful shutdown sequence (SIGTERM):**

1. Stop accepting new connections (set liveness to draining — `/healthz` returns 200 but `/readyz` returns 503).
2. Wait for in-flight requests to complete, up to `OP_SHUTDOWN_GRACE_MS` (default 30,000 ms).
3. Flush BullMQ in-flight webhook jobs back to the queue.
4. Decrement `gateway:replicas` in Redis.
5. Close SSE connections with a `retry: 0` directive so clients reconnect immediately.
6. Exit.

---

## 3. Middleware Stack

Every inbound request passes through this ordered middleware chain before reaching any route handler. The chain is assembled using `@oneplatform/core`'s `createApp()` factory.

```
Inbound request
       │
       ▼
1.  requestId          — generate W3C trace ID if not present in X-B3-TraceId / traceparent
       │
       ▼
2.  otelInstrumentation — start OTEL span, attach trace context to request
       │
       ▼
3.  cors               — enforce OP_ALLOWED_ORIGINS; 403 on mismatch (not CORS error)
       │
       ▼
4.  healthBypass       — /healthz and /readyz skip all remaining middleware
       │
       ▼
5.  rateLimit          — global tier check first; exit 429 if exceeded
       │
       ▼
6.  auth               — validate Bearer JWT or X-API-Key header; set c.var.user
       │                  (public routes: /api/v1/auth/*, /healthz, /readyz skip this)
       ▼
7.  tenantRateLimit     — per-tenant and per-API-key tier check; exit 429 if exceeded
       │
       ▼
8.  rateLimitHeaders    — attach X-RateLimit-* headers to response (always, even on 429)
       │
       ▼
9.  responseEnvelope   — wrap success responses in { data: T } envelope
       │
       ▼
10. errorHandler        — catch thrown AppError / Error; format as { error: {...} }
       │
       ▼
11. route handler       — proxy, data route, webhook, SSE, or local route
       │
       ▼
12. deprecationHeaders  — add Deprecation / Sunset / Link headers if route is deprecated
       │
       ▼
Outbound response
```

**Note on auth bypass:** Routes under `/api/v1/auth/` are public by design — the auth middleware marks these routes as `allowUnauthenticated`. The `/api/v1/webhooks/inbound/{id}/receive` route also bypasses JWT/API-key auth; it authenticates via HMAC-SHA256 signature verification instead (the Ingestion Service owns that route).

---

## 4. Database Schema

The Gateway uses the `gateway` schema in the shared PostgreSQL instance, accessed via PgBouncer in transaction mode.

**Connection pool allocation:** 15 server connections (from ADR-5: Gateway is weighted at 15 because write volume is low — webhook registrations and delivery logs — but connection count matters for concurrent request handling).

### 4.1 gateway.webhooks

Stores registered outbound webhook endpoints.

```sql
CREATE TABLE gateway.webhooks (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID        NOT NULL REFERENCES auth.tenants(id) ON DELETE CASCADE,
  url             TEXT        NOT NULL,
  events          TEXT[]      NOT NULL,  -- event type patterns, e.g. {"pipeline.*","data.created"}
  secret_hash     TEXT        NOT NULL,  -- bcrypt hash of the 32-byte raw secret
  description     TEXT,
  enabled         BOOLEAN     NOT NULL DEFAULT true,
  custom_headers  JSONB,                 -- {"Authorization": "Bearer <token>"}
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  throttled_until TIMESTAMPTZ,           -- NULL = not throttled; set when consecutive_failures >= 5
  total_deliveries       BIGINT NOT NULL DEFAULT 0,
  successful_deliveries  BIGINT NOT NULL DEFAULT 0,
  failed_deliveries      BIGINT NOT NULL DEFAULT 0,
  last_delivery_at       TIMESTAMPTZ,
  last_delivery_status   TEXT CHECK (last_delivery_status IN ('success', 'failed')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT webhooks_url_not_empty CHECK (url <> ''),
  CONSTRAINT webhooks_events_not_empty CHECK (array_length(events, 1) > 0),
  CONSTRAINT webhooks_max_events CHECK (array_length(events, 1) <= 50)
);

-- Efficient lookup: all webhooks for a tenant (fan-out on event receipt)
CREATE INDEX idx_webhooks_tenant_id
  ON gateway.webhooks(tenant_id)
  WHERE enabled = true;

-- Throttle check: find throttled webhooks that are ready to un-throttle
CREATE INDEX idx_webhooks_throttled_until
  ON gateway.webhooks(throttled_until)
  WHERE throttled_until IS NOT NULL;

-- updated_at trigger
CREATE TRIGGER set_webhooks_updated_at
  BEFORE UPDATE ON gateway.webhooks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

**Design notes:**
- `secret_hash` is a bcrypt hash. The raw secret is returned once on creation and never stored in plaintext.
- `custom_headers` is JSONB, not a relational table. The expected cardinality is 0-5 headers; JSONB avoids a join on every delivery.
- `events` is a `TEXT[]` column. Pattern matching (trie) happens in application code at delivery time, not in SQL.
- `consecutive_failures` and `throttled_until` support the backpressure mechanism without a separate table.
- Soft deletes are not used. A deleted webhook is gone. Delivery history is retained in `webhook_deliveries` for 7 days by the retention job.

### 4.2 gateway.webhook_deliveries

Delivery log. Retains the last 100 deliveries per webhook, with a 7-day time-based retention.

```sql
CREATE TABLE gateway.webhook_deliveries (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id      UUID        NOT NULL REFERENCES gateway.webhooks(id) ON DELETE CASCADE,
  tenant_id       UUID        NOT NULL,  -- denormalized for retention job efficiency
  event_id        UUID        NOT NULL,  -- PlatformEvent.eventId (idempotency key)
  event_type      TEXT        NOT NULL,
  delivery_id     UUID        NOT NULL,  -- stable across retries; UUIDv4 generated at first attempt
  attempt         INTEGER     NOT NULL DEFAULT 1,
  requested_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at    TIMESTAMPTZ,
  status_code     INTEGER,               -- NULL on timeout or DNS failure
  response_body   TEXT,                  -- first 1024 bytes of response body
  error           TEXT,                  -- error message if no HTTP response
  duration_ms     INTEGER,
  success         BOOLEAN     NOT NULL GENERATED ALWAYS AS (
                    status_code >= 200 AND status_code < 300
                  ) STORED,

  CONSTRAINT webhook_deliveries_attempt_positive CHECK (attempt >= 1 AND attempt <= 9)
);

-- Fan-out: all deliveries for a specific webhook in reverse chronological order
CREATE INDEX idx_webhook_deliveries_webhook_id_requested_at
  ON gateway.webhook_deliveries(webhook_id, requested_at DESC);

-- Retention job: delete deliveries older than 7 days
CREATE INDEX idx_webhook_deliveries_requested_at
  ON gateway.webhook_deliveries(requested_at)
  WHERE requested_at < now() - INTERVAL '7 days';

-- Idempotency lookup: has this event_id + webhook already been successfully delivered?
CREATE UNIQUE INDEX idx_webhook_deliveries_event_delivery
  ON gateway.webhook_deliveries(webhook_id, event_id, attempt);
```

**Retention policy:**
- A background job runs every hour: `DELETE FROM gateway.webhook_deliveries WHERE requested_at < now() - INTERVAL '7 days'`.
- Per-webhook cap of 100 deliveries: after the DELETE, if a webhook still has more than 100 rows, delete the oldest rows beyond 100. This is done with a window function query, not a trigger, to avoid per-row overhead.

### 4.3 gateway.rate_limit_config

Per-tenant rate limit tier overrides. The global defaults are environment variables; this table stores only deviations from defaults.

```sql
CREATE TABLE gateway.rate_limit_config (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID        NOT NULL REFERENCES auth.tenants(id) ON DELETE CASCADE,
  tier_name        TEXT        NOT NULL,  -- 'standard' | 'pro' | 'enterprise' | 'custom'

  -- Per-tenant limits (NULL = use global default)
  req_per_min_tenant     INTEGER CHECK (req_per_min_tenant > 0),
  req_per_min_api_key    INTEGER CHECK (req_per_min_api_key > 0),
  burst_multiplier       NUMERIC(4,2) DEFAULT 2.0 CHECK (burst_multiplier >= 1.0 AND burst_multiplier <= 10.0),
  burst_duration_sec     INTEGER DEFAULT 5 CHECK (burst_duration_sec BETWEEN 1 AND 60),

  -- Specific API-key overrides (NULL = no key-level customization)
  api_key_overrides      JSONB,  -- {"keyId": {"req_per_min": 2000}}

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT rate_limit_config_tenant_unique UNIQUE (tenant_id)
);

CREATE TRIGGER set_rate_limit_config_updated_at
  BEFORE UPDATE ON gateway.rate_limit_config
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

**Rate limit config caching:** This table is read once per tenant on first request and cached in the Gateway in-memory LRU cache (1000 entries, 5-minute TTL). A Redis pub/sub message (`gateway:rate-limit-config-changed:{tenantId}`) invalidates the cache entry when an operator updates the tier.

---

## 5. API Endpoints — Full Route Table

### 5.1 Gateway-Owned Routes (not proxied)

These routes are implemented directly in the Gateway Service.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/healthz` | None | Liveness check |
| GET | `/readyz` | None | Readiness check |
| GET | `/api/v1/openapi.json` | Bearer/APIKey | Tenant-specific OpenAPI 3.1 spec |
| GET | `/docs/api` | None | Interactive API explorer (Scalar) |
| GET | `/api/v1/events/stream` | Bearer/APIKey | SSE event subscription |
| POST | `/api/v1/webhooks/outbound` | Bearer/APIKey | Register outbound webhook |
| GET | `/api/v1/webhooks/outbound` | Bearer/APIKey | List outbound webhooks |
| GET | `/api/v1/webhooks/outbound/{id}` | Bearer/APIKey | Get outbound webhook |
| PUT | `/api/v1/webhooks/outbound/{id}` | Bearer/APIKey | Update outbound webhook |
| DELETE | `/api/v1/webhooks/outbound/{id}` | Bearer/APIKey | Delete outbound webhook |
| POST | `/api/v1/webhooks/outbound/{id}/test` | Bearer/APIKey | Send test delivery |
| GET | `/api/v1/webhooks/outbound/{id}/deliveries` | Bearer/APIKey | List delivery history |

### 5.2 Data Routes (auto-generated from ontology)

These routes are registered dynamically from the Gateway's ontology cache. The route handlers proxy to the Ontology Service.

| Method | Path | Auth | Proxied to |
|--------|------|------|------------|
| GET | `/api/v1/data/{entityType}` | Bearer/APIKey | Ontology :3003 |
| GET | `/api/v1/data/{entityType}/{id}` | Bearer/APIKey | Ontology :3003 |
| POST | `/api/v1/data/{entityType}` | Bearer/APIKey | Ontology :3003 |
| PATCH | `/api/v1/data/{entityType}/{id}` | Bearer/APIKey | Ontology :3003 |
| DELETE | `/api/v1/data/{entityType}/{id}` | Bearer/APIKey | Ontology :3003 |
| POST | `/api/v1/data/{entityType}/bulk` | Bearer/APIKey | Ontology :3003 |

### 5.3 Proxied Routes by Service

All routes not in sections 5.1 or 5.2 are proxied verbatim to the appropriate internal service. The Gateway validates auth, enforces rate limits, and then forwards the request with added service headers.

#### Auth Service (port 3001)

| Method | Path | Notes |
|--------|------|-------|
| POST | `/api/v1/auth/register` | No auth required |
| POST | `/api/v1/auth/login` | No auth required |
| POST | `/api/v1/auth/logout` | Bearer required |
| POST | `/api/v1/auth/refresh` | No auth required (refresh token in body) |
| POST | `/api/v1/auth/bootstrap` | Bootstrap token required (one-time) |
| GET | `/api/v1/auth/bootstrap/status` | No auth required |
| POST | `/api/v1/auth/forgot-password` | No auth required |
| POST | `/api/v1/auth/reset-password/{token}` | No auth required |
| GET | `/api/v1/auth/verify-email/{token}` | No auth required |
| GET | `/api/v1/auth/oauth/{provider}/authorize` | No auth required |
| GET | `/api/v1/auth/oauth/{provider}/callback` | No auth required |
| POST | `/api/v1/auth/keys` | Bearer required |
| GET | `/api/v1/auth/keys` | Bearer required |
| DELETE | `/api/v1/auth/keys/{id}` | Bearer required |
| POST | `/api/v1/auth/keys/{id}/rotate` | Bearer required |
| GET | `/api/v1/roles` | Bearer required |
| POST | `/api/v1/roles` | Bearer required |
| PATCH | `/api/v1/roles/{id}` | Bearer required |

#### Ingestion Service (port 3002)

| Method | Path |
|--------|------|
| GET/POST | `/api/v1/connectors` |
| GET/PATCH/DELETE | `/api/v1/connectors/{id}` |
| POST | `/api/v1/connectors/{id}/test` |
| POST | `/api/v1/connectors/{id}/trigger` |
| GET | `/api/v1/connectors/{id}/syncs` |
| GET | `/api/v1/connectors/{id}/syncs/{syncId}/progress` |
| POST | `/api/v1/webhooks/inbound` |
| POST | `/api/v1/webhooks/inbound/{id}/receive` |
| POST | `/api/v1/uploads` |
| GET | `/api/v1/uploads/{id}/status` |

#### Ontology Service (port 3003)

| Method | Path |
|--------|------|
| GET/POST | `/api/v1/ontology` |
| GET/PATCH/DELETE | `/api/v1/ontology/{entityType}` |
| POST | `/api/v1/ontology/{entityType}/validate` |
| GET | `/api/v1/ontology/migrations` |
| GET | `/api/v1/ontology/migrations/{id}` |
| POST | `/api/v1/ontology/migrations/{id}/confirm` |
| POST | `/api/v1/ontology/migrations/{id}/rollback` |
| GET | `/api/v1/ontology/migrations/{id}/status` |

#### Pipeline Service (port 3004)

| Method | Path |
|--------|------|
| GET/POST | `/api/v1/pipelines` |
| GET/PATCH/DELETE | `/api/v1/pipelines/{id}` |
| POST | `/api/v1/pipelines/{id}/trigger` |
| GET | `/api/v1/pipelines/{id}/runs` |
| GET | `/api/v1/pipeline-runs/{runId}` |
| POST | `/api/v1/pipeline-runs/{runId}/cancel` |
| GET | `/api/v1/pipeline-runs/{runId}/logs` |
| GET/POST | `/api/v1/schedules` |
| PATCH/DELETE | `/api/v1/schedules/{id}` |

#### Execution Service (port 3005)

| Method | Path |
|--------|------|
| POST | `/api/v1/exec/run` |
| GET | `/api/v1/exec/{id}` |
| GET | `/api/v1/exec/{id}/logs` |

#### App Service (port 3006)

| Method | Path |
|--------|------|
| GET/POST | `/api/v1/apps` |
| GET/PATCH/DELETE | `/api/v1/apps/{id}` |
| GET | `/api/v1/apps/{id}/files` |
| GET/PUT/DELETE | `/api/v1/apps/{id}/files/{path}` |
| POST | `/api/v1/apps/{id}/builds` |
| GET | `/api/v1/apps/{id}/builds/{buildId}/logs/stream` |
| POST | `/api/v1/apps/{id}/deploy` |
| POST | `/api/v1/apps/{id}/rollback` |
| GET | `/api/v1/apps/{id}/roles` |
| `*` | `/apps/{slug}/*` | Path-based app serving |

#### Logging Service (port 3007)

| Method | Path |
|--------|------|
| GET | `/api/v1/logs` |
| GET | `/api/v1/logs/{id}` |
| GET | `/api/v1/audit-events` |

#### Plugin Service (port 3008)

| Method | Path |
|--------|------|
| GET/POST | `/api/v1/plugins` |
| GET/DELETE | `/api/v1/plugins/{id}` |
| POST | `/api/v1/plugins/{id}/enable` |
| POST | `/api/v1/plugins/{id}/disable` |

### 5.4 Internal Routes (not proxied, not public)

The `GET /internal/*` namespace is blocked at the Gateway — all requests to `/internal/` receive `404 Not Found`. Internal service-to-service calls use the Docker internal network directly (e.g., `http://auth-service:3001/internal/auth/validate`) and never pass through the Gateway.

---

## 6. Request Routing and Proxy Logic

### 6.1 Route Resolution Order

Hono evaluates routes in registration order. The Gateway registers routes in this priority:

1. `/healthz`, `/readyz` — exact match, no middleware stack.
2. `/api/v1/webhooks/outbound/*` — Gateway-owned webhook management.
3. `/api/v1/events/stream` — Gateway-owned SSE.
4. `/api/v1/openapi.json`, `/docs/api` — Gateway-owned spec endpoints.
5. `/api/v1/data/:entityType/*` — dynamic data routes (registered after ontology cache loads).
6. `/internal/*` — blocked with 404.
7. `/api/v1/:service/*` — catch-all proxy to internal services.
8. `/apps/:slug/*` — proxy to App Service.

### 6.2 Service URL Mapping

The proxy target is resolved from the route prefix using a static map. Each entry is configurable via environment variables to support non-default Docker Compose service names.

```typescript
const SERVICE_MAP: Record<string, string> = {
  "auth":         process.env.AUTH_SERVICE_URL      ?? "http://auth-service:3001",
  "connectors":   process.env.INGESTION_SERVICE_URL ?? "http://ingestion-service:3002",
  "webhooks/inbound": process.env.INGESTION_SERVICE_URL ?? "http://ingestion-service:3002",
  "uploads":      process.env.INGESTION_SERVICE_URL ?? "http://ingestion-service:3002",
  "ontology":     process.env.ONTOLOGY_SERVICE_URL  ?? "http://ontology-service:3003",
  "pipelines":    process.env.PIPELINE_SERVICE_URL  ?? "http://pipeline-service:3004",
  "pipeline-runs":process.env.PIPELINE_SERVICE_URL  ?? "http://pipeline-service:3004",
  "schedules":    process.env.PIPELINE_SERVICE_URL  ?? "http://pipeline-service:3004",
  "exec":         process.env.EXECUTION_SERVICE_URL ?? "http://execution-service:3005",
  "apps":         process.env.APP_SERVICE_URL        ?? "http://app-service:3006",
  "logs":         process.env.LOGGING_SERVICE_URL    ?? "http://logging-service:3007",
  "audit-events": process.env.LOGGING_SERVICE_URL    ?? "http://logging-service:3007",
  "plugins":      process.env.PLUGIN_SERVICE_URL     ?? "http://plugin-service:3008",
  "roles":        process.env.AUTH_SERVICE_URL        ?? "http://auth-service:3001",
};
```

### 6.3 Proxy Request Transformation

Before forwarding, the Gateway adds these headers to the upstream request:

```
X-Forwarded-For:     {client IP}
X-Forwarded-Proto:   https (or http in dev)
X-OnePlatform-Request-ID:  {W3C trace ID}
X-OnePlatform-Tenant-ID:   {tenantId from validated token}
X-OnePlatform-User-ID:     {userId from validated token}
X-OnePlatform-User-Roles:  {comma-separated roles}
X-OnePlatform-Key-ID:      {apiKeyId if API-key auth, else omitted}
X-Service-Token:     {Ed25519-signed service token from Gateway's keypair}
traceparent:         {W3C Trace Context propagation header}
```

The `X-Service-Token` is the Ed25519 JWT signed by the Gateway's private key (`OP_GATEWAY_PRIVATE_KEY`). Internal services verify this token using the Gateway's public key from the service RBAC matrix in `@oneplatform/core`. This prevents any external caller from spoofing the service identity headers.

**Headers stripped from client requests before forwarding:**
- `X-Service-Token` — clients cannot inject service tokens
- `X-OnePlatform-Tenant-ID`, `X-OnePlatform-User-ID`, `X-OnePlatform-User-Roles` — clients cannot spoof identity

### 6.4 Upstream Timeout and Circuit Breaker

Each upstream call has a configurable timeout:

| Service | Default timeout | Rationale |
|---------|----------------|-----------|
| Auth | 5,000 ms | Should be fast; used on every request |
| Ingestion | 30,000 ms | File uploads, sync triggers can be slow |
| Ontology | 10,000 ms | Migrations can take time; reads are fast |
| Pipeline | 10,000 ms | Trigger is async; status reads are fast |
| Execution | 35,000 ms | 30s code execution + 5s overhead |
| App | 10,000 ms | Build jobs are async |
| Logging | 5,000 ms | Should be fast |
| Plugin | 10,000 ms | Bundle fetch may be slow on first load |

**Upstream errors:** if the upstream returns a non-2xx response, the Gateway forwards the response verbatim (status code and body) to the client. The Gateway does not re-interpret or transform upstream errors.

**Timeout handling:** if the upstream does not respond within the configured timeout, the Gateway returns:
```json
HTTP 503
{
  "error": {
    "code": "SERVICE_UNAVAILABLE",
    "message": "The auth service did not respond in time. Please try again.",
    "details": { "service": "auth", "timeoutMs": 5000 },
    "requestId": "01J4WZJHK8GN9..."
  }
}
```

**Retry policy for proxied requests:** the Gateway does NOT retry proxied requests automatically. Retrying non-idempotent requests (POST, PATCH, DELETE) on transient errors can cause duplicate writes. Clients are responsible for retrying with exponential backoff. The `Retry-After` header is included on 503 responses.

**Per-service circuit breaker:** each upstream target has an in-process circuit breaker (half-open state after 10s). After 5 consecutive timeout/5xx errors within 60 seconds, the breaker opens and the Gateway immediately returns 503 without attempting the upstream call. This prevents thread exhaustion from piling up against a down service.

---

## 7. Auth Validation

The Gateway validates every authenticated request before routing. It does NOT call the Auth Service on every request — it validates JWTs locally and checks the Redis revocation set.

### 7.1 JWT Validation

```
Authorization: Bearer {jwt}
```

1. Decode the JWT header to get `kid` (key ID).
2. Look up the Ed25519 public key for `kid` from the in-memory key cache (populated at startup from `OP_JWT_PUBLIC_KEY`).
3. Verify the JWT signature.
4. Check `exp` claim — reject if expired.
5. Check `jti` claim against the Redis revocation set (`auth:revoked:{jti}`). If the key exists, return 401.
6. Extract `tenantId`, `userId`, `roles`, `scopes` from claims.
7. Store as `c.var.user` for downstream middleware and route handlers.

If any step fails: `401 UNAUTHORIZED`.

### 7.2 API Key Validation

```
X-API-Key: op_live_{base64-encoded-random-bytes}
```

1. Extract the key prefix (first 8 chars after `op_live_` or `op_test_`).
2. Look up the key hash in the in-memory API key cache (LRU, 10,000 entries, 1-minute TTL), keyed by prefix.
3. On cache miss: call the Auth Service `GET /internal/auth/validate?keyPrefix={prefix}` to get the full key record.
4. Compare the provided key against the stored bcrypt hash using `bcrypt.compare()`.
5. Check the key's `revoked` flag in the Redis revocation set (`auth:revoked-key:{keyId}`).
6. Extract `tenantId`, `userId`, `scopes` from the key record.
7. Store as `c.var.user` for downstream middleware and route handlers.

**Scope enforcement:** route handlers declare their required scope. The Gateway middleware checks `c.var.user.scopes` against the required scope before routing. If the scope is missing: `403 INSUFFICIENT_SCOPE`.

**Timing safety:** the bcrypt comparison uses a constant-time function. The API key lookup from Redis uses the key prefix, not the full key, to avoid exposing the key in Redis logs.

### 7.3 Service Token Pass-Through

Requests with `X-Service-Token` are internal service calls. The Gateway validates the token using `@oneplatform/core`'s `serviceAuthMiddleware` and routes them without further auth checks. Service tokens are not subject to rate limiting (except a separate high-limit service rate limit of 100,000 req/min). Service tokens never appear in client-facing responses.

---

## 8. Rate Limiting

Implements ADR-20. The rate limiting layer is the first thing that can block a request (after CORS and before auth), so a compromised or misbehaving client is stopped before hitting any backend.

### 8.1 Tier Architecture

| Tier | Limit | Storage | Key Pattern | Applied When |
|------|-------|---------|-------------|--------------|
| Global | 10,000 req/min (configurable via `OP_GLOBAL_RATE_LIMIT`) | Redis | `ratelimit:global:{windowStart}` | Always |
| Per-tenant | 1,000 req/min (default; overridden by `gateway.rate_limit_config`) | Redis | `ratelimit:tenant:{tenantId}:{windowStart}` | After auth |
| Per-API-key | 500 req/min (default; overridden per key at creation) | Redis | `ratelimit:key:{keyId}:{windowStart}` | After auth, API-key requests only |
| Webhook inbound | 100 req/sec (separate from API limits) | Redis | `ratelimit:webhook:{endpointId}:{windowStart}` | `/api/v1/webhooks/inbound/{id}/receive` |

**Burst:** each tier allows a 2x burst for 5 seconds. During a burst window, the effective limit doubles. After 5 seconds, the limit reverts to normal. This handles legitimate traffic spikes (e.g., a pipeline completing and triggering many downstream calls at once).

**Most-restrictive policy header:** the `X-RateLimit-Policy` response header reports which tier imposed the tightest constraint. If the per-tenant limit is 800 req/min and the global limit is 10,000, the header shows `per-tenant` and the `X-RateLimit-Limit` shows `800`.

### 8.2 Sliding Window Algorithm

The sliding window uses two Redis keys per tier per window: the current 1-minute window counter and the previous window counter. The effective rate is interpolated:

```
effectiveCount = prevWindowCount * (1 - elapsedFraction) + currentWindowCount
```

Where `elapsedFraction = (now - currentWindowStart) / windowDurationMs`.

This prevents the burst spike that occurs at the exact window boundary of fixed-window algorithms. The implementation uses a Lua script to atomically read both counters, compute the effective count, and increment the current counter in a single round trip.

```lua
-- Redis Lua script: sliding_window_rate_limit.lua
-- KEYS[1] = current window key, KEYS[2] = previous window key
-- ARGV[1] = current window start (ms), ARGV[2] = window duration (ms), ARGV[3] = limit
local current = tonumber(redis.call('GET', KEYS[1])) or 0
local previous = tonumber(redis.call('GET', KEYS[2])) or 0
local elapsed = tonumber(ARGV[1]) % tonumber(ARGV[2])
local effective = previous * (1 - elapsed / tonumber(ARGV[2])) + current
if effective >= tonumber(ARGV[3]) then
  return {0, math.floor(effective), -1}  -- denied
end
redis.call('INCR', KEYS[1])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]) * 2)
local remaining = tonumber(ARGV[3]) - math.floor(effective) - 1
local reset = math.floor((tonumber(ARGV[1]) + tonumber(ARGV[2])) / 1000)
return {1, remaining, reset}  -- allowed, remaining, reset Unix timestamp
```

### 8.3 Redis Outage Fallback

When Redis is unreachable, the Gateway falls back to per-instance in-memory sliding windows. The replica count is determined in priority order:

1. **Primary:** the value of `gateway:replicas` in Redis (accurate during normal operation — incremented on startup, decremented on SIGTERM).
2. **Cached:** the last-known value from the most recent successful Redis read, held in memory.
3. **Env var:** `OP_GATEWAY_REPLICAS` — required in multi-replica deployments; the Docker Compose template populates this from `deploy.replicas`.
4. **Hard default:** if none of the above is available (cold start during Redis outage with no replica count), apply a conservative hard limit of 100 req/min globally.

The per-instance fallback limit is:

```
instanceLimit = floor(normalLimit / replicaCount)
```

This means the total effective limit across all instances is approximately correct even without Redis coordination.

**Fallback algorithm:** in-memory sliding window using an ordered array of timestamps, capped at `windowDuration * instanceLimit` entries. The `shift()` operation removes entries older than `windowDuration`.

**Fallback detection:** the Gateway detects Redis outage via the Redis client `error` event. It logs a `CRITICAL` warning and switches to fallback mode. When Redis recovers (first successful PING), it switches back to Redis mode and clears the in-memory windows.

### 8.4 Response Headers

Every response includes rate limit headers regardless of whether the request was rate limited. On 429, `Retry-After` is also included.

```
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 987
X-RateLimit-Reset: 1735689600
X-RateLimit-Policy: per-tenant
Retry-After: 13          (only on 429)
```

### 8.5 Rate Limit Error Response

```json
HTTP 429 Too Many Requests
{
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Rate limit exceeded. You have sent too many requests. Please retry after 13 seconds.",
    "details": {
      "policy": "per-tenant",
      "limit": 1000,
      "remaining": 0,
      "resetAt": "2026-06-10T14:31:00Z"
    },
    "requestId": "01J4WZJHK8GN9..."
  }
}
```

---

## 9. CORS Policy

The Gateway is the sole CORS enforcer. Internal services do not set CORS headers.

### 9.1 Configuration

```
OP_ALLOWED_ORIGINS=https://app.example.com,http://localhost:4000
```

In production, a wildcard `*` is rejected at startup with a fatal error and explicit message:
```
FATAL: OP_ALLOWED_ORIGINS must not be '*' in production. Set explicit origins.
```

Development default (when `NODE_ENV=development`): `http://localhost:3000,http://localhost:4000`.

### 9.2 CORS Headers Added to All Responses

```
Access-Control-Allow-Origin: https://app.example.com   (matching origin only)
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Headers: Authorization, Content-Type, X-API-Key, X-Requested-With
Access-Control-Expose-Headers: X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset,
                               X-RateLimit-Policy, X-OnePlatform-Request-ID
Access-Control-Max-Age: 86400
Access-Control-Allow-Credentials: true
```

`Access-Control-Allow-Credentials: true` is only set when the origin is explicitly in the allowlist (not when using a wildcard default, which is not permitted in production).

### 9.3 Non-Allowlisted Origins

Requests from origins not in `OP_ALLOWED_ORIGINS` are rejected with `403 ORIGIN_NOT_ALLOWED` — a proper 403, not a CORS error. This prevents information leakage via CORS error messages (an attacker cannot distinguish "origin not allowed" from "you are not authenticated" through CORS headers).

```json
HTTP 403
{
  "error": {
    "code": "ORIGIN_NOT_ALLOWED",
    "message": "The origin 'https://evil.example.com' is not permitted.",
    "requestId": "01J4WZJHK8GN9..."
  }
}
```

### 9.4 Preflight Handling

`OPTIONS` requests matching an allowed origin receive `204 No Content` with the CORS headers above. Preflight responses are not rate limited. The `Access-Control-Max-Age: 86400` header means browsers cache the preflight result for 24 hours.

---

## 10. Auto-Generated Data Routes

Routes under `/api/v1/data/{entityType}` are generated dynamically from the ontology cache. They are not hardcoded in the router — they are registered when the ontology cache is populated and re-registered when the cache is refreshed.

### 10.1 Ontology Cache

The Gateway maintains a per-tenant in-memory ontology cache:

```typescript
interface OntologyCache {
  tenantId: string;
  schemaVersion: number;
  entities: Map<string, EntityDefinition>;  // entityType → definition
  lastFetchedAt: Date;
}
```

**Population:** on startup, the Gateway calls `GET http://ontology-service:3003/internal/ontology/schema?tenantId={all}` to fetch all tenant schemas. This is a service-authenticated call (X-Service-Token).

**Invalidation:** the Gateway subscribes to Redis pub/sub channel `ontology:changed` (pattern: `ontology:*`). On receiving a `{tenantId, newVersion, diff}` message, the Gateway fetches the updated schema for that tenant and hot-swaps the cache entry.

**Safety net poll:** every 5 minutes, the Gateway checks each cache entry's `schemaVersion` against the Ontology Service's current version using a conditional `GET` with `If-None-Match: {schemaVersion}`. A cache miss triggers a full re-fetch. This catches any pub/sub messages missed during network hiccups.

**Ontology Service unavailability:** if the Ontology Service is down at startup, the Gateway starts with an empty ontology cache. Data routes (`/api/v1/data/*`) return `503 SERVICE_UNAVAILABLE` with message: `"Data API routes are temporarily unavailable while schema is loading."`. Non-data routes (proxied routes) are unaffected. Once the Ontology Service recovers, the safety-net poll re-populates the cache.

### 10.2 Dynamic Route Registration

When a new entity is added to the ontology cache, the Gateway calls an internal `registerEntityRoutes(entityType)` function:

```typescript
function registerEntityRoutes(entityType: string, app: Hono): void {
  const prefix = `/api/v1/data/${entityType}`;
  app.get(prefix, authMiddleware, rateLimitMiddleware, proxyToOntology);
  app.get(`${prefix}/:id`, authMiddleware, rateLimitMiddleware, proxyToOntology);
  app.post(prefix, authMiddleware, rateLimitMiddleware, proxyToOntology);
  app.patch(`${prefix}/:id`, authMiddleware, rateLimitMiddleware, proxyToOntology);
  app.delete(`${prefix}/:id`, authMiddleware, rateLimitMiddleware, proxyToOntology);
  app.post(`${prefix}/bulk`, authMiddleware, rateLimitMiddleware, proxyToOntology);
}
```

**Route conflict prevention:** the entityType is validated against a reserved-word list (`bulk`, `schema`, `migrations`, `validate`) before registration. An entityType that would conflict with a reserved path is rejected at ontology creation time by the Ontology Service.

**Unknown entity types:** a request to `/api/v1/data/nonexistent` where `nonexistent` is not in the ontology cache returns `404 ENTITY_NOT_FOUND`. The Gateway does NOT proxy unknown entity types to the Ontology Service — the 404 is authoritative and immediate.

### 10.3 Request Flow for Data Routes

```
Client: GET /api/v1/data/customer?filter[status][eq]=active
  │
  ├── Gateway: look up "customer" in ontology cache for tenant
  ├── Gateway: confirm entityType is registered for this tenant
  ├── Gateway: validate request headers, run rate limit check
  └── Gateway: proxy to http://ontology-service:3003/api/v1/data/customer?filter[status][eq]=active
                  with X-OnePlatform-Tenant-ID, X-OnePlatform-User-ID, X-Service-Token headers
```

The Ontology Service receives the request, validates the filter against the entity's field list, and executes the query.

---

## 11. Outbound Webhook System

Implements ADR-30. The Gateway is the sole owner of outbound webhook delivery. No other service sends outbound HTTP requests to user-registered URLs.

### 11.1 Registration Flow

```
POST /api/v1/webhooks/outbound
{
  "url": "https://hooks.example.com/oneplatform",
  "events": ["pipeline.*", "data.created"],
  "description": "Notify our CI when pipelines complete",
  "headers": { "Authorization": "Bearer my-token" }
}
```

**Validation steps (in order):**

1. **Schema validation:** Zod schema validates `url`, `events`, `description`, `headers`, `enabled`.
2. **URL protocol check:** `url` must start with `https://`. If `OP_WEBHOOK_ALLOW_HTTP=true` (development only), `http://` is permitted.
3. **SSRF prevention — DNS resolution:** resolve the hostname to an IP address and check against blocked ranges:
   - Private: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`
   - Loopback: `127.0.0.0/8`, `::1`
   - Link-local: `169.254.0.0/16` (blocks AWS/GCP metadata endpoints `169.254.169.254`)
   - Docker DNS: any hostname resolving to a Docker network gateway (typically `172.17.0.1` or `172.18.0.1`)
   - If the hostname resolves to multiple IPs (CDN), ALL IPs are checked.
4. **SSRF prevention — hostname check:** hostnames `localhost`, `*.local`, or any service name matching `*-service` are rejected even before DNS resolution.
5. **Connectivity check:** send a `POST` to the URL with body `{"test": true, "eventType": "webhook.registered"}` and `Content-Type: application/json`. If the response is not 2xx within 5 seconds, registration fails with a clear error message including the status code.
6. **Secret generation:** if no `secret` is provided in the request, generate a 32-byte random secret using `crypto.randomBytes(32).toString('hex')`. Return the raw secret in the response body. Store `bcrypt.hash(rawSecret, 12)` in the database.
7. **Write to database:** insert into `gateway.webhooks`.

**Registration failure response examples:**

```json
HTTP 422
{
  "error": {
    "code": "GATEWAY_WEBHOOK_SSRF_BLOCKED",
    "message": "The webhook URL resolves to a private IP address (10.0.0.5) and cannot be registered.",
    "details": { "url": "https://internal.company.com/hook", "resolvedIp": "10.0.0.5" },
    "requestId": "..."
  }
}
```

```json
HTTP 422
{
  "error": {
    "code": "GATEWAY_WEBHOOK_CONNECTIVITY_FAILED",
    "message": "The webhook URL returned HTTP 404. Ensure your endpoint is reachable and returns 2xx.",
    "details": { "url": "https://hooks.example.com/bad-path", "statusCode": 404 },
    "requestId": "..."
  }
}
```

### 11.2 SSRF Re-Validation on Every Delivery

DNS rebinding can allow an attacker to register a webhook with a legitimate URL that later resolves to an internal IP. To prevent this, the IP is re-resolved and re-validated **on every delivery attempt**, not just at registration:

```typescript
async function validateDeliveryTarget(url: string): Promise<void> {
  const hostname = new URL(url).hostname;
  const addresses = await dns.promises.resolve4(hostname);   // IPv4
  const addresses6 = await dns.promises.resolve6(hostname).catch(() => []); // IPv6
  const allAddresses = [...addresses, ...addresses6];
  for (const ip of allAddresses) {
    if (isBlockedIpRange(ip)) {
      throw new AppError("GATEWAY_WEBHOOK_SSRF_BLOCKED",
        `Delivery blocked: ${hostname} resolved to blocked IP ${ip}`, 422);
    }
  }
}
```

If the re-validation fails on delivery, the delivery attempt is failed immediately (counted as an attempt), and the specific error is recorded in `gateway.webhook_deliveries.error`.

### 11.3 HMAC-SHA256 Signing

Each delivery includes a signature computed over the raw request body bytes:

```typescript
const rawBody = JSON.stringify(event);  // deterministic serialization
const signature = crypto.createHmac('sha256', rawSecret)
  .update(rawBody)
  .digest('hex');
const signatureHeader = `sha256=${signature}`;
```

**Secret retrieval:** the Gateway stores the bcrypt hash in the database. The raw secret is needed to compute HMAC. Resolution:
- The raw secret is NOT stored anywhere in the Gateway after registration.
- Instead, the `X-OnePlatform-Signature` mechanism requires the webhook owner to store their raw secret. The Gateway's delivery worker fetches the webhook record from the database. Since the raw secret cannot be recovered from the bcrypt hash, the Gateway uses a different approach: the secret is re-encrypted (AES-256-GCM, using `OP_MASTER_KEY` via `@oneplatform/core`'s `encrypt()`) and stored in a separate `secret_encrypted` column alongside `secret_hash`. The hash is used for client verification proofs; the encrypted value is used by the delivery worker.

**Database column update for gateway.webhooks:**

```sql
ALTER TABLE gateway.webhooks
  ADD COLUMN secret_encrypted TEXT NOT NULL;
-- secret_hash: bcrypt hash (for client-side "verify my secret" endpoint if needed)
-- secret_encrypted: AES-256-GCM ciphertext (for delivery worker to compute HMAC)
```

### 11.4 BullMQ Delivery Queue

The Gateway subscribes to Redis `PSUBSCRIBE events:*`. On receiving a published event:

1. Parse the `PlatformEvent` from the pub/sub message.
2. Look up all enabled webhooks for `event.tenantId` where the webhook's `events` patterns match `event.eventType`.
3. For each matching webhook, enqueue a BullMQ job to the `outbound-webhooks` queue.

**BullMQ queue configuration:**

```typescript
const outboundWebhooksQueue = createQueue('outbound-webhooks', redisClient, {
  defaultJobOptions: {
    attempts: 9,
    backoff: {
      type: 'custom',
      // delays in ms: 0, 1000, 5000, 30000, 120000, 600000, 3600000, 21600000, 86400000
    },
    removeOnComplete: { count: 1000, age: 86400 },
    removeOnFail: false,  // DLQ handles failed jobs
  },
});
```

**Retry schedule:**

| Attempt | Delay before retry |
|---------|--------------------|
| 1 | 0 ms (immediate) |
| 2 | 1,000 ms |
| 3 | 5,000 ms |
| 4 | 30,000 ms |
| 5 | 120,000 ms (2 min) |
| 6 | 600,000 ms (10 min) |
| 7 | 3,600,000 ms (1 hr) |
| 8 | 21,600,000 ms (6 hr) |
| 9 | 86,400,000 ms (24 hr) |

After attempt 9: the job moves to the `webhook-delivery:dlq` BullMQ queue (created via `createDlqQueue()` from core). A `dlq.job.added` event is emitted to Redis pub/sub. The `_isWebhookDlq: true` flag in the DLQ event payload prevents infinite loop re-delivery.

### 11.5 Delivery Worker

The delivery worker processes jobs from the `outbound-webhooks` queue:

```typescript
const deliveryWorker = createWorker('outbound-webhooks', async (job) => {
  const { webhookId, event, deliveryId, attempt } = job.data;

  // 1. Fetch webhook record (includes secret_encrypted, url, custom_headers)
  const webhook = await db.query.webhooks.findFirst(webhookId);
  if (!webhook || !webhook.enabled) {
    return;  // Webhook deleted or disabled mid-retry; discard
  }

  // 2. Re-validate target IP (SSRF prevention)
  await validateDeliveryTarget(webhook.url);

  // 3. Decrypt secret for HMAC
  const rawSecret = decrypt(webhook.secretEncrypted);

  // 4. Build request
  const body = JSON.stringify(event);
  const signature = computeHmac(rawSecret, body);
  const headers = {
    'Content-Type': 'application/json',
    'X-OnePlatform-Signature': `sha256=${signature}`,
    'X-OnePlatform-Event': event.eventType,
    'X-OnePlatform-Delivery': deliveryId,
    'X-OnePlatform-Timestamp': String(Math.floor(Date.now() / 1000)),
    ...webhook.customHeaders,
  };

  // 5. Send with 30s timeout
  const startMs = Date.now();
  let statusCode: number | null = null;
  let responseBody: string | null = null;
  let error: string | null = null;

  try {
    const response = await fetch(webhook.url, {
      method: 'POST', body, headers,
      signal: AbortSignal.timeout(30_000),
    });
    statusCode = response.status;
    responseBody = (await response.text()).slice(0, 1024);
    if (!response.ok) throw new Error(`HTTP ${statusCode}`);
  } catch (err) {
    error = (err as Error).message;
    throw err;  // BullMQ retries on throw
  } finally {
    // 6. Log delivery (always, even on failure)
    await logDelivery({
      webhookId, eventId: event.eventId, eventType: event.eventType,
      deliveryId, attempt, statusCode, responseBody, error,
      durationMs: Date.now() - startMs,
    });
  }

  // 7. Update webhook stats and reset consecutive_failures on success
  await updateWebhookStats(webhookId, true);
}, redisClient);
```

**Backpressure throttling:** on job failure, the worker checks `consecutive_failures`. If 5 or more consecutive failures, it sets `throttled_until = now() + 1 hour` on the webhook record. The BullMQ worker checks `throttled_until` before attempting delivery and delays the job (moves it back to the delayed set) if still within the throttle window.

### 11.6 Delivery Log Write

Every delivery attempt writes a row to `gateway.webhook_deliveries`. The write is asynchronous — it does not block the delivery worker. If the write fails (e.g., Postgres is transiently unavailable), the failure is logged via the structured logger but does not cause the BullMQ job to fail or retry.

### 11.7 Test-Send API

`POST /api/v1/webhooks/outbound/{id}/test` sends a single synchronous delivery with no retry. The response includes the result within 30 seconds:

```json
{
  "data": {
    "deliveryId": "01J4WZJHK8GN9ABCDEF01234567",
    "statusCode": 200,
    "latencyMs": 142,
    "success": true
  }
}
```

On failure:
```json
{
  "data": {
    "deliveryId": "01J4WZJHK8GN9ABCDEF01234567",
    "statusCode": 404,
    "latencyMs": 89,
    "success": false,
    "error": "HTTP 404 Not Found"
  }
}
```

---

## 12. SSE Event Streaming

Implements ADR-30. The SSE endpoint provides a real-time event stream scoped to the authenticated tenant.

### 12.1 Endpoint

```
GET /api/v1/events/stream?events=pipeline.*,data.created&Last-Event-ID=01J4WZJHK8GN9...
```

**Query parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `events` | Yes | Comma-separated event type patterns. `*` = all events. |
| `Last-Event-ID` | No | Event ID for replay. If provided, the stream replays buffered events after this ID before entering live mode. |

**Authentication:** standard Bearer JWT or X-API-Key. The connection is scoped to the tenant in the token. Unauthenticated requests receive `401 UNAUTHORIZED` immediately.

### 12.2 Per-Tenant Ring Buffer

Each Gateway instance maintains a per-tenant in-memory ring buffer. The ring buffer is not shared across replicas.

```typescript
interface TenantRingBuffer {
  tenantId: string;
  events: PlatformEvent[];  // circular array, capacity 1000
  head: number;             // index of the oldest event
  size: number;             // current number of events (0 to 1000)
}

// LRU eviction: if tenantId not accessed in 15 minutes, the buffer is freed
const ringBuffers = new LRUCache<string, TenantRingBuffer>({
  max: 500,             // max 500 tenants per Gateway instance
  ttl: 15 * 60 * 1000, // 15-minute LRU TTL
});
```

**Buffer writes:** the Gateway's Redis `PSUBSCRIBE events:*` handler writes each received event to the tenant's ring buffer. Buffer writes are synchronous and in-order.

**Buffer eviction:** when the buffer reaches 1000 events, the oldest event is overwritten (LRU). Clients that reconnect with a `Last-Event-ID` that is no longer in the buffer receive a `replay.overflow` synthetic event.

### 12.3 Connection Lifecycle

**On new connection:**

1. Validate auth (401 if invalid).
2. Parse `events` query parameter; compile patterns into a trie matcher.
3. Check connection count for this API key: if ≥ 10, return `429 Too Many Requests` with `Retry-After: 60`.
4. Increment `gateway:sse-connections:{keyId}` in Redis (TTL 70s, refreshed on heartbeat).
5. Set response headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `X-Accel-Buffering: no`.
6. If `Last-Event-ID` is provided: perform replay (section 12.4).
7. Enter live mode: register this connection as a subscriber to the tenant's event stream.
8. Start heartbeat timer (30-second interval, sends `: keepalive` SSE comment).

**On event arrival (live mode):**

1. Check if the event matches the client's `events` pattern filter using the compiled trie.
2. If no match: skip.
3. Write the SSE event to the response stream:
   ```
   id: {event.eventId}
   event: {event.eventType}
   data: {JSON.stringify(event)}
   retry: 5000

   ```
4. Check backpressure (section 12.5).

**On connection close (client disconnect or error):**

1. Remove the subscriber from the tenant event stream.
2. Clear the heartbeat timer.
3. Decrement `gateway:sse-connections:{keyId}` in Redis.

### 12.4 Replay (`Last-Event-ID`)

When a client reconnects with `Last-Event-ID={eventId}`:

1. Find the event with `eventId` in the tenant's ring buffer.
2. If found: emit all events after that event that match the client's `events` filter.
3. If not found (event is older than the buffer): emit a synthetic `replay.overflow` event to signal the client must re-fetch.

```
id: synthetic-replay-overflow
event: replay.overflow
data: {"message":"Some events may have been missed. Re-fetch entity state.","tenantId":"..."}

```

4. After replay (or immediately after `replay.overflow`), enter live mode.

### 12.5 Backpressure

Node.js tracks write buffer size per response stream. The Gateway monitors this:

- **> 512 KB:** stop emitting events with `level: "debug"` in the event payload. Only emit events with `level: "info"` or above.
- **> 1 MB:** close the connection with custom status:
  ```
  event: error
  data: {"code":"SSE_BUFFER_OVERFLOW","message":"Connection closed: write buffer exceeded 1MB. Reconnect with Last-Event-ID."}

  ```
  Then close the response stream. The `retry: 5000` directive in previous events tells the browser to reconnect after 5 seconds.

### 12.6 SSE Wire Format

Each event is formatted per the [W3C Server-Sent Events specification](https://html.spec.whatwg.org/multipage/server-sent-events.html):

```
id: 01J4WZJHK8GN9ABCDEF01234567
event: pipeline.completed
data: {"eventId":"01J4WZJHK8GN9ABCDEF01234567","eventType":"pipeline.completed","eventVersion":"1.0","tenantId":"...","timestamp":"2026-06-10T14:30:00.000Z","actor":{"type":"user","id":"..."},"data":{"pipelineId":"...","runId":"...","durationMs":4231,"outputRows":1500}}
retry: 5000

```

The empty line after `retry` terminates the event. The `retry: 5000` field (5 seconds) instructs the browser's `EventSource` to reconnect after 5 seconds on disconnect.

### 12.7 Multi-Replica Limitation

The ring buffer is per-Gateway-instance. In a multi-replica deployment:
- Live events go to the correct client regardless of which replica they connected to (each replica subscribes to `PSUBSCRIBE events:*` independently).
- Replay (`Last-Event-ID`) may miss events buffered by a different replica (the client connected to replica A, but events B, C, D were only received by replica B while the client was disconnected).
- This is documented behavior. Clients receive `replay.overflow` when the event is not in the local buffer, which is the correct signal to re-fetch.
- For guaranteed delivery across replicas, use outbound webhooks (BullMQ-backed, persistent).

---

## 13. OpenAPI Generation

### 13.1 Endpoint

```
GET /api/v1/openapi.json
```

**Authentication:** Bearer JWT or API key. The spec is tenant-aware — it includes auto-generated routes for the requesting tenant's ontology entities. Different tenants see different specs.

### 13.2 Generation Pipeline

1. Check the Redis cache: `GET ontology:{tenantId}:{schemaVersion}:openapi`. If present and TTL > 0, return the cached JSON.
2. On cache miss:
   a. Collect route definitions from all 9 services. Each service exposes `GET /internal/openapi/routes` which returns its Hono route definitions as a JSON array of `{method, path, requestSchema, responseSchema}` objects.
   b. Collect entity routes from the Gateway's ontology cache for this tenant.
   c. Merge all route definitions.
   d. Generate the OpenAPI 3.1 document using `@oneplatform/core`'s `openApiGenerator(routes, { tenantId })`.
   e. Cache the result in Redis: `SET ontology:{tenantId}:{schemaVersion}:openapi {spec} EX 300`.
3. Return `Content-Type: application/json`.

**Schema version invalidation:** when the Ontology Service publishes `ontology:changed` for a tenant, the Gateway deletes the cached spec for that tenant from Redis: `DEL ontology:{tenantId}:*:openapi`. The next request regenerates it.

### 13.3 Interactive Explorer

`GET /docs/api` serves the interactive API explorer (Scalar) as an HTML page. Scalar fetches the spec from `/api/v1/openapi.json`. The explorer is not gated by tenant auth — it renders the public surface of the API for exploration, but operations require auth.

---

## 14. Redis Usage

The Gateway Service uses Redis exclusively via key-prefix ACLs enforced by the Redis ACL rule: `~ratelimit:* ~gateway:* ~webhook:* &events:*`. The Gateway cannot access any key outside these prefixes, and cannot subscribe to channels outside `events:*`.

### 14.1 Key Patterns and TTLs

| Key Pattern | Purpose | TTL | Notes |
|-------------|---------|-----|-------|
| `ratelimit:global:{windowStart}` | Global rate limit counter | `windowDuration * 2` ms | Lua script managed |
| `ratelimit:tenant:{id}:{windowStart}` | Per-tenant counter | `windowDuration * 2` ms | Lua script managed |
| `ratelimit:key:{id}:{windowStart}` | Per-API-key counter | `windowDuration * 2` ms | Lua script managed |
| `ratelimit:webhook:{id}:{windowStart}` | Webhook inbound counter | `windowDuration * 2` ms | Lua script managed |
| `gateway:replicas` | Count of live Gateway instances | No TTL; managed via INCR/DECR | SIGTERM decrements |
| `gateway:sse-connections:{keyId}` | SSE connection count per API key | 70s (refreshed by heartbeat) | Prevents > 10 SSE per key |
| `gateway:rate-limit-config-changed:{tenantId}` | Rate limit config invalidation signal | 60s | Published by Auth/Admin |
| `ontology:{tenantId}:{schemaVersion}:openapi` | Cached OpenAPI spec | 300s (5 min) | Invalidated on schema change |
| `webhook:outbound-webhooks:*` | BullMQ job queue keys | BullMQ managed | Not accessed directly |

### 14.2 Pub/Sub Subscriptions

| Channel Pattern | Purpose |
|----------------|---------|
| `events:*` | All platform events for webhook fan-out and SSE ring buffer writes |
| `ontology:*` | Schema change notifications for ontology cache invalidation |
| `gateway:*` | Rate limit config change signals |

### 14.3 Redis Resilience

See ADR-18 (Redis Resilience) for the global Redis resilience strategy. Gateway-specific behavior:

- **Rate limiting fallback:** in-memory sliding windows (section 8.3).
- **SSE connections counter:** if Redis is unavailable, the SSE connection limit is enforced via an in-memory counter per Gateway instance (max 10 per key across connections on this instance only).
- **Pub/sub disconnect:** on Redis reconnect, the Gateway re-issues `PSUBSCRIBE events:*`. Events published during the disconnect window are missed by SSE (correct behavior — SSE is best-effort). The webhook delivery path is unaffected because BullMQ uses persistent storage.
- **OpenAPI cache miss:** if Redis is unavailable, the spec is regenerated on every request (no caching). This is expensive but functionally correct; the Gateway logs a warning.

---

## 15. Error Handling

### 15.1 Error Code Registry (Gateway-Specific)

The core error registry (from `@oneplatform/core/errors.ts`) covers all common codes. The Gateway adds these service-specific codes:

| Code | HTTP | Description |
|------|------|-------------|
| `GATEWAY_WEBHOOK_SSRF_BLOCKED` | 422 | Webhook URL resolves to a private/internal IP |
| `GATEWAY_WEBHOOK_CONNECTIVITY_FAILED` | 422 | Connectivity check to webhook URL failed |
| `GATEWAY_WEBHOOK_INVALID_URL` | 422 | Webhook URL is malformed or uses a disallowed protocol |
| `GATEWAY_SSE_CONNECTION_LIMIT` | 429 | Maximum SSE connections per API key exceeded |
| `GATEWAY_SSE_BUFFER_OVERFLOW` | N/A | Sent as SSE event before closing connection |
| `GATEWAY_ROUTE_NOT_FOUND` | 404 | No route matches the request path |
| `GATEWAY_PROXY_TIMEOUT` | 503 | Upstream service timeout |
| `GATEWAY_PROXY_UNAVAILABLE` | 503 | Upstream service circuit breaker open |
| `GATEWAY_ENTITY_TYPE_NOT_FOUND` | 404 | Entity type not in ontology cache for this tenant |

### 15.2 Upstream Error Pass-Through

When a proxied upstream service returns a 4xx or 5xx response, the Gateway passes the response through verbatim. The upstream service's response body is already in the standard `{ error: {...} }` envelope format (enforced by `@oneplatform/core`). The Gateway does not re-interpret, modify, or re-wrap upstream errors.

**Exception:** if the upstream returns a non-JSON response body (e.g., a crash with a plain text error), the Gateway wraps it:

```json
HTTP 500
{
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "An unexpected error occurred. Please try again.",
    "requestId": "..."
  }
}
```

The raw upstream response body is logged at `DEBUG` level with the request ID for operator inspection.

### 15.3 Gateway Internal Errors

Unhandled exceptions in Gateway-owned route handlers (webhook registration, SSE, OpenAPI) are caught by the `errorHandler` middleware from `@oneplatform/core`. The handler:

1. Logs the full error with stack trace at `ERROR` level via the structured logger.
2. Emits an OTEL span with error status.
3. Returns `500 INTERNAL_ERROR` to the client with request ID only (no stack trace).

### 15.4 Error Response Format

All error responses use the standard envelope from ADR-29:

```json
{
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Human-readable, safe to display in UI.",
    "details": { "...": "..." },
    "requestId": "01J4WZJHK8GN9..."
  }
}
```

Stack traces are NEVER included in API error responses. They are logged internally at `DEBUG` level and accessible to admins via `GET /api/v1/logs?filter[traceId][eq]={requestId}`.

---

## 16. Observability

### 16.1 Structured Logging

All Gateway logs use the structured JSON logger from `@oneplatform/core`. Every log entry includes:

```json
{
  "timestamp": "2026-06-10T14:30:00.000Z",
  "level": "info",
  "service": "gateway",
  "traceId": "01J4WZJHK8GN9...",
  "tenantId": "...",
  "message": "Proxied request to auth-service",
  "metadata": {
    "method": "POST",
    "path": "/api/v1/auth/login",
    "upstreamService": "auth",
    "upstreamLatencyMs": 42,
    "statusCode": 200
  }
}
```

**Log levels:**
- `DEBUG`: rate limit counter values, cache hits/misses, individual SSE events.
- `INFO`: proxied requests (method, path, service, status, latency), webhook deliveries, SSE connections.
- `WARN`: upstream service slow (> 2× expected latency), Redis outage fallback activated, circuit breaker state changes.
- `ERROR`: upstream timeout, circuit breaker open, SSRF block, unhandled exceptions.
- `CRITICAL`: Redis outage with unknown replica count (hard limit applied).

### 16.2 OTEL Metrics

The Gateway exposes Prometheus-compatible metrics at `GET /metrics` (internal network only, not proxied to clients).

| Metric | Type | Labels |
|--------|------|--------|
| `gateway_requests_total` | Counter | `method`, `path_template`, `status_code`, `upstream_service` |
| `gateway_request_duration_ms` | Histogram | `method`, `path_template`, `upstream_service` |
| `gateway_rate_limit_hits_total` | Counter | `policy` (global/tenant/api-key/webhook) |
| `gateway_upstream_errors_total` | Counter | `upstream_service`, `error_type` |
| `gateway_circuit_breaker_state` | Gauge | `upstream_service` (0=closed, 1=half-open, 2=open) |
| `gateway_sse_connections_active` | Gauge | `tenant_id` |
| `gateway_webhook_deliveries_total` | Counter | `status` (success/failed/dlq) |
| `gateway_webhook_delivery_duration_ms` | Histogram | `status` |
| `gateway_redis_fallback_active` | Gauge | (1 = in fallback mode) |
| `gateway_ontology_cache_size` | Gauge | `tenant_id` |

### 16.3 OTEL Tracing

Every inbound request generates an OTEL span. The trace ID is the same as the `X-OnePlatform-Request-ID` header and `requestId` in error responses. Spans are created for:
- The full inbound request (root span).
- Each upstream proxy call (child span: `proxy.{serviceName}`).
- Redis operations (child span: `redis.{command}`).
- Database queries (child span: `db.{table}.{operation}`).
- HMAC computation (child span: `webhook.sign`).
- SSRF DNS resolution (child span: `ssrf.dns-check`).

---

## 17. Testing Strategy

### 17.1 Unit Tests

**Rate limiter unit tests** (`packages/gateway/src/rate-limit/__tests__/`):

| Test | What it verifies |
|------|-----------------|
| Sliding window algorithm | Correct interpolation at window boundary |
| Burst multiplier | 2x limit for 5 seconds, revert after |
| Lua script correctness | Test Lua script with mock Redis (ioredis mock) |
| Fallback mode activation | Redis error triggers in-memory fallback |
| Fallback replica count tiers | Correct limit division at each replica count source |
| Cold start safety | No Redis + no env var → 100 req/min hard limit |
| Rate limit headers | Correct headers on allowed and blocked requests |

**Webhook SSRF prevention unit tests:**

| Test | What it verifies |
|------|-----------------|
| `10.0.0.1` blocked | Private range rejection |
| `172.20.0.1` blocked | Docker range rejection |
| `127.0.0.1` blocked | Loopback rejection |
| `169.254.169.254` blocked | Link-local/metadata rejection |
| `::1` blocked | IPv6 loopback rejection |
| `8.8.8.8` allowed | Public IP passes |
| `localhost` blocked | Hostname rejection before DNS |
| DNS rebinding | Hostname that returns public IP on first call, private on second → blocked on second call |
| Multiple A records | All resolved IPs checked, any private → blocked |

**Webhook HMAC unit tests:**

| Test | What it verifies |
|------|-----------------|
| Correct HMAC computation | Known key + body → expected SHA256 hex |
| Signature header format | `sha256={hex}` format |
| Secret rotation | New secret produces different HMAC |

**SSE ring buffer unit tests:**

| Test | What it verifies |
|------|-----------------|
| Circular overwrite | Event 1001 overwrites event 1 |
| Replay found | `Last-Event-ID` in buffer → correct events returned in order |
| Replay miss | `Last-Event-ID` not in buffer → `replay.overflow` event |
| Pattern matching | `pipeline.*` matches `pipeline.completed`, not `data.created` |
| LRU eviction | Tenant not accessed for 15 min → buffer freed |
| Backpressure | Buffer > 512KB drops debug events; > 1MB closes connection |

### 17.2 Integration Tests

Integration tests use a test Postgres and Redis spun up via Docker Compose in CI (`docker compose -f docker-compose.test.yml up -d`).

**Webhook delivery integration tests:**

| Test | Setup | What it verifies |
|------|-------|-----------------|
| End-to-end delivery | Register webhook → publish event to Redis → verify HTTP POST received | Full delivery pipeline |
| Retry on 500 | Mock endpoint returns 500 for first 3 attempts, then 200 | BullMQ retries correct delays |
| DLQ after 9 failures | Mock endpoint always returns 500 | Job moves to DLQ, `dlq.job.added` emitted |
| Throttle on 5 failures | 5 consecutive failures → `throttled_until` set | Delivery rate limited to 1/hour |
| SSRF prevention at delivery | Register webhook → DNS record changed to `10.0.0.1` → delivery attempt | Delivery blocked, error logged |
| Secret signature verification | Delivery sent → consumer verifies HMAC → passes | HMAC-SHA256 correct end-to-end |
| Delivery log retention | 101 deliveries → only 100 rows in `webhook_deliveries` | Per-webhook cap enforced |

**Rate limiting integration tests:**

| Test | What it verifies |
|------|-----------------|
| Global limit enforced | 10,001 requests in 1 minute → 10,001st returns 429 |
| Per-tenant limit enforced | Tenant A at 1,001 req/min → 429; Tenant B at 500 → still 200 |
| Redis outage → fallback | Disconnect Redis → confirm in-memory limits applied |
| Redis recovery | Reconnect Redis → confirm Redis counters resume |
| Headers present on 429 | `X-RateLimit-*` and `Retry-After` present |

**Proxy integration tests:**

| Test | What it verifies |
|------|-----------------|
| Request forwarded | `POST /api/v1/auth/login` received by mock auth service |
| Identity headers injected | Upstream receives `X-OnePlatform-Tenant-ID` etc. |
| Client spoof headers stripped | Client-provided `X-OnePlatform-Tenant-ID` not forwarded |
| Timeout → 503 | Upstream delays 6s, Gateway timeout 5s → 503 |
| Circuit breaker opens | 5 timeouts in 60s → circuit open → 503 without calling upstream |
| Internal routes blocked | `GET /internal/auth/validate` → 404 |

**SSE integration tests:**

| Test | What it verifies |
|------|-----------------|
| Connection streams live events | Publish event → SSE client receives it within 100ms |
| Pattern filter | Subscribe to `pipeline.*` → `pipeline.completed` received, `data.created` not |
| Last-Event-ID replay | Disconnect → miss 3 events → reconnect with Last-Event-ID → 3 events replayed |
| replay.overflow | Disconnect → miss 1001 events → reconnect → `replay.overflow` received |
| Heartbeat | 30s idle → `: keepalive` comment received |
| Connection limit | 11th SSE connection for same API key → 429 |
| Auth required | No token → 401 |

### 17.3 Load Tests

Load tests use k6 (MIT license) and run against a staging environment.

**Rate limiting load test (`k6/rate-limit.js`):**

```javascript
// Scenario: 2000 virtual users ramping up over 1 minute, sustained for 5 minutes
// Expected: p99 latency < 10ms on rate limit check; exactly 10,000 req/min pass globally
export const options = {
  stages: [
    { duration: '1m', target: 2000 },   // ramp up
    { duration: '5m', target: 2000 },   // sustained
  ],
  thresholds: {
    'http_req_duration{tag:expected_429}': ['p95<10'],  // Rate limit checks fast
    'rate_limit_429_rate': ['rate>=0.80'],               // > 80% of requests are rate limited correctly
  },
};
```

**Webhook delivery throughput load test:**

Target: 10,000 events/second ingested from Redis, all dispatched to BullMQ within 1 second.

**SSE connection load test:**

Target: 1,000 concurrent SSE connections on a single Gateway instance, each receiving 100 events/minute. p99 SSE delivery latency < 200ms.

### 17.4 Contract Tests

`@oneplatform/core` exports `testApiContract(app, spec)`. The Gateway's CI runs this against its own OpenAPI spec to verify every route definition matches its declared request/response schemas.

---

## 18. Deployment

### 18.1 Docker Compose

```yaml
gateway-service:
  image: oneplatform/gateway-service:${TAG:-latest}
  build:
    context: .
    dockerfile: services/gateway/Dockerfile
  ports:
    - "3000:3000"
  environment:
    - NODE_ENV=production
    - PORT=3000
    - DATABASE_URL=postgresql://op_gateway:${GATEWAY_DB_PASS}@pgbouncer:5433/oneplatform
    - REDIS_URL=redis://:${REDIS_PASS}@redis:6379
    - OP_ALLOWED_ORIGINS=${OP_ALLOWED_ORIGINS}
    - OP_GLOBAL_RATE_LIMIT=${OP_GLOBAL_RATE_LIMIT:-10000}
    - OP_GATEWAY_REPLICAS=${OP_GATEWAY_REPLICAS:-1}
    - OP_GATEWAY_PRIVATE_KEY=${OP_GATEWAY_PRIVATE_KEY}
    - OP_JWT_PUBLIC_KEY=${OP_JWT_PUBLIC_KEY}
    - OP_MASTER_KEY_FILE=/data/init/master.key
    - OP_WEBHOOK_ALLOW_HTTP=${OP_WEBHOOK_ALLOW_HTTP:-false}
    - OP_SHUTDOWN_GRACE_MS=${OP_SHUTDOWN_GRACE_MS:-30000}
    - AUTH_SERVICE_URL=http://auth-service:3001
    - INGESTION_SERVICE_URL=http://ingestion-service:3002
    - ONTOLOGY_SERVICE_URL=http://ontology-service:3003
    - PIPELINE_SERVICE_URL=http://pipeline-service:3004
    - EXECUTION_SERVICE_URL=http://execution-service:3005
    - APP_SERVICE_URL=http://app-service:3006
    - LOGGING_SERVICE_URL=http://logging-service:3007
    - PLUGIN_SERVICE_URL=http://plugin-service:3008
  volumes:
    - init-data:/data/init:ro
  networks:
    - oneplatform-public
    - oneplatform-internal
  healthcheck:
    test: ["CMD", "wget", "-qO-", "http://localhost:3000/healthz"]
    interval: 10s
    timeout: 5s
    retries: 3
    start_period: 20s
  depends_on:
    op-init:
      condition: service_completed_successfully
    postgres:
      condition: service_healthy
    redis:
      condition: service_healthy
    auth-service:
      condition: service_healthy
  deploy:
    resources:
      limits:
        memory: 512M
        cpus: '1.0'
      reservations:
        memory: 128M
        cpus: '0.25'
    restart_policy:
      condition: on-failure
      delay: 5s
      max_attempts: 3
```

### 18.2 Database Migrations

The Gateway Service runs its own schema migrations on startup using the standard Postgres migration runner from `@oneplatform/core`. Migrations live in `services/gateway/migrations/`. The migration runner acquires an advisory lock (`pg_advisory_lock(gatewaySchemaLockId)`) to prevent concurrent migrations when multiple Gateway replicas start simultaneously.

Migration files:
- `001_create_gateway_schema.sql` — `CREATE SCHEMA gateway`
- `002_create_webhooks.sql` — `gateway.webhooks` table and indexes
- `003_create_webhook_deliveries.sql` — `gateway.webhook_deliveries` table and indexes
- `004_create_rate_limit_config.sql` — `gateway.rate_limit_config` table

### 18.3 Scaling Considerations

- **Horizontal scaling:** the Gateway is stateless except for the per-tenant SSE ring buffer and the in-memory rate limit fallback. Both are per-instance and explicitly designed to work without cross-instance coordination.
- **Replica count:** update `OP_GATEWAY_REPLICAS` in Docker Compose when scaling. The `gateway:replicas` Redis key tracks live replicas; the env var is the fallback for Redis outage scenarios.
- **Memory:** each tenant's ring buffer holds up to 1000 events. Each `PlatformEvent` is approximately 1 KB. With `ringBuffers` capped at 500 tenants, the maximum ring buffer memory is 500 MB (500 tenants × 1000 events × 1 KB). The container memory limit of 512 MB accounts for this plus baseline process overhead. For deployments with > 500 active tenants, increase the container memory limit and the `LRUCache.max` parameter.

---

## 19. Configuration Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3000` | HTTP listen port |
| `NODE_ENV` | Yes | — | `development` or `production` |
| `DATABASE_URL` | Yes | — | Postgres connection string (via PgBouncer) |
| `REDIS_URL` | Yes | — | Redis connection string |
| `OP_ALLOWED_ORIGINS` | Yes (production) | `http://localhost:3000,http://localhost:4000` (dev) | Comma-separated allowed CORS origins |
| `OP_GLOBAL_RATE_LIMIT` | No | `10000` | Global rate limit (requests per minute) |
| `OP_GATEWAY_REPLICAS` | Yes (multi-replica) | `1` | Number of Gateway replicas (for rate limit fallback calculation) |
| `OP_GATEWAY_PRIVATE_KEY` | Yes | — | Ed25519 private key (PEM) for signing service tokens |
| `OP_JWT_PUBLIC_KEY` | Yes | — | Ed25519 public key (PEM) for verifying client JWTs |
| `OP_MASTER_KEY_FILE` | Yes | `/data/init/master.key` | Path to AES-256-GCM master key file (for webhook secret decryption) |
| `OP_WEBHOOK_ALLOW_HTTP` | No | `false` | Allow HTTP (not HTTPS) webhook URLs. Set `true` in development only. |
| `OP_SHUTDOWN_GRACE_MS` | No | `30000` | Graceful shutdown timeout in milliseconds |
| `AUTH_SERVICE_URL` | No | `http://auth-service:3001` | Auth Service internal URL |
| `INGESTION_SERVICE_URL` | No | `http://ingestion-service:3002` | Ingestion Service internal URL |
| `ONTOLOGY_SERVICE_URL` | No | `http://ontology-service:3003` | Ontology Service internal URL |
| `PIPELINE_SERVICE_URL` | No | `http://pipeline-service:3004` | Pipeline Service internal URL |
| `EXECUTION_SERVICE_URL` | No | `http://execution-service:3005` | Execution Service internal URL |
| `APP_SERVICE_URL` | No | `http://app-service:3006` | App Service internal URL |
| `LOGGING_SERVICE_URL` | No | `http://logging-service:3007` | Logging Service internal URL |
| `PLUGIN_SERVICE_URL` | No | `http://plugin-service:3008` | Plugin Service internal URL |
| `OP_PROXY_TIMEOUT_AUTH_MS` | No | `5000` | Auth Service proxy timeout |
| `OP_PROXY_TIMEOUT_INGESTION_MS` | No | `30000` | Ingestion Service proxy timeout |
| `OP_PROXY_TIMEOUT_EXECUTION_MS` | No | `35000` | Execution Service proxy timeout |
| `OP_PROXY_TIMEOUT_DEFAULT_MS` | No | `10000` | Default proxy timeout for all other services |
| `OP_CIRCUIT_BREAKER_THRESHOLD` | No | `5` | Consecutive failures before circuit opens |
| `OP_CIRCUIT_BREAKER_RESET_MS` | No | `10000` | Circuit half-open probe interval |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No | — | OTEL Collector endpoint (traces + metrics) |
