---
title: Service Design Documents
description: Per-service and per-package design documents for OnePlatform.
sidebar:
  order: 1
---

Detailed service designs are stored in `docs/designs/` in the repository. Each document
covers the data model, API surface, implementation decisions, and known limitations for
a specific service or package.

## Available designs

| Document | Covers |
|----------|--------|
| `auto-generated-docs.md` | OpenAPI generation, TypeDoc, Starlight docs site |
| `auth-service.md` | Authentication, token lifecycle, RBAC |
| `gateway-service.md` | Proxy, rate limiting, webhooks, data routing |
| `ingestion-service.md` | Connectors, sync scheduling, field mapping |
| `ontology-service.md` | Entity types, field schemas, validation rules |
| `pipeline-service.md` | Pipeline DSL, step types, scheduling |
| `execution-service.md` | Run lifecycle, sandboxing, log streaming |
| `app-service.md` | App lifecycle, VFS, BFF pattern |
| `logging-service.md` | Log ingestion, storage, querying |
| `plugin-service.md` | Plugin lifecycle, hook dispatch |
| `sdk-package.md` | `@oneplatform/sdk` API design |
| `app-sdk-package.md` | `@oneplatform/app-sdk` React hooks design |
| `plugin-sdk-package.md` | `@oneplatform/plugin-sdk` plugin author API |
| `cli-package.md` | CLI command structure and implementation |
| `frontend-package.md` | Admin UI and app shell design |
| `friction-fixes.md` | Developer experience improvements |

View all designs in the repository: `docs/designs/`
