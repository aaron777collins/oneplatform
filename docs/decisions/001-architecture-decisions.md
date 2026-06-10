# OnePlatform — Architecture Decision Record

## Project Vision

OnePlatform is an open-source data platform that provides:
- Data ingestion from any source
- User-defined ontology/schema mapping
- Automated pipelines with triggers, crons, and event-driven flows
- Sandboxed code execution in multiple languages
- An app platform for building and hosting mini-apps
- API gateway for exposing data via REST endpoints
- Built-in auth and RBAC for multi-tenant security

It aims to be a free, open-source alternative to tools like Fivetran, n8n, and Retool — combined into one cohesive platform.

## Key Decisions

### 1. MVP Scope
**Decision:** Include all core subsystems in MVP — ingestion, ontology, pipelines, code execution, app platform, API gateway, and auth/RBAC. Marketplace/pre-built connectors deferred to fast follow.

**Rationale:** The app platform is a key differentiator. Users need the full "ingest → map → build" loop to see the value.

### 2. App Platform Approach
**Decision:** Code-first with templates and SDK. Visual drag-and-drop builder designed for later.

**Rationale:** Faster to build, more flexible, appeals to technical early adopters. Architecture allows visual builder to be layered on top.

### 3. Deployment Model
**Decision:** Self-hosted first via Docker Compose, with cloud-ready architecture internally.

**Rationale:** Single `docker compose up` for easy adoption. Clean service boundaries allow splitting into hosted SaaS later if monetized.

### 4. Tech Stack
**Decision:** Full TypeScript monorepo — React + Tailwind v4 + shadcn/ui frontend, Fastify/Hono backend services.

**Rationale:** Same language front and back, shared types, huge ecosystem. Code generation is central to the platform — generating TypeScript that runs natively in the same runtime is the most cohesive approach.

### 5. Database Strategy
**Decision:** PostgreSQL + Redis. Postgres for persistent storage, Redis for job queues (BullMQ), caching, and real-time pipeline state.

**Rationale:** Postgres handles structured platform metadata and dynamic user data (JSONB). Redis is needed for BullMQ job queues regardless. One extra container in Docker Compose.

### 6. Code Execution Sandbox
**Decision:** `isolated-vm` for JavaScript/TypeScript (fast path, ~1ms), Docker containers for other languages (Python, Go, etc.).

**Rationale:** Most auto-generated code is JS/TS and benefits from near-instant execution. Docker containers provide full language support for heavy processing. Platform injects controlled APIs (fetch, db, cache) into both environments.

### 7. Authentication Model
**Decision:** Built-in email/password auth + optional OAuth (GitHub, Google). API keys for programmatic access.

**Rationale:** Self-hosted users need offline auth. OAuth is table stakes for modern platforms. Both available via configuration.

### 8. License
**Decision:** Business Source License (BSL) — source-available, free to self-host, converts to Apache 2.0 after 4 years.

**Rationale:** Protects against competitors re-hosting the project as a competing service. Allows monetization later while keeping source fully visible and self-hosting free.

### 9. Real-Time Communication
**Decision:** SSE for one-way streaming (pipeline logs, status updates, data feeds) + WebSockets for bidirectional communication (app platform).

**Rationale:** SSE is simpler and more reliable for 80% of real-time needs. WebSockets available for apps needing bidirectional communication.

### 10. Architecture Pattern
**Decision:** Full microservices — each subsystem is its own service with clean boundaries. Shared PostgreSQL with per-service schemas initially, separable to individual databases later.

**Rationale:** Avoids painful monolith-to-microservices refactoring later. Per-service schemas keep data boundaries clean while keeping Docker Compose manageable. Connection string change is all that's needed to split databases.

## Tech Stack Summary

| Layer | Technology | License |
|-------|-----------|---------|
| Frontend | React 18, TypeScript, Tailwind v4, shadcn/ui | MIT |
| Backend Framework | Fastify or Hono | MIT |
| Database | PostgreSQL 16 | PostgreSQL License (permissive) |
| Cache/Queue | Redis 7 + BullMQ | BSD-3 / MIT |
| JS Sandbox | isolated-vm | MIT |
| Container Sandbox | Docker Engine API | Apache 2.0 |
| Auth | Custom + Passport.js (OAuth) | MIT |
| Real-time | SSE + ws (WebSocket) | MIT |
| Testing | Vitest, Playwright, Supertest | MIT |
| Monorepo | Turborepo or pnpm workspaces | MIT / MIT |
| Containerization | Docker, Docker Compose | Apache 2.0 |

All dependencies are MIT/Apache/BSD/permissive — safe for commercial use under BSL.
