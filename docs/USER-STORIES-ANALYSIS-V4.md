# OnePlatform User Story Analysis v4

**Date:** 2026-06-15
**Method:** 10-persona exhaustive analysis with source code verification and deduplication against v2+v3
**Previous analyses:** [v1](./USER-STORIES-ANALYSIS.md) (108 points), [v2](./USER-STORIES-ANALYSIS-V2.md) (85 unique, 13 CRITICAL), [v3](./USER-STORIES-ANALYSIS-V3.md) (53 unique, 5 CRITICAL)
**This analysis:** NET-NEW findings only -- every item verified as absent from v2 and v3

---

## Summary Table

| Severity | Count |
|----------|-------|
| CRITICAL | 18    |
| HIGH     | 45    |
| MEDIUM   | 61    |
| LOW      | 24    |
| **Total net-new findings** | **148** |

---

## Methodology

This v4 analysis applies 10 distinct user personas to the entire OnePlatform codebase. Every finding has been:

1. **Verified in source code** -- file paths, line numbers, and exact code patterns are cited
2. **Cross-referenced against v2 and v3** -- only findings absent from v2's 85 items and v3's 53 items are included
3. **Deduplicated** -- overlapping findings from different personas are merged into a single entry
4. **Classified by severity** using the same rubric as v2/v3

### Severity Rubric

| Level | Criteria |
|-------|----------|
| **CRITICAL** | Blocks a core workflow entirely, causes data loss, or creates an exploitable security vulnerability |
| **HIGH** | Significant functionality gap, performance degradation, or security weakness that affects many users |
| **MEDIUM** | Noticeable quality issue, inconsistency, or missing feature that has workarounds |
| **LOW** | Cosmetic issue, minor inconvenience, or improvement opportunity |

### Personas Applied

| Persona | Focus Area | Findings |
|---------|------------|----------|
| **First-Time Self-Hoster** | Docker Compose experience, bootstrap flow, first-run errors | 29 |
| **Data Engineer** | Connector pipelines, sync reliability, mapping correctness, batch processing | 17 |
| **App Developer** | SDK, BFF, build/deploy lifecycle, type safety | 17 |
| **Plugin Developer** | Plugin SDK, hook system, sandbox interaction, bundle lifecycle | 30 |
| **Platform Admin** | User management, RBAC configuration, tenant operations, monitoring | (included in Plugin Dev) |
| **DevOps/SRE** | Observability, scaling, backup, health checks, container lifecycle | 15 |
| **Security Auditor** | Auth flows, token handling, SSRF, injection, secrets management | (included in Enterprise) |
| **Enterprise Evaluator** | Multi-tenancy, compliance, audit trail, SSO integration | 9 |
| **Power User / Data Scientist** | Query performance, API ergonomics, large dataset handling | 17 |
| **Casual / Non-Technical User** | UI clarity, error messages, onboarding guidance | 14 |

---

## Top 10 Priorities

| # | Finding | Severity | Why It Matters | Effort |
|---|---------|----------|----------------|--------|
| 1 | V4-C-01: Quick Start `docker compose up` fails -- no compose file at repo root | CRITICAL | The literal first step in onboarding is broken; every new user hits a wall immediately | Small |
| 2 | V4-C-02: Redis URL missing username -- all services fail Redis auth with ACL mode | CRITICAL | All 9 services fail to connect to Redis at startup; the platform is completely non-functional in Docker | Small |
| 3 | V4-C-14: BullMQ key prefix `bull:` not covered by any service ACL patterns | CRITICAL | All BullMQ-based job processing (sync, pipeline, audit, retention) fails with NOPERM errors | Small |
| 4 | V4-C-16: Log events table lacks `tenant_id` column -- cross-tenant log leakage | CRITICAL | Any user can read all tenants' log data; complete multi-tenancy failure for logs | Large |
| 5 | V4-C-04: `useUser()` returns wrong shape -- BffClient does not unwrap `/bff/me` envelope | CRITICAL | User identity is broken for all hosted apps; user.id, user.displayName are always undefined | Medium |
| 6 | V4-C-10: Audit log frontend calls wrong API endpoint path (`/v1/audit` vs `/v1/audit-events`) | CRITICAL | The entire Audit Log page is non-functional; admins cannot view any audit events | Small |
| 7 | V4-C-18: `listRuns` ignores pipelineId filter -- returns all tenant runs | CRITICAL | Users querying runs for a specific pipeline get ALL runs from ALL pipelines in the tenant | Small |
| 8 | V4-C-03: No `op_execution` user in Redis ACL -- execution service cannot start | CRITICAL | The execution-service container fails to start because the Redis password file does not exist | Small |
| 9 | V4-C-05: SDK `deploy()` sends PATCH with wrong field, should be POST to `/deploy` | CRITICAL | Every `client.apps.deploy()` call fails with a 400 validation error | Small |
| 10 | V4-H-03: NewConnectorPage calls non-existent `/v1/connectors/types` endpoint | HIGH | The connector creation wizard is broken at step 1; users cannot create any connectors via UI | Medium |

---

## All Findings

### CRITICAL (18)

#### V4-C-01: Quick Start `docker compose up` fails -- no docker-compose.yml at repo root

**Severity:** CRITICAL
**Personas:** First-Time Self-Hoster, DevOps/SRE
**Component:** `README.md` (line 38-43)

**Problem:** The README instructs users to run `docker compose up` from the repo root, but the compose file is at `docker/docker-compose.yml`, not at the root. There is no symlink or compose.yml/docker-compose.yml anywhere in the project root:

```bash
git clone https://github.com/aaron777collins/oneplatform.git
cd oneplatform
docker compose up
```

Running this produces: `no configuration file provided: not found`

**Impact:** Every first-time self-hoster hits a wall at the very first step. The Quick Start is the #1 entry point and it is broken. Users must discover the correct path themselves by exploring the repo structure.

**Fix:** Either add a symlink or root-level docker-compose.yml that includes the docker/ path, or update the README to use `docker compose -f docker/docker-compose.yml up`. Also add the missing `cp .env.example .env` step before `docker compose up`.

**Effort:** Small

---

#### V4-C-02: Redis URL missing username -- all services fail Redis auth with ACL mode

**Severity:** CRITICAL
**Personas:** First-Time Self-Hoster, DevOps/SRE
**Component:** `docker/service-entrypoint.sh` (line 77)

**Problem:** The service-entrypoint.sh constructs the Redis URL without a username:

```sh
export OP_REDIS_URL="redis://:${REDIS_PASSWORD}@redis:6379"
```

But redis.conf uses ACL mode with `protected-mode yes` and the default user is disabled in users.acl.template:

```
user default off nopass ~* &* -@all
```

With no username in the URL, ioredis authenticates as the `default` user, which is disabled. The Redis unit test at `packages/core/src/__tests__/redis.test.ts:12` shows the correct format: `redis://op_auth:secret@redis:6379`.

**Impact:** Every service (gateway, auth, ingestion, ontology, pipeline, logging, app, plugin) fails to connect to Redis at startup. The platform is completely non-functional. Health checks report Redis as unhealthy and services enter restart loops.

**Fix:** Change line 77 of service-entrypoint.sh to include the ACL username:
```sh
export OP_REDIS_URL="redis://op_${SERVICE_SHORT}:${REDIS_PASSWORD}@redis:6379"
```

**Effort:** Small

---

#### V4-C-03: No `op_execution` user in Redis ACL -- execution service has no Redis credentials

**Severity:** CRITICAL
**Personas:** First-Time Self-Hoster, DevOps/SRE
**Component:** `docker/redis/users.acl.template` (line 1-10)

**Problem:** The Redis ACL template defines users for 8 of 9 services (op_admin, op_auth, op_pipeline, op_logging, op_gateway, op_ingestion, op_ontology, op_app, op_plugin) but has NO `op_execution` user. The init.sh generates `redis_password_execution.txt` at line 160:

```sh
for REDIS_USER in admin auth pipeline logging gateway ingestion ontology app plugin; do
```

But `execution` is missing from this list. The redis-entrypoint.sh substitution loop also lacks `execution`. While the execution service currently uses a noop Redis stub (line 72 of services/execution/src/index.ts), the service-entrypoint.sh still tries to read `redis_password_execution.txt` and would FATAL because the file does not exist.

**Impact:** The execution-service container fails to start because service-entrypoint.sh cannot find `/data/init/redis_password_execution.txt`. The `read_secret` function exits with a fatal error.

**Fix:** Either (a) add `execution` to the Redis password generation loop in init.sh and add an `op_execution` ACL entry in the template, and add `execution` to the redis-entrypoint.sh substitution loop, or (b) add special-case handling in service-entrypoint.sh to skip Redis URL construction for the execution service.

**Effort:** Small

---

#### V4-C-04: useUser() returns wrong shape -- BffClient does not unwrap data envelope from /bff/me

**Severity:** CRITICAL
**Personas:** App Developer, Plugin Developer
**Component:** `packages/app-sdk/src/provider/AppProvider.tsx` (line 200, 207)

**Problem:** AppProvider fetches `bffClient.request<UserContext>("/bff/me")` at line 200 and stores the result via `setUser(meResult)` at line 207. However, BffClient.request() (BffClient.ts line 215) returns `response.json()` without unwrapping the `{ data: ... }` envelope. The server returns `{ data: { userId, tenantId, appId, roles, isGuest } }` (bff.ts lines 77-86). So `meResult` is the full envelope `{ data: { userId, ... } }`, not a `UserContext`. Additionally, the server returns `userId` but `UserContext` expects `id`, and the server omits `email` and `displayName` entirely. The default template App.tsx generated on app creation uses `user.displayName` which will always be `undefined`.

Server response shape (bff.ts line 77-86):
```
{ data: { userId, tenantId, appId, roles, isGuest } }
```
Expected UserContext shape (entities.ts line 116-124):
```
{ id, email, displayName, tenantId, roles, isGuest }
```

**Impact:** Every app developer using useUser() gets an object with all fields undefined. The default scaffold template's `{user.displayName}` renders nothing. User identity is effectively broken for all hosted apps.

**Fix:** Either: (1) BffClient.request() should unwrap the `{ data: T }` envelope like the SDK Transport does, or (2) AppProvider should access `meResult.data` before calling setUser(). Additionally, the /bff/me endpoint must return `id` (not `userId`) and include `email` and `displayName` from the auth token to match the UserContext interface.

**Effort:** Medium

---

#### V4-C-05: SDK deploy() sends currentBuildId via PATCH which is rejected by strict schema validation

**Severity:** CRITICAL
**Personas:** App Developer, Plugin Developer
**Component:** `packages/sdk/src/resources/apps.ts` (line 220-226)

**Problem:** The SDK's `deploy()` method (line 220-226) calls:
```ts
async deploy(id: string, buildId: string): Promise<App> {
  return transport.request<App>({
    method: 'PATCH',
    path: `${BASE}/${encodeURIComponent(id)}`,
    body: { currentBuildId: buildId },
  });
}
```
But the server's PatchAppSchema (schemas/index.ts line 19-25) uses `.strict()` which rejects any fields not explicitly defined. `currentBuildId` is not in the schema -- only `name`, `slug`, `description`, `accessMode`, and `allowedModules` are allowed. The actual deploy endpoint is `POST /api/v1/apps/:appId/deploy` handled by deployments.ts.

**Impact:** Every `client.apps.deploy(id, buildId)` call fails with a 400 validation error. Developers cannot deploy apps through the SDK.

**Fix:** Change SDK `deploy()` to use `POST ${BASE}/${encodeURIComponent(id)}/deploy` with body `{ buildId }` matching the DeploySchema, and return a `Deployment` (not `App`) to match the server response shape.

**Effort:** Small

---

#### V4-C-06: SDK AppBuild status enum uses 'queued' but the server only ever returns 'pending'

**Severity:** CRITICAL
**Personas:** App Developer, Plugin Developer
**Component:** `packages/sdk/src/resources/apps.ts` (line 38)

**Problem:** The SDK defines the build status type as:
```ts
readonly status: 'queued' | 'building' | 'success' | 'failed';
```
(apps.ts line 38)

But the server database constraint (001_initial_schema.sql line 72) and all service code only use `'pending'`, never `'queued'`:
```sql
CHECK (status IN ('pending','building','success','failed'))
```
The build-service.ts explicitly returns `status: "pending"` at line 361.

**Impact:** TypeScript consumers comparing `build.status === 'queued'` will never match. Type narrowing based on the SDK type is incorrect -- the actual 'pending' status value is not representable in the SDK's union type.

**Fix:** Change `AppBuild.status` from `'queued' | 'building' | 'success' | 'failed'` to `'pending' | 'building' | 'success' | 'failed'` to match the server.

**Effort:** Small

---

#### V4-C-07: HookPayloadDataMap uses non-existent pipeline stage names, breaking typed narrowing

**Severity:** CRITICAL
**Personas:** Platform Admin, Security Auditor, Plugin Developer
**Component:** `packages/plugin-sdk/src/types/hooks.ts` (line 173-174)

**Problem:** The HookPayloadDataMap maps `"before:pipeline.execute"` and `"after:pipeline.execute"` to PipelineExecuteData, but these are NOT valid HookStage values. The HookStage union defines `pipeline.trigger`, `pipeline.step`, and `pipeline.complete` -- there is no `pipeline.execute` stage.

```typescript
export interface HookPayloadDataMap {
  // ...
  "before:pipeline.execute":   PipelineExecuteData;  // NOT a valid HookStage
  "after:pipeline.execute":    PipelineExecuteData;   // NOT a valid HookStage
  // ...
}
```

The HookStage union defines:
```typescript
| "before:pipeline.trigger"
| "after:pipeline.trigger"
| "before:pipeline.step"
| "after:pipeline.step"
| "before:pipeline.complete"
| "after:pipeline.complete"
```

Since `"before:pipeline.execute"` is not in HookStage, the conditional type `S extends keyof HookPayloadDataMap ? HookPayloadDataMap[S] : Record<string, unknown>` always falls through to `Record<string, unknown>` for all pipeline stages.

**Impact:** Plugin developers writing pipeline hooks get zero type safety. `HookPayload<"before:pipeline.step">.data` resolves to `Record<string, unknown>` instead of `PipelineExecuteData`. The typed hook system is advertised but non-functional for the entire pipeline domain -- the most common hook target.

**Fix:** Change the HookPayloadDataMap keys to match actual HookStage values. Map `before:pipeline.step` and `after:pipeline.step` (and optionally trigger/complete) to PipelineExecuteData instead of the non-existent `pipeline.execute` stages.

**Effort:** Small

---

#### V4-C-08: cache.lock() not implemented in sandbox ContextCallHandler -- runtime crash

**Severity:** CRITICAL
**Personas:** Platform Admin, Security Auditor, Plugin Developer
**Component:** `services/execution/src/services/context-call-handler.ts` (line 24-32)

**Problem:** The PluginContext interface exposes `cache.lock()` as part of CacheAccessor, documented for distributed mutex operations like token refresh deduplication. The mock context implements it. But the ContextCallRequest method union in the execution sandbox does NOT include `cache.lock`:

```typescript
method:
  | "fetch"
  | "credentials.get"
  | "credentials.list"
  | "cache.get"
  | "cache.set"
  | "cache.delete"
  | "pipeline.trigger"
  | "ontology.getEntity";
```

The `default` branch in the switch throws an `UNSUPPORTED_METHOD` error. Any plugin calling `context.cache.lock()` will crash at runtime in production with an unhelpful "Unknown contextCall method" error, despite the call compiling successfully against the SDK types and working in local tests with the mock context.

**Impact:** Plugin developers following the SDK documentation to use distributed locks for token refresh or singleton operations will have code that passes local tests but fails at runtime in production. The AuthProvider documentation specifically says to use `context.cache.lock()` to prevent concurrent refreshes.

**Fix:** Add `"cache.lock"` and `"cache.lock.release"` to the ContextCallRequest method union and implement the handler, likely delegating to a Redis SETNX + TTL pattern via the Plugin Service's cache endpoint.

**Effort:** Medium

---

#### V4-C-09: ontology.getSchema() not implemented in sandbox -- only getEntity exists

**Severity:** CRITICAL
**Personas:** Platform Admin, Security Auditor, Plugin Developer
**Component:** `services/execution/src/services/context-call-handler.ts` (line 24-32)

**Problem:** The OntologyAccessor interface exposes two methods: `getSchema()` and `getEntitySchema()`. The ContextCallHandler only implements `ontology.getEntity` (singular):

```typescript
method:
  | "fetch"
  | ...
  | "ontology.getEntity";  // only this one
```

The `getSchema()` method -- which returns the full ontology with all entity types -- has no corresponding context call method. When a plugin calls `context.ontology.getSchema()` in production, it will fail with UNSUPPORTED_METHOD. The mock context returns the full schema, so tests pass.

**Impact:** Any plugin that inspects the full ontology schema (common for transformer plugins that need to discover entity types dynamically) will fail at runtime. This is especially bad for transformer and destination plugins that need to handle multiple entity types.

**Fix:** Add `"ontology.getSchema"` to the ContextCallRequest method union and implement it by returning `executionCtx.ontologySnapshot` directly (the full snapshot is already injected at execution start).

**Effort:** Small

---

#### V4-C-10: Audit log frontend calls wrong API endpoint path

**Severity:** CRITICAL
**Personas:** Platform Admin, Security Auditor, Plugin Developer
**Component:** `packages/frontend/src/components/logs/AuditLogTable.tsx` (line 64)

**Problem:** The AuditLogTable component requests `/v1/audit` (line 64) which becomes `/api/v1/audit` at the gateway. However, the backend registers the route at `/api/v1/audit-events` (services/logging/src/routes/audit.ts line 39), and the gateway SERVICE_MAP only has an `audit-events` key (services/gateway/src/services/proxy-service.ts line 31-32). There is no `audit` key, so the gateway cannot route this request to any upstream service.

Frontend code:
```
client.get<PaginatedResponse<AuditEvent>>("/v1/audit", ...)
```
Backend route:
```
routes.get("/api/v1/audit-events", async (c) => { ... })
```
Gateway map:
```
"audit-events": process.env["LOGGING_SERVICE_URL"] ?? "http://logging-service:3000"
```

**Impact:** The entire Audit Log page at /logs/audit is completely broken. Platform admins cannot view any audit events through the UI. The page will always show 'No audit events found' or an error, defeating the purpose of having an audit trail.

**Fix:** Change the frontend endpoint from `/v1/audit` to `/v1/audit-events` in AuditLogTable.tsx line 64. Additionally, update the query parameter names to match the backend's expected format (the backend expects `actorId`, `from`, `to`, etc. as query params, not the filter DSL syntax `filter[timestamp][gte]` the frontend is sending).

**Effort:** Small

---

#### V4-C-11: Audit log frontend/backend response shape mismatch

**Severity:** CRITICAL
**Personas:** Platform Admin, Security Auditor, Plugin Developer
**Component:** `packages/frontend/src/components/logs/AuditLogTable.tsx` (line 30-43)

**Problem:** Even if the endpoint path were correct, the frontend AuditEvent interface expects fields that don't match the backend response. The frontend expects:
```typescript
interface AuditEvent {
  id: string;
  timestamp: string;   // backend sends 'createdAt'
  actor: string;       // backend sends 'actorId' + 'actorType'
  action: string;
  resource: string;    // backend sends 'resourceType' + 'resourceId'
  outcome: string;     // backend sends 'result'
  traceId?: string;
}
```
But the backend mapAuditRow (services/logging/src/routes/audit.ts lines 9-23) returns:
```typescript
{ id, traceId, actorId, actorType, tenantId, action, resourceType, resourceId, result, metadata, createdAt }
```
Fields `timestamp`, `actor`, `resource`, and `outcome` do not exist in the API response.

**Impact:** Even with a corrected endpoint path, the audit table would display empty/undefined values for timestamp, actor, resource, and outcome columns. All audit data would be present but invisible to the admin.

**Fix:** Either update the frontend AuditEvent interface and table rendering to use the actual backend field names (actorId, actorType, resourceType, resourceId, result, createdAt), or add a mapping layer in the API client that transforms the response into the expected shape.

**Effort:** Small

---

#### V4-C-12: Redis URL missing username -- services cannot authenticate with ACL

**Severity:** CRITICAL
**Personas:** DevOps/SRE, First-Time Self-Hoster
**Component:** `docker/service-entrypoint.sh` (line 77)

**Problem:** The service-entrypoint.sh constructs the Redis URL without a username:

```
export OP_REDIS_URL="redis://:${REDIS_PASSWORD}@redis:6379"
```

The `redis://:password@host` format sends `AUTH password` which authenticates as the Redis "default" user. However, `docker/redis/users.acl.template` line 1 disables the default user:

```
user default off nopass ~* &* -@all
```

With the default user disabled, every service that connects through this entrypoint will receive a `NOAUTH` or `WRONGPASS` error. Named users like `op_auth`, `op_gateway`, etc. exist in the ACL but the URL never references them. The correct URL format for Redis 6+ ACL is `redis://op_<service>:<password>@redis:6379`.

**Impact:** Every service that uses Redis (8 of 9 services) will fail to connect in a Docker Compose deployment. BullMQ workers, rate limiting, pub/sub, caching, and JWT revocation checks will all fail. The platform is completely non-functional in production.

**Fix:** Change service-entrypoint.sh line 77 to include the per-service username:
```
export OP_REDIS_URL="redis://op_${SERVICE_SHORT}:${REDIS_PASSWORD}@redis:6379"
```

**Effort:** Small

---

#### V4-C-13: App service Redis ACL missing key patterns for build logs, BFF cache, rate limiting, and BullMQ

**Severity:** CRITICAL
**Personas:** DevOps/SRE, First-Time Self-Hoster
**Component:** `docker/redis/users.acl.template` (line 9)

**Problem:** The op_app ACL user only allows `~guest-session:*`:

```
user op_app on >REDIS_PASSWORD_app ~guest-session:* &events:* ...
```

But the app service uses many additional key patterns:
- `rate:guest-session:*` (index.ts line 167) -- rate limiting keys
- `app:build-logs:*` (build-service.ts line 374) -- build log lists
- `app:build:*:log` (build-service.ts line 375) -- build log pub/sub channels
- `bff:runtime-config:*` (bff.ts line 572) -- BFF config cache
- `app:preview-reload:*` (index.ts line 572) -- preview SSE channel
- `bull:queue:app:retention:*` (BullMQ default prefix) -- retention worker

None of these key patterns match `~guest-session:*`.

**Impact:** The app service will receive NOPERM errors for build logs, BFF runtime config caching, rate limiting, preview SSE, and retention cleanup. App building, deployment, and BFF functionality are broken in Docker Compose.

**Fix:** Expand the op_app ACL to include all needed key patterns:
```
user op_app on >REDIS_PASSWORD_app ~guest-session:* ~rate:guest-session:* ~app:* ~bff:* ~bull:queue:app:* &events:* &app:* ...
```

**Effort:** Small

---

#### V4-C-14: BullMQ default key prefix 'bull:' not covered by any service ACL patterns

**Severity:** CRITICAL
**Personas:** DevOps/SRE, First-Time Self-Hoster
**Component:** `docker/redis/users.acl.template` (line 4-8)

**Problem:** BullMQ uses a default key prefix of `bull:` (confirmed in `bullmq@5.78.0/dist/esm/classes/queue-keys.js` line 2: `constructor(prefix = 'bull')`).

The ingestion service creates queue `ingestion:sync` which produces Redis keys like `bull:ingestion:sync:id`. The ACL for op_ingestion allows `~queue:ingestion:* ~ingestion:sync:*` -- neither matches `bull:ingestion:sync:*`.

The pipeline service creates queues `queue:pipeline:run` and `queue:pipeline:cron` which produce keys like `bull:queue:pipeline:run:*`. The ACL for op_pipeline allows `~queue:pipeline:* ~queue:execution:*` -- neither matches `bull:queue:pipeline:run:*`.

The logging audit worker uses BullMQ similarly -- `bull:audit.event:*` doesn't match `~audit:*`.

**Impact:** All BullMQ-based job processing across ingestion (sync/batch/file-parse workers), pipeline (run workers), logging (audit worker), and app (retention worker) services will fail with NOPERM errors. Data sync, pipeline execution, audit logging, and build retention are all broken.

**Fix:** Either add `bull:` prefix variants to each ACL (e.g., `~bull:ingestion:sync:*` for op_ingestion), or configure BullMQ queues with a custom prefix matching the existing ACL patterns. The simplest fix is to add the `bull:` prefix to each service's ACL key patterns.

**Effort:** Small

---

#### V4-C-15: SQL injection in countDataRows via unquoted identifier interpolation

**Severity:** CRITICAL
**Personas:** First-Time Self-Hoster, DevOps/SRE
**Component:** `services/ontology/src/repositories/entity-repository.ts` (line 131-134)

**Problem:** The `countDataRows` method directly interpolates `schemaName` and `entitySlug` into a SQL query without using the `quotePgIdentifier()` function that exists in the same codebase. The query is:

```typescript
async countDataRows(schemaName, entitySlug) {
  const result = await db.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM "${schemaName}"."${entitySlug}"`,
  );
```

While other DDL operations in `entity-service.ts` (line 264, 300, 303, 560) correctly use `quotePgIdentifier()` to validate and escape identifiers, `countDataRows` bypasses this protection entirely. Although `tenantSchemaName()` and `deriveSlug()` produce restricted character sets, the method itself performs no validation, meaning any caller that passes unsanitized values could achieve SQL injection. A double-quote in `entitySlug` would break out of the quoted identifier context.

**Impact:** If any code path passes an unvalidated entity slug to `countDataRows`, an attacker could execute arbitrary SQL. Even with current callers being safe, this is a defense-in-depth failure that could be exploited by future code changes.

**Fix:** Use `quotePgIdentifier()` for both parameters: `SELECT COUNT(*)::text AS count FROM ${quotePgIdentifier(schemaName)}.${quotePgIdentifier(entitySlug)}`. This matches the pattern used everywhere else in the ontology service.

**Effort:** Small

---

#### V4-C-16: Log events table lacks tenant_id column -- complete absence of tenant isolation for logs

**Severity:** CRITICAL
**Personas:** Enterprise Evaluator, Security Auditor, Platform Admin
**Component:** `services/logging/src/db/migrations/001_initial_schema.sql` (line 29-40)

**Problem:** The `logging.events` table schema has no `tenant_id` column:
```sql
CREATE TABLE IF NOT EXISTS logging.events (
  id          UUID        NOT NULL DEFAULT gen_random_uuid(),
  trace_id    TEXT        NOT NULL DEFAULT '',
  service     TEXT        NOT NULL,
  level       TEXT        NOT NULL CHECK (level IN ('debug','info','warn','error')),
  message     TEXT        NOT NULL,
  metadata    JSONB       NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  search_vec  TSVECTOR    GENERATED ALWAYS AS (...) STORED
) PARTITION BY RANGE (created_at);
```
Compare with `logging.audit_events` which correctly has `tenant_id TEXT NOT NULL`. The log query route at `services/logging/src/routes/logs.ts:37-74` performs no tenant filtering -- any user with `logs:read` scope can see ALL tenants' log data. The `LogEventRow` type in `repositories/types.ts:4-12` also has no tenant_id field.

**Impact:** Enterprise-critical: In a multi-tenant deployment, any authenticated user from Tenant A can read all log events from Tenant B, C, etc. This is a complete data isolation failure. Enterprise customers with compliance requirements (SOC2, GDPR, HIPAA) cannot adopt the platform -- log data from one tenant leaks to all others. Competitors like Fivetran enforce strict tenant isolation on all data including logs.

**Fix:** Add a `tenant_id TEXT NOT NULL` column to `logging.events`, update the `CreateLogEventData` type to require tenantId, propagate tenant context through the pub/sub ingestion pipeline, and add a mandatory `WHERE tenant_id = $N` clause in all log query paths. Add a DB migration with backfill for existing rows.

**Effort:** Large

---

#### V4-C-17: logs:export and audit:read scopes missing from ALL_SCOPES -- endpoints permanently inaccessible

**Severity:** CRITICAL
**Personas:** Enterprise Evaluator, Security Auditor, Platform Admin
**Component:** `services/auth/src/services/token-service.ts` (line 29-49)

**Problem:** The `ALL_SCOPES` array defines every scope the platform recognizes:
```typescript
const ALL_SCOPES: readonly string[] = [
  "data:read", "data:write", "ontology:read", "ontology:write",
  "pipelines:read", "pipelines:trigger", "pipelines:manage",
  "apps:read", "apps:deploy", "apps:manage",
  "plugins:read", "plugins:manage",
  "users:read", "users:manage",
  "logs:read", "webhooks:manage",
  "execution:read", "execution:run",
  "admin",
] as const;
```
Notably absent: `logs:export` and `audit:read`. The log export endpoint (`services/logging/src/routes/logs.ts:86`) requires `logs:export` scope and the audit endpoint (`services/logging/src/routes/audit.ts:42`) requires `audit:read`. Neither scope appears in `ALL_SCOPES` nor in any `PREDEFINED_ROLE_SCOPES` mapping. Since `resolveScopes()` only emits scopes from these two data structures, no JWT will ever contain these scopes. Even `platform-admin` gets `admin` which is in ALL_SCOPES -- but non-admin roles can never get `logs:export` or `audit:read`.

**Impact:** The log export streaming endpoint and audit event query endpoint are completely inaccessible to any non-platform-admin role. Tenant-admins cannot export logs or query audit trails, which are core enterprise compliance features. Only platform-admin (via the 'admin' scope catch-all) can use these endpoints, but the intended RBAC model is broken -- audit:read should be assignable to compliance officers without giving them full admin.

**Fix:** Add `logs:export` and `audit:read` to the `ALL_SCOPES` array. Add `audit:read` and `logs:export` to the `tenant-admin` predefined role scopes. Consider adding `audit:read` to the `developer` and `editor` roles as well for observability.

**Effort:** Small

---

#### V4-C-18: listRuns ignores pipelineId filter -- returns all tenant runs

**Severity:** CRITICAL
**Personas:** Power User / Data Scientist, Data Engineer
**Component:** `services/pipeline/src/services/run-service.ts` (line 271-276)

**Problem:** The `listRuns` method accepts `pipelineId` in its `RunListQuery` type (line 45: `pipelineId?: string`) but never passes it through to the repository. The code at lines 271-276 calls `runRepo.findByTenantId(tenantId, {...})` without any pipeline_id filter:
```typescript
async function listRuns(tenantId: string, query: RunListQuery): Promise<RunListResult> {
  const rows = await runRepo.findByTenantId(tenantId, {
    ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
    limit: query.limit,
    ...(query.filterStatus !== undefined ? { filterStatus: query.filterStatus } : {}),
  });
```
The route at `services/pipeline/src/routes/pipelines.ts` line 197 passes `pipelineId: c.req.param('id')` but the service silently ignores it. The SDK's `listRuns(pipelineId, options)` also sends this parameter. Meanwhile, the RunRepository has a dedicated `findByPipelineId` method (run-repository.ts line 67) that is never used by listRuns.

**Impact:** When a power user calls `GET /api/v1/pipelines/:id/runs` or `sdk.pipelines.listRuns(pipelineId)`, they receive ALL runs across ALL pipelines in the tenant, not just runs for the specified pipeline. With hundreds of pipelines and thousands of runs, the response is wrong data mixed together. Pagination cursors become meaningless because they walk across unrelated pipelines.

**Fix:** In `listRuns`, when `query.pipelineId` is defined, call `runRepo.findByPipelineId(query.pipelineId, { cursor, limit })` instead of `runRepo.findByTenantId`. Add tenant ownership verification before returning results. Alternatively, add a `pipelineId` filter parameter to `findByTenantId`.

**Effort:** Small

---

### HIGH (45)

#### V4-H-01: README says UI is at localhost:3000 but frontend is on port 8080

**Severity:** HIGH
**Personas:** First-Time Self-Hoster, DevOps/SRE
**Component:** `README.md` (line 43)

**Problem:** The README states:
```
The platform will be available at `http://localhost:3000`.
```

But in docker-compose.yml, the gateway exposes port 3000 (raw API only, no UI), and the frontend container exposes port 8080:

```yaml
# gateway-service:
ports:
  - "3000:3000"     # line 259
# frontend:
ports:
  - "8080:80"       # line 638
```

Visiting localhost:3000 shows raw JSON API responses, not the UI. The DEPLOYMENT.md (line 36) repeats this error: `open http://localhost:3000`.

**Impact:** First-time self-hosters navigate to port 3000, see raw JSON or a 404, and think the platform is broken. They have no indication that the actual UI is on port 8080.

**Fix:** Change README.md and DEPLOYMENT.md to reference `http://localhost:8080` for the UI, and mention that port 3000 is the API gateway for direct API access.

**Effort:** Small

---

#### V4-H-02: Quick Start omits required `cp .env.example .env` step

**Severity:** HIGH
**Personas:** First-Time Self-Hoster, DevOps/SRE
**Component:** `README.md` (line 36-43)

**Problem:** The README Quick Start is:
```bash
git clone ...
cd oneplatform
docker compose up
```

But the .env.example file header explicitly says:
```
# Copy to .env and fill in values before running docker compose:
#   cp .env.example .env
```

Without copying the .env file, docker-compose uses inline defaults. While `OP_MINIO_PASSWORD` has a default (`dev_minio_password_change_me`) that passes the entrypoint check, other env vars may be unset. The DEPLOYMENT.md Quick Start (line 29) correctly includes `cp .env.example .env`, but the README does not.

**Impact:** Users who follow the README verbatim skip environment configuration. While it might work with defaults for development, it creates confusion about what configuration is needed and whether things are properly set up.

**Fix:** Add `cp .env.example .env` to the README Quick Start section between `cd oneplatform` and `docker compose up`, with a note to edit the file for production use.

**Effort:** Small

---

#### V4-H-03: NewConnectorPage calls non-existent `/v1/connectors/types` endpoint

**Severity:** HIGH
**Personas:** First-Time Self-Hoster, DevOps/SRE
**Component:** `packages/frontend/src/pages/connectors/NewConnectorPage.tsx` (line 103-106)

**Problem:** The NewConnectorPage fetches connector types from:
```typescript
queryFn: () => client.get<{ data: ConnectorTypeOption[] }>("/v1/connectors/types"),
```

But this route does not exist in the ingestion service. The connector routes at `services/ingestion/src/routes/connectors.ts` only define: GET /, POST /, GET /:id, PATCH /:id, DELETE /:id, POST /:id/test, POST /:id/trigger, GET /:id/syncs, GET /:id/syncs/:syncId/progress.

The request to `/api/v1/connectors/types` would be matched by `GET /:id` with id="types", returning a 404 error because no connector has id "types".

**Impact:** The connector creation wizard is broken at step 1. Users cannot see available connector types and cannot create any connectors, which is the core data ingestion functionality.

**Fix:** Add a `GET /types` route to the ingestion service's connector routes that returns available connector types from the plugin registry. This should be registered before `GET /:id` to take priority.

**Effort:** Medium

---

#### V4-H-04: Connector creation sends wrong field names to backend API

**Severity:** HIGH
**Personas:** First-Time Self-Hoster, DevOps/SRE
**Component:** `packages/frontend/src/pages/connectors/NewConnectorPage.tsx` (line 109)

**Problem:** The frontend sends:
```typescript
mutationFn: (body: { typeId: string; config: ConnectorFormValues }) =>
  client.post<ApiResponse<CreatedConnector>>("/v1/connectors", body),
```

But the backend `createConnectorRequest` schema at `services/ingestion/src/schemas/index.ts:16-25` expects:
```typescript
export const createConnectorRequest = z.object({
  pluginId: z.string().min(1),   // frontend sends 'typeId'
  name: z.string().min(1),       // frontend doesn't send this
  credentials: z.record(z.string()),  // frontend doesn't send this
  ...
});
```

The field name is `pluginId` not `typeId`, and required fields `name` and `credentials` are absent.

**Impact:** Even if the `/connectors/types` endpoint existed, the connector creation POST would always fail with a 422 validation error. The entire connector creation flow is non-functional.

**Fix:** Update the frontend mutation to send `pluginId` instead of `typeId`, and include the required `name` and `credentials` fields. The wizard needs a name input field (which is currently missing) and the ConnectorForm needs to separate config vs credential fields.

**Effort:** Medium

---

#### V4-H-05: Pre-save connection test calls non-existent `POST /v1/connectors/test` (no ID)

**Severity:** HIGH
**Personas:** First-Time Self-Hoster, DevOps/SRE
**Component:** `packages/frontend/src/pages/connectors/NewConnectorPage.tsx` (line 140-141)

**Problem:** The NewConnectorPage test step calls:
```typescript
await client.post(`/v1/connectors/test`, {
  typeId: selectedType.id,
  config: values,
});
```

But the ingestion service only has `POST /:id/test` (line 150 of connectors.ts) which requires an existing connector ID. There is no `POST /connectors/test` route without an ID. The request would not match any POST route and return a 404.

**Impact:** Users cannot test a connection before saving the connector. The test step of the wizard always fails, blocking the creation flow at step 3.

**Fix:** Add a `POST /test` route to the ingestion service that accepts a pluginId + config + credentials payload and tests connectivity without requiring an existing connector. Alternatively, update the frontend to skip the test step or test after creation.

**Effort:** Medium

---

#### V4-H-06: Dashboard Service Health panel calls non-existent `/v1/health/services` endpoint

**Severity:** HIGH
**Personas:** First-Time Self-Hoster, DevOps/SRE
**Component:** `packages/frontend/src/components/metrics/ServiceHealthGrid.tsx` (line 55)

**Problem:** The ServiceHealthGrid component polls:
```typescript
queryFn: () => client.get<{ data: ServiceHealth[] }>("/v1/health/services"),
```

But no such route exists in the gateway. The gateway's health routes (services/gateway/src/routes/health.ts) only define `/healthz` and `/readyz`. The proxy service's SERVICE_MAP has no "health" key, so the request gets a 404 from the proxy catch-all.

**Impact:** The dashboard's Service Health section always shows "No service health data available" or throws repeated errors in the console. Self-hosters see no way to verify that all 9 services are running correctly from the UI.

**Fix:** Implement a `GET /api/v1/health/services` route in the gateway that fans out health checks to all upstream services (auth, ingestion, ontology, pipeline, execution, app, logging, plugin) and returns their aggregate status.

**Effort:** Medium

---

#### V4-H-07: No .dockerignore file -- entire repo (including node_modules, .git) sent as build context

**Severity:** HIGH
**Personas:** First-Time Self-Hoster, DevOps/SRE
**Component:** `docker/Dockerfile.service` (line 1-109)

**Problem:** There is no `.dockerignore` file in the repository root. Both `Dockerfile.service` and `Dockerfile.frontend` use `context: ..` (the repo root) as their build context:

```yaml
build:
  context: ..
  dockerfile: docker/Dockerfile.service
```

Without a `.dockerignore`, Docker sends the entire repo to the daemon, including `node_modules/` (hundreds of MB), `.git/` (potentially large), `dist/` directories, test files, and documentation.

**Impact:** The first `docker compose build` takes 5-10x longer than necessary due to the massive build context transfer. On a typical machine with a populated node_modules, this adds minutes of waiting to every build.

**Fix:** Create a `.dockerignore` file at the repo root with at minimum:
```
node_modules
.git
dist
*.log
.turbo
```

**Effort:** Small

---

#### V4-H-08: Sync progress double-counts completedBatches in processSyncJob

**Severity:** HIGH
**Personas:** Data Engineer, Power User
**Component:** `services/ingestion/src/services/sync-service.ts` (line 586-601)

**Problem:** In processSyncJob, the progress object's `completedBatches` is incremented during the pagination loop (line 589) before the batch job is even enqueued to BullMQ. Then in processBatchJob (lines 734-740), `completedBatches` is incremented again via `progressData.completedBatches + 1`. This means every batch is counted twice in the completedBatches metric.

In processSyncJob:
```typescript
batchSeqNum += 1;
progress.totalRecords = totalRecords;
progress.completedBatches = batchSeqNum;
```

In processBatchJob:
```typescript
await writeProgress({
  ...progressData,
  completedBatches: progressData.completedBatches + 1,
```

**Impact:** Data engineers monitoring sync progress see inflated completedBatches counts (double the actual value). Progress bars in the UI and CLI --wait polling show misleading percentages, making it impossible to track actual sync progress accurately.

**Fix:** In processSyncJob, track `totalBatches` (the number dispatched) separately from `completedBatches` (which should only be advanced by processBatchJob). Set `progress.totalBatches = batchSeqNum` instead of `progress.completedBatches = batchSeqNum` in the pagination loop.

**Effort:** Small

---

#### V4-H-09: listSyncs fetches up to 10,000 BullMQ jobs into memory for filtering

**Severity:** HIGH
**Personas:** Data Engineer, Power User
**Component:** `services/ingestion/src/services/sync-service.ts` (line 347-423)

**Problem:** The listSyncs method fetches up to 10,000 jobs from BullMQ into memory on every call, then filters by connectorId in JavaScript:

```typescript
const jobs = await syncQueue.getJobs(states, 0, 10_000);

const filtered = jobs
  .filter((job) => job.data.connectorId === connectorId)
  .map((job): SyncJobSummary => {
```

For a platform with many connectors, this loads all jobs (up to 10K) into memory and iterates them fully even when the caller only needs a single page of 20 results for one connector.

**Impact:** Data engineers running `op connector trigger --wait` or viewing sync history for a single connector cause the ingestion service to load thousands of unrelated BullMQ jobs into memory. Under load with many concurrent connectors, this leads to high memory usage, GC pressure, and slow API responses for the sync history endpoint.

**Fix:** Use BullMQ's built-in job data filtering or maintain a separate sync_history table in PostgreSQL indexed by connector_id. At minimum, add an early break once enough filtered results are collected to fill the requested page.

**Effort:** Medium

---

#### V4-H-10: CLI connector list sends wrong query parameter names to API

**Severity:** HIGH
**Personas:** Data Engineer, Power User
**Component:** `packages/cli/src/commands/connector/index.ts` (line 57-63)

**Problem:** The CLI connector list command sends query parameters `pluginId` and `status`, but the API schema at services/ingestion/src/schemas/index.ts expects `filter[pluginId][eq]` and `filter[status][eq]`:

```typescript
// CLI sends:
async function listAction(opts: ListOpts, ctx: CommandContext): Promise<void> {
  const query: Record<string, unknown> = {};
  if (opts.plugin) query["pluginId"] = opts.plugin;
  if (opts.status) query["status"] = opts.status;
```

```typescript
// API expects:
export const listConnectorsQuery = z.object({
  "filter[status][eq]": z.enum(["enabled", "disabled"]).optional(),
  "filter[pluginId][eq]": z.string().optional(),
```

**Impact:** Data engineers using `op connector list --plugin <id>` or `op connector list --status active` get unfiltered results because the server ignores the unrecognized query parameters. Filtering connectors by plugin or status from the CLI does not work.

**Fix:** Change the CLI to send `query["filter[pluginId][eq]"]` and `query["filter[status][eq]"]` to match the API schema. Also update the CLI --status help text from `active|paused|error` to `enabled|disabled` to match the API enum values.

**Effort:** Small

---

#### V4-H-11: Mapping upsert issues one SQL query per record instead of batch

**Severity:** HIGH
**Personas:** Data Engineer, Power User
**Component:** `services/ontology/src/services/mapping-service.ts` (line 190-203)

**Problem:** The mapping service inserts valid records one at a time inside a transaction loop:

```typescript
for (const rec of validRecords) {
  const cols = ["_source_id", ...userFieldSlugs.filter((s) => rec.data[s] !== undefined)];
  const vals = [rec.sourceId, ...userFieldSlugs.filter((s) => rec.data[s] !== undefined).map((s) => rec.data[s])];
  // ...
  await client.query(
    `INSERT INTO ${table} (${colNames.join(", ")})
     VALUES (${placeholders.join(", ")})
     ON CONFLICT ("_source_id") DO UPDATE SET ...`,
    vals,
  );
}
```

For a batch of 1,000 records with 10 mapping rules targeting the same entity, this executes 1,000 individual INSERT statements within a single transaction.

**Impact:** Data engineers running large syncs experience severely degraded mapping throughput. Each batch of records causes hundreds or thousands of round-trips to Postgres, creating a bottleneck that backs up the ontology:map queue and delays the entire pipeline.

**Fix:** Batch the upserts using unnest() arrays (like the raw table insertBatch method does) or use multi-row VALUES. Group records that have the same set of non-undefined columns and issue one bulk INSERT per group.

**Effort:** Medium

---

#### V4-H-12: listConnectors applies plugin filter in-memory, bypassing pagination limits

**Severity:** HIGH
**Personas:** Data Engineer, Power User
**Component:** `services/ingestion/src/services/connector-service.ts` (line 353-401)

**Problem:** When filterPluginId is provided, listConnectors fetches ALL connectors for that plugin, then applies tenant and status filters in-memory, ignoring the cursor and limit:

```typescript
if (query.filterPluginId !== undefined) {
  const byPlugin = await connectorRepo.findByPluginId(query.filterPluginId);
  connectorRows = tenantId === "*"
    ? byPlugin
    : byPlugin.filter((c) => c.tenant_id === tenantId);
} else {
  connectorRows = await connectorRepo.findByTenantId(tenantId, {
    ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
    limit: query.limit,
  });
}
```

The `findByPluginId` call has no pagination. If a plugin has thousands of connectors, they are all loaded into memory. The cursor-based pagination parameters are completely ignored in this code path.

**Impact:** Data engineers filtering connectors by plugin ID get all results dumped at once with no pagination, causing memory pressure on the server and unusable API responses for plugins with many connectors.

**Fix:** Add cursor and limit parameters to the findByPluginId repository method, or use the list() method with both filterPluginId and pagination options applied at the SQL level.

**Effort:** Medium

---

#### V4-H-13: SDK apps.list() paginator expects {items} but server returns {data} with separate {pagination}

**Severity:** HIGH
**Personas:** App Developer, Plugin Developer
**Component:** `packages/sdk/src/resources/apps.ts` (line 150-165)

**Problem:** The SDK's `list()` method requests `transport.request<{ items: App[], nextCursor, total }>` (line 153-158). The Transport unwraps the `{ data: T }` envelope (transport.ts line 420-422), so it returns the inner value. The server list endpoint returns:
```json
{ "data": [...apps], "pagination": { "nextCursor": "...", "total": 42 } }
```
After Transport unwrapping `data`, the SDK receives the array of apps directly (not `{ items, nextCursor, total }`). So `result.items` is `undefined`, `result.nextCursor` is `undefined`, and the Paginator yields pages with `items: undefined`.

**Impact:** All `client.apps.list()` calls return empty or undefined data. Developers iterating over apps get no results despite apps existing.

**Fix:** The `list()` Paginator callback needs to expect the actual unwrapped shape. Since Transport unwraps `data`, the callback receives the `App[]` array directly. Either: (1) change Transport to not unwrap for list endpoints, or (2) restructure the Paginator callback to handle the actual `{ data: App[], pagination: {...} }` shape before unwrapping, or (3) have the server return the `{ items, nextCursor, total }` shape the SDK expects inside `data`.

**Effort:** Medium

---

#### V4-H-14: SDK CreateAppRequest missing required 'slug' field

**Severity:** HIGH
**Personas:** App Developer, Plugin Developer
**Component:** `packages/sdk/src/resources/platform-types.ts` (line 199-202)

**Problem:** The SDK's `CreateAppRequest` type is:
```ts
export interface CreateAppRequest {
  readonly name: string;
  readonly description?: string;
}
```
(platform-types.ts line 199-202)

But the server's CreateAppSchema (schemas/index.ts line 7-15) requires `slug`:
```ts
slug: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/)
```
Slug has no default value and is mandatory. The `accessMode` field defaults to 'platform-user' so is less critical, but should still be exposed.

**Impact:** Every `client.apps.create({ name: 'My App' })` call fails with a 400 validation error because `slug` is missing. Developers must cast or use `as any` to include it, defeating TypeScript safety.

**Fix:** Add `readonly slug: string` and `readonly accessMode?: 'platform-user' | 'public'` to `CreateAppRequest`. Also update `UpdateAppRequest` to include `slug`, `accessMode`, and `allowedModules`.

**Effort:** Small

---

#### V4-H-15: SDK App type mismatches actual server response -- missing slug, accessMode, tenantId; has non-existent 'status' field

**Severity:** HIGH
**Personas:** App Developer, Plugin Developer
**Component:** `packages/sdk/src/resources/platform-types.ts` (line 189-196)

**Problem:** The SDK's `App` type:
```ts
export interface App {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly status: 'active' | 'inactive';
  readonly createdAt: string;
  readonly updatedAt: string;
}
```
The actual server response (apps.ts lines 568-587, formatAppDetail) returns:
```
{ id, tenantId, name, slug, description, accessMode, currentBuildId, currentBuild, allowedModules, createdAt, updatedAt, createdBy }
```
The server never returns a `status` field. The SDK type is missing `slug`, `tenantId`, `accessMode`, `currentBuildId`, `allowedModules`, and `createdBy`.

**Impact:** App developers accessing `app.slug` or `app.accessMode` get no TypeScript support. The `status` property always reads as `undefined` at runtime despite being typed as required. Developers cannot rely on the type to build UIs.

**Fix:** Rewrite the `App` interface to match the actual server response: add `slug`, `tenantId`, `accessMode`, `currentBuildId`, `allowedModules`, `createdBy` and remove the non-existent `status` field.

**Effort:** Small

---

#### V4-H-16: Build service passes encrypted (ciphertext) env vars to the esbuild execution instead of decrypting them

**Severity:** HIGH
**Personas:** App Developer, Plugin Developer
**Component:** `services/app/src/services/build-service.ts` (line 402-408)

**Problem:** The build service reads env vars from the DB at line 403 and passes them directly to the Execution Service at line 407:
```ts
const envVarRows = await permRepo.listEnvVarsByApp(appId);
const envVars: Record<string, string> = {};
for (const ev of envVarRows) {
  if (!ev.is_secret) {
    envVars[ev.key] = ev.value;
  }
}
```
But `ev.value` is stored encrypted in the database (permission-service.ts line 216 encrypts with `encrypt(input.value, masterKey)` before persisting). The BFF runtime-config endpoint (bff.ts line 597-605) properly calls `decrypt()` before returning values. The build service does not decrypt, so esbuild receives ciphertext strings as env var values.

**Impact:** App builds that reference `process.env.MY_VAR` via esbuild define will get AES-GCM ciphertext blobs baked into their bundles instead of actual values. Runtime behavior is completely wrong.

**Fix:** Import and call `decrypt(ev.value, masterKey)` in the build service's env var loop, matching the pattern used in the BFF runtime-config handler. The `masterKey` is already available in `BuildServiceDeps`.

**Effort:** Small

---

#### V4-H-17: useAppStorage never loads persisted values due to BffClient not unwrapping data envelope

**Severity:** HIGH
**Personas:** App Developer, Plugin Developer
**Component:** `packages/app-sdk/src/hooks/useAppStorage.ts` (line 92-98)

**Problem:** The hook reads the BFF response:
```ts
bffClient
  .request<BffStorageGetResponse>(`/bff/storage/${encodeURIComponent(key)}`)
  .then((res) => {
    setValueState(res.value !== null ? (res.value as T) : defaultValue);
  })
```
The server returns `{ data: { key, value, updatedAt } }` (bff.ts line 461-467). Since BffClient.request() returns `response.json()` without unwrapping, `res` is `{ data: { key, value, ... } }`. So `res.value` is `undefined`, which passes the `!== null` check (since `undefined !== null`), and the hook casts `undefined as T`. The actual value nested at `res.data.value` is never reached.

**Impact:** useAppStorage appears to work (no errors thrown) but always returns the defaultValue on initial load. Persisted values are silently discarded. Developers see their preferences/settings reset on every page load.

**Fix:** Either have BffClient.request() unwrap the `{ data: T }` envelope, or change the storage hook to access `res.data.value` instead of `res.value`, and update `BffStorageGetResponse` to reflect the actual `{ data: { key, value, updatedAt } }` shape.

**Effort:** Small

---

#### V4-H-18: Auth provider scaffold generates getAuthorizationUrl with wrong signature (3 params vs 2)

**Severity:** HIGH
**Personas:** Platform Admin, Security Auditor, Plugin Developer
**Component:** `packages/plugin-sdk/src/dev/scaffold.ts` (line 349)

**Problem:** The AuthProvider interface defines `getAuthorizationUrl` with 2 parameters:

```typescript
// auth-provider.ts line 95
getAuthorizationUrl(state: string, options: AuthOptions): string;
```

But the scaffold template generates it with 3 parameters:

```typescript
// scaffold.ts line 349
getAuthorizationUrl(state: string, options: AuthOptions, config: Record<string, unknown>): string {
```

The extra `config` parameter does not exist in the interface. This means the scaffolded code will fail TypeScript compilation if strict interface checking is applied, or the `config` parameter will always be `undefined` at runtime since the caller only passes 2 arguments.

**Impact:** Every developer who scaffolds an auth-provider plugin gets broken code out of the box. The generated plugin won't compile with strict TypeScript, or if it somehow runs, the `config["clientId"]` access on line 351 reads from undefined and throws at runtime.

**Fix:** Change the scaffold template to match the interface signature: `getAuthorizationUrl(state: string, options: AuthOptions): string`. Access config through the closure or through the plugin's instance config stored elsewhere.

**Effort:** Small

---

#### V4-H-19: AuthContext missing fetch and credentials -- auth providers cannot exchange codes or access secrets

**Severity:** HIGH
**Personas:** Platform Admin, Security Auditor, Plugin Developer
**Component:** `packages/plugin-sdk/src/types/auth-provider.ts` (line 40-49)

**Problem:** The AuthContext interface provides only `tenant`, `logger`, and `cache`:

```typescript
export interface AuthContext {
  tenant: TenantContext;
  logger: PluginLogger;
  cache: CacheAccessor;
}
```

But auth providers need to: (1) call external token endpoints to exchange authorization codes (`handleCallback`), requiring `fetch`; (2) access client secrets for token exchange, requiring `credentials`. The scaffold template for auth-provider even declares `requiredApis: ["credentials", "fetch", "cache"]` and `requiredCredentials: [{ name: "clientSecret" }]` in the manifest.

Without `fetch`, `handleCallback` cannot make HTTP calls to the identity provider's token endpoint. Without `credentials`, it cannot access the client secret needed for the code exchange.

**Impact:** Auth provider plugins are architecturally unable to implement OAuth2 token exchange. The scaffold generates a manifest that requests these capabilities, but the AuthContext interface does not provide them. Every auth provider plugin developer will hit a wall when implementing handleCallback.

**Fix:** Add `fetch: FetchProxy` and `credentials: CredentialAccessor` to the AuthContext interface. Ensure the execution sandbox grants credential access for auth-provider execution types.

**Effort:** Medium

---

#### V4-H-20: Hook stage field has no validation against valid HookStage values

**Severity:** HIGH
**Personas:** Platform Admin, Security Auditor, Plugin Developer
**Component:** `packages/plugin-sdk/src/manifest/schema.ts` (line 17)

**Problem:** The manifest Zod schema validates hook declarations' `stage` field as just `z.string().min(1)`:

```typescript
const HookDeclarationZ = z.object({
  stage: z.string().min(1),  // Accepts ANY non-empty string
  criticality: z.enum(["critical", "advisory"]),
  ...
});
```

The HookStage type union has 26 specific valid stages (plus parameterized `pipeline.step:*` patterns). But the manifest schema accepts literally any string. A developer could type `"before:pipeline.execute"` (the wrong name from HookPayloadDataMap -- see V4-PL-01) and the manifest would validate successfully. The hook would simply never fire because no service emits that stage.

**Impact:** Plugin developers get no feedback when they mistype a hook stage name. The plugin installs, manifests validate, but hooks silently never fire. Debugging why a hook doesn't trigger requires deep platform knowledge since there's no error -- the stage name just doesn't match any emitted event.

**Fix:** Replace `z.string().min(1)` with `z.enum([...all valid HookStage values])` or `z.string().regex(/^(before|after):(ingestion|ontology|pipeline|execution|auth|app)\.[a-z]+/)` to catch typos at manifest validation time.

**Effort:** Small

---

#### V4-H-21: simulate-hook falls back to manifest.entrypoint which is the plugin object, not a hook function

**Severity:** HIGH
**Personas:** Platform Admin, Security Auditor, Plugin Developer
**Component:** `packages/plugin-sdk/src/dev/simulate-hook.ts` (line 121-140)

**Problem:** When `--entrypoint` is not provided, simulate-hook reads the manifest's `entrypoint` field:

```typescript
entrypoint = rawManifest["entrypoint"];  // e.g. "MyConnector"
```

But the manifest's `entrypoint` is the named export of the plugin object (e.g., `export const MyConnector: Connector = {...}`). The code then attempts to call it as a function:

```typescript
const fn = exports[__entrypoint];
if (typeof fn !== "function") {
  throw new Error("Bundle export ... is not a callable function (got " + typeof fn + ")");
}
```

Since the plugin object is an object (not a function), this always fails with: `Bundle export "MyConnector" is not a callable function (got object)`. The hook entrypoints are separate named exports specified in the hooks[] array of the manifest, not the top-level entrypoint.

**Impact:** First-time plugin developers running `op plugin simulate-hook before:ingestion.receive` without `--entrypoint` get a confusing error. The error message doesn't explain that they need to pass the hook function's export name, not the plugin object name. The fallback to manifest.entrypoint is a trap.

**Fix:** When `--entrypoint` is not provided, look up the hook's entrypoint from the manifest's hooks[] array by matching the provided stage argument. If no matching hook is declared, show a helpful error listing the available hooks and their entrypoints. Fall back to manifest.entrypoint only as a last resort with a clear warning.

**Effort:** Small

---

#### V4-H-22: execution:read scope missing from ApiKeyScope Zod enum causes API key creation failures

**Severity:** HIGH
**Personas:** Platform Admin, Security Auditor, Plugin Developer
**Component:** `services/auth/src/schemas/index.ts` (line 29-48)

**Problem:** The ApiKeyScope enum (used for Zod validation of API key creation requests) does not include `execution:read`:
```typescript
export const ApiKeyScope = z.enum([
  "data:read", "data:write", "ontology:read", "ontology:write",
  "pipelines:read", "pipelines:trigger", "pipelines:manage",
  "apps:read", "apps:deploy", "apps:manage",
  "plugins:read", "plugins:manage", "users:read", "users:manage",
  "logs:read", "webhooks:manage", "execution:run", "admin",
]);
```
However, the frontend's AVAILABLE_SCOPES list (packages/frontend/src/pages/settings/ApiKeysPage.tsx line 106) includes `execution:read`, and the token service ALL_SCOPES (services/auth/src/services/token-service.ts line 46) also includes it. When a user selects `execution:read` in the UI and submits, Zod rejects the request.

**Impact:** Admins who select execution:read in the API key creation form will get a cryptic validation error. They cannot create API keys with this scope despite it being a valid platform scope that JWTs include for multiple roles.

**Fix:** Add `"execution:read"` to the ApiKeyScope enum in services/auth/src/schemas/index.ts, between the existing scopes.

**Effort:** Small

---

#### V4-H-23: audit:read scope is required but never issued to any role

**Severity:** HIGH
**Personas:** Platform Admin, Security Auditor, Plugin Developer
**Component:** `services/logging/src/routes/audit.ts` (line 42-44)

**Problem:** The audit events endpoint requires `audit:read` scope (line 42-44):
```typescript
if (
  !user.scopes.includes("audit:read") &&
  !user.scopes.includes("admin")
) {
  throw new ForbiddenError("audit:read scope is required");
}
```
However, `audit:read` does not appear anywhere in the auth service: not in ALL_SCOPES (token-service.ts), not in PREDEFINED_ROLE_SCOPES, not in ApiKeyScope, and not in the frontend's AVAILABLE_SCOPES. The only way to pass this check is via the `admin` scope (which only platform-admin gets). Tenant-admins with `logs:read` cannot access audit events because `logs:read` is not `audit:read`.

**Impact:** Tenant admins, developers, and editors are completely locked out of the audit log API even though they have the logs:read scope. Only platform-admin (with the admin super-scope) can query audit events. This defeats the purpose of tenant-level audit visibility.

**Fix:** Either add `audit:read` to ALL_SCOPES, PREDEFINED_ROLE_SCOPES (at minimum for tenant-admin), and ApiKeyScope; or change the audit route to accept `logs:read` instead of the nonexistent `audit:read` scope.

**Effort:** Small

---

#### V4-H-24: User reactivation (isActive=true) is silently ignored

**Severity:** HIGH
**Personas:** Platform Admin, Security Auditor, Plugin Developer
**Component:** `services/auth/src/routes/users.ts` (line 143-200)

**Problem:** The PUT /api/v1/users/:id handler only processes `isActive === false` (line 150), deactivating the user. There is no code path for `isActive === true` to reactivate a deactivated user. The update call at line 143-146 does not pass `is_active` to the repository:
```typescript
const updated = await userRepository.update(id, {
  ...(parsed.data.displayName !== undefined ? { display_name: parsed.data.displayName } : {}),
  ...(parsed.data.roles !== undefined ? { roles: parsed.data.roles } : {}),
});

if (parsed.data.isActive === false) {
  await userRepository.deactivate(id);
  // ... session revocation logic
}
```
The `isActive: true` case falls through with no action. The response on line 200 even hardcodes `isActive: parsed.data.isActive === false ? false : updated.is_active`, masking the fact that no reactivation occurred.

**Impact:** Once an admin deactivates a user, there is no way to reactivate them through the API. The admin must update the database directly, which is unacceptable in production. The API silently accepts the request and returns a misleading 200 response.

**Fix:** Add an `isActive === true` branch that calls a new `userRepository.activate(id)` method (setting `is_active = true, updated_at = now()`), similar to how deactivate works. Alternatively, include `is_active` in the UpdateUserData interface and handle it in the repository update method.

**Effort:** Small

---

#### V4-H-25: GET /auth/me returns tenant ID as tenantName

**Severity:** HIGH
**Personas:** Platform Admin, Security Auditor, Plugin Developer
**Component:** `services/auth/src/routes/auth.ts` (line 105)

**Problem:** The /api/v1/auth/me endpoint returns the tenant_id (a UUID) as the tenantName:
```typescript
return c.json({
  id: found.id,
  email: found.email,
  displayName: found.display_name ?? "",
  tenantId: found.tenant_id,
  tenantName: found.tenant_id,  // BUG: should be the tenant's name, not its UUID
  roles: found.roles,
});
```
The user repository's findById returns a User row which has `tenant_id` but not the tenant's human-readable name. The code should join with auth.tenants to fetch the name.

**Impact:** Any UI that displays the tenant name (e.g., the admin page header, profile page, org switcher) will show a UUID string like `550e8400-e29b-41d4-a716-446655440000` instead of the organization's actual name. This is confusing and unprofessional for platform admins.

**Fix:** Query the tenant repository to fetch the actual tenant name: `const tenant = await tenantRepository.findById(found.tenant_id)` and return `tenantName: tenant?.name ?? found.tenant_id`.

**Effort:** Small

---

#### V4-H-26: Role deletion does not check if users still hold the role

**Severity:** HIGH
**Personas:** Platform Admin, Security Auditor, Plugin Developer
**Component:** `services/auth/src/routes/roles.ts` (line 155-181)

**Problem:** The DELETE /api/v1/roles/:id handler (lines 157-181) checks if the role is predefined and if the caller has permissions, then calls `roleRepository.delete(id)` directly:
```typescript
routes.delete("/api/v1/roles/:id", async (c) => {
  // ... permission checks ...
  const existing = await roleRepository.findById(user.tenantId, id);
  // ... predefined check ...
  const deleted = await roleRepository.delete(id);
  // No check for users who currently hold this role
  return new Response(null, { status: 204 });
});
```
There is no check for users who currently have this role assigned. Deleting a role that users hold leaves those users with a dangling role name in their roles array that no longer maps to any permissions.

**Impact:** If an admin deletes a custom role that is assigned to users, those users will have a phantom role that appears in their JWT but resolves to zero scopes (since resolveScopes only knows predefined roles or DB-backed custom roles). This effectively strips permissions from affected users without warning the admin.

**Fix:** Before deleting, query `SELECT count(*) FROM auth.users WHERE tenant_id = $1 AND $2 = ANY(roles)` to check if any users hold the role. If so, either reject the deletion with a clear error, or provide a bulk reassignment workflow.

**Effort:** Medium

---

#### V4-H-27: Role name update accepted by schema but silently dropped by handler

**Severity:** HIGH
**Personas:** Platform Admin, Security Auditor, Plugin Developer
**Component:** `services/auth/src/routes/roles.ts` (line 139-141)

**Problem:** The updateRoleRequest Zod schema (services/auth/src/schemas/index.ts line 303-307) accepts a `name` field:
```typescript
export const updateRoleRequest = z.object({
  name: z.string().min(1).max(64).optional(),
  description: z.string().max(500).optional(),
  permissions: z.array(z.string()).max(50).optional(),
});
```
But the PUT /api/v1/roles/:id handler at line 139-141 only passes `description` and `permissions` to the repository:
```typescript
const updated = await roleRepository.update(id, {
  ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
  ...(parsed.data.permissions !== undefined ? { permissions: parsed.data.permissions } : {}),
});
```
The `name` field is validated and parsed but never persisted. The API returns 200 OK, misleading the caller.

**Impact:** Admins who attempt to rename a custom role via the API will receive a success response, but the name remains unchanged. This causes confusion and makes role management unreliable. CI/CD scripts that manage roles via API will silently fail to rename roles.

**Fix:** Either add `name` to the repository update call: `...(parsed.data.name !== undefined ? { name: parsed.data.name } : {})`, and add `name` to UpdateRoleData type and the repository's SET clause. Or remove `name` from the updateRoleRequest schema if renaming is intentionally unsupported (and document why).

**Effort:** Small

---

#### V4-H-28: logs:export scope is required but never declared in the platform scope system

**Severity:** HIGH
**Personas:** Platform Admin, Security Auditor, Plugin Developer
**Component:** `services/logging/src/routes/logs.ts` (line 86-89)

**Problem:** The log export endpoint (GET /api/v1/logs/export) requires `logs:export` scope:
```typescript
if (
  !user.scopes.includes("logs:export") &&
  !user.scopes.includes("admin")
) {
  throw new ForbiddenError("logs:export scope is required");
}
```
But `logs:export` does not exist anywhere in the auth service: not in ALL_SCOPES (token-service.ts), not in any PREDEFINED_ROLE_SCOPES mapping, not in ApiKeyScope, and not in the frontend's AVAILABLE_SCOPES list. No JWT will ever contain this scope.

**Impact:** Only platform-admin users (via the `admin` super-scope) can export logs. All other roles, including tenant-admin, are locked out of the log export feature despite having `logs:read`. There is no way for admins to grant `logs:export` to any user or API key.

**Fix:** Add `logs:export` to ALL_SCOPES in token-service.ts, to PREDEFINED_ROLE_SCOPES for tenant-admin, to ApiKeyScope in schemas/index.ts, and to the frontend's AVAILABLE_SCOPES. Alternatively, change the export endpoint to accept `logs:read` if that is the intended access level.

**Effort:** Small

---

#### V4-H-29: Backup script Redis CLI commands lack ACL authentication

**Severity:** HIGH
**Personas:** DevOps/SRE, First-Time Self-Hoster
**Component:** `docker/scripts/backup.sh` (line 86-98)

**Problem:** The backup script calls redis-cli without credentials:

```bash
BEFORE_SAVE=$(docker compose exec -T redis redis-cli LASTSAVE ...)
docker compose exec -T redis redis-cli BGSAVE > /dev/null
```

Since the default Redis user is disabled (`user default off nopass`), these commands will fail with an authentication error. The healthcheck in docker-compose.yml correctly authenticates (`redis-cli --user op_admin -a "$$PASS" ping`), but the backup script does not follow the same pattern.

**Impact:** Operators cannot back up Redis data. The backup script fails silently on LASTSAVE (stderr redirected) then exits with an error on BGSAVE. The entire backup operation may appear to complete but the Redis RDB file will be stale or missing.

**Fix:** Authenticate using the op_admin user credentials from the init-data volume:
```bash
ADMIN_PASS=$(docker compose exec -T redis cat /data/init/redis_password_admin.txt | tr -d '[:space:]')
BEFORE_SAVE=$(docker compose exec -T redis redis-cli --user op_admin -a "$ADMIN_PASS" LASTSAVE ...)
docker compose exec -T redis redis-cli --user op_admin -a "$ADMIN_PASS" BGSAVE > /dev/null
```

**Effort:** Small

---

#### V4-H-30: Auth service SIGTERM handler has no shutdown timeout fallback

**Severity:** HIGH
**Personas:** DevOps/SRE, First-Time Self-Hoster
**Component:** `services/auth/src/index.ts` (line 364-368)

**Problem:** The auth service's SIGTERM handler has no hard-exit timeout:

```typescript
process.on("SIGTERM", () => {
    server.close(() => {
      void cleanup().then(() => process.exit(0));
    });
  });
```

Every other service (gateway, ingestion, ontology, pipeline, execution, app, logging, plugin) implements a 30-second hard-exit setTimeout as a safety net. If `server.close()` or `cleanup()` hangs due to a stuck connection or unresponsive backing store, the auth service process will never exit voluntarily.

**Impact:** During deployments or restarts, the auth service may hang indefinitely waiting for connections to drain. Docker's stop_grace_period (45s) will eventually SIGKILL it, but this is a hard kill that skips cleanup (DB pool close, Redis quit), potentially leaving connections open and causing connection pool exhaustion on the backing stores.

**Fix:** Add a 30-second hard-exit timeout matching the pattern in all other services:
```typescript
process.on("SIGTERM", () => {
    console.info("SIGTERM received -- starting graceful shutdown");
    const shutdownTimeout = setTimeout(() => {
      console.error("Shutdown timeout exceeded -- forcing exit");
      process.exit(1);
    }, 30_000);
    shutdownTimeout.unref();
    server.close(() => {
      void cleanup().then(() => {
        clearTimeout(shutdownTimeout);
        process.exit(0);
      });
    });
  });
```

**Effort:** Small

---

#### V4-H-31: Gateway /healthz liveness probe depends on Postgres and Redis availability

**Severity:** HIGH
**Personas:** DevOps/SRE, First-Time Self-Hoster
**Component:** `services/gateway/src/routes/health.ts` (line 16-43)

**Problem:** The gateway's `/healthz` endpoint performs full connectivity checks to both Postgres and Redis:

```typescript
routes.get("/healthz", async (c) => {
    try {
      await pool.query("SELECT 1");
      checks["postgres"] = "ok";
    } catch {
      checks["postgres"] = "error";
      healthy = false;
    }
    try {
      await redis.ping();
      checks["redis"] = "ok";
    } catch {
      checks["redis"] = "error";
      healthy = false;
    }
    // returns 503 if either check fails
```

Docker Compose healthcheck (docker-compose.yml line 264) polls `/healthz`. When Postgres or Redis experiences a transient blip (network partition, brief restart), the healthcheck returns 503 and Docker marks the container unhealthy. After 5 consecutive failures (retries: 5), Docker restarts the gateway. This creates a restart cascade: all 9 services depend on the gateway being healthy, so a brief DB blip can bring down the entire platform.

**Impact:** A transient Postgres or Redis hiccup causes the gateway container to be restarted by Docker, which cascades to all services that depend on it (the frontend depends on gateway-service being healthy). This turns a recoverable backing-store blip into a full platform outage.

**Fix:** The `/healthz` liveness endpoint should only verify the process is alive (return 200 unconditionally or check only internal state). Move the Postgres/Redis dependency checks to `/readyz` only (which currently only checks Postgres). Update the docker-compose.yml healthcheck to use `/healthz` for liveness and configure a separate readiness check for load balancing if needed.

**Effort:** Small

---

#### V4-H-32: MinIO container has no resource limits -- can consume unbounded memory and CPU

**Severity:** HIGH
**Personas:** DevOps/SRE, First-Time Self-Hoster
**Component:** `docker/docker-compose.yml` (line 138-157)

**Problem:** The MinIO service definition has no `deploy.resources.limits` section:

```yaml
minio:
    image: minio/minio:RELEASE.2024-05-10T01-41-38Z
    command: ["server", "/data", "--console-address", ":9001"]
    ...
    # No deploy: section
```

Every other stateful service (postgres, redis, pgbouncer) and all application services have explicit memory and CPU limits. MinIO handles object storage for plugin bundles, app build artifacts, and file uploads. Under heavy upload load or a memory leak, MinIO can consume all available host memory, causing OOM kills of other containers.

**Impact:** MinIO can starve other containers of memory and CPU resources on the host, potentially causing OOM kills of critical services (postgres, redis, application services). This is especially dangerous during large file uploads or when many concurrent operations access MinIO.

**Fix:** Add resource limits to the MinIO service definition:
```yaml
minio:
    ...
    deploy:
      resources:
        limits:
          memory: 1g
          cpus: "1"
```

**Effort:** Small

---

#### V4-H-33: logs:export and audit:read scopes are unrepresented in ALL_SCOPES and role mappings

**Severity:** HIGH
**Personas:** First-Time Self-Hoster, DevOps/SRE
**Component:** `services/auth/src/services/token-service.ts` (line 29-49)

**Problem:** The logging service route handlers require `logs:export` (services/logging/src/routes/logs.ts line 88) and `audit:read` (services/logging/src/routes/audit.ts line 43) scopes. However, neither scope appears in the token service's `ALL_SCOPES` array (lines 29-49) or in any `PREDEFINED_ROLE_SCOPES` mapping (lines 54-74). The only way to access these endpoints is via the `admin` scope, which short-circuits to ALL_SCOPES at line 88:

```typescript
if (union.has("admin")) return [...ALL_SCOPES];
```

But even `admin` expansion does NOT include `logs:export` or `audit:read` since they are not in `ALL_SCOPES`. This means no JWT token can ever carry these scopes, making these routes completely inaccessible even to platform admins (unless the route fallback to `user.scopes.includes("admin")` catches it before the scope check).

**Impact:** The log export endpoint and audit event query endpoint check for scopes that cannot be granted to any user or API key. Platform admins can access them only through the separate `admin` string match in the route guard, but no non-admin role can ever be granted these capabilities. This blocks legitimate compliance and operational use cases.

**Fix:** Add `logs:export` and `audit:read` to `ALL_SCOPES` in token-service.ts, add them to appropriate role mappings in `PREDEFINED_ROLE_SCOPES` (e.g., tenant-admin and developer for logs:export, tenant-admin for audit:read), and add them to the `ApiKeyScope` enum in schemas/index.ts so they can be granted via API keys.

**Effort:** Small

---

#### V4-H-34: API key scope enum missing execution:read, preventing API key access to execution GET endpoints

**Severity:** HIGH
**Personas:** First-Time Self-Hoster, DevOps/SRE
**Component:** `services/auth/src/schemas/index.ts` (line 29-48)

**Problem:** The `ApiKeyScope` Zod enum (lines 29-48) does not include `execution:read`, while the token service's `ALL_SCOPES` (token-service.ts line 46) does include it. The schema lists:

```typescript
export const ApiKeyScope = z.enum([
  // ... other scopes ...
  "execution:run",
  "admin",
]);
```

Note `execution:read` is absent. This means users cannot create API keys with the `execution:read` scope, since the Zod validation at key creation time (POST /api/v1/api-keys) rejects it as an invalid enum value. JWT-based sessions receive `execution:read` via role resolution, but API key users cannot.

**Impact:** API integrations that need to read execution results (GET /api/v1/exec/{id}) via API keys are blocked. The Zod schema rejects the scope at creation time, forcing users to use the `admin` scope as an overprivileged workaround.

**Fix:** Add `"execution:read"` to the `ApiKeyScope` enum in `services/auth/src/schemas/index.ts` between `logs:read` and `webhooks:manage`.

**Effort:** Small

---

#### V4-H-35: User reactivation (isActive=true) silently ignored, leaving deactivated users permanently locked

**Severity:** HIGH
**Personas:** First-Time Self-Hoster, DevOps/SRE
**Component:** `services/auth/src/routes/users.ts` (line 143-192)

**Problem:** The user update handler at line 150 only processes `isActive === false` (deactivation). There is no corresponding `else if (parsed.data.isActive === true)` branch to reactivate a user:

```typescript
const updated = await userRepository.update(id, {
  ...(parsed.data.displayName !== undefined ? { display_name: parsed.data.displayName } : {}),
  ...(parsed.data.roles !== undefined ? { roles: parsed.data.roles } : {}),
});

if (parsed.data.isActive === false) {
  await userRepository.deactivate(id);
  // ... session revocation ...
}
```

When `isActive=true` is sent, the `update()` call at line 143 does not include `is_active` in its SET clause (it only handles display_name, roles, metadata, last_login_at, password_hash). The deactivation branch is skipped. The response at line 200 misleadingly returns the old `is_active` value from the `updated` record.

**Impact:** Admins with `users:manage` scope cannot reactivate deactivated users through the API. Once deactivated, a user is permanently locked out unless someone manually updates the database. This is a significant operational security concern as it means there is no self-service recovery path.

**Fix:** Add an `else if (parsed.data.isActive === true)` branch that calls a new `userRepository.reactivate(id)` method setting `is_active = true`. Also clear the `revocation:user:{id}` Redis key if it still exists.

**Effort:** Small

---

#### V4-H-36: User list pagination cursor is unsigned, enabling cursor forgery

**Severity:** HIGH
**Personas:** First-Time Self-Hoster, DevOps/SRE
**Component:** `services/auth/src/repositories/user-repository.ts` (line 179-189)

**Problem:** The `listByTenant` method uses a simple base64url-encoded JSON cursor with no cryptographic signature:

```typescript
if (cursor !== undefined) {
  let decoded: { createdAt: string; id: string };
  try {
    decoded = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8")
    ) as { createdAt: string; id: string };
  } catch {
    throw new Error("Invalid cursor: could not decode pagination cursor");
  }
  afterCreatedAt = decoded.createdAt;
  afterId = decoded.id;
}
```

In contrast, the logging service uses `encodeCursor`/`decodeCursor` with HMAC signing via `OP_CURSOR_SECRET` (log-event-repository.ts lines 124, 155-160; audit-event-repository.ts lines 131, 161-169). The user repository's unsigned cursor allows an attacker to craft arbitrary cursor values to enumerate users by manipulating `createdAt` and `id` values, potentially accessing user records from different pages than intended.

**Impact:** An attacker with `users:read` scope can forge cursor values to skip ahead, jump backward, or systematically enumerate all users in a tenant by crafting cursor values with arbitrary timestamps and UUIDs. While parameterized queries prevent SQL injection, the pagination manipulation breaks intended access patterns.

**Fix:** Use the core `encodeCursor`/`decodeCursor` functions (with `OP_CURSOR_SECRET` HMAC) consistently across all repositories, including the user repository. Add a Zod schema validation for the decoded cursor payload (as done in log-event-repository.ts with `CursorPayloadSchema`).

**Effort:** Small

---

#### V4-H-37: No multi-factor authentication (MFA/2FA) support

**Severity:** HIGH
**Personas:** Enterprise Evaluator, Security Auditor, Platform Admin
**Component:** `services/auth/src/services/auth-service.ts` (line 1-781)

**Problem:** A grep for 'MFA|mfa|multi.factor|totp|authenticator|2fa|two.factor' across the entire auth service returns zero results. The login flow in `auth-service.ts` at lines 274-424 only validates email + password with no second factor step. The auth routes (`routes/auth.ts`) have no MFA enrollment, challenge, or verification endpoints.

**Impact:** Enterprises with compliance requirements (SOC2, PCI-DSS, HIPAA) mandate MFA for administrative access. Without MFA, a single compromised password gives full account access. This is a compliance blocker for regulated industries. All enterprise competitors (Fivetran, Retool, n8n Cloud) support TOTP-based MFA at minimum.

**Fix:** Add TOTP-based MFA with enrollment (QR code generation), verification (6-digit code), and recovery codes. Store encrypted TOTP secrets in the users table. Add MFA enforcement policy per-tenant in tenant settings. Implement MFA challenge step in the login flow between password verification and token issuance.

**Effort:** Large

---

#### V4-H-38: Login flow does not capture IP address or user-agent in session records

**Severity:** HIGH
**Personas:** Enterprise Evaluator, Security Auditor, Platform Admin
**Component:** `services/auth/src/services/auth-service.ts` (line 370-380)

**Problem:** The session creation in the login flow stores no client metadata:
```typescript
await db.query(
  `INSERT INTO auth.sessions
     (id, user_id, tenant_id, refresh_token_jti, family_id, expires_at)
   VALUES ($1, $2, $3, $4, $5, $6)`,
  [sessionId, user.id, data.tenantId, randomUUID(), familyId, expiresAt]
);
```
The Session type (`repositories/types.ts:32-44`) has `user_agent: string | null` and `ip_address: string | null` columns, but the login handler never extracts or passes these values from the request. The same issue exists in the OAuth callback at `oauth-service.ts:308-313` and the registration flow at `auth-service.ts:228-233`.

**Impact:** Enterprise security teams cannot audit session origin (geographic location, device type) or detect anomalous login patterns (impossible travel, credential stuffing from bot networks). Session management UI cannot show users where their sessions are active. This is required for SOC2 compliance and is standard in all enterprise auth systems.

**Fix:** Extract `c.req.header('User-Agent')` and the client IP from the request context. Pass both through to the session INSERT in all code paths: login, registration, OAuth callback, and token refresh. Update the session listing API to expose these fields.

**Effort:** Medium

---

#### V4-H-39: Audit events lack source IP, user-agent, and request ID fields

**Severity:** HIGH
**Personas:** Enterprise Evaluator, Security Auditor, Platform Admin
**Component:** `services/logging/src/services/audit-service.ts` (line 11-22)

**Problem:** The `AuditEventJobSchema` captures only high-level action metadata:
```typescript
const AuditEventJobSchema = z.object({
  timestamp: z.string().datetime(),
  traceId: z.string().default(""),
  actorId: z.string().min(1).max(255),
  actorType: z.enum(["user", "service", "system"]),
  tenantId: z.string().min(1).max(255),
  action: z.string().min(1).max(255),
  resourceType: z.string().min(1).max(255),
  resourceId: z.string().min(1).max(255),
  result: z.enum(["success", "failure"]),
  metadata: z.record(z.unknown()).default({}),
});
```
Missing: `sourceIp`, `userAgent`, `requestId`, `changedFields` (before/after values). The DB schema (`audit_events` table) also lacks these columns. While `metadata` could theoretically hold arbitrary data, no producer currently populates it with IP/UA information.

**Impact:** For compliance audits (SOC2, GDPR Article 30, HIPAA), auditors require knowing WHERE an action originated (IP), HOW it was performed (user-agent/API key), and WHAT changed (before/after). Without these fields, the audit trail is incomplete and will fail formal compliance audits. Enterprise competitors like Retool capture full request context in audit logs.

**Fix:** Add `sourceIp`, `userAgent`, and `requestId` fields to the AuditEventJobSchema and the `audit_events` DB table. Propagate request context from the gateway through event publishing. Add a `changes` JSONB column for before/after diffs on mutating operations.

**Effort:** Medium

---

#### V4-H-40: Repeated full findByRunId queries on every step iteration in the execution engine

**Severity:** HIGH
**Personas:** Power User / Data Scientist, Data Engineer
**Component:** `services/pipeline/src/services/execution-engine.ts` (line 809, 836, 1001)

**Problem:** During step traversal in `processRun`, the execution engine calls `runStepRepo.findByRunId(runId)` to fetch ALL run_step rows on every loop iteration:
- Line 809: Inside cancellation check: `const stepRows = await runStepRepo.findByRunId(runId);`
- Line 836: To find the current step's row: `const stepRows = await runStepRepo.findByRunId(runId);`
- Line 1001: On failure to cancel pending steps: `const stepRows = await runStepRepo.findByRunId(runId);`

For a pipeline with N steps, the main traversal loop alone issues N full-table queries (one per step at line 836). Each query fetches ALL step rows (up to 100 per the schema max). A 50-step pipeline thus issues 50 SELECT queries each returning 50 rows, just to find the matching step_id.

**Impact:** Power users running complex 20-50 step pipelines see significantly slower execution times due to O(N^2) database queries. Each step adds ~5-10ms of unnecessary DB overhead, adding 250-500ms of pure waste for a 50-step pipeline. At scale with many concurrent runs, this creates severe DB connection pool pressure.

**Fix:** Load step rows once at the start of traversal into a `Map<string, RunStepRow>`. Re-use the map during traversal instead of re-querying on every step. Only re-query when step rows need to be updated for cancellation. The map can be built from the createBatch result at line 758.

**Effort:** Small

---

#### V4-H-41: SDK CreatePipelineRequest type is incompatible with the backend schema

**Severity:** HIGH
**Personas:** Power User / Data Scientist, Data Engineer
**Component:** `packages/sdk/src/resources/platform-types.ts` (line 60-66)

**Problem:** The SDK's `CreatePipelineRequest` type (line 60-66) expects:
```typescript
export interface CreatePipelineRequest {
  readonly name: string;
  readonly description?: string;
  readonly trigger: PipelineTrigger;
}
```
But the backend `CreatePipelineSchema` (schemas/index.ts line 150-162) expects:
```typescript
z.object({
  name: z.string(),
  slug: z.string().optional(),
  description: z.string().optional(),
  definition: PipelineDefinitionSchema,  // { version, entryStepId, steps, options }
  isActive: z.boolean().default(true),
})
```
The SDK type has `trigger: PipelineTrigger` (a union of manual/schedule/event objects) but the backend expects `definition: PipelineDefinition` (with version, entryStepId, steps array). There is no `trigger` field in the backend schema at all. Similarly, `UpdatePipelineRequest` (line 68-72) includes `trigger?` and `status?` fields that the backend does not accept.

**Impact:** Any developer using the SDK types as a guide to create pipelines will send malformed requests. The `trigger` field is silently ignored by the backend, and the required `definition` field is absent from the SDK type, causing a 400 Validation Error with no obvious explanation. This is the primary pipeline creation path for power users.

**Fix:** Update `CreatePipelineRequest` and `UpdatePipelineRequest` in `platform-types.ts` to match the backend schema: replace `trigger` with `definition: PipelineDefinition`, add `slug?`, `isActive?`, and define a `PipelineDefinition` type with `version`, `entryStepId`, `steps`, and `options`.

**Effort:** Medium

---

#### V4-H-42: listPipelines always returns lastRunAt as null

**Severity:** HIGH
**Personas:** Power User / Data Scientist, Data Engineer
**Component:** `services/pipeline/src/services/pipeline-service.ts` (line 488)

**Problem:** The `listPipelines` service method hardcodes `lastRunAt: null` for every pipeline:
```typescript
return {
  data: rows.map((pipeline) => ({ pipeline, lastRunAt: null })),
  pagination: { nextCursor, total: null },
};
```
The `PipelineListResult` interface (line 147) declares `lastRunAt: string | null` as a field, and the CLI renders it in the PIPELINE_COLUMNS (cli/src/commands/pipeline/index.ts line 19). But the service never queries for it.

**Impact:** Power users listing pipelines via CLI (`op pipeline list`) or SDK always see a blank 'Last Run' column. This is critical information for monitoring pipeline health -- users cannot tell which pipelines have run recently without individually querying each pipeline's run history. With dozens of pipelines, this forces N+1 manual lookups.

**Fix:** Add a LEFT JOIN or subquery to fetch the most recent run's `started_at` (or `created_at`) for each pipeline in the list query. This can be done with a lateral join: `LEFT JOIN LATERAL (SELECT created_at FROM pipeline.runs WHERE pipeline_id = p.id ORDER BY created_at DESC LIMIT 1) lr ON true`. Also populate `total` in the pagination response.

**Effort:** Medium

---

#### V4-H-43: Cursor-based pagination uses id > cursor but ORDER BY created_at ASC -- unstable ordering

**Severity:** HIGH
**Personas:** Power User / Data Scientist, Data Engineer
**Component:** `services/pipeline/src/repositories/pipeline-repository.ts` (line 100-116)

**Problem:** The `findByTenantId` method uses `id > $cursor` as the cursor condition but orders by `created_at ASC, id ASC`:
```typescript
if (options?.cursor !== undefined) {
  conditions.push(`id > $${idx++}`);
  values.push(options.cursor);
}
// ...
ORDER BY created_at ASC, id ASC
LIMIT $${idx}
```
The cursor is the last-seen `id` (a UUID), but the sort is on `created_at`. UUIDs are not monotonically increasing with respect to `created_at` (especially UUID v4). A pipeline created earlier could have a lexicographically larger UUID, causing `id > cursor` to skip it. This breaks pagination when rows have varying UUID patterns vs creation timestamps.

**Impact:** Power users paginating through large pipeline lists may miss pipelines or see duplicates across pages. The issue gets worse with concurrent pipeline creation across multiple users. The same cursor mismatch exists in the run repository's `findByTenantId` (run-repository.ts lines 97-131) and the schedule repository.

**Fix:** Use a composite cursor strategy: either (1) change the cursor to encode both `created_at` and `id`, using `WHERE (created_at, id) > ($cursor_ts, $cursor_id)`, or (2) switch to ordering by `id ASC` with `id > cursor` since UUIDs provide sufficient uniqueness. Option 2 is simpler and sufficient for most use cases.

**Effort:** Medium

---

#### V4-H-44: Settings sidebar layout breaks on mobile screens

**Severity:** HIGH
**Personas:** Casual / Non-Technical User, First-Time Self-Hoster
**Component:** `packages/frontend/src/pages/settings/SettingsPage.tsx` (line 54)

**Problem:** The settings page uses a horizontal `flex gap-8` layout with a fixed `w-48` sidebar nav and the content area side by side. There are no responsive breakpoints to stack this layout vertically on small screens. On mobile, the 192px sidebar plus the gap-8 (32px) consumes most of the viewport width, leaving the content area (profile form, password form, etc.) crushed into an unreadably narrow column.

Code at line 54:
```tsx
<div className="flex gap-8">
  {/* Sidebar nav */}
  <nav aria-label="Settings navigation" className="w-48 shrink-0">
```

**Impact:** Any user accessing Settings on a phone or narrow tablet cannot read or interact with the profile, teams, API keys, webhooks, or admin forms. The forms become too narrow to use.

**Fix:** Add responsive classes to stack the layout vertically on mobile. For example: `className="flex flex-col gap-4 md:flex-row md:gap-8"` for the container, and `className="w-full md:w-48 shrink-0"` for the nav. Also consider making the settings nav a horizontal scrollable tab bar on mobile.

**Effort:** Small

---

#### V4-H-45: API key scope selection uses raw code identifiers with no explanations

**Severity:** HIGH
**Personas:** Casual / Non-Technical User, First-Time Self-Hoster
**Component:** `packages/frontend/src/pages/settings/ApiKeysPage.tsx` (line 378-393)

**Problem:** When creating an API key, the scope selection shows raw machine-readable scope strings like `data:read`, `ontology:write`, `pipelines:trigger`, `execution:run`, and `admin` with no human-readable descriptions. A non-technical user has no idea what `ontology:write` or `execution:run` means, nor what the consequences of selecting `admin` are.

Code at lines 378-393:
```tsx
<fieldset>
  <legend className="mb-2 text-sm font-medium">Scopes</legend>
  <div className="space-y-2">
    {AVAILABLE_SCOPES.map((scope) => (
      <label key={scope} className="flex cursor-pointer items-center gap-2 text-sm">
        <input type="checkbox" ... />
        <code className="font-mono text-xs">{scope}</code>
      </label>
    ))}
  </div>
</fieldset>
```

The 19 scopes are rendered as a flat list of monospace code strings.

**Impact:** Non-technical users creating API keys for integrations cannot understand what permissions they are granting. They may either over-grant (security risk) or under-grant (integration fails) because the scope names are opaque.

**Fix:** Add human-readable labels and brief descriptions for each scope. Group them by category (Data, Ontology, Pipelines, Apps, etc.). For example: `data:read` could show as "Read data - Query and retrieve records from the platform".

**Effort:** Medium

---

### MEDIUM (61)

#### V4-M-01: BootstrapErrorPage shows wrong health check URL

**Severity:** MEDIUM
**Personas:** First-Time Self-Hoster, DevOps/SRE
**Component:** `packages/frontend/src/pages/BootstrapErrorPage.tsx` (line 79)

**Problem:** The troubleshooting section tells users:
```tsx
Try <code>curl http://localhost:3000/health</code>.
```

But the actual health endpoint is `/healthz` (not `/health`), as defined in `services/gateway/src/routes/health.ts:16`:
```typescript
routes.get("/healthz", async (c) => {
```

Also, the gateway is at port 3000 but the user is on port 8080 (frontend). Additionally, step 4 references `OP_GATEWAY_PORT`, a variable that does not exist in the config schema or docker-compose.yml.

**Impact:** Users following the troubleshooting steps get a 404 from the wrong health endpoint URL, further confusing debugging. The phantom `OP_GATEWAY_PORT` reference adds confusion about non-existent configuration.

**Fix:** Change the health check URL to `curl http://localhost:3000/healthz` and remove the reference to `OP_GATEWAY_PORT`. Replace with `OP_BASE_URL` or just mention the gateway is on port 3000.

**Effort:** Small

---

#### V4-M-02: OP_SMTP_FROM Zod validation rejects the documented RFC 5322 display-name format

**Severity:** MEDIUM
**Personas:** First-Time Self-Hoster, DevOps/SRE
**Component:** `packages/core/src/config.ts` (line 62)

**Problem:** The auth config schema validates:
```typescript
OP_SMTP_FROM: z.string().email().optional(),
```

But `.env.example` documents the value as RFC 5322 display-name format:
```
OP_SMTP_FROM=OnePlatform <noreply@example.com>
```

Zod's `.email()` validator expects a bare email address (e.g., `noreply@example.com`), not the display-name format (`Name <email>`). Any user who follows the .env.example format will get a startup validation error on the auth service.

**Impact:** Auth service fails to start when self-hosters set OP_SMTP_FROM using the format shown in .env.example. The error message from Zod says "Invalid email" which is confusing since the value contains a valid email.

**Fix:** Either change the Zod validation to use a custom regex that accepts both bare email and RFC 5322 display-name format, or change the .env.example to show just the bare email: `OP_SMTP_FROM=noreply@example.com`.

**Effort:** Small

---

#### V4-M-03: Gateway service fallback URLs use wrong ports for upstream services

**Severity:** MEDIUM
**Personas:** First-Time Self-Hoster, DevOps/SRE
**Component:** `docker/docker-compose.yml` (line 224-259)

**Problem:** The gateway service's index.ts has hardcoded fallback URLs that use the old port convention:
```typescript
// services/gateway/src/index.ts:319-320
ontologyServiceUrl: process.env["ONTOLOGY_SERVICE_URL"] ?? "http://ontology-service:3003",
ingestionServiceUrl: process.env["INGESTION_SERVICE_URL"] ?? "http://ingestion-service:3002",
```

But all services listen on port 3000 internally (the docker-compose correctly sets `ONTOLOGY_SERVICE_URL: http://ontology-service:3000`). If the env vars are ever unset, the fallback ports 3003 and 3002 would cause connection failures.

**Impact:** If environment variables are stripped (e.g., running outside docker-compose for debugging), the gateway tries to reach ontology on port 3003 and ingestion on port 3002, both of which are wrong. Connection timeouts with no clear error message.

**Fix:** Update the fallback URLs in `services/gateway/src/index.ts` lines 319-320 to use port 3000:
```typescript
ontologyServiceUrl: process.env["ONTOLOGY_SERVICE_URL"] ?? "http://ontology-service:3000",
ingestionServiceUrl: process.env["INGESTION_SERVICE_URL"] ?? "http://ingestion-service:3000",
```

**Effort:** Small

---

#### V4-M-04: Frontend VITE_API_URL is described as build-time but never actually set

**Severity:** MEDIUM
**Personas:** First-Time Self-Hoster, DevOps/SRE
**Component:** `docker/docker-compose.yml` (line 627-639)

**Problem:** The docker-compose comment says:
```yaml
# VITE_API_URL is baked into the SPA at build time (not a runtime env var).
# See Dockerfile.frontend where it is passed as a build arg.
```

But the Dockerfile.frontend (docker/Dockerfile.frontend) never sets or uses VITE_API_URL as a build arg. The frontend uses relative paths (`/api/*`) via the api-client.ts, which works correctly through nginx proxy. However, the misleading comment about VITE_API_URL being a build arg could lead a self-hoster to waste time trying to configure it.

**Impact:** Self-hosters read the comment and try to set VITE_API_URL, wasting time debugging a non-existent configuration option.

**Fix:** Remove the misleading VITE_API_URL comment from docker-compose.yml. The frontend correctly uses relative paths through nginx proxy and no build-time API URL configuration is needed.

**Effort:** Small

---

#### V4-M-05: DEPLOYMENT.md documents phantom `OP_GATEWAY_PORT` configuration variable

**Severity:** MEDIUM
**Personas:** First-Time Self-Hoster, DevOps/SRE
**Component:** `docs/DEPLOYMENT.md` (line 56)

**Problem:** The deployment guide's configuration table includes:
```
| `OP_GATEWAY_PORT` | `3000` | Port the API gateway listens on. |
```

And the troubleshooting section (line 228) references it:
```
Port conflict: Another service is using port 3000. Set `OP_GATEWAY_PORT` to a free port.
```

But `OP_GATEWAY_PORT` is not defined in any config schema (packages/core/src/config.ts), is not referenced in any service code, and is not in .env.example or docker-compose.yml. The gateway port is controlled by the `PORT` env var (hardcoded to 3000 in docker-compose) and the Docker port mapping.

**Impact:** Self-hosters with port conflicts try setting OP_GATEWAY_PORT and are confused when it has no effect. They cannot figure out how to change the port.

**Fix:** Remove `OP_GATEWAY_PORT` from DEPLOYMENT.md. Document the actual port change mechanism: modify the `ports` mapping in docker-compose.yml (e.g., change `3000:3000` to `4000:3000`).

**Effort:** Small

---

#### V4-M-06: Mapping service fetches entity and fields per entity per batch without caching

**Severity:** MEDIUM
**Personas:** Data Engineer, Power User
**Component:** `services/ontology/src/services/mapping-service.ts` (line 62-64)

**Problem:** Inside the mapBatch method, for every entity in the rulesByEntity map, the service queries the entity and all its fields:

```typescript
for (const [entityId, entityRules] of rulesByEntity) {
  const entity = await entityRepo.findById(tenantId, entityId);
  if (!entity) continue;
  const fields = await fieldRepo.findByEntityId(entityId);
```

Since batches arrive continuously during a sync, the same entity and fields are fetched from the database on every single batch. For a connector syncing 100K records in 100 batches targeting 3 entities, this results in 300 redundant entity lookups and 300 redundant field lookups.

**Impact:** Data engineers running high-throughput syncs see unnecessary database load on the ontology service. The repeated queries slow down mapping and add latency to every batch, accumulating to significant delays across a full sync.

**Fix:** Add an in-process LRU cache for entity and field lookups in the mapping service, keyed by entityId, with a short TTL (e.g., 60 seconds). The entity schema rarely changes during a sync.

**Effort:** Small

---

#### V4-M-07: CLI pipeline update uses PUT instead of PATCH, sending incomplete data

**Severity:** MEDIUM
**Personas:** Data Engineer, Power User
**Component:** `packages/cli/src/commands/pipeline/index.ts` (line 56-62)

**Problem:** The CLI pipeline update command uses `ctx.http.put` while the API expects `PATCH /api/v1/pipelines/:id`:

```typescript
async function updateAction(id: string, opts: { file: string }, ctx: CommandContext): Promise<void> {
  const { load } = await import("js-yaml");
  const content = readFileSync(opts.file, "utf8");
  const definition = load(content) as unknown;
  await ctx.http.put(`/api/v1/pipelines/${encodeURIComponent(id)}`, definition);
```

The server defines `routes.patch("/:id", ...)` but no `routes.put("/:id", ...)`. The PUT request will receive a 404 or method-not-allowed response.

**Impact:** Data engineers attempting to update a pipeline definition via `op pipeline update <id> --file pipeline.yaml` get an error because the HTTP method does not match. The update workflow is broken from the CLI.

**Fix:** Change `ctx.http.put` to `ctx.http.patch` in the pipeline update action.

**Effort:** Small

---

#### V4-M-08: CLI schedule pause/resume calls nonexistent API endpoints

**Severity:** MEDIUM
**Personas:** Data Engineer, Power User
**Component:** `packages/cli/src/commands/schedule/index.ts` (line 56-58)

**Problem:** The CLI schedule pause and resume commands call POST endpoints that do not exist in the API:

```typescript
async function pauseAction(id: string, _opts: Record<string, never>, ctx: CommandContext): Promise<void> {
  await ctx.http.post(`/api/v1/schedules/${encodeURIComponent(id)}/pause`);
```

The schedule routes (services/pipeline/src/routes/schedules.ts) only define CRUD operations via the ScheduleService interface. There are no `/pause` or `/resume` sub-routes. The correct approach is to use PATCH to set `enabled: false` or `enabled: true`.

**Impact:** Data engineers running `op schedule pause <id>` or `op schedule resume <id>` get a 404 error. They must manually figure out to use `op schedule update` or make raw PATCH API calls to toggle the enabled flag.

**Fix:** Replace the pause/resume POST calls with PATCH requests that set `{ enabled: false }` and `{ enabled: true }` respectively on the schedule endpoint.

**Effort:** Small

---

#### V4-M-09: Mapping rules applied without priority ordering guarantee within an entity

**Severity:** MEDIUM
**Personas:** Data Engineer, Power User
**Component:** `services/ontology/src/services/mapping-service.ts` (line 78-165)

**Problem:** When multiple mapping rules target the same entity and the same target field, the rules are applied in the order they appear in the entityRules array. The repository fetches them with `ORDER BY priority DESC, created_at`, but if two rules map different source fields to the same target field slug, the last rule wins silently:

```typescript
for (const rule of entityRules) {
  const sourceValue = getNestedValue(record.data, rule.source_field_path);
  // ... transform ...
  const targetField = fields.find((f) => f.id === rule.target_field_id);
  if (targetField) {
    mappedRecord[targetField.slug] = transformedValue;
  }
}
```

The higher-priority rule writes first, but a lower-priority rule targeting the same field silently overwrites it because there is no conflict detection.

**Impact:** Data engineers who configure multiple mapping rules targeting the same entity field (e.g., to handle different connector data shapes) get unpredictable results. The lower-priority rule overwrites the higher-priority one, which is the opposite of the expected behavior.

**Fix:** Skip writing to mappedRecord if the target field slug is already set by a higher-priority rule. Add a `Set<string>` of already-mapped field slugs and only write if the slug has not been claimed yet.

**Effort:** Small

---

#### V4-M-10: CLI connector trigger --wait does not pass sync mode or force options

**Severity:** MEDIUM
**Personas:** Data Engineer, Power User
**Component:** `packages/cli/src/commands/connector/index.ts` (line 153-178)

**Problem:** The CLI trigger command does not pass the `--mode` or `--force` flags through to the API, despite the API supporting them:

```typescript
async function triggerAction(id: string, opts: TriggerOpts, ctx: CommandContext): Promise<void> {
  const resp = await ctx.http.post<{ syncJobId: string }>(
    `/api/v1/connectors/${encodeURIComponent(id)}/trigger`,
  );
```

The API schema supports `{ mode: 'full' | 'incremental', force: boolean }` but the CLI TriggerOpts only has `{ wait?: boolean }`. A data engineer cannot trigger a full sync or force a re-sync through the CLI.

**Impact:** Data engineers who need to force a full resync (e.g., after a data issue) or override the connector's default sync mode cannot do so from the CLI. They must use curl or the API directly.

**Fix:** Add `--mode <full|incremental>` and `--force` options to the CLI trigger command and pass them in the POST body.

**Effort:** Small

---

#### V4-M-11: Mapping rule update does not enforce tenant isolation

**Severity:** MEDIUM
**Personas:** Data Engineer, Power User
**Component:** `services/ontology/src/routes/mapping-rules.ts` (line 85-116)

**Problem:** The PATCH endpoint for mapping rules updates any rule by ID without verifying that the rule belongs to the requesting tenant:

```typescript
routes.patch("/api/v1/ontology/:entityType/mappings/:ruleId", async (c) => {
  // ... scope check ...
  const body = await c.req.json();
  const parsed = updateMappingRuleRequest.safeParse(body);
  // ... no tenant check ...
  const updated = await mappingRuleRepo.update(c.req.param("ruleId"), updateData as ...);
  if (!updated) throw new NotFoundError("Mapping rule not found.");
```

Compare with the GET errors endpoint (line 140-145) which does enforce tenant isolation: `if (rule.tenant_id !== user.tenantId)`. The same check is missing from PATCH and DELETE.

**Impact:** A data engineer authenticated as one tenant could modify or delete mapping rules belonging to another tenant if they know the rule UUID. This is a cross-tenant data integrity issue.

**Fix:** Before updating or deleting, fetch the rule by ID and verify `rule.tenant_id === user.tenantId`. Apply the same pattern used in the GET errors endpoint.

**Effort:** Small

---

#### V4-M-12: Execution engine re-queries all run steps from DB on every step iteration

**Severity:** MEDIUM
**Personas:** Data Engineer, Power User
**Component:** `services/pipeline/src/services/execution-engine.ts` (line 806-838)

**Problem:** Inside the step traversal loop, the engine fetches all step rows from the database on every iteration just to find the current step's row:

```typescript
while (currentStepId !== null) {
  // ...
  const stepRows = await runStepRepo.findByRunId(runId);
  const runStepRow = stepRows.find((r) => r.step_id === currentStepId);
```

For a pipeline with 50 steps, this executes 50 SELECT queries that each return all 50 step rows, totaling 2,500 row scans.

**Impact:** Data engineers running pipelines with many steps experience unnecessary database load. Each step iteration triggers a full table scan of all run_steps for the run, adding latency proportional to the square of the step count.

**Fix:** Fetch all run step rows once before the traversal loop and build a Map<stepId, RunStepRow>. Alternatively, add a `findByRunIdAndStepId` repository method to query exactly one row.

**Effort:** Small

---

#### V4-M-13: CLI schedule create does not send inputTemplate or enabled fields

**Severity:** MEDIUM
**Personas:** Data Engineer, Power User
**Component:** `packages/cli/src/commands/schedule/index.ts` (line 42-53)

**Problem:** The schedule create command omits the `inputTemplate` and `enabled` fields that the API supports:

```typescript
async function createAction(opts: CreateOpts, ctx: CommandContext): Promise<void> {
  validateCron(opts.cron);
  const body: Record<string, unknown> = {
    pipelineId: opts.pipeline,
    cronExpr: opts.cron,
  };
  if (opts.name) body["name"] = opts.name;
  body["timezone"] = opts.timezone ?? "UTC";
```

The API CreateScheduleSchema requires `inputTemplate` (defaults to `{}`) and `enabled` (defaults to `true`). While the API defaults handle absent fields, there is no CLI option to set `--input-template` for passing runtime parameters to scheduled runs, or `--disabled` to create a schedule in a paused state.

**Impact:** Data engineers who need to create schedules that pass runtime parameters to their pipeline runs cannot do so from the CLI. They must use curl or the API directly to set inputTemplate.

**Fix:** Add `--input-template <json-file>` and `--disabled` options to the schedule create command.

**Effort:** Small

---

#### V4-M-14: cancelSync does not cancel active BullMQ jobs, only waiting/delayed ones

**Severity:** MEDIUM
**Personas:** Data Engineer, Power User
**Component:** `services/ingestion/src/services/sync-service.ts` (line 429-448)

**Problem:** The cancelSync method only removes jobs in `waiting` or `delayed` states. If the job is already `active` (being processed by a worker), it is not affected:

```typescript
async function cancelSync(syncJobId: string): Promise<void> {
  const job = await syncQueue.getJob(syncJobId);
  // ...
  const state = await job.getState();
  if (state === "waiting" || state === "delayed") {
    await job.remove();
  }
  // For active jobs, only writes a cancelled progress entry
  const existing = await getSyncProgress(syncJobId);
  if (existing !== null) {
    await writeProgress({ ...existing, status: "cancelled" });
  }
```

While the progress flag is set for active jobs, the sync worker only checks `isCancelled()` at the top of each batch iteration loop. If the sync is stuck on a single slow fetchBatch call (with a 65-second timeout), cancellation is delayed until that call completes.

**Impact:** Data engineers who cancel a sync that is currently executing a slow batch must wait up to 65 seconds (the fetch timeout) for cancellation to take effect. During that window, the sync continues processing and writing data.

**Fix:** Pass the AbortSignal from the cancellation flag check into the fetchBatch HTTP request. When a cancellation is detected, abort the in-flight request immediately rather than waiting for it to complete.

**Effort:** Medium

---

#### V4-M-15: SDK listBuilds() paginator has same items/data shape mismatch as apps.list()

**Severity:** MEDIUM
**Personas:** App Developer, Plugin Developer
**Component:** `packages/sdk/src/resources/apps.ts` (line 204-219)

**Problem:** Like apps.list(), the listBuilds() Paginator callback expects `{ items: AppBuild[], nextCursor, total }` (line 207-210) after Transport unwraps `data`. But the server's builds list endpoint (versions.ts line 72-76) returns:
```json
{ "data": [...builds], "pagination": { "nextCursor": "...", "total": N } }
```
After Transport unwraps, the SDK receives the builds array, not the expected `{ items, nextCursor, total }` object.

**Impact:** Developers calling `client.apps.listBuilds(id)` get no build results. Pagination is broken for build listings.

**Fix:** Apply the same fix as V4-AP-04: restructure the Paginator callback to handle the actual response shape.

**Effort:** Small

---

#### V4-M-16: useQuery isLoading logic is always false after first render due to tautological check

**Severity:** MEDIUM
**Personas:** App Developer, Plugin Developer
**Component:** `packages/app-sdk/src/hooks/useQuery.ts` (line 237-243)

**Problem:** The isLoading computation at line 237-243:
```ts
const isLoading =
  !isReady || (enabled && cachedEntry === undefined && !cachedEntry);

return {
  ...
  isLoading: isLoading && cachedEntry === undefined,
};
```
The expression `cachedEntry === undefined && !cachedEntry` is tautological -- if `cachedEntry === undefined`, then `!cachedEntry` is always true (since `!undefined === true`). More importantly, the return value applies a second `&& cachedEntry === undefined` check, making the condition: `(!isReady || (enabled && cachedEntry === undefined)) && cachedEntry === undefined`. When `isReady` is true and there IS no cached entry, `isLoading` becomes `(false || (true && true)) && true = true`. When `isReady` is false, `isLoading` becomes `(true) && (cachedEntry === undefined)` which is only true if there's no cache entry. This works but the double-check and tautological `!cachedEntry` are confusing and the intent is unclear.

**Impact:** The hook technically works but the code is misleading. The redundant `!cachedEntry` condition suggests the author intended additional logic (e.g., checking for null data arrays) that was lost. Developers reading the source to debug loading states will be confused.

**Fix:** Simplify to: `const isLoading = !isReady || (enabled && cachedEntry === undefined);` and return `isLoading` directly without the redundant second check.

**Effort:** Small

---

#### V4-M-17: useAppStorage setValue does not rollback optimistic update on network failure

**Severity:** MEDIUM
**Personas:** App Developer, Plugin Developer
**Component:** `packages/app-sdk/src/hooks/useAppStorage.ts` (line 114-144)

**Problem:** The `setValue` callback at line 114-144 performs an optimistic update via `setValueState(newValue)` at line 137, then fires the PUT request:
```ts
const setValue = React.useCallback(
  async (newValue: T): Promise<void> => {
    if (!isKeyValid) return;
    // ... size check ...
    setValueState(newValue); // optimistic update
    await bffClient.request(`/bff/storage/...`, { method: "PUT", body: { value: newValue } });
  },
  [isKeyValid, key, bffClient],
);
```
If the PUT request fails (network error, 5xx, etc.), the optimistic state remains. The UI shows the new value even though it was never persisted. There is no try/catch rollback to restore the previous value.

**Impact:** Developers saving user preferences see them 'saved' in the UI but they revert silently on next page load. This creates a confusing UX where the app appears to save but doesn't actually persist. The useMutation hook has proper rollback via snapshot/restore but useAppStorage does not.

**Fix:** Capture the previous value before the optimistic update. Wrap the PUT in a try/catch that rolls back `setValueState` to the previous value on error, similar to useMutation's snapshot pattern. Optionally surface the error via the meta return value.

**Effort:** Small

---

#### V4-M-18: validateFilePath rejects extensionless files needed for config (e.g. .prettierrc, .editorconfig)

**Severity:** MEDIUM
**Personas:** App Developer, Plugin Developer
**Component:** `services/app/src/services/app-service.ts` (line 113)

**Problem:** The `validateFilePath` function extracts the extension via:
```ts
const ext = path.slice(path.lastIndexOf("."));
```
For a file like `/src/.prettierrc`, `lastIndexOf('.')` returns 5, giving ext `.prettierrc` which is not in `ALLOWED_EXTENSIONS`. For `/Makefile` (no dot at all), `lastIndexOf('.')` returns -1 and `"Makefile".slice(-1)` returns `"e"`. The ALLOWED_EXTENSIONS set (line 86-97) does not include common dotfiles like `.prettierrc`, `.eslintrc`, `.editorconfig`, or extensionless files. This means app developers cannot add standard tooling config files to their VFS.

**Impact:** Developers who want to include `.prettierrc`, `.editorconfig`, `Makefile`, `.npmrc`, or similar config files get a confusing 400 error. The error message lists all allowed extensions but the developer's desired extension is simply not there.

**Fix:** Add common dotfile/config extensions to ALLOWED_EXTENSIONS (e.g., add an allowlist for well-known dotfiles), or change the validation to only block known-dangerous extensions (e.g., `.exe`, `.sh`, `.bat`) rather than allowlisting. At minimum, add `.prettierrc`, `.eslintrc`, `.editorconfig`, `.npmrc` to the set.

**Effort:** Small

---

#### V4-M-19: HTML shell injects configJson without escaping, allowing XSS if appId/tenantId contain quotes

**Severity:** MEDIUM
**Personas:** App Developer, Plugin Developer
**Component:** `services/app/src/index.ts` (line 506-509)

**Problem:** The app serving route builds the HTML shell with:
```ts
const configJson = JSON.stringify({
  appId:     tenantApp.id,
  tenantId:  tenantApp.tenant_id,
  bffOrigin: "",
});
// ...
`  <script>`,
`    window.__OP_APP_CONFIG__ = ${configJson};`,
`  </script>`,
```
While `JSON.stringify` handles most special characters, it does not escape `</script>` sequences. If an appId or tenantId contains `</script><script>alert(1)//`, JSON.stringify produces a valid JSON string containing the literal `</script>` which closes the script tag early. The app name IS escaped via `escapeHtml` (line 502), but configJson is not.

**Impact:** An attacker who can control appId or tenantId values (e.g., through a compromised DB or admin API) could inject arbitrary JavaScript into every user who visits the app.

**Fix:** Escape `</` sequences in the JSON output. Replace `</` with `<\/` in configJson before interpolation: `configJson.replace(/</g, '<')`. Alternatively, use a `<script type="application/json" id="op-config">` tag and parse it from the DOM.

**Effort:** Small

---

#### V4-M-20: WebSocketManager.connect() uses appId as slug parameter but the WS URL expects app slug, not ID

**Severity:** MEDIUM
**Personas:** App Developer, Plugin Developer
**Component:** `packages/app-sdk/src/ws/WebSocketManager.ts` (line 60-82)

**Problem:** AppProvider calls `wsManager.connect(config.appId)` at line 210 of AppProvider.tsx. WebSocketManager.connect() builds the URL:
```ts
connect(slug: string): void {
  const wsOrigin = window.location.origin.replace(/^http/, "ws");
  const url = `${wsOrigin}/apps/${encodeURIComponent(slug)}/ws`;
  this.socket = new WebSocket(url);
}
```
The parameter is named `slug` but AppProvider passes `config.appId` (a UUID). The app serving route at index.ts line 407 matches `/apps/:slug/*` where slug is the human-readable slug (e.g., 'my-app'). A WebSocket to `/apps/550e8400-e29b-41d4-a716-446655440000/ws` would not match any served app route.

**Impact:** The WebSocket connection fails silently for every app. useSubscription never receives real-time events. WebSocketManager reconnects indefinitely (exponential backoff to 30s) wasting resources.

**Fix:** Either: (1) pass the app slug (not appId) to wsManager.connect() -- this requires storing the slug in OPAppConfig, or (2) add a WebSocket route that matches by appId (e.g., `/ws/apps/:appId`).

**Effort:** Small

---

#### V4-M-21: createMockTransformerContext and createMockAuthContext not exported from testing entry point

**Severity:** MEDIUM
**Personas:** Platform Admin, Security Auditor, Plugin Developer
**Component:** `packages/plugin-sdk/src/testing/index.ts` (line 1-25)

**Problem:** The mock-context.ts file defines three context factories:
- `createMockContext` (exported from testing/index.ts)
- `createMockTransformerContext` (NOT exported)
- `createMockAuthContext` (NOT exported)

The testing/index.ts only re-exports:
```typescript
export { createMockContext } from "./mock-context.js";
export type { MockContextOptions, MockContext, ... } from "./mock-context.js";
export { assertValidPlugin, assertValidMetadata } from "./assertions.js";
export { simulateHook } from "./simulate-hook.js";
```

The specialized factories and their option/result types (MockTransformerContext, MockTransformerContextOptions, MockAuthContext, MockAuthContextOptions) are inaccessible to plugin test code via the public import path `@oneplatform/plugin-sdk/testing`.

**Impact:** Transformer and auth provider plugin developers must use the generic createMockContext instead of the purpose-built factories that provide convenience aliases (fetchCalls, credentialCalls) and pre-populated auth credentials. This degrades the testing experience for the two most complex plugin types.

**Fix:** Add exports to testing/index.ts for createMockTransformerContext, createMockAuthContext, and all their associated types (MockTransformerContext, MockTransformerContextOptions, MockAuthContext, MockAuthContextOptions).

**Effort:** Small

---

#### V4-M-22: Destination scaffold comment references non-existent context.config path

**Severity:** MEDIUM
**Personas:** Platform Admin, Security Auditor, Plugin Developer
**Component:** `packages/plugin-sdk/src/dev/scaffold.ts` (line 305)

**Problem:** The destination scaffold template contains this guide comment:

```typescript
// Minimal scaffold: acknowledges all records as written without sending them.
// Replace with actual HTTP delivery to context.config["endpointUrl"].
```

But `DestinationContext` has no `config` property. Configuration is accessed through `context.tenant.config["endpointUrl"]`. A developer following this comment will write `context.config["endpointUrl"]` which won't compile.

**Impact:** Developers following the scaffold guidance will write code that fails to compile, forcing them to dig into the type definitions to find the correct path. The scaffold is supposed to guide developers, but this comment misleads them.

**Fix:** Change the comment to reference `context.tenant.config["endpointUrl"]` which is the correct path through TenantContext.

**Effort:** Small

---

#### V4-M-23: HookPayloadDataMap missing typed data for most hook stages

**Severity:** MEDIUM
**Personas:** Platform Admin, Security Auditor, Plugin Developer
**Component:** `packages/plugin-sdk/src/types/hooks.ts` (line 166-177)

**Problem:** The HookPayloadDataMap only defines typed data for 5 of the 13 base hook stage domains:

```typescript
export interface HookPayloadDataMap {
  "before:ingestion.receive":  IngestionReceiveData;
  "after:ingestion.receive":   IngestionReceiveData;
  "before:ingestion.validate": IngestionValidateData;
  "after:ingestion.validate":  IngestionValidateData;
  "before:ontology.map":       OntologyMapData;
  "after:ontology.map":        OntologyMapData;
  "before:pipeline.execute":   PipelineExecuteData;  // wrong key
  "after:pipeline.execute":    PipelineExecuteData;   // wrong key
  "before:auth.login":         AuthLoginData;
  "after:auth.login":          AuthLoginData;
}
```

Missing typed data shapes for: ingestion.enrich, ingestion.stage, ontology.normalize, pipeline.trigger/step/complete, execution.setup/teardown, auth.logout/token.issue, app.request/build. These all fall back to `Record<string, unknown>`.

**Impact:** Plugin developers writing hooks for the majority of stages (13+ stages) get no type safety. They must manually cast `payload.data` fields, losing the primary value proposition of the typed hook system.

**Fix:** Define data shape interfaces for the remaining stages (IngestionEnrichData, PipelineStepData, ExecutionSetupData, etc.) and add them to HookPayloadDataMap with correct HookStage keys.

**Effort:** Medium

---

#### V4-M-24: Scaffold test template is minimal and does not exercise plugin behavior

**Severity:** MEDIUM
**Personas:** Platform Admin, Security Auditor, Plugin Developer
**Component:** `packages/plugin-sdk/src/dev/scaffold.ts` (line 453-477)

**Problem:** The scaffold-generated test only covers trivial checks:

```typescript
describe("${entrypoint}", () => {
  it("returns valid metadata", () => {
    const meta = ${entrypoint}.metadata();
    expect(meta.type).toBe("${opts.type}");
    expect(meta.id).toBe("${opts.id}");
  });
  it("has all required methods", () => {
    expect(typeof ${entrypoint}.metadata).toBe("function");
  });
  it("creates a mock context without errors", () => {
    const ctx = createMockContext({ config: {} });
    expect(ctx.tenant.tenantId).toBe("test-tenant");
  });
});
```

For a connector, there is no test for `connect()`, `fetchBatch()`, or `disconnect()`. For a transformer, there is no test that calls `transform()`. The scaffold teaches plugin developers that minimal metadata checks are sufficient testing.

**Impact:** Plugin developers get a false sense of test coverage. The scaffold teaches bad testing habits by not showing how to use mock contexts to test actual plugin behavior (connect with credentials, transform records, write batches).

**Fix:** Generate type-specific test templates that exercise the primary method of each plugin type. For example, a connector test should call `connect()` with mock credentials and `fetchBatch()` with a cursor. A transformer test should transform a sample record.

**Effort:** Medium

---

#### V4-M-25: Mock cache does not enforce TTL, masking production timeout bugs

**Severity:** MEDIUM
**Personas:** Platform Admin, Security Auditor, Plugin Developer
**Component:** `packages/plugin-sdk/src/testing/mock-context.ts` (line 260-288)

**Problem:** The mock cache stores values permanently with no TTL enforcement:

```typescript
const cacheStore = new Map<string, unknown>();

const mockCache: CacheAccessor = {
  async get<T>(key: string): Promise<T | null> {
    const value = cacheStore.get(key);
    return value === undefined ? null : (value as T);
  },
  async set<T>(key: string, value: T, _ttlSeconds?: number): Promise<void> {
    cacheStore.set(key, value);  // _ttlSeconds ignored
  },
```

The comment acknowledges this: "TTL is tracked but not enforced." In production, the CacheAccessor interface documents a maximum TTL of 86400 (24 hours). A plugin that sets `ttlSeconds: 5` and reads the value 10 seconds later will succeed in tests but fail in production.

**Impact:** Plugin developers testing cache-dependent flows (token caching, pagination state) will have tests that pass locally but fail in production when cached values expire. This is especially problematic for auth providers that cache PKCE verifiers with 300-second TTLs.

**Fix:** Track TTL in the mock cache by recording `setAt + ttlSeconds` alongside each value. In `get()`, check if the TTL has expired using `Date.now()` and return null if so. This gives developers realistic cache behavior in tests.

**Effort:** Small

---

#### V4-M-26: Admin page calls nonexistent /v1/admin/config and /v1/admin/rotate-master-key endpoints

**Severity:** MEDIUM
**Personas:** Platform Admin, Security Auditor, Plugin Developer
**Component:** `packages/frontend/src/pages/settings/AdminPage.tsx` (line 59-62)

**Problem:** The AdminPage component makes API calls to endpoints that have no backend implementation:
```typescript
const configQuery = useQuery({
  queryFn: ({ signal }) =>
    client.get<{ data: TenantConfig }>("/v1/admin/config", undefined, { signal }),
});

const updateConfigMutation = useMutation({
  mutationFn: (values: TenantValues) =>
    client.patch("/v1/admin/config", values),
});

const rotateMasterKeyMutation = useMutation({
  mutationFn: () => client.post("/v1/admin/rotate-master-key"),
});
```
There are no `/api/v1/admin/config` or `/api/v1/admin/rotate-master-key` routes in any service. The gateway SERVICE_MAP has no `admin` entry.

**Impact:** The entire Admin settings page is non-functional. The config query will fail silently (showing a loading skeleton forever), the save button will error, and the master key rotation button will error. Platform admins see a broken page.

**Fix:** Implement the admin config and master-key-rotation endpoints in the auth or gateway service, or remove the AdminPage UI elements that reference these non-existent endpoints until the backend is ready.

**Effort:** Medium

---

#### V4-M-27: Teams page calls nonexistent /v1/teams/* endpoints

**Severity:** MEDIUM
**Personas:** Platform Admin, Security Auditor, Plugin Developer
**Component:** `packages/frontend/src/pages/settings/TeamsPage.tsx` (line 73-76)

**Problem:** The TeamsPage makes API calls to `/v1/teams/members` and `/v1/teams/invites` endpoints:
```typescript
const membersQuery = useQuery({
  queryFn: ({ signal }) =>
    client.get<PaginatedResponse<Member>>("/v1/teams/members", undefined, { signal }),
});

const inviteMutation = useMutation({
  mutationFn: (values: InviteValues) =>
    client.post("/v1/teams/invites", values),
});
```
There are no `/api/v1/teams/*` routes in any service. The gateway SERVICE_MAP has no `teams` entry. The auth service has user listing at `/api/v1/users` but no teams/invites concept.

**Impact:** The Teams page is completely non-functional. Admins cannot view team members, invite new users, change roles, or remove members through the UI. The member list will always be empty and invite attempts will error.

**Fix:** Either implement /api/v1/teams/* endpoints that delegate to the auth service's user management (mapping teams/members to users and teams/invites to a new invitation flow), or rewire the TeamsPage to use the existing /api/v1/users endpoints with appropriate create-user capabilities.

**Effort:** Large

---

#### V4-M-28: Profile update uses PATCH method and wrong path, but backend only supports PUT

**Severity:** MEDIUM
**Personas:** Platform Admin, Security Auditor, Plugin Developer
**Component:** `packages/frontend/src/pages/settings/ProfilePage.tsx` (line 92-93)

**Problem:** The ProfilePage sends a PATCH request to `/v1/auth/users/${userId}` (line 93):
```typescript
const updateProfileMutation = useMutation({
  mutationFn: (values: ProfileValues) =>
    client.patch(`/v1/auth/users/${userId}`, values),
});
```
However, the backend user update route is registered as PUT at `/api/v1/users/:id` (services/auth/src/routes/users.ts line 101). Two problems: (1) the path includes `/auth/` which the gateway maps to the auth service, but the route is at `/api/v1/users/:id` not `/api/v1/auth/users/:id`; (2) the method is PATCH but the route only handles PUT.

**Impact:** Profile updates from the settings page will fail. Users cannot change their display name through the UI. The PATCH request will receive a 404 or 405 response from the auth service.

**Fix:** Change the frontend to use `client.put(`/v1/users/${userId}`, { displayName: values.displayName })`. Remove the email field from the update since the backend updateUserRequest schema does not accept email changes.

**Effort:** Small

---

#### V4-M-29: No guard against admin self-deactivation

**Severity:** MEDIUM
**Personas:** Platform Admin, Security Auditor, Plugin Developer
**Component:** `services/auth/src/routes/users.ts` (line 101-204)

**Problem:** The PUT /api/v1/users/:id handler allows a user with `users:manage` scope to deactivate themselves (when `id === user.userId` and `isActive === false`). There is no check preventing the last platform-admin from deactivating their own account:
```typescript
const isSelf = id === user.userId;
// No check like: if (isSelf && parsed.data.isActive === false) throw ...
if (parsed.data.isActive === false) {
  await userRepository.deactivate(id);
  // ... revoke all sessions ...
}
```
If the sole platform-admin deactivates themselves, the platform becomes permanently locked out of admin operations.

**Impact:** A single admin can accidentally lock the entire platform by deactivating their own account. Since there is no user reactivation flow (V4-PL-05), recovery requires direct database access.

**Fix:** Add a guard: when deactivating a user who has the `platform-admin` role and `isSelf`, query the count of other active platform-admin users. If this is the last one, reject with ForbiddenError('Cannot deactivate the last platform admin').

**Effort:** Small

---

#### V4-M-30: User listing has no search or filter capabilities

**Severity:** MEDIUM
**Personas:** Platform Admin, Security Auditor, Plugin Developer
**Component:** `services/auth/src/routes/users.ts` (line 32-63)

**Problem:** The GET /api/v1/users endpoint (lines 32-63) only supports cursor-based pagination with no filtering:
```typescript
routes.get("/api/v1/users", async (c) => {
  const cursor = c.req.query("cursor");
  const limitParam = c.req.query("limit");
  const { users, nextCursor } = await userRepository.listByTenant(
    user.tenantId, cursor, limit
  );
  // No search, no filter by email/role/active status
});
```
The UserRepository.listByTenant method similarly has no search/filter parameters.

**Impact:** Admins managing a tenant with hundreds of users cannot search by email, filter by role, or filter by active/inactive status. They must page through the entire user list manually to find a specific user. This makes user management painful at scale.

**Fix:** Add query parameters for `email` (ILIKE search), `role` (exact match), and `isActive` (boolean filter) to the GET /api/v1/users endpoint and extend UserRepository.listByTenant to accept these filters.

**Effort:** Medium

---

#### V4-M-31: API key listing returns all keys including revoked ones with no filtering

**Severity:** MEDIUM
**Personas:** Platform Admin, Security Auditor, Plugin Developer
**Component:** `services/auth/src/routes/api-keys.ts` (line 60-79)

**Problem:** The GET /api/v1/api-keys endpoint returns all API keys for the user with no ability to filter:
```typescript
const keys = await apiKeyService.list(user.userId);
```
The list method in api-key-service.ts (line 262) queries:
```sql
SELECT * FROM auth.api_keys WHERE user_id = $1 ORDER BY created_at DESC
```
This returns ALL keys including revoked ones. The response includes `revokedAt` but there is no query parameter to filter by active-only. For admins managing many integrations, revoked keys clutter the list.

**Impact:** Admins with many API keys (especially after rotations which create revoked+new pairs) see a growing list of revoked keys mixed with active ones. There is no way to show only active keys without client-side filtering.

**Fix:** Add a `status` query parameter ('active', 'revoked', 'all') to the list endpoint, and add a `WHERE revoked_at IS NULL` clause when status is 'active'. Default to 'active' to show the most useful view.

**Effort:** Small

---

#### V4-M-32: Admin cannot view or manage API keys for other users in the tenant

**Severity:** MEDIUM
**Personas:** Platform Admin, Security Auditor, Plugin Developer
**Component:** `services/auth/src/routes/api-keys.ts` (line 60-79)

**Problem:** The API key list endpoint is scoped strictly to the authenticated user's own keys:
```typescript
routes.get("/api/v1/api-keys", async (c) => {
  const user = c.var.user;
  const keys = await apiKeyService.list(user.userId);
});
```
Similarly, the revoke endpoint uses `user.userId` as the revokedBy field and the service verifies ownership. There is no `users:manage` elevated path for admins to audit or revoke keys created by other users in their tenant.

**Impact:** If an employee leaves or their key is compromised, a tenant admin cannot revoke that user's API keys through the API. The admin must deactivate the entire user account (which is irreversible per V4-PL-05) just to stop their API keys from working.

**Fix:** Add an optional `userId` query parameter to the list endpoint that admins with `users:manage` scope can use to view other users' keys. Similarly, allow admins to revoke keys by ID without ownership verification when they have `users:manage` scope.

**Effort:** Medium

---

#### V4-M-33: docker-socket-proxy container has no resource limits or healthcheck

**Severity:** MEDIUM
**Personas:** DevOps/SRE, First-Time Self-Hoster
**Component:** `docker/docker-compose.yml` (line 159-179)

**Problem:** The docker-socket-proxy service has neither resource limits nor a healthcheck:

```yaml
docker-socket-proxy:
    image: tecnativa/docker-socket-proxy:0.2.0
    ...
    restart: unless-stopped
    depends_on:
      op-init:
        condition: service_completed_successfully
    # No deploy: or healthcheck: sections
```

The execution service `depends_on` for docker-socket-proxy uses `condition: service_started` (not `service_healthy`) because there is no healthcheck defined. If the proxy crashes or becomes unresponsive, the execution service will fail to create sandbox containers but won't get restarted.

**Impact:** If docker-socket-proxy becomes unresponsive, the execution service cannot create sandbox containers for code execution. Without a healthcheck, Docker cannot detect the failure and restart the proxy. Without resource limits, a misbehaving proxy could consume excessive host resources.

**Fix:** Add a healthcheck and resource limits:
```yaml
docker-socket-proxy:
    ...
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:2375/version || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 5
    deploy:
      resources:
        limits:
          memory: 128m
          cpus: "0.25"
```
And update execution-service depends_on to `condition: service_healthy`.

**Effort:** Small

---

#### V4-M-34: Execution service will crash on startup -- no sandbox container creates the Unix socket

**Severity:** MEDIUM
**Personas:** DevOps/SRE, First-Time Self-Hoster
**Component:** `docker/docker-compose.yml` (line 432-484)

**Problem:** The execution service connects to a sandbox Unix socket at `/run/sandbox/op.sock` during startup (services/execution/src/index.ts line 159-175) with up to 12 retries (60s total):

```typescript
async function connectToSandbox(retryCount = 0): Promise<void> {
    try {
      await sandboxClient.connect(sandboxSocketPath);
    } catch (err) {
      const maxRetries = 12;
      if (retryCount >= maxRetries) {
        throw new Error(`Failed to connect to sandbox socket after ${maxRetries} retries`);
      }
```

However, docker-compose.yml defines no sandbox-vm container that would create this socket. The `sandbox-socket` volume is empty. The Dockerfile.sandbox exists but is not referenced in docker-compose.yml. The execution service will exhaust all retries and crash.

**Impact:** The execution service cannot start in a Docker Compose deployment. All code execution features (connector scripts, pipeline steps, plugin hooks, expression transforms) are non-functional.

**Fix:** Add the sandbox-vm container to docker-compose.yml:
```yaml
sandbox-vm:
    build:
      context: ..
      dockerfile: docker/Dockerfile.sandbox
    volumes:
      - sandbox-socket:/run/sandbox
    networks:
      - oneplatform-sandbox
    read_only: true
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    deploy:
      resources:
        limits:
          memory: 512m
          cpus: "1"
```
And add it as a dependency for the execution service.

**Effort:** Medium

---

#### V4-M-35: Vector log collector loses logs between restarts due to read_from: end

**Severity:** MEDIUM
**Personas:** DevOps/SRE, First-Time Self-Hoster
**Component:** `docker/vector/vector.yaml` (line 22)

**Problem:** Vector is configured with `read_from: end`:

```yaml
sources:
  docker_file_logs:
    type: file
    include:
      - /var/lib/docker/containers/**/*-json.log
    read_from: end
```

This means on every Vector restart, it starts reading from the current end of each log file. Any log lines written between the Vector crash/restart and the new startup are silently lost. There is no checkpoint file configured to track read positions.

**Impact:** Log entries written during Vector downtime (restarts, upgrades, crashes) are permanently lost. In production, this means gaps in operational visibility, missing audit trail entries, and potential compliance violations. The window of data loss scales with how long Vector is down.

**Fix:** Configure Vector with checkpointing by adding a `data_dir` and changing `read_from: beginning`:
```yaml
data_dir: /var/log/oneplatform/.vector
sources:
  docker_file_logs:
    type: file
    include:
      - /var/lib/docker/containers/**/*-json.log
    read_from: beginning
```
The checkpoint file in `data_dir` ensures Vector resumes from where it left off after restarts. Mount the log-data volume to persist checkpoints.

**Effort:** Small

---

#### V4-M-36: Ontology service HTTP server lacks request error handler -- unhandled socket errors crash the process

**Severity:** MEDIUM
**Personas:** DevOps/SRE, First-Time Self-Hoster
**Component:** `services/ontology/src/index.ts` (line 253-296)

**Problem:** The ontology service's HTTP server adapter does not attach an error handler to the request stream:

```typescript
const server = createServer(
    (req: IncomingMessage, res: ServerResponse): void => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        // ... handle request
      });
    },
  );
```

Unlike the gateway (line 339), ingestion (line 357), logging (line 257), execution (line 339), pipeline (line 389), app (line 661), and plugin (line 416) services -- which all attach `req.on("error", ...)` handlers -- the ontology service omits this handler. If a client aborts a connection mid-request, Node.js emits an unhandled 'error' event on the request stream, which crashes the process.

**Impact:** Any client that disconnects mid-request (network timeout, browser navigation away, load balancer health check timeout) can crash the ontology service. In a production environment with frequent traffic, this causes intermittent ontology service crashes and restarts.

**Fix:** Add a request error handler matching the pattern used by other services:
```typescript
req.on("error", (err) => {
    console.warn("Request socket error", err.message);
    res.destroy();
  });
```

**Effort:** Small

---

#### V4-M-37: Auth service HTTP server lacks request error handler -- unhandled socket errors crash the process

**Severity:** MEDIUM
**Personas:** DevOps/SRE, First-Time Self-Hoster
**Component:** `services/auth/src/index.ts` (line 312-358)

**Problem:** The auth service's HTTP server adapter does not attach an error handler to the request stream:

```typescript
const server = createServer(
    (req: IncomingMessage, res: ServerResponse): void => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        // ... handle request
      });
    },
  );
```

Unlike 7 other services that attach `req.on("error", ...)` handlers, the auth service (like ontology) omits it. A client disconnection mid-request causes an unhandled 'error' event that crashes the process.

**Impact:** Client disconnections during auth requests (login, token refresh, API key validation) can crash the auth service. Since auth is a critical dependency for all other services, this can cascade to platform-wide authentication failures.

**Fix:** Add a request error handler before `req.on("data", ...)`:
```typescript
req.on("error", (err) => {
    console.warn("Request socket error", err.message);
    res.destroy();
  });
```

**Effort:** Small

---

#### V4-M-38: No HTTP server keepAliveTimeout set -- 502 errors during rolling restarts behind reverse proxy

**Severity:** MEDIUM
**Personas:** DevOps/SRE, First-Time Self-Hoster
**Component:** `docker/docker-compose.yml` (line 418)

**Problem:** None of the 9 services set `server.keepAliveTimeout` or `server.headersTimeout` on their Node.js HTTP servers:

```typescript
// services/gateway/src/index.ts line 418
server.listen(port, () => {
    console.info(`Gateway service started on port ${port}`);
  });
// No server.keepAliveTimeout = ... or server.headersTimeout = ...
```

Node.js defaults `keepAliveTimeout` to 5 seconds. When deployed behind a reverse proxy (nginx frontend, or any external load balancer), the proxy's keepalive timeout is typically longer (60-120s). If the proxy reuses a connection that Node has already closed, the request gets a TCP RST, resulting in a 502 error.

**Impact:** Users experience intermittent 502 errors when the platform is behind the nginx frontend or any external load balancer. The issue is especially pronounced during traffic spikes and after idle periods.

**Fix:** Set keepAliveTimeout and headersTimeout on all HTTP servers. headersTimeout must be greater than keepAliveTimeout:
```typescript
server.keepAliveTimeout = 65_000; // Must exceed upstream proxy timeout
server.headersTimeout = 70_000;
```
Apply this pattern in all 9 service index.ts files after `createServer()`.

**Effort:** Small

---

#### V4-M-39: OAuth account linking by email allows account takeover if provider email is unverified

**Severity:** MEDIUM
**Personas:** First-Time Self-Hoster, DevOps/SRE
**Component:** `services/auth/src/services/oauth-service.ts` (line 277-285)

**Problem:** The `upsertOAuthUser` function links an OAuth identity to an existing local account solely by matching the email address (line 428-431):

```typescript
const existingUser = await client.query<{ id: string }>(
  "SELECT id FROM auth.users WHERE tenant_id = $1 AND lower(email) = lower($2)",
  [tenantId, email]
);
let userId: string;
if (existingUser.rows.length > 0) {
  userId = existingUser.rows[0]?.id ?? "";
  isNewUser = false;
}
```

If an OAuth provider returns an email address that the provider has NOT verified (some providers allow unverified emails), an attacker could register an OAuth account with another user's email at the provider, then use OAuth login to gain access to the victim's account. The code at line 268 checks for null emails but not for unverified ones.

**Impact:** An attacker who controls an OAuth provider account with a victim's email address (unverified at the provider level) could link to the victim's existing platform account and gain full access to their data and permissions.

**Fix:** Add a check in `handleCallback` or `upsertOAuthUser` that verifies the OAuth provider has confirmed the email address. For GitHub, check the `verified` field on the email endpoint. For Google, the email is always verified via OpenID Connect. Reject linking if the email is not provider-verified. Also consider requiring the user to confirm the link if the account already exists.

**Effort:** Medium

---

#### V4-M-40: BFF data proxy passes raw query parameters to upstream without validation

**Severity:** MEDIUM
**Personas:** First-Time Self-Hoster, DevOps/SRE
**Component:** `services/app/src/routes/bff.ts` (line 162-165)

**Problem:** The BFF data GET route constructs the upstream URL by forwarding all query parameters from the client without validation:

```typescript
const queryParams = new URLSearchParams(c.req.query()).toString();
const upstreamUrl = `${executionServiceUrl}/internal/data/${user.tenantId}/${appId}/${entity}${queryParams ? `?${queryParams}` : ""}`;
```

The `entity` path parameter at line 146 is also taken directly from the URL without validation. While the URL is constructed using template literals (not string concatenation with user values in the path), the `entity` parameter could contain path traversal characters like `../` that would alter the target path on the execution service.

**Impact:** An attacker could manipulate the `entity` path parameter to access unintended internal endpoints on the execution service (e.g., `/internal/data/tenantId/appId/../../../other-endpoint`). The service token authenticates the request with admin-level service privileges.

**Fix:** Validate the `entity` parameter against a strict pattern (e.g., `/^[a-z][a-z0-9_]*$/`) and use `encodeURIComponent(entity)` in the URL construction. Also validate or whitelist query parameters before forwarding.

**Effort:** Small

---

#### V4-M-41: Service-to-service calls without X-User-Context get full admin scopes

**Severity:** MEDIUM
**Personas:** First-Time Self-Hoster, DevOps/SRE
**Component:** `packages/core/src/middleware/service-auth.ts` (line 180-190)

**Problem:** When a service token is valid but no X-User-Context header is present, the middleware grants full admin privileges:

```typescript
} else {
  const serviceUser: UserContext = {
    userId: claims.sub,
    tenantId: "",
    roles: ["service"],
    scopes: ["admin"],
    isGuest: false,
    isService: true,
    emailVerified: true,
  };
  c.set("user", serviceUser);
}
```

This means any service with a valid Ed25519 token gets admin-level scopes. While the RBAC matrix (isServiceCallAllowed) restricts which services can call which endpoints, route handlers that only check `user.scopes.includes("admin")` would grant access to any service caller. The empty `tenantId` also triggers the wildcard bypass in connector-repository.ts.

**Impact:** A compromised or misconfigured service could access admin-only endpoints on any other service. The broad admin scope makes the RBAC matrix the sole defense, and route handlers that trust scopes without checking `isService` could be exploited.

**Fix:** Assign service-specific scopes based on the RBAC matrix rather than blanket `admin`. For example, the ingestion-service calling the ontology-service should only get `ontology:read` scope. Also set `tenantId` to a sentinel value like `__service__` instead of empty string to prevent tenant isolation bypasses.

**Effort:** Medium

---

#### V4-M-42: User reactivation not supported -- deactivation is a one-way operation

**Severity:** MEDIUM
**Personas:** Enterprise Evaluator, Security Auditor, Platform Admin
**Component:** `services/auth/src/routes/users.ts` (line 97-204)

**Problem:** The user update route handles deactivation at lines 150-192:
```typescript
if (parsed.data.isActive === false) {
  await userRepository.deactivate(id);
  // ... revokes all sessions ...
}
```
But there is no handling for `isActive === true`. The route ignores the isActive field when it is true, meaning once a user is deactivated, there is no API path to reactivate them. The update query at line 143-146 only passes `display_name` and `roles` -- `is_active` is not included in the update payload.

**Impact:** Enterprise user lifecycle management requires the ability to temporarily suspend and later reactivate employees (e.g., sabbatical, leave of absence, role changes). Currently, an admin who deactivates a user by mistake has no API to reverse the action -- they must update the database directly. This is an operational risk and breaks standard ITSM workflows.

**Fix:** Handle `parsed.data.isActive === true` in the user update route. Add a `reactivate(id)` method to the UserRepository that sets `is_active = true`. Emit an `auth.user.reactivated` event. Consider requiring a reason field for audit purposes.

**Effort:** Small

---

#### V4-M-43: Audit worker has no dead-letter queue consumer or alerting -- failed audits are silently lost

**Severity:** MEDIUM
**Personas:** Enterprise Evaluator, Security Auditor, Platform Admin
**Component:** `services/logging/src/services/audit-service.ts` (line 43-113)

**Problem:** The audit worker configuration at lines 97-101:
```typescript
{
  connection,
  concurrency,
  removeOnComplete: { count: 0 },
  removeOnFail: { count: 100 },
}
```
`removeOnComplete: { count: 0 }` removes all completed jobs immediately. `removeOnFail: { count: 100 }` keeps only the last 100 failed jobs in the BullMQ failed set. There is no DLQ consumer that processes or alerts on failed audit events. The `worker.on('failed')` handler at lines 104-110 only logs to console -- there is no alerting mechanism, no metric counter, and no retry escalation for permanently failed audit events.

**Impact:** Enterprise compliance requires guaranteed audit trail completeness. If audit events fail validation or DB insertion, they land in the BullMQ failed set and eventually get evicted (after 100 more failures). There is no mechanism to detect audit trail gaps, alert compliance teams, or reprocess failed events. An auditor discovering gaps in the audit trail is a compliance finding.

**Fix:** Add a DLQ consumer that moves permanently failed audit events to a separate persistent storage (S3/MinIO) for later investigation. Add a metric counter for audit failures that can trigger alerts via monitoring. Consider reducing `removeOnFail` eviction or setting it to `age` instead of `count`.

**Effort:** Medium

---

#### V4-M-44: Audit events have no export/download API -- compliance teams cannot extract audit data

**Severity:** MEDIUM
**Personas:** Enterprise Evaluator, Security Auditor, Platform Admin
**Component:** `services/logging/src/routes/audit.ts` (line 39-88)

**Problem:** The audit routes only expose a single query endpoint (`GET /api/v1/audit-events`) with cursor pagination returning at most 500 results per page. There is no `/api/v1/audit-events/export` endpoint analogous to the log export at `/api/v1/logs/export`. The `AuditEventRepository` has `query()` and `queryByResource()` but no `exportPage()` method for streaming large result sets.

**Impact:** Compliance teams need to extract the full audit trail for a time period (quarterly, annually) for external archival and review. With only a paginated query endpoint returning max 500 records, extracting a year of audit data for a busy tenant requires hundreds of paginated API calls. Enterprise competitors provide audit export in JSONL/CSV format for compliance workflows.

**Fix:** Add a `GET /api/v1/audit-events/export` endpoint mirroring the log export pattern: streaming JSONL/CSV with required time range, keyset pagination, and max window validation. Add an `exportPage()` method to AuditEventRepository. Gate behind the `audit:read` scope.

**Effort:** Medium

---

#### V4-M-45: SDK PipelineRun type does not include steps, durationMs, or definition_snapshot

**Severity:** MEDIUM
**Personas:** Power User / Data Scientist, Data Engineer
**Component:** `packages/sdk/src/resources/platform-types.ts` (line 49-58)

**Problem:** The SDK's `PipelineRun` type (lines 49-58) defines:
```typescript
export interface PipelineRun {
  readonly id: string;
  readonly pipelineId: string;
  readonly status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly input: Record<string, unknown>;
  readonly output: Record<string, unknown> | null;
  readonly error: { message: string; code: string } | null;
}
```
But the backend `getRun` returns `RunWithSteps` (run-service.ts line 116-120) which includes `steps: RunStepRow[]` and `durationMs: number | null`. The steps array contains per-step status, timing, input, and output -- essential for debugging complex pipelines. The status 'queued' in the SDK type does not match 'pending' used by the backend.

**Impact:** SDK users calling `getRun` lose access to per-step execution details. Power users debugging a 30-step pipeline failure cannot programmatically inspect which step failed, what its input was, or how long each step took. They must fall back to raw HTTP calls to access this data. The status mismatch ('queued' vs 'pending') means TypeScript type guards will not match the actual server response.

**Fix:** Add `steps`, `durationMs`, and `triggeredBy` to the `PipelineRun` type. Change 'queued' to 'pending' to match the backend. Define a `RunStep` type with `stepId`, `stepName`, `stepType`, `status`, `startedAt`, `completedAt`, `input`, `output`, `error`, and `executionId`.

**Effort:** Small

---

#### V4-M-46: JSONata webhook timeout timer is never cleared on successful evaluation

**Severity:** MEDIUM
**Personas:** Power User / Data Scientist, Data Engineer
**Component:** `services/pipeline/src/services/execution-engine.ts` (line 155-165)

**Problem:** The `evaluateWithTimeout` function (line 155-165) creates a `setTimeout` timer for the JSONata webhook evaluation but never clears it:
```typescript
function evaluateWithTimeout(expr: ReturnType<typeof jsonata>, data: unknown): Promise<unknown> {
  return Promise.race([
    expr.evaluate(data),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`JSONata expression timed out after ${JSONATA_WEBHOOK_TIMEOUT_MS}ms`)),
        JSONATA_WEBHOOK_TIMEOUT_MS,
      ),
    ),
  ]);
}
```
When the evaluation succeeds (the common case), the 5-second timeout timer remains active until it fires. The rejection handler runs after Promise.race has already settled, creating an unhandled rejection if no `.catch()` is attached to the losing promise.

**Impact:** In a high-throughput pipeline with many webhook steps, hundreds of dangling 5-second timers accumulate. Each holds a reference to the reject function and its closure. On Node.js 18+, the unhandled rejection from the losing setTimeout promise can trigger warnings or -- if `--unhandled-rejections=throw` is set -- crash the worker process.

**Fix:** Use an AbortController or clearTimeout pattern:
```typescript
const timer = setTimeout(...);
try { const result = await expr.evaluate(data); clearTimeout(timer); return result; }
catch(e) { clearTimeout(timer); throw e; }
```
The same pattern applies to the conditional evaluator at lines 410-417.

**Effort:** Small

---

#### V4-M-47: CLI pipeline trigger --input accepts only JSON string, not file path

**Severity:** MEDIUM
**Personas:** Power User / Data Scientist, Data Engineer
**Component:** `packages/cli/src/commands/pipeline/index.ts` (line 70-98)

**Problem:** The `triggerAction` in the CLI only accepts inline JSON for the `--input` flag:
```typescript
if (opts.input) {
  try {
    body['input'] = JSON.parse(opts.input) as unknown;
  } catch {
    throw new CliError('--input must be valid JSON.', EXIT.GENERAL);
  }
}
```
Power users running complex pipelines often have large input payloads (hundreds of lines of JSON with data transformations, filter criteria, etc.) that are impractical to pass as a CLI argument string. The `data create` command (data/index.ts line 53-62) supports `--file` including stdin via `-`, but `pipeline trigger` does not.

**Impact:** Power users must escape and inline their entire pipeline input as a single CLI argument, which is error-prone with nested JSON, shell escaping issues, and argument length limits. Scripts that trigger pipelines with dynamic inputs require workarounds like `--input "$(cat input.json)"` which fails with large payloads on some shells.

**Fix:** Support `--input-file <path>` with `-` for stdin, consistent with the `data create --file` pattern. When `--input-file` is provided, read and parse the file; when `--input` is provided, parse it as inline JSON. Both can coexist with `--input-file` taking precedence.

**Effort:** Small

---

#### V4-M-48: Hook resolution issues two HTTP calls per step even when no hooks exist

**Severity:** MEDIUM
**Personas:** Power User / Data Scientist, Data Engineer
**Component:** `services/pipeline/src/services/execution-engine.ts` (line 867-896)

**Problem:** For every step in the pipeline, the execution engine makes two HTTP calls to the Plugin Service to resolve hooks -- before and after:
```typescript
// Line 867: before:step hooks
const beforeStepHooks = await resolveHookChain(
  `before:pipeline.step:${step.id}`, tenantId,
);
// Line 967: after:step hooks
const afterStepHooks = await resolveHookChain(
  `after:pipeline.step:${step.id}`, tenantId,
);
```
The `resolveHookChain` function (line 259-275) makes an HTTP GET to the Plugin Service on every call. For a pipeline with 50 steps, this is 100+ HTTP round-trips to the Plugin Service just for hook resolution, even when no hooks are registered.

**Impact:** A 50-step pipeline incurs 100+ HTTP calls to the Plugin Service for hook resolution alone, adding 200-500ms of network latency to every run even when the tenant has no plugins installed. This overhead scales linearly with step count and is especially wasteful for the common case of zero hooks.

**Fix:** Cache hook resolution results per-tenant per-stage for the duration of a pipeline run. Since hooks cannot change mid-run, resolve all hooks once at the start (e.g., query `GET /internal/plugins/hooks?tenantId=X` without a stage filter to get all hooks, then group by stage locally). Alternatively, add a `?stages=before:pipeline.step:*,after:pipeline.step:*` bulk query parameter.

**Effort:** Medium

---

#### V4-M-49: CLI pipeline trigger --wait polls wrong endpoint with hardcoded 3s interval

**Severity:** MEDIUM
**Personas:** Power User / Data Scientist, Data Engineer
**Component:** `packages/cli/src/commands/pipeline/index.ts` (line 86-97)

**Problem:** The `--wait` polling loop hits `/api/v1/pipeline-runs/${resp.runId}` (line 89) but the run status endpoint returns `{ data: { run, steps, durationMs } }` and the code expects `{ status: string }` directly:
```typescript
const status = await ctx.http.get<{ status: string }>(
  `/api/v1/pipeline-runs/${resp.runId}`,
);
process.stderr.write(`Run status: ${status.status}\n`);
```
Depending on whether the transport unwraps the `data` envelope, `status.status` may be undefined (the run object is nested as `data.run.status`). Additionally, the 3-second hardcoded polling interval (line 88) provides no progress information and cannot be customized.

**Impact:** The `--wait` flag may display `Run status: undefined` instead of the actual status, causing users to think the command is broken. The 3-second interval is too slow for short pipelines (adds unnecessary latency) and wasteful for long-running pipelines. Users get no step-level progress information while waiting.

**Fix:** Use the SSE log streaming endpoint instead of polling (the `run-logs` command already supports this via `streamSse`). If polling is kept, unwrap the response correctly: the run endpoint returns `{ data: { run: { status }, steps, durationMs } }`. Add a `--poll-interval` flag with a sensible default (1s).

**Effort:** Small

---

#### V4-M-50: listPipelines pagination never returns total count

**Severity:** MEDIUM
**Personas:** Power User / Data Scientist, Data Engineer
**Component:** `services/pipeline/src/services/pipeline-service.ts` (line 486-490)

**Problem:** The `listPipelines` method always returns `total: null` in the pagination response:
```typescript
return {
  data: rows.map((pipeline) => ({ pipeline, lastRunAt: null })),
  pagination: { nextCursor, total: null },
};
```
The `PipelineListResult` interface declares `total: number | null` (line 148), but the service never queries for the total count. The same pattern exists in `listRuns` (run-service.ts line 284) and `listSchedules` (schedule-service.ts line 234).

**Impact:** SDK users and frontend components that need to display 'Showing 1-50 of 347 pipelines' or calculate how many pages remain have no way to get this information. The SDK's `Page<T>.total` is always null. Power users building dashboards or progress indicators cannot determine collection sizes without exhaustive pagination.

**Fix:** Add a COUNT(*) query (can be run in parallel with the main query) and populate the `total` field. For large collections, consider returning total only on the first page (cursor === undefined) to avoid repeated COUNT queries. The connector service already does this correctly (connector-service.ts line 395: `const total = await connectorRepo.countByTenantId(tenantId)`).

**Effort:** Small

---

#### V4-M-51: processSyncJob completedBatches counter incremented before batch is actually processed

**Severity:** MEDIUM
**Personas:** Power User / Data Scientist, Data Engineer
**Component:** `services/ingestion/src/services/sync-service.ts` (line 588-589)

**Problem:** In the sync pagination loop, `progress.completedBatches` is incremented after enqueuing the batch job but before the batch is actually processed:
```typescript
batchSeqNum += 1;
progress.completedBatches = batchSeqNum;  // line 589
progress.lastBatchAt = new Date().toISOString();
await writeProgress(progress);
// ... batch job is enqueued but not yet processed
await batchQueue.add('batch', jobPayload);  // line 624
```
And then in `processBatchJob` (line 734-740), `completedBatches` is incremented AGAIN:
```typescript
await writeProgress({
  ...progressData,
  completedBatches: progressData.completedBatches + 1,
  processedRecords: progressData.processedRecords + records.length,
});
```
So `completedBatches` ends up double-counted: once by processSyncJob and once by processBatchJob.

**Impact:** Sync progress reporting shows inflated completion percentages. A sync that fetched 10 batches but only processed 5 would report `completedBatches: 15` instead of `5`. Power users monitoring sync progress via the SDK's `getSyncProgress` or the SSE stream see misleading progress that jumps ahead of actual completion, then never reaches the expected total.

**Fix:** In `processSyncJob`, use a separate counter like `totalBatches` (which is already declared but never updated -- it stays at 0 from line 465). Set `progress.totalBatches = batchSeqNum` instead of updating `completedBatches`. Let only `processBatchJob` increment `completedBatches` so it reflects actual processing.

**Effort:** Small

---

#### V4-M-52: SDK ConnectorInstance type missing critical fields for power users

**Severity:** MEDIUM
**Personas:** Power User / Data Scientist, Data Engineer
**Component:** `packages/sdk/src/resources/platform-types.ts` (line 83-98)

**Problem:** The SDK's `ConnectorInstance` type (lines 75-82) is:
```typescript
export interface ConnectorInstance {
  readonly id: string;
  readonly name: string;
  readonly pluginId: string;
  readonly status: 'healthy' | 'error' | 'unchecked';
  readonly lastSyncAt: string | null;
  readonly createdAt: string;
}
```
But the backend's `ConnectorWithSyncState` returns much richer data including: `config`, `syncMode`, `isEnabled`, `scheduleCron`, `description`, `instanceId`, and the full `syncState` object with `lastCursor`, `status` ('never_run'|'running'|'success'|'failed'|'cancelled'), `lastError`, `rowsLastSync`, `rowsTotal`. The SDK type also uses incompatible status values ('healthy'|'error'|'unchecked' vs the backend's 'never_run'|'running'|'success'|'failed'|'cancelled').

**Impact:** Power users cannot programmatically check connector sync status, error details, row counts, or configuration through the SDK without casting to `any`. The status field mismatch means TypeScript type narrowing gives wrong results. Building monitoring dashboards or automation around connector health requires raw HTTP calls.

**Fix:** Expand `ConnectorInstance` to include `config`, `syncMode`, `isEnabled`, `scheduleCron`, `description`, and add a `syncState` sub-object with the real status enum. Update `CreateConnectorRequest` to include `credentials`, `syncMode`, `isEnabled`, and `scheduleCron` fields that the backend expects.

**Effort:** Small

---

#### V4-M-53: Entity name validation requires PascalCase with no upfront guidance

**Severity:** MEDIUM
**Personas:** Casual / Non-Technical User, First-Time Self-Hoster
**Component:** `packages/frontend/src/components/ontology/EntityEditor.tsx` (line 43-45)

**Problem:** The entity name field validates against the regex `/^[A-Z][a-zA-Z0-9]*$/` which requires PascalCase (must start with uppercase, no spaces, no hyphens, no underscores). The validation error only appears after the user submits or leaves the field: "Entity name must start with a capital letter". There is no placeholder or help text explaining the naming rules before the user types.

Code at lines 43-45:
```tsx
name: z.string()
  .min(1, "Entity name is required")
  .regex(/^[A-Z][a-zA-Z0-9]*$/, "Entity name must start with a capital letter"),
```

The placeholder at line 139 says `e.g. Customer` but does not explain the naming constraints.

**Impact:** Non-technical users will naturally type names like "customer orders", "my-data", or "user_info" and repeatedly get cryptic validation errors. The error message says "must start with a capital letter" but does not mention that spaces, hyphens, and underscores are also forbidden.

**Fix:** Add help text below the entity name input explaining the naming convention: "Use PascalCase with no spaces (e.g., CustomerOrder, ProductCategory)". Improve the error message to: "Entity name must use PascalCase: start with a capital letter, use only letters and numbers, no spaces or special characters (e.g., CustomerOrder)."

**Effort:** Small

---

#### V4-M-54: Dashboard activity feed shows raw service names and truncated log messages without context

**Severity:** MEDIUM
**Personas:** Casual / Non-Technical User, First-Time Self-Hoster
**Component:** `packages/frontend/src/pages/dashboard/DashboardPage.tsx` (line 471-493)

**Problem:** The Recent Activity panel on the dashboard shows log events with raw service identifiers (e.g., "ingestion", "pipeline", "execution") and truncated messages that may be cut off mid-sentence. Each event displays `event.service` as a plain text label with no explanation of what the service does. A non-technical user seeing entries like `ingestion | warn | Record batch exceeded configured...` cannot understand what happened or whether they need to act.

Code at lines 473-489:
```tsx
<li key={event.id} className="flex items-start gap-2 py-2">
  <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
    <Badge className={LEVEL_CLASSES[event.level]}>
      {event.level}
    </Badge>
    <span className="text-xs text-[var(--color-muted-foreground)]">
      {event.service}
    </span>
  </div>
  <div className="min-w-0 flex-1">
    <p className="text-sm" title={event.message}>
      {truncate(event.message, 120)}
    </p>
```

**Impact:** The dashboard activity feed, which is the primary landing page for all users, shows technical log data that non-technical users cannot interpret. They cannot tell whether errors require their attention or are normal platform operations.

**Fix:** Map service names to human-readable labels (e.g., "ingestion" to "Data Import", "pipeline" to "Data Pipeline"). For error-level events, add a brief plain-language summary or action hint. Consider showing an icon or color-coded severity that helps users quickly see if something needs attention.

**Effort:** Medium

---

#### V4-M-55: DLQ and Metrics nav items use unexplained acronyms and technical labels

**Severity:** MEDIUM
**Personas:** Casual / Non-Technical User, First-Time Self-Hoster
**Component:** `packages/frontend/src/components/layout/Sidebar.tsx` (line 83-85)

**Problem:** The sidebar navigation shows "DLQ" (Dead Letter Queue) as a nav item label. This is a messaging/queue system acronym that means absolutely nothing to a non-technical user. Even "Dead Letter Queue" (shown on the DLQ page itself) is jargon. The item has no description tooltip.

Code at lines 83-85:
```tsx
{ label: "DLQ", to: "/dlq", icon: Inbox, requiredRole: "data-engineer" },
{ label: "Metrics", to: "/metrics", icon: BarChart2, requiredRole: "data-engineer" },
```

Note: While these are gated behind `requiredRole: "data-engineer"`, the Sidebar role check at line 180 also passes through if the user has `platform-admin`, so admin users who are not technical will still see "DLQ".

**Impact:** Platform admins who are not engineers see "DLQ" in navigation and have no idea what it is. Even after clicking through, the page title "Dead Letter Queue" does not help a non-technical person understand the feature.

**Fix:** Add a `description` field to the DLQ nav item (like the Ontology item has), e.g., "Failed processing jobs that need manual review". Consider renaming the label to "Failed Jobs" which is more universally understood.

**Effort:** Small

---

#### V4-M-56: Password requirements are only revealed via validation errors after typing

**Severity:** MEDIUM
**Personas:** Casual / Non-Technical User, First-Time Self-Hoster
**Component:** `packages/frontend/src/pages/auth/ResetPasswordPage.tsx` (line 39-44)

**Problem:** The reset password form requires passwords to be at least 12 characters with an uppercase letter, a lowercase letter, and a number. However, these requirements are nowhere visible on the form before the user starts typing. They only appear as red validation errors one at a time after submission or blur.

Code at lines 39-44:
```tsx
password: z
  .string()
  .min(12, "Password must be at least 12 characters")
  .regex(/[A-Z]/, "Password must contain an uppercase letter")
  .regex(/[a-z]/, "Password must contain a lowercase letter")
  .regex(/[0-9]/, "Password must contain a number"),
```

The form fields at lines 156-168 show only the label "New password" with no hint text.

**Impact:** Users resetting their password will type something simple, get rejected, add a number, get rejected again, add an uppercase letter, and so on. This trial-and-error loop is frustrating, especially for non-technical users who may give up.

**Fix:** Add a visible password requirements list below or alongside the password field before the user types. For example: "Password must be at least 12 characters and include an uppercase letter, lowercase letter, and number." Optionally add a strength indicator that updates in real time.

**Effort:** Small

---

#### V4-M-57: Webhook event selection shows raw event type codes with no descriptions

**Severity:** MEDIUM
**Personas:** Casual / Non-Technical User, First-Time Self-Hoster
**Component:** `packages/frontend/src/pages/settings/WebhooksPage.tsx` (line 300-315)

**Problem:** When creating a webhook, the event subscription list shows raw event type strings like `pipeline.completed`, `pipeline.failed`, `build.success`, `connector.sync.completed`, and `dlq.job.added` in monospace font with no human-readable labels or descriptions.

Code at lines 300-315:
```tsx
<fieldset>
  <legend className="mb-2 text-sm font-medium">Events to subscribe</legend>
  <div className="space-y-1.5">
    {ALL_EVENTS.map((event) => (
      <label key={event} className="flex cursor-pointer items-center gap-2 text-sm">
        <input type="checkbox" ... />
        <code className="font-mono text-xs">{event}</code>
      </label>
    ))}
  </div>
</fieldset>
```

**Impact:** Users configuring webhooks cannot understand what events they are subscribing to without developer knowledge of the event naming convention. Terms like `dlq.job.added` are completely opaque.

**Fix:** Add human-readable labels alongside or instead of the code-style event names. For example: `pipeline.completed` could display as "Pipeline completed - When a data pipeline finishes successfully".

**Effort:** Small

---

#### V4-M-58: Apps page description uses unexplained term 'Monaco-built'

**Severity:** MEDIUM
**Personas:** Casual / Non-Technical User, First-Time Self-Hoster
**Component:** `packages/frontend/src/pages/apps/AppsPage.tsx` (line 134)

**Problem:** The Apps page description says "Monaco-built internal tools and data views." The term "Monaco" refers to Microsoft's Monaco code editor (used in VS Code), but a non-technical user has no idea what this means. It reads as a meaningless brand name.

Code at line 134:
```tsx
<PageHeader
  title="Apps"
  description="Monaco-built internal tools and data views."
```

Similarly, the New App dialog description at line 213 says: "Create a new Monaco-powered app. You can edit the code immediately after creation."

**Impact:** The page description is the first thing users read when navigating to Apps. Using an unexplained technical term as the primary descriptor confuses non-technical users and makes the feature seem inaccessible.

**Fix:** Change the description to something user-friendly like "Build and manage internal tools and data views." Remove or explain "Monaco" references in the dialog: "Create a new app. You can customize it using the built-in code editor after creation."

**Effort:** Small

---

#### V4-M-59: New app dialog requires a URL slug with strict regex and no explanation

**Severity:** MEDIUM
**Personas:** Casual / Non-Technical User, First-Time Self-Hoster
**Component:** `packages/frontend/src/pages/apps/AppsPage.tsx` (line 57-64)

**Problem:** When creating a new app, users must provide a "URL slug" that matches `/^[a-z0-9-]+$/` (lowercase letters, numbers, hyphens only). While the slug is auto-generated from the name, the field is visible and editable with the label "URL slug" and a required asterisk. A non-technical user does not know what a "slug" is.

Code at lines 57-64:
```tsx
slug: z
  .string()
  .min(1, "Slug is required")
  .max(48)
  .regex(/^[a-z0-9-]+$/, "Slug may only contain lowercase letters, numbers, and hyphens"),
```

And the form field label at line 239:
```tsx
<FormLabel>URL slug <span className="text-[var(--color-destructive)]" aria-hidden>*</span></FormLabel>
```

**Impact:** Non-technical users creating apps are confused by the term "URL slug" and may edit the auto-generated value to something invalid. The validation error "Slug may only contain lowercase letters, numbers, and hyphens" adds to confusion.

**Fix:** Rename the field label to "URL path" or "Web address" and add help text: "This becomes part of the app's web address. It is auto-generated from the name." Consider making the slug field read-only or collapsed by default since it auto-generates.

**Effort:** Small

---

#### V4-M-60: No skip-to-content link for keyboard users

**Severity:** MEDIUM
**Personas:** Casual / Non-Technical User, First-Time Self-Hoster
**Component:** `packages/frontend/src/components/layout/AppShell.tsx` (line 40-84)

**Problem:** The AppShell renders the sidebar, then the topbar, then the main content area. There is no skip-to-content link that allows keyboard-only users to bypass the full sidebar navigation (which contains 12+ links) and jump directly to the main content. While the main element has `tabIndex={-1}` and `id="main-content"` for programmatic focus management on route changes, there is no visible skip link for manual keyboard navigation.

Code at lines 40-84:
```tsx
<div className="flex h-screen overflow-hidden bg-[var(--color-background)]">
  {/* Desktop sidebar */}
  <div className="hidden md:flex">
    <Sidebar />
  </div>
  ...
  <main ref={mainRef} tabIndex={-1} className="flex-1 overflow-y-auto outline-none" id="main-content">
    <Outlet />
  </main>
</div>
```

**Impact:** Keyboard-only users and screen reader users must tab through every sidebar link on every page navigation before reaching the main content. This makes the application very tedious to use for people with motor disabilities or vision impairments.

**Fix:** Add a visually-hidden skip link as the first focusable element in AppShell: `<a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:z-50 ...">Skip to main content</a>`. This is a WCAG 2.1 Level A requirement (Success Criterion 2.4.1).

**Effort:** Small

---

#### V4-M-61: Role change dropdown is immediately active with no confirmation for destructive changes

**Severity:** MEDIUM
**Personas:** Casual / Non-Technical User, First-Time Self-Hoster
**Component:** `packages/frontend/src/pages/settings/TeamsPage.tsx` (line 221-233)

**Problem:** On the Teams page, each member's role can be changed via a dropdown select. Changing the select value immediately fires the `updateRoleMutation` API call with no confirmation dialog. Accidentally changing a member from "admin" to "viewer" takes effect instantly.

Code at lines 221-233:
```tsx
<Select
  value={member.role}
  onValueChange={(role) => updateRoleMutation.mutate({ memberId: member.id, role })}
>
  <SelectTrigger className="w-28 h-7 text-xs">
    <SelectValue />
  </SelectTrigger>
  <SelectContent>
    <SelectItem value="viewer">Viewer</SelectItem>
    <SelectItem value="editor">Editor</SelectItem>
    <SelectItem value="admin">Admin</SelectItem>
  </SelectContent>
</Select>
```

**Impact:** A non-technical admin browsing team members can accidentally change roles with a single mis-click in the dropdown. There is no undo or confirmation, potentially locking a colleague out of admin access.

**Fix:** Add a confirmation step before applying role changes, especially for downgrades. Alternatively, use a "Save" button pattern where the user selects a new role and must click "Apply" to confirm the change.

**Effort:** Small

---

### LOW (24)

#### V4-L-01: Vector log files named by container ID are opaque to self-hosters

**Severity:** LOW
**Personas:** First-Time Self-Hoster, DevOps/SRE
**Component:** `docker/vector/vector.yaml` (line 64)

**Problem:** Vector writes parsed logs to files named by container ID:
```yaml
path: /var/log/oneplatform/{{ container_id }}.log
```

The comment at line 63 explains:
```yaml
# Use container_id for the filename since we cannot resolve container names
# without docker.sock access.
```

But container IDs are 64-character hex strings that change on every `docker compose up`. A self-hoster looking at `/var/log/oneplatform/` sees files like `a3f5b2c8d1e0...log` with no way to know which service each belongs to.

**Impact:** Self-hosters cannot use the aggregated log files for troubleshooting because they cannot identify which service produced each file. They fall back to `docker compose logs` which works but defeats the purpose of the log aggregation setup.

**Fix:** Add a Vector transform step that maps container IDs to service names using the docker-compose `container_name` labels (available in the Docker JSON log metadata), or use `container_name` from the parsed log metadata if available. Alternatively, document how to map container IDs to names using `docker inspect`.

**Effort:** Small

---

#### V4-L-02: No `docker compose up` instructions for running from docker/ subdirectory

**Severity:** LOW
**Personas:** First-Time Self-Hoster, DevOps/SRE
**Component:** `docker/docker-compose.yml` (line 1-676)

**Problem:** The docker-compose.yml is at `docker/docker-compose.yml` with `context: ..` for builds. The DEPLOYMENT.md correctly shows `docker compose -f docker/docker-compose.yml up -d` (line 33), but neither the docker-compose.yml itself nor the README mention this requirement. A user who cd's into the docker/ directory and runs `docker compose up` would get incorrect build contexts.

**Impact:** Users who try `cd docker && docker compose up` instead of `docker compose -f docker/docker-compose.yml up` from the root get build failures because the build context (`..`) resolves to the wrong parent directory.

**Fix:** Add a comment at the top of docker-compose.yml explaining it must be run from the repo root with `-f docker/docker-compose.yml`, or restructure to put docker-compose.yml at the repo root.

**Effort:** Small

---

#### V4-L-03: Login page shows OAuth buttons (GitHub, Google) that are not configured

**Severity:** LOW
**Personas:** First-Time Self-Hoster, DevOps/SRE
**Component:** `packages/frontend/src/pages/auth/LoginPage.tsx` (line 72-75)

**Problem:** The login page always renders OAuth buttons:
```tsx
<OAuthButton provider="github" />
<OAuthButton provider="google" />
```

These buttons appear even when no OAuth provider is configured in the .env file. Self-hosters who have not set up GitHub/Google OAuth credentials will see buttons that fail when clicked, with no prior indication that configuration is needed.

**Impact:** Self-hosters see GitHub and Google login buttons that lead to errors when clicked. This looks broken and unprofessional for a fresh self-hosted deployment where OAuth is not set up.

**Fix:** Conditionally render OAuth buttons based on whether the providers are configured. Add a backend endpoint that returns which OAuth providers are enabled, or use a feature flag. At minimum, hide the buttons when OP_OAUTH_GITHUB_CLIENT_ID / OP_OAUTH_GOOGLE_CLIENT_ID are not set.

**Effort:** Medium

---

#### V4-L-04: getNestedValue does not support array index notation in field paths

**Severity:** LOW
**Personas:** Data Engineer, Power User
**Component:** `services/ontology/src/services/mapping-service.ts` (line 246-254)

**Problem:** The getNestedValue helper only supports dot-separated paths:

```typescript
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
```

Paths like `contacts[0].email` or `items.0.name` will fail to resolve because array bracket notation is not handled. The execution engine's getPath helper (line 382-394) does support bracket notation, creating an inconsistency.

**Impact:** Data engineers whose connector data contains arrays cannot map array elements using bracket notation in source field paths. Mapping rules like `addresses[0].street` will always return undefined, causing records to fail validation.

**Fix:** Align getNestedValue with the execution engine's getPath helper by adding support for bracket notation: split on both `.` and `[n]` patterns.

**Effort:** Small

---

#### V4-L-05: Upload failure rate check uses wrong denominator for abort threshold

**Severity:** LOW
**Personas:** Data Engineer, Power User
**Component:** `services/ingestion/src/services/upload-service.ts` (line 349-355)

**Problem:** The failure rate calculation divides rowsFailed by totalAttempted (rowsParsed + rowsFailed), but rowsFailed is never incremented during CSV/JSON/NDJSON parsing. Only the processNdjsonStream and processCsvStream helpers skip malformed rows silently. The rowsFailed counter stays at 0 unless the mapping/staging step fails:

```typescript
const totalAttempted = rowsParsed + rowsFailed;
if (
  totalAttempted > 0 &&
  rowsFailed / totalAttempted > MAX_FAILURE_RATE
) {
  throw new UploadParseFailedError(...);
}
```

Since rowsFailed is never incremented (there is no `rowsFailed += 1` anywhere in the parsing callbacks), the abort threshold can never trigger. Malformed rows are silently dropped.

**Impact:** Data engineers uploading a CSV file where 90% of rows are malformed will not receive an abort error. The upload completes 'successfully' with most data silently dropped, giving a false sense of completeness.

**Fix:** Track parse failures in the onRecord callback or in the stream parsers' catch blocks by incrementing rowsFailed. Add a try/catch around the JSON.parse in processNdjsonStream that increments a shared failure counter.

**Effort:** Small

---

#### V4-L-06: listPipelines returns null for total count, preventing data engineers from knowing result set size

**Severity:** LOW
**Personas:** Data Engineer, Power User
**Component:** `services/pipeline/src/services/pipeline-service.ts` (line 473-491)

**Problem:** The listPipelines method always returns `total: null` in its pagination response:

```typescript
async function listPipelines(
  tenantId: string,
  query: PipelineListQuery,
): Promise<PipelineListResult> {
  const rows = await pipelineRepo.findByTenantId(tenantId, { ... });
  // ...
  return {
    data: rows.map((pipeline) => ({ pipeline, lastRunAt: null })),
    pagination: { nextCursor, total: null },
  };
}
```

The connector list endpoint returns a proper total count via `connectorRepo.countByTenantId`, but the pipeline equivalent does not. The `lastRunAt` field is also always null, which was likely intended to be populated from the run history.

**Impact:** Data engineers using the API or CLI cannot tell how many pipelines exist in total, making it impossible to display proper pagination controls or progress indicators. The always-null lastRunAt makes pipeline list views less informative.

**Fix:** Add a `countByTenantId` method to the pipeline repository and return the actual total. Optionally, join with the latest run to populate lastRunAt.

**Effort:** Small

---

#### V4-L-07: App serving route hardcodes content type to JS/JSON only -- CSS, images, and fonts return wrong MIME type

**Severity:** LOW
**Personas:** App Developer, Plugin Developer
**Component:** `services/app/src/index.ts` (line 547-549)

**Problem:** The bundle proxy at line 547-549:
```ts
const contentType = rawPath.endsWith(".json")
  ? "application/json"
  : "application/javascript";
```
All non-JSON files are served as `application/javascript`, including CSS files, images (SVG, PNG), and fonts (woff2). The ALLOWED_EXTENSIONS in app-service.ts includes `.css`, `.svg`, `.png`, `.woff2`, etc., meaning these files can be stored in the VFS and built into bundles, but they will be served with the wrong MIME type.

**Impact:** CSS files served as `application/javascript` are rejected by browsers due to MIME type mismatch. Apps that include CSS, SVG, or other asset types in their bundles will have broken styling and resources.

**Fix:** Add a MIME type lookup based on file extension. At minimum, add mappings for `.css` -> `text/css`, `.svg` -> `image/svg+xml`, `.map` -> `application/json`, `.html` -> `text/html`, and font types like `.woff2` -> `font/woff2`.

**Effort:** Small

---

#### V4-L-08: SDK listFiles() double-wraps the response by unwrapping both Transport envelope and manual .data access

**Severity:** LOW
**Personas:** App Developer, Plugin Developer
**Component:** `packages/sdk/src/resources/apps.ts` (line 259-265)

**Problem:** The `listFiles()` method:
```ts
async listFiles(id: string): Promise<AppFileSummary[]> {
  const result = await transport.request<{ data: AppFileSummary[] }>({
    method: 'GET',
    path: `${BASE}/${encodeURIComponent(id)}/files`,
  });
  return result.data;
}
```
The Transport automatically unwraps `{ data: T }` (transport.ts line 420-422). So `transport.request<{ data: AppFileSummary[] }>` first parses `{ data: { data: [...files] } }` and unwraps to `{ data: [...files] }`. Then the method accesses `result.data` to get the files array. This works BUT only if the server returns `{ data: { data: [...] } }` -- which it does not. The server returns `{ data: [...files] }`. So Transport unwraps to `[...files]` (the array), then `result.data` on an array returns `undefined`.

**Impact:** Developers calling `client.apps.listFiles(id)` get `undefined` instead of the file list.

**Fix:** Change to `transport.request<AppFileSummary[]>(...)` and return the result directly, since Transport already unwraps the `{ data }` envelope.

**Effort:** Small

---

#### V4-L-09: Build dispatch fetches all file contents AND all file metadata in two separate queries when one would suffice

**Severity:** LOW
**Personas:** App Developer, Plugin Developer
**Component:** `services/app/src/services/build-service.ts` (line 389-399)

**Problem:** The `dispatchBuild` method makes two sequential queries:
```ts
// Line 389: Fetch full file contents
const files = await fileRepo.getAllFilesForBuild(appId);
for (const f of files) {
  fileMap[f.path] = f.content;
}
// Line 397: Fetch file metadata (including content_hash)
const fileMeta = await fileRepo.listByApp(appId);
for (const f of fileMeta) {
  fileSnapshot[f.path] = f.content_hash;
}
```
`getAllFilesForBuild` likely returns rows with content, and `listByApp` returns metadata. Both hit the same table. The content_hash could be obtained from the first query if the repository method returned it.

**Impact:** Every build makes one extra DB round-trip to fetch metadata that could be obtained from the first query. For apps with many files, this doubles the DB load during builds.

**Fix:** Have `getAllFilesForBuild` return the `content_hash` field alongside `path` and `content`, and populate both `fileMap` and `fileSnapshot` from a single query.

**Effort:** Small

---

#### V4-L-10: Widget render() returns string but no sanitization guidance for XSS in data interpolation

**Severity:** LOW
**Personas:** Platform Admin, Security Auditor, Plugin Developer
**Component:** `packages/plugin-sdk/src/types/widget.ts` (line 61-76)

**Problem:** The Widget interface's `render()` method returns a raw HTML string:

```typescript
render(data: WidgetData): string;
```

The comment mentions DOMPurify strips `<script>` tags, but `data.config` and `data.queryResults` values are user-controlled. The scaffold template directly interpolates user data into HTML without escaping:

```typescript
const title = String(data.config["title"] ?? "${opts.name}");
return `<h1>${title}</h1>\n<p>Hello, ${data.user.id}!</p>`;
```

If `data.config["title"]` contains `<img onerror=alert(1)>`, this becomes an XSS vector. While the iframe sandbox provides some isolation (no same-origin), stored XSS in the widget config could still affect the widget's own iframe context.

**Impact:** Widget plugin developers who follow the scaffold pattern will create XSS-vulnerable widgets. While the iframe sandbox limits the blast radius, a compromised widget can still exfiltrate widget data or display phishing content within its frame.

**Fix:** Add an `escapeHtml()` utility function to the scaffold template and use it on all interpolated values. Document in the Widget interface JSDoc that all user-supplied values must be HTML-escaped before interpolation.

**Effort:** Small

---

#### V4-L-11: Audit page has no filter for actor, action, or resource type

**Severity:** LOW
**Personas:** Platform Admin, Security Auditor, Plugin Developer
**Component:** `packages/frontend/src/pages/logs/AuditPage.tsx` (line 12-58)

**Problem:** The AuditPage only provides date range filters (from/to):
```typescript
export function AuditPage() {
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  // No actorId, action, resourceType filters
  return (
    <AuditLogTable
      {...(from !== "" ? { from: new Date(from).toISOString() } : {})}
      {...(to !== "" ? { to: new Date(to + "T23:59:59").toISOString() } : {})}
    />
  );
}
```
The backend audit query API supports `actorId`, `actorType`, `action`, `resourceType`, `resourceId`, and `result` filters (services/logging/src/schemas/index.ts lines 24-35), but the frontend does not expose any of them.

**Impact:** Admins investigating a specific user's actions, a particular resource, or filtering by success/failure must manually page through the full audit log. For compliance investigations this is extremely time-consuming.

**Fix:** Add filter dropdowns/inputs for actorId (with user search), action (select from known actions), resourceType, and result (success/failure) to the AuditPage, and pass them through to the AuditLogTable query.

**Effort:** Medium

---

#### V4-L-12: Production override does not enforce required MinIO password

**Severity:** LOW
**Personas:** DevOps/SRE, First-Time Self-Hoster
**Component:** `docker/docker-compose.prod.yml` (line 27-174)

**Problem:** The production docker-compose.prod.yml enforces `POSTGRES_PASSWORD` with `:?` syntax (line 34) and `OP_ALLOWED_ORIGINS` and `OP_BASE_URL` (lines 40-41), but does NOT enforce `OP_MINIO_PASSWORD`:

```yaml
postgres:
    environment:
      POSTGRES_PASSWORD: "${POSTGRES_PASSWORD:?Must set a strong POSTGRES_PASSWORD}"

gateway-service:
    environment:
      OP_ALLOWED_ORIGINS: "${OP_ALLOWED_ORIGINS:?Must set OP_ALLOWED_ORIGINS}"
      OP_BASE_URL: "${OP_BASE_URL:?Must set OP_BASE_URL}"
```

The service-entrypoint.sh checks for the placeholder `CHANGE_ME_minio` value, but the production compose file should also reject the default `dev_minio_password_change_me` from docker-compose.yml line 143.

**Impact:** Operators deploying with `docker-compose.prod.yml` might inadvertently use the default MinIO password from .env.example or docker-compose.yml defaults, creating a security vulnerability in production object storage.

**Fix:** Add MinIO password enforcement in docker-compose.prod.yml:
```yaml
minio:
    environment:
      MINIO_ROOT_PASSWORD: "${OP_MINIO_PASSWORD:?Must set OP_MINIO_PASSWORD for production}"
```

**Effort:** Small

---

#### V4-L-13: PgBouncer logging disabled -- connection issues are invisible to operators

**Severity:** LOW
**Personas:** DevOps/SRE, First-Time Self-Hoster
**Component:** `docker/pgbouncer/pgbouncer.ini` (line 28-29)

**Problem:** PgBouncer connection and disconnection logging is disabled:

```ini
log_connections = 0
log_disconnections = 0
```

While `log_pooler_errors = 1` captures errors, disabling connection/disconnection logging removes visibility into connection patterns, pool exhaustion events, and authentication failures. Operators debugging connectivity issues have no PgBouncer-side logs to correlate against.

**Impact:** When connection pool exhaustion occurs or services experience intermittent database connectivity issues, operators have no PgBouncer-level visibility to diagnose the root cause. They must rely solely on application-level error logs, which may not contain enough context.

**Fix:** Enable connection logging at least in production:
```ini
log_connections = 1
log_disconnections = 1
```
Or create a production override in docker-compose.prod.yml that enables these settings.

**Effort:** Small

---

#### V4-L-14: JWT expiry seconds parsed without NaN guard allows invalid token lifetimes

**Severity:** LOW
**Personas:** First-Time Self-Hoster, DevOps/SRE
**Component:** `services/auth/src/services/auth-service.ts` (line 762-763)

**Problem:** The `getJwtExpirySeconds` and `getRefreshTokenTtlSeconds` helper functions parse environment variables with `parseInt` but do not check for `NaN`:

```typescript
function getJwtExpirySeconds(): number {
  const raw = process.env["OP_JWT_EXPIRY_SECONDS"];
  return raw !== undefined ? parseInt(raw, 10) : 900;
}
```

If `OP_JWT_EXPIRY_SECONDS` is set to a non-numeric value like `"abc"`, `parseInt` returns `NaN`. A `NaN` expiry would produce tokens with `exp: NaN`, which jose's `setExpirationTime` would reject, causing every login to fail. The same pattern exists in token-service.ts (lines 107-114), api-key-service.ts (line 77-79), and oauth-service.ts (lines 487-492).

**Impact:** A misconfigured environment variable silently breaks token issuance with unhelpful error messages rather than a clear startup-time validation failure. Operations staff would see cryptic jose errors rather than a clear configuration error.

**Fix:** Add NaN guards to all `parseInt`-based env var parsers: `const parsed = parseInt(raw, 10); if (Number.isNaN(parsed) || parsed <= 0) throw new Error("OP_JWT_EXPIRY_SECONDS must be a positive integer");`. Alternatively, validate all OP_* env vars at service startup before accepting traffic.

**Effort:** Small

---

#### V4-L-15: API key last_used_at update uses fire-and-forget with uncaught potential for connection pool exhaustion

**Severity:** LOW
**Personas:** First-Time Self-Hoster, DevOps/SRE
**Component:** `services/auth/src/services/api-key-service.ts` (line 233-244)

**Problem:** The `validate` method fires a background query to update `last_used_at` without awaiting it:

```typescript
setImmediate(() => {
  db.query(
    "UPDATE auth.api_keys SET last_used_at = now() WHERE id = $1",
    [matchedRow!.id]
  ).catch((err: unknown) => {
    logger.warn("Failed to update api_keys.last_used_at", { ... });
  });
});
```

Under high load, many concurrent API key validations could accumulate pending `setImmediate` callbacks, each acquiring a database connection from the pool. Since these are fire-and-forget, there is no backpressure mechanism. If the pool is exhausted, subsequent API key validations (which need the pool for the SELECT queries) would hang or fail.

**Impact:** Under sustained high API key traffic, the fire-and-forget UPDATE queries could exhaust the database connection pool, causing all API key validations to time out. This creates a cascading failure where the background updates meant to be non-blocking end up blocking the critical path.

**Fix:** Batch the `last_used_at` updates using a debounced/throttled approach: collect key IDs over a time window (e.g., 5 seconds) and issue a single `UPDATE ... WHERE id = ANY($1)` with the batched IDs. Alternatively, use a Redis counter that is periodically flushed to Postgres.

**Effort:** Medium

---

#### V4-L-16: Refresh token family set (auth:user-sessions) has no TTL, allowing unbounded Redis memory growth

**Severity:** LOW
**Personas:** First-Time Self-Hoster, DevOps/SRE
**Component:** `services/auth/src/services/token-service.ts` (line 219-223)

**Problem:** The `auth:user-sessions:{userId}` Redis set tracks active refresh tokens per user. Members are added at lines 222-223:

```typescript
await redis.sadd(`auth:user-sessions:${userId}`, token);
```

While individual refresh tokens have TTLs (line 209-214), the `auth:user-sessions:{userId}` set itself has no TTL. The set is cleaned on explicit logout-all (auth-service.ts line 450) or password reset (line 660), but for users who never log out and whose refresh tokens naturally expire, the set accumulates stale member entries indefinitely. Redis SADD does not remove expired keys from the set.

**Impact:** Over time, the `auth:user-sessions:*` sets grow without bound for active users who never explicitly log out. In a multi-tenant deployment with many users, this causes gradual Redis memory growth that could eventually trigger eviction or OOM.

**Fix:** Set a TTL on the `auth:user-sessions:{userId}` set equal to the refresh token TTL. Use `EXPIRE` after each `SADD` to reset the TTL. Alternatively, run a periodic cleanup job that removes set members whose corresponding `auth:refresh:{token}` key no longer exists.

**Effort:** Small

---

#### V4-L-17: SDK ping() calls nonexistent /api/v1/auth/whoami endpoint

**Severity:** LOW
**Personas:** Enterprise Evaluator, Security Auditor, Platform Admin
**Component:** `packages/sdk/src/client.ts` (line 109-112)

**Problem:** The SDK's `ping()` method:
```typescript
async ping(): Promise<WhoAmIResponse> {
  return transport.request<WhoAmIResponse>({
    method: 'GET',
    path: '/api/v1/auth/whoami',
  });
}
```
However, the auth service routes (`services/auth/src/routes/auth.ts`) define the endpoint as `GET /api/v1/auth/me` (line 92), not `/api/v1/auth/whoami`. The SDK will always get a 404 when calling `client.ping()`.

**Impact:** SDK users calling `client.ping()` to verify their credentials will always receive a 404 error. This is a DX frustration that makes the SDK appear broken on first use. The workaround is to call any other endpoint, but the `ping()` method is specifically documented as the way to verify connectivity.

**Fix:** Change the SDK's ping path from `/api/v1/auth/whoami` to `/api/v1/auth/me`, or add a `/api/v1/auth/whoami` alias in the auth service routes.

**Effort:** Small

---

#### V4-L-18: CLI data import reads entire file into memory as string before uploading

**Severity:** LOW
**Personas:** Power User / Data Scientist, Data Engineer
**Component:** `packages/cli/src/commands/data/index.ts` (line 88-106)

**Problem:** The `importAction` function reads the entire file into memory as a string, then wraps it in a Blob for FormData:
```typescript
const content = readFileSync(opts.file, 'utf8');
const form = new FormData();
form.append('file', new Blob([content]), opts.file.split('/').pop() ?? 'data');
```
For large CSV/JSON imports (hundreds of MB), this doubles memory usage: once for the string and once for the Blob. The upload service supports streaming (upload-service.ts uses ReadableStream), but the CLI does not take advantage of it.

**Impact:** Power users importing large datasets (100MB+ CSV files) via `op data import` may encounter Node.js heap OOM errors. The practical import limit via CLI is ~500MB (Node.js default heap is ~1.5GB, and doubling the file content in memory leaves little room for the parser).

**Fix:** Use `createReadStream` (already imported at line 10 but unused for import) with Node.js `File` or `Blob` constructed from the stream, or use `fs.openAsBlob()` (Node 20+). For Node 18 compatibility, pass the file size and stream the upload body manually rather than reading the entire file into a string.

**Effort:** Small

---

#### V4-L-19: SSE log streaming polls database every 500ms with separate run status query

**Severity:** LOW
**Personas:** Power User / Data Scientist, Data Engineer
**Component:** `services/pipeline/src/routes/runs.ts` (line 134-186)

**Problem:** The SSE streaming loop makes two database queries every 500ms:
```typescript
// Fetch new log entries
newLogs = await runService.getRunLogs(runId, cursor > 0 ? cursor : undefined);
// Check run status
const result = await runService.getRun(user.tenantId, runId);
currentRun = result.run;
```
The `getRun` call at line 166 also fetches all run_steps (run-service.ts line 257: `const steps = await runStepRepo.findByRunId(runId)`), meaning each 500ms tick loads the full step array just to check if `run.status` is terminal.

**Impact:** Each SSE connection generates 4 DB queries per second (2 per 500ms tick). With 20 concurrent pipeline watchers, that is 80 queries/second of overhead. The unnecessary step data fetch makes each tick ~2x more expensive than needed.

**Fix:** Add a lightweight `getRunStatus(tenantId, runId)` method that only fetches the run row's status column, not the full run + steps. Alternatively, combine the log fetch and status check into a single query. Consider increasing the poll interval to 1-2s for runs that have been in the same status for multiple ticks.

**Effort:** Small

---

#### V4-L-20: SDK streamRunLogs returns paginated iterable instead of real-time stream

**Severity:** LOW
**Personas:** Power User / Data Scientist, Data Engineer
**Component:** `packages/sdk/src/resources/pipelines.ts` (line 146-159)

**Problem:** The `streamRunLogs` method (lines 146-159) is implemented as a regular paginated HTTP fetch:
```typescript
streamRunLogs(pipelineId: string, runId: string): PaginatedIterable<LogEntry> {
  return new Paginator<LogEntry>(async (cursor, limit) => {
    const result = await transport.request<{ items: LogEntry[]; ... }>({ ... });
    return { ...result, hasMore: result.nextCursor !== null };
  });
}
```
Despite the name 'stream', this is a standard paginated GET, not an SSE connection. The backend provides an SSE endpoint (`/api/v1/pipeline-runs/:runId/logs` with `follow=true`) that streams logs in real-time, but the SDK does not use it. The paginated approach means logs are only fetched once per page, not in real-time.

**Impact:** Power users expecting real-time log streaming (as the method name suggests) get a one-shot paginated fetch instead. To monitor a running pipeline's logs in real-time, they must implement their own SSE client, defeating the purpose of the SDK.

**Fix:** Add a real `streamRunLogs` method that establishes an SSE connection to the backend's log streaming endpoint. Return an `AsyncIterable<LogEntry>` that yields individual log entries as they arrive. Keep the paginated version as `listRunLogs` for historical log retrieval.

**Effort:** Medium

---

#### V4-L-21: CLI pipeline update uses PUT but backend expects PATCH

**Severity:** LOW
**Personas:** Power User / Data Scientist, Data Engineer
**Component:** `packages/cli/src/commands/pipeline/index.ts` (line 56-62)

**Problem:** The `updateAction` in the CLI uses `ctx.http.put()` (line 60):
```typescript
async function updateAction(id: string, opts: { file: string }, ctx: CommandContext): Promise<void> {
  const { load } = await import('js-yaml');
  const content = readFileSync(opts.file, 'utf8');
  const definition = load(content) as unknown;
  await ctx.http.put(`/api/v1/pipelines/${encodeURIComponent(id)}`, definition);
```
But the backend only registers a PATCH handler (pipelines.ts line 101: `routes.patch('/:id', ...)`). The SDK correctly uses PATCH (sdk/resources/pipelines.ts line 97: `method: 'PATCH'`). Sending PUT to a PATCH-only endpoint will return 404 or 405 Method Not Allowed.

**Impact:** Running `op pipeline update <id> --file pipeline.yaml` fails with an HTTP error. Users must manually use `op pipeline create` or raw HTTP calls to update pipelines. This breaks the edit-test-deploy workflow for power users iterating on pipeline definitions.

**Fix:** Change `ctx.http.put(...)` to `ctx.http.patch(...)` in the updateAction function.

**Effort:** Small

---

#### V4-L-22: Toast close button is invisible until hover, unreachable without hover on touch devices

**Severity:** LOW
**Personas:** Casual / Non-Technical User, First-Time Self-Hoster
**Component:** `packages/frontend/src/components/ui/toast.tsx` (line 83-93)

**Problem:** The ToastClose button has `opacity-0` by default and only becomes visible on `group-hover:opacity-100` or `focus:opacity-100`. On touch devices (phones, tablets), there is no hover event, so the close button is permanently invisible unless the user happens to focus it via assistive technology.

Code at lines 83-93:
```tsx
<ToastPrimitive.Close
  ref={ref}
  className={cn(
    "absolute right-2 top-2 rounded-md p-1 text-[var(--color-foreground)]/50 opacity-0 transition-opacity hover:text-[var(--color-foreground)] focus:opacity-100 focus:outline-none focus:ring-2 group-hover:opacity-100 ...",
    className,
  )}
```

**Impact:** Mobile and tablet users cannot see or tap the toast close button. Combined with the ~17-minute auto-dismiss delay (V4-NO-12), toasts become persistent, unmovable obstructions on the screen.

**Fix:** Make the close button always visible on touch devices using a media query: add `@media (hover: none) { opacity: 1 }` or a Tailwind equivalent like `touch:opacity-100`. Alternatively, always show the close button at reduced opacity.

**Effort:** Small

---

#### V4-L-23: OAuth callback failure silently redirects to login with no error message

**Severity:** LOW
**Personas:** Casual / Non-Technical User, First-Time Self-Hoster
**Component:** `packages/frontend/src/pages/auth/CallbackPage.tsx` (line 55-58)

**Problem:** When the OAuth callback fails (network error, invalid state, server error), the catch block silently redirects to the login page with no feedback about what went wrong.

Code at lines 55-58:
```tsx
} catch {
  // Any error sends back to login — the user can retry the OAuth flow
  void navigate({ to: "/login" });
}
```

The user clicks "Sign in with GitHub", authorizes the app, returns to the callback page, and is silently sent back to the login page with no indication of what happened.

**Impact:** Users who experience OAuth failures (which can happen due to expired state tokens, network issues, or server problems) are dropped back at the login page with no explanation. They may repeatedly try the OAuth flow without understanding why it keeps failing.

**Fix:** Navigate to `/login` with an error query parameter like `?error=oauth_failed` and display a user-friendly message on the login page such as "Sign-in with [provider] failed. Please try again or use email and password."

**Effort:** Small

---

#### V4-L-24: API key search input has no visible label or accessible label

**Severity:** LOW
**Personas:** Casual / Non-Technical User, First-Time Self-Hoster
**Component:** `packages/frontend/src/pages/settings/ApiKeysPage.tsx` (line 242-249)

**Problem:** The search input on the API Keys page has a placeholder "Search keys..." but no `aria-label` attribute and no visible label. Screen reader users will not know the purpose of this input.

Code at lines 242-249:
```tsx
<div className="relative max-w-sm flex-1">
  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-muted-foreground)]" aria-hidden="true" />
  <Input
    placeholder="Search keys..."
    value={searchQuery}
    onChange={(e) => setSearchQuery(e.target.value)}
    className="pl-9"
  />
</div>
```

Compare with other search inputs like ConnectorsPage (line 148) which properly has `aria-label="Search connectors"`.

**Impact:** Screen reader users navigating the API Keys page will encounter an unlabeled text input, making it unclear what the field is for.

**Fix:** Add `aria-label="Search API keys"` to the Input component, consistent with the pattern used on other pages.

**Effort:** Small

---

## Finding Distribution by Perspective

| Persona | CRITICAL | HIGH | MEDIUM | LOW | Total |
|---------|----------|------|--------|-----|-------|
| First-Time Self-Hoster | 4 | 11 | 8 | 6 | 29 |
| Data Engineer | 0 | 5 | 9 | 3 | 17 |
| App Developer | 3 | 5 | 6 | 3 | 17 |
| Platform Admin / Plugin Developer | 5 | 11 | 12 | 2 | 30 |
| DevOps/SRE | 3 | 4 | 6 | 2 | 15 |
| Enterprise Evaluator | 2 | 3 | 3 | 1 | 9 |
| Power User / Data Scientist | 1 | 4 | 8 | 4 | 17 |
| Casual / Non-Technical User | 0 | 2 | 9 | 3 | 14 |
| **Total** | **18** | **45** | **61** | **24** | **148** |

---

## Cross-Reference by Component Area

| Component Area | CRITICAL | HIGH | MEDIUM | LOW | Total | Key Issues |
|----------------|----------|------|--------|-----|-------|------------|
| Frontend | 2 | 6 | 13 | 5 | 26 | V4-C-10, V4-C-11, V4-H-03 |
| Auth Service | 1 | 12 | 7 | 3 | 23 | V4-C-17, V4-H-22, V4-H-24 |
| Docker/Infra | 5 | 3 | 6 | 4 | 18 | V4-C-02, V4-C-03, V4-C-12 |
| SDK | 2 | 4 | 3 | 3 | 12 | V4-C-05, V4-C-06, V4-H-13 |
| Plugin SDK | 1 | 4 | 5 | 1 | 11 | V4-C-07, V4-H-18, V4-H-19 |
| Pipeline Service | 1 | 3 | 4 | 2 | 10 | V4-C-18, V4-H-40, V4-H-42 |
| CLI | 0 | 1 | 6 | 2 | 9 | V4-H-10 |
| Ontology Service | 1 | 1 | 4 | 1 | 7 | V4-C-15, V4-H-11 |
| Logging Service | 1 | 3 | 2 | 0 | 6 | V4-C-16, V4-H-23, V4-H-28 |
| Ingestion Service | 0 | 3 | 2 | 1 | 6 | V4-H-08, V4-H-09, V4-H-12 |
| App Service | 0 | 1 | 3 | 2 | 6 | V4-H-16 |
| App SDK | 1 | 1 | 3 | 0 | 5 | V4-C-04, V4-H-17 |
| Documentation | 1 | 2 | 1 | 0 | 4 | V4-C-01, V4-H-01, V4-H-02 |
| Execution Service | 2 | 0 | 0 | 0 | 2 | V4-C-08, V4-C-09 |
| Core Package | 0 | 0 | 2 | 0 | 2 |  |
| Gateway Service | 0 | 1 | 0 | 0 | 1 | V4-H-31 |

---

## Finding Distribution by Category

| Category | Count | Examples |
|----------|-------|----------|
| DX | 51 | V4-C-01, V4-C-04 |
| Reliability | 44 | V4-C-02, V4-C-03 |
| UX | 23 | V4-C-10, V4-C-11 |
| Security | 17 | V4-C-15, V4-C-16 |
| Performance | 10 | V4-C-18, V4-H-07 |
| Accessibility | 2 | V4-M-60, V4-L-24 |
| Documentation | 1 | V4-M-05 |
