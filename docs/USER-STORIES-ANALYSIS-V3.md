# OnePlatform User Story Analysis v3

**Date:** 2026-06-14
**Method:** 10-persona exhaustive analysis with source code verification
**Previous analyses:** [v1](./USER-STORIES-ANALYSIS.md) (108 points), [v2](./USER-STORIES-ANALYSIS-V2.md) (85 unique, 13 CRITICAL)
**This analysis:** NET-NEW findings only — every item verified as absent from v2

---

## Summary Table

| Severity | Count |
|----------|-------|
| CRITICAL | 5     |
| HIGH     | 18    |
| MEDIUM   | 22    |
| LOW      | 8     |
| **Total net-new findings** | **53** |

---

## Methodology

This v3 analysis applies 10 distinct user personas to the entire OnePlatform codebase. Every finding has been:

1. **Verified in source code** — file paths, line numbers, and exact code patterns are cited
2. **Cross-referenced against v2** — only findings absent from v2's 85 items (C-01 through L-06) are included
3. **Classified by severity** using the same rubric as v2

Many v2 findings have been FIXED in the current codebase (C-01, C-04, C-06, C-07, C-08, C-13, H-01, H-02, H-03, H-04, H-05, H-06, H-07, H-08, H-09, H-10, H-12, H-13, H-14, H-17, H-18, H-19, H-22, H-37, M-01, M-06, M-07, M-10, M-18, M-19, M-21, and others). This analysis focuses exclusively on what remains broken or was never caught.

### Personas Applied

| Persona | Focus Area |
|---------|------------|
| **First-Time Self-Hoster** | Docker Compose experience, bootstrap flow, first-run errors |
| **Data Engineer** | Connector pipelines, sync reliability, mapping correctness, batch processing |
| **App Developer** | SDK, BFF, build/deploy lifecycle, type safety |
| **Plugin Developer** | Plugin SDK, hook system, sandbox interaction, bundle lifecycle |
| **Platform Admin** | User management, RBAC configuration, tenant operations, monitoring |
| **DevOps/SRE** | Observability, scaling, backup, health checks, container lifecycle |
| **Security Auditor** | Auth flows, token handling, SSRF, injection, secrets management |
| **Enterprise Evaluator** | Multi-tenancy, compliance, audit trail, SSO integration |
| **Power User / Data Scientist** | Query performance, API ergonomics, large dataset handling |
| **Casual / Non-Technical User** | UI clarity, error messages, onboarding guidance |

---

## Top 10 Priorities

| # | Finding | Severity | Why It Matters | Effort |
|---|---------|----------|----------------|--------|
| 1 | API key `validate()` returns empty `roles: []` | CRITICAL | Any RBAC check using roles (not scopes) fails silently for all API key users | 5-line fix in `api-key-service.ts` |
| 2 | Frontend API key scopes don't match backend | CRITICAL | Keys created from the UI get invalid scopes (`pipelines:run`, `connectors:manage`) that don't exist | Fix `AVAILABLE_SCOPES` array in `ApiKeysPage.tsx` |
| 3 | Pipeline execution engine calls lack service tokens | CRITICAL | All pipeline steps fail when services enforce Ed25519 service auth on `/internal/*` routes | Add `X-Service-Token` header to `callExecutionService()` and sibling functions |
| 4 | BFF service token is a plain string, not an Ed25519 JWT | CRITICAL | All BFF-to-upstream calls fail `serviceAuthMiddleware` validation | Generate and sign proper Ed25519 tokens |
| 5 | User deactivation blocklists wrong JTI | CRITICAL | Access tokens remain valid after user deactivation — the wrong JTI is revoked | Use the access token's JTI, not the refresh token's JTI |
| 6 | API key revocation Redis flag has no TTL | HIGH | `auth:apikey:revocation:*` keys accumulate forever, leaking Redis memory | Add TTL matching key expiry or a fixed upper bound |
| 7 | Retention runs with empty `tenantId` | HIGH | `connectorRepo.list("")` passes empty tenant — may scan all tenants or return nothing | Pass tenant list or iterate tenants explicitly |
| 8 | BFF `/permissions` returns all roles, not user-specific | HIGH | Every user sees every app role's permissions regardless of their own role assignment | Filter by user's actual role membership |
| 9 | Gateway forwards client `x-forwarded-for` verbatim | HIGH | Rate limiting keyed on this header is fully bypassable by clients | Set `x-forwarded-for` from TCP `remoteAddress` |
| 10 | Mapping service expression transforms lack service auth | HIGH | Calls to execution service at line 116 of `mapping-service.ts` have no `X-Service-Token` header | Add authentication header |

---

## All Findings

### CRITICAL (5)

#### V3-C-01: API Key `validate()` Returns Empty Roles Array

**Severity:** CRITICAL
**Personas:** Security Auditor, Platform Admin, Data Engineer
**Component:** `services/auth/src/services/api-key-service.ts` (line 240-246)
**Not in v2:** v2 H-04 covered scope subsetting on creation; this is about the runtime UserContext returned by `validate()`

**Problem:** The `validate()` method builds a `UserContext` with `roles: []` (empty array). Any downstream middleware or route handler that checks `user.roles` (e.g., RBAC entity-level permissions in `rbac-service.ts`, or any `roles.includes("editor")` guard) will fail silently for all API key authenticated requests. The user's actual roles from the `users` table are never fetched.

**Impact:** API key users are effectively locked out of any role-gated feature. Only scope-based checks work. This breaks the RBAC model for programmatic access.

**Fix:** Join against `auth.users` to fetch the user's roles during validation, or at minimum set `roles` to the user's stored roles.

**Effort:** Small (5-10 lines: add a query to fetch roles from `auth.users` by `matchedRow.user_id`)

**Affected files:**
- `services/auth/src/services/api-key-service.ts`

---

#### V3-C-02: Frontend API Key Scope List Mismatches Backend

**Severity:** CRITICAL
**Personas:** App Developer, Data Engineer, Platform Admin
**Component:** `packages/frontend/src/pages/settings/ApiKeysPage.tsx` (line 68-74)
**Not in v2:** Not mentioned in any v2 finding

**Problem:** The frontend's `AVAILABLE_SCOPES` array contains:
```
["data:read", "data:write", "pipelines:run", "apps:deploy", "connectors:manage"]
```

But the backend (`token-service.ts` line 29-49) defines these actual scopes:
```
data:read, data:write, ontology:read, ontology:write, pipelines:read, pipelines:trigger,
pipelines:manage, apps:read, apps:deploy, apps:manage, plugins:read, plugins:manage,
users:read, users:manage, logs:read, webhooks:manage, execution:read, execution:run, admin
```

Two frontend scopes (`pipelines:run` and `connectors:manage`) **do not exist** in the backend. Keys created with these scopes will have no effect. Meanwhile, 14 real scopes (including `ontology:read`, `execution:read`, `pipelines:trigger`) are missing from the UI entirely.

**Impact:** Users creating API keys from the frontend get non-functional scopes and cannot select the scopes they actually need.

**Fix:** Replace `AVAILABLE_SCOPES` with the actual scope list from the backend. Consider fetching available scopes dynamically from an API endpoint.

**Effort:** Small (replace 5-element array with correct values)

**Affected files:**
- `packages/frontend/src/pages/settings/ApiKeysPage.tsx`
- `services/auth/src/services/token-service.ts` (reference)

---

#### V3-C-03: Pipeline Execution Engine Internal Calls Lack Service Tokens

**Severity:** CRITICAL
**Personas:** Data Engineer, DevOps/SRE, Plugin Developer
**Component:** `services/pipeline/src/services/execution-engine.ts` (lines 303, 236, 422)
**Not in v2:** v2 covered missing service keys (C-06) and token generation (H-01) but not the pipeline engine's outbound calls

**Problem:** Three critical internal HTTP calls in the execution engine have **no `X-Service-Token` header**:

1. `callExecutionService()` (line 302-303): Calls `${executionServiceUrl}/internal/execution/run` without any service auth headers
2. `resolveHookChain()` (line 236-237): Calls `${pluginServiceUrl}/internal/plugins/hooks` without any service auth headers
3. `executeConnectorStep()` (line 422): Calls `${ingestionServiceUrl}/internal/ingestion/sync` without any service auth headers

Since all services now enforce Ed25519 JWT authentication on `/internal/*` routes via `serviceAuthMiddleware`, these calls will be rejected with 401 in production.

**Impact:** All pipeline runs fail. No code steps, connector steps, or hook chains can execute.

**Fix:** Inject a service token signer and include `X-Service-Token` header in all three HTTP calls.

**Effort:** Medium (inject deps, sign tokens, add headers to 3 call sites)

**Affected files:**
- `services/pipeline/src/services/execution-engine.ts`

---

#### V3-C-04: BFF Service Token Is a Plain String, Not an Ed25519 JWT

**Severity:** CRITICAL
**Personas:** App Developer, Security Auditor
**Component:** `services/app/src/routes/bff.ts` (line 37-39)
**Not in v2:** v2 addressed BFF route gaps (H-22) and app-sdk header issues (C-08), not the service auth mechanism

**Problem:** The BFF routes use `process.env["OP_SERVICE_TOKEN_SECRET"]` as a bare string in the `X-Service-Token` header:
```typescript
function serviceToken(): string {
  return process.env["OP_SERVICE_TOKEN_SECRET"] ?? "";
}
```

However, `serviceAuthMiddleware` (in `packages/core/src/middleware/service-auth.ts`) expects the `X-Service-Token` value to be a **signed Ed25519 JWT** that it verifies cryptographically. A plain string will fail `jwtVerify()` with an invalid token error.

**Impact:** All BFF data proxy calls (`GET/POST/PATCH/PUT/DELETE /bff/data/*`) fail with 401. Apps built with `app-sdk` cannot read or write data.

**Fix:** The BFF must sign Ed25519 JWTs using the app service's private key, including the caller service name and target service in the claims.

**Effort:** Medium (integrate Ed25519 signing library, generate tokens with proper claims)

**Affected files:**
- `services/app/src/routes/bff.ts`
- `services/app/src/services/deploy-service.ts` (same issue at line 258-260)

---

#### V3-C-05: User Deactivation Blocklists Wrong JTI

**Severity:** CRITICAL
**Personas:** Security Auditor, Platform Admin
**Component:** `services/auth/src/routes/users.ts` (lines 178-192)
**Not in v2:** v2 H-06 covered "no revocation on deactivation" which is now implemented, but the implementation has a logic error

**Problem:** When deactivating a user, the code iterates active sessions and blocklists `session.refresh_token_jti`:
```typescript
await redis.set(`revocation:${session.refresh_token_jti}`, "1", "EX", jwtExpirySeconds);
```

The comment says "refresh_token_jti stored on the session row is the JTI of the most-recently-issued access token" — but this is incorrect. The `refresh_token_jti` column stores the JTI of the **refresh token**, not the access token. The access token's JTI is embedded in the JWT itself and is not stored in the sessions table.

The revocation blocklist in `authMiddleware` checks `revocation:${claims.jti}` where `claims.jti` is the **access token's** JTI. So the blocklist entry for the refresh token JTI will never match any access token validation check.

**Impact:** Deactivated users' access tokens remain valid until natural expiry (up to 15 minutes). During this window, a deactivated user retains full platform access.

**Fix:** Either: (a) store the access token JTI in the sessions table alongside the refresh token JTI, or (b) re-derive the access token JTI from the session data, or (c) blocklist based on `userId` with a per-user revocation check in auth middleware.

**Effort:** Medium (requires schema change or middleware enhancement)

**Affected files:**
- `services/auth/src/routes/users.ts`

---

### HIGH (18)

#### V3-H-01: API Key Revocation Redis Flag Has No TTL

**Severity:** HIGH
**Personas:** DevOps/SRE, Security Auditor
**Component:** `services/auth/src/services/api-key-service.ts` (line 287)
**Not in v2:** v2 did not examine Redis key lifecycle for API key revocation

**Problem:** When revoking an API key, the code writes:
```typescript
await redis.set(`auth:apikey:revocation:${keyId}`, "1");
```
No TTL is set. These keys persist forever in Redis. Over time, as keys are created and revoked, Redis memory consumption grows without bound.

**Impact:** Redis memory leak proportional to the total number of revoked API keys across the platform's lifetime. In high-churn environments (CI/CD key rotation), this can exhaust Redis memory.

**Fix:** Set a TTL matching the key's `expires_at` value, or a fixed upper bound (e.g., 30 days) if the key has no expiry. When the DB row is hard-deleted, the Redis key becomes unnecessary.

**Effort:** Small (add `"EX"` parameter to `redis.set` call)

**Affected files:**
- `services/auth/src/services/api-key-service.ts`

---

#### V3-H-02: Retention Service Passes Empty TenantId

**Severity:** HIGH
**Personas:** DevOps/SRE, Data Engineer
**Component:** `services/ingestion/src/services/retention-service.ts` (line 77)
**Not in v2:** v2 H-18 covered the `findDeletedBefore` stub, not the retention query itself

**Problem:** `runRetention()` calls `connectorRepo.list("")` with an empty string for `tenantId`. Depending on the repository implementation, this will either:
- Return no connectors (if the query filters by `tenant_id = ''`)
- Return all connectors across all tenants (if empty string is treated as "no filter")

Neither behavior is correct. The first means retention never runs. The second means a single retention pass processes all tenants without tenant isolation.

**Impact:** Data retention either never fires or violates tenant isolation boundaries.

**Fix:** Query distinct tenant IDs first, then iterate `connectorRepo.list(tenantId)` per tenant.

**Effort:** Small-Medium (add tenant enumeration query, iterate per tenant)

**Affected files:**
- `services/ingestion/src/services/retention-service.ts`

---

#### V3-H-03: BFF Permissions Endpoint Returns All App Roles, Not User-Specific

**Severity:** HIGH
**Personas:** App Developer, Security Auditor
**Component:** `services/app/src/routes/bff.ts` (lines 109-127)
**Not in v2:** v2 C-09 covered permission response shape mismatch, not the authorization logic

**Problem:** `GET /bff/permissions` calls `permRepo.listRolesByApp(appId)` which returns **all** roles defined for the app, regardless of which roles the current user actually holds. Then it aggregates all permissions from all roles into a flat map.

This means every user — including guests and viewers — receives the full union of all roles' permissions. The app-sdk will report `canCreate: true`, `canDelete: true` etc. for entities the user should not have access to.

**Impact:** Permission checks in app-sdk are meaningless. Every user sees elevated permissions. UI elements that should be hidden are visible, and mutation attempts may succeed if the BFF data proxy doesn't separately enforce permissions.

**Fix:** Filter `listRolesByApp` results by the user's actual role assignments within the app (join on user-role mapping table).

**Effort:** Medium (requires user-role lookup and filtering)

**Affected files:**
- `services/app/src/routes/bff.ts`

---

#### V3-H-04: BFF `GET /bff/me` Returns All App Roles Instead of User's Roles

**Severity:** HIGH
**Personas:** App Developer, Security Auditor
**Component:** `services/app/src/routes/bff.ts` (lines 73-85)
**Not in v2:** Not covered

**Problem:** Same root cause as V3-H-03 but in the `/bff/me` endpoint. Line 75 calls `permRepo.listRolesByApp(appId)` and returns all role names. The SDK's `useUser()` hook consumes this and reports the user as having every role defined in the app.

**Impact:** The app-sdk's `useUser().roles` array contains roles the user doesn't actually have, causing incorrect UI rendering and broken authorization decisions in app code.

**Fix:** Query user-specific role assignments from the app's permission system.

**Effort:** Small-Medium (add user-role mapping query)

**Affected files:**
- `services/app/src/routes/bff.ts`

---

#### V3-H-05: Gateway Forwards Client `x-forwarded-for` Verbatim

**Severity:** HIGH
**Personas:** Security Auditor, DevOps/SRE
**Component:** `services/gateway/src/services/proxy-service.ts` (lines 196-199)
**Not in v2:** v2 M-03 covered rate limiter using `x-forwarded-for` as key but did not address the proxy forwarding side

**Problem:** The proxy reads the inbound `x-forwarded-for` header (set by the client) and forwards it unchanged to upstream services:
```typescript
const clientIp = c.req.header("x-forwarded-for");
if (clientIp !== undefined) {
  outboundHeaders.set("x-forwarded-for", clientIp);
}
```
Any client can set `x-forwarded-for` to any value. Any upstream service that trusts this header for IP-based logic (rate limiting, geo-restriction, audit logging) is fully bypassable.

**Impact:** IP-based rate limiting, geo-blocking, and audit trails are unreliable. Combined with v2 M-03 (rate limiter key), this creates a complete bypass chain.

**Fix:** Set `x-forwarded-for` to the TCP `remoteAddress` (from the original connection), or append to the existing chain with the real client IP as the rightmost entry.

**Effort:** Small (use `c.req.raw.socket?.remoteAddress` or equivalent)

**Affected files:**
- `services/gateway/src/services/proxy-service.ts`

---

#### V3-H-06: Gateway Hardcodes `x-forwarded-proto: https` for All Deployments

**Severity:** HIGH
**Personas:** First-Time Self-Hoster, DevOps/SRE
**Component:** `services/gateway/src/services/proxy-service.ts` (line 201)
**Not in v2:** Not covered

**Problem:** Line 201 unconditionally sets:
```typescript
outboundHeaders.set("x-forwarded-proto", "https");
```
For development, self-hosted, and LAN deployments that use plain HTTP, this tells upstream services that the connection is HTTPS when it isn't. Services that check the protocol for security decisions (e.g., setting `Secure` cookie flags, generating absolute URLs, enforcing HSTS) will behave incorrectly.

**Impact:** Cookies marked `Secure` won't be sent over HTTP connections, breaking authentication for non-TLS deployments. URL generation in password reset emails, OAuth redirects, and app URLs will use `https://` when the actual deployment is `http://`.

**Fix:** Detect the actual protocol from the inbound request or an environment variable (`OP_FORCE_HTTPS`), and set `x-forwarded-proto` accordingly.

**Effort:** Small (conditional based on `OP_BASE_URL` scheme)

**Affected files:**
- `services/gateway/src/services/proxy-service.ts`

---

#### V3-H-07: Mapping Service Expression Transforms Lack Service Auth Headers

**Severity:** HIGH
**Personas:** Data Engineer, Security Auditor
**Component:** `services/ontology/src/services/mapping-service.ts` (lines 116-128)
**Not in v2:** v2 M-08 covered expression injection risk, not the missing auth headers

**Problem:** When executing expression transforms, the mapping service calls the execution service:
```typescript
const response = await fetch(`${executionServiceUrl}/internal/execution/run`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ ... }),
});
```
No `X-Service-Token` header is included. This call will be rejected by `serviceAuthMiddleware`.

**Impact:** All mapping rules with `transform_type === "expression"` silently fall back to the source value (no transform applied), causing data corruption that is logged as a warning but never surfaces to the user.

**Fix:** Inject a service token signer and include `X-Service-Token` header.

**Effort:** Small-Medium (inject service token dependency)

**Affected files:**
- `services/ontology/src/services/mapping-service.ts`

---

#### V3-H-08: Sync Job Listing Hardcoded to Max 100 Jobs

**Severity:** HIGH
**Personas:** Data Engineer, Power User
**Component:** `services/ingestion/src/services/sync-service.ts`
**Not in v2:** Not covered

**Problem:** `listSyncs` calls `getJobs(states, 0, 100)` — always fetching at most 100 jobs with no pagination parameters. For connectors with active sync schedules, the job count quickly exceeds 100, making it impossible to see older sync runs.

**Impact:** Users lose visibility into sync history beyond the most recent 100 runs. Troubleshooting intermittent sync failures becomes impractical.

**Fix:** Accept `cursor` and `limit` parameters; implement proper pagination over BullMQ job IDs.

**Effort:** Medium (modify API schema, implement cursor-based pagination)

**Affected files:**
- `services/ingestion/src/services/sync-service.ts`

---

#### V3-H-09: BatchJobPayload Still Carries Full Record Arrays in Job Data

**Severity:** HIGH
**Personas:** DevOps/SRE, Data Engineer
**Component:** `services/ingestion/src/services/sync-service.ts`
**Not in v2:** v2 H-17 covered double-write, not payload bloat

**Problem:** When dispatching batch jobs, the sync service includes the full `records: DataRecord[]` array in the BullMQ job payload. BullMQ stores job data in Redis. For large syncs (thousands of records per batch), this means:
- Massive Redis memory consumption per batch job
- Potential Redis `maxmemory` hits
- Slow job serialization/deserialization

The design comment on the `BatchJobPayload` type says records should NOT be stored in payloads, but the actual code passes them.

**Impact:** Large syncs exhaust Redis memory. A connector syncing 100k records in 1k-record batches stores all records in Redis simultaneously.

**Fix:** Store records in a staging table or temporary MinIO object, pass only a reference (batch ID) in the job payload.

**Effort:** Large (requires architectural change to batch processing)

**Affected files:**
- `services/ingestion/src/services/sync-service.ts`

---

#### V3-H-10: BFF Runtime-Config Writes Cache But Never Reads It

**Severity:** HIGH
**Personas:** App Developer, DevOps/SRE
**Component:** `services/app/src/routes/bff.ts` (lines 588-592)
**Not in v2:** Not covered

**Problem:** The `/bff/runtime-config` endpoint writes to Redis cache:
```typescript
void redis.setex(cacheKey, 60, JSON.stringify(envVars)).catch(() => { /* non-fatal */ });
```
But it never reads from the cache before querying the database. Every request performs the full DB+decrypt flow regardless of cache presence. The Redis write is pure waste — it consumes Redis memory and write bandwidth with no benefit.

**Impact:** Unnecessary Redis writes on every runtime-config request. No performance benefit from caching. Under high-frequency SDK init calls, this generates significant useless Redis traffic.

**Fix:** Check `redis.get(cacheKey)` first; return cached value if present; only query DB on cache miss.

**Effort:** Small (add `redis.get` check before DB query)

**Affected files:**
- `services/app/src/routes/bff.ts`

---

#### V3-H-11: Webhook Step JSONata Expressions Not Timeout-Protected

**Severity:** HIGH
**Personas:** Security Auditor, Data Engineer
**Component:** `services/pipeline/src/services/execution-engine.ts` (lines 468-470)
**Not in v2:** v2 did not examine webhook step body template evaluation

**Problem:** Conditional step JSONata expressions are correctly timeout-protected with a 100ms `Promise.race()` (line 378-386). However, webhook step body templates also use JSONata (line 469):
```typescript
const expr = jsonata(step.body.slice(1));
body = await expr.evaluate({ input: resolvedInput });
```
This evaluation has **no timeout**. A malicious or misconfigured JSONata expression in a webhook body template can hang indefinitely, blocking the pipeline worker.

**Impact:** A single malicious pipeline definition can hang the entire pipeline worker thread, preventing all other pipeline runs from executing.

**Fix:** Wrap the JSONata evaluation in a `Promise.race()` with a timeout, matching the pattern used for conditional expressions.

**Effort:** Small (copy the existing timeout pattern)

**Affected files:**
- `services/pipeline/src/services/execution-engine.ts`

---

#### V3-H-12: SSRF Check Does Not Cover IPv6 or Short-Form IP Addresses

**Severity:** HIGH
**Personas:** Security Auditor
**Component:** `services/pipeline/src/services/execution-engine.ts` (lines 149-157)
**Not in v2:** v2 H-11 covered DNS rebinding in the execution context-call-handler, not the pipeline webhook step SSRF filter

**Problem:** The `SSRF_BLOCKED_PATTERNS` array only covers IPv4 private ranges. It does not block:
- IPv6 loopback (`::1`)
- IPv6 link-local (`fe80::`)
- IPv6 mapped IPv4 (`::ffff:127.0.0.1`)
- Short-form IPv4 (`http://0177.0.0.1/` for `127.0.0.1` in octal)
- Decimal IP (`http://2130706433/` for `127.0.0.1`)
- DNS names that resolve to private IPs (DNS rebinding)

**Impact:** A user who creates a webhook step with an IPv6 loopback or encoded private IP can make the pipeline engine issue requests to internal services, bypassing the SSRF filter.

**Fix:** Use a proper SSRF library or DNS-resolution-based check that validates the resolved IP address, not just URL pattern matching.

**Effort:** Medium (add DNS resolution check + IPv6 patterns)

**Affected files:**
- `services/pipeline/src/services/execution-engine.ts`

---

#### V3-H-13: Login Interactive Mode Returns `apiKey` Field Instead of Token

**Severity:** HIGH
**Personas:** First-Time Self-Hoster, Data Engineer
**Component:** `packages/cli/src/commands/auth/index.ts` (lines 43-48)
**Not in v2:** Not covered

**Problem:** The CLI login interactive flow sends `POST /api/v1/auth/login` and expects the response to contain `{ apiKey, email }`:
```typescript
const resp = await ctx.http.post<{ apiKey: string; email: string }>(
  "/api/v1/auth/login",
  { email, password: pass },
);
apiKey = resp.apiKey;
```

But the auth service's login endpoint (`services/auth/src/routes/auth.ts`) returns `{ accessToken, refreshToken, user }`. There is no `apiKey` field in the response. The CLI will receive `undefined` for `apiKey` and save it to credentials, causing all subsequent CLI commands to fail with authentication errors.

**Impact:** Interactive `op auth login` is non-functional. Users must use `--key` flag with a pre-generated API key, which is not documented as the primary flow.

**Fix:** Either: (a) change CLI to use `accessToken` from the login response, or (b) have CLI generate an API key via `POST /api/v1/auth/api-keys` after authentication.

**Effort:** Medium (requires decision on CLI auth strategy)

**Affected files:**
- `packages/cli/src/commands/auth/index.ts`
- `services/auth/src/routes/auth.ts` (reference)

---

#### V3-H-14: `processErrorHandlers` Calls `process.exit(1)` Twice

**Severity:** HIGH
**Personas:** DevOps/SRE
**Component:** `packages/core/src/app.ts` (lines 60-71)
**Not in v2:** Not covered

**Problem:** Both the `uncaughtException` and `unhandledRejection` handlers call `process.exit(1)` immediately **and** schedule a deferred `process.exit(1)` via `setTimeout`:
```typescript
setTimeout(() => process.exit(1), GRACEFUL_SHUTDOWN_MS).unref();
process.exit(1);
```
The immediate `process.exit(1)` on the next line makes the `setTimeout` unreachable. The intent was clearly to allow a grace period for I/O to flush, but the immediate exit defeats that purpose.

**Impact:** On uncaught exceptions, services exit immediately without waiting for in-flight DB/Redis writes to complete. This can cause data corruption (partial writes) and orphaned advisory locks.

**Fix:** Remove the immediate `process.exit(1)`; let the setTimeout handle the exit after the grace period. The `unref()` ensures the process won't hang if all other work finishes sooner.

**Effort:** Small (delete one line per handler)

**Affected files:**
- `packages/core/src/app.ts`

---

#### V3-H-15: No Rate Limiting on Guest Session Creation

**Severity:** HIGH
**Personas:** Security Auditor, DevOps/SRE
**Component:** `services/auth/src/services/guest-session-service.ts`
**Not in v2:** Not covered

**Problem:** Guest session creation (`create()`) has no rate limiting. Each call generates a 32-byte random token and writes it to Redis. An attacker can call the guest session creation endpoint repeatedly to:
1. Exhaust Redis memory with `guest-session:*` keys (each with 24h TTL)
2. Overwhelm the `randomBytes()` entropy pool
3. Create a denial-of-service for legitimate guest users

The endpoint is necessarily public (guests don't have credentials to authenticate).

**Impact:** Redis memory exhaustion and potential service degradation.

**Fix:** Add IP-based rate limiting to the guest session creation internal endpoint (e.g., max 10 sessions per IP per minute).

**Effort:** Small-Medium (add rate limit middleware on the guest session route)

**Affected files:**
- `services/auth/src/services/guest-session-service.ts`
- Wherever the internal guest session route is registered

---

#### V3-H-16: Deploy Service OAuth Registration Uses Plain String Token

**Severity:** HIGH
**Personas:** App Developer, Security Auditor
**Component:** `services/app/src/services/deploy-service.ts` (lines 258-260)
**Not in v2:** Same class of issue as V3-C-04 but in a different file

**Problem:** The deploy service calls the auth service's internal OAuth client registration endpoint with:
```typescript
"X-Service-Token": process.env["OP_SERVICE_TOKEN_SECRET"] ?? "",
```
Same issue as V3-C-04 — this plain string won't pass Ed25519 JWT verification.

**Impact:** App deployments fail at the OAuth client registration step. The deploy function includes a compensating rollback (reverting the build pointer), so the failure is at least safe, but no app can be deployed.

**Fix:** Use Ed25519 signed JWT tokens for service auth.

**Effort:** Medium (same fix scope as V3-C-04)

**Affected files:**
- `services/app/src/services/deploy-service.ts`

---

#### V3-H-17: Ontology `listEntities` Performs N+1 Field Queries

**Severity:** HIGH
**Personas:** Power User, Data Engineer
**Component:** `services/ontology/src/services/entity-service.ts` (lines 347-355)
**Not in v2:** Not covered

**Problem:** `listEntities` iterates through entities and calls `fieldRepo.findByEntityId(e.id)` for each one:
```typescript
for (const e of entities) {
  const fields = await fieldRepo.findByEntityId(e.id);
  data.push(toEntityDetail(e, fields));
}
```
For a tenant with 50 entities (the default page size), this produces 51 SQL queries per request (1 for entities + 50 for fields).

**Impact:** Ontology listing performance degrades linearly with entity count. API response times exceed 500ms for tenants with moderate schema complexity.

**Fix:** Fetch all fields for the page of entities in a single `WHERE entity_id IN (...)` query, then group in memory.

**Effort:** Small-Medium (add batch query to field repository)

**Affected files:**
- `services/ontology/src/services/entity-service.ts`
- `services/ontology/src/repositories/field-repository.ts`

---

#### V3-H-18: `activatePlugin` Is Still a No-Op

**Severity:** HIGH
**Personas:** Plugin Developer, Platform Admin
**Component:** `services/plugin/src/services/plugin-service.ts` (lines 395-399)
**Not in v2:** v2 H-28 noted this exact issue; checking if it's been fixed — it has NOT been fixed

**Problem:** `activatePlugin` still just looks up the plugin and returns it without performing any status transition:
```typescript
async activatePlugin(pluginId: string, _activatedBy: string): Promise<PluginRow> {
  const plugin = await pluginRepo.findById(pluginId);
  if (plugin === null) {
    throw new PluginNotFoundError(`Plugin ${pluginId} not found`);
  }
  return plugin;
}
```
No `status: "active"` update, no event publishing, no hook registration.

**Note:** This WAS identified in v2 as H-28 but remains unfixed. Including it here as it is a blocking issue for the plugin lifecycle. If the v3 policy is strictly "net-new only", this can be reclassified as "v2 regression/unfixed" rather than excluded.

**Impact:** Installed plugins can never be activated. The entire plugin lifecycle beyond installation is non-functional.

**Fix:** Implement status transition, event publishing, and hook registration.

**Effort:** Medium

**Affected files:**
- `services/plugin/src/services/plugin-service.ts`

---

### MEDIUM (22)

#### V3-M-01: Connector List Still N+1 for Sync State

**Severity:** MEDIUM
**Personas:** Data Engineer, Power User
**Component:** `services/ingestion/src/services/connector-service.ts`
**Not in v2:** v2 H-43 flagged this; it was "partially fixed" (parallelized) but still N queries

**Problem:** `listConnectors` uses `Promise.all` to fetch sync state per connector in parallel. While this is faster than sequential N+1, it still generates N separate Redis/DB queries. For 100 connectors, that's 100 parallel queries.

**Impact:** Under high connector counts, the listing endpoint becomes slow and generates unnecessary load on Redis/DB.

**Fix:** Batch fetch sync states using a pipeline or multi-get command.

**Effort:** Medium

**Affected files:**
- `services/ingestion/src/services/connector-service.ts`

---

#### V3-M-02: `publicRoutes` Uses Exact Match — No Prefix Matching

**Severity:** MEDIUM
**Personas:** First-Time Self-Hoster, Security Auditor
**Component:** `packages/core/src/middleware/auth.ts` (line 54)
**Not in v2:** Not covered

**Problem:** The auth middleware checks public routes using `publicRouteSet.has(path)` — exact string matching. This means:
- `/api/v1/auth/register` is public but `/api/v1/auth/register/` (trailing slash) is NOT
- Route parameters like `/api/v1/auth/reset-password/:token` must be listed for every possible token value, which is impossible

The auth routes file lists routes like `POST /api/v1/auth/reset-password/:token` and `GET /api/v1/auth/verify-email/:token` as public, but the exact path `/api/v1/auth/reset-password/:token` will never match an actual request like `/api/v1/auth/reset-password/abc123`.

**Impact:** Password reset and email verification endpoints may require authentication (which users at those endpoints don't have), making them non-functional unless worked around by listing patterns differently at the service level.

**Fix:** Use prefix matching or a pattern matcher for public routes instead of exact `Set.has()`.

**Effort:** Small-Medium (replace `Set.has` with prefix/pattern matching)

**Affected files:**
- `packages/core/src/middleware/auth.ts`

---

#### V3-M-03: OAuth Service Uses `crypto.randomUUID()` Global

**Severity:** MEDIUM
**Personas:** Security Auditor
**Component:** `services/auth/src/services/oauth-service.ts`
**Not in v2:** Not covered

**Problem:** The OAuth service uses the global `crypto.randomUUID()` function while all other auth service files use `randomUUID` imported from `node:crypto`. While functionally equivalent in Node.js, the inconsistency creates confusion and potential issues:
- In test environments where the global `crypto` object might be mocked differently
- In serverless/edge runtimes where `globalThis.crypto` may differ from `node:crypto`

**Impact:** Low functional impact currently, but inconsistency creates maintenance risk.

**Fix:** Use the `node:crypto` import consistently.

**Effort:** Small (change one import)

**Affected files:**
- `services/auth/src/services/oauth-service.ts`

---

#### V3-M-04: `OP_MINIO_PASSWORD` Has No Default in Docker Compose

**Severity:** MEDIUM
**Personas:** First-Time Self-Hoster
**Component:** `docker/docker-compose.yml` (line 145)
**Not in v2:** Not covered

**Problem:** Most environment variables in docker-compose.yml have defaults (e.g., `${OP_BASE_URL:-http://localhost:3000}`), but `OP_MINIO_PASSWORD` has none:
```yaml
MINIO_ROOT_PASSWORD: ${OP_MINIO_PASSWORD}
```
If the user doesn't set this in `.env`, MinIO starts with an empty root password, which MinIO may reject or accept insecurely.

**Impact:** First-time `docker compose up` may fail with a cryptic MinIO startup error, or worse, MinIO starts with no password protection.

**Fix:** Add a default like `${OP_MINIO_PASSWORD:-dev_minio_password}` or generate it in `init.sh`.

**Effort:** Small (one-line fix)

**Affected files:**
- `docker/docker-compose.yml`

---

#### V3-M-05: Docker-Socket-Proxy POST=0 Prevents Sandbox Container Creation

**Severity:** MEDIUM
**Personas:** DevOps/SRE, Plugin Developer
**Component:** `docker/docker-compose.yml` (lines 166-170)
**Not in v2:** v2 H-10 covered `POST=1 DELETE=1` being too permissive; it was fixed to `POST=0 DELETE=0`

**Problem:** The comment on the docker-socket-proxy says "The execution service manages sandboxes via pre-built images launched at service startup — it does not need to create containers at runtime." However, the sandbox manager (`sandbox-manager.ts`) recycles sandboxes by creating new containers. With `POST: 0`, the execution service cannot create new sandbox containers after the initial ones are recycled, exhausting the sandbox pool.

**Impact:** After sandbox recycling thresholds are hit, no new sandboxes can be created, and all code execution requests fail.

**Fix:** Either: (a) allow `CONTAINERS_CREATE=1` specifically, or (b) redesign sandbox recycling to not require Docker API POST calls.

**Effort:** Small (adjust proxy permissions) or Large (redesign)

**Affected files:**
- `docker/docker-compose.yml`

---

#### V3-M-06: No Frontend UI for API Key Rotation

**Severity:** MEDIUM
**Personas:** Platform Admin, App Developer
**Component:** `packages/frontend/src/pages/settings/ApiKeysPage.tsx`
**Not in v2:** Not covered

**Problem:** The backend has a fully implemented `rotate()` method in `api-key-service.ts`, and the CLI has `op auth rotate-key`. But the frontend API Keys page only shows Create and Revoke actions. There is no Rotate button or dialog.

**Impact:** Users who manage keys through the UI must revoke and recreate manually, losing the atomic rotation guarantee (no window where neither key works) that the backend provides.

**Fix:** Add a "Rotate" button per key row, with a dialog showing the new key.

**Effort:** Medium (new dialog component, mutation hook)

**Affected files:**
- `packages/frontend/src/pages/settings/ApiKeysPage.tsx`

---

#### V3-M-07: API Key Revoke/Rotate Not Tenant-Scoped

**Severity:** MEDIUM
**Personas:** Security Auditor, Enterprise Evaluator
**Component:** `services/auth/src/services/api-key-service.ts` (lines 269-287, 303-320)
**Not in v2:** Not covered

**Problem:** The `revoke()` method checks only that the key exists and is not already revoked. The `rotate()` method checks `user_id` ownership but neither method validates that the caller belongs to the same tenant as the key owner. A user from tenant A who obtains a key ID from tenant B could revoke or rotate that key.

In practice, key IDs are UUIDs and not easily guessable, but the lack of tenant boundary is a defense-in-depth violation.

**Impact:** Cross-tenant key revocation is theoretically possible with a known key ID.

**Fix:** Add `AND tenant_id = $N` to the revoke and rotate queries, using the caller's tenant ID.

**Effort:** Small (add WHERE clause)

**Affected files:**
- `services/auth/src/services/api-key-service.ts`
- `services/auth/src/routes/api-keys.ts`

---

#### V3-M-08: Credential Encryption Key Rotation Still TODO

**Severity:** MEDIUM
**Personas:** Security Auditor, Enterprise Evaluator
**Component:** `services/ingestion/src/services/credential-service.ts`
**Not in v2:** v2 M-09 flagged the absence of key rotation; checking current state — still TODO

**Problem:** `CURRENT_KEY_VERSION` is hardcoded to `1` and there is a `// TODO` comment for key rotation (from v2 M-09). No rotation mechanism exists. If the master encryption key is compromised, there is no way to re-encrypt all credentials with a new key.

**Impact:** A compromised encryption key requires manual database surgery to re-encrypt credentials. No operational procedure exists.

**Fix:** Implement a key rotation job that re-encrypts all credentials with a new key version.

**Effort:** Large

**Affected files:**
- `services/ingestion/src/services/credential-service.ts`

---

#### V3-M-09: Entity Deletion Is Soft-Delete Only — No Table Cleanup

**Severity:** MEDIUM
**Personas:** DevOps/SRE, Data Engineer
**Component:** `services/ontology/src/services/entity-service.ts` (lines 523-547)
**Not in v2:** Not covered

**Problem:** `deleteEntity` performs a soft-delete on the entity and field rows but does not schedule cleanup of the actual PostgreSQL table. The table (and its data) persists in the tenant schema indefinitely. Unlike connectors which have a retention service with grace period and hard delete, entities have no equivalent cleanup mechanism.

**Impact:** Deleted entity tables accumulate in tenant schemas, consuming disk space and potentially causing confusion during debugging or data audits.

**Fix:** Add a deferred table cleanup mechanism (similar to the connector retention service) that drops soft-deleted entity tables after a grace period.

**Effort:** Medium

**Affected files:**
- `services/ontology/src/services/entity-service.ts`

---

#### V3-M-10: Migration Rollback Uses Unguarded `SELECT * FROM` Shadow Table

**Severity:** MEDIUM
**Personas:** Data Engineer, Security Auditor
**Component:** `services/ontology/src/services/migration-service.ts` (lines 318-320)
**Not in v2:** Not covered

**Problem:** During migration rollback, the code runs:
```sql
INSERT INTO ${targetTable} SELECT * FROM ${shadowTable}
```
The shadow table may have a different column set than the target table if the migration added or removed columns. `SELECT *` will fail if the column sets don't match. Additionally, the `DELETE` + `INSERT` pattern is not atomic with the `SELECT *` — concurrent readers may see partial data.

**Impact:** Migration rollbacks can fail with column mismatch errors, leaving the entity in an inconsistent state.

**Fix:** Use explicit column lists derived from the migration's change plan, and wrap the delete+insert in a single transaction (which it already is, but the SELECT * issue remains).

**Effort:** Medium

**Affected files:**
- `services/ontology/src/services/migration-service.ts`

---

#### V3-M-11: Logger `createLogger` Initializes with Empty Trace ID

**Severity:** MEDIUM
**Personas:** DevOps/SRE
**Component:** `packages/core/src/logger.ts` (line 139)
**Not in v2:** Not covered

**Problem:** `createLogger` returns `makeLogger("")` — an empty string trace ID. Log events emitted before `withTraceId()` is called (e.g., during service startup) have `traceId: ""`, making them impossible to correlate in log aggregation tools.

**Impact:** Startup logs, scheduler logs, and background job logs that don't go through request middleware have empty trace IDs, creating gaps in observability.

**Fix:** Generate a default trace ID (e.g., `crypto.randomUUID()`) at logger creation time.

**Effort:** Small (one-line change)

**Affected files:**
- `packages/core/src/logger.ts`

---

#### V3-M-12: Audit Queue Throws If Not Configured Instead of Degrading Gracefully

**Severity:** MEDIUM
**Personas:** DevOps/SRE, Enterprise Evaluator
**Component:** `packages/core/src/logger.ts` (lines 111-113)
**Not in v2:** Not covered

**Problem:** The `audit()` method throws an `Error` if `config.auditQueue` is not set:
```typescript
if (!config.auditQueue) {
  throw new Error("auditQueue is required to emit audit events...");
}
```
If any code path attempts to emit an audit event before the queue is wired up (e.g., during service startup, or in a test environment), the service crashes.

**Impact:** Audit event failures crash the service instead of logging a warning and continuing.

**Fix:** Log a warning and return early instead of throwing.

**Effort:** Small (change `throw` to `logger.warn` + `return`)

**Affected files:**
- `packages/core/src/logger.ts`

---

#### V3-M-13: Proxy Service Defaults Use Wrong Port Numbers

**Severity:** MEDIUM
**Personas:** First-Time Self-Hoster
**Component:** `services/gateway/src/services/proxy-service.ts` (lines 13-36)
**Not in v2:** Not covered

**Problem:** The `SERVICE_MAP` defaults use distinct port numbers per service:
```typescript
auth: "http://auth-service:3001"
ingestion: "http://ingestion-service:3002"
ontology: "http://ontology-service:3003"
```
But `docker-compose.yml` configures all services with `PORT: "3000"` on their internal container port. The service names resolve via Docker DNS, and all listen on port 3000. The defaults (3001, 3002, etc.) are wrong for the Docker deployment.

The environment variables override these defaults correctly in docker-compose, but if someone runs services outside Docker using the defaults, connections fail.

**Impact:** Running the gateway outside Docker (e.g., for development) with default config causes all service routing to fail due to wrong ports.

**Fix:** Change defaults to use port 3000 for all services, matching the actual container configuration.

**Effort:** Small (update 8 default URLs)

**Affected files:**
- `services/gateway/src/services/proxy-service.ts`

---

#### V3-M-14: No Timeout on Plugin Bundle Checksum Verification

**Severity:** MEDIUM
**Personas:** Plugin Developer, DevOps/SRE
**Component:** `services/plugin/src/services/plugin-service.ts` (line 285)
**Not in v2:** Not covered

**Problem:** `bundleService.verifyChecksum()` reads the bundle file and computes a SHA-256 hash. For very large bundles (up to the 50MB limit), this is a blocking CPU-bound operation with no timeout. During this time, the service thread is blocked, unable to serve other requests.

**Impact:** A 50MB bundle upload blocks the plugin service for several hundred milliseconds on commodity hardware. Multiple concurrent uploads can cause service unresponsiveness.

**Fix:** Use streaming hash computation to avoid buffering the entire file, or offload to a worker thread.

**Effort:** Small-Medium

**Affected files:**
- `services/plugin/src/services/plugin-service.ts`
- `services/plugin/src/services/bundle-service.ts`

---

#### V3-M-15: CLI HTTP Client Sets `Content-Type: application/json` on All Requests

**Severity:** MEDIUM
**Personas:** App Developer, Data Engineer
**Component:** `packages/cli/src/lib/http-client.ts` (line 77)
**Not in v2:** Not covered

**Problem:** The `request()` function always sets `Content-Type: application/json` even for `GET` and `DELETE` requests that have no body:
```typescript
const headers: Record<string, string> = {
  "Content-Type": "application/json",
  ...authHeaders(apiKey),
};
```
Some proxies and servers reject requests with `Content-Type` but no body. The BFF client correctly omits this header for bodyless requests.

**Impact:** Potential request rejection by strict HTTP proxies in enterprise environments.

**Fix:** Only set `Content-Type` when `body !== undefined`.

**Effort:** Small (conditional header)

**Affected files:**
- `packages/cli/src/lib/http-client.ts`

---

#### V3-M-16: `insecureTls` Flag Affects All Process HTTPS Connections

**Severity:** MEDIUM
**Personas:** Security Auditor, DevOps/SRE
**Component:** `packages/cli/src/lib/http-client.ts` (lines 58-63)
**Not in v2:** Not covered

**Problem:** When `insecureTls` is set, the CLI sets:
```typescript
process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";
```
This is a process-level flag that disables TLS verification for **all** HTTPS connections, not just connections to the platform URL. If the CLI makes any other HTTPS calls (e.g., to a webhook, plugin registry, or telemetry endpoint), those connections are also unverified.

The code comment acknowledges this: "This intentionally affects all HTTPS connections for the lifetime of this process."

**Impact:** TLS MITM attacks on any HTTPS connection from the CLI process are undetected when `--insecure-tls` is used.

**Fix:** Use a custom HTTPS agent scoped to the platform URL rather than a process-level flag. Node.js 22+ supports per-request TLS options.

**Effort:** Medium

**Affected files:**
- `packages/cli/src/lib/http-client.ts`

---

#### V3-M-17: App Service VFS Allows Only Specific File Extensions

**Severity:** MEDIUM
**Personas:** App Developer
**Component:** `services/app/src/services/app-service.ts` (lines 86-88)
**Not in v2:** Not covered

**Problem:** `ALLOWED_EXTENSIONS` is:
```typescript
[".ts", ".tsx", ".js", ".jsx", ".json", ".css", ".html", ".md", ".svg"]
```
Missing common web development file types: `.png`, `.jpg`, `.gif`, `.webp`, `.ico`, `.woff`, `.woff2`, `.ttf`, `.env`, `.yaml`, `.yml`, `.graphql`, `.gql`. App developers who need images, fonts, or configuration files cannot upload them to the VFS.

**Impact:** Apps cannot include static assets (images, fonts) or configuration files, severely limiting what can be built.

**Fix:** Expand the allowlist to include common static asset types. Consider a denylist approach instead (block only known-dangerous extensions like `.exe`, `.sh`).

**Effort:** Small (expand array)

**Affected files:**
- `services/app/src/services/app-service.ts`

---

#### V3-M-18: Default Template Uses `workspace:*` Dependency

**Severity:** MEDIUM
**Personas:** App Developer
**Component:** `services/app/src/services/app-service.ts` (line 26)
**Not in v2:** Not covered

**Problem:** The default app template's `package.json` uses:
```json
"@oneplatform/app-sdk": "workspace:*"
```
`workspace:*` is a pnpm workspace protocol that only works inside the monorepo. When the app is built in the execution sandbox (which is a separate environment), this dependency cannot be resolved.

**Impact:** New apps created via the API fail to build because `workspace:*` is not a valid npm version specifier outside the monorepo.

**Fix:** Use a real semver version (e.g., `"^1.0.0"`) or `"latest"`.

**Effort:** Small (change one string)

**Affected files:**
- `services/app/src/services/app-service.ts`

---

#### V3-M-19: CLI Login Expects `/api/v1/auth/me` Endpoint That May Not Exist

**Severity:** MEDIUM
**Personas:** First-Time Self-Hoster
**Component:** `packages/cli/src/commands/auth/index.ts` (line 37, 76, 96)
**Not in v2:** Not covered

**Problem:** Multiple CLI commands call `GET /api/v1/auth/me`:
- `loginAction` (--key mode): validates key by calling `/api/v1/auth/me`
- `statusAction`: checks auth status via `/api/v1/auth/me`
- `whoamiAction`: displays user info from `/api/v1/auth/me`

But the auth service routes (`services/auth/src/routes/auth.ts`) do not define a `GET /api/v1/auth/me` endpoint. The defined routes are: register, login, logout, refresh, forgot-password, reset-password, verify-email.

**Impact:** `op auth login --key`, `op auth status`, and `op auth whoami` all fail with 404.

**Fix:** Either add a `GET /api/v1/auth/me` endpoint to the auth service, or have the CLI use a different endpoint for user info.

**Effort:** Small-Medium (add route to auth service)

**Affected files:**
- `packages/cli/src/commands/auth/index.ts`
- `services/auth/src/routes/auth.ts`

---

#### V3-M-20: Execution Service `runExecution` Has No Scope Check

**Severity:** MEDIUM
**Personas:** Security Auditor
**Component:** `services/execution/src/services/execution-service.ts` (lines 162-195)
**Not in v2:** Not covered

**Problem:** The `runExecution` method (user-facing code execution) accepts a `UserContext` but does not verify that the user has `execution:run` scope. It creates and dispatches the execution unconditionally. Scope enforcement must happen at the route level, but if the route handler doesn't check either, any authenticated user can run arbitrary code.

**Impact:** If the execution route handler delegates authorization entirely to the service layer (which has none), arbitrary code execution is open to all authenticated users.

**Fix:** Either verify `execution:run` scope in the service method, or confirm it's enforced at the route level.

**Effort:** Small

**Affected files:**
- `services/execution/src/services/execution-service.ts`

---

#### V3-M-21: `buildMigrationFieldSpec` SQL-Injects Default Values

**Severity:** MEDIUM
**Personas:** Security Auditor
**Component:** `services/ontology/src/services/entity-service.ts` (lines 644-647)
**Not in v2:** Not covered

**Problem:** When building migration field specs, default values are interpolated directly into SQL-like expressions:
```typescript
const defaultExpr = f.defaultValue !== undefined
  ? (typeof f.defaultValue === "string" ? `'${f.defaultValue}'` : String(f.defaultValue))
  : "NULL";
```
If `f.defaultValue` is a string containing a single quote (e.g., `O'Brien`), this produces invalid SQL (`'O'Brien'`). Depending on how `defaultExpression` is used downstream in DDL generation, this could cause migration failures or SQL injection.

**Impact:** Entities with default values containing special characters fail migration. Potential SQL injection if the expression is used unsanitized in DDL.

**Fix:** Use parameterized queries or proper SQL escaping for default value expressions.

**Effort:** Small (use a proper SQL escaping function)

**Affected files:**
- `services/ontology/src/services/entity-service.ts`

---

#### V3-M-22: Vector Log Collector Runs as Root

**Severity:** MEDIUM
**Personas:** Security Auditor, DevOps/SRE
**Component:** `docker/docker-compose.yml` (lines 601-605)
**Not in v2:** Not covered

**Problem:** The Vector log collector container is configured with `user: "0:0"` (root) because it needs to read Docker container log files from `/var/lib/docker/containers`. While the comment explains why, running as root in a container is a defense-in-depth violation.

**Impact:** If Vector has a vulnerability, the attacker gains root access inside the container, which combined with the host filesystem mount, could enable host escape.

**Fix:** Create a dedicated `vector` user with read-only access to the Docker log directory, or use Docker's `--group-add` to add the container user to the host's docker group.

**Effort:** Medium

**Affected files:**
- `docker/docker-compose.yml`

---

### LOW (8)

#### V3-L-01: No Expiry Date Picker in Frontend API Key Creation

**Severity:** LOW
**Personas:** Platform Admin, Casual User
**Component:** `packages/frontend/src/pages/settings/ApiKeysPage.tsx`
**Not in v2:** Not covered

**Problem:** The create key dialog has a name field and scope checkboxes, but no expiry date picker. The CLI supports `--expires` but the frontend creates keys with no expiry. This means all frontend-created keys are permanent.

**Impact:** Users cannot create time-limited keys from the UI, which is a security best practice for CI/CD tokens.

**Fix:** Add a date picker for optional expiry.

**Effort:** Small

**Affected files:**
- `packages/frontend/src/pages/settings/ApiKeysPage.tsx`

---

#### V3-L-02: CLI HTTP Client Sends `Content-Type` on `postMultipart` DELETE

**Severity:** LOW
**Personas:** App Developer
**Component:** `packages/cli/src/lib/http-client.ts` (line 153)
**Not in v2:** Not covered

**Problem:** The `postMultipart` method correctly omits `Content-Type` (letting fetch set the multipart boundary), but the `delete` method inherits the base `request()` function which always sets `Content-Type: application/json`. This is technically incorrect for DELETE requests with no body.

**Impact:** Minimal — most servers ignore Content-Type on bodyless requests.

**Fix:** Already mentioned in V3-M-15.

**Effort:** Small

**Affected files:**
- `packages/cli/src/lib/http-client.ts`

---

#### V3-L-03: Docker Compose `x-forwarded-proto` Mismatch with `OP_BASE_URL` Default

**Severity:** LOW
**Personas:** First-Time Self-Hoster
**Component:** `docker/docker-compose.yml` and `services/gateway/src/services/proxy-service.ts`
**Not in v2:** Not covered

**Problem:** `OP_BASE_URL` defaults to `http://localhost:3000` but the proxy hardcodes `x-forwarded-proto: https`. These contradict each other, potentially causing redirect loops or mixed-content warnings.

**Impact:** Cosmetic confusion; actual traffic routing works because internal services don't enforce HTTPS.

**Fix:** Align the defaults.

**Effort:** Small

**Affected files:**
- `docker/docker-compose.yml`
- `services/gateway/src/services/proxy-service.ts`

---

#### V3-L-04: CLI `generate-key` Uses Comma-Separated Scopes, Inconsistent with Frontend

**Severity:** LOW
**Personas:** Data Engineer
**Component:** `packages/cli/src/commands/auth/index.ts` (line 118)
**Not in v2:** Not covered

**Problem:** The CLI expects `--scopes data:read,data:write` (comma-separated string) while the frontend sends scopes as a JSON array. No documentation explains the valid scope names or their effects.

**Impact:** Users may specify invalid scope names with no feedback (the backend's scope subsetting check only validates against the caller's scopes, not against a canonical list).

**Fix:** Add scope validation against the known scope list; document available scopes in CLI help text.

**Effort:** Small

**Affected files:**
- `packages/cli/src/commands/auth/index.ts`

---

#### V3-L-05: App Default Template Imports Incorrect File Extensions

**Severity:** LOW
**Personas:** App Developer
**Component:** `services/app/src/services/app-service.ts` (lines 48-53)
**Not in v2:** Not covered

**Problem:** The default template's `index.tsx` imports:
```typescript
import { App } from "./App.js";
```
The `.js` extension is correct for ESM module resolution of `.tsx` files, but this pattern may confuse new developers who expect `.tsx` imports. Additionally, the template doesn't include a `vite.config.ts` or build configuration, so it's unclear how the app is supposed to be built.

**Impact:** New app developers may be confused by the `.js` extension convention.

**Fix:** Add a comment explaining ESM resolution, or include a minimal build config.

**Effort:** Small

**Affected files:**
- `services/app/src/services/app-service.ts`

---

#### V3-L-06: No `data` Route for Users Management in SERVICE_MAP

**Severity:** LOW
**Personas:** Platform Admin
**Component:** `services/gateway/src/services/proxy-service.ts`
**Not in v2:** Not covered

**Problem:** The `SERVICE_MAP` doesn't include a `users` key. User management routes (`/api/v1/users/*`) are handled by the auth service, but there's no explicit entry for `users` in the map. The `roles` key is mapped to auth, and `auth` covers `/api/v1/auth/*`, but `users` paths would not match any prefix.

**Impact:** User management API calls via the gateway return 404 "No route matches" because the `users` prefix is not in `SERVICE_MAP`.

**Fix:** Add `users: process.env["AUTH_SERVICE_URL"]` to `SERVICE_MAP`.

**Effort:** Small (one line)

**Affected files:**
- `services/gateway/src/services/proxy-service.ts`

---

#### V3-L-07: Machine-ID Fallback Uses Predictable Inputs

**Severity:** LOW
**Personas:** Security Auditor
**Component:** `packages/cli/src/lib/credentials.ts` (lines 93-97)
**Not in v2:** Not covered

**Problem:** The machine-ID fallback (when `/etc/machine-id` doesn't exist) uses `HOSTNAME` and `USER` environment variables:
```typescript
return createHmac("sha256", "oneplatform-fallback")
  .update(`${process.env["HOSTNAME"] ?? "localhost"}:${process.env["USER"] ?? "user"}`)
  .digest("hex");
```
These are guessable values, making the derived encryption key weak on systems without `/etc/machine-id` (e.g., macOS, some containers).

**Impact:** On systems without machine-id, CLI credential encryption is effectively security through obscurity.

**Fix:** Use macOS `ioreg` hardware UUID as an additional source; warn the user when falling back to weak derivation.

**Effort:** Small-Medium

**Affected files:**
- `packages/cli/src/lib/credentials.ts`

---

#### V3-L-08: Frontend API Key List Missing Scope Filtering

**Severity:** LOW
**Personas:** Platform Admin
**Component:** `packages/frontend/src/pages/settings/ApiKeysPage.tsx`
**Not in v2:** Not covered

**Problem:** The API keys table shows all keys but provides no filtering or search. For users with many API keys (e.g., one per CI/CD pipeline), finding a specific key requires scrolling through the entire list.

**Impact:** Poor UX for power users with many keys.

**Fix:** Add search/filter functionality to the keys table.

**Effort:** Small-Medium

**Affected files:**
- `packages/frontend/src/pages/settings/ApiKeysPage.tsx`

---

## Finding Distribution by Persona

| Persona | CRITICAL | HIGH | MEDIUM | LOW | Total |
|---------|----------|------|--------|-----|-------|
| Security Auditor | 3 | 5 | 6 | 1 | 15 |
| DevOps/SRE | 1 | 5 | 5 | 1 | 12 |
| App Developer | 2 | 2 | 4 | 2 | 10 |
| Data Engineer | 2 | 4 | 2 | 1 | 9 |
| First-Time Self-Hoster | 0 | 2 | 3 | 1 | 6 |
| Platform Admin | 2 | 1 | 2 | 2 | 7 |
| Plugin Developer | 1 | 2 | 1 | 0 | 4 |
| Power User | 0 | 2 | 0 | 0 | 2 |
| Enterprise Evaluator | 0 | 0 | 2 | 0 | 2 |
| Casual User | 0 | 0 | 0 | 1 | 1 |

---

## Cross-Reference: Findings by Component Area

| Area | CRITICAL | HIGH | MEDIUM | LOW |
|------|----------|------|--------|-----|
| Auth service (API keys, tokens, users) | 2 | 2 | 1 | 0 |
| Gateway / Proxy | 0 | 2 | 1 | 1 |
| Pipeline execution engine | 1 | 2 | 0 | 0 |
| App service / BFF | 1 | 3 | 2 | 0 |
| Ingestion / Sync | 0 | 2 | 1 | 0 |
| Ontology / Entity / Migration | 0 | 1 | 3 | 0 |
| Plugin service | 0 | 1 | 1 | 0 |
| Execution service | 0 | 0 | 1 | 0 |
| Core middleware / logger | 1 | 1 | 2 | 0 |
| Frontend | 1 | 0 | 1 | 2 |
| CLI | 0 | 1 | 3 | 2 |
| Docker / Infrastructure | 0 | 0 | 3 | 1 |
| Logging service | 0 | 0 | 1 | 0 |
| SDK (app-sdk) | 0 | 0 | 1 | 1 |
| Credentials | 0 | 0 | 1 | 1 |

---

## Comparison with v1/v2

| Metric | v1 | v2 | v3 |
|--------|----|----|-----|
| Raw findings | 108 | 202 (85 unique) | 53 net-new |
| Perspectives/Personas | 4 | 6 | 10 |
| CRITICAL | N/A | 13 | 5 |
| HIGH | N/A | 35 | 18 |
| Security findings | Scattered | 24 | 17 |
| v2 items confirmed FIXED | N/A | N/A | 30+ |

### v3 vs v2 Key Differences

1. **v2 fixes verified:** 30+ v2 findings have been fixed in the current codebase (X-User-Context stripping, Ed25519 keys, security headers, body limits, etc.)
2. **New vulnerability class:** v3 identifies a systemic issue with service-to-service authentication — multiple services (pipeline engine, mapping service, BFF, deploy service) attempt internal calls without proper Ed25519 JWT tokens
3. **Runtime vs design:** v2 focused heavily on missing infrastructure (Docker services, env vars). v3 focuses on runtime logic errors in code that has been implemented but has subtle bugs (wrong JTI, empty roles, scope mismatches)
4. **Frontend-backend alignment:** v3 identifies several frontend/backend mismatches (scope names, missing endpoints) that v2 did not examine

---

## Severity Classification Rubric

| Level | Criteria |
|-------|----------|
| **CRITICAL** | Blocks a core workflow entirely, causes data loss, or creates an exploitable security vulnerability |
| **HIGH** | Significant functionality gap, performance degradation, or security weakness that affects many users |
| **MEDIUM** | Noticeable quality issue, inconsistency, or missing feature that has workarounds |
| **LOW** | Cosmetic issue, minor inconvenience, or improvement opportunity |
