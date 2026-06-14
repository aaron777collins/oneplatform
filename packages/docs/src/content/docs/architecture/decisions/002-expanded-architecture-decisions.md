---
title: "ADRs 023–036: Expanded Architecture"
description: Expanded decisions covering developer surfaces, plugin system, documentation, and infrastructure.
sidebar:
  order: 3
---

These decisions are documented in `docs/decisions/002-expanded-architecture-decisions.md` in the repository.

The file covers:

- **ADR-23** — Auto-generated documentation system (OpenAPI + TypeDoc + Starlight)
- **ADR-24** — Tenant-aware ontology cache in the Gateway (Redis pub/sub + 5-minute safety poll)
- **ADR-25** — App bundle format (single ES module, `@oneplatform/app-sdk` externalized)
- **ADR-26** — `@oneplatform/app-sdk` React hooks API (`useQuery`, `useMutation`, `useSubscription`)
- **ADR-27** — Plugin manifest format (JSON, hooks array, permission declarations)
- **ADR-28** — `.oppkg` bundle format (ZIP with `dist/bundle.js` + `plugin.manifest.json`)
- **ADR-29** — Tenant-specific OpenAPI spec at `GET /api/v1/openapi.json`
- **ADR-30** — CLI command structure (`op <resource> <action>` pattern)
- **ADR-31** — API key format (`op_<type>_<random>` with scope embedding)
- **ADR-32** — Webhook delivery model (at-least-once, exponential backoff, 7-day retention)
- **ADR-33** — SSE event format for real-time subscriptions
- **ADR-34** — Data route pattern at Gateway (`/api/v1/data/{entityType}`)
- **ADR-35** — Structured error envelope (`{ error: { code, message, details } }`)
- **ADR-36** — Inter-service authentication (`X-Service-Token` header, rotating keys)

View the full document in the repository: `docs/decisions/002-expanded-architecture-decisions.md`
