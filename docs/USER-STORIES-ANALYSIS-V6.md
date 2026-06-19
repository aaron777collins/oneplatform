# OnePlatform User Story Analysis v6

**Date:** 2026-06-19
**Method:** 11-persona adversarial analysis with 206+ total agents
**Previous analyses:** [v1](./USER-STORIES-ANALYSIS.md) (108 points), [v2](./USER-STORIES-ANALYSIS-V2.md) (85 unique, 13 CRITICAL), [v3](./USER-STORIES-ANALYSIS-V3.md) (53 unique, 5 CRITICAL), [v4](./USER-STORIES-ANALYSIS-V4.md) (148 unique, 18 CRITICAL), [v5](./USER-STORIES-ANALYSIS-V5.md) (135 unique, 9 CRITICAL)
**This analysis:** 213 unique findings after deduplication, 14 false positives removed, 13 escalated, 12 downgraded during adversarial verification

---

## Summary Table

| Severity | Count |
|----------|-------|
| CRITICAL | 25    |
| HIGH     | 69    |
| MEDIUM   | 85    |
| LOW      | 34    |
| **Total unique findings** | **213** |

---

## Methodology

This v6 analysis extends the v5 adversarial workflow with an additional persona targeting low-code and drag-and-drop UI users. The process is structured in three phases totaling **206+ agents**:

### Phase 1: Persona Analysis (11 agents)

Eleven distinct persona agents independently analyze the entire OnePlatform codebase. Each agent is configured with a specific user profile, goals, and areas of concern. Each agent produces findings from its vantage point with source code citations.

| Persona | Focus Area |
|---------|------------|
| **First-Time Self-Hoster** | Docker Compose experience, bootstrap flow, first-run errors |
| **Data Engineer** | Connector pipelines, sync reliability, mapping correctness, batch processing |
| **App Developer** | SDK, BFF, build/deploy lifecycle, type safety |
| **Plugin Developer** | Plugin SDK, hook system, sandbox interaction, bundle lifecycle |
| **Platform Admin** | User management, RBAC configuration, tenant operations, monitoring |
| **DevOps/SRE** | Observability, scaling, backup, health checks, container lifecycle |
| **Security Auditor** | Auth flows, token handling, SSRF, injection, secrets management |
| **CLI Power User** | Shell completion, output formats, scripting integration, profile management |
| **SDK Consumer** | Type accuracy, API ergonomics, error handling, pagination |
| **Frontend/UX Reviewer** | UI flows, accessibility, responsive design, error states |
| **Low-Code/Drag-and-Drop UI User** | Visual builder usability, no-code pipeline configuration, form-based setup, technical jargon exposure |

### Phase 2: Deduplication & Classification (2 agents)

Two agents perform independent deduplication and severity classification. Findings from all 11 persona agents are merged -- when multiple personas flag the same root cause, they are consolidated into a single finding. Severity is assigned using the standard rubric.

### Phase 3: Adversarial Verification (193+ agents)

Adversarial verifier agents challenge the findings:
- Each finding is reviewed by at least 2 independent verifiers
- Verifiers attempt to refute findings by examining the cited code, checking for compensating controls, and testing edge cases
- **14 false positives were identified and removed** during this phase
- **13 findings were escalated** to higher severity based on broader impact analysis (e.g., V6-045 MEDIUM->CRITICAL due to cross-tenant data access, V6-087 MEDIUM->HIGH due to design-implementation gap, V6-096 MEDIUM->HIGH due to runtime TypeError on every API key operation)
- **12 findings were downgraded** to lower severity due to compensating controls or overstated impact (e.g., V6-080 MEDIUM->LOW due to gateway header sanitization, V6-091 HIGH->LOW due to per-schedule try-catch isolation, V6-142 MEDIUM->LOW due to Kubernetes default strategy being safe)

### Severity Rubric

| Level | Criteria |
|-------|----------|
| **CRITICAL** | Blocks a core workflow entirely, causes data loss, or creates an exploitable security vulnerability |
| **HIGH** | Significant functionality gap, performance degradation, or security weakness that affects many users |
| **MEDIUM** | Noticeable quality issue, inconsistency, or missing feature that has workarounds |
| **LOW** | Cosmetic issue, minor inconvenience, or improvement opportunity |

---

## Finding Distribution by Category

| Category | Count | CRITICAL | HIGH | MEDIUM | LOW |
|----------|-------|----------|------|--------|-----|
| **Reliability** | 56 | 7 | 18 | 25 | 6 |
| **DX** | 45 | 0 | 8 | 26 | 11 |
| **UX** | 42 | 4 | 11 | 18 | 9 |
| **API** | 31 | 9 | 16 | 5 | 1 |
| **Security** | 24 | 3 | 12 | 6 | 3 |
| **Operations** | 10 | 1 | 2 | 4 | 3 |
| **Data** | 4 | 1 | 2 | 1 | 0 |
| **Performance** | 1 | 0 | 0 | 0 | 1 |

---

## Top 10 Priorities

| # | ID | Finding | Severity | Why It Matters | Effort |
|---|-----|---------|----------|----------------|--------|
| 1 | V6-001 | init-data volume file permissions block all services | CRITICAL | Root-owned 0400 files are unreadable by service UID 1001 -- every service fails on first `docker compose up` | Small |
| 2 | V6-002 | Gateway publicRoutes missing auth endpoints | CRITICAL | All auth endpoints return 401 at the gateway -- users cannot log in after bootstrap | Small |
| 3 | V6-010 | Frontend token refresh sends no body but backend requires refreshToken in JSON body | CRITICAL | Browser-based session refresh always fails -- sessions expire after 15 minutes with no recovery | Small |
| 4 | V6-009 | Logging service log query has no tenant isolation | CRITICAL | Any user with logs:read scope can read log events from ALL tenants -- cross-tenant data exposure | Medium |
| 5 | V6-014 | Gateway Storage Routes cross-tenant data access bypass | CRITICAL | Per-bucket operations skip tenant prefix validation -- any authenticated user can access another tenant's files | Small |
| 6 | V6-015 | Password Reset/Change missing token revocation key in Redis | CRITICAL | Stolen access tokens remain valid for up to 15 minutes after password change | Small |
| 7 | V6-047 | Manifest schema mismatch between SDK and Plugin Service | CRITICAL | No valid hook stage format passes both SDK and service validation -- plugin hook system completely blocked | Medium |
| 8 | V6-013 | Docker Compose default OP_MINIO_PASSWORD rejected by entrypoint | CRITICAL | Every application container crashes on fresh `docker compose up` without custom .env file | Small |
| 9 | V6-019 | gRPC-Web client routes never mounted in gateway | CRITICAL | All gRPC-Web calls 404 -- entire gRPC client non-functional | Small |
| 10 | V6-003 | Auth service publicRoutes missing reset-password and verify-email | CRITICAL | Password reset and email verification return 401 for unauthenticated users | Small |

---

## All Findings

### CRITICAL (25)

| ID | Category | Component | Pain | Fix |
|----|----------|-----------|------|-----|
| V6-001 | Reliability | `docker/init/init.sh:27-165` | The op-init container runs as root and creates all secret files with chmod 0400 (owner-read only, root-owned). Service containers run as UID 1001. When service-entrypoint.sh tries to read these files via read_secret(), it gets 'Permission denied'. Every single service fails to start on first docker compose up | Change chmod 0400 to chmod 0444 for files that all services need to read, or chown them to UID 1001. For db_password_*.txt, ensure postgres user (UID 70) can also read them |
| V6-002 | Reliability | `services/gateway/src/index.ts:341-346` | The gateway's publicRoutes only lists /healthz, /readyz, /api/v1/bootstrap, and /api/v1/bootstrap/*. All auth endpoints (/api/v1/auth/login, /api/v1/auth/register, /api/v1/auth/refresh) are NOT public at the gateway level. The gateway's auth middleware returns 401 before the proxy ever forwards them. After bootstrap, users cannot log in | Add '/api/v1/auth/*' to the gateway's publicRoutes array since the auth service has its own auth middleware internally |
| V6-003 | Reliability | `services/auth/src/index.ts:245-255` | The auth service's publicRoutes does not include '/api/v1/auth/reset-password/:token' or '/api/v1/auth/verify-email/:token'. Both are unauthenticated flows (user clicks link from email while not logged in). The auth middleware returns 401 before the route handler runs | Add '/api/v1/auth/reset-password/:token' and '/api/v1/auth/verify-email/:token' to the publicRoutes array |
| V6-004 | API | `services/ontology/src/services/mapping-service.ts:138-152` | Expression transforms send language='javascript', timeoutMs, memoryLimitMb, and noIo fields, but the execution service expects language='js', 'timeout' (not timeoutMs), required 'type' field, and context with traceId/tenantId. Every expression mapping rule fails Zod validation and silently falls back to the raw source value | Update the fetch call to send { type: 'expression', language: 'js', timeout: 5000, context: { traceId, tenantId } } matching InternalRunRequestSchema |
| V6-005 | API | `packages/cli/src/commands/connector/index.ts:179-188` | The CLI triggerAction polls for status 'completed' but the backend SyncProgress status enum is 'queued'\|'running'\|'success'\|'failed'\|'cancelled'. Status will never equal 'completed' so the CLI poll loop runs until timeout (600s), then throws even though the sync succeeded | Change status check from 'completed' to 'success'. Remove the 'timeout' check since it is not a valid backend status |
| V6-006 | API | `packages/sdk/src/resources/platform-types.ts:131-139` | The SDK SyncJob type defines status as 'pending'\|'running'\|'completed'\|'failed'\|'cancelled' but the backend uses 'queued'\|'running'\|'success'\|'failed'\|'cancelled'. Two values differ: SDK 'pending' vs backend 'queued', SDK 'completed' vs backend 'success'. Any SDK code checking sync status will never match | Update the SyncJob status union to match the backend: change 'pending' to 'queued' and 'completed' to 'success' |
| V6-007 | Reliability | `packages/app-sdk/src/client/BffClient.ts:212-216` | BffClient.request() always calls response.json() but BFF DELETE endpoints return Response(null, { status: 204 }) with no body. When useMutation's remove() deletes an entity, response.json() throws a SyntaxError. Every DELETE operation through the App SDK is broken at runtime | Add a 204 guard before calling response.json(): if (response.status === 204) return undefined as T |
| V6-008 | Reliability | `packages/app-sdk/src/provider/AppProvider.tsx:212` | WebSocketManager.connect() expects a slug but AppProvider passes config.appId (a UUID). Furthermore, the App Service has no WebSocket endpoint. Every useSubscription call fails: WebSocket connects to nonexistent endpoint and triggers infinite reconnect attempts | Either pass the app slug instead of appId and implement the WebSocket endpoint, or resolve the slug from the /bff/me response |
| V6-009 | Security | `services/logging/src/routes/logs.ts:38-75` | GET /api/v1/logs has no tenant isolation. LogQueryParams has no tenantId field, the query builder never adds a WHERE tenant_id clause, and the route handler does not inject the caller's tenantId from the JWT. Any user with logs:read scope can read log events from ALL tenants | Add tenantId to LogQueryParams, inject user.tenantId from the JWT, add WHERE tenant_id = $N clause. Non-admin callers must be scoped to their own tenant |
| V6-010 | API | `services/auth/src/routes/auth.ts:199-212` | The frontend's apiFetch calls POST /api/v1/auth/refresh with no JSON body (only credentials: 'include' for cookies). The auth route parses via c.req.json() and validates with refreshRequest.safeParse requiring a refreshToken string field. The login route sets the refresh token as an HttpOnly cookie but the refresh endpoint only reads from JSON body. Every browser-based token refresh fails | The refresh route must also read the refresh token from the op_refresh_token cookie when the JSON body is absent |
| V6-011 | Reliability | `packages/core/src/middleware/otel.ts:136` | The otelMiddleware only writes span JSON to stdout via process.stdout.write(). It never sends spans to the OTEL_EXPORTER_OTLP_ENDPOINT. Vector has no Jaeger/OTLP sink. Zero spans reach Jaeger, so all Grafana alert rule groups evaluate against empty data and never fire. The entire observability alerting stack is non-functional | Add an OTLP HTTP exporter that POSTs spans to OTEL_EXPORTER_OTLP_ENDPOINT, or add a Vector transform that forwards spans to Jaeger |
| V6-012 | Operations | `deploy/helm/oneplatform/templates/_helpers.tpl:217-287` | The commonEnv helper does not inject EXECUTION_SERVICE_URL, PLUGIN_SERVICE_URL, INGESTION_SERVICE_URL, PIPELINE_SERVICE_URL, or AUTH_SERVICE_URL. Only gateway.yaml manually pulls these. All other services fall back to hardcoded defaults using wrong ports. Every inter-service call from a non-gateway service fails with connection refused | Add the cross-service URL env vars to the commonEnv helper, sourcing from the ConfigMap |
| V6-013 | Reliability | `docker/docker-compose.yml:259` | docker-compose.yml sets OP_MINIO_PASSWORD to 'dev_minio_password_change_me' as default, but service-entrypoint.sh explicitly rejects this exact string and exits with FATAL. Every application service container crashes immediately on fresh 'docker compose up' without a custom .env file | Change the default to 'oneplatform_minio_dev_2024' (the value allowed by the entrypoint guard), or remove the rejection |
| V6-014 | Security | `services/gateway/src/routes/storage.ts:63-236` | The listBuckets endpoint filters by tenant prefix, but all per-bucket operations (listObjects, getObjectMetadata, deleteObject, generatePresignedDownloadUrl) do NOT validate that the bucket name starts with the authenticated user's tenant prefix. Any authenticated user can access another tenant's bucket | Add a tenant-prefix check at the top of every per-bucket route handler: verify bucket starts with `${user.tenantId}-` |
| V6-015 | Security | `services/auth/src/services/auth-service.ts:579-761` | Both resetPassword and changePassword revoke DB sessions and delete refresh tokens from Redis, but neither sets the 'revocation:user:{userId}' Redis key. The auth middleware checks this key to reject active access tokens. Without it, all previously-issued access tokens remain valid until natural expiry (up to 15 minutes) | After revoking sessions, add: await redis.set('revocation:user:' + userId, '1', 'EX', jwtExpirySeconds) |
| V6-016 | API | `packages/sdk/src/resources/events.ts:44` | The SDK builds the SSE subscription URL as /api/v1/events/subscribe but the gateway mounts the SSE route at GET /api/v1/events. Every call to client.events.subscribe() gets a 404, making the entire real-time event system non-functional via the SDK | Change the path from '/api/v1/events/subscribe' to '/api/v1/events' |
| V6-017 | API | `packages/sdk/src/subscriptions/sse-subscriber.ts:139-153` | The SDK sends event patterns as repeated query params via searchParams.append('events', event) producing ?events=pattern1&events=pattern2. The gateway expects 'events' as a single comma-separated string. Hono's c.req.query() returns only the last value, so all but the last event pattern are silently dropped | Change buildSseUrl() to join patterns with commas: searchParams.set('events', options.events.join(',')) |
| V6-018 | API | `packages/sdk/src/resources/logs.ts:112` | The SDK sends audit queries to /api/v1/logs/audit but the logging service defines the audit endpoint at GET /api/v1/audit-events. SDK audit queries 404 or are proxied to the wrong handler | Change the path from '/api/v1/logs/audit' to '/api/v1/audit-events' |
| V6-019 | API | `packages/sdk/src/grpc-client.ts:466-519` | The SDK exports createGrpcClient() which sends requests to /grpc/oneplatform.v1.DataService/*. The gateway has grpc-web-handler.ts but it is never imported or mounted in gateway/src/index.ts. All gRPC-Web calls 404, making the entire gRPC client non-functional | Import createGrpcWebHandler in gateway/src/index.ts and mount it: app.route('/grpc', grpcWebRoutes) |
| V6-045 | Data | `services/logging/src/repositories/log-event-repository.ts:172-181` | findById omits tenant_id from SELECT clause, causing undefined tenantId in API response. Additionally, no tenant isolation check on single-event fetch, so any user with logs:read can fetch any log event by ID across tenants. Cross-tenant data access via direct ID enumeration | Add tenant_id to the SELECT clause. Add tenant isolation via tenantId parameter and WHERE tenant_id = $2 clause |
| V6-047 | API | `packages/plugin-sdk/src/manifest/schema.ts:17-28` | SDK manifest schema uses z.enum of legacy hook stage names ('pre-ingest', 'post-ingest'), while service-side schema uses the new timing:domain.event regex pattern. SDK's own types define HookStage as "before:ingestion.receive" etc., contradicting the manifest schema. No valid stage format passes BOTH schemas -- impossible to build AND install a plugin with hooks | Update the HookDeclarationZ stage in the SDK to use the same regex pattern as the service-side schema |
| V6-200 | UX | `packages/frontend/src/components/pipeline-editor/NodeConfigPanel.tsx:559-646` | Transform step requires users to type raw JSON in a textarea for parameters. Placeholder shows JSON syntax. No visual form for filter/aggregate/sort operations -- completely inaccessible to non-technical users | Replace raw JSON textarea with dynamic visual form based on selected operation type |
| V6-201 | UX | `packages/frontend/src/pages/pipelines/PipelineBuilderPage.tsx:178-188` | Scheduled trigger requires raw cron expression (e.g. '0 2 * * *') with no visual schedule builder, no presets, no human-readable preview. Non-technical users cannot configure pipeline schedules | Add visual schedule builder with presets (hourly, daily, weekly, monthly) and custom interval picker |
| V6-202 | UX | `packages/frontend/src/components/pipeline-editor/NodeConfigPanel.tsx:244-312` | Conditional step requires raw dot-notation field paths, raw UUID step IDs, and uses code-style operator labels (eq, neq, gte, lte) instead of human-readable text. Unusable without developer knowledge | Replace with field picker, step dropdown, and human-readable operator labels ('equals', 'is greater than') |
| V6-203 | UX | `packages/frontend/src/components/pipeline-editor/NodeConfigPanel.tsx:183-238` | Code step type embeds full Monaco editor expecting TypeScript/Python/Go code. No template-based alternative for non-coders. Completely blocks low-code users from using code steps | Offer template mode with pre-built code templates selectable via form, keep Monaco as Advanced toggle |

---

### HIGH (69)

| ID | Category | Component | Pain | Fix |
|----|----------|-----------|------|-----|
| V6-020 | Security | `services/auth/src/services/bootstrap-service.ts:119-136` | GET /api/v1/bootstrap/status returns the bootstrap token in the response body when bootstrap is not yet complete. This endpoint is public. Any unauthenticated caller can obtain the one-time bootstrap token and race to complete bootstrap, hijacking the initial platform setup | Remove the bootstrapToken from the getStatus() response. Require the operator to provide the token from the server filesystem |
| V6-021 | UX | `packages/frontend/src/components/wizard/steps/AdminAccountStep.tsx:31-39` | The frontend validates passwords with min 12 chars, uppercase, lowercase, number. The backend additionally requires a special character. Users pass frontend validation then get a confusing server error | Add .regex(/[^A-Za-z0-9]/, 'Password must contain a special character') to adminAccountSchema |
| V6-022 | DX | `docs/quickstart/platform-admin.md:9-62` | Multiple inaccuracies: says 'Ports 3000 and 8080' but compose exposes 80/443; uses 'docker compose exec op-init' on stopped container; references nonexistent 'op auth bootstrap' CLI command; says 'http://localhost:8080' but actual URL is https://localhost | Rewrite with correct ports, URLs, commands, and bootstrap token extraction |
| V6-023 | Reliability | `docker/postgres/set-passwords.sh:21-40` | The Postgres container runs set-passwords.sh as the postgres user (UID 70), not root. Password files in /data/init/ are root-owned with mode 0400. Service role passwords remain as CHANGE_ME. PgBouncer authenticates with generated passwords but Postgres still has CHANGE_ME. Every service connection through PgBouncer fails | In init.sh, change chmod 0400 to chmod 0444 for db_password_*.txt, or chown to UID 70 |
| V6-024 | Reliability | `docker/caddy/Caddyfile.nossl:12-36` | Caddyfile.nossl (used when OP_TLS_MODE=off) lacks /healthz and /readyz handle blocks. These requests fall through to the catch-all frontend handler and return SPA index.html with 200 OK, masking actual health check failures | Add handle /healthz and handle /readyz blocks with reverse_proxy to gateway-service:3000 |
| V6-025 | Reliability | `services/auth/src/services/bootstrap-service.ts:76-83` | The bootstrapRequest schema allows tenantName as short as 1 character, but the Postgres slug constraint requires minimum 3. A user entering a 1-2 character org name passes validation but fails with raw Postgres constraint violation error | Add .min(3) to the tenantName field in the bootstrap schema |
| V6-026 | API | `packages/cli/src/commands/connector/index.ts:57-63` | The CLI listAction expects a flat array but the backend returns { items, nextCursor, total }. The CLI renders the envelope as a single-row table with columns like 'items' and 'nextCursor' | Extract resp.items and pass to ctx.renderer.render() |
| V6-027 | API | `packages/sdk/src/resources/platform-types.ts:105-112` | The SDK ConnectorInstance type is missing syncMode, scheduleCron, isEnabled, and config fields that the backend returns. SDK users cannot read sync mode, schedule, or enabled state without casting | Add syncMode, scheduleCron, isEnabled, and config to ConnectorInstance |
| V6-028 | API | `packages/sdk/src/resources/platform-types.ts:114-118` | The SDK CreateConnectorRequest only has name, pluginId, and config. Missing credentials, syncMode, isEnabled, and scheduleCron. Users cannot set credentials or schedule when creating connectors | Add credentials, syncMode, isEnabled, and scheduleCron fields |
| V6-029 | API | `packages/sdk/src/resources/platform-types.ts:75` | PipelineStep.type is typed as 'code'\|'connector'\|'transformer'\|'conditional'\|'parallel'\|'webhook' but the execution engine also supports 'transform', 'wait', 'approval', and 'sub_workflow'. SDK users get compile errors for these step types | Add 'transform'\|'wait'\|'approval'\|'sub_workflow' to the type union |
| V6-030 | API | `packages/sdk/src/resources/connectors.ts:127-131` | SDK connector trigger() returns PipelineRun type but the backend returns { syncJobId, status: 'queued' }. The returned object has no PipelineRun fields, so SDK callers accessing result.id get undefined | Create a TriggerSyncResult type and change the return type |
| V6-032 | Reliability | `services/pipeline/src/services/execution-engine.ts:510-515` | evaluateConditional uses Promise.race with a setTimeout for 100ms timeout, but the timer is never cleared when JSONata completes normally. Each conditional step leaks one setTimeout handle, accumulating timer handles that leak memory | Store the timer ID and call clearTimeout in a .finally() block |
| V6-033 | Data | `services/pipeline/src/services/transform-engine.ts:417-418` | The sort function handles null values incorrectly: when both values are null, the comparator returns 1 instead of 0, making the sort unstable. Produces non-deterministic pipeline output | Add check for both values being null/undefined before individual null checks: return 0 |
| V6-034 | Data | `services/ingestion/src/services/connector-registry-service.ts:449-463` | The PostgreSQL connector's registry entry lists host, database, user, password as required config but the actual plugin requires proxyUrl. Users configuring through UI/CLI provide wrong fields and get runtime PluginConfigError | Update registry configSchema to list proxyUrl as required, matching actual plugin |
| V6-035 | Security | `plugins/connector-mysql/src/index.ts:77-78` | The MySQL connector stores the full database connectionString (with credentials) in ConnectorHandle metadata. Handle metadata may appear in logs, BullMQ job payloads, and API responses, exposing credentials in plaintext | Remove connectionString from metadata. Retrieve from secure credential store on each fetchBatch call |
| V6-036 | API | `services/app/src/routes/apps.ts:570-585` | The /apps/:id/type-declarations endpoint emits incorrect signatures: useAppStorage declared as 2-tuple but returns 3-tuple; QueryResult.data declared non-nullable but is actually T[]\|null; SubscriptionResult has different shape. Wrong IntelliSense and runtime crashes | Update generated type declarations to match actual signatures |
| V6-037 | Reliability | `packages/frontend/src/components/editor/AppEditor.tsx:118-122` | AppEditor.tsx uses encodeURIComponent on the full path (e.g. /src/App.tsx) which encodes forward slashes. The server constructs //src/App.tsx (double leading slash), mismatching stored path. Both manual save and auto-save (every 500ms) silently fail | Encode each path segment individually, preserving literal path separators |
| V6-038 | API | `packages/sdk/src/resources/apps.ts:62-69` | SDK AppBuild type field names mismatch the server: SDK 'version' (string\|null) vs server 'versionNumber' (number); SDK 'completedAt' vs server 'builtAt'; SDK 'error' vs server 'errorMessage' | Align SDK fields with server response names and types |
| V6-039 | Security | `services/auth/src/routes/users.ts:213-234` | PUT /api/v1/users/:id allows a tenant-admin to deactivate themselves. There is a guard for the last platform admin but not for the last tenant-admin. This would lock the entire tenant out of administrative functions | Add self-deactivation guard: if isSelf and isActive===false, throw ForbiddenError |
| V6-040 | API | `packages/cli/src/commands/user/index.ts:46-51` | CLI 'user update' sends HTTP PATCH but auth service only registers PUT. PATCH gets 404/405. Also sends { role: string } but API expects { roles: string[] } | Change to ctx.http.put. Change body['role'] to body['roles'] = [opts.role] |
| V6-041 | API | `packages/cli/src/commands/user/index.ts:32-38` | CLI 'user invite' posts to /api/v1/users/invite which does not exist. Auth service only has POST /api/v1/users. Always returns 404 | Change to POST /api/v1/users and map to createUserRequest schema format |
| V6-042 | API | `packages/cli/src/commands/user/index.ts:54-58` | CLI 'user deactivate' posts to /api/v1/users/:id/deactivate which does not exist. Deactivation is done via PUT /api/v1/users/:id with { isActive: false }. Always gets 404 | Change to PUT /api/v1/users/:id with body { isActive: false } |
| V6-043 | API | `packages/cli/src/commands/user/index.ts:60-73` | CLI 'user import' posts multipart form data to /api/v1/users/import which does not exist. No bulk user import endpoint exists. Always fails with 404 | Implement POST /api/v1/users/import in auth service, or remove the command |
| V6-044 | API | `packages/cli/src/commands/role/index.ts:32-46` | CLI 'role assign' posts to /api/v1/roles/:roleName/members and 'role remove' uses nonexistent DELETE endpoint. Role assignment is done via PUT /api/v1/users/:id with { roles: [...] }. Both always fail | Reimplement via PUT /api/v1/users/:userId with updated roles array |
| V6-046 | Security | `services/logging/src/routes/logs.ts:84-199` | GET /api/v1/logs/export enforces logs:export scope but never filters by caller's tenant_id. A user with logs:export scope can export all tenants' log data | Add tenant_id filtering to the export query. Pass user.tenantId to logEventRepository.exportPage() |
| V6-048 | API | `packages/plugin-sdk/src/types/auth-provider.ts:103-162` | The AuthProvider interface does not declare initialize(), yet both OIDC and LDAP implementations depend on it being called first. Plugin developers following the SDK interface cannot discover that initialize() exists and get cryptic errors at runtime | Add optional initialize() method to AuthProvider interface |
| V6-049 | API | `packages/plugin-sdk/src/types/auth-provider.ts:48-71` | AuthContext omits the tracing property that PluginContext includes. Auth provider plugins cannot create spans in handleCallback() or refreshToken(). Tracing completely unavailable in auth flow methods | Add 'tracing: TracingContext' to AuthContext |
| V6-050 | DX | `packages/plugin-sdk/src/dev-server/plugin-dev-server.ts:192-210` | Dev server suggests 'op plugin simulate-hook before:pipeline.transform' and 'before:destination.write' but neither exists in HookStage type. Following this guidance produces runtime errors | Update typeGuidance strings to reference valid HookStage values |
| V6-051 | Reliability | `deploy/helm/oneplatform/templates/_helpers.tpl:351-360` | The readinessProbe probes /healthz which returns 200 as long as the Node process is alive. The /readyz endpoint actually checks DB and Redis connectivity. Kubernetes routes traffic to pods whose database or Redis is broken | Change the readinessProbe path from /healthz to /readyz |
| V6-052 | Reliability | `deploy/helm/oneplatform/templates/_helpers.tpl:338-346` | The startupProbe helper allows 300s startup window but no template includes it. Without startupProbe, livenessProbe starts checking after 20s. Services running migrations risk being killed, creating CrashLoopBackOff | Add the startupProbe include to each service deployment template |
| V6-053 | Reliability | `services/auth/src/index.ts:374-378` | The auth service's SIGTERM handler calls server.close() then cleanup() without any hard-exit timeout. If server.close() hangs, the process never exits. Docker Compose sends SIGKILL after 45s but during those 45s the container is unresponsive | Add setTimeout(() => process.exit(1), 30_000).unref() to the SIGTERM handler |
| V6-054 | Reliability | `packages/core/src/app.ts:39-70` | packages/core exports setupProcessErrorHandlers() for structured logging of uncaught exceptions, but none of the 9 services call it. Uncaught exceptions crash with default Node.js output that is not structured JSON and will not be parsed by Vector | Add setupProcessErrorHandlers(logger) to each service's main() after logger creation |
| V6-055 | Operations | `deploy/helm/oneplatform/templates/services/plugin.yaml:37-43` | The plugin service requires OP_SERVICE_TOKEN_SECRET (calls process.exit(1) if empty). The Helm commonEnv does not inject it. Helm deployment crashes the plugin service on every startup | Add OP_SERVICE_TOKEN_SECRET to the plugin service Helm template |
| V6-056 | Operations | `deploy/helm/oneplatform/values.yaml:125-127` | The nginx ingress has default proxy-read-timeout of 60s, which kills all SSE connections after 1 minute. SSE-based features (execution streaming, pipeline monitoring, app preview) are non-functional behind the ingress | Add nginx.ingress.kubernetes.io/proxy-read-timeout: '3600' and proxy-buffering: 'off' |
| V6-057 | Security | `deploy/helm/oneplatform/templates/infra/secret.yaml:14-18` | The chart-managed Secret renders empty strings for jwtPrivateKey, jwtPublicKey, masterKey, jwtSecret, cursorSecret when no values are provided. Services crash with Zod validation errors. No guard or warning exists | Add required check that fails helm install when values are empty, or auto-generate secrets |
| V6-058 | Security | `services/gateway/src/routes/webhooks.ts:23-67` | Webhook route handlers only check authentication but do not verify webhooks:manage scope. Any authenticated user including viewers can create, update, and delete webhooks | Add scope checks: POST/PUT/DELETE require 'webhooks:manage', GET requires 'webhooks:read' |
| V6-059 | Security | `services/gateway/src/routes/data.ts:27-73` | handleDataRoute checks only for authentication before proxying all HTTP methods. No check for data:read or data:write scopes. Any authenticated user can read, create, update, and delete data records | Add method-based scope checks: GET requires 'data:read', POST/PUT/PATCH/DELETE requires 'data:write' |
| V6-060 | Security | `services/gateway/src/routes/lineage.ts:41-56` | Lineage route handlers only check authentication, not any scope. The lineage graph reveals complete data flow topology (connectors, tables, ontology types, pipelines, apps) | Add scope check requiring 'lineage:read' or 'admin' scope |
| V6-061 | Security | `services/auth/src/services/oauth-service.ts:144-165` | getAuthorizationUrl accepts a caller-provided redirectUri and stores it without validating against a configured allowlist. An attacker can supply an arbitrary redirect URI to capture the authorization code | Maintain a per-provider allowlist. Validate redirectUri matches exactly. Default to the platform's own callback URL |
| V6-062 | Security | `services/app/src/routes/embed.ts:309-317` | buildFrameAncestors allows wildcard '*' in frame-ancestors CSP when allowedOrigins contains '*'. Any website can embed the app in an iframe, enabling clickjacking attacks | Remove the wildcard branch. Default to 'self' only. Log warning and reject '*' |
| V6-063 | Security | `services/app/src/routes/embed.ts:275-295` | The embed response injects inline script tags for app config and embed token, but the CSP sets script-src 'self' without 'unsafe-inline' or a nonce. Browsers block the inline scripts, causing embed to fail | Generate per-request cryptographic nonce, add to inline scripts, include 'nonce-{value}' in CSP |
| V6-064 | DX | `packages/cli/src/commands/auth/index.ts:74-82` | The logout command calls getActiveProfileName() ignoring the --profile flag. 'op auth logout --profile staging' deletes credentials for the default/active profile instead of the specified one. Data-loss bug | Replace getActiveProfileName() with ctx.profileName which respects --profile and OP_PROFILE |
| V6-065 | DX | `packages/cli/src/commands/pipeline/index.ts:44-46` | pipeline get, ontology get, schedule get, app get, plugin info, service health, run-status, and exec logs all hardcode ctx.renderer.json() instead of ctx.renderer.render(). The global --output format flag is bypassed | Replace ctx.renderer.json() with ctx.renderer.render(data, COLUMNS) in all get/info/detail commands |
| V6-067 | DX | `services/app/src/routes/apps.ts:575-583` | The generated MutationResult type declaration is missing bulkCreate, reset, and isError that are present in the actual type. Developers get no IntelliSense for bulk operations or error state | Add bulkCreate, reset, and isError to the generated MutationResult declaration |
| V6-068 | Reliability | `packages/frontend/src/pages/ontology/QueryBuilderPage.tsx:434` | entityList derivation accesses .data.items but the ontology endpoint returns { data: EntitySummary[], pagination }. .data.items returns undefined, so the entity type dropdown is always empty, making the query builder non-functional | Change to: const entityList = entityListData?.data ?? [] |
| V6-069 | Reliability | `packages/frontend/src/pages/apps/AppEditorPage.tsx:38` | useEditorStore() called without selector subscribes to every property. markDirty fires on every keystroke, each time re-rendering the page including the heavy Monaco editor. Causes severe performance degradation | Replace with useEditorStore(s => s.setAppId) to select only the specific action needed |
| V6-070 | UX | `packages/frontend/src/pages/apps/AppBuilderPage.tsx:41` | useBuilderStore() called without selector subscribes to all store changes. Every layout mutation (drag, drop, prop change, undo, redo) re-renders the entire page including the heavy AppBuilderCanvas, causing visible lag | Replace with useBuilderStore(s => s.resetLayout) and use only the specific action |
| V6-071 | Reliability | `packages/sdk/src/resources/apps.ts:197-210` | apps.list() and apps.listBuilds() assume server returns a bare array and infer pagination from items.length === limit. If server returns { items, nextCursor, total }, the code tries .length on an object | Align with standard pagination pattern: expect { items, nextCursor, total } and use nextCursor |
| V6-073 | Security | `packages/sdk/src/auth/pkce.ts:247-257` | The PKCE handler constructor synchronously checks URL params and throws AuthError if state mismatches. Called during createClient(), a benign scenario (stale ?code= params from browser back button) permanently prevents SDK client initialization | Move state validation from constructor into handleCallback(). Defer validation during construction |
| V6-074 | API | `packages/sdk/src/resources/logs.ts:78-96` | The SDK sends tail requests to /api/v1/logs/tail but the logging service has no tail endpoint. Calling client.logs.tail() will 404. The method is dead code | Implement /api/v1/logs/tail endpoint, or remove tail() from the SDK |
| V6-075 | DX | `packages/cli/src/commands/connector/index.ts:104-107` | connector get passes a single object to ctx.renderer.render() with columns. render() checks Array.isArray(data) for table dispatch. A single object falls through to JSON. --output table silently ignored for detail views | Wrap single object in array: ctx.renderer.render([connector], CONNECTOR_COLUMNS) |
| V6-087 | Reliability | `services/execution/src/services/sandbox-manager.ts:249-256` | getPrimary() only rejects requests when state is STARTING but not DRAINING_OLD. New executions dispatched to a draining sandbox may be killed mid-execution when drain completes. No warm replacement pool exists despite design spec requiring one | Add DRAINING_OLD check in getPrimary() and implement warm replacement pool per design spec |
| V6-096 | API | `packages/frontend/src/pages/settings/ApiKeysPage.tsx:181-222` | Create and rotate mutations expect { data: ApiKey } but auth route returns flat JSON without data wrapper. response.data is undefined, causing TypeError on every create/rotate. API key secret is permanently lost since it cannot be retrieved later | Update frontend types to match actual response shape, or wrap auth route responses |
| V6-097 | UX | `packages/frontend/src/pages/settings/TeamsPage.tsx:149-161` | Role dropdown only offers viewer, editor, admin. Cannot assign developer or tenant-admin. Worse: 'admin' is a scope name, not a role -- assigning it gives zero permissions. Single-element array overwrites multi-role users | Expand to all 5 valid roles. Support multi-role assignment |
| V6-107 | Reliability | `plugins/auth-provider-oidc/src/index.ts:505-513` | handleCallback reads redirect_uri from context.tenant.config instead of auth flow params. redirect_uri will be empty unless admin manually added it to plugin config. OAuth code exchange breaks because redirect_uri must match authorization request | Add redirectUri to CallbackParams or cache during getAuthorizationUrl using state parameter |
| V6-119 | Reliability | `services/app/src/services/build-service.ts:247-248` | build-service reads raw OP_SERVICE_TOKEN_SECRET and sends as X-Service-Token header. Other services use serviceTokenSigner.sign() for Ed25519 JWTs. Execution service validates as JWT, so raw secret fails. Also calls /internal/execution/execute but route is /internal/execution/run | Inject ServiceTokenSigner into BuildServiceDeps and use sign(). Fix endpoint path |
| V6-126 | Reliability | `packages/frontend/src/lib/sse.ts:102-111` | Code overrides EventSource.dispatchEvent to intercept named events, but browsers do not call dispatchEvent for incoming SSE events. Named events are dispatched through internal browser mechanisms. Server sends ALL events as named events, so SSEConnection drops everything. Entire platform event streaming pipeline is non-functional | Use addEventListener for specific named event types instead of overriding dispatchEvent |
| V6-139 | Reliability | `services/gateway/src/routes/health.ts:16-43` | Gateway /healthz checks both Postgres and Redis, returning 503 on failure. Used as liveness probe in both Docker Compose and Kubernetes. If PgBouncer briefly restarts, all gateway containers are killed simultaneously, causing complete platform outage | Separate liveness from readiness. Liveness returns 200 unconditionally. Use /readyz for readiness |
| V6-150 | Reliability | `packages/sdk/src/pagination/paginator.ts:50-57` | Paginator loops while cursor !== null. If server returns empty items with non-null cursor, all three methods (asyncIterator, collect, take) loop forever. collect()'s maxItems guard never fires with empty pages. No timeout or circuit breaker | Break loop if items.length === 0 AND nextCursor is not null. Log warning |
| V6-151 | DX | `packages/cli/src/commands/sdk/index.ts:22-29` | generate-types expects { items, nextCursor, total } from /api/v1/ontology. ontology list expects plain array from same endpoint. Neither matches actual response { data: { items, ... } }. CLI HTTP client does no envelope unwrapping. Both commands crash at runtime | Unify expected response shape and add proper response unwrapping |
| V6-164 | DX | `packages/cli/src/commands/auth/index.ts:53-62` | CLI auth login sends to /api/v1/auth/login which gateway publicRoutes blocks (V6-002). Response shape mismatch: CLI expects { accessToken, user } at top level but server returns { data: { accessToken, ... } }. Missing required tenantId field. Three independent failures block CLI login | Fix all three: gateway publicRoutes, response unwrapping, and tenantId prompt |
| V6-204 | UX | `packages/frontend/src/components/pipeline-editor/NodeConfigPanel.tsx:436-453` | Sub-workflow step requires manually typing UUID of child pipeline. No pipeline picker or autocomplete available | Replace UUID input with searchable dropdown listing existing pipelines by name |
| V6-205 | UX | `packages/frontend/src/components/pipeline-editor/NodeConfigPanel.tsx:536-553` | Transformer step requires typing raw plugin ID. No picker or autocomplete for available transformer plugins | Add dropdown fetching available transformer plugins from API |
| V6-206 | UX | `packages/frontend/src/components/pipeline-editor/VisualPipelineEditor.tsx:56-65` | Pipeline editor has no undo/redo. Delete key removes nodes instantly with no recovery. App Builder has undo/redo but pipeline editor does not | Add undo/redo history stack and toolbar buttons |
| V6-207 | UX | `packages/frontend/src/components/app-builder/ComponentConfigPanel.tsx:266-357` | Data binding uses hardcoded static entity type list instead of API fetch. Field mapping requires free-text inputs with no validation | Fetch entity types from ontology API. Use dropdown pickers for field mapping |
| V6-208 | UX | `packages/frontend/src/components/dlq/DLQJobDetail.tsx:36-44` | DLQ shows raw stack traces, UUIDs, and internal queue names. Non-technical users get no actionable guidance | Add user-friendly error summary, hide stack traces behind expandable section, add suggestions |
| V6-209 | UX | `packages/frontend/src/pages/dashboard/DashboardPage.tsx:363-513` | Dashboard is fixed layout with hardcoded panels. No drag-and-drop customization, no add/remove widgets | Add dashboard customization mode with drag-and-drop widget arrangement |
| V6-210 | UX | `packages/frontend/src/components/app-builder/AppBuilderCanvas.tsx:133-141` | 'Open in editor' button exports visual layout to raw JSX code, implying visual builder is incomplete and code knowledge is needed | De-emphasize code export. Ensure all features configurable through visual builder |
| V6-211 | UX | `packages/frontend/src/components/pipeline-editor/NodeConfigPanel.tsx:318-343` | Wait step requires duration in milliseconds (e.g. 60000). Max shown as 86,400,000 ms. Unusable for non-developers | Replace with duration picker using hours/minutes/seconds fields |

---

### MEDIUM (85)

| ID | Category | Component | Pain | Fix |
|----|----------|-----------|------|-----|
| V6-072 | Reliability | `packages/frontend/src/pages/pipelines/PipelineBuilderPage.tsx:54-125` | Duplicate useQuery calls with same queryKey (redundant but not double-fetching due to React Query dedup). Pipeline name field has no client-side validation -- empty string triggers confusing server error | Remove duplicate useQuery. Add client-side name validation in handleSave |
| V6-076 | Reliability | `services/auth/src/index.ts:60-71` | readBootstrapToken reads /data/init/bootstrap.token directly (root-owned 0400), ignoring OP_BOOTSTRAP_TOKEN env var set by service-entrypoint.sh. Fails with permission denied. Bootstrap token is null | Check process.env.OP_BOOTSTRAP_TOKEN first before falling back to file read |
| V6-077 | Reliability | `services/auth/src/index.ts:74-82` | After bootstrap, eraseBootstrapTokenFile attempts to unlink /data/init/bootstrap.token, but init-data volume is mounted :ro. Token persists across container restarts | Mount init-data as read-write in auth-service only, or rely on database bootstrap_completed flag |
| V6-079 | Reliability | `docker/redis/redis.conf:19-26` | redis.conf sets maxmemory 256mb but container has 512mb. allkeys-lru will evict auth tokens that must NOT be evicted | Raise maxmemory to match container, or change policy to volatile-lru so only keys with TTL are evicted |
| V6-081 | DX | `packages/cli/src/commands/logs/index.ts:37-39` | logs query calls ctx.renderer.render(logs) without column definitions. Without columns, table format falls through to JSON | Define LOG_COLUMNS (timestamp, service, level, message, traceId) and pass as second argument |
| V6-082 | DX | `packages/cli/src/commands/data/index.ts:35-43` | data query and data get call ctx.renderer.render() without column definitions. Since entity schemas are user-defined, no compile-time columns exist. Always produces JSON | When format is 'table' and no columns provided, auto-detect from first record's keys |
| V6-083 | DX | `packages/cli/src/commands/app/index.ts:122-136` | Deploy --wait polling loop has no timeout or deadline. If deployment gets stuck, CLI polls indefinitely every 3 seconds. Traps CI/CD scripts | Add --poll-timeout option (default 600s) |
| V6-084 | DX | `packages/cli/src/commands/profile/index.ts:86-99` | Removing a profile only deletes the profile JSON file, not the encrypted API key from credentials.json. Orphaned credentials remain on disk | Add deleteCredentials(name) call alongside deleteProfile(name) |
| V6-085 | DX | `packages/cli/src/lib/output.ts:142-148` | renderTsv only outputs data rows without headers. Standard TSV convention includes a header line | Add header line: process.stdout.write(columns.map(c => c.header).join('\\t') + '\\n') |
| V6-086 | DX | `packages/cli/src/commands/schedule/index.ts:85` | schedule update treats --enabled as string ('true'/'false' comparison), inconsistent with connector which uses boolean --enabled/--no-enabled pair | Use Commander boolean pair: .option('--enabled')/.option('--no-enabled') |
| V6-088 | Reliability | `plugins/connector-mysql/src/index.ts:201-215` | MySQL connector rejects all non-HTTPS proxyUrl with no private network exception. Postgres allows HTTP for private networks. MySQL fails in containerized deployments with localhost DB proxy | Apply same isPrivateNetworkHttp() check from Postgres connector |
| V6-089 | Reliability | `plugins/connector-csv/src/index.ts:376-398` | Registry advertises maxFileSizeMb:500 but plugin never enforces. fetchBatch fetches entire file via response.text() with no size check. A 2GB CSV causes OOM | Check Content-Length and enforce size limit. Stream response and abort if exceeded |
| V6-090 | Reliability | `plugins/connector-csv/src/index.ts:272, 487-491` | CSV connector metadata claims 'authenticated endpoints via bearer token' but buildRequestHeaders never attaches Authorization header. Users get 401 errors on authenticated CSVs | Add bearerToken config field and Authorization header |
| V6-092 | Reliability | `services/pipeline/src/templates/csv-import.ts:126-139` | csv-import template's upsert step references process.env and global fetch inside code that runs in isolated-vm. These Node.js globals are unavailable. Step throws ReferenceError at runtime | Pass ontology service URL through step input context and use sandbox-provided HTTP client |
| V6-093 | Data | `services/ingestion/src/services/sync-service.ts:48-62` | BatchJobPayload comment says records should NOT be in the payload, yet the records field is in the type and processSyncJob sets it. 1MB guard allows payloads up to 1MB per batch. Hundreds of concurrent batches push Redis memory high | Store batch records in a staging table. Batch processor should fetch by batchId |
| V6-095 | Reliability | `docker/docker-compose.yml:206-210` | PgBouncer healthcheck only checks if server accepts connections, not whether authentication works. PgBouncer can be 'ready' while auth_file entries are wrong | Authenticate via psql with service role credentials or use SHOW DATABASES |
| V6-098 | DX | `packages/frontend/src/pages/settings/ProfilePage.tsx:103-106` | ProfilePage sends only currentPassword and newPassword but backend schema requires confirmPassword. Zod returns 400 for missing field. Change-password flow completely broken | Include confirmPassword in POST body |
| V6-099 | API | `services/auth/src/routes/users.ts:60-67` | createUserRequest schema accepts optional temporaryPassword with full validation, but the route handler never reads it. Users always created without password_hash | If temporaryPassword is provided, hash it and include in create call |
| V6-100 | Security | `services/auth/src/routes/branding.ts:33-39` | All branding routes require platform-admin scope. Tenant-admin users who need to customize their organization's branding are locked out | Allow tenant-admin users to access branding for their own tenant |
| V6-101 | Reliability | `packages/frontend/src/components/metrics/ServiceHealthGrid.tsx:62-92` | ServiceHealthGrid only checks gateway /healthz and displays single 'Gateway' entry, despite describing itself as 'all platform services'. Cannot detect unhealthy downstream services | Extend gateway /healthz to probe each upstream service |
| V6-102 | API | `packages/cli/src/commands/role/index.ts:19-22` | Both 'role list' and 'user list' expect raw arrays but APIs return { data: [...], pagination: {...} }. Renderer produces garbled single-row output | Extract data array from paginated response |
| V6-103 | Security | `services/auth/src/routes/users.ts:46-66` | POST /api/v1/users validates platform-admin assignment but does not verify roles exist in tenant's registry. Admin could assign nonexistent role names resolving to zero scopes | Query roleRepository to verify role names exist. Return ValidationError for unrecognized names |
| V6-105 | DX | `packages/plugin-sdk/src/dev/scaffold.ts:349-361` | Scaffold-generated auth provider reads clientId from options.additionalParams?.clientId instead of parsed config (as OIDC reference does). Crashes when additionalParams lacks clientId | Update scaffold to match OIDC reference pattern |
| V6-106 | DX | `packages/plugin-sdk/src/dev/scaffold.ts:527-549` | Scaffold-generated transformer test creates records with 'entityType' and 'timestamp' fields not on DataRecord interface. TypeScript strict mode failures | Update template records to use { sourceId, data, metadata } matching DataRecord |
| V6-108 | API | `packages/plugin-sdk/src/dev/scaffold.ts:640-649` | Scaffold-generated widget test passes { config, user, data: {} } but WidgetData has 'queryResults', not 'data'. render() receives missing field, causing runtime failures | Update to pass { config, user, queryResults: {} } |
| V6-109 | DX | `packages/plugin-sdk/src/dev/simulate-hook.ts:153-161` | When no hooks match, simulateHook falls back to manifest's top-level entrypoint which is a plugin export (object), not a hook function. Gives unhelpful 'not a callable function' error | Check if fallback is function or object and provide clear error message |
| V6-110 | API | `packages/plugin-sdk/src/testing/mock-factories.ts:555-589` | createTransformerMockContext returns MockContext with all PluginContext properties including credentials and fetch, but TransformerContext intentionally omits them. Tests pass but production fails | Update mock to exclude credentials and fetch, matching TransformerContext |
| V6-111 | Reliability | `packages/plugin-sdk/src/dev/pack.ts:445-460` | extractOppkg keys files by path.basename, stripping directory structure. If two files share basename in different directories, one overwrites the other | Key by full relative path. Look up using expected relative paths |
| V6-112 | DX | `packages/plugin-sdk/src/testing/mock-context.ts:390-409` | Two different transformer mock context factories exist: createMockTransformerContext in mock-context.ts and createTransformerMockContext in mock-factories.ts. Different return types, naming collision | Remove or deprecate one. Keep createTransformerMockContext from mock-factories.ts |
| V6-113 | Security | `packages/plugin-sdk/src/dev-server/dev-context.ts:97-120` | When allowRealFetch is true, fetch calls globalThis.fetch with no URL validation. Manifest's requiredExternalUrls allowlist is ignored. Plugins work in dev but fail in production | Log warning when restrictions bypassed. Optionally validate against manifest allowlist |
| V6-114 | DX | `packages/plugin-sdk/src/dev-server/plugin-dev-server.ts:160-165` | PluginDevServer only runs connector lifecycle. All other plugin types get generic message. Transformer/auth-provider developers must write their own test harness | Add lifecycle runners for transformer and auth-provider types |
| V6-117 | Reliability | `plugins/auth-provider-ldap/src/index.ts:783-800` | validateToken uses user DN as searchBase with filter '(objectClass=*)' and no scope restriction. Could return entries below the DN in the tree | Add 'scope' parameter (default 'base') to LDAP proxy search API |
| V6-118 | Reliability | `packages/frontend/src/components/apps/AppDeployButton.tsx:22-24` | Component expects 'queued'\|'building'\|'success'\|'failed'\|'cancelled' but server returns 'pending'\|'building'\|'success'\|'failed'. Status mismatch causes incorrect UI state | Align status type to 'pending'\|'building'\|'success'\|'failed' |
| V6-121 | Security | `services/gateway/src/index.ts:472-477` | Gateway storage service falls back to hardcoded 'minioadmin' and 'dev_minio_password_change_me' when env vars not set. Production could silently use well-known credentials | Check if credentials match defaults and NODE_ENV is 'production', throw error at startup |
| V6-122 | Reliability | `services/auth/src/services/bootstrap-service.ts:38-59` | In-memory rate limiter Map stores entries for every unique IP but entries never deleted when windows expire. Many IPs cause unbounded memory growth, eventually OOM | Add periodic cleanup interval for expired entries, or cap Map size with LRU eviction |
| V6-124 | Security | `services/auth/src/services/token-service.ts:177-184` | Multiple parseInt calls on security-critical parameters (JWT expiry, refresh TTL, bcrypt rounds) lack NaN validation. Non-numeric values cause NaN to propagate. Redis SET with EX NaN silently stores keys with no expiration | Add NaN validation after each parseInt: throw startup error or fall back to default |
| V6-127 | Reliability | `packages/frontend/src/router.tsx:95-125` | After bootstrap, user redirected to /dashboard where AuthenticatedLayout calls /v1/auth/me. If not logged in, 401 redirects to /login, which redirects to '/' re-triggering bootstrap check -- redirect loop | Redirect to /login after bootstrap completion instead of /dashboard |
| V6-129 | UX | `packages/frontend/src/components/layout/AppShell.tsx:38-91` | MobileNavigation has full bottom tab bar implementation meeting WCAG 2.5.5, but AppShell never imports or renders it. Users on mobile get desktop sidebar drawer instead | Import and render MobileNavigation in AppShell.tsx |
| V6-130 | Reliability | `packages/frontend/src/pages/connectors/NewConnectorPage.tsx:148-177` | handleConfigureSubmit changes step to 'test' before mutation fires. If mutation fails, testStatus never set, leaving user stuck with perpetual spinner and no way back | Show error message and 'Back' button when createConnector.isError |
| V6-131 | UX | `packages/frontend/src/pages/connectors/NewConnectorPage.tsx:99-109` | Marketplace install navigates to /connectors/new with pluginId param, but NewConnectorPage does not read search params. User must manually re-select the same connector type | Read pluginId from search params. Auto-select matching type and skip to 'configure' step |
| V6-132 | Reliability | `packages/frontend/src/pages/dashboard/DashboardPage.tsx:364` | DashboardPage wraps content in overflow-y-auto but parent AppShell main already has overflow-y-auto. Nested scrollable containers cause conflicting scroll behavior on mobile | Remove overflow-y-auto from DashboardPage root div |
| V6-134 | UX | `packages/frontend/src/pages/apps/AppDetailPage.tsx:117-124` | Loading condition includes app === undefined which is true on error. Query error state never shows error message. Skeleton renders forever on 404 | Add isError check before loading: if query.isError return error state |
| V6-136 | Operations | `.github/workflows/ci.yml:128-139` | No vulnerability scanning (Trivy, Grype, Snyk). Base images can carry CVEs. Vulnerabilities ship to production undetected | Add security scanning step after docker build using trivy-action |
| V6-137 | Reliability | `deploy/helm/oneplatform/templates/infra/pvc.yaml:19-21` | PVCs use ReadWriteOnce but HPA can scale to 5 replicas on different nodes. Additional pods fail with multi-attach error | Change to ReadWriteMany, switch to object storage, or disable HPA for RWO volumes |
| V6-138 | Operations | `deploy/helm/oneplatform/templates/services/gateway.yaml:22-30` | No template sets terminationGracePeriodSeconds (defaults to 30s). Service shutdown handlers have 30s hard-exit timeouts. SIGKILL and hard-exit fire simultaneously | Add terminationGracePeriodSeconds: 45 to pod spec in each template |
| V6-140 | Reliability | `docker/grafana/provisioning/alerting/alert-rules.yml:56-75` | Error-rate alert uses classic_conditions evaluating count(A) > 0.05 instead of computing A/B (errors/total). Fires on any single error, not 5% rate threshold | Replace classic_conditions with math expression computing $A / $B > 0.05 |
| V6-141 | Operations | `docker/vector/vector.yaml:58-65` | Vector sink writes to {container_id}.log. Container IDs change on every restart with no stable mapping. Operators cannot correlate logs to services | Parse SERVICE_NAME from structured JSON log lines and use as file path component |
| V6-143 | Security | `docker/docker-compose.yml:803` | Caddy health check uses 'pgrep -x caddy' which only confirms process running. Does not verify TLS certificates or request serving. Failed certificate acquisition goes undetected | Replace with HTTP check against Caddy's admin API or synthetic request |
| V6-144 | Operations | `deploy/helm/oneplatform/values.yaml:247-264` | Docker Compose has Vector container for log collection but Helm chart has no equivalent. In Kubernetes, logs only available via kubectl logs. Grafana dashboards have no data source | Add Vector DaemonSet to Helm chart or document integration with cluster-level collector |
| V6-145 | Reliability | `packages/sdk/src/transport.ts:468-474` | When server returns { data: null }, envelope.data is null (not undefined) so code returns null typed as T. Caller gets null expecting typed object, causing runtime crashes on property access | Add explicit null check or update return type to T \| null |
| V6-146 | Reliability | `packages/sdk/src/subscriptions/sse-subscriber.ts:210-250` | After normal server close, reconnectAttempt resets to 0 causing 1-second delay. If server keeps closing, backoff never escalates, creating infinite 1-second reconnect loop | Track consecutive reconnects separately. Only reset after connection stays alive for minimum duration |
| V6-147 | DX | `packages/sdk/src/index.ts:25-28` | OnePlatformClient has properties like 'data: DataNamespace' but DataNamespace and EntityResource are not exported from barrel. SDK consumers cannot type function parameters without deep imports | Add DataNamespace, EntityResource, and all namespace types to barrel exports |
| V6-148 | Reliability | `packages/app-sdk/src/ws/WebSocketManager.ts:207-219` | No maximum reconnect attempt limit (SSE subscriber has 10). If server permanently unreachable, manager reconnects every 30s forever with no failure surfaced to the app | Add maximum reconnect constant (e.g., 30) and transition to 'failed' state |
| V6-149 | Reliability | `packages/sdk/src/grpc-client.ts:247-295` | grpcServerStreamingCall awaits response.arrayBuffer() to read entire response then decodes all frames. Defeats the purpose of streaming for large result sets | Replace with incremental frame parsing from response.body.getReader(), yielding each entity as it arrives |
| V6-152 | DX | `packages/cli/src/commands/webhook-out/index.ts:57-63` | Uses opts.enabled === 'true' string comparison, inconsistent with connector's boolean pair | Replace with Commander boolean pair: .option('--enabled')/.option('--no-enabled') |
| V6-153 | DX | `packages/cli/src/commands/service/index.ts:59-63` | Only command that calls process.exit directly in action handler. Bypasses withContext error handling, --verbose stack traces, and EXIT constants | Replace with throw new CliError() |
| V6-154 | DX | `packages/cli/src/lib/http-client.ts:162-168` | Unlike regular request(), postMultipart does not check for AbortError specifically. Upload timeout wrapped as generic 'Network error' instead of 'Request timed out' | Add AbortError check matching request() pattern |
| V6-155 | DX | `packages/cli/src/lib/http-client.ts:180-205` | stream() method for SSE connections has no timeout on initial fetch. If platform unreachable, connection hangs indefinitely with no feedback | Add connection timeout to initial fetch. Remove abort controller after response headers received |
| V6-157 | DX | `packages/cli/src/commands/connector/index.ts:80-82` | connector create reads config from file but has no stdin support unlike data create. Automation requires temp files | Add stdin support: when value is '-', read from process.stdin |
| V6-158 | DX | `packages/sdk/src/resources/apps.ts:291-317` | Both deploy() and uploadAndDeploy() POST to same path but deploy sends JSON while uploadAndDeploy sends FormData. Server only handles JSON. uploadAndDeploy always fails | Implement multipart handling with separate path, or remove uploadAndDeploy |
| V6-159 | DX | `packages/sdk/src/resources/platform-types.ts:13-20` | ApiErrorResponse describes canonical error body shape but is not exported. SDK consumers cannot reference this type without deep imports | Add ApiErrorResponse to type exports in packages/sdk/src/index.ts |
| V6-160 | DX | `packages/plugin-sdk/src/dev/scaffold.ts:784-819` | Scaffold generates PascalCase identifiers but all reference plugins use camelCase. Scaffold-generated plugins look inconsistent with all reference code | Change toPascalCase to toCamelCase in scaffold generator |
| V6-161 | DX | `docker/Dockerfile.frontend:29-37` | Dockerfile.frontend copies all 9 service package.json files even though frontend has no dependency. Bloats build context and breaks Docker layer caching | Remove COPY lines for services. Use turbo prune --scope=@oneplatform/frontend --docker |
| V6-162 | DX | `docs/quickstart/platform-admin.md:20` | platform-admin.md says 'docker compose up -d' without -f flag. Running from repo root fails because there is no docker-compose.yml in root | Update to 'docker compose -f docker/docker-compose.yml up -d' |
| V6-165 | DX | `packages/app-sdk/src/hooks/useQuery.ts:18-27` | useQuery JSDoc example shows inline object literal without memoization, contradicting the function's own docs warning about refetch-on-every-render | Update @example to show memoized pattern |
| V6-166 | DX | `packages/sdk/src/resources/pipelines.ts:151-164` | streamRunLogs() is the only list method that does not accept ListOptions or pass pageSize. Caller cannot control page size | Add optional ListOptions parameter |
| V6-168 | Reliability | `services/app/src/services/build-service.ts:716-720` | findFailedOlderThan returns failed builds from ALL apps. Outer loop iterates apps but inner query is global, causing redundant delete calls | Pass appId to findFailedOlderThan, or collect and deduplicate |
| V6-190 | DX | `services/app/src/routes/bff.ts:136-148` | UserContext includes isLoaded: boolean but /bff/me endpoint does not include it. Code directly accessing context.user finds isLoaded undefined | Add isLoaded: true to /bff/me response |
| V6-192 | Reliability | `packages/app-sdk/src/provider/AppProvider.tsx:198-203` | Promise.all in single withRetry means failure in one re-executes both calls. /bff/me is needlessly re-called when only seed() fails | Separate retry logic so each call retries independently |
| V6-193 | API | `packages/sdk/src/resources/apps.ts:189-211` | Transport unwraps { data } envelope, losing pagination metadata. Paginator returns total: null. UI pagination controls cannot display 'showing X of Y' | Modify Transport to preserve pagination metadata, or add apps.count() method |
| V6-212 | UX | `packages/frontend/src/components/pipelines/PipelineBuilder.tsx:186-250` | Legacy pipeline builder has only name and text summary fields per step. No actual configuration | Remove legacy builder or extend with real configuration forms |
| V6-213 | UX | `packages/frontend/src/components/pipeline-editor/NodeConfigPanel.tsx:483-494` | When no connectors found, falls back to raw UUID text input instead of clear CTA to create one | Remove UUID fallback, show prominent create-connector CTA |
| V6-214 | UX | `packages/frontend/src/components/app-builder/palette-registry.ts:109-120` | FilterBar component has empty propSchema. Config panel shows 'No configurable properties' | Add propSchema entries for filter field, type, label, and options |
| V6-215 | UX | `packages/frontend/src/components/app-builder/palette-registry.ts:17-35` | DataTable propSchema only has pageSize/emptyMessage. No way to define columns visually | Add visual column editor to propSchema |
| V6-216 | UX | `packages/frontend/src/components/pipeline-editor/NodeConfigPanel.tsx:356-375` | Approval step requires comma-separated email addresses. No user picker or autocomplete | Replace with tag-style multi-select fetching from user directory API |
| V6-217 | UX | `packages/frontend/src/pages/settings/WebhooksPage.tsx:61-68` | Webhook event selection shows raw internal names like 'dlq.job.added'. No descriptions | Replace with human-readable labels grouped by category |
| V6-218 | UX | `packages/frontend/src/components/apps/TemplatePickerDialog.tsx:54-64` | Only 3 app template categories. No previews/thumbnails. No template marketplace | Add template thumbnails, more templates, and preview modal |
| V6-219 | UX | `packages/frontend/src/components/app-builder/palette-registry.ts:158-183` | HtmlBlock uses raw HTML textarea. MarkdownBlock requires Markdown syntax. No WYSIWYG | Replace with WYSIWYG rich text editor |
| V6-220 | UX | `packages/frontend/src/components/shared/ErrorBoundary.tsx:65-70` | ErrorBoundary shows raw backend error messages with HTTP codes and TypeScript errors | Classify errors into user-facing categories with actionable messages |
| V6-221 | UX | `packages/frontend/src/pages/ontology/QueryBuilderPage.tsx:44-59` | Query builder uses SQL operators (LIKE, IN, IS NULL) instead of plain English | Replace with 'contains', 'is one of', 'is empty' |
| V6-222 | UX | `packages/frontend/src/pages/ontology/QueryBuilderPage.tsx:213-220` | IN/NOT IN operators require comma-separated values. No tag-style input | Replace with tag-style multi-value input |
| V6-223 | UX | `packages/frontend/src/components/ontology/SchemaInferencePanel.tsx:306-314` | Entity name requires PascalCase format. User typing 'my customers' gets unhelpful validation error | Auto-convert input to PascalCase on every keystroke |
| V6-224 | UX | `packages/frontend/src/pages/dashboard/DashboardPage.tsx:472-490` | Activity shows raw internal service names and log levels. Messages like 'ingestion.pipeline.step.completed' are opaque | Map to user-friendly labels and icons. Filter out system-level events |
| V6-225 | UX | `packages/frontend/src/pages/pipelines/RunDetailPage.tsx:106-190` | Run detail shows truncated UUID title, raw error text, raw trigger type string | Show pipeline name + run number. Categorize errors. Use friendly trigger labels |
| V6-231 | UX | `packages/frontend/src/pages/pipelines/PipelineBuilderPage.tsx:192-203` | Two different pipeline builders exist (legacy linear vs visual DAG). Visual editor has no clear entry point | Make VisualPipelineEditor the default. Add prominent toggle or remove legacy |

---

### LOW (34)

| ID | Category | Component | Pain | Fix |
|----|----------|-----------|------|-----|
| V6-080 | Security | `services/auth/src/routes/bootstrap.ts:94-97` | Bootstrap and refresh rate limiters use X-Forwarded-For as primary IP source, which is client-controlled. Gateway sanitizes both headers from TCP source, so exploitation requires bypassing gateway | Prefer X-Real-IP over X-Forwarded-For |
| V6-091 | Reliability | `services/pipeline/src/services/schedule-service.ts:148-154` | Schedule service passes user-provided timezone to cron-parser without validation. Invalid IANA timezone causes confusing raw error. Per-schedule try-catch prevents blocking other schedules | Validate timezone against Intl.supportedValuesOf('timeZone') at creation time |
| V6-094 | API | `services/ingestion/src/services/retention-service.ts:12-18` | Two interfaces define incompatible deleteOlderThan signatures. Concrete implementation handles both via union types with no data corruption, but design is confusing | Unify the two interfaces to use the same signature |
| V6-104 | Operations | `services/logging/src/services/retention-service.ts:54-79` | ensurePartitions interpolates partition name into SQL without regex validation, while the drop path validates. Partition names are constructed deterministically from Date objects (no external input) | Apply same regex validation for defense-in-depth consistency |
| V6-123 | Security | `services/auth/src/services/guest-session-service.ts:42-73` | Guest session create() has no rate limiting. However, endpoint is internal-only (serviceAuthMiddleware), only app-service can call it, and app-service already rate-limits guest creation | Add per-IP rate limiting as defense-in-depth |
| V6-133 | UX | `packages/frontend/src/pages/settings/WebhooksPage.tsx:71` | Frontend accepts http:// webhook URLs. Backend enforces HTTPS via SSRF guard, so user gets server error instead of client-side feedback | Add z.refine() that warns on http:// or require https:// |
| V6-142 | Operations | `deploy/helm/oneplatform/templates/services/gateway.yaml:12-15` | No explicit deployment strategy defined. Kubernetes defaults (maxSurge:25%, maxUnavailable:25%) are safe for single-replica services. Good practice to be explicit | Add strategy.rollingUpdate.maxSurge: 1 and maxUnavailable: 0 |
| V6-156 | Reliability | `packages/cli/src/lib/file-sync.ts:47` | file-sync slug not URI-encoded in PUT path, inconsistent with app commands. Server enforces alphanumeric+hyphen slugs, so encoding is always no-op | Use encodeURIComponent(slug) for consistency |
| V6-169 | Reliability | `services/gateway/src/routes/health.ts:45-52` | Gateway readyz only checks Postgres, not Redis. Redis used for rate limiting, SSE, metering, token revocation. Kubernetes routes traffic when Redis is down | Add Redis ping check to /readyz handler |
| V6-170 | Operations | `docker/docker-compose.yml:736-738` | Vector mounts /var/lib/docker/containers which may not exist on systems with custom data-root. Silently fails on macOS Docker Desktop and WSL2 | Add configurable OP_DOCKER_DATA_ROOT env var. Document Linux-only limitation |
| V6-171 | DX | `packages/plugin-sdk/src/testing/mock-context.ts:259-288` | Mock cache.set() discards TTL parameter entirely. Plugin tests for TTL-based behavior get false positives because cached values never expire | Track TTL in mock cache with { value, expiresAt }. Add advanceTime() utility |
| V6-172 | DX | `packages/plugin-sdk/src/testing/assertions.ts:28-71` | assertValidPlugin does not check conditionally required auth-provider methods (validateToken, refreshToken) based on metadata feature flags. Passes assertion but fails at runtime | Check metadata() feature flags and assert conditionally required methods |
| V6-173 | Reliability | `packages/plugin-sdk/src/dev-server/plugin-loader.ts:94-101` | Dynamic import uses same URL on reload. Node.js returns cached module. Watch mode shows 'Reloading plugin...' but old version runs | Append cache-busting query parameter: '?t=' + Date.now() |
| V6-175 | DX | `packages/cli/src/commands/version/index.ts:9` | CLI_VERSION hardcoded to '0.0.0'. Users cannot determine actual version. SDK similarly uses hardcoded '0.1.0' | Read version from package.json at build time or dynamically |
| V6-176 | DX | `packages/cli/src/commands/ontology/index.ts:215-216` | ontology migrate --timeout description says 'Max wait duration in seconds' without specifying default is 300s | Add default value to description |
| V6-177 | DX | `packages/cli/src/commands/dlq/index.ts:64-69` | dlq replay-all does sequential HTTP calls without parallelism. Extremely slow for large DLQ backlogs | Add batched parallel execution with concurrency limit |
| V6-178 | Security | `packages/cli/src/commands/config/index.ts:163-164` | Passphrase passed as command-line flag is visible in ps aux output and shell history | Add interactive prompt fallback when --passphrase not provided |
| V6-179 | DX | `packages/sdk/src/filter-builder/filter-builder.ts:123-125` | FilterBuilder.in() comma-joins values. Values containing commas are corrupted. No escape mechanism | URL-encode commas within values before joining, or use repeated query params |
| V6-180 | DX | `services/app/src/routes/apps.ts:562` | Generated useUser return type omits isLoaded: boolean. Missing from IntelliSense | Add isLoaded: boolean to generated return type |
| V6-181 | UX | `packages/frontend/src/pages/plugins/PluginDetailPage.tsx:115-122` | Same issue as AppDetailPage: loading check includes plugin === undefined which is true on error. Skeleton renders forever on 404 | Add isError check before loading check |
| V6-182 | UX | `packages/frontend/src/pages/logs/AuditPage.tsx:65-67` | Appending 'T23:59:59' to invalid date string causes new Date().toISOString() to throw uncaught exception, crashing component | Wrap Date construction in try/catch or validate date string |
| V6-184 | Performance | `packages/frontend/src/hooks/use-auth.ts:19-29` | Zustand selector returns new object on every call. Object identity changes every render, causing unnecessary re-renders | Use useShallow from zustand/react/shallow or split into individual selectors |
| V6-185 | DX | `packages/app-sdk/src/hooks/useQuery.ts:44-52` | buildCacheKey uses JSON.stringify which depends on property insertion order. Same filter with different order creates different cache keys | Sort filter keys before serialization |
| V6-186 | DX | `packages/cli/src/commands/completion/index.ts:1-295` | Shell completion lists 'status' but does not offer --watch and --interval flag completions. Bash/zsh scripts do not complete flags | Add flag completion for commands. Consider generating from Commander program tree |
| V6-187 | Reliability | `packages/frontend/src/pages/settings/StorageBrowserPage.tsx:127-139` | Query string manually concatenated into path parameter. Special characters in prefix may not be properly encoded | Pass prefix, delimiter, maxKeys as params option to client.get |
| V6-188 | UX | `packages/frontend/src/pages/settings/ProfilePage.tsx:30-33` | Email field is disabled but schema validates with z.string().email(). If server returns malformed email, form silently prevents submission since field cannot be edited | Remove email from validation schema since it is never submitted |
| V6-189 | DX | `packages/plugin-sdk/src/manifest/schema.ts:69-72` | Plugin description min(10) error message uses inconsistent style compared to other fields. Scaffold generates descriptions well over 10 chars so error rarely triggered | Change message to 'description must be at least 10 characters' for consistency |
| V6-191 | DX | `packages/frontend/src/pages/settings/ApiKeysPage.tsx:372` | Mask always shows 'op_' prefix regardless of actual key, leaking key format. If key shorter than 3 chars, repeat gets negative number | Use fixed mask length. Do not hardcode prefix in mask |
| V6-194 | Reliability | `packages/frontend/src/pages/dashboard/DashboardPage.tsx:317-319` | Dashboard passes sort: '-createdAt' to /v1/logs but Zod strips it. Server always returns descending order anyway. Dead code | Remove sort parameter from dashboard activity query |
| V6-226 | UX | `packages/frontend/src/components/pipeline-editor/PipelineNode.tsx:163-188` | Delete/Backspace removes pipeline nodes instantly. No confirmation, no undo toast | Add confirmation dialog or undo toast after deletion |
| V6-227 | UX | `packages/frontend/src/components/app-builder/ComponentConfigPanel.tsx:370-476` | Style tab uses CSS property names (alignSelf, flex-start, stretch). Not beginner-friendly | Use plain English labels: 'Alignment' with 'Left/Center/Right/Fill' |
| V6-228 | UX | `packages/frontend/src/components/apps/TemplatePickerDialog.tsx:83-88` | URL slug field uses developer terminology. Validation error says 'Slug may only contain...' | Rename to 'App URL', auto-generate, hide behind Advanced toggle |
| V6-229 | UX | `packages/frontend/src/components/connectors/ConnectorForm.tsx:136-282` | Connector form fields have descriptions but no tooltips, help icons, examples, or doc links | Add tooltip icons, inline examples, and doc links |
| V6-230 | UX | `packages/frontend/src/components/app-builder/palette-registry.ts:96-104` | DetailPanel has fields:[] default with no UI to populate it | Add visual field list editor to propSchema |

---

## Finding Distribution by Persona

| Persona | CRITICAL | HIGH | MEDIUM | LOW | Total |
|---------|----------|------|--------|-----|-------|
| First-Time Self-Hoster | 4 | 7 | 10 | 3 | 24 |
| Data Engineer | 3 | 8 | 5 | 1 | 17 |
| App Developer | 2 | 6 | 8 | 2 | 18 |
| Plugin Developer | 1 | 4 | 10 | 3 | 18 |
| Platform Admin | 2 | 6 | 7 | 1 | 16 |
| DevOps/SRE | 2 | 7 | 6 | 2 | 17 |
| Security Auditor | 3 | 9 | 5 | 3 | 20 |
| CLI Power User | 0 | 5 | 12 | 4 | 21 |
| SDK Consumer | 5 | 5 | 7 | 2 | 19 |
| Frontend/UX Reviewer | 0 | 4 | 11 | 5 | 20 |
| Low-Code/Drag-and-Drop UI User | 4 | 8 | 16 | 5 | 33 |

Note: Findings flagged by multiple personas are counted once per persona. Total exceeds 213 due to multi-persona overlap.

---

## Cross-Reference by Component Area

| Component Area | CRITICAL | HIGH | MEDIUM | LOW | Total |
|----------------|----------|------|--------|-----|-------|
| Frontend | 4 | 8 | 17 | 7 | 36 |
| Pipeline Editor / Visual Builder | 4 | 5 | 8 | 1 | 18 |
| App Builder / App SDK | 2 | 7 | 7 | 3 | 19 |
| SDK (platform) | 5 | 7 | 8 | 3 | 23 |
| Auth Service | 1 | 4 | 6 | 1 | 12 |
| Gateway / Proxy | 2 | 5 | 2 | 1 | 10 |
| CLI | 1 | 7 | 12 | 5 | 25 |
| Plugin SDK / Service | 1 | 3 | 9 | 3 | 16 |
| App Service / BFF | 1 | 4 | 4 | 1 | 10 |
| Pipeline / Execution | 1 | 2 | 2 | 0 | 5 |
| Ingestion Service | 0 | 1 | 3 | 1 | 5 |
| Docker / Infrastructure | 2 | 2 | 5 | 2 | 11 |
| Helm / Kubernetes | 1 | 4 | 5 | 2 | 12 |
| Logging Service | 1 | 1 | 0 | 0 | 2 |
| Plugins (connectors) | 0 | 2 | 3 | 0 | 5 |
| Documentation | 0 | 1 | 1 | 0 | 2 |
| Grafana / Monitoring | 0 | 0 | 1 | 0 | 1 |
| Security Infra | 0 | 0 | 1 | 0 | 1 |

---

## Comparison with Previous Analyses

| Metric | v1 | v2 | v3 | v4 | v5 | v6 |
|--------|----|----|----|----|-----|-----|
| Raw findings | 108 | 202 (85 unique) | 53 net-new | 148 net-new | 135 unique | 213 unique |
| Perspectives/Personas | 4 | 6 | 10 | 10 | 10 | 11 |
| CRITICAL | N/A | 13 | 5 | 18 | 9 | 25 |
| HIGH | N/A | 35 | 18 | 45 | 35 | 69 |
| Total agents | N/A | 6 | 10 | 10 | 62 | 206+ |
| Adversarial verification | No | No | No | No | Yes (50 agents) | Yes (193+ agents) |
| False positives caught | N/A | N/A | N/A | N/A | 1 | 14 |
| Severity adjustments | N/A | N/A | N/A | N/A | 3 escalations | 13 escalated, 12 downgraded |

### v6 Key Differences from v5

1. **New persona -- Low-Code/Drag-and-Drop UI User:** v6 introduces an 11th persona focused on non-technical users interacting with the visual pipeline editor, app builder, and drag-and-drop interfaces. This persona surfaced 33 findings (4 CRITICAL, 8 HIGH), revealing that many visual builder interfaces require raw JSON, cron expressions, UUIDs, or code -- defeating their purpose for low-code users.

2. **Dramatic increase in CRITICAL findings:** The jump from 9 (v5) to 25 (v6) CRITICALs reflects deeper code-path analysis. v6 found fundamental issues missed in v5: init file permissions blocking all services (V6-001), gateway publicRoutes blocking all auth endpoints (V6-002), and cross-tenant security violations in logging and storage (V6-009, V6-014, V6-045).

3. **Stronger adversarial verification:** 193+ verifier agents (up from 50 in v5) with more aggressive challenge criteria. 14 false positives removed (vs 1 in v5), 13 findings escalated (vs 3 in v5), and 12 findings downgraded (new in v6). Each escalation and downgrade includes detailed evidence chains.

4. **Security category growth:** 24 security findings (3 CRITICAL, 12 HIGH) -- a significant increase from v5's 14 (0 CRITICAL, 5 HIGH). New findings include cross-tenant data access bypasses, missing scope enforcement on 3 gateway route groups, OAuth redirect URI attacks, and post-password-change token persistence.

5. **Reliability dominance:** Reliability is now the largest category with 56 findings (vs 16 in v5), reflecting deeper analysis of runtime behavior including WebSocket/SSE lifecycle issues, Zustand store performance, sandbox manager race conditions, and Docker init permission chains.

6. **CLI command-to-API mismatches:** 8 CLI commands target nonexistent endpoints (V6-040 through V6-044, V6-102, V6-151, V6-164), indicating the CLI was developed against a spec that diverged from the actual API implementation. This is a systemic pattern requiring contract testing.

---

## Severity Classification Rubric

| Level | Criteria |
|-------|----------|
| **CRITICAL** | Blocks a core workflow entirely, causes data loss, or creates an exploitable security vulnerability |
| **HIGH** | Significant functionality gap, performance degradation, or security weakness that affects many users |
| **MEDIUM** | Noticeable quality issue, inconsistency, or missing feature that has workarounds |
| **LOW** | Cosmetic issue, minor inconvenience, or improvement opportunity |
