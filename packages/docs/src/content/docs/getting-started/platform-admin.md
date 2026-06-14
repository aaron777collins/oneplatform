---
title: Platform Admin Quickstart
description: Get the OnePlatform stack running and create the first admin user.
sidebar:
  order: 1
---

Get the OnePlatform stack running and create the first admin user.

## Prerequisites

- Docker 24+ and Docker Compose v2
- `openssl` available in your shell
- Ports 3000 and 8080 free on the host

## Setup (3 commands)

```sh
# 1. Copy and fill required secrets
cp .env.example .env
# Edit .env: set OP_MINIO_PASSWORD and POSTGRES_PASSWORD to strong values
# Generate strong values: openssl rand -hex 32

# 2. Start the stack
docker compose up -d

# 3. Install the CLI
npm install -g @oneplatform/cli
```

## First working example

Wait for all services to report healthy (check with `docker compose ps`), then:

```sh
# Extract the one-time bootstrap token from the init container logs
BOOTSTRAP_TOKEN=$(docker compose exec op-init cat /data/init/bootstrap.token)

# Create the first admin user
op auth bootstrap \
  --token "$BOOTSTRAP_TOKEN" \
  --email admin@example.com \
  --password "$(openssl rand -hex 16)" \
  --name "Platform Admin"

# Log in
op auth login --email admin@example.com

# Verify all services are healthy
op service health
```

Expected output from `op service health`:

```
gateway-service    ok
auth-service       ok
ingestion-service  ok
ontology-service   ok
pipeline-service   ok
execution-service  ok
app-service        ok
logging-service    ok
plugin-service     ok
```

The platform UI is available at `http://localhost:8080`.

## Basic configuration

```sh
# Set allowed CORS origins (required before going to production)
op config set OP_ALLOWED_ORIGINS https://your-domain.com

# Rotate inter-service signing keys on schedule
op service rotate-keys

# View recent audit logs
op log list --level audit --limit 20
```

## Next steps

- [Data Engineer Quickstart](/getting-started/data-engineer) — connect a data source
- [App Developer Quickstart](/getting-started/app-developer) — build and deploy an app
- [Plugin Developer Quickstart](/getting-started/plugin-developer) — create a plugin
- `docs/DEPLOYMENT.md` — production hardening, TLS, backups
- `docker/scripts/backup.sh` — scheduled backup setup
