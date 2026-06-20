# Full Platform Demo

A complete OnePlatform demo environment with seeded data, monitoring, and all features enabled.

## What's Included

- 2 demo tenants (Acme Corp, Widget Co)
- Users with different roles (admin, analyst, viewer)
- All 5 connector types configured
- 4 entity definitions (Customer, Order, Product, Event)
- 3 pipelines (sync, ETL, event processing)
- 2 apps (admin dashboard, customer portal)
- Grafana monitoring dashboard

## Prerequisites

- Docker Desktop (4GB+ RAM allocated)
- Node.js 18+
- `op` CLI installed (`npm i -g @oneplatform/cli`)

## Quick Start

```bash
# 1. Start the platform with demo overrides
docker compose -f ../../docker/docker-compose.yml -f docker-compose.override.yml up -d

# 2. Wait for services to be healthy (about 30 seconds)
docker compose -f ../../docker/docker-compose.yml ps

# 3. Seed demo data
pnpm install
pnpm seed

# 4. Open the platform
open http://localhost:3000
```

## Demo Credentials

| User | Email | Password | Role | Tenant |
|------|-------|----------|------|--------|
| Admin | admin@acme.example.com | Demo1234! | platform-admin | Acme Corp |
| Analyst | analyst@acme.example.com | Demo1234! | data-engineer | Acme Corp |
| Viewer | viewer@acme.example.com | Demo1234! | viewer | Acme Corp |
| Admin | admin@widget.example.com | Demo1234! | tenant-admin | Widget Co |

## Monitoring

Grafana is available at `http://localhost:3001` with the pre-configured dashboard.

## Cleanup

```bash
./scripts/cleanup.sh
```

## See Also

- [Quick Start](../quick-start/) — Simpler getting-started guide
- [Visual Pipeline](../visual-pipeline/) — Pipeline builder examples
- [Enterprise Auth](../enterprise-auth/) — Authentication setup
