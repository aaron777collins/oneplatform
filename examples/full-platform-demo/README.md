# Full Platform Demo

A complete OnePlatform deployment demo that provisions tenants, users, connectors, entity types, pipelines, and applications using the `@oneplatform/sdk`. This example is designed for evaluation, training, and development environments where you need a fully populated platform instance with realistic data.

## What Gets Created

The seed script provisions the following resources across two demo tenants:

### Acme Corp (Enterprise Tenant)
- **Users**: 6 users across 4 roles (admin, data engineer, analyst, viewer)
- **Connectors**: Salesforce CRM, PostgreSQL data warehouse, REST API
- **Entity types**: Customer, Order, Product, SupportTicket
- **Pipelines**: CRM sync, order ETL, product catalog refresh, support ticket triage
- **Apps**: Executive dashboard, inventory management tool

### Widget Co (Professional Tenant)
- **Users**: 4 users across 3 roles
- **Connectors**: Shopify, Google Analytics
- **Entity types**: Product, Order, WebSession
- **Pipelines**: Shopify product sync, order processing, analytics aggregation
- **Apps**: Sales dashboard

## Prerequisites

- **Docker Desktop** (v4.0+) or a remote Docker host
- **Node.js 18+** with npm
- **OnePlatform** source code (this demo lives inside the monorepo)
- An **admin API key** (generated during platform bootstrap)

## Quick Start

### 1. Start the Platform

```bash
npm run demo:up
```

This starts all OnePlatform services plus the demo overrides (Grafana on port 3100, Jaeger on port 16686).

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env and set OP_API_KEY to your admin API key
```

### 3. Seed the Platform

```bash
npm run seed
```

The seed script creates all tenants, users, connectors, entities, pipelines, and apps in order, respecting dependencies.

### 4. Explore the Platform

- **OnePlatform UI**: https://localhost
- **Grafana dashboards**: http://localhost:3100 (admin / admin)
- **Jaeger tracing**: http://localhost:16686

### 5. Clean Up

```bash
# Remove all demo data (keeps the platform running)
npm run cleanup

# Stop everything
npm run demo:down

# Full reset: stop, clean, reseed
npm run demo:reset
```

## Directory Structure

```
full-platform-demo/
  seed/
    tenants.json          Tenant definitions
    users.json            User accounts with role assignments
    connectors.json       Data source connector configurations
    entities.json         Entity type (ontology) definitions
    pipelines.json        Pipeline definitions with steps
    apps.json             Application definitions
  scripts/
    seed.ts               Seed script using @oneplatform/sdk
    cleanup.sh            Tear down all demo data
  monitoring/
    grafana-dashboard.json  Pre-built Grafana dashboard for platform observability
  docker-compose.override.yml  Docker Compose overrides for demo services
  .env.example            Environment variable template
  package.json            Dependencies and npm scripts
  README.md               This file
```

## Seed Data Details

### Tenants

Two tenants demonstrate different platform configurations:

| Tenant | Plan | Timezone | Features |
|--------|------|----------|----------|
| Acme Corp | Enterprise | America/New_York | Audit logging, 512MB sandbox, 90-day retention |
| Widget Co | Professional | Europe/London | 256MB sandbox, 30-day retention |

### Users

User passwords are **generated at seed time** — the `seed/users.json` file contains
the placeholder `"<GENERATED_BY_SEED_SCRIPT>"` for every password field rather than
literal credentials. When the seed script runs, it calls `crypto.randomBytes(16)` to
produce a unique 32-character hex password for each user and prints it to stdout.
Copy those passwords from the seed output; they are not stored anywhere after the
script exits.

Each user has a realistic name, email, and role assignment:

| User | Tenant | Role | Purpose |
|------|--------|------|---------|
| Sarah Chen | Acme Corp | tenant-admin | Tenant administrator |
| Marcus Rivera | Acme Corp | data-engineer | Pipeline and connector management |
| Emily Nakamura | Acme Corp | data-engineer | Ontology and data modeling |
| David Okonkwo | Acme Corp | business-analyst | Dashboard and app development |
| Priya Sharma | Acme Corp | viewer | Read-only stakeholder access |
| James Mitchell | Acme Corp | viewer | External auditor access |
| Lena Fischer | Widget Co | tenant-admin | Tenant administrator |
| Raj Patel | Widget Co | data-engineer | E-commerce data integration |
| Sofia Andersson | Widget Co | business-analyst | Sales analytics |
| Tom Williams | Widget Co | viewer | Management reporting |

### Pipelines

Pipelines demonstrate different patterns:

- **Scheduled sync**: CRM data pulled every 15 minutes
- **Event-driven ETL**: Order data processed on connector events
- **Batch refresh**: Product catalog refreshed daily at 02:00 UTC
- **Multi-step processing**: Support tickets enriched, classified, then routed

## Monitoring

The included Grafana dashboard (`monitoring/grafana-dashboard.json`) provides:

- **Pipeline health**: Run success/failure rates, duration percentiles, throughput
- **Connector status**: Sync intervals, record counts, error rates
- **API performance**: Request latency, error rates, active connections
- **Resource usage**: CPU, memory, and disk usage for each service

Import the dashboard via Grafana UI (Dashboards > Import > Upload JSON) or place it in Grafana's provisioning directory.

## Customization

### Adding More Seed Data

Edit the JSON files in `seed/` to add more resources. The seed script processes them in dependency order (tenants -> users -> connectors -> entities -> pipelines -> apps), so new resources must reference existing parent resources.

### Adjusting Docker Compose

The `docker-compose.override.yml` extends the base Docker Compose configuration with demo-specific settings (exposed ports, Grafana, Jaeger). Modify it to change ports, add services, or adjust resource limits.

### Environment Variables

See `.env.example` for all available configuration options including database credentials, TLS mode, observability settings, and demo-specific flags.
