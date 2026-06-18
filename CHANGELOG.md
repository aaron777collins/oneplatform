# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-06-17

### Added

#### Infrastructure & Core (Phases 1–2)
- Turborepo + pnpm monorepo scaffold with 9 services and 7 packages
- Docker Compose stack: PostgreSQL 16, PgBouncer, Redis 7, BullMQ workers, Caddy TLS reverse proxy
- `@oneplatform/core` library: types, config, errors, crypto, DB, Redis, queues, logger, events, health checks, middleware, `createApp()` factory
- Ed25519 service-to-service token auth with 3-tier network topology
- L2 design documents for all 9 services and 4 shared packages (25,535 lines)

#### Services (Phase 3)
- **Auth Service** — registration, login, JWT/refresh token rotation, TOTP MFA, OAuth2/OIDC provider, API key management (182 unit tests)
- **Ontology Service** — entity/relationship schema registry, ontology-driven RBAC, permission graph (610 unit tests)
- **Gateway Service** — rate limiting, request routing, JWT validation, service-token forwarding
- **Logging Service** — structured log ingestion, log levels, retention policies, dead-letter queue
- **Ingestion Service** — connector framework, event ingestion, schema validation, DLQ routing
- **Pipeline Service** — visual pipeline definitions, DAG execution ordering, step configuration (450 unit tests)
- **Execution Service** — isolated-vm sandbox (JS/TS), Docker sandbox (Python/Go), resource limits
- **App Service** — app registry, version management, settings storage, widget configuration (530 unit tests)
- **Plugin Service** — plugin lifecycle, manifest validation, sandboxed plugin execution (557 unit tests)

#### SDKs, CLI & Plugin SDK (Phase 4)
- `@oneplatform/sdk` — typed REST client, auth helpers, pagination, SSE, filter builder (39 files)
- `@oneplatform/app-sdk` — React hooks, BFF client, WebSocket manager, permission cache (32 files)
- `@oneplatform/plugin-sdk` — plugin types, manifest validation, testing utilities, dev tools
- `@oneplatform/cli` — full CLI covering auth, connectors, pipelines, apps, plugins, logs

#### Frontend (Phases 5–7)
- React 18 + TypeScript + Tailwind CSS v4 + shadcn/ui frontend package
- Six-screen bootstrap wizard for first-run setup
- Dashboard, connector management, ontology browser, pipeline editor (Monaco-based)
- App catalog, plugin manager, log viewer, DLQ console, metrics, settings (172 files, 367 tests)

#### Testing (Phase 8)
- Integration test suite: 20 files, ~126 tests across all 9 services
- Cross-service HTTP tests covering all service boundaries
- Full-stack E2E test suites (4 suites) with shared helpers

#### Operational Hardening (Phases 9–13)
- OpenTelemetry tracing and metrics across all services
- OTEL Collector + Vector log aggregation pipeline
- Caddy TLS reverse proxy with Authelia SSO
- OpenAPI spec generation pipeline and auto-published API docs (MkDocs Material)
- GitHub Actions CI pipeline: lint, typecheck, test, build, Docker image build
- P1 gap closures from V2/V3/V4 user story analysis (148 findings across 63 files)

### Changed

- N/A — initial release

### Fixed

- N/A — initial release

### Security

- All secrets loaded from environment variables, never committed
- bcrypt password hashing with configurable cost factor
- Ed25519 service tokens with short expiry and per-service ACLs
- Redis ACL rules scoped per service (least-privilege)
- Sandboxed plugin/script execution (isolated-vm + Docker)
- Ontology-driven RBAC enforced at gateway and service layer

[Unreleased]: https://github.com/AaronCollins/oneplatform/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/AaronCollins/oneplatform/releases/tag/v0.1.0
