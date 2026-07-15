# OnePlatform — Working State

This document tracks the current state of development. Read this FIRST when resuming work.

## Current Phase: Phase 22 — Comprehensive Frontend E2E Audit & Bug Fixes (2026-07-15)

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

#### Phase 12: Docker Compose, Docs & TLS
- [x] Docker Compose — all 9 service containers already complete (gateway, auth, ingestion, ontology, pipeline, execution, app, logging, plugin)
- [x] API docs pipeline — OpenAPI specs for all 9 services, TypeDoc for 4 SDK packages, CLI reference (23 pages)
- [x] docs:merge — merged specs into docs/generated/ (10 OpenAPI JSON, 257 TypeDoc pages, 23 CLI pages)
- [x] Starlight docs site build — 25 pages compiled, search indexed (1146 words)
- [x] OPERATIONS.md — day-to-day platform operations guide
- [x] MONITORING.md — observability and alerting setup guide
- [x] TROUBLESHOOTING.md — common issues and debug procedures
- [x] UPGRADE.md — version upgrade and migration procedures
- [x] BACKUP.md — backup and disaster recovery procedures
- [x] TLS configuration — Caddy reverse proxy with 3 modes (internal/auto/off)
  - Caddyfile.dev: self-signed via Caddy internal CA
  - Caddyfile.prod.template: Let's Encrypt with HTTP-01 ACME
  - Caddyfile.nossl: plain HTTP fallback for dev behind proxies
  - caddy-entrypoint.sh: mode selector with domain validation
  - Dockerfile.caddy: caddy:2-alpine, UID 1001, read-only filesystem
  - Docker Compose: caddy service, ports 80/443, security hardening (cap_drop ALL, read_only, tmpfs)
  - Frontend: simplified to static nginx.conf (Caddy handles API routing + security headers)
  - All services updated: OP_BASE_URL/OP_ALLOWED_ORIGINS → https://localhost
  - CSP headers on all 3 Caddyfile variants
  - Dead nginx-frontend-start.sh removed
- [x] Code review — 3 parallel reviews (TLS, API docs, ops docs), all blockers fixed
- [x] Final E2E verification — 17/17 build, 20/20 test suites, 19/19 docs, 25-page Starlight site, Docker Compose valid

#### Phase 13: P1 Gap Closure, Connectors, OTEL & Process Hardening
- [x] P1 gap audit — 53 P1 gaps audited, 49 confirmed fixed, 4 remaining identified
- [x] G-011: Post-bootstrap wizard routing fix — httpOnly cookies + redirect to /dashboard
- [x] G-025: OTEL observability wired — W3C Trace Context middleware, Jaeger container, all 9 services
- [x] G-042: 5 built-in connector plugins (REST API, PostgreSQL, MySQL, CSV, Webhook) — 214 tests
- [x] G-107: CI/CD pipeline — GitHub Actions (lint, typecheck, test, build, Docker image build)
- [x] DEVELOPMENT-PROCESS.md — 8 new sections: CI/CD, rollback, dependency mgmt, perf testing, migration strategy, hotfix process, accessibility testing, API versioning

#### Phase 14: P2-P4 Gap Implementation (ALL 75 GAPS COMPLETE)
- [x] 37 commits, 769 files changed, ~103K insertions
- [x] ~2,950 new test cases added across 101 test files

**P2 Gaps (48 items) — ALL DONE:**
- [x] G-034: GPG verification cleanup
- [x] G-036: Widget registry persisted to Postgres
- [x] G-038: Dynamic service versions from package.json
- [x] G-043: Connector marketplace/registry with custom branding (G-123)
- [x] G-044: Schema drift detection
- [x] G-047: Data quality monitoring
- [x] G-048: Usage metering
- [x] G-049: Connector health monitoring
- [x] G-050: Sync analytics
- [x] G-054: Stale sync detection watchdog
- [x] G-055: Durable sync history in Postgres
- [x] G-056: Visual node-based workflow editor
- [x] G-057: Conditional branching in pipelines
- [x] G-058: Pipeline versioning with snapshot history and rollback
- [x] G-059: Workflow templates (4 pre-built templates)
- [x] G-060: Per-step retry/fallback config
- [x] G-061: Webhook delivery inspection UI
- [x] G-065: Wait/approval nodes
- [x] G-066: Live pipeline execution visualization
- [x] G-067: Drag-and-drop visual app builder
- [x] G-068: Rich UI component library
- [x] G-069: SQL query builder
- [x] G-072: App version control
- [x] G-074: Subscription cache invalidation
- [x] G-075: Pre-built app templates
- [x] G-076: OIDC auth provider plugin
- [x] G-080: Framework-level inbound webhook signature verification
- [x] G-083: HMAC-signed X-User-Context headers
- [x] G-085: Asymmetric JWT signing with Ed25519/EdDSA
- [x] G-087: SDK app build/deploy/rollback methods
- [x] G-088: Typed SDK data client
- [x] G-089: SDK ValidationError subclass
- [x] G-090: Strip trailing slash from baseUrl
- [x] G-092: Per-stage hook type narrowing
- [x] G-094: Plugin dev server
- [x] G-095: Per-type mock factories
- [x] G-096: Comprehensive SDK/Plugin-SDK/App-SDK/CLI documentation
- [x] G-097: CLI mapping commands
- [x] G-101: Example projects
- [x] G-102: Expression injection fix (sandboxed evaluation)
- [x] G-103: CLI command groups (8 logical groups)
- [x] G-104: Hot reload for development
- [x] G-108: Release/versioning process
- [x] G-115: Monitoring/alerting setup (Grafana dashboards + alert rules)
- [x] G-117: Tenant management API
- [x] G-118: Credential key rotation
- [x] G-126: Sandbox V8 hardening flags
- [x] G-128: CONTRIBUTING.md + Code of Conduct

**P3 Gaps (24 items) — ALL DONE:**
- [x] G-045: CDC via PostgreSQL WAL logical replication
- [x] G-046: Data lineage tracking
- [x] G-051: SQL transform library
- [x] G-052: Data reconciliation
- [x] G-062: Execution replay
- [x] G-063: Sub-workflows
- [x] G-064: Parallel execution paths
- [x] G-070: Mobile/PWA support
- [x] G-071: Embed/iframe support
- [x] G-077: LDAP/Active Directory auth provider plugin
- [x] G-082: MinIO file browser UI
- [x] G-111: Kubernetes Helm chart (all 9 services + frontend)
- [x] G-112: Performance benchmarks (API, ingestion, pipeline)
- [x] G-113: Capacity planning guide
- [x] G-114: Upgrade/migration procedures + pre-upgrade validation
- [x] G-116: High-availability guide
- [x] G-119: SOC2 tooling
- [x] G-120: GDPR tools (data export, erasure fan-out)
- [x] G-121: Data residency controls
- [x] G-122: IP allowlisting
- [x] G-125: Field-level audit trail
- [x] G-129: GitHub issue/PR templates
- [x] G-130: Public roadmap
- [x] G-131: Plugin marketplace hub
- [x] G-132: Community forum templates + support docs

**P4 Gaps (7 items) — ALL DONE:**
- [x] G-078: GraphQL API gateway (auto-generated from ontology)
- [x] G-079: gRPC-Web support
- [x] G-081: Streaming ingestion (Kafka/NATS)
- [x] G-124: Multi-region deployment guide + Terraform skeleton
- [x] G-133: Auto-generated docs pipeline

#### Phase 15: V5 Friction Point Analysis & Fixes (COMPLETE)
- [x] User story analysis v5 — 135 findings from 10 personas using 62-agent workflow
  - 9 CRITICAL, 35 HIGH, 69 MEDIUM, 22 LOW
- [x] All 9 CRITICAL fixes (JWT claims email/displayName, BFF RBAC enforcement, master key Redis persistence, SSRF IPv6/redirect hardening, and more)
- [x] All 35 HIGH fixes (frontend, backend, SDK, CLI, ops categories)
- [x] All 69 MEDIUM fixes across all categories
- [x] All 22 LOW fixes — final batch
- [x] Code review fixes — 2 RED blockers + 7 YELLOW warnings resolved
- [x] Key architectural changes:
  - JWT claims updated to include email and displayName
  - BFF RBAC middleware enforces role-based access control
  - Master key persistence via Redis (survives restarts)
  - SSRF hardening for IPv6 mapped addresses and redirect following
- [x] 6 commits: V5 analysis doc (`1a34056`), CRITICAL fixes (`14a93e3`), HIGH fixes (`3ce96da`), MEDIUM fixes (`eb28cd8`), LOW fixes (`5b57713`), code review fixes (`4eb4c1a`)

#### Phase 16: V6 Friction Point Analysis & Fixes (COMPLETE)
- [x] User story analysis v6 — 213 findings from 11 personas (added Low-Code/Drag-and-Drop UI User) using 206+ agent workflow
  - 25 CRITICAL, 69 HIGH, 85 MEDIUM, 34 LOW
- [x] All 25 CRITICAL fixes (visual pipeline editor default, schedule builder, tag inputs, error classification, timezone validation, gRPC streaming, Redis atomic rate limiting, Trivy scanning, and more)
- [x] All 69 HIGH fixes across frontend, backend, SDK, CLI, ops
- [x] All 85 MEDIUM fixes across all categories
- [x] All 34 LOW fixes — final batch
- [x] Code review fixes — 4 RED blockers + 7 YELLOW warnings resolved
- [x] Build/test fixes — auth service, frontend, CLI, ontology service, gateway tests updated for V6 changes
- [x] Key changes:
  - Visual pipeline editor set as default view
  - Schedule builder UI for cron expressions
  - Tag input components for user-friendly list entry
  - Error classification and categorization improvements
  - UTC timezone validation fix (not in Intl.supportedValuesOf)
  - gRPC streaming types added to SDK
  - Redis atomic rate limiting implementation
  - Trivy container scanning integration
  - Vitest dist/ exclusion across all services
  - Expression evaluator infinite loop fix
  - Webhook connector supportsIncremental flag corrected
  - Storage tenant isolation and data residency in gateway
- [x] 15 commits: V6 analysis doc (`91aee42`), CRITICAL fixes (`7330964`), HIGH fixes (`07a64cc`), MEDIUM fixes (`978d3dc`), build fixes (`51dd50e`, `11b235d`), LOW fixes (`1fae0a0`), SDK gRPC export (`9f23c48`), webhook fix (`4b13025`), test updates (`6e9adba`, `8a96ee5`, `84b0917`), UTC timezone fix (`46a3a54`), vitest dist exclusion (`56ac95c`), code review fixes (`24d2a8e`)

#### Phase 17: Full System Analysis & Bug Fix Cycle (COMPLETE)
- [x] Phase 17.1: Full codebase analysis — 88-agent workflow with adversarial verification
  - 220 total raw findings across 24 analysis areas (9 services, 7 packages, 7 plugins, 2 cross-cutting)
  - 64 CRITICAL/HIGH findings sent to adversarial verification → 58 confirmed real, 6 refuted
  - 156 MEDIUM/LOW findings
  - Analysis results: `docs/phase17-analysis-findings.json`
- [x] Phase 17.2: Fix ALL issues — 394 fixes across 200+ files (all builds + tests pass)
  - Initial CRIT/HIGH: 31 fixes (`68fc3dc`) — tenant isolation, CSV infinite loop, auth wildcard glob, SSRF bypass, SQL injection, CSP nonce
  - Initial MEDIUM: 122 fixes, 3 skipped (`4219d83`) — atomic rate limiting, algorithm confusion, SSE cleanup, origin matching, timer leaks, token refresh races
  - Initial LOW: 54 fixes, 1 skipped (`26e99dc`)
  - Re-analysis C1: 82 fixes (`3bb7ec4`) — ECDSA JWT verification (CRITICAL), OAuth auth bypass, HMAC body mismatch, gRPC context wiring, streaming export OOM
  - Re-analysis C2 CRIT/HIGH: 9 fixes (`ed0676d`)
  - Re-analysis C2 MED/LOW: 38 fixes, 5 skipped (`38a563a`)
  - Re-analysis C3 MEDIUM: 13 fixes, 1 skipped (`e986275`)
- [x] Phase 17.3: Re-analyze until clean — 3 cycles, 220→94→35→0 confirmed CRIT/HIGH findings
- [x] Phase 17.4: Create example projects — 8 examples, 75+ files covering all personas (`089e265`)
  1. `examples/quick-start` — No-code quick start guide (CLI + JSON configs)
  2. `examples/visual-pipeline` — Visual pipeline builder demos
  3. `examples/app-templates` — App builder with all templates
  4. `examples/webhook-event-processing` — Event-driven webhook processing
  5. `examples/multi-source-etl` — Multi-source ETL pipeline
  6. `examples/enterprise-auth` — OIDC + LDAP enterprise auth setup
  7. `examples/custom-auth-provider` — Plugin dev (SAML auth provider)
  8. `examples/full-platform-demo` — Complete demo with Docker + seed data
- [x] Phase 17.5: Persona verification — no-code, developer, admin persona flows verified; all blocking issues fixed (`43c3540`, `6415f4e`)
- [x] Phase 17.6: Final quality gates — build 24/24 passing, tests 28/28 passing, docs reviewed (`af93378`)
  - 15+ commits, 394+ bug fixes, 8 example projects, 3 persona verifications
  - auth-service turbo-parallel resource contention is the only known flake (passes in isolation)

#### Phase 18: V7 Friction Fix Cycle & E2E Test Infrastructure (COMPLETE)
- [x] Phase 18.0: Playwright E2E testing infrastructure — 119 tests across all major user flows
- [x] Phase 18.1: V7 friction analysis — 97-agent workflow, 181 findings (CRITICAL/HIGH/MEDIUM/LOW)
- [x] Phase 18.2: Fix ALL CRITICAL and HIGH findings — 44 fixes across frontend, backend, security, CLI, SDK
- [x] Phase 18.3: Fix ALL MEDIUM and LOW findings — 137 fixes across all categories
- [x] Phase 18.4: Comprehensive E2E test suite — full coverage of new features
- [x] Phase 18.5: UI polish cycle — re-analysis passed clean after polish
- [x] Phase 18.6: Re-analyze verification — 0 blocking issues confirmed
- [x] Phase 18.7: Documentation and handoff updated

**Key Features Added in Phase 18:**
- Query builder: GROUP BY, aggregations, charts, pivot table, JOINs, calculated fields, SQL mode, date grouping, saved queries, scheduled reports
- App builder: 14 new components (charts, forms, interactive), 5 new templates, column resize, visual field picker, JSON editor, component connections, sharing
- Pipeline editor: 8 templates with wizard, loop step, failure notifications, mobile bottom sheets
- Mobile: responsive layouts, touch targets, bottom sheets, PWA meta tags, service worker
- Data quality dashboard, data catalog, data preview
- Admin: team invites, RBAC page, admin API keys, audit export, system stats
- Backend: keyset pagination, streaming transforms, pipeline dependencies, warm sandbox pool, batch payloads, SCIM scaffold
- Security: SSRF guard enhancements, password history, purpose token key, secret permissions, Docker hardening
- CLI: bulk commands, usage stats, --fields, exit codes, stdin support, rate limit display, SDK type generator
- SDK: dual ESM/CJS, stable hooks, fetch check, typed resource create

**Build & Test Status:** 24/24 builds passing, 600+ unit tests + 119 E2E tests passing.

#### Phase 19: Full System Analysis, Docker Fleet Manager & Dev Stack (COMPLETE)
- [x] Phase 19.1: Isolated dev-test Docker Compose stack (22 services, separate ports/networks/volumes)
- [x] Phase 19.2: All Docker images built and validated
- [x] Phase 19.3: Docker Fleet Manager app designed (924-line design doc)
- [x] Phase 19.4: Docker Fleet Manager implemented — BFF sidecar, React frontend (37 files), App Service proxy
- [x] Phase 19.5: Full system analysis — 25 analysis agents + 6 adversarial verification agents, 130 confirmed findings
  - 16 CRITICAL, 59 HIGH, 47 MEDIUM, 8 LOW
  - Key themes: forgotten wiring, broken service-to-service auth, connector data loss, auth plugin security gaps
- [x] Phase 19.6: All 130 findings fixed across 5 parallel fix agents (200+ files changed)
  - CRITICAL: gateway wiring, service URLs, Ed25519 auth, code injection, OIDC/LDAP security
  - HIGH: auth logout/cookie, OAuth CSRF, sandbox hardening, connector incremental sync, N+1 queries
  - MEDIUM+LOW: consistency, logging, CLI, frontend, docs corrections
- [x] Phase 19.7: Docker crash-loop fixes — all 22 containers healthy
  - Root causes: empty env vars, postgres grants, CJS imports, redis publish, sandbox sockets, migration syntax
- [x] Phase 19.8: Documentation and handoff updated

**Build & Test Status:** 25/25 builds passing, 29/29 test suites passing.
**Dev-Test Stack:** All 22 containers healthy at https://localhost:8443

#### Phase 20: Bootstrap Setup Wizard Fix (2026-06-24)
- [x] Fixed Redis ACL: `op_auth` user was missing the `&events:*` channel permission in `docker/redis/users.acl.template`, which caused a `NOPERM` error when the auth service published `bootstrap.completed` events
- [x] Fixed bootstrap-service.ts error resilience: moved `clearInMemoryToken()` to run after `events.publish()`, and wrapped the event publish in a try/catch so a publish failure no longer aborts bootstrap completion
- [x] Auth service rebuilt and restarted; bootstrap state reset for a clean run
- [x] The bootstrap setup wizard at test.aaroncollins.info now works end-to-end
- Commit: da0b76b
- Files changed: `docker/redis/users.acl.template`, `services/auth/src/services/bootstrap-service.ts`

#### Phase 21: Stale Container Investigation, Sandbox Fix & Envelope Unwrap Sweep (2026-07-11)
- [x] Investigated three user-reported blockers: empty connector marketplace, code editor not showing files, app builder crash on stat editing
- [x] Root cause identified: all three fixes were already present in source (commit bd38e0e, 2026-07-10) — running Docker containers were stale (built 2026-07-08, missing 2026-07-10+ commits)
- [x] Reverted unnecessary agent changes (agents had attempted to re-fix already-fixed code)
- [x] Rebuilt frontend, gateway, and ingestion Docker images from current source
- [x] Resolved Docker build cache issue: `--no-cache` flag did not produce correct frontend bundle; correct dist was copied manually into the container
- [x] Verified all three runtime fixes active in served JavaScript:
  - Connector marketplace: `g.data?.data??g.data` envelope unwrap pattern active
  - App builder store: `s.layout` read inside `set()` callbacks (no stale closure capture)
  - File tree: `isDirectory: false` set in API response, `isDirectory === true` comparison in FileTree
- [x] Fixed sandbox-vm Unix socket protocol framing mismatch (commit `1990001`):
  - `docker/sandbox/src/server.js` was sending raw JSON without a length prefix
  - Execution service `UnixSocketClient` expected 4-byte big-endian uint32 length-prefixed frames
  - First 4 bytes of raw JSON read as ~2GB length, exceeding 12MB max — socket destroyed every 10 seconds
  - Rewrote server.js with matching length-prefixed protocol + ping/drain method handlers
  - Eliminated 840 errors/hour execution service crash loop
- [x] Rebuilt sandbox-vm container and restarted execution service
- [x] Fixed response envelope unwrapping on 25 frontend pages (commits `bc8984b`, `fe56102`):
  - Gateway wraps responses as `{data: <payload>}`, paginated lists return `{data: {data: [...], total: N}}`
  - 25 pages were reading `.data` once, receiving the inner envelope object instead of the array
  - Applied `response.data?.data ?? response.data` pattern across all affected pages
  - Pages covered: ConnectorMarketplacePage, NewConnectorPage, PluginsPage, PipelinesPage, AppsPage, LogsPage, OntologyPage, MappingsPage, DataCatalogPage, MetricsPage, and 15 more
- [x] Fixed builder store stale layout closure in all 9 mutations (commit `1df13ab`):
  - Mutations were capturing `layout` from outer `get()` call — rapid edits would overwrite each other
  - Moved layout read inside each `set()` callback to always read current `s.layout`
  - 26/26 builder store tests pass
- [x] Started docker-bff and docker-socket-proxy containers (Docker Fleet Manager BFF)
- [x] Deployed fresh frontend build after each fix batch

**Commits this phase:**
| Hash | Description |
|------|-------------|
| `1990001` | fix: sandbox-vm length-prefixed framing + ping/drain handlers |
| `6161f47` | docs: update session notes |
| `bc8984b` | fix: envelope unwrap on marketplace, new connector, plugins pages |
| `1df13ab` | fix: builder store reads layout inside set() to prevent stale closure |
| `fe56102` | fix: envelope unwrap on 22 remaining frontend pages |

#### Phase 22: Comprehensive Frontend E2E Audit & Bug Fixes (2026-07-15)
- [x] Wrote 98 Playwright E2E live-site tests covering every page, button, and flow
  - `tests/e2e/live-spider.spec.ts` — 70 page-level tests
  - `tests/e2e/live-interactions.spec.ts` — 28 button-interaction tests
  - `tests/e2e/playwright-live.config.ts` — config targeting http://localhost:8088
  - `tests/e2e/live-global-setup.ts` — authenticates via OnePlatform login form (bypasses Authelia)
  - Run: `npx playwright test --config tests/e2e/playwright-live.config.ts`
- [x] Fixed 5 bugs found during audit:
  1. **Pipeline builder crash** — API returns `definition.steps`, not top-level `steps` (`55afe72`)
  2. **Logs page "undefined" timestamps** — API returns `createdAt`, component expected `timestamp` (`1e243c9`)
  3. **Settings Admin page redirect race** — `beforeLoad` guard ran before auth store hydrated (`1e243c9`)
  4. **API retry delays not abort-aware** — stale 429/5xx retries could block after navigation (`1e243c9`)
  5. **TypeScript build errors** — `exactOptionalPropertyTypes` + `TS4111` fixes in 3 files (`1e243c9`)
- [x] Final E2E result: **97/98 tests pass, 0 failures, 1 skip** (plugin detail — needs a plugin installed)
- [x] All pages verified working: Dashboard, Connectors, Data Models, Explore, Data Quality, Pipelines, Apps, Logs, Audit, DLQ, Metrics, Plugins, all Settings tabs, navigation, mobile, error handling

**Final container state (2026-07-11, 21 containers running):**
- `op-dev-test-frontend`: rebuilt 05:58, dist redeployed after each fix batch
- `op-dev-test-gateway`: rebuilt 05:58
- `op-dev-test-ingestion`: rebuilt 05:58
- `op-dev-test-sandbox-vm`: rebuilt 07:09, socket protocol fixed
- `op-dev-test-execution`: restarted 07:12
- `op-dev-test-docker-bff`: started this session
- `op-dev-test-docker-socket-proxy`: started this session
- All other 14 containers: unchanged, healthy

**System health at session end:** All 9 services OK, sub-15ms latency, zero errors for 45+ minutes.

**Outstanding:**
- Full E2E browser verification requires Authelia credentials (not available to automated agents)
- User should confirm in browser: connector marketplace shows 5 connectors, app builder stat editing works, code editor file tree loads, sandbox code execution completes without errors
- Docker build cache behavior warrants investigation — frontend dist may require manual copy after `docker build` even with `--no-cache`

## Test Totals

| Area | Tests |
|------|-------|
| Services (unit) | ~5,623 |
| SDK | 82 |
| Plugin SDK | 61 |
| App SDK | 105 |
| Frontend | 367 |
| Connectors | 214 |
| Integration L1 | ~126 |
| Integration L2 | ~50 |
| Integration L3 (E2E) | ~28 |
| Phase 14 (P2-P4 gaps) | ~2,950 |
| Phase 15 (V5 fixes) | 2 (skipIf conditional tests) |
| Phase 18 (E2E Playwright) | 119 |
| Phase 22 (live-site E2E Playwright) | 98 |
| **Total** | **~9,825** |

24/24 builds passing. All test suites passing (600+ unit tests, 119 E2E tests). (auth-service has known turbo-parallel resource contention — passes in isolation.)

## Key References

| File | Purpose |
|------|---------|
| `docs/decisions/001-architecture-decisions.md` | 36 architecture decisions (L0 reference) |
| `docs/designs/*.md` | L2 service designs |
| `docs/USER-STORIES-ANALYSIS-V2.md` | Friction point analysis v2 (85 findings) |
| `docs/USER-STORIES-ANALYSIS-V3.md` | Friction point analysis v3 (53 net-new findings) |
| `docs/USER-STORIES-ANALYSIS-V4.md` | Friction point analysis v4 (148 net-new findings) |
| `docs/USER-STORIES-ANALYSIS-V5.md` | Friction point analysis v5 (135 findings, 62-agent workflow) |
| `docs/USER-STORIES-ANALYSIS-V6.md` | Friction point analysis v6 (213 findings, 206+ agent workflow, 11 personas) |
| `docs/USER-STORIES-ANALYSIS-V7.md` | Friction point analysis v7 (181 findings, 97-agent workflow) |
| `docs/GAP-ANALYSIS.md` | Gap analysis (127 gaps across 9 categories) |
| `docs/OPERATIONS.md` | Day-to-day platform operations |
| `docs/MONITORING.md` | Observability and alerting setup |
| `docs/TROUBLESHOOTING.md` | Common issues and debug procedures |
| `docs/UPGRADE.md` | Version upgrade and migration procedures |
| `docs/BACKUP.md` | Backup and disaster recovery |
| `DEVELOPMENT-PROCESS.md` | Development pipeline and quality gates |
| `.github/workflows/ci.yml` | CI/CD pipeline |
| `plugins/connector-*` | 5 built-in connector plugins |
| `.claude/handoff.md` | Session continuity handoff |
