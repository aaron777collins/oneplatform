# OnePlatform — Full System Analysis V8 (Phase 19.5)

**Date:** 2026-06-22
**Scope:** Entire codebase — 9 services, 7 packages, 7 plugins, cross-cutting security & consistency
**Method:** 25 parallel analysis agents (one per component + 2 cross-cutting) reading actual source, followed by 6 adversarial verification agents that attempted to *refute* every CRITICAL and HIGH finding. Findings survive only if a refutation agent could trace the exact broken code path. Default verdict was REFUTED when uncertain.
**Baseline:** `pnpm turbo build` PASS (exit 0), `pnpm turbo test` PASS (exit 0).
**Full machine-readable results:** `docs/phase19-analysis-results.json` (130 findings).

> Prior rounds V2–V7 fixed the obvious bugs. V8 targets subtle defects that *compile and pass tests but are wrong*: forgotten wiring, cross-service trust gaps, silent data loss, and security checks that look correct but short-circuit.

---

## 1. Findings by Severity

| Severity | Count |
|----------|-------|
| CRITICAL | 16 |
| HIGH | 59 |
| MEDIUM | 47 |
| LOW | 8 |
| **Total** | **130** |

129 of 130 confirmed by adversarial verification (or reported by a single analysis pass for MEDIUM/LOW). 1 retained as `verified:false` (P19-006, a real gap but currently unreachable). Findings refuted during verification (not included in the table): an ontology SQL-paren false alarm, a CSV off-by-one false alarm, a `packages/core` cursor claim already guarded, and a gateway GraphQL header-case claim that is functionally harmless because HTTP header names are case-insensitive.

## 2. Findings by Category

| Category | Count |
|----------|-------|
| security | 55 |
| logic | 48 |
| consistency | 11 |
| incomplete | 7 |
| error-handling | 4 |
| type-safety | 3 |
| resource | 2 |

## 3. Findings by Component

| Component | Count |
|-----------|-------|
| cross-cutting | 14 |
| services/app | 11 |
| services/ontology | 9 |
| services/pipeline | 9 |
| services/auth | 8 |
| services/gateway | 8 |
| packages/core | 7 |
| services/ingestion | 7 |
| services/plugin | 7 |
| services/execution | 5 |
| plugins/connector-rest-api | 5 |
| plugins/auth-provider-oidc | 5 |
| plugins/connector-postgres | 4 |
| plugins/connector-webhook | 4 |
| packages/frontend | 4 |
| services/logging | 3 |
| plugins/connector-mysql | 3 |
| plugins/auth-provider-ldap | 3 |
| packages/sdk | 3 |
| packages/docs | 3 |
| packages/cli | 3 |
| plugins/connector-csv | 3 |
| packages/app-sdk | 2 |

---

## 4. Top Critical Findings (full detail)

These are the highest-impact, verified defects. Several are "forgotten wiring" bugs that make whole features unreachable, plus the cross-service auth chain that is broken in any real (Docker) deployment.

### P19-088 (CRITICAL, consistency) — Service-to-service URLs only set for gateway; all other direct calls hit dead ports
`docker/docker-compose.yml:321`. Compose sets `PORT=3000` for every service but defines the `*_SERVICE_URL` env vars only in the gateway block, and the entrypoint never exports them. So execution/pipeline/ontology/app fall back to hardcoded *wrong* ports (plugin:3008, ingestion:3002, execution:3005, …) and every direct service-to-service call fails with ECONNREFUSED. **This breaks sync→execution, pipeline→execution, app→auth, ontology→execution in the dev stack.**

### P19-089 (CRITICAL, security) — Execution service sends a plain token where an Ed25519 JWT is required
`services/execution/src/index.ts:328` + `context-call-handler.ts`. Execution loads `OP_SERVICE_TOKEN ?? ''` (compose doesn't even set it) and sends it raw as `X-Service-Token`, but `serviceAuthMiddleware` splits on `.` and verifies an Ed25519 JWT, so **all execution→internal calls (credentials.get, plugin cache, pipeline trigger) return 401** — connector executions cannot fetch credentials. pipeline/app/ontology use `createServiceTokenSigner`; execution (and the plugin service / gateway `OP_SERVICE_TOKEN` path) do not.

### P19-087 (CRITICAL, consistency) — Gateway publicRoutes omit OAuth + JWKS → login broken
`services/gateway/src/index.ts:353`. `publicRoutes` lacks `/api/v1/oauth/:provider/authorize`, `/callback`, and `/api/v1/auth/.well-known/jwks.json`. The gateway auth middleware runs first and 401s these, so **OAuth browser login and JWKS key fetch are blocked in any deployed environment** (the proxy SERVICE_MAP also lacks an `oauth` key, compounding it).

### P19-090 (CRITICAL, consistency) — connector-registry + analytics mounts missing from gateway SERVICE_MAP
`services/ingestion/src/index.ts:420`. Ingestion mounts `/api/v1/connector-registry` (and dual-mounts `/api/v1/analytics`) but the gateway proxy SERVICE_MAP has no key for them, so client requests 404. (See also P19-100: streaming routes implemented but never mounted, and P19-045: gateway usage/billing routes imported but never mounted.)

### P19-001 (CRITICAL, incomplete) — Ontology query route implemented but never mounted
`services/ontology/src/routes/index.ts:49`. `createQueryRoutes`/`createQueryService` are fully implemented but never imported or mounted, so the entire structured-query feature (`POST /api/v1/ontology/query`) 404s.

### P19-010 (CRITICAL, security) — User-supplied appName injected into generated TSX source
`services/app/src/services/app-service.ts:84` (+ all 8 templates). `appName` is interpolated directly into backtick template literals that *become* generated TSX stored in the VFS and later compiled by Execution. `CreateAppSchema` allows any character, so a backtick or `${…}` breaks out and injects arbitrary code — a persistent code-injection path.

### P19-011 / P19-012 (CRITICAL, logic) — `app.builds.updated_at` written but column does not exist
`services/app/src/repositories/deployment-repository.ts:126` and `build-service.ts:762`. `update()` always sets `updated_at = now()` and `recoverInterruptedBuilds` filters on `updated_at`, but the `app.builds` table has no such column — **every build state transition throws, and startup recovery throws on every boot.** Builds are broken.

### P19-003 (CRITICAL, logic) — Migration set to `confirmed` on auto-commit pool before advisory lock
`services/ontology/src/services/migration-service.ts:180`. `setConfirmed` commits on the pool before the advisory lock is acquired in a transaction; if the lock fails, the entity is permanently stuck in `confirmed` with no recovery path.

### P19-067 (CRITICAL, logic) — Postgres connector terminates sync early when a full batch is fully deduped
`plugins/connector-postgres/src/index.ts:871`. `hasMore`/`nextCursor` are set only inside `if (records.length>0)`; when a full proxy batch is entirely removed by client-side dedup, the connector returns `hasMore:false` and **silently stops syncing while rows remain** — data loss.

### P19-070 (CRITICAL, security) — REST connector baseUrl has no SSRF protection
`plugins/connector-rest-api/src/index.ts:139`. `parseConfig` only rejects embedded credentials; no scheme/private-IP checks, so `file:///etc/passwd`, `http://169.254.169.254` (cloud metadata), `http://localhost/admin` all pass. (P19-071 is the same gap on redirect targets.)

### P19-079 / P19-080 (CRITICAL, security) — OIDC ID-token validation skipped
`plugins/auth-provider-oidc/src/index.ts:604,597`. The audience check short-circuits when `aud` is absent, and `handleCallback` consumes the ID token with no signature/exp/iss/**nonce** verification — and **no nonce is ever generated**, so OIDC replay protection is entirely missing end-to-end.

### P19-084 (CRITICAL, security) — LDAP token scope check bypassable via sibling-tree DN
`plugins/auth-provider-ldap/src/index.ts:837`. The scope guard uses bare `endsWith(baseDN)` with no RDN-comma boundary, so a sibling/child-tree or malformed DN passes and the service account searches arbitrary entries — privilege escalation by mapping roles from non-user objects.

### P19-039 (CRITICAL, security) — Shared JWT middleware doesn't validate issuer/audience
`packages/core/src/middleware/auth.ts:179`. `jwtVerify` is called with only `{ algorithms }` for both EdDSA and HS256, omitting `issuer`/`audience` even though tokens are minted with `iss/aud='oneplatform'`. Every non-auth service trusts tokens without iss/aud enforcement → cross-issuer/audience replay across the service boundary.

---

## 5. Notable HIGH findings (selected)

- **P19-051 / P19-053 (ingestion):** batch temp-file deleted on failure but BullMQ retries reuse the path → ENOENT → **records permanently lost**; Lua progress scripts `SET` without `KEEPTTL` → **Redis key leak**.
- **P19-050 (ingestion):** reconciliation report readable cross-connector/cross-tenant (IDOR) — connector ownership checked but `report.connectorId` not.
- **P19-020 / P19-021 / P19-022 (pipeline):** parallel-branch steps never written to `run_steps` (invisible/unaudited); critical-hook failures skip `completeExecution` → SSE streams hang forever; sub-workflow cycle detection is in-process only → cross-job cycles undetected.
- **P19-028 (execution):** Docker sandboxes created without `PidsLimit`, seccomp/`no-new-privileges`, or non-root `User` — fork-bomb + wide kernel syscall surface, running as root.
- **P19-033 / P19-034 / P19-094 (auth):** logout doesn't revoke cookie-session access tokens or clear cookies; OAuth state GET+DEL uses a non-atomic pipeline (replay); cookie `Secure` flag never set behind the TLS-terminating proxy.
- **P19-092 (cross-cutting):** `ontology:map` queue has producers in 3 services but **no consumer worker** — ontology mapping never runs, jobs accumulate forever.
- **P19-095 (cross-cutting):** `lineage:read` scope is referenced but defined nowhere, so all non-admins are 403'd from lineage.
- **P19-060 / P19-059 / P19-061 (plugin):** marketplace install lacks authorization; no bundle signature verification; `requiredExternalUrls` accepts non-HTTP schemes.
- **P19-106 / P19-107 / P19-109 (frontend/app-sdk):** CSS sanitizer misses CSS-escaped `url()` (XSS); module-level `QueryCache` not tenant-scoped (cross-tenant data); generated-code HTML sanitizer allowlist bypass into `dangerouslySetInnerHTML`.
- **P19-110 (docs):** documented API paths are wrong across auth/execution/pipeline/plugin (`/api/v1/auth/users` vs real `/api/v1/users`, `/runs` vs `/exec`, etc.) — every documented call 404s.

---

## 6. Themes

1. **Forgotten wiring is the dominant CRITICAL theme.** Multiple fully-implemented features (ontology query, ingestion streaming, gateway usage/billing, connector-registry) are never mounted, and the `ontology:map` queue has no consumer. Recommend an integration test that asserts every exported route factory is mounted and every produced queue has a worker.
2. **The service-to-service auth + URL story is broken in the deployed (Docker) configuration.** P19-088 (URLs) and P19-089 (Ed25519 signing) together mean direct inter-service calls fail at runtime even though unit tests pass. This is the highest-priority cluster.
3. **Connector incremental-sync correctness** (postgres P19-067, mysql P19-065/066, rest P19-072) repeatedly silently drops or stops data. These need a shared, tested keyset-pagination contract.
4. **Auth-plugin token validation** (OIDC P19-079/080/082/083, LDAP P19-084/085) has several short-circuits that defeat the security control while appearing correct.
5. **Docs/code drift** (P19-110/111) — the auto-generated and hand-authored docs disagree with actual routes; regenerate from `openapi-meta` and add a doc/route consistency check.

---

## 7. Recommended Fix Order (Phase 19.6)

1. **Deployment-blocking:** P19-088, P19-089, P19-087, P19-090, P19-100, P19-045 (wiring + service auth — nothing works end-to-end without these).
2. **Data integrity:** P19-011/012 (builds), P19-067/065/066 (connector data loss), P19-051/053 (ingestion loss/leak), P19-003/004 (migration orphan).
3. **Security:** P19-010 (app code injection), P19-070/071 (REST SSRF), P19-079/080/084 (auth-plugin bypass), P19-039 (JWT iss/aud), P19-028 (sandbox hardening), P19-050/031 (IDOR), P19-094/033/034 (auth cookies/logout/replay).
4. **Correctness/UX:** remaining HIGH/MEDIUM, then LOW.

All 130 findings with file:line, description, and concrete fix are in `docs/phase19-analysis-results.json`.
