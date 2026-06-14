---
title: "ADRs 001–022: Core Architecture"
description: Core architecture decisions covering platform vision, service design, data model, auth, and APIs.
sidebar:
  order: 2
---

These decisions are documented in `docs/decisions/001-architecture-decisions.md` in the repository.

The file covers:

- **ADR-01** — Microservices architecture with Hono + TypeScript
- **ADR-02** — PostgreSQL as the primary data store
- **ADR-03** — Redis for caching, pub/sub, and rate limiting
- **ADR-04** — MinIO for object storage (bundles, attachments)
- **ADR-05** — JWT-based authentication with refresh token rotation
- **ADR-06** — RBAC permission model
- **ADR-07** — Ontology-driven data model (entity types, fields, validation rules)
- **ADR-08** — Connector + sync model for external data sources
- **ADR-09** — Pipeline DSL for ETL step composition
- **ADR-10** — Sandboxed app runtime (V8 isolates via the BFF pattern)
- **ADR-11** — Plugin system with hook points
- **ADR-12** — API gateway pattern (single entry point for all client traffic)
- **ADR-13** — Docker Compose for local development, Kubernetes for production
- **ADR-14** — Turborepo + pnpm workspaces monorepo structure
- **ADR-15** — Vitest for unit and integration testing
- **ADR-16** — OpenAPI 3.0.3 as the API contract format
- **ADR-17** — TypeDoc + Starlight for documentation
- **ADR-18** — Commander.js for the CLI
- **ADR-19** — Zod for runtime schema validation (shared between services and SDK)
- **ADR-20** — Event-driven architecture for cross-service notifications (Redis Streams)
- **ADR-21** — Structured logging with trace ID propagation
- **ADR-22** — SDK, CLI, and API as first-class citizens (not afterthoughts)

View the full document in the repository: `docs/decisions/001-architecture-decisions.md`
