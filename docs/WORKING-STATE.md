# OnePlatform — Working State

This document tracks the current state of development. Read this FIRST when resuming work.

## Current Phase: Phase 9 — Critical Fixes & Hardening

### Completed Phases

#### Phase 0: Architecture & Planning
- [x] Initial brainstorming and requirements gathering
- [x] 23 architecture decisions documented (`docs/decisions/001-architecture-decisions.md`)
- [x] 11 architecture review cycles — CLEAN APPROVED
- [x] User stories walkthrough — 108 friction points identified
- [x] 13 new ADR decisions (ADR 24-36) — 2 review cycles, CLEAN APPROVED
- [x] L1 design specification (2239 lines)
- [x] Detailed implementation plans for Phase 0 (infra) + Phase 1 (core)

#### Phase 1: Infrastructure & Core Library
- [x] Monorepo infrastructure + Docker Compose stack
- [x] Redis 7 AOF config and per-service ACL rules
- [x] `@oneplatform/core` foundation (types, config, errors, crypto, DB, Redis, queues, logger, events, health)
- [x] `@oneplatform/core` middleware stack + createApp() factory
- [x] Architecture review fixes (2 blockers + 6 warnings)

#### Phase 2: L2 Service Designs
- [x] L2 design documents for all 9 services + 4 packages (25,535 lines)
- [x] Cross-service consistency review (9 blocking + 10 warning fixes)

#### Phase 3: Service Implementation
- [x] Auth Service — full implementation + 182 unit tests + 6 security blocker fixes
- [x] Ontology Service — full implementation + 610 unit tests
- [x] Gateway Service — full implementation + tests
- [x] Logging Service — full implementation + tests
- [x] Ingestion Service — full implementation
- [x] Pipeline Service — full implementation + 450 unit tests + 6 blocker fixes
- [x] Execution Service — full implementation + 4 blocker fixes
- [x] App Service — full implementation + 530 unit tests + 7 blocker fixes
- [x] Plugin Service — full implementation + 557 unit tests + 7 blocker fixes

#### Phase 4: SDKs, CLI & Plugin SDK
- [x] `@oneplatform/sdk` — typed client, auth, pagination, SSE, filter builder (39 files)
- [x] `@oneplatform/app-sdk` — React hooks, BFF client, WebSocket, permission cache (32 files)
- [x] `@oneplatform/plugin-sdk` — types, manifest validation, testing utilities, dev tools
- [x] `@oneplatform/cli` — full implementation + review fixes
- [x] SDK review fixes (2 blockers, 4 warnings)
- [x] App SDK review fixes (1 blocker, 8 warnings)
- [x] Plugin SDK review fixes (4 blockers, 5 warnings)
- [x] CLI review fixes (3 blockers, 12 warnings)

#### Phase 5: Frontend Design
- [x] Frontend design specification (2016 lines)
- [x] Design review — 10 warnings + 4 suggestions addressed

#### Phase 6: Frontend Implementation
- [x] Layer 1 — scaffold, lib, stores, hooks, routing (52 files)
- [x] Layer 2 — shadcn/ui components, layout, shared (31 files)
- [x] Layer 3 — auth pages + 6-screen bootstrap wizard (18 files)
- [x] Layer 4 — dashboard, connectors, ontology, pipelines (28 files)
- [x] Layer 5 — apps, Monaco editor, plugins, logs, DLQ, metrics, settings (43 files)

#### Phase 7: Frontend Testing & Review
- [x] Frontend review fixes (3 blockers, 11 warnings)
- [x] Frontend test suite — 367 tests across 24 files
- [x] Test review fixes — safeRedirect security bug, false positives removed

#### Phase 8: Integration & E2E Testing
- [x] Integration test architecture design (APPROVED after 5 blocker fixes)
- [x] Service refactoring — all 9 services export createServiceApp() factory
- [x] Test infrastructure — helpers, env config, Docker Compose test profile
- [x] Level 1 integration tests — 20 files, ~126 tests across all 9 services
- [x] Level 1 review fixes — 4 blockers, 3 warnings
- [x] Level 2 cross-service HTTP tests — 9 services covered
- [x] Level 3 full-stack E2E tests — 4 test suites
- [x] Level 2/3 review cycle — 12 blockers + 8 warnings + 3 regressions fixed, GREEN
- [x] Shared test helpers extracted (e2e-auth.ts, wait-for-ready.ts)
- [x] User story analysis v2 — 85 findings from 6 perspectives (13 CRITICAL, 35 HIGH)

#### Phase 10: V3 Analysis & Comprehensive Hardening
- [x] NAPI crash fix (bcrypt + vitest worker_threads → pool: "forks")
- [x] DEVELOPMENT-PROCESS.md rewritten with agent workflow, implementation patterns
- [x] CLAUDE.md created pointing to development process
- [x] User story analysis v3 — 53 net-new findings from 10 personas (5 CRITICAL, 18 HIGH)
- [x] Gap analysis — 127 gaps across 9 categories (52 P1, 42 P2, 23 P3, 10 P4)
- [x] Architecture review cycle — verified fixes, identified remaining issues
- [x] All 5 CRITICAL fixes: API key roles (V3-C-01), frontend scopes (V3-C-02), pipeline service tokens (V3-C-03), BFF Ed25519 JWTs (V3-C-04), per-user token revocation (V3-C-05)
- [x] 17/18 HIGH fixes (V3-H-15 was already fixed):
  - V3-H-01: API key revocation TTL (revoke + rotate)
  - V3-H-02: Retention service cross-tenant sentinel
  - V3-H-03/04: BFF permissions/me filter to user's actual roles
  - V3-H-05/06: Gateway x-forwarded-for and x-forwarded-proto
  - V3-H-07: Mapping service Ed25519 auth headers
  - V3-H-08: Sync job listing ceiling raised (100 → 10K)
  - V3-H-09: Batch job payload 1MB size guard
  - V3-H-10: BFF runtime-config cache read-through
  - V3-H-11: JSONata 5s timeout protection
  - V3-H-12: SSRF guard expanded for IPv6
  - V3-H-13: CLI login field name fix (apiKey → accessToken)
  - V3-H-14: Process error handler double-exit removed
  - V3-H-16: Deploy service Ed25519 JWT
  - V3-H-17: Ontology N+1 query eliminated with batch fetch
  - V3-H-18: activatePlugin implemented (status update + event)
- [x] New core modules: service-token.ts (Ed25519 signer), cron.ts (shared validation)
- [x] NODE_ENV safety pattern applied to password reset and email verification
- [x] Implementation Patterns section added to DEVELOPMENT-PROCESS.md

- [x] All 22 MEDIUM fixes:
  - V3-M-01: Connector list N+1 → batch `findByConnectorIds` query
  - V3-M-02: Auth middleware public route prefix/pattern matching (was exact-match only)
  - V3-M-03: OAuth service `crypto.randomUUID()` → `randomUUID()` import
  - V3-M-04: Docker MinIO password default added
  - V3-M-05: Docker socket proxy POST=1, CONTAINERS=1, IMAGES=1 for sandbox creation
  - V3-M-06: Frontend API key rotation UI (button, confirm dialog, new key reveal)
  - V3-M-07: API key revoke/rotate tenant-scoped (AND tenant_id = $N)
  - V3-M-08: Credential encryption key rotation implemented (multi-version, optimistic lock)
  - V3-M-09: Entity deletion table cleanup (`cleanupDeletedEntities` with 7-day grace)
  - V3-M-10: Migration rollback uses column intersection (was SELECT *)
  - V3-M-11: Logger default trace ID (randomUUID instead of empty string)
  - V3-M-12: Audit queue graceful degradation (warn + return instead of throw)
  - V3-M-13: Gateway SERVICE_MAP default ports all → 3000
  - V3-M-14: Plugin bundle checksum 30s timeout wrapper
  - V3-M-15: CLI Content-Type only on requests with body
  - V3-M-16: CLI TLS warning when insecureTls enabled
  - V3-M-17: App VFS allowed extensions expanded (9 → 27 types)
  - V3-M-18: Default template `workspace:*` → `^1.0.0`
  - V3-M-19: Auth `/api/v1/auth/me` endpoint added for CLI
  - V3-M-20: Execution `runExecution` scope check (defense-in-depth)
  - V3-M-21: `buildMigrationFieldSpec` SQL-escapes default values
  - V3-M-22: Docker Vector container runs as nobody (UID 65534)
- [x] All 8 LOW fixes:
  - V3-L-01: Frontend API key expiry date picker (Never, 30d, 90d, 1y, Custom)
  - V3-L-02: CLI Content-Type on bodyless DELETE (covered by M-15)
  - V3-L-03: Docker proto/base-url consistency (verified, already aligned)
  - V3-L-04: CLI scope validation + help text listing all 19 valid scopes
  - V3-L-05: Default template tsconfig target ES2022
  - V3-L-06: Gateway SERVICE_MAP `users` route → auth service
  - V3-L-07: CLI machine-ID macOS UUID + OP_MACHINE_ID override + weak fallback warning
  - V3-L-08: Frontend API key search/filter

#### Phase 11: V4 Analysis & Fixes
- [x] User story analysis v4 — 148 net-new findings from 10 personas across 60+ files
- [x] 10-persona parallel analysis using workflow with 197 agents + adversarial verification
- [x] 38 false positives refuted during verification
- [x] Infrastructure fixes: Redis ACL (execution user, bull: prefixes), Redis URL username, README quick start, backup.sh auth, MinIO password guard, gateway fallback ports, OP_SMTP_FROM relaxed, BootstrapErrorPage healthz fix
- [x] Auth/Logging fixes: user listing with pagination/filtering, per-user token revocation check, role rename cascades to user arrays, logging tenant_id column, role deletion guard, safe SQL interval casting
- [x] SDK/App fixes: tenant-scoped BFF cache key, build-service decryption fail-fast, platform-types resource, apps pagination, service token JWT auth
- [x] Frontend fixes: AuditLogTable overhaul, ServiceHealthGrid enhancements, NewConnectorPage wizard with recovery path, AdminPage/TeamsPage placeholders, ApiKeysPage rotation fix, scope descriptions
- [x] Plugin/Execution fixes: scaffold auth-provider signature fix, cache operations fail-fast on missing pluginId, HookStage/HookPayloadDataMap key alignment, mock context factories
- [x] Data engineer fixes: CLI connector/pipeline/schedule improvements, mapping-rules tenant isolation, mapping-service batch upsert, execution-engine N+1 fix, upload service enhancements
- [x] 6 parallel code reviews — all blockers resolved
- [x] All type checks pass, all ~6,800 tests pass

### Pending
1. Docker Compose — add all 9 application service containers
2. TLS configuration and security hardening
3. Operational documentation (deployment, operations, upgrade guides)
4. Auto-generated API docs pipeline
5. BSL license file
6. Final end-to-end verification

## Test Totals

| Area | Tests |
|------|-------|
| Services (unit) | ~5,623 |
| SDK | 82 |
| Plugin SDK | 61 |
| App SDK | 105 |
| Frontend | 367 |
| Integration L1 | ~126 |
| Integration L2 | ~50 |
| Integration L3 (E2E) | ~28 |
| **Total** | **~6,442** |

## Key References

| File | Purpose |
|------|---------|
| `docs/decisions/001-architecture-decisions.md` | 36 architecture decisions (L0 reference) |
| `docs/designs/*.md` | L2 service designs |
| `docs/USER-STORIES-ANALYSIS-V2.md` | Friction point analysis v2 (85 findings) |
| `docs/USER-STORIES-ANALYSIS-V3.md` | Friction point analysis v3 (53 net-new findings) |
| `docs/USER-STORIES-ANALYSIS-V4.md` | Friction point analysis v4 (148 net-new findings) |
| `docs/GAP-ANALYSIS.md` | Gap analysis (127 gaps across 9 categories) |
| `docs/ARCH-REVIEW-REMAINING-ISSUES.md` | Architecture review of remaining issues |
| `DEVELOPMENT-PROCESS.md` | Development pipeline and quality gates |
| `.claude/handoff.md` | Session continuity handoff |
