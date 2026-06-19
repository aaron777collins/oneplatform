# Platform Admin Quickstart

Get the OnePlatform stack running and create the first admin user.

## Prerequisites

- Docker 24+ and Docker Compose v2
- `openssl` available in your shell
- Ports 80 and 443 free on the host

## Setup (2 commands)

```sh
# 1. Copy and fill required secrets
cp .env.example .env
# Edit .env: set OP_MINIO_PASSWORD and POSTGRES_PASSWORD to strong values
# Generate strong values: openssl rand -hex 32

# 2. Start the stack
docker compose up -d
```

## First working example

Wait for all services to report healthy (check with `docker compose ps`), then:

```sh
# Extract the one-time bootstrap token from the init container logs
BOOTSTRAP_TOKEN=$(docker compose logs op-init 2>&1 | grep 'BOOTSTRAP_TOKEN=' | tail -1 | sed 's/.*BOOTSTRAP_TOKEN=//')

# Create the first admin user via the Auth Service API
curl -s -X POST https://localhost/api/v1/auth/bootstrap \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $BOOTSTRAP_TOKEN" \
  -d '{
    "email": "admin@example.com",
    "password": "'"$(openssl rand -hex 16)"'",
    "name": "Platform Admin"
  }'

# Log in and obtain a session token
curl -s -X POST https://localhost/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "admin@example.com", "password": "<password-from-above>"}'

# Verify all services are healthy
curl -s https://localhost/healthz | jq .
```

Expected output from the health check:

```json
{
  "status": "ok",
  "services": {
    "gateway-service": "ok",
    "auth-service": "ok",
    "ingestion-service": "ok",
    "ontology-service": "ok",
    "pipeline-service": "ok",
    "execution-service": "ok",
    "app-service": "ok",
    "logging-service": "ok",
    "plugin-service": "ok"
  }
}
```

The platform UI is available at `https://localhost`.

## Basic configuration

```sh
# Set allowed CORS origins (required before going to production)
# Edit .env and set OP_ALLOWED_ORIGINS=https://your-domain.com
# Then restart: docker compose up -d

# View recent audit logs via the Logging Service API
curl -s https://localhost/api/v1/logs?level=audit&limit=20 \
  -H "Authorization: Bearer <session-token>"
```

## Next steps

- [Data Engineer Quickstart](./data-engineer.md) — connect a data source
- [App Developer Quickstart](./app-developer.md) — build and deploy an app
- [Plugin Developer Quickstart](./plugin-developer.md) — create a plugin
- `docs/DEPLOYMENT.md` — production hardening, TLS, backups
- `docker/scripts/backup.sh` — scheduled backup setup
