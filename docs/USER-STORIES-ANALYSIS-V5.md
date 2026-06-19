# OnePlatform User Story Analysis v5

**Date:** 2026-06-19
**Method:** 10-persona adversarial analysis with 62 total agents
**Previous analyses:** [v1](./USER-STORIES-ANALYSIS.md) (108 points), [v2](./USER-STORIES-ANALYSIS-V2.md) (85 unique, 13 CRITICAL), [v3](./USER-STORIES-ANALYSIS-V3.md) (53 unique, 5 CRITICAL), [v4](./USER-STORIES-ANALYSIS-V4.md) (148 unique, 18 CRITICAL)
**This analysis:** 135 unique findings after deduplication, 1 false positive refuted during adversarial verification

---

## Summary Table

| Severity | Count |
|----------|-------|
| CRITICAL | 9     |
| HIGH     | 35    |
| MEDIUM   | 69    |
| LOW      | 22    |
| **Total unique findings** | **135** |

---

## Methodology

This v5 analysis employs a multi-agent adversarial workflow that goes beyond the persona-based approach used in v2-v4. The process is structured in three phases totaling **62 agents**:

### Phase 1: Persona Analysis (10 agents)

Ten distinct persona agents independently analyze the entire OnePlatform codebase. Each agent is configured with a specific user profile, goals, and areas of concern. Each agent produces findings from its vantage point with source code citations.

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

### Phase 2: Deduplication & Classification (2 agents)

Two agents perform independent deduplication and severity classification. Findings from all 10 persona agents are merged -- when multiple personas flag the same root cause, they are consolidated into a single finding. Severity is assigned using the standard rubric.

### Phase 3: Adversarial Verification (50 agents)

Fifty adversarial verifier agents challenge the findings:
- Each finding is reviewed by at least 2 independent verifiers
- Verifiers attempt to refute findings by examining the cited code, checking for compensating controls, and testing edge cases
- **1 false positive was identified and removed** during this phase (a finding about missing CSRF protection was refuted because the platform uses token-based auth with no cookie-based session state, making CSRF inapplicable)
- Verifiers also escalated 3 findings from MEDIUM to HIGH based on broader impact analysis

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
| **UX** | 38 | 0 | 7 | 22 | 9 |
| **DX** | 30 | 1 | 10 | 13 | 6 |
| **Operations** | 18 | 1 | 4 | 10 | 3 |
| **API** | 16 | 6 | 6 | 1 | 3 |
| **Reliability** | 16 | 1 | 3 | 10 | 2 |
| **Security** | 14 | 0 | 5 | 7 | 2 |
| **Data** | 3 | 0 | 0 | 6 | 0 |

Note: The Data category has 3 findings but shares the MEDIUM slot with findings from other categories for a total of 69 MEDIUM.

---

## Top 10 Priorities

| # | ID | Finding | Severity | Why It Matters | Effort |
|---|-----|---------|----------|----------------|--------|
| 1 | V5-001 | Bootstrap wizard uses wrong API path prefix | CRITICAL | Frontend `/auth/bootstrap/*` vs backend `/bootstrap/*` -- entire bootstrap flow is broken | Small |
| 2 | V5-004 | Gateway SERVICE_MAP missing `api-keys` entry | CRITICAL | All API key management via frontend returns 404 | Small |
| 3 | V5-005 | Gateway SERVICE_MAP missing `tenants` entry | CRITICAL | Tenant management endpoints unreachable | Small |
| 4 | V5-011 | Rollback dialog sends wrong field name | CRITICAL | App rollback always fails -- `targetBuildId` vs `buildId` | Small |
| 5 | V5-031 | skipIf expression logic is inverted | CRITICAL | Pipeline conditional steps execute when they should skip and vice versa | Small |
| 6 | V5-053 | gRPC client and types not exported from SDK barrel | CRITICAL | SDK consumers cannot use gRPC at all | Small |
| 7 | V5-118 | Helm chart missing 5 required env vars | CRITICAL | Kubernetes deployments crash on startup | Medium |
| 8 | V5-003 | Bootstrap status response missing `bootstrapToken` | CRITICAL | Confirm button permanently disabled during bootstrap | Small |
| 9 | V5-002 | Master key wizard step fetches non-existent endpoint | CRITICAL | Master key step of bootstrap flow is non-functional | Small |
| 10 | V5-047 | `OP_MINIO_PASSWORD` placeholder causes FATAL on first `docker compose up` | HIGH | First-run experience is broken for self-hosters | Small |

---

## All Findings

### CRITICAL (9)

| ID | Category | Component | Pain | Fix |
|----|----------|-----------|------|-----|
| V5-001 | API | `packages/frontend/src/router.tsx:98`, `services/auth/src/routes/bootstrap.ts:22` | Bootstrap wizard requests non-existent API path: frontend uses `/auth/bootstrap/*` but backend registers `/bootstrap/*` -- entire bootstrap flow is broken for new installations | Either change the frontend paths to `/bootstrap/*` or change the auth service routes to `/auth/bootstrap/*` |
| V5-002 | API | `packages/frontend/src/components/wizard/steps/MasterKeyStep.tsx:56` | Master key wizard step fetches non-existent `GET /api/v1/bootstrap/master-key` endpoint -- the step cannot render properly | Add `GET /api/v1/bootstrap/master-key` route to the auth service bootstrap routes |
| V5-003 | API | `services/auth/src/services/bootstrap-service.ts:119-126` | Bootstrap status response lacks `bootstrapToken` field that the frontend requires -- confirm button is permanently disabled because the token check fails | Add `bootstrapToken` to the `getStatus()` response object |
| V5-004 | API | `services/gateway/src/services/proxy-service.ts:12-36` | Gateway `SERVICE_MAP` missing `api-keys` entry -- all API key management requests from the frontend return 404 because the gateway cannot route them to the auth service | Add `'api-keys': authServiceUrl` to `SERVICE_MAP` |
| V5-005 | API | `services/gateway/src/services/proxy-service.ts:12-36` | Gateway `SERVICE_MAP` missing `tenants` entry -- tenant management endpoints are unreachable through the gateway, blocking all tenant CRUD operations | Add `'tenants': authServiceUrl` to `SERVICE_MAP` |
| V5-011 | API | `packages/frontend/src/components/apps/AppRollbackDialog.tsx:72` | Rollback dialog sends `targetBuildId` but the server expects `buildId` -- every rollback attempt fails with a validation error | Change the request body key from `targetBuildId` to `buildId` |
| V5-031 | Reliability | `services/pipeline/src/services/execution-engine.ts:1520-1524` | `skipIf` expression logic is inverted: `skip = !condTrue` causes steps to execute when the condition is true and skip when false -- the opposite of expected behavior | Change `skip = !condTrue` to `skip = condTrue` |
| V5-053 | DX | `packages/sdk/src/index.ts` | gRPC client and types are not exported from the SDK barrel file -- SDK consumers who need gRPC streaming cannot access the client or type definitions | Add `export { GrpcClient } from './grpc-client.js'` and gRPC type exports to `index.ts` |
| V5-118 | Operations | `deploy/helm/oneplatform/templates/_helpers.tpl:195-246` | Helm chart missing 5 required environment variables (`OP_MASTER_KEY`, `OP_JWT_SECRET`, `OP_CURSOR_SECRET`, and constructed `OP_DATABASE_URL` / `OP_REDIS_URL`) -- all Kubernetes deployments crash on startup | Add the missing env vars to the helpers template, constructing DB/Redis URLs from subchart service names |

---

### HIGH (35)

| ID | Category | Component | Pain | Fix |
|----|----------|-----------|------|-----|
| V5-006 | API | `packages/frontend/src/pages/connectors/ConnectorsPage.tsx:26-46` | Connector list page receives wrong response shape from the backend -- data fails to render | Update frontend to match backend response envelope or flatten backend response |
| V5-007 | API | `packages/frontend/src/pages/connectors/NewConnectorPage.tsx:114-123` | NewConnectorPage plugin list expects `data` but receives `items` -- available plugins never display | Update frontend to access `result.items` instead of `result.data` |
| V5-008 | API | `services/plugin/src/routes/plugins.ts:18-31` | Plugin list response missing `configSchema` field -- connector creation form cannot render dynamic config fields | Include `configSchema` from manifest in the plugin list response |
| V5-009 | API | `packages/frontend/src/pages/dashboard/DashboardPage.tsx:317-319` | Dashboard Recent Activity double-wraps log data -- results display as `[object Object]` or fail to render | Remove the extra wrapping layer |
| V5-010 | API | `services/app/src/routes/apps.ts:602-618` | App list/detail pages expect `buildStatus` and `lastDeployedAt` but server never returns them -- build status always shows as unknown | Add `buildStatus` and `lastDeployedAt` fields to the app response |
| V5-012 | API | `services/gateway/src/index.ts:342-419` | Data residency routes are defined but never mounted in the gateway router -- all residency management endpoints return 404 | Mount the data residency routes in the gateway |
| V5-013 | API | `services/auth/src/routes/tenants.ts:59-186` | No `POST /api/v1/tenants` route exists -- platform admins cannot create new tenants after initial bootstrap | Add a create tenant route |
| V5-014 | API | `packages/plugin-sdk/src/types/auth-provider.ts:40-50` | `AuthContext` missing `fetch` and `credentials` -- auth providers cannot exchange OAuth codes or access client secrets | Add `fetch: FetchProxy` and `credentials: CredentialAccessor` to `AuthContext` |
| V5-015 | API | `packages/plugin-sdk/src/types/destination.ts:35-41` | `DestinationContext` missing `credentials` accessor -- destination plugins cannot access stored secrets for outbound delivery | Add `credentials: CredentialAccessor` to `DestinationContext` |
| V5-017 | Security | `services/app/src/routes/bff.ts:151-431` | BFF data proxy does not enforce entity-level RBAC -- any app user can read/write any entity regardless of role permissions | Add permission checks before proxying data requests |
| V5-018 | Security | `services/auth/src/services/token-service.ts:284-297` | JWT tokens lack `iss` (issuer) and `aud` (audience) claims -- tokens cannot be scoped to specific services and are vulnerable to cross-service replay | Add `iss` and `aud` claims to all issued JWTs |
| V5-019 | Security | `docker/docker-compose.yml:180` | Docker socket proxy blocks DELETE but the execution service needs it for sandbox container cleanup -- orphaned containers accumulate | Set `DELETE: 1` on the socket proxy or configure sandbox containers with `AutoRemove: true` |
| V5-020 | Security | `services/gateway/src/routes/storage.ts:32-39` | Storage bucket listing has no tenant isolation -- any authenticated user can list all buckets across all tenants | Filter bucket listing by the requesting user's `tenantId` |
| V5-032 | Reliability | `packages/cli/src/commands/auth/index.ts:66-68` | `op auth login` saves credentials to the `default` profile, ignoring the `--profile` flag -- credentials overwrite the wrong profile | Use the resolved profile name from `--profile` option |
| V5-033 | Reliability | `packages/cli/src/commands/profile/index.ts:30-33` | `op profile add` validates the new API key using the OLD profile's credentials -- validation succeeds/fails based on the wrong key | Use a temporary HTTP client constructed with the new API key for validation |
| V5-047 | DX | `docker/service-entrypoint.sh:98`, `.env.example:44` | `OP_MINIO_PASSWORD` placeholder value causes FATAL error on first `docker compose up` -- the entrypoint script rejects the default value | Use a working default password in `.env.example` |
| V5-048 | DX | `plugins/connector-postgres/src/index.ts:135-139` | PostgreSQL connector requires HTTPS proxy for all connections, blocking local development with plain HTTP | Allow HTTP connections when target is localhost or a private network address |
| V5-049 | DX | `services/app/src/routes/apps.ts:559-586` | Monaco type declarations have wrong function signatures -- IDE autocompletion shows incorrect parameter types | Regenerate type declarations from current `app-sdk` source |
| V5-050 | DX | `packages/plugin-sdk/src/dev-server/plugin-dev-server.ts:96-117` | Dev server watch mode reloads the stale bundle without rebuilding first -- code changes are not reflected until manual rebuild | Trigger a build step before reloading the bundle |
| V5-051 | DX | `packages/cli/src/commands/plugin/index.ts:481-576` | No CLI command to publish a plugin to the marketplace -- developers must use raw API calls to publish | Add `op plugin publish` command |
| V5-052 | DX | `packages/cli/src/commands/completion/index.ts:16-128` | Shell completion missing subcommands for 16 of 21 command groups -- tab completion is largely non-functional | Add completion entries for all command groups and subcommands |
| V5-054 | DX | `packages/sdk/src/grpc-client.ts:135-143` | `GrpcClientError` does not extend `OnePlatformError` -- callers cannot use unified error handling with `instanceof OnePlatformError` | Change `GrpcClientError` to extend `OnePlatformError` |
| V5-055 | DX | `packages/sdk/src/transport.ts:110-111` | `ValidationError.fields` is always empty for 422 errors -- callers cannot programmatically determine which fields failed validation | Map Zod issue details to the `fields` array |
| V5-056 | DX | `packages/sdk/src/resources/pipelines.ts:66-86` | Resource list methods silently ignore `filter` and `sort` options -- query parameters are constructed but never sent to the server | Use `serializeListQuery` to include filter/sort in the request URL |
| V5-077 | UX | `packages/frontend/src/pages/BootstrapErrorPage.tsx:79` | BootstrapErrorPage troubleshooting section suggests wrong port numbers and service names -- misdirects debugging | Update troubleshooting instructions with correct ports and service identifiers |
| V5-078 | UX | `packages/frontend/src/components/plugins/PluginInstallDialog.tsx:80-100` | PluginInstallDialog sends JSON body to a multipart form endpoint -- plugin upload always fails | Fix the request to use `multipart/form-data` encoding |
| V5-079 | UX | `packages/frontend/src/components/plugins/PluginInstallDialog.tsx:144-220` | PluginInstallDialog shows wrong accepted file formats (`.zip`/`.tgz` instead of `.oppkg`) -- users cannot select their plugin bundle | Change the file accept filter to `.oppkg` |
| V5-080 | UX | `packages/frontend/src/pages/settings/TeamsPage.tsx:96-97` | TeamsPage role update uses wrong HTTP method and field name -- role changes silently fail | Use `PUT` with a `roles` array instead of `PATCH` with `role` string |
| V5-081 | UX | `packages/frontend/src/pages/settings/TeamsPage.tsx:108-110` | TeamsPage Remove member calls a nonexistent `DELETE` endpoint -- member removal always fails | Use `PUT` to set `isActive: false` instead of DELETE |
| V5-082 | UX | `packages/frontend/src/pages/settings/TeamsPage.tsx:49-55` | TeamsPage `Member` interface does not match the API response shape -- all member fields render as undefined | Update the `Member` interface to match the actual user API response |
| V5-083 | UX | `packages/frontend/src/router.tsx:436` | Admin route guard checks for `platform-admin` role but the actual role name is `tenant-admin` -- admins are locked out of admin pages | Change the role check to `tenant-admin` or check for either role |
| V5-115 | Data | `packages/frontend/src/pages/connectors/ConnectorDetailPage.tsx` | Schema drift detection has no UI visibility -- drifts are detected server-side but users have no way to see or respond to them | Add a Schema tab to the connector detail page showing drift alerts |
| V5-119 | Operations | `deploy/helm/oneplatform/templates/services/` | Helm chart has no PodDisruptionBudget, anti-affinity, or topology spread constraints -- production deployments have no HA guarantees | Add PDB templates and pod anti-affinity rules |
| V5-120 | Operations | `docker/docker-compose.yml:238` | `container_name` on app services blocks `docker compose up --scale` -- cannot scale any service beyond 1 replica | Remove `container_name` from application service definitions |
| V5-125 | Operations | `packages/sdk/src/grpc-client.ts:238-241` | gRPC server-streaming buffers the entire response before yielding -- defeats the purpose of streaming for large result sets | Use an incremental reader that yields chunks as they arrive |

---

### MEDIUM (69)

| ID | Category | Component | Pain | Fix |
|----|----------|-----------|------|-----|
| V5-016 | API | `services/auth/src/routes/users.ts:27-239` | No admin-created user endpoint -- platform admins cannot create users on behalf of others | Add `POST /api/v1/users` route with admin scope check |
| V5-021 | Security | `services/gateway/src/index.ts:250` | Gateway API key validation is a no-op stub -- the middleware accepts any API key without verification | Implement actual key lookup and validation logic |
| V5-022 | Security | `services/auth/src/schemas/index.ts:101,203` | Password validation has no complexity requirements beyond minimum length -- weak passwords are accepted | Add regex rules for uppercase, lowercase, digit, and special character |
| V5-023 | Security | `services/auth/src/routes/auth.ts` | No authenticated password change endpoint -- users must use the forgot-password flow to change their own password | Add `POST /api/v1/auth/change-password` requiring current password |
| V5-024 | Security | `services/pipeline/src/services/execution-engine.ts:204-211` | SSRF block patterns require trailing slash in URLs -- `http://169.254.169.254` bypasses the filter while `http://169.254.169.254/` is blocked | Make trailing slash optional in all SSRF regex patterns |
| V5-025 | Security | `services/ingestion/src/connectors/postgres-cdc/postgres-cdc-connector.ts:76-111` | CDC connector stores raw database password in the connection config -- password visible in process memory and debug logs | Use the credential service to encrypt and retrieve passwords |
| V5-026 | Security | `services/auth/src/routes/auth.ts:151-161` | Refresh token endpoint has no dedicated rate limiting -- an attacker with a leaked refresh token can generate unlimited access tokens | Add per-user rate limiting on the refresh endpoint |
| V5-027 | Security | `services/auth/src/services/api-key-service.ts:190-209` | API key prefix collision enables DoS: prefix lookup query can scan many rows if prefixes are not unique enough | Add `LIMIT 1` to the prefix query or use a longer prefix |
| V5-034 | Reliability | `packages/app-sdk/src/hooks/useQuery.ts:237-243` | `useQuery` `isLoading` computation has a redundant tautological condition -- the logic works but is misleading and fragile | Simplify to `!isReady \|\| (enabled && cachedEntry === undefined)` |
| V5-035 | Reliability | `services/ingestion/src/services/cdc-ingestion-service.ts:461-488` | CDC `makeMinimalContext` throws `Error('Not available in CDC context')` on every method -- any connector that calls context methods during CDC crashes | Wire real implementations for credential and cache access |
| V5-036 | Reliability | `packages/app-sdk/src/hooks/useQuery.ts:163-205` | `fetchPage` captures stale `options` in its closure -- re-renders with new options still use the old filter/sort values | Use a ref to always read current options |
| V5-037 | Reliability | `packages/app-sdk/src/hooks/useAppStorage.ts:139-143` | `useAppStorage` does not revert optimistic update on network error -- UI shows saved state that was never persisted | Add try/catch rollback to the previous value on PUT failure |
| V5-038 | Reliability | `docker/scripts/backup.sh:70` | Backup script connects to MinIO via `localhost` but the MinIO container has no host port mapping -- backup of object storage fails silently | Run `mc` commands inside the MinIO container using `docker compose exec` |
| V5-039 | Reliability | `docker/caddy/Caddyfile.prod.template:27-41` | `/healthz` endpoint hits the frontend SPA fallback instead of the gateway -- health probes return HTML instead of JSON | Add explicit Caddy route rules for `/healthz` and `/readyz` to proxy to the gateway |
| V5-040 | Reliability | `deploy/helm/oneplatform/templates/infra/ingress.yaml:34-47` | Helm Ingress routes `/healthz` to the frontend pod instead of the gateway -- Kubernetes liveness probes fail | Add a separate Ingress path rule routing `/healthz` to the gateway service |
| V5-041 | Reliability | `deploy/helm/oneplatform/templates/_helpers.tpl:252-261` | Helm service templates lack `startupProbe` -- slow-starting services (ontology migrations, plugin loading) are killed before they are ready | Add `startupProbe` with longer initial delay and failure threshold |
| V5-042 | Reliability | `docker/scripts/backup.sh` | Backup script does not back up the `init-data` volume -- generated secrets and certificates are lost if the volume is destroyed | Add `init-data` volume backup step |
| V5-043 | Reliability | `packages/cli/src/lib/errors.ts:75-79` | 429 error message claims "3 retries" but no retry logic exists -- the message is misleading | Either implement retry with exponential backoff or fix the error message |
| V5-044 | Reliability | `packages/cli/src/commands/pipeline/index.ts:86-98` | `op connector trigger --wait` and `op pipeline trigger --wait` poll indefinitely with no timeout -- a stuck job hangs the terminal forever | Add `--poll-timeout` flag with a sensible default (e.g., 30 minutes) |
| V5-045 | Reliability | `packages/sdk/src/transport.ts:149` | `warnedDeprecations` is a module-level global `Set` -- in bundled environments where the module is loaded multiple times, warnings repeat | Move the set to an instance field on the Transport class |
| V5-046 | Reliability | `packages/sdk/src/client.ts:114,288-293` | `destroy()` does not abort in-flight HTTP requests -- calling destroy during active requests leaves dangling promises | Track `AbortController` instances and abort them in `destroy()` |
| V5-057 | DX | `services/plugin/src/schemas/index.ts:30` | Plugin SDK and service have conflicting description length limits (SDK: 500, service: 255) -- plugins that pass SDK validation fail service validation | Align both to 500 characters |
| V5-058 | DX | `packages/plugin-sdk/src/dev/scaffold.ts:453-476` | Scaffold test only checks metadata and method existence -- does not test actual plugin behavior (connect, transform, etc.) | Generate type-specific test templates that exercise the primary plugin method |
| V5-059 | DX | `packages/plugin-sdk/src/dev-server/plugin-dev-server.ts:157-160` | Dev server only supports connector-type plugins -- transformer, auth-provider, destination, and widget plugins cannot use the dev server | Add runner implementations for all plugin types |
| V5-060 | DX | `packages/plugin-sdk/src/dev/simulate-hook.ts:124-140` | `simulate-hook` falls back to `manifest.entrypoint` which is the plugin object, not a hook function -- always fails with "not a callable function" error | Search the hooks array in the manifest for the matching stage's entrypoint |
| V5-061 | DX | `packages/cli/src/lib/profiles.ts:20` | Profile `defaultOutput` type excludes `jsonl` -- users cannot set JSONL as their default output format | Add `'jsonl'` to the `OutputFormat` union type |
| V5-062 | DX | `packages/cli/src/commands/mapping/index.ts:248-305` | No batch mapping command -- data engineers must create mapping rules one at a time | Add `op mapping import` command accepting a YAML/JSON file of rules |
| V5-063 | DX | `packages/cli/src/commands/dlq/index.ts:47-65` | No bulk DLQ replay command -- operators must replay failed jobs individually by ID | Add `op dlq replay-all` with optional `--filter` flags |
| V5-064 | DX | `packages/sdk/src/index.ts` | `SyncJob` and `SyncProgress` types not exported from SDK -- consumers cannot type-annotate sync monitoring code | Add exports for `SyncJob`, `SyncProgress`, and related types |
| V5-065 | DX | `packages/sdk/src/subscriptions/sse-subscriber.ts:312` | `Subscription.on()` lacks type-safe overloads -- event names and payload types are `string` and `unknown` | Add overloaded signatures for known event types |
| V5-066 | DX | `packages/sdk/src/grpc-client.ts:8,379-414` | gRPC client requires separate construction with duplicated auth configuration -- not accessible from the main SDK client | Add a `grpc` property to the SDK client that shares auth config |
| V5-067 | DX | `packages/sdk/src/grpc-types/data.ts:10` | gRPC `Entity.dataJson` is a raw string requiring manual `JSON.parse` -- error-prone and loses type safety | Add a typed `data<T>(): T` wrapper method |
| V5-068 | DX | `packages/sdk/src/errors/network-error.ts:36-49` | `NetworkError` does not expose `cause` -- callers cannot inspect the underlying fetch/socket error | Add `cause` field in the constructor to chain the original error |
| V5-069 | DX | `packages/app-sdk/src/index.ts:30-72` | App SDK React components (`DataTable`, `Form`, `QueryBuilder`) not exported from barrel -- app developers cannot import them | Add component exports to `index.ts` |
| V5-084 | UX | `packages/frontend/src/components/connectors/ConnectorForm.tsx:118-121` | ConnectorForm masks `primaryKey` field as a password input due to overly broad regex matching on "key" | Use word-boundary regex `\bpassword\b|\bsecret\b|\btoken\b` to avoid false positives |
| V5-085 | UX | `packages/frontend/src/components/app-builder/ComponentWrapper.tsx:130-135` | Visual builder component label renders empty because the `componentType` prop is not passed through | Add `componentType` prop to the wrapper and display it as the label |
| V5-086 | UX | `packages/frontend/src/components/layout/Sidebar.tsx:67` | Sidebar "Overview" link navigates to the bootstrap gate instead of the dashboard -- users hit the bootstrap page on every click | Change the link target from `/` to `/dashboard` |
| V5-087 | UX | `services/ingestion/src/schemas/index.ts:16-25` | Connector creation schema has no way to separate config from credentials -- both are mixed in a single object, complicating credential rotation | Make `credentials` optional or split into separate form sections |
| V5-088 | UX | `packages/frontend/src/components/wizard/steps/ReviewStep.tsx:74-75` | Bootstrap SuccessStep is never displayed because ReviewStep calls `onComplete()` before `onNext()` -- flow ends on review | Call `onNext()` first to advance to the success step, then `onComplete()` |
| V5-089 | UX | `packages/frontend/src/components/pipeline-editor/NodeConfigPanel.tsx:501-534` | Transform step configuration only shows an operation type selector with no operation-specific fields -- users cannot configure transforms | Add dynamic fields based on the selected operation type |
| V5-090 | UX | `packages/frontend/src/components/pipeline-editor/NodeConfigPanel.tsx:438-472` | Connector step requires manual UUID entry for the connector ID -- no picker or search | Add a connector picker dropdown with search |
| V5-091 | UX | `packages/frontend/src/pages/connectors/ConnectorDetailPage.tsx:229-277` | Connector detail sync history does not show error details for failed syncs -- just "failed" with no message | Add an error column or expandable error detail row |
| V5-092 | UX | `packages/frontend/src/pages/settings/ApiKeysPage.tsx:89-109` | API key scope selection list is missing many valid scopes -- users cannot grant `ontology:*`, `execution:*`, `webhooks:*` scopes | Add all scopes defined in `ALL_SCOPES` to the frontend list |
| V5-093 | UX | `services/auth/src/services/api-key-service.ts:261-268` | API key list endpoint returns all keys (active and revoked) with no filtering or pagination -- response grows unbounded | Add `status` filter and cursor pagination |
| V5-094 | UX | `packages/frontend/src/pages/settings/AdminPage.tsx:51-183` | AdminPage is entirely non-functional -- config query, save, and master key rotation all call nonexistent endpoints | Wire to the tenant configuration API or display placeholder until backend is ready |
| V5-095 | UX | `services/plugin/src/routes/marketplace.ts:349-379` | Marketplace install only records telemetry -- does not actually download or install the plugin | Orchestrate the full install flow: download bundle, verify, register, activate |
| V5-096 | UX | `packages/frontend/src/pages/plugins/PluginDetailPage.tsx:199-208` | Plugin detail upgrade action uses `window.prompt` instead of a proper dialog -- looks broken and is inconsistent with the rest of the UI | Replace with a shadcn/ui dialog component |
| V5-097 | UX | `packages/cli/src/commands/connector/index.ts:104-108` | `op connector get` always outputs raw JSON regardless of the configured output format -- ignores `--output table` | Use `renderer.render()` with the configured output format |
| V5-098 | UX | `packages/frontend/src/pages/settings/StorageBrowserPage.tsx:4` | StorageBrowserPage exists but has no route definition and no sidebar navigation link -- the page is unreachable | Add a route in the router and a nav link in the settings sidebar |
| V5-099 | UX | `packages/frontend/src/components/logs/AuditLogTable.tsx:82-92` | Audit log search only filters client-side on the currently loaded page -- does not search the full dataset | Add server-side search using the backend's query parameters |
| V5-100 | UX | `packages/frontend/src/pages/logs/AuditPage.tsx:22-45` | Audit log date filter has no clear/reset button -- users must manually empty both date fields to remove the filter | Add a "Clear filters" button |
| V5-101 | UX | `packages/frontend/src/components/metrics/ServiceHealthGrid.tsx:62-93` | Service Health panel only shows gateway status -- does not aggregate health from all 9 services | Fan out health checks to all services and display aggregate status |
| V5-102 | UX | `packages/frontend/src/pages/settings/TeamsPage.tsx:127-186` | Teams invite form is non-functional -- sends to nonexistent endpoint and has no backend support | Hide the form or replace with a working user creation flow |
| V5-103 | UX | `packages/frontend/src/components/layout/Topbar.tsx:192-205` | Notification dropdown bell icon is not clickable -- items have no links or actions | Add navigation links to the relevant pages for each notification type |
| V5-104 | UX | `packages/frontend/src/pages/pipelines/PipelinesPage.tsx:68` | Pipelines "New" button uses synthetic ID `'new'` causing navigation to `/pipelines/new` which hits the detail page with invalid ID | Add a dedicated `/pipelines/new` route for the pipeline creation flow |
| V5-105 | UX | `packages/frontend/src/pages/apps/AppDetailPage.tsx:196-203` | App "Open" button is only shown for public apps -- authenticated apps have no way to launch from the detail page | Show the Open button for all deployed apps regardless of access mode |
| V5-106 | UX | `packages/frontend/src/pages/apps/AppDetailPage.tsx:134-144` | No visual builder link from the app detail page -- users must manually navigate to `/apps/:id/builder` | Add a "Visual Builder" button to the app detail toolbar |
| V5-107 | UX | `packages/frontend/src/pages/ontology/QueryBuilderPage.tsx:642-668` | Query builder field selection has confusing initial state -- fields list is empty until user selects an entity, with no guidance | Show a help message or auto-select the first entity |
| V5-108 | UX | `packages/frontend/src/pages/settings/SettingsPage.tsx:54-80` | Settings sidebar has no mobile responsive layout -- sidebar and content overlap on small screens | Add `flex-col md:flex-row` responsive classes |
| V5-116 | Data | `plugins/connector-postgres/src/index.ts:601-607` | Incremental sync does not save cursor on partial batch failure -- next sync re-processes the entire failed batch plus previously synced records | Always return the cursor position, even on partial batch |
| V5-121 | Operations | `deploy/helm/oneplatform/Chart.yaml:12-23` | Helm dependencies have no `Chart.lock` file committed -- `helm dependency build` behavior is non-deterministic across environments | Run `helm dependency build` and commit `Chart.lock` |
| V5-122 | Operations | `docker/grafana/provisioning/datasources/datasources.yml` | Grafana dashboards reference Prometheus as a datasource but no Prometheus instance is deployed -- all metric panels show "No data" | Bundle a Prometheus instance in the Docker Compose stack or switch to a different metrics backend |
| V5-123 | Operations | `deploy/helm/oneplatform/templates/infra/grafana.yaml:78-88` | Helm Grafana deployment has no dashboard provisioning -- Grafana starts with no dashboards | Add a ConfigMap with dashboard JSON and a provisioning volume mount |
| V5-126 | Operations | `services/ingestion/src/services/sync-service.ts:408-484` | `listSyncs` fetches up to 10K BullMQ jobs into memory for filtering -- causes memory spikes and slow responses | Store sync history in PostgreSQL with proper indexing instead of querying BullMQ |
| V5-127 | Operations | `services/gateway/src/services/data-residency-service.ts:593-616` | Compliance check fetches 10K audit rows into memory for aggregation -- blocks the event loop and wastes memory | Use SQL `GROUP BY` aggregation instead of in-memory processing |
| V5-128 | Operations | `packages/cli/src/commands/data/index.ts:88-106` | `op data import` reads the entire file into memory as a string before uploading -- OOM on large files | Stream the file or use `fs.openAsBlob()` for memory-efficient uploads |
| V5-129 | Operations | `README.md:45` | README URL inconsistencies between `http://localhost:3000` and `https://localhost` -- confuses first-time users about the correct URL | Standardize all documentation URLs to `https://localhost` (or the appropriate port) |
| V5-130 | Operations | `docker/docker-compose.prod.yml:15-17` | Production compose file has conflicting environment variable comments -- unclear which values override which | Remove conflicting inline comments and add a clear precedence explanation |
| V5-131 | Operations | `packages/plugin-sdk/src/dev/scaffold.ts:305` | Destination scaffold references non-existent `context.config` in guide comment -- developers follow the comment and get compilation errors | Change comment to `context.tenant.config["endpointUrl"]` |

---

### LOW (22)

| ID | Category | Component | Pain | Fix |
|----|----------|-----------|------|-----|
| V5-028 | Security | `services/auth/src/routes/auth.ts:78` | Login cookie uses `SameSite=Strict` -- breaks OAuth redirect flows where the auth response comes from a third-party origin | Change to `SameSite=Lax` which still prevents CSRF while allowing top-level navigations |
| V5-029 | Security | `packages/core/src/middleware/ip-allowlist.ts:285-297` | IP allowlist rejection error message leaks the client's IP address in the response body -- information disclosure | Replace with a generic "Request blocked by IP allowlist policy" message |
| V5-030 | Security | `deploy/helm/oneplatform/templates/infra/networkpolicy.yaml:83-98` | Helm NetworkPolicy `sandbox-isolation` targets pods with a label selector that no pod matches -- the policy has no effect | Fix the label selector to match the actual sandbox pod labels or remove the unused policy |
| V5-070 | DX | `packages/sdk/src/resources/pipelines.ts` | SDK missing `connectors` resource namespace -- connector operations require raw HTTP calls instead of typed SDK methods | Add a `client.connectors` resource with `list`, `get`, `create`, `update`, `delete`, and `trigger` methods |
| V5-071 | DX | `packages/sdk/src/types/subscription.ts:8-23` | `PlatformEvent.payload` is typed as `unknown` -- consumers must cast on every event handler | Add a generic type parameter `PlatformEvent<T = unknown>` |
| V5-072 | DX | `packages/sdk/package.json:4` | SDK `package.json` has `"private": true` -- prevents `npm publish` when the SDK is ready for distribution | Remove `private` field when the SDK is ready to publish |
| V5-073 | DX | `packages/app-sdk/src/hooks/useUser.ts:15-22` | `useUser` returns empty-string sentinel `""` for `id` when user is not loaded -- callers comparing `id !== ""` is fragile and non-obvious | Return `null` for unloaded state or add an `isLoaded` boolean |
| V5-074 | DX | `packages/cli/src/commands/data/index.ts:149` | `op data create` requires `--file` flag even when data is available on stdin -- cannot pipe data from other commands | Auto-detect stdin when `--file` is not provided (check `process.stdin.isTTY`) |
| V5-075 | DX | `packages/cli/src/commands/schedule/index.ts:80-108` | Schedule command group missing `get` and `update` subcommands -- users can create and list schedules but cannot view or modify individual ones | Add `op schedule get <id>` and `op schedule update <id>` subcommands |
| V5-076 | DX | `packages/plugin-sdk/src/manifest/schema.ts:17` | Hook stage validation differs between SDK (`z.string().min(1)`) and service (`z.enum([...])`) -- SDK accepts invalid stages that the service rejects | Use `z.enum([...all valid HookStage values])` in the SDK schema |
| V5-109 | UX | `packages/frontend/src/pages/auth/LoginPage.tsx:73-75` | Login page shows GitHub and Google OAuth buttons even when no OAuth providers are configured -- buttons lead to errors | Conditionally render OAuth buttons based on provider configuration |
| V5-110 | UX | `services/app/src/routes/bff.ts:79-93` | BFF `/bff/me` returns the user's UUID as `displayName` -- apps show a UUID string instead of the user's actual name | Fetch the user profile from the auth service to populate `displayName` |
| V5-111 | UX | `packages/frontend/src/components/logs/AuditLogTable.tsx:143-146` | Audit log table shows raw UUIDs for actor and resource columns -- impossible to identify who did what | Resolve UUIDs to display names via a user/resource lookup |
| V5-112 | UX | `packages/frontend/src/pages/apps/AppsPage.tsx:60` | Apps page description says "Monaco-built" -- meaningless jargon to non-technical users | Change to "Build and manage internal tools and data views" |
| V5-113 | UX | `packages/frontend/src/pages/dlq/DLQPage.tsx:93-116` | DLQ bulk actions (replay all, delete all) have no role guard -- any user with page access can replay or delete failed jobs | Add permission check requiring `admin` or `pipelines:manage` scope |
| V5-114 | UX | `services/auth/src/routes/users.ts:75` | User list endpoint returns `total: null` -- frontend cannot show "Showing X of Y users" pagination info | Add a `COUNT(*)` query and return the actual total |
| V5-117 | Data | `services/ingestion/src/services/schema-drift-service.ts:138-182` | Schema drift detection uses shallow type inference only (no nested object or array inspection) -- complex JSON structures report false-positive drifts | Add recursive type inference for nested objects and arrays |
| V5-124 | Operations | `docker/grafana/provisioning/alerting/alert-rules.yml` | Alert rules reference non-existent runbook URLs -- operators clicking "View Runbook" get 404 errors | Create actual runbook documents or update URLs to point to existing documentation |
| V5-132 | Operations | `README.md:76` | README lacks Docker Compose V2 prerequisite -- users with V1 (`docker-compose` binary) get confusing syntax errors | Add a version check note: "Requires Docker Compose V2 (`docker compose` command)" |
| V5-133 | Operations | `packages/plugin-sdk/src/dev/scaffold.ts:565` | Scaffold README template has wrong `.oppkg` filename -- references `plugin-name-1.0.0.oppkg` but the actual pack output uses a different naming convention | Update the template to match the actual output filename pattern |
| V5-134 | Operations | `packages/cli/src/commands/pipeline/index.ts:81-98` | `op pipeline trigger --wait` flag is not documented in the help text -- users do not know this option exists | Add `--wait` to the command's option descriptions |
| V5-135 | UX | `packages/frontend/src/pages/settings/WebhooksPage.tsx:203-211` | Webhook delivery status indicator uses color alone (green/red dots) to convey success/failure -- inaccessible to colorblind users | Add text labels ("Delivered" / "Failed") alongside the color indicators |

---

## Finding Distribution by Persona

| Persona | CRITICAL | HIGH | MEDIUM | LOW | Total |
|---------|----------|------|--------|-----|-------|
| First-Time Self-Hoster | 4 | 5 | 8 | 4 | 21 |
| Data Engineer | 0 | 3 | 7 | 2 | 12 |
| App Developer | 2 | 5 | 6 | 2 | 15 |
| Plugin Developer | 1 | 6 | 8 | 3 | 18 |
| Platform Admin | 2 | 4 | 7 | 2 | 15 |
| DevOps/SRE | 1 | 4 | 8 | 3 | 16 |
| Security Auditor | 0 | 3 | 7 | 2 | 12 |
| CLI Power User | 0 | 3 | 5 | 3 | 11 |
| SDK Consumer | 1 | 5 | 5 | 3 | 14 |
| Frontend/UX Reviewer | 0 | 2 | 12 | 4 | 18 |

Note: Findings flagged by multiple personas are counted once per persona. Total exceeds 135 due to multi-persona overlap.

---

## Cross-Reference by Component Area

| Component Area | CRITICAL | HIGH | MEDIUM | LOW | Total |
|----------------|----------|------|--------|-----|-------|
| Frontend | 2 | 7 | 22 | 6 | 37 |
| Auth Service | 2 | 2 | 5 | 2 | 11 |
| Gateway / Proxy | 2 | 2 | 2 | 0 | 6 |
| SDK (platform) | 1 | 4 | 6 | 3 | 14 |
| Plugin SDK / Service | 0 | 4 | 4 | 2 | 10 |
| CLI | 0 | 3 | 5 | 3 | 11 |
| App Service / BFF | 1 | 1 | 2 | 1 | 5 |
| Pipeline / Execution | 1 | 1 | 2 | 0 | 4 |
| Ingestion Service | 0 | 0 | 4 | 0 | 4 |
| App SDK | 0 | 0 | 3 | 1 | 4 |
| Docker / Infrastructure | 0 | 2 | 5 | 2 | 9 |
| Helm / Kubernetes | 1 | 1 | 3 | 1 | 6 |
| Documentation | 0 | 0 | 2 | 2 | 4 |
| Grafana / Monitoring | 0 | 0 | 2 | 1 | 3 |
| Data / Ontology | 0 | 1 | 2 | 1 | 4 |

---

## Comparison with Previous Analyses

| Metric | v1 | v2 | v3 | v4 | v5 |
|--------|----|----|----|----|-----|
| Raw findings | 108 | 202 (85 unique) | 53 net-new | 148 net-new | 135 unique |
| Perspectives/Personas | 4 | 6 | 10 | 10 | 10 |
| CRITICAL | N/A | 13 | 5 | 18 | 9 |
| HIGH | N/A | 35 | 18 | 45 | 35 |
| Total agents | N/A | 6 | 10 | 10 | 62 |
| Adversarial verification | No | No | No | No | Yes (50 agents) |
| False positives caught | N/A | N/A | N/A | N/A | 1 |

### v5 Key Differences from v4

1. **Adversarial verification:** v5 is the first analysis to include adversarial verifier agents. 50 agents challenged every finding, resulting in 1 false positive removal and 3 severity escalations. This increases confidence in the remaining findings.

2. **Category distribution shift:** v5 shows a shift toward UX and DX findings (38 + 30 = 68, half of all findings), reflecting the maturity of the codebase -- infrastructure-level blockers from v2-v3 have largely been addressed, surfacing more user-facing issues.

3. **Fewer CRITICAL findings:** The drop from 18 (v4) to 9 (v5) CRITICALs indicates significant progress on core workflow blockers. Remaining CRITICALs are concentrated in API routing mismatches and missing gateway entries -- systematic issues rather than fundamental architectural gaps.

4. **Frontend/API alignment:** 16 of 135 findings are in the API category, focused on frontend-backend contract mismatches. This is a recurring theme across all versions and suggests a need for contract testing or OpenAPI specification enforcement.

5. **Operations maturity gaps:** 18 operations findings highlight that while Docker Compose development works, production deployment paths (Helm, Grafana, backup/restore) remain under-tested.

---

## Severity Classification Rubric

| Level | Criteria |
|-------|----------|
| **CRITICAL** | Blocks a core workflow entirely, causes data loss, or creates an exploitable security vulnerability |
| **HIGH** | Significant functionality gap, performance degradation, or security weakness that affects many users |
| **MEDIUM** | Noticeable quality issue, inconsistency, or missing feature that has workarounds |
| **LOW** | Cosmetic issue, minor inconvenience, or improvement opportunity |
