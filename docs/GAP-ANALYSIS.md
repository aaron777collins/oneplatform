# OnePlatform Gap Analysis

**Date:** 2026-06-14
**Compared against:** Fivetran, n8n, Retool, and general enterprise expectations
**Total gaps identified:** 127
**Analysis method:** Source code inspection of all 9 services, 5 packages, frontend, Docker infrastructure, and documentation against ADR specs and competitor feature sets

## Executive Summary

OnePlatform has an exceptionally detailed architecture specification (36 ADRs, 25,000+ lines of design docs) and substantial code written across all 9 microservices, 5 packages, a React frontend, and Docker infrastructure. However, a significant gap exists between what the architecture describes and what is actually operational. The platform cannot currently run end-to-end: while docker-compose now defines all 9 service containers, there are 13 CRITICAL bugs (identified in the v2 user story analysis) that prevent basic functionality -- including broken inter-service authentication, identity impersonation via unsanitized headers, and non-functional plugin tooling. The OTEL observability stack is entirely stubbed out. No built-in connectors ship with the platform. There are zero pre-built app templates or workflow templates. SSO/SAML/OIDC support exists only as a plugin interface definition with no actual implementation.

The most impactful gaps fall into three tiers. First, **operational readiness gaps** that prevent anyone from using the platform at all: the 13 CRITICAL and 35 HIGH bugs from the v2 analysis, missing TLS, missing operational documentation, and missing CI/CD pipeline. Second, **feature parity gaps** that would block adoption even after the platform runs: zero pre-built connectors (vs Fivetran's 300+), no visual workflow builder (vs n8n's node editor), no drag-and-drop app builder (vs Retool), and no plugin marketplace. Third, **enterprise gaps** that block enterprise adoption: no SSO implementation, no SOC2 tooling, no GDPR controls, no multi-region support, and incomplete audit trail depth.

The recommended strategy is to fix all CRITICAL/HIGH bugs first (the platform must actually work), then ship 10-15 built-in connectors and basic workflow templates (the platform must be useful), then pursue enterprise features (the platform must be trustworthy). The architecture is sound and extensible -- the gap is overwhelmingly in implementation completeness and operational hardening, not in design.

## Gap Inventory

### Category 1: Operational Readiness (Platform Does Not Yet Work End-to-End)

| ID | Gap | Severity | Current State | Expected State | Effort | Priority |
|----|-----|----------|---------------|----------------|--------|----------|
| G-001 | X-User-Context header not stripped from external requests | CRITICAL | External callers can impersonate any user by setting this header | Gateway must strip this header before proxying | S | P1 |
| G-002 | Hardcoded CHANGE_ME passwords in Postgres/Redis/PgBouncer | CRITICAL | All service credentials are publicly known strings | init.sh must generate unique random passwords | S | P1 |
| G-003 | execution:read scope missing from ALL_SCOPES | CRITICAL | All execution GET endpoints return 403 for all users | Add missing scope to token service | S | P1 |
| G-004 | BffClient missing X-App-Id header | CRITICAL | Every app-sdk hook call fails with 400 | Accept appId in constructor, include in all headers | S | P1 |
| G-005 | Ed25519 service key pairs not generated | CRITICAL | All /internal/* service-to-service routes fail auth | Extend init.sh to generate key pairs | S | P1 |
| G-006 | OP_DATABASE_URL and OP_REDIS_URL missing from .env.example | CRITICAL | Services crash on startup with opaque Zod errors | Add documented variables to .env.example | S | P1 |
| G-007 | Permission response shape incompatible with PermissionCache | CRITICAL | All permission checks silently return false | Align response envelope format | S | P1 |
| G-008 | op plugin create generates non-compiling scaffold | CRITICAL | Generated plugin code has missing imports and wrong types | Wire to plugin-sdk's generateScaffold() | M | P1 |
| G-009 | op plugin pack is a non-functional stub | CRITICAL | Command exits immediately with no output | Wire to plugin-sdk's packPlugin() | M | P1 |
| G-010 | op plugin simulate-hook requires running server unnecessarily | CRITICAL | Local simulation impossible | Delegate to SDK's runSimulateHook() | S | P1 |
| G-011 | Post-bootstrap dashboard renders outside AppShell | CRITICAL | No navigation sidebar after bootstrap -- user is trapped | Redirect to proper authenticated route | S | P1 |
| G-012 | No TLS anywhere in the stack | CRITICAL | All communication is plaintext including passwords and tokens | Add reverse proxy (Caddy/nginx), enable PG/Redis TLS | L | P1 |
| G-013 | No stdout/stderr transport for logger | HIGH | docker logs captures nothing; Redis failure = total log loss | Add console transport as primary, Redis as secondary | S | P1 |
| G-014 | No HTTP security headers on any response | HIGH | Missing HSTS, X-Content-Type-Options, X-Frame-Options, CSP | Add security headers middleware to createApp() | S | P1 |
| G-015 | Blanket /internal/* auth bypass | HIGH | Any external request reaching /internal/ path skips auth | Replace with explicit per-route allowlists | M | P1 |
| G-016 | JWT tokens only in response body (no httpOnly cookie) | HIGH | XSS token theft is straightforward | Implement dual-mode token delivery | M | P1 |
| G-017 | No scope validation on API key creation | HIGH | Callers can request scopes they don't possess (privilege escalation) | Validate scopes are subset of requesting user's scopes | S | P1 |
| G-018 | No role validation on user update endpoint | HIGH | Any user can set another user's role to platform-admin | Enforce role hierarchy on assignment | S | P1 |
| G-019 | User deactivation doesn't revoke sessions/tokens | HIGH | Deactivated users retain access until token expiry | Revoke all tokens on deactivation | S | P1 |
| G-020 | Admin role check uses wrong string ('admin' vs 'platform-admin') | HIGH | Admin routes inaccessible to real admins | Use scope-based check instead of role string | S | P1 |
| G-021 | No uncaughtException/unhandledRejection handlers | HIGH | Unhandled errors silently terminate services | Add process error handlers with graceful shutdown | S | P1 |
| G-022 | No resource limits on Docker containers | HIGH | A runaway service can starve the entire host | Add deploy.resources.limits to each service | S | P1 |
| G-023 | Docker socket proxy overly permissive (POST=1 DELETE=1) | HIGH | Containers can create/delete arbitrary Docker resources | Restrict to CONTAINERS_CREATE=1 only | S | P1 |
| G-024 | SSRF via DNS rebinding in context-call-handler | HIGH | Outbound requests can reach internal RFC-1918 addresses | Add DNS resolution validation | M | P1 |
| G-025 | OTEL entirely stubbed out (commented out in app.ts) | HIGH | No traces, no metrics, no collector configured | Wire OTEL SDK, add collector sidecar | L | P1 |
| G-026 | Replay detection uses Redis SCAN (DoS vector) | HIGH | Scanning large keyspaces blocks Redis event loop | Replace with per-family Redis set for O(1) lookup | M | P1 |
| G-027 | Records double-written during sync | HIGH | Inline insert AND batch job both write same records | Remove inline insert; batch job is sole writer | S | P1 |
| G-028 | cleanupDeletedConnectors is a no-op | HIGH | Deleted connectors accumulate orphaned rows forever | Implement findDeletedBefore query and cleanup | M | P1 |
| G-029 | Build dispatch fire-and-forget with no recovery | HIGH | Stuck builds in 'building' state never retry/timeout | Add startup scan, timeout, and retry logic | M | P1 |
| G-030 | Pipeline step editor non-functional | HIGH | Clicking steps opens no configuration panel | Add real step configuration UI | L | P1 |
| G-031 | BFF mutation routes (PATCH, PUT, DELETE) absent | HIGH | Apps can read but cannot mutate data | Add missing BFF data mutation routes | M | P1 |
| G-032 | Connector trigger CLI polls wrong progress endpoint | HIGH | Users get no meaningful sync status feedback | Fix polling to correct endpoint | S | P1 |
| G-033 | activatePlugin is a no-op stub | HIGH | Plugin activation returns success without doing anything | Implement actual status transition logic | M | P1 |
| G-034 | GPG signature verification declared but never performed | HIGH | Plugins accepted without verification despite gpgFingerprint | Implement openpgp verification or remove field | M | P2 |
| G-035 | CLI sends 'file' field but plugin service expects 'bundle' | HIGH | Plugin uploads silently fail field validation | Change CLI to send 'bundle' | S | P1 |
| G-036 | Widget registry in-memory only | MEDIUM | Widgets lost on service restart | Persist to Postgres | M | P2 |
| G-037 | tar flattens directory structure during plugin pack | MEDIUM | Plugins with sub-directories lose file layout | Preserve relative paths in archive | S | P1 |
| G-038 | All services hardcode version '0.0.0' | HIGH | Health and metrics show no version info | Read from package.json or BUILD_VERSION env | S | P2 |
| G-039 | No maxmemory limit on Redis | HIGH | Redis consumes all host memory under load | Set 256mb default with allkeys-lru eviction | S | P1 |
| G-040 | SIGTERM handler never calls process.exit(0) | HIGH | Container shutdown hangs until Docker kill timeout | Add process.exit(0) and hard shutdown timeout | S | P1 |
| G-041 | Rate limiter uses client-controllable X-Forwarded-For | MEDIUM | Rate limiting easily bypassed with forged header | Use req.socket.remoteAddress | S | P1 |

### Category 2: Feature Gaps vs Fivetran (Data Integration)

| ID | Gap | Severity | Current State | Expected State | Effort | Priority |
|----|-----|----------|---------------|----------------|--------|----------|
| G-042 | Zero pre-built connectors | CRITICAL | No built-in connectors ship with the platform. Connector creation page shows empty list. | At minimum: REST API, PostgreSQL, MySQL, CSV, webhook -- the 5 mentioned in ADR-28. Fivetran has 300+. | XL | P1 |
| G-043 | No connector marketplace/registry | HIGH | Plugin installation only from local files or URLs | Hosted registry with searchable catalog, one-click install | L | P2 |
| G-044 | No schema drift detection | HIGH | No mechanism to detect when source schema changes | Auto-detect new/removed/changed columns on each sync run, notify user | L | P2 |
| G-045 | No Change Data Capture (CDC) support | HIGH | Only full sync and cursor-based incremental | CDC via WAL/binlog for database sources (Postgres, MySQL) | XL | P3 |
| G-046 | No data lineage tracking | MEDIUM | Raw data and mapped data exist but no traversal from destination back to source | Visual lineage graph: source -> raw -> mapped -> pipeline -> app | L | P3 |
| G-047 | No data quality monitoring/alerting | HIGH | No quality checks on ingested data | Anomaly detection (null rate spikes, volume drops, type mismatches), configurable alerts | L | P2 |
| G-048 | No usage metering/billing integration | LOW | No usage tracking beyond basic metrics | Track rows synced, API calls, storage used per tenant; billing webhook for SaaS operators | L | P4 |
| G-049 | No connector health monitoring dashboard | MEDIUM | Individual connector status visible but no aggregate health view | Dashboard showing all connectors with health scores, failure rates, latency trends | M | P2 |
| G-050 | No historical sync analytics | MEDIUM | Sync history sourced only from BullMQ (transient) | Durable sync history in Postgres with trend charts, failure analysis | M | P2 |
| G-051 | No data transformation library (dbt-like) | HIGH | Only raw JS/TS expression transforms in mapping rules | SQL-based transformations, pre-built transforms (dedup, pivot, aggregate, join), transformation testing | XL | P3 |
| G-052 | No data diffing/reconciliation | MEDIUM | No way to compare source data vs platform data | Reconciliation reports showing missing/extra/changed records | L | P3 |
| G-053 | Cron expressions accepted without validation | HIGH | Invalid expressions cause silent scheduling failures | Add cron-parser validation at API boundary | S | P1 |
| G-054 | Stale running sync state with no watchdog | MEDIUM | Crashed syncs never reset, blocking future runs | Add periodic stale-sync detection and reset job | M | P2 |
| G-055 | Sync run history transient (BullMQ only) | HIGH | History lost on queue flush | Store sync runs in Postgres for durable history | M | P2 |

### Category 3: Feature Gaps vs n8n (Workflow Automation)

| ID | Gap | Severity | Current State | Expected State | Effort | Priority |
|----|-----|----------|---------------|----------------|--------|----------|
| G-056 | No visual node-based workflow editor | HIGH | PipelineBuilder is a linear list of steps (source/transform/destination); no node canvas with connections | React Flow or similar: drag nodes, draw connections, visual branching | XL | P2 |
| G-057 | No conditional branching in pipelines | HIGH | Pipeline is a linear step chain only | If/else nodes, switch nodes, conditional routing based on data values | L | P2 |
| G-058 | No workflow versioning/rollback | MEDIUM | Pipelines can be updated but no version history or rollback | Version each pipeline save; allow rollback to any prior version | M | P2 |
| G-059 | No workflow templates/marketplace | HIGH | No pre-built pipelines or starter templates | Template gallery: "Sync Shopify to Postgres", "Daily CSV export", etc. | L | P2 |
| G-060 | No error handling patterns (retry/fallback/circuit breaker) in pipeline UI | MEDIUM | Retry exists at BullMQ level but not configurable per-step in UI | Per-step retry count, fallback paths, circuit breaker config in pipeline builder | M | P2 |
| G-061 | No webhook debugging/inspection UI | MEDIUM | Webhook receiver exists but no way to inspect received payloads in UI | Request inspector showing recent payloads, headers, response codes | M | P2 |
| G-062 | No execution history with replay | MEDIUM | Execution logs exist but no replay capability | One-click replay of any past execution with same inputs | M | P3 |
| G-063 | No sub-workflows/reusable pipeline components | MEDIUM | Each pipeline is a standalone definition | Allow pipelines to call other pipelines as sub-steps | M | P3 |
| G-064 | No parallel execution paths | MEDIUM | Steps execute sequentially only | Parallel branches that fan out and join | L | P3 |
| G-065 | No wait/delay/human-approval nodes | MEDIUM | No way to pause pipeline for external input | Wait nodes, approval gates, webhook wait triggers | M | P3 |
| G-066 | No pipeline execution visualization (live progress) | MEDIUM | Pipeline runs show status but not live step-by-step progress | Visual execution trace showing which step is running with timing | M | P2 |

### Category 4: Feature Gaps vs Retool (App Builder)

| ID | Gap | Severity | Current State | Expected State | Effort | Priority |
|----|-----|----------|---------------|----------------|--------|----------|
| G-067 | No visual drag-and-drop app builder | HIGH | Code-first only (Monaco editor). ADR says "designed for later." | Visual builder with component palette, property panel, layout grid | XL | P2 |
| G-068 | Limited UI component library | MEDIUM | shadcn/ui base components only; no data-specific components in app-sdk | Rich component library: DataTable, Charts, Forms, Maps, File Upload, Kanban, Calendar | L | P2 |
| G-069 | No database/SQL query builder | MEDIUM | Data access only through SDK hooks (useQuery with filter DSL) | Visual SQL editor with results preview, query saved as reusable data sources | L | P3 |
| G-070 | No mobile app support | MEDIUM | Web-only responsive layout | React Native SDK or PWA with mobile-optimized components | XL | P4 |
| G-071 | No embed/iframe support for apps | MEDIUM | Apps served at /apps/{slug} with SameSite=Strict cookies | Embeddable mode: generate iframe snippet, relax cookie policy for embedding | M | P3 |
| G-072 | No version control UI for apps | MEDIUM | Build history exists but no diff view, branching, or PR-like workflow | Visual diff between versions, branch/merge for collaborative editing | L | P3 |
| G-073 | Auto-generated type declarations inaccurate | HIGH | Types endpoint returns hand-authored types that drift from implementation | Auto-generate from app-sdk source using tsc --declaration | M | P1 |
| G-074 | App useSubscription has no cache invalidation | MEDIUM | UIs go stale after writes | Auto-invalidate related queries on entity mutation events | M | P2 |
| G-075 | No pre-built app templates | HIGH | "Create app" starts from blank. No starter apps. | Template gallery: CRUD admin panel, dashboard, form builder, customer portal | L | P2 |

### Category 5: Integration Gaps

| ID | Gap | Severity | Current State | Expected State | Effort | Priority |
|----|-----|----------|---------------|----------------|--------|----------|
| G-076 | No SSO/SAML/OIDC implementation | HIGH | AuthProvider plugin interface defined (ADR-31) but zero implementations. No SAML/OIDC code. | At minimum: OIDC auth provider plugin (covers Okta, Azure AD, Auth0). SAML for enterprise. | L | P2 |
| G-077 | No LDAP integration | MEDIUM | AuthProvider interface supports protocol: "ldap" but no implementation | LDAP/Active Directory auth provider plugin | M | P3 |
| G-078 | No GraphQL API | LOW | REST-only. No GraphQL schema or resolver. | GraphQL gateway layer auto-generated from ontology schemas | L | P4 |
| G-079 | No gRPC support | LOW | HTTP REST only for all service communication | gRPC for high-throughput service-to-service and external API access | L | P4 |
| G-080 | Webhook inbound signature verification incomplete | MEDIUM | Ingestion receives webhooks but verification of sender is connector-specific | Framework-level signature verification (HMAC, OAuth, IP allowlist) for inbound webhooks | M | P2 |
| G-081 | No streaming/real-time data ingestion | HIGH | SSE for outbound events exists but no inbound streaming (Kafka, Kinesis, MQTT) | Streaming connectors for Kafka, NATS, MQTT; real-time connector subscription support | XL | P3 |
| G-082 | No S3/MinIO file browser in UI | MEDIUM | MinIO configured but no UI to browse uploaded files or build artifacts | File browser component showing bucket contents with upload/download | M | P3 |
| G-083 | X-User-Context header not HMAC-signed between services | MEDIUM | Any service can forge user context headers | Add HMAC signing on emission, validate on receipt | M | P2 |
| G-084 | Password reset link exposed in API response (non-SMTP mode) | HIGH | Production deployments leak reset URLs to callers | Guard against returning reset links in non-development environments | S | P1 |
| G-085 | HS256 symmetric JWT signing | MEDIUM | Single secret compromise breaks all token verification | Migrate to RS256 or EdDSA asymmetric signing | M | P2 |
| G-086 | No request body size limit | MEDIUM | Large payloads can exhaust memory | Add configurable size limit; return 413 on exceed | S | P1 |

### Category 6: Developer Experience Gaps

| ID | Gap | Severity | Current State | Expected State | Effort | Priority |
|----|-----|----------|---------------|----------------|--------|----------|
| G-087 | SDK App methods are bare CRUD only | HIGH | No build, deploy, rollback, or file management in SDK | Add build(), deploy(), rollback(), files.* methods | M | P2 |
| G-088 | SDK data proxy returns 'any' type | MEDIUM | No TypeScript autocompletion for data queries | Add createTypedClient<T>() factory with typed methods | M | P2 |
| G-089 | SDK validation failures throw plain Error | LOW | Callers cannot distinguish SDK errors from other errors | Use ValidationError subclass of OnePlatformError | S | P2 |
| G-090 | SDK client throws on trailing slash in baseUrl | LOW | Common user mistake becomes uncaught error | Silently strip trailing slashes | S | P2 |
| G-091 | PKCE constructor auto-redirects browser on import | HIGH | Importing class triggers navigation side effect | Add explicit login() method; side-effect-free constructor | S | P1 |
| G-092 | Plugin HookPayload.data typed as Record<string, unknown> for all stages | HIGH | No per-stage type narrowing | Create discriminated union keyed on stage | M | P2 |
| G-093 | Plugin credential access restricted to connector-run only | HIGH | Auth providers and destinations cannot access their credentials | Extend credential access to auth-provider and destination types | S | P1 |
| G-094 | No plugin dev server or lifecycle testing tooling | HIGH | Must deploy to live server to test plugins | Create op plugin dev command with hot-reload and local invocation | L | P2 |
| G-095 | Single generic mock for all plugin types | MEDIUM | connector-run, auth-provider, destination get identical mocks | Add per-type mock factories with realistic data | M | P2 |
| G-096 | No SDK README, API reference, or usage examples | HIGH | Both SDK and plugin-sdk have no documentation | Getting-started guides, JSDoc examples on all public methods | M | P2 |
| G-097 | No op mapping command group in CLI | HIGH | Data engineers cannot manage ontology mappings from CLI | Add op mapping list/create/update/delete commands | M | P2 |
| G-098 | CLI help text advertises Python support that doesn't exist | MEDIUM | exec command says it supports python but only js/ts work | Update description to js/ts only | S | P1 |
| G-099 | CLI schedule command sends wrong field name | MEDIUM | CLI sends 'cron' but service expects 'cronExpr' | Change CLI to send 'cronExpr' | S | P1 |
| G-100 | Response double-wrapped in envelope (app-sdk) | HIGH | Consuming code must unwrap twice or receives undefined | Fix envelope unwrapping to single layer | S | P1 |
| G-101 | No example projects or starter templates in repo | HIGH | New users have no reference implementations | Add examples/ directory with data pipeline, app, and plugin examples | M | P2 |
| G-102 | Expression transforms built via string concatenation (injection risk) | MEDIUM | Potential for expression injection in mapping | Replace with JSONata or sandboxed evaluation | M | P2 |
| G-103 | 20 flat uncategorized CLI command groups | LOW | op --help output is overwhelming | Add command categories (Data, Apps, Plugins, Admin) | S | P3 |
| G-104 | No hot reload for service development | MEDIUM | pnpm dev exists but actual hot reload behavior unclear | Ensure tsx watch or nodemon configured for each service | M | P2 |

### Category 7: Operational Gaps

| ID | Gap | Severity | Current State | Expected State | Effort | Priority |
|----|-----|----------|---------------|----------------|--------|----------|
| G-105 | No operational documentation | HIGH | No deployment guide, operations runbook, upgrade procedure, scaling guide | Create docs/operations/ with comprehensive guides | L | P1 |
| G-106 | No backup/restore procedures | HIGH | Data loss is unrecoverable | Postgres dump scripts, Redis snapshots, documented restore runbook | M | P1 |
| G-107 | No CI/CD pipeline | HIGH | No .github/workflows directory. No automated tests in CI. | GitHub Actions: lint, test, build, Docker image push, release | L | P1 |
| G-108 | No release/versioning process | HIGH | No tags, no changelog, no release process | Semantic versioning, changelog generation, GitHub Releases | M | P2 |
| G-109 | No container log rotation configured | MEDIUM | Logs grow unbounded | Add logging driver config with size rotation (now partially fixed) | S | P1 |
| G-110 | No stop_grace_period on containers | MEDIUM | Containers force-killed before graceful shutdown | Set stop_grace_period: 45s (now partially fixed) | S | P1 |
| G-111 | No Kubernetes deployment manifests | MEDIUM | Docker Compose only | Helm chart or Kustomize manifests for K8s deployment | L | P3 |
| G-112 | No performance benchmarks | MEDIUM | No data on throughput, latency, capacity | Benchmarks for ingestion rate, API latency, pipeline throughput, concurrent users | L | P3 |
| G-113 | No capacity planning guide | MEDIUM | No guidance on sizing infrastructure | Document CPU/memory/disk requirements per concurrent user count | M | P3 |
| G-114 | No upgrade/migration procedures between versions | HIGH | No way to safely upgrade the platform | Migration scripts, data compatibility checks, rollback procedures | L | P2 |
| G-115 | No monitoring/alerting setup guide | HIGH | OTEL stubbed out; no Grafana dashboards provided | Pre-built Grafana dashboards, PagerDuty/Slack alert templates | M | P2 |
| G-116 | No high availability configuration documentation | MEDIUM | Redis Sentinel mentioned but not documented | HA guide: Redis Sentinel, Postgres replication, multi-Gateway, load balancer | M | P3 |
| G-117 | No tenant management API beyond bootstrap | MEDIUM | Cannot create, rename, or delete tenants after setup | Add CRUD routes to auth service and CLI commands | M | P2 |
| G-118 | No key rotation mechanism for encrypted credentials | MEDIUM | Credential re-encryption job specified in ADR-11 but not implemented | Implement key rotation job with re-encryption | M | P2 |

### Category 8: Enterprise/Compliance Gaps

| ID | Gap | Severity | Current State | Expected State | Effort | Priority |
|----|-----|----------|---------------|----------------|--------|----------|
| G-119 | No SOC2 readiness tooling | MEDIUM | Audit logs exist but no SOC2-specific controls or evidence generation | Automated SOC2 evidence collection, access review reports | L | P3 |
| G-120 | No GDPR compliance tools | HIGH | No data subject access/deletion requests, no consent management | Right to access, right to deletion, data export, processing records | L | P2 |
| G-121 | No data residency controls | MEDIUM | Single-region deployment only | Per-tenant data residency configuration, region-aware routing | XL | P4 |
| G-122 | No IP allowlisting | MEDIUM | Rate limiting exists but no IP-based access control | Per-tenant and per-API-key IP allowlist/denylist | M | P3 |
| G-123 | No custom branding/white-labeling | LOW | OnePlatform branding throughout | Configurable logo, colors, email templates per tenant | M | P4 |
| G-124 | No multi-region support | LOW | Single Docker Compose deployment | Multi-region deployment guide with data replication strategy | XL | P4 |
| G-125 | Incomplete audit trail depth | MEDIUM | Audit events exist at API level but not for data access, field-level changes | Field-level audit for sensitive data, data access logging | M | P3 |
| G-126 | No container security hardening flags in sandbox | LOW | Missing V8 hardening flags | Add --disallow-code-generation-from-strings and --jitless | S | P2 |

### Category 9: Community/Ecosystem Gaps

| ID | Gap | Severity | Current State | Expected State | Effort | Priority |
|----|-----|----------|---------------|----------------|--------|----------|
| G-127 | No BSL license file | HIGH | License mentioned in README/ADR but no LICENSE file in repo | Create LICENSE file with BSL terms | S | P1 |
| G-128 | No CONTRIBUTING guide | MEDIUM | No contributing guide, no code of conduct | CONTRIBUTING.md with setup instructions, PR guidelines, code of conduct | M | P2 |
| G-129 | No issue templates | LOW | No structured issue/PR templates | Bug report, feature request, PR templates in .github/ | S | P2 |
| G-130 | No public roadmap | MEDIUM | No visible roadmap for potential adopters | Public roadmap (GitHub Projects or similar) | S | P2 |
| G-131 | No plugin marketplace/community hub | HIGH | Plugins can only be installed from local files or direct URLs | Online plugin registry with search, ratings, verified publishers | XL | P3 |
| G-132 | No community forum/discussions | LOW | No venue for community Q&A | GitHub Discussions enabled, or Discourse instance | S | P3 |
| G-133 | Auto-generated docs pipeline not wired | HIGH | turbo run docs:generate task exists but generated/ directory is empty | Wire doc generation into CI, publish to docs site | M | P2 |

## Priority Roadmap

### P1 -- Must-have for credible MVP launch (52 gaps)

**Security-critical fixes (ship-blocking):**
- G-001: Strip X-User-Context header (identity impersonation)
- G-002: Generate real passwords for Postgres/Redis/PgBouncer
- G-003: Add execution:read scope
- G-005: Generate Ed25519 service key pairs
- G-012: Add TLS (Caddy reverse proxy)
- G-015: Fix blanket /internal/* auth bypass
- G-016: Add httpOnly cookie token delivery
- G-017: Validate API key scope creation
- G-018: Validate role assignments
- G-019: Revoke sessions on user deactivation
- G-020: Fix admin role check string
- G-023: Restrict Docker socket proxy permissions
- G-024: Fix SSRF via DNS rebinding
- G-041: Fix rate limiter to use real IP
- G-084: Guard password reset link in non-dev
- G-086: Add request body size limit

**Functional fixes (platform must actually work):**
- G-004: Fix BffClient X-App-Id header
- G-006: Add database/Redis URLs to .env.example
- G-007: Fix PermissionCache response shape
- G-008: Fix op plugin create scaffold
- G-009: Wire op plugin pack
- G-010: Wire op plugin simulate-hook
- G-011: Fix post-bootstrap routing
- G-013: Add stdout logger transport
- G-014: Add HTTP security headers
- G-021: Add uncaught exception handlers
- G-022: Add Docker resource limits
- G-025: Wire OTEL observability
- G-027: Fix double-write in sync
- G-028: Implement connector cleanup
- G-029: Fix build dispatch recovery
- G-030: Make pipeline step editor functional
- G-031: Add BFF mutation routes
- G-032: Fix connector trigger CLI
- G-033: Implement activatePlugin
- G-035: Fix CLI plugin upload field name
- G-037: Fix tar directory structure in plugin pack
- G-039: Set Redis maxmemory
- G-040: Fix SIGTERM handler
- G-053: Validate cron expressions
- G-073: Auto-generate type declarations
- G-091: Fix PKCE constructor side effect
- G-093: Extend plugin credential access
- G-098: Fix CLI exec help text
- G-099: Fix CLI schedule field name
- G-100: Fix app-sdk double envelope wrapping

**Table-stakes features (platform must be useful):**
- G-042: Ship minimum 5 built-in connectors (REST API, PostgreSQL, MySQL, CSV, Webhook)
- G-105: Write operational documentation
- G-106: Create backup/restore procedures
- G-107: Create CI/CD pipeline
- G-127: Create BSL license file

### P2 -- Required for first enterprise customer (42 gaps)

**Enterprise auth and compliance:**
- G-076: Implement OIDC auth provider plugin
- G-120: Add GDPR data subject request tools

**Data platform completeness:**
- G-043: Connector marketplace/registry
- G-044: Schema drift detection
- G-047: Data quality monitoring/alerting
- G-049: Connector health dashboard
- G-050: Historical sync analytics
- G-054: Stale sync detection
- G-055: Durable sync history

**Workflow/pipeline completeness:**
- G-056: Visual node-based workflow editor
- G-057: Conditional branching
- G-058: Workflow versioning
- G-059: Workflow templates
- G-060: Per-step error handling config
- G-061: Webhook inspection UI
- G-066: Live pipeline execution visualization

**App platform completeness:**
- G-067: Visual drag-and-drop app builder
- G-068: Rich UI component library
- G-074: Subscription cache invalidation
- G-075: Pre-built app templates

**Developer experience:**
- G-087: SDK App build/deploy/rollback methods
- G-088: Typed SDK data client
- G-089: Proper SDK error types
- G-090: Strip trailing slash from baseUrl
- G-092: Per-stage hook type narrowing
- G-094: Plugin dev server
- G-095: Per-type mock factories
- G-096: SDK documentation
- G-097: CLI mapping commands
- G-101: Example projects
- G-102: Fix expression injection risk
- G-104: Hot reload for development

**Operations:**
- G-034: GPG verification or remove
- G-036: Persist widget registry
- G-038: Dynamic service versions
- G-083: HMAC sign X-User-Context
- G-085: Asymmetric JWT signing
- G-108: Release/versioning process
- G-114: Upgrade/migration procedures
- G-115: Monitoring/alerting setup
- G-117: Tenant management API
- G-118: Credential key rotation
- G-126: Sandbox V8 hardening flags

**Community:**
- G-128: CONTRIBUTING guide
- G-129: Issue templates
- G-130: Public roadmap
- G-133: Auto-generated docs pipeline

### P3 -- Competitive differentiation (23 gaps)

- G-045: CDC support (database WAL/binlog)
- G-046: Data lineage visualization
- G-051: SQL-based transformation library
- G-052: Data reconciliation
- G-062: Execution replay
- G-063: Sub-workflows
- G-064: Parallel execution paths
- G-065: Wait/approval/human-in-the-loop nodes
- G-069: Database query builder UI
- G-071: Embed/iframe support for apps
- G-072: Version control UI for apps
- G-077: LDAP auth provider
- G-080: Framework-level inbound webhook verification
- G-082: S3/MinIO file browser UI
- G-103: CLI command categories
- G-109: Container log rotation
- G-110: stop_grace_period
- G-111: Kubernetes manifests
- G-112: Performance benchmarks
- G-113: Capacity planning guide
- G-116: HA documentation
- G-119: SOC2 readiness tooling
- G-122: IP allowlisting
- G-125: Field-level audit trail
- G-131: Plugin marketplace hub
- G-132: Community forum

### P4 -- Nice-to-have / future (10 gaps)

- G-048: Usage metering/billing
- G-070: Mobile app support (React Native)
- G-078: GraphQL API
- G-079: gRPC support
- G-081: Streaming ingestion (Kafka, NATS)
- G-121: Data residency controls
- G-123: White-labeling/custom branding
- G-124: Multi-region support

## Architecture Impact Assessment

### Gaps requiring NO architectural changes (feature additions only)
The majority of gaps (approximately 95) are implementation completions, bug fixes, or feature additions that fit cleanly within the existing architecture:
- All 41 P1 bug fixes (G-001 through G-041)
- Built-in connector implementations (G-042) -- the Connector interface is already specified
- SSO/OIDC plugin (G-076) -- the AuthProvider interface is already specified
- Workflow templates (G-059), app templates (G-075) -- storage/serving fits existing models
- Documentation, CI/CD, community files -- no architecture impact

### Gaps requiring minor architectural extensions
These gaps extend the architecture without changing it:
- **Visual workflow editor (G-056):** Frontend-only change using React Flow. Pipeline model needs DAG support (currently linear array of steps). Backend impact: Pipeline Service must support step dependencies/branching, not just sequential execution.
- **Conditional branching (G-057):** Pipeline execution engine needs DAG traversal logic (currently iterates an array). Step schema needs condition expressions.
- **Schema drift detection (G-044):** Ingestion Service needs a schema comparison step after connector fetch, before mapping. New event type `ingestion.schema.drift.detected`.
- **Data quality monitoring (G-047):** New service or module within Ingestion/Ontology for quality rule evaluation. New event types for quality alerts.
- **GDPR tools (G-120):** Cross-service coordination for data subject deletion (delete from raw tables, mapped tables, audit logs). New API endpoints on Gateway.

### Gaps requiring significant architectural additions
- **CDC/streaming ingestion (G-045, G-081):** Current architecture is batch-oriented (BullMQ jobs). Real-time streaming requires a persistent consumer process per connector, likely a new worker type in the Ingestion Service. May need Kafka/NATS as infrastructure.
- **Visual drag-and-drop app builder (G-067):** Major frontend initiative. Requires a component metadata system, layout engine, property binding system, and a way to serialize visual layouts back to code or a separate representation format. The existing code-first architecture supports this being layered on top (per ADR-2).
- **Multi-region (G-124):** Requires Postgres replication, region-aware routing, and cross-region consistency model. Fundamental infrastructure change.
- **Plugin marketplace (G-131):** Requires a hosted registry service (separate from the platform), package distribution, version resolution, trust/signing infrastructure, and a web portal.
- **GraphQL API (G-078):** Requires a GraphQL schema generation layer on top of the ontology, resolvers that map to existing REST endpoints, and subscription support. Could be a Gateway plugin.
- **SQL transformation library (G-051):** Requires a SQL execution engine (possibly leveraging the existing sandbox) with access to tenant data, transformation DAG, and a materialization strategy. Significant new subsystem.
