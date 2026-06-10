# OnePlatform — Working State

This document tracks the current state of development. Read this FIRST when resuming work.

## Current Phase: Architecture Finalization

### Completed
- [x] Initial brainstorming and requirements gathering
- [x] 23 architecture decisions documented in `docs/decisions/001-architecture-decisions.md`
- [x] 5 architecture review cycles completed
- [x] All blocking issues from reviews 1-5 resolved
- [x] README.md created
- [x] DEVELOPMENT-PROCESS.md created (full team flow documented)
- [x] GitHub repo created and all work pushed: https://github.com/aaron777collins/oneplatform

### In Progress
- [ ] Final (6th) architecture review — expecting clean APPROVED
- [ ] Writing comprehensive design spec

### Pending (in order)
1. Walk through user stories (build app, build plugin, use API/CLI) — find friction, fix it
2. Write comprehensive test strategy into architecture
3. Write full design spec and commit
4. Create detailed implementation plan (invoke writing-plans skill)
5. Write DEVELOPMENT-PROCESS.md with full team flow (DONE)
6. Granular sub-designs for each of the 9 services + core library
   - Each goes through: propose → review → test → code review (R/Y/G) → revise → review loop
7. Full implementation using structured agent teams
8. Comprehensive test suites — unit, integration, contract, e2e, security

## Architecture Summary (23 Decisions)

| # | Decision | Status |
|---|----------|--------|
| 1 | MVP Scope — all subsystems including app platform | APPROVED |
| 2 | App Platform — code-first, visual builder later | APPROVED |
| 3 | Deployment — self-hosted Docker Compose, cloud-ready | APPROVED |
| 4 | Tech Stack — TypeScript monorepo, Hono backend | APPROVED |
| 5 | Database — Postgres + PgBouncer (dual-mode) + Redis (logical DBs + ACLs) | APPROVED |
| 6 | Code Execution — isolated-vm in separate container + Docker sandbox via proxy | APPROVED |
| 7 | Auth — email/password + OAuth + JWT revocation + emergency re-key | APPROVED |
| 8 | License — BSL (converts to Apache 2.0 after 4 years) | APPROVED |
| 9 | Real-Time — SSE + WebSockets | APPROVED |
| 10 | Architecture — 9 microservices, SOLID, engine-first | APPROVED |
| 11 | Secret Management — AES-256-GCM + HKDF + idempotent rotation | APPROVED |
| 12 | Ontology Resilience — local cache + pub/sub + 15s poll + jitter + circuit breaker | APPROVED |
| 13 | Queue Reliability — DLQ + backpressure + poison-pill | APPROVED |
| 14 | Schema Migration — versioned, dual-schema UNION view, per-batch shadow tables, orphan cleanup | APPROVED |
| 15 | App Routing — path-based default, optional subdomain | APPROVED |
| 16 | Plugin Hooks — linearized, sandboxed, critical/advisory, depth guard | APPROVED |
| 17 | Logging — async pub/sub + BullMQ audit + batch persist + horizontal scale path | APPROVED |
| 18 | Redis Resilience — AOF + graceful degradation + WAL for job buffer + Sentinel docs | APPROVED |
| 19 | Service-to-Service Auth — per-service secrets + service RBAC + 3-tier network | APPROVED |
| 20 | Rate Limiting — multi-tier + local in-memory fallback | APPROVED |
| 21 | Observability — OTEL + Prometheus + Jaeger + auto-instrumented via core | APPROVED |
| 22 | SDK/CLI/API — first-class, auto-generated, browser OAuth+PKCE, App BFF | APPROVED |
| 23 | Auto-Generated Docs — API/SDK/CLI/ontology, CI drift check, versioned | APPROVED |

## Services

| Service | Port | Key Responsibilities |
|---------|------|---------------------|
| Gateway | 3000 | API routing, rate limiting, auth validation, auto-generated REST endpoints |
| Auth | 3001 | Users, sessions, OAuth, API keys, RBAC, ontology-aware permissions |
| Ingestion | 3002 | Connectors, webhooks, uploads, credential vault |
| Ontology | 3003 | Schema definitions, mapping, code generation, migration |
| Pipeline | 3004 | Workflow orchestration, triggers, cron, hook invocation |
| Execution | 3005 | Sandboxed code execution (isolated-vm + Docker) |
| App | 3006 | User app hosting, SDK, build/deploy |
| Logging | 3007 | Centralized logs, audit, metrics, alerting |
| Plugin | 3008 | Plugin lifecycle, hook registry, extension points |

## Infrastructure

| Component | Purpose |
|-----------|---------|
| PostgreSQL 16 + PgBouncer | Persistent storage with connection pooling |
| Redis 7 (AOF, ACLs, logical DBs) | Queues, cache, pub/sub, auth state |
| Docker Socket Proxy | Restricted Docker API for sandbox containers |
| op-sandbox-vm | Process-isolated isolated-vm container |
| Nginx | Frontend SPA serving |

## Shared Packages

| Package | Purpose |
|---------|---------|
| @oneplatform/core | Engine library — DB, auth, queues, logging, OTEL, types |
| @oneplatform/sdk | External app SDK (auto-generated from OpenAPI) |
| @oneplatform/app-sdk | Platform app SDK |
| @oneplatform/plugin-sdk | Plugin development SDK |
| @oneplatform/cli | CLI tool (op) |

## Key Design Principles (ALWAYS reference these)

1. **SOLID** — Single Responsibility, Open/Closed, Liskov, Interface Segregation, Dependency Inversion
2. **Engine-first** — Robust core engine, extensible layers on top
3. **Plugin architecture** — Built-in features use the same interfaces as third-party plugins
4. **Auth first-class** — Woven into core library, ontology-driven RBAC
5. **API-first** — Everything available via REST API, CLI, SDKs
6. **Auto-generated** — Types, API routes, docs, SDK methods all generated from ontology/code
7. **Observable** — Trace IDs, OTEL, Prometheus metrics, audit trails
8. **Secure** — Sandboxed execution, encrypted credentials, service-to-service auth, rate limiting

## Files to Read

| File | Purpose |
|------|---------|
| `docs/decisions/001-architecture-decisions.md` | All 23 architecture decisions (L0 reference) |
| `DEVELOPMENT-PROCESS.md` | Full development pipeline and quality gates |
| `docs/WORKING-STATE.md` | THIS FILE — current state of work |
| `README.md` | Project overview and quick start |

## Git History

All work is committed and pushed to https://github.com/aaron777collins/oneplatform
- Initial commit: architecture decisions
- Multiple review cycles: all blocking issues resolved
- Latest: 5th review fixes (per-service secrets, job WAL, graceful sandbox recycling, etc.)
