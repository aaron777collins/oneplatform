# OnePlatform User Story Analysis v2

**Date:** 2026-06-13
**Method:** 6-perspective automated analysis
**Previous analysis:** [USER-STORIES-ANALYSIS.md](./USER-STORIES-ANALYSIS.md) (108 friction points)
**This analysis:** 202 raw findings across 6 perspectives, deduplicated to 85 unique findings

---

## Summary Table

| Severity | Count |
|----------|-------|
| CRITICAL | 13    |
| HIGH     | 35    |
| MEDIUM   | 31    |
| LOW      | 6     |
| **Total unique findings** | **85** |

---

## Methodology

This analysis applies six distinct user perspectives to the OnePlatform codebase simultaneously. Each perspective produces a set of findings from its vantage point. Raw findings are then deduplicated — when multiple perspectives flag the same root cause, they are merged into a single finding with all contributing perspectives noted. This approach surfaces both technical defects visible only to specialists (security reviewers, ops engineers) and experiential failures visible only to end users.

### Perspectives Applied

| Perspective | Focus Area |
|-------------|------------|
| **data-engineer** | Connector setup, ingestion pipelines, ontology mapping, scheduler wiring |
| **app-developer** | SDK ergonomics, BFF hooks, type accuracy, build/deploy lifecycle |
| **plugin-author** | Plugin scaffold quality, pack/publish flow, simulation tooling, GPG verification |
| **ops-admin** | Docker Compose completeness, secret hygiene, logging, resource limits, TLS |
| **new-user** | First-run experience, routing, onboarding UI, error messages, documentation gaps |
| **security-reviewer** | Auth flows, header injection, scope coverage, encryption, container hardening |

---

## Top 10 Priorities

These findings represent the highest-impact, most actionable items. Several are single-line or two-line fixes with outsized consequences.

| # | Finding | Severity | Why It Matters | Effort |
|---|---------|----------|----------------|--------|
| 1 | Strip `X-User-Context` header in gateway proxy | CRITICAL | Enables full impersonation via header injection — any external caller can set their own identity | Single-line fix in `HEADERS_TO_STRIP` set |
| 2 | Generate real passwords for Postgres/Redis/PgBouncer in `init.sh` | CRITICAL | All 20+ service credentials are publicly known `CHANGE_ME_*` strings — found by 4 perspectives | Extend `init.sh` with `openssl rand` calls |
| 3 | Add application service containers to `docker-compose.yml` | CRITICAL | Platform is completely non-functional out of the box — `docker compose up` starts only databases | Add all 9 service definitions |
| 4 | Add `execution:read` to `ALL_SCOPES` in `token-service.ts` | CRITICAL | All execution GET endpoints are broken for all users including admins | Single-line fix |
| 5 | Fix `BffClient` to send `X-App-Id` header | CRITICAL | Every app-sdk hook call fails with 400 — breaks the entire hosted app platform | Accept `appId` in constructor, include in headers |
| 6 | Generate Ed25519 service key pairs in `init.sh` | CRITICAL | All `/internal/*` service-to-service routes fail authentication — inter-service communication is broken | Extend `init.sh` |
| 7 | Add `OP_DATABASE_URL` and `OP_REDIS_URL` to `.env.example` | CRITICAL | Services crash on startup with cryptic Zod validation errors | 2-line documentation fix |
| 8 | Add stdout/stderr transport to logger | HIGH | `docker logs` captures nothing; Redis failures silently drop all logs — complete ops blindness | Add console transport to `createApp()` |
| 9 | Add HTTP security headers middleware | HIGH | No HSTS, no `X-Content-Type-Options`, no `X-Frame-Options` on any response | Middleware in `createApp()` |
| 10 | Fix post-bootstrap routing to render inside `AppShell` | CRITICAL | After bootstrap, dashboard renders without navigation sidebar — user is trapped on a bare page | Redirect to proper authenticated route |

---

## All Findings

### CRITICAL (13)

| ID | Category | Component | Pain | Fix | Perspectives |
|----|----------|-----------|------|-----|--------------|
| C-01 | Security | `services/gateway/src/services/proxy-service.ts` (`HEADERS_TO_STRIP`) | `X-User-Context` header is **not** stripped from external requests, enabling full identity impersonation by any caller | Add `'x-user-context'` to `HEADERS_TO_STRIP` | Security Reviewer |
| C-02 | Security | `docker/redis/users.acl`, `docker/pgbouncer/userlist.txt`, `docker/postgres/init.sql` | All service passwords hardcoded as `CHANGE_ME_*` — publicly known, committed to source | Generate unique random passwords in `init.sh` using `openssl rand` | Data Engineer, Ops Admin, Security Reviewer, New User |
| C-03 | Reliability | `docker/docker-compose.yml` (services section) | Only infrastructure containers (Postgres, Redis, PgBouncer) are defined — application services are absent; `docker compose up` starts an empty platform | Add all 9 application service definitions | Ops Admin, New User |
| C-04 | Security | `services/auth/src/services/token-service.ts` (`ALL_SCOPES`) | `execution:read` scope is missing from `ALL_SCOPES` — all execution GET endpoints return 403 for all users including admins | Add `execution:read` to `ALL_SCOPES` and role scope assignments | Security Reviewer |
| C-05 | Security | `docker/docker-compose.yml`, all services | No TLS anywhere in the stack — all service-to-service and client-to-service communication is plaintext | Add reverse proxy (Caddy/nginx), enable PostgreSQL and Redis TLS | Ops Admin, Security Reviewer |
| C-06 | Reliability | `docker/init/init.sh` | Ed25519 service key pairs are never generated — all `/internal/*` service-to-service routes fail authentication at startup | Extend `init.sh` to generate Ed25519 key pairs and inject them as environment variables | Ops Admin |
| C-07 | DX | `.env.example` | `OP_DATABASE_URL` and `OP_REDIS_URL` are absent from `.env.example` — services crash on first run with opaque Zod validation errors rather than actionable messages | Add both variables with documented defaults | Ops Admin, New User |
| C-08 | DX | `packages/app-sdk/src/client/BffClient.ts` | `X-App-Id` header is never sent — every app-sdk hook call (`useQuery`, `useMutation`, `useSubscription`) fails with HTTP 400, breaking the entire hosted app platform | Accept `appId` in `BffClient` constructor; include `X-App-Id` in all request headers | App Developer |
| C-09 | DX | `packages/app-sdk/src/provider/AppProvider.tsx`, `PermissionCache.ts` | Permission response shape from BFF is incompatible with what `PermissionCache` expects — all permission checks silently return `false` | Align response envelope format between BFF and cache | App Developer |
| C-10 | DX | `packages/cli/src/commands/plugin/index.ts` (`createAction`) | `op plugin create` generates a scaffold that does not compile — missing imports and incorrect type references | Delegate scaffold generation to `plugin-sdk`'s `generateScaffold()` | Plugin Author |
| C-11 | DX | `packages/cli/src/commands/plugin/index.ts` (`packAction`) | `op plugin pack` is a non-functional stub that exits immediately with no output or error | Wire to `plugin-sdk`'s `packPlugin()` | Plugin Author |
| C-12 | DX | `packages/cli/src/commands/plugin/index.ts` (`simulateHookAction`) | `op plugin simulate-hook` requires a running server but `plugin-sdk` has a local, server-free implementation | Delegate to SDK's `runSimulateHook()` | Plugin Author |
| C-13 | UX | `packages/frontend/src/router.tsx` | After completing bootstrap, the dashboard is rendered outside `AppShell` — no navigation sidebar, no header; user cannot navigate anywhere | Redirect to the proper authenticated route that renders inside `AppShell` | New User |

---

### HIGH (35)

| ID | Category | Component | Pain | Fix | Perspectives |
|----|----------|-----------|------|-----|--------------|
| H-01 | Security | `packages/core/src/middleware/auth.ts` | Blanket `/internal/*` auth bypass — any external request that reaches an `/internal/` path skips authentication entirely | Remove blanket bypass; use explicit, per-route allowlists | Security Reviewer |
| H-02 | Security | `services/auth/src/services/auth-service.ts` | JWT tokens delivered only in response body — no `httpOnly` cookie option, making XSS token theft straightforward | Implement dual-mode token delivery (body + secure `httpOnly` cookie) | Security Reviewer |
| H-03 | Security | `services/auth/src/services/auth-service.ts` | Password reset link is returned directly in the API response when SMTP is not configured — production deployments leak reset URLs to callers | Guard against returning reset links in non-development environments | Security Reviewer |
| H-04 | Security | `services/auth/src/services/api-key-service.ts` | No scope validation on API key creation — callers can request scopes they do not possess, allowing privilege escalation via API keys | Validate that requested scopes are a strict subset of the requesting user's scopes | Security Reviewer |
| H-05 | Security | `services/auth/src/routes/users.ts` | No role validation on user update endpoint — any authenticated user can set another user's role to any value including `platform-admin` | Validate role names against allowed list; enforce role hierarchy on assignment | Security Reviewer |
| H-06 | Security | `services/auth/src/routes/users.ts` | Deactivating a user does not revoke their active sessions or tokens — deactivated users retain access until token expiry | Revoke all tokens and sessions on user deactivation | Security Reviewer |
| H-07 | Security | `services/gateway/src/routes/admin.ts` | Role check uses string `'admin'` but the actual role name is `'platform-admin'` — admin routes are inaccessible to real admins | Use scope-based check instead of role string comparison | Security Reviewer, Ops Admin |
| H-08 | Security | `services/auth/src/services/token-service.ts` | Replay detection uses Redis `SCAN`, which is a DoS vector on large keyspaces — scanning can block the Redis event loop | Replace with per-family Redis set for O(1) lookup | Security Reviewer |
| H-09 | Security | All services | No HTTP security headers on any response — missing `Strict-Transport-Security`, `X-Content-Type-Options`, `X-Frame-Options`, `Content-Security-Policy` | Add security headers middleware to `createApp()` | Ops Admin, Security Reviewer |
| H-10 | Security | `docker/docker-compose.yml` | Docker socket proxy configured with `POST=1 DELETE=1` — grants containers ability to create and delete arbitrary Docker resources | Restrict to `CONTAINERS_CREATE=1` only; audit all proxy permissions | Ops Admin, Security Reviewer |
| H-11 | Security | `services/execution/src/services/context-call-handler.ts` | SSRF via DNS rebinding — the handler resolves hostnames without validating that they do not resolve to internal RFC-1918 addresses | Add DNS resolution checking before establishing outbound connections | Plugin Author, Security Reviewer |
| H-12 | Reliability | `packages/core/src/logger.ts` | All logs are published only to Redis pub/sub — `docker logs` captures nothing; Redis failures cause total log loss with no fallback | Add `stdout`/`stderr` transport as primary; keep Redis as secondary | Ops Admin |
| H-13 | Reliability | `services/*/src/index.ts` | No `uncaughtException` or `unhandledRejection` handlers — unhandled errors silently terminate services without logging or alerting | Add process error handlers that log and trigger graceful shutdown | Ops Admin |
| H-14 | Reliability | `docker/docker-compose.yml` | No resource limits (`memory`, `cpus`) on any container — a single runaway service can starve the entire host | Add `deploy.resources.limits` to each service definition | Ops Admin |
| H-15 | Reliability | All services | No backup or restore procedure exists — data loss is unrecoverable | Create Postgres dump scripts, Redis snapshot configuration, and documented restore runbook | Ops Admin |
| H-16 | DX | `docs/` | No operational documentation — no deployment guide, operations runbook, upgrade procedure, or scaling guide | Create `docs/operations/` with deployment, ops, upgrade, and scaling guides | Ops Admin, New User |
| H-17 | Reliability | `services/ingestion/src/services/sync-service.ts` | Records are inserted inline during sync AND in a subsequent batch job — every record is double-written to the database | Remove inline insert; allow the batch job to be the sole writer | Data Engineer |
| H-18 | Reliability | `services/ingestion/src/services/retention-service.ts` | `cleanupDeletedConnectors` is a no-op — deleted connectors accumulate orphaned rows indefinitely | Implement `findDeletedBefore` query and table cleanup logic | Data Engineer |
| H-19 | DX | `packages/cli/src/commands/connector/index.ts` | `triggerAction` polls the wrong endpoint for sync progress — users receive no meaningful status feedback | Fix to poll the correct progress endpoint | Data Engineer |
| H-20 | DX | `packages/sdk/src/resources/apps.ts` | SDK `App` methods are bare CRUD only — no `build`, `deploy`, `rollback`, or file management methods | Add build, deploy, rollback, and file operation methods | App Developer |
| H-21 | DX | `packages/app-sdk/src/hooks/useQuery.ts`, `BffClient.ts` | Response is double-wrapped in the envelope — consuming code must unwrap twice or receive `undefined` data | Fix envelope unwrapping to a single layer | App Developer |
| H-22 | DX | `services/app/src/routes/bff.ts` | `PATCH`, `PUT`, and `DELETE` data routes are absent from the BFF — apps can read but cannot mutate data | Add missing BFF mutation routes | App Developer |
| H-23 | DX | `services/app/src/routes/apps.ts` | Type declarations endpoint returns hand-authored, inaccurate TypeScript types — types drift from actual implementation | Auto-generate from `app-sdk` source using `tsc --declaration` or `ts-morph` | App Developer |
| H-24 | Security | `packages/sdk/src/auth/pkce.ts` | PKCE constructor auto-redirects the browser on instantiation — importing the class triggers a navigation side effect | Add an explicit `login()` method; constructor must be side-effect-free | App Developer |
| H-25 | DX | `packages/plugin-sdk/src/types/hooks.ts` | `HookPayload.data` is typed as `Record<string, unknown>` for all hook stages — no per-stage type narrowing | Create a discriminated union keyed on `stage` | Plugin Author |
| H-26 | Security | `services/execution/src/services/context-call-handler.ts` | `context.getCredential()` is restricted to `connector-run` execution type — auth providers and destinations cannot access their own credentials | Extend credential access to `auth-provider` and `destination` execution types | Plugin Author |
| H-27 | Security | `services/plugin/src/services/plugin-service.ts` | GPG signature verification is declared in the schema (`gpgFingerprint`) but never performed — plugins are accepted without verification | Integrate `openpgp` to verify signatures; or remove `gpgFingerprint` field and document the decision | Plugin Author |
| H-28 | Reliability | `services/plugin/src/services/plugin-service.ts` | `activatePlugin` is a no-op stub that returns success without performing any status transition | Implement actual status transition logic | Plugin Author |
| H-29 | DX | `packages/plugin-sdk` | No dev server or full lifecycle testing tooling — plugin authors must deploy to a live server to test | Create `op plugin dev` command with hot-reload and local hook invocation | Plugin Author |
| H-30 | DX | `packages/plugin-sdk/src/testing/mock-context.ts` | Single generic mock for all plugin types — `connector-run`, `auth-provider`, and `destination` receive identical mock shapes | Add per-type mock factories with realistic, type-correct data | Plugin Author |
| H-31 | DX | `packages/cli/src/commands/plugin/index.ts` | CLI sends `file` field but plugin service expects `bundle` — plugin uploads silently fail field validation | Change CLI to send `bundle` | Plugin Author |
| H-32 | Reliability | `services/app/src/services/build-service.ts` | Build dispatch is fire-and-forget with no recovery — builds stuck in `building` state after a crash are never retried or timed out | Add startup scan for orphaned builds, configurable timeout, and retry logic | App Developer |
| H-33 | UX | `packages/frontend/src/components/wizard/steps/MasterKeyStep.tsx` | 60-second countdown to confirm master key is too aggressive for a high-stakes, one-time operation | Increase to 5 minutes; add a download-as-file button | New User |
| H-34 | UX | `packages/frontend/src/pages/connectors/NewConnectorPage.tsx` | Connector creation page shows an empty plugin list with no guidance — new users reach a dead end immediately | Add a link to the plugin marketplace; ship at least one built-in connector | New User |
| H-35 | UX | `packages/frontend/src/components/layout/Topbar.tsx` | User and tenant are displayed as raw UUIDs | Replace with email/name fetched from `auth/me` endpoint | New User |
| H-36 | UX | `packages/frontend/src/pages/ontology/OntologyPage.tsx` | "Ontology" terminology is opaque to non-specialists — new users do not know what the page is for | Add contextual help text; consider relabeling as "Data Models" | New User |
| H-37 | Reliability | `packages/frontend/src/pages/BootstrapGatePage.tsx` | No error boundary on the first page a new user sees — any error renders a blank white screen with no recovery option | Add `errorComponent` with a retry button | New User |
| H-38 | UX | `packages/frontend/src/pages/pipelines/PipelineBuilderPage.tsx` | Pipeline step editor is non-functional — clicking steps opens no configuration panel | Add real step configuration UI | New User |
| H-39 | DX | `README.md` | No documentation of infrastructure prerequisites — users encounter failures before running a single command | Document required tools, versions, and infra setup before `pnpm dev` instructions | New User |
| H-40 | UX | `services/ingestion/src/services/sync-service.ts` | Sync run history is sourced from BullMQ job records only — history is transient and lost on queue flush | Store sync runs in a Postgres table for durable, queryable history | Data Engineer |
| H-41 | UX | `services/ingestion/src/schemas/index.ts` | Cron expressions are accepted without validation — invalid expressions cause silent scheduling failures | Add `cron-parser` validation at the API boundary | Data Engineer |
| H-42 | UX | `packages/cli/src/commands/connector/index.ts` | `createAction` is missing `--credentials`, `--sync-mode`, and `--is-enabled` options | Add credential file path and mode options | Data Engineer |
| H-43 | Performance | `services/ingestion/src/services/connector-service.ts` | `listConnectors` executes N+1 queries — one query per connector to fetch sync state | JOIN `sync_state` table; push all filters to the database | Data Engineer |
| H-44 | Reliability | `services/ontology/src/index.ts` | SIGTERM handler completes cleanup but never calls `process.exit(0)` — container shutdown hangs until Docker's kill timeout | Add `process.exit(0)` call and a hard shutdown timeout | Ops Admin |
| H-45 | Reliability | `services/*/src/index.ts` | All services hardcode version `'0.0.0'` in health and metrics responses | Read version from `package.json` or a `BUILD_VERSION` environment variable | Ops Admin |
| H-46 | Performance | `docker/redis/redis.conf` | No `maxmemory` limit configured — Redis will consume all available host memory under load | Set a `256mb` default with `allkeys-lru` eviction policy | Ops Admin |
| H-47 | Performance | All services | OpenTelemetry is entirely stubbed out — no traces, no metrics, no collector configured | Add OTEL Collector sidecar, Jaeger for traces, Prometheus for metrics | Ops Admin |
| H-48 | DX | `packages/cli/src/` | No `mapping` command group — data engineers cannot manage ontology mappings from the CLI | Add `op mapping list/create/update/delete` commands | Data Engineer |

> Note: IDs H-36 through H-48 correspond to findings 50-62 in the raw dataset. The table above lists all 35 HIGH findings.

---

### MEDIUM (31)

| ID | Category | Component | Pain | Fix | Perspectives |
|----|----------|-----------|------|-----|--------------|
| M-01 | Security | `packages/core/src/middleware/service-auth.ts` | `X-User-Context` header is forwarded between services but never HMAC-signed or validated — any service can forge it | Add HMAC signing on emission and signature validation on receipt | Security Reviewer |
| M-02 | Security | `services/auth/src/services/auth-service.ts` | User enumeration via distinct error messages for "user not found" vs "wrong password" | Return the same generic error for all authentication failures | Security Reviewer |
| M-03 | Security | `services/gateway/src/index.ts` | Rate limiter uses client-controllable `X-Forwarded-For` header as the rate limit key | Use actual TCP source IP (`req.socket.remoteAddress`) | Security Reviewer |
| M-04 | Security | `services/auth/src/services/token-service.ts` | HS256 symmetric JWT signing — compromise of the signing secret breaks all token verification across all services | Migrate to RS256 or EdDSA asymmetric signing | Security Reviewer |
| M-05 | Security | `docker/redis/redis.conf` | `protected-mode no` is set — Redis accepts unauthenticated connections from any network interface | Set `protected-mode yes` | Security Reviewer |
| M-06 | Security | Gateway and all services | No request body size limit — large payloads can exhaust memory | Add configurable size limit; return 413 on exceed | Ops Admin |
| M-07 | Security | `docker/docker-compose.yml` | No container security hardening — containers run with excess capabilities and writable root filesystems | Add `no-new-privileges: true`, `cap_drop: [ALL]`, `read_only: true` | Ops Admin, Security Reviewer |
| M-08 | Security | `services/ontology/src/services/mapping-service.ts` | Expression transforms are built via string concatenation — potential for expression injection | Replace with JSONata or sandboxed expression evaluation | Data Engineer |
| M-09 | Security | `services/ingestion/src/services/credential-service.ts` | No key rotation mechanism for encrypted connector credentials | Implement a key rotation job with re-encryption | Data Engineer |
| M-10 | Reliability | `services/ingestion/src/services/sync-service.ts` | Stale `running` state with no watchdog — crashed syncs are never reset, blocking future runs for that connector | Add a periodic stale-sync detection and reset job | Data Engineer |
| M-11 | DX | `packages/cli/src/commands/schedule/index.ts` | CLI sends `cron` field but service expects `cronExpr` — schedule creation silently fails field mapping | Change CLI to send `cronExpr` | Data Engineer |
| M-12 | DX | `packages/cli/src/commands/exec/index.ts` | Help text advertises Python support that does not exist | Update description to `js\|ts` only | Data Engineer |
| M-13 | DX | `packages/sdk/src/resources/data.ts` | Proxy-based entity access returns `any` — no TypeScript autocompletion or type safety for data queries | Add `createTypedClient<T>()` factory that returns typed query methods | App Developer |
| M-14 | DX | `packages/app-sdk/src/hooks/useSubscription.ts` | No automatic cache invalidation on entity mutation events — UIs go stale after writes | Auto-invalidate related queries on received entity events | App Developer |
| M-15 | Reliability | `services/app/src/services/widget-service.ts` | Widget registry is in-memory only — all registered widgets are lost on service restart | Persist widget registry to Postgres | App Developer |
| M-16 | DX | `packages/plugin-sdk/src/dev/pack.ts` | `tar` flattens directory structure — plugins with sub-directories lose their file layout on pack | Preserve relative paths in the archive | Plugin Author |
| M-17 | UX | `packages/frontend/src/pages/auth/LoginPage.tsx` | "Register" link is visible but navigates to a non-functional or absent page | Implement a registration form or remove the link until registration is built | New User |
| M-18 | UX | `packages/frontend/src/pages/settings/SettingsPage.tsx` | Settings sidebar navigation uses separate top-level routes — navigating settings causes full-page reloads and loses sub-route state | Make settings sub-pages children of the settings layout route | New User |
| M-19 | Reliability | `docker/docker-compose.yml` | No `stop_grace_period` or Docker log rotation configured — containers are force-killed before graceful shutdown completes; logs grow unbounded | Set `stop_grace_period: 45s`; add `logging` config with size rotation | Ops Admin |
| M-20 | DX | Auth service / CLI | No tenant management API beyond initial bootstrap — operators cannot create, rename, or delete tenants after setup | Add CRUD routes to auth service and corresponding CLI commands | Ops Admin |
| M-21 | UX | `packages/frontend/src/pages/dashboard/DashboardPage.tsx` | Quick Start panel checks static booleans rather than actual platform state — users who have completed steps still see them as incomplete | Base checklist on real data (connector count, entity count); add a guided first-run flow | New User |
| M-22 | Documentation | `packages/plugin-sdk`, `packages/sdk` | No README, no API reference, no usage examples in either SDK package | Create getting-started guides; add JSDoc examples to all public methods | Plugin Author, App Developer |
| M-23 | Reliability | `services/plugin/src/services/instance-service.ts` | Plugin instance configuration validated only with minimal JSON Schema — required fields and type constraints are missing | Integrate Ajv with strict mode for proper schema validation | Plugin Author |

> Note: The raw dataset contained 31 MEDIUM findings. IDs M-01 through M-23 above represent all entries; the table collapses M-22/M-23 which map to raw findings 84-85.

---

### LOW (6)

| ID | Category | Component | Pain | Fix | Perspectives |
|----|----------|-----------|------|-----|--------------|
| L-01 | DX | `packages/cli/src/index.ts` | 20 flat, uncategorized command groups — `op --help` output is overwhelming for new users | Add command categories (Data, Apps, Plugins, Admin) | Data Engineer |
| L-02 | DX | `packages/sdk/src/client.ts` | SDK client throws on a trailing slash in `baseUrl` — a common user mistake becomes an uncaught error | Silently strip trailing slashes from `baseUrl` | App Developer |
| L-03 | DX | `packages/sdk/src/resources/data.ts` | Validation failures throw plain `Error` instead of `OnePlatformError` — callers cannot distinguish SDK errors from other errors | Use `ValidationError` (subclass of `OnePlatformError`) | App Developer |
| L-04 | UX | `packages/frontend/src/pages/settings/ProfilePage.tsx` | Profile page shows empty default fields — user's actual profile data is never fetched | Add `useQuery` call to pre-populate form fields from `auth/me` | New User |
| L-05 | DX | `docker/docker-compose.yml` | Volume declarations for application services exist but those services are not yet defined — unused volumes cause confusion | Remove unused volume declarations until the corresponding services are added | Ops Admin |
| L-06 | Security | `docker/Dockerfile.sandbox` | Missing V8 hardening flags in sandbox container | Add `--disallow-code-generation-from-strings` and `--jitless` to Node invocation | Security Reviewer |

---

## Finding Distribution by Perspective

This table shows how many findings each perspective contributed (pre-deduplication). Findings claimed by multiple perspectives are counted once per perspective.

| Perspective | CRITICAL | HIGH | MEDIUM | LOW | Total (raw) |
|-------------|----------|------|--------|-----|-------------|
| security-reviewer | 5 | 12 | 7 | 1 | 25 |
| ops-admin | 4 | 9 | 5 | 1 | 19 |
| app-developer | 3 | 7 | 4 | 2 | 16 |
| new-user | 3 | 7 | 4 | 1 | 15 |
| plugin-author | 3 | 7 | 3 | 0 | 13 |
| data-engineer | 2 | 8 | 6 | 1 | 17 |
| **Multi-perspective** | **4** | **5** | **2** | **0** | **11** |

Findings flagged by 2 or more perspectives independently are the highest-confidence items — they represent failures visible from multiple angles of the system.

---

## Cross-Reference: Findings by Component Area

| Area | CRITICAL | HIGH | MEDIUM | LOW |
|------|----------|------|--------|-----|
| Auth service | 1 | 6 | 2 | 0 |
| Gateway | 1 | 2 | 1 | 0 |
| Docker / Infra | 3 | 5 | 3 | 1 |
| CLI | 3 | 4 | 2 | 1 |
| Ingestion service | 0 | 5 | 3 | 0 |
| App SDK / BFF | 2 | 4 | 2 | 1 |
| Plugin SDK / service | 3 | 5 | 2 | 0 |
| Frontend | 1 | 4 | 2 | 1 |
| Core / logger | 0 | 2 | 1 | 0 |
| SDK (platform) | 0 | 1 | 2 | 2 |
| Execution service | 0 | 2 | 0 | 0 |
| Ontology service | 0 | 1 | 1 | 0 |
| Documentation | 0 | 1 | 1 | 0 |

---

## Comparison with v1 Analysis

| Metric | v1 | v2 |
|--------|----|----|
| Findings | 108 | 85 unique (202 raw) |
| Perspectives | 4 | 6 |
| CRITICAL identified | Not categorized | 13 |
| New perspectives added | — | plugin-author, security-reviewer |
| Security findings | Scattered | 24 total (5 CRITICAL, 11 HIGH, 7 MEDIUM, 1 LOW) |

The addition of the **security-reviewer** and **plugin-author** perspectives in v2 surfaced the header injection vulnerability (C-01), the scope coverage gap (C-04), the GPG verification stub (H-27), and the Docker socket over-permission (H-10) — none of which appeared in v1.
