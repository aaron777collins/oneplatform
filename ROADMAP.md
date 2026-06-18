# OnePlatform Roadmap

**Last updated:** June 17, 2026

> **Disclaimer:** This roadmap reflects current intent and priorities. Specific items,
> ordering, and timelines may change based on community feedback, contributor availability,
> and production learnings. Watch the repository or join GitHub Discussions to stay current.

---

## What is OnePlatform?

OnePlatform is an open-source data integration, transformation, and app platform — a free
alternative to Fivetran + n8n + Retool combined into one cohesive system. You ingest data
from any source, map it to user-defined ontologies, route it through automated pipelines,
and build apps on top of it — all without leaving the platform.

---

## Phase 1: Core Platform — COMPLETE

The foundation is built, tested, and operational.

### Platform Infrastructure
- 9 microservices: Gateway, Auth, Ingestion, Ontology, Pipeline, Execution, App, Logging, Plugin
- React 18 frontend with full admin UI, wizard-based bootstrap flow, Monaco-based code editor
- PostgreSQL 16 + PgBouncer, Redis 7 + BullMQ, isolated-vm + Docker sandbox
- Caddy reverse proxy with TLS (self-signed dev, Let's Encrypt prod, HTTP fallback)
- Docker Compose with resource limits, health checks, and security hardening
- OpenTelemetry distributed tracing wired across all 9 services (Jaeger, Prometheus)
- GitHub Actions CI/CD: lint, typecheck, unit tests, integration tests, Docker image build

### Security & Auth
- Ed25519 service-to-service authentication on all internal routes
- RBAC with entity-level, field-level, and row-level permissions driven by the ontology
- API key management: scoped, rotatable, revocable, with expiry
- Asymmetric JWT (Ed25519) for user sessions, httpOnly cookie delivery
- Per-user token revocation, deactivation-triggered session invalidation
- SSRF guard (IPv4 + IPv6), rate limiting, security response headers, CORS

### Developer Experience
- `@oneplatform/sdk` — typed TypeScript client with auth, pagination, SSE, filter builder
- `@oneplatform/app-sdk` — React hooks, BFF client, WebSocket, permission cache
- `@oneplatform/plugin-sdk` — plugin manifest validation, testing utilities, dev tools
- `@oneplatform/cli` (`op`) — full CLI covering auth, connectors, pipelines, apps, plugins,
  ontology, schedules, and API keys (23 reference pages auto-generated)
- Auto-generated OpenAPI specs for all 9 services, TypeDoc for all 4 SDK packages

### Built-in Connectors (5)
- **REST API** — paginated polling, auth (Bearer, Basic, API key), header templating
- **PostgreSQL** — full and cursor-based incremental sync, SSL
- **MySQL** — full and cursor-based incremental sync, SSL
- **CSV** — file upload and URL fetch, delimiter and encoding options
- **Webhook** — inbound HTTP push with signature verification (HMAC-SHA256)

### Testing
- ~6,800 tests total: ~5,600 service unit tests, 367 frontend tests, 214 connector tests,
  248 SDK/CLI tests, and ~200 integration + E2E tests
- 4 levels of test coverage: unit, integration (L1 per-service), cross-service HTTP (L2),
  full-stack E2E (L3)

---

## Phase 2: Enterprise Readiness — IN PROGRESS

Making OnePlatform production-ready for regulated and enterprise environments.

### Auth & Identity
- **OIDC/SSO auth provider plugin** — plug-in interface for enterprise identity providers
  (Okta, Azure AD, Google Workspace, Keycloak). The plugin-sdk interface is defined;
  the reference implementation is in progress.
- **Asymmetric JWT signing (RS256/EdDSA)** — configurable signing algorithm, JWK Set
  endpoint for downstream consumers, key rotation without service restart

### Data Governance
- **GDPR data subject request tools** — right-to-access and right-to-erasure workflows,
  tenant-scoped data export, audit trail of subject requests
- **Schema drift detection** — automatic detection of new, removed, or changed columns
  on each sync run; configurable alerts and schema migration proposals

### Connector Ecosystem
- **Connector marketplace / registry** — hosted registry with searchable catalog,
  semantic versioning, one-click install, and community ratings

### Pipeline & Workflow
- **Visual workflow editor** — node-based drag-and-drop pipeline builder (vs the current
  code-first editor); real-time preview of data flow
- **Data quality monitoring** — anomaly detection on ingested data (null rate spikes,
  volume drops, type mismatches), configurable alert thresholds and notification channels

---

## Phase 3: Competitive Differentiation — PLANNED

Features that advance OnePlatform from "capable" to "best-in-class" for specific use cases.

### Data Integration
- **Change Data Capture (CDC)** — real-time database replication via PostgreSQL WAL
  (logical replication) and MySQL binlog; low-latency sync without polling
- **Data lineage visualization** — interactive graph tracing data from source connector
  through raw ingestion, ontology mapping, pipeline transformations, and app consumption
- **SQL-based transformation library** — dbt-style declarative transforms, pre-built
  functions (dedup, pivot, aggregate, join), and a transformation test harness

### Pipeline Execution
- **Sub-workflows and parallel execution** — compose pipelines from reusable sub-workflows;
  run independent branches in parallel with configurable fan-out and merge strategies

### Infrastructure
- **Kubernetes deployment manifests** — Helm chart covering all 9 services, PgBouncer,
  Redis, Caddy, and the OTEL collector; horizontal pod autoscaling for stateless services
- **SOC2 readiness tooling** — automated evidence collection (access logs, change history,
  encryption attestations), control mapping documentation, and audit-ready reports

---

## Phase 4: Future Vision — EXPLORING

Longer-horizon ideas being evaluated. No implementation commitment yet; community input
will shape whether and how these land.

### API Layer
- **GraphQL API gateway** — GraphQL schema auto-generated from the ontology, with
  resolver-level permission enforcement
- **gRPC support** — high-throughput binary protocol for service-to-service data
  transfer and SDK clients

### Deployment & Scale
- **Multi-region deployment** — active-active or active-passive configurations with
  cross-region replication and latency-aware routing
- **Streaming ingestion (Kafka, NATS)** — first-class Kafka consumer and NATS JetStream
  connector with exactly-once delivery guarantees

### Reach
- **Mobile app support** — React Native SDK and responsive frontend for managing
  connectors, monitoring pipelines, and viewing app data from mobile devices

---

## Contributing

OnePlatform is built by its community. See [CONTRIBUTING.md](CONTRIBUTING.md) for:

- How to set up a local development environment
- Coding standards and the pull request process
- How to propose new features or architectural changes
- Where to find beginner-friendly issues

If you want to work on a roadmap item, open an issue or comment on an existing one to
coordinate before starting. Large items (Phase 2 and beyond) benefit from an architecture
discussion before implementation begins.

Questions and discussion: [GitHub Discussions](https://github.com/aaron777collins/oneplatform/discussions)
