# OnePlatform — Complete Handoff Document

**Last updated:** 2026-06-10
**Status:** Architecture APPROVED (clean, 11 review cycles). Moving to design spec + implementation.
**Repo:** https://github.com/aaron777collins/oneplatform
**Working directory:** /home/ubuntu/topics/oneplatform

## What Is OnePlatform?

A free, source-available (BSL license) data platform that combines Fivetran + n8n + Retool into one cohesive system. Users can:
1. **Ingest** data from any source (APIs, databases, webhooks, files, streams)
2. **Map** data to user-defined ontologies (schemas with relationships, types, permissions)
3. **Transform** data through automated pipelines (cron, event-driven, custom code)
4. **Build apps** on top of the data (code-first editor, hosted within the platform)
5. **Expose** data via auto-generated REST APIs with ontology-driven authorization
6. **Extend** everything via plugins (connectors, transformers, destinations, auth providers)

## User's Requirements (from original conversation)

The user (aaron777collins@gmail.com) wants:
- **Full implementation** — no shortcuts, no "MVP, do later". Every feature fully built.
- **Structured agent teams** — architect → architect review → code → tester → code reviewer → cycle until clean
- **Everything written down** — plans, todos, decisions, concepts, all documented
- **Commit often and push** — never leave uncommitted work
- **Use websitetemplate repo** as frontend starting point (github.com/aaron777collins/websitetemplate — Vite + React 18 + TypeScript + Tailwind v4 + shadcn/ui)
- **Docker deployment** — `docker compose up` runs everything
- **License check** — all dependencies must be free for commercial use
- **Comprehensive test suites** — unit, integration, contract, e2e, security
- **Granular sub-designs** for each service, each going through the full review loop
- **Development process documented** in DEVELOPMENT-PROCESS.md (DONE)
- **User stories walkthrough** — build app, build plugin, use API/CLI — find friction points
- **Always reference the architecture** — never lose scope
- **SOLID principles, extendibility, plugins, CORE library** — always in mind
- **Do NOT wait for the user** — keep working autonomously, make best decisions
- **Do NOT cut corners** — finish everything perfectly

## Architecture (23 Decisions — APPROVED)

Full document: `docs/decisions/001-architecture-decisions.md`

### Services (9 microservices + 1 sandbox container)

| # | Service | Port | Key Responsibility |
|---|---------|------|--------------------|
| 1 | Gateway | 3000 | API routing, rate limiting (multi-tier + in-memory fallback), auth validation, auto-generated REST endpoints |
| 2 | Auth | 3001 | Email/password + OAuth (GitHub/Google), JWT (15-min access + refresh), API keys, RBAC, ontology-aware permissions (entity/field/row level), emergency re-key |
| 3 | Ingestion | 3002 | Pull connectors (REST, DB, FTP), push receivers (webhooks, uploads), stream listeners, normalize to JSON, AES-256-GCM credential vault |
| 4 | Ontology | 3003 | User-defined entity schemas, field mapping rules, type validation/coercion, relationship definitions, auto-generates: TS types, API routes, validation code, auth rules. Schema migration with UNION views, shadow tables, three-tier orphan cleanup |
| 5 | Pipeline | 3004 | Workflow orchestration, cron scheduling, event-driven triggers, conditional branching, error handling/retry, hook invocation via Plugin+Execution services |
| 6 | Execution | 3005 | Sandboxed code execution. isolated-vm in separate op-sandbox-vm container (Node 20, unidirectional Unix socket, graceful recycling with 10-inflight cap). Docker containers for Python/Go via socket proxy. Injected APIs: fetch (proxied), db, ontology, cache |
| 7 | App | 3006 | Code-first app builder, in-browser editor, build/serve user apps in containers, external SDK connections, subdomain/path routing. Acts as BFF for browser apps |
| 8 | Logging | 3007 | Async logs via Redis pub/sub, audit via BullMQ (guaranteed delivery), batch persistence, trace ID correlation, audit fallback file (100MB cap), horizontal scale path (time partitions, read replica, cold storage) |
| 9 | Plugin | 3008 | Plugin lifecycle (install/enable/disable), hook registry, extension points. All plugin code runs through Execution Service sandbox. Hook linearization with critical/advisory criticality |

### Infrastructure (Docker Compose)

| Component | Image | Notes |
|-----------|-------|-------|
| PostgreSQL 16 | postgres:16-alpine | Per-service schemas, PgBouncer dual-mode (transaction default, session for Ontology+Pipeline) |
| PgBouncer | pgbouncer/pgbouncer | 200 max client conn, per-service pool sizing |
| Redis 7 | redis:7-alpine | AOF persistence, key-prefix ACLs (SELECT denied), per-service users |
| Docker Socket Proxy | tecnativa/docker-socket-proxy | Restricted API for sandbox containers |
| op-sandbox-vm | Custom (Dockerfile.sandbox) | Process-isolated isolated-vm, Node 20 pinned |
| Frontend | Custom (Nginx) | React SPA from websitetemplate |
| OTEL Collector | otel/opentelemetry-collector-contrib:0.104.0 | Optional (observability profile) |
| Prometheus | prom/prometheus:v2.53.0 | Optional (observability profile) |
| Jaeger | jaegertracing/all-in-one:1.58 | Optional (observability profile) |

### Shared Packages

| Package | Purpose |
|---------|---------|
| `@oneplatform/core` | Engine library: DB clients, auth middleware (user + service token validation + service RBAC), queue helpers (BullMQ + DLQ + WAL), logging/tracing (OTEL auto-instrument), error handling, config loader, health checks, encryption (AES-256-GCM), rate limit helpers, service RBAC permission matrix |
| `@oneplatform/sdk` | External app SDK: auth (OAuth+PKCE for browser, API key for server), real-time (SSE/WS), ontology-typed data access, pipeline triggers. Auto-generated from OpenAPI spec |
| `@oneplatform/app-sdk` | Platform app SDK: extends SDK with user context, app storage, inter-app comms, UI components |
| `@oneplatform/plugin-sdk` | Plugin dev SDK: interfaces (Connector, Transformer, Destination, AuthProvider, Widget), hook registration, local dev server |
| `@oneplatform/cli` | CLI tool (`op`): wraps REST API, JSON+table output, auth via API key or interactive login |

### Key Security Decisions

- **Service-to-service auth:** Ed25519 asymmetric signing. Each service has its own keypair on a dedicated volume. Public keys shared read-only. Receiving service middleware enforces service RBAC permission matrix (compiled into core at build time).
- **3-tier Docker network:** internal (services), sandbox (execution), public (gateway+frontend). Execution Service bridges internal+sandbox.
- **Credential encryption:** AES-256-GCM + HKDF-SHA256, per-credential salt, idempotent key rotation. Master key security prominently documented.
- **Sandbox isolation:** op-sandbox-vm is a separate container with no Docker socket, no internal network, read-only filesystem. Unidirectional Unix socket pair. Recycled every 1000 executions with graceful drain.
- **Redis ACLs:** key-prefix conventions, SELECT denied, FLUSHDB/FLUSHALL/KEYS denied for all service users.
- **Rate limiting:** global/per-tenant/per-API-key/webhook. In-memory fallback divides by replica count. Conservative 100 req/min hard fallback on cold start with no data.
- **Browser SDK:** OAuth+PKCE (no API keys client-side). App Service as BFF.
- **JWT:** 15-min access tokens, Redis-backed revocation blocklist, emergency re-key option.

### Key Reliability Decisions

- **Redis graceful degradation:** 5 concerns each with specific fallback (BullMQ WAL, auth fail-closed, ontology 15s poll with jitter/ETag/circuit breaker, log buffer+fallback file)
- **BullMQ:** DLQ, exponential backoff, poison-pill detection, backpressure with QueueFullError
- **Ontology cache:** pub/sub + 5-min version-check poll safety net (ETag) + 15s degraded poll
- **Schema migration:** UNION view (10s query timeout, 1hr migration timeout, auto-abort), per-batch shadow tables in single transaction, three-tier orphan cleanup with row count verification
- **WAL:** per-service, CRC32 checksums, corruption detection, per-service volumes
- **Sandbox recycling:** graceful drain with 60s grace, 10-inflight cap, overlap period
- **isolated-vm contingency:** pre-warmed Docker container pool fallback, CI smoke test, alternatives documented (workerd, worker_threads)

## Monorepo Structure

```
oneplatform/
├── packages/
│   ├── core/                  # @oneplatform/core
│   ├── sdk/                   # @oneplatform/sdk (auto-generated)
│   ├── app-sdk/               # @oneplatform/app-sdk
│   ├── plugin-sdk/            # @oneplatform/plugin-sdk
│   └── cli/                   # @oneplatform/cli (op)
├── services/
│   ├── gateway/               # API Gateway + rate limiting
│   ├── auth/                  # Auth & RBAC
│   ├── ingestion/             # Data ingestion + credential vault
│   ├── ontology/              # Schema engine + code generation
│   ├── pipeline/              # Workflow orchestration
│   ├── execution/             # Code sandbox
│   ├── app/                   # App hosting & runtime
│   ├── logging/               # Logs, metrics, audit
│   └── plugin/                # Plugin lifecycle & hooks
├── frontend/                  # React dashboard (from websitetemplate)
├── docker/
│   ├── Dockerfile.service     # Multi-stage build for all services
│   ├── Dockerfile.sandbox     # Low-privilege isolated-vm container (Node 20)
│   ├── Dockerfile.frontend    # Nginx + React build
│   └── docker-compose.yml     # Full stack orchestration
├── docs/
│   ├── decisions/             # Architecture Decision Records
│   ├── designs/               # Per-service detailed designs
│   ├── generated/             # Auto-generated API, SDK, CLI, ontology docs
│   ├── WORKING-STATE.md       # Current development state
│   └── HANDOFF.md             # THIS FILE
├── DEVELOPMENT-PROCESS.md     # Full development pipeline
├── README.md                  # Project overview
├── turbo.json                 # Turborepo config
├── pnpm-workspace.yaml
└── package.json
```

## Development Process (ALWAYS follow this)

Documented in `DEVELOPMENT-PROCESS.md`. Summary:

### For EVERY piece of work:
1. **PROPOSE** — Architect agent creates design (references L0 architecture)
2. **ARCH REVIEW** — Architecture reviewer validates (APPROVED/REVISE)
3. **THEORETICAL TEST** — Verify design covers edge cases, failure modes, contracts
4. **DEVELOP** — Developer agent implements code (SOLID, extendible, plugins)
5. **WRITE TESTS** — Tester agent writes comprehensive test suites
6. **RUN TESTS** — Execute all tests
7. **CODE REVIEW** — Code reviewer checks (RED/YELLOW/GREEN)
8. **COMMIT** — Commit and push

### Agent Team Roles:
- **Architect** (subagent_type: "architect") — creates designs
- **Architecture Reviewer** (subagent_type: "architecture-reviewer") — validates designs
- **Developer** (subagent_type: "developer") — implements code
- **Tester** (subagent_type: "tester") — writes test suites
- **Code Reviewer** (subagent_type: "code-reviewer") — reviews code (RED/YELLOW/GREEN)

### Reference Hierarchy (always check UP):
```
L0: Architecture Decisions (docs/decisions/001-architecture-decisions.md)
L1: Design Spec (docs/superpowers/specs/*-design.md)
L2: Service-Level Design (docs/designs/{service-name}.md)
L3: Implementation (services/{service-name}/src/)
L4: Tests (services/{service-name}/src/__tests__/)
```

## Core Values (ALWAYS in mind)

1. **SOLID** — Single Responsibility, Open/Closed, Liskov, Interface Segregation, Dependency Inversion
2. **Engine-first** — Robust core engine, extensible layers on top
3. **Plugin architecture** — Built-in features use same interfaces as third-party plugins
4. **Auth first-class** — Woven into core library, ontology-driven RBAC
5. **API-first** — Everything available via REST API, CLI, SDKs
6. **Auto-generated** — Types, API routes, docs, SDK methods generated from ontology/code
7. **Observable** — Trace IDs, OTEL, Prometheus metrics, audit trails
8. **Secure** — Sandboxed execution, encrypted credentials, service-to-service auth
9. **Extendible** — Plugins, interfaces, SOLID principles at every level
10. **Microservices** — 9 services with clean boundaries, inter-service auth, 3-tier network

## What Has Been Done

1. [x] Initial brainstorming and requirements gathering
2. [x] 23 architecture decisions documented
3. [x] 11 architecture review cycles — CLEAN APPROVED (no blockers, no warnings)
4. [x] README.md created
5. [x] DEVELOPMENT-PROCESS.md created (full team flow)
6. [x] docs/WORKING-STATE.md created (state tracker)
7. [x] docs/HANDOFF.md created (THIS FILE — comprehensive handoff)
8. [x] GitHub repo created, all work committed and pushed
9. [x] Visual companion server set up (may need restart: use start-server.sh with --host 0.0.0.0 --url-host 65.108.1.247)

## What Needs To Be Done Next (IN ORDER)

### Phase 1: Design Completion
1. **Walk through user stories** — three key stories:
   - "I want to build an app on the platform" — what's the UX flow?
   - "I want to build a plugin to extend functionality" — what's the developer experience?
   - "I want to use the API/CLI" — what operations are available?
   - For each: identify friction points, blockers, and fix them in the architecture/design
2. **Write comprehensive test strategy** — document in architecture what tests cover what contracts
3. **Write full design spec** — save to `docs/superpowers/specs/2026-06-10-oneplatform-design.md`
4. **Invoke writing-plans skill** — create detailed implementation plan

### Phase 2: Granular Service Designs
For EACH of the 9 services + core library + 4 SDKs + CLI (14 total):
1. Architect agent creates detailed service design (references L0 architecture)
2. Architecture reviewer validates
3. Theoretical test review
4. Loop until clean APPROVED

Order of implementation (dependency-driven):
1. `@oneplatform/core` (everything depends on this)
2. Auth Service (everything needs auth)
3. Ontology Service (everything references ontology)
4. Gateway Service (entry point for everything)
5. Ingestion Service
6. Pipeline Service
7. Execution Service
8. Plugin Service
9. App Service
10. Logging Service
11. `@oneplatform/sdk`
12. `@oneplatform/app-sdk`
13. `@oneplatform/plugin-sdk`
14. `@oneplatform/cli`
15. Frontend (from websitetemplate)

### Phase 3: Implementation
For EACH service/package:
1. Developer agent implements
2. Tester agent writes tests
3. Run tests
4. Code reviewer reviews (RED/YELLOW/GREEN)
5. Fix and re-review until GREEN
6. Commit and push

### Phase 4: Integration & E2E
1. Docker Compose setup
2. Integration tests between services
3. E2E tests for full user stories
4. Security tests
5. Performance tests

### Phase 5: Documentation & Polish
1. Auto-generated docs pipeline
2. Setup wizard (first-run experience)
3. Final end-to-end verification

## Tech Stack (all commercially licensable)

| Technology | License | Purpose |
|-----------|---------|---------|
| React 18 | MIT | Frontend UI |
| TypeScript | Apache 2.0 | Language |
| Tailwind CSS v4 | MIT | Styling |
| shadcn/ui (Radix) | MIT | UI components |
| Hono | MIT | Backend HTTP framework |
| Node.js 22 | MIT | Service runtime |
| Node.js 20 | MIT | Sandbox runtime (pinned for isolated-vm) |
| PostgreSQL 16 | PostgreSQL License | Database |
| PgBouncer | ISC | Connection pooling |
| Redis 7 | BSD-3 | Queues, cache, pub/sub |
| BullMQ | MIT | Job queue library |
| isolated-vm | MIT | JS/TS sandbox |
| Docker | Apache 2.0 | Containerization |
| tecnativa/docker-socket-proxy | MIT | Restricted Docker API |
| Passport.js | MIT | OAuth providers |
| OpenTelemetry SDK | Apache 2.0 | Distributed tracing |
| Prometheus | Apache 2.0 | Metrics |
| Jaeger | Apache 2.0 | Trace viewer |
| OTEL Collector | Apache 2.0 | Trace/metric buffering |
| Vitest | MIT | Unit/integration testing |
| Playwright | Apache 2.0 | E2E testing |
| Supertest | MIT | HTTP testing |
| Turborepo | MIT | Monorepo build |
| pnpm | MIT | Package manager |
| Commander.js | MIT | CLI framework |
| Scalar/Stoplight Elements | MIT | API docs renderer |
| TypeDoc | MIT | SDK docs generator |
| Zod | MIT | Schema validation |
| Framer Motion | MIT | Animations (frontend) |
| Lucide React | ISC | Icons |

## Important Context

- The user's server is at 65.108.1.247 (Hetzner)
- The user has n8n, Caddy, and other services running on the same server
- The user's GitHub username is aaron777collins
- The websitetemplate repo has Vite + React 18 + TypeScript + Tailwind v4 + shadcn/ui + Vitest + Framer Motion
- The user wants to potentially monetize this later (hence BSL license)
- The user explicitly said "do NOT wait for me" and "finish this perfectly"
- The user wants ALL architecture concepts (SOLID, plugins, core library, etc.) ALWAYS referenced during implementation
- The user wants the same propose → review → test → code review → revise loop for DESIGNS too, not just architecture
- The visual companion server may need restarting (port changes each time)

## Files Reference

| File | What It Is |
|------|-----------|
| `docs/decisions/001-architecture-decisions.md` | **THE** architecture document. 23 decisions. L0 reference. |
| `DEVELOPMENT-PROCESS.md` | Development pipeline, agent roles, test strategy, quality gates |
| `docs/WORKING-STATE.md` | Current state tracker (update as you work) |
| `docs/HANDOFF.md` | THIS FILE — comprehensive context for session continuity |
| `README.md` | Project overview and quick start |
| `.gitignore` | Standard ignores (node_modules, dist, .env, .superpowers, .claude) |

## Git State

- Branch: `main`
- Remote: `origin` → https://github.com/aaron777collins/oneplatform
- All work committed and pushed
- Latest commit includes all 11 review cycle fixes
