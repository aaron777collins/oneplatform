# OnePlatform — Debug Reference

All commands target the **dev-test** stack (`-p op-dev-test`). Adjust if you are using the main stack.

---

## Quick Reference

| Service | Container Name | Internal Port | Health Endpoint | Host Port (dev-test) |
|---|---|---|---|---|
| Gateway | `op-dev-test-gateway` | 3000 | `/healthz` | `127.0.0.1:4080` |
| Auth | `op-dev-test-auth` | 3000 | `/healthz` | — (internal only) |
| Ingestion | `op-dev-test-ingestion` | 3000 | `/healthz` | — |
| Ontology | `op-dev-test-ontology` | 3000 | `/healthz` | — |
| Pipeline | `op-dev-test-pipeline` | 3000 | `/healthz` | — |
| Execution | `op-dev-test-execution` | 3000 | `/healthz` | — |
| App | `op-dev-test-app` | 3000 | `/healthz` | — |
| Logging | `op-dev-test-logging` | 3000 | `/healthz` | — |
| Plugin | `op-dev-test-plugin` | 3000 | `/healthz` | — |
| Docker BFF | `op-dev-test-docker-bff` | 3000 | `/healthz` | — |
| Sandbox VM | `op-dev-test-sandbox-vm` | Unix socket | (socket check) | — |
| PostgreSQL | `op-dev-test-postgres` | 5432 | `pg_isready` | `127.0.0.1:5532` |
| PgBouncer | `op-dev-test-pgbouncer` | 5433 | `SELECT 1` | — (internal only) |
| Redis | `op-dev-test-redis` | 6379 | `PING` | `127.0.0.1:6479` |
| MinIO S3 API | `op-dev-test-minio` | 9000 | `/minio/health/live` | `127.0.0.1:9100` |
| MinIO Console | `op-dev-test-minio` | 9001 | — | `127.0.0.1:9101` |
| Caddy (HTTP) | `op-dev-test-caddy` | 80 | — | `0.0.0.0:8088` |
| Caddy (HTTPS) | `op-dev-test-caddy` | 443 | — | `0.0.0.0:8443` |
| Jaeger UI | `op-dev-test-jaeger` | 16686 | — | `127.0.0.1:16687` |
| Jaeger OTLP | `op-dev-test-jaeger` | 4318 | — | `127.0.0.1:4319` |
| Grafana | `op-dev-test-grafana` | 3000 | `/api/health` | `127.0.0.1:3101` |
| Vector | `op-dev-test-vector` | — | — | — |

All services behind PgBouncer connect on port **5433** (not 5432).

---

## Checking Logs

### View all container logs

```bash
docker compose -f docker/docker-compose.dev-test.yml -p op-dev-test logs
```

### View a specific service

```bash
docker compose -f docker/docker-compose.dev-test.yml -p op-dev-test logs gateway-service
docker compose -f docker/docker-compose.dev-test.yml -p op-dev-test logs auth-service
docker compose -f docker/docker-compose.dev-test.yml -p op-dev-test logs ingestion-service
docker compose -f docker/docker-compose.dev-test.yml -p op-dev-test logs logging-service
```

### Tail logs in real time

```bash
# All services
docker compose -f docker/docker-compose.dev-test.yml -p op-dev-test logs -f

# Single service, last 50 lines then follow
docker compose -f docker/docker-compose.dev-test.yml -p op-dev-test logs -f --tail=50 gateway-service
```

### Filter logs by level (error/warn)

All services emit structured JSON logs. `warn` and `error` go to **stderr**; `debug` and `info` go to **stdout**. Use Docker's log filtering to isolate them:

```bash
# Errors and warnings only (stderr stream)
docker compose -f docker/docker-compose.dev-test.yml -p op-dev-test logs gateway-service 2>&1 | grep '"level":"error"'
docker compose -f docker/docker-compose.dev-test.yml -p op-dev-test logs gateway-service 2>&1 | grep -E '"level":"(error|warn)"'

# Pipe through jq for pretty output
docker compose -f docker/docker-compose.dev-test.yml -p op-dev-test logs gateway-service 2>&1 | grep '"level"' | jq -r '.level + " | " + .message'
```

### Change the minimum log level

Set `OP_LOG_LEVEL` in the service environment before starting the stack. Valid values: `debug`, `info`, `warn`, `error` (default: `info`).

```bash
OP_LOG_LEVEL=debug docker compose -f docker/docker-compose.dev-test.yml -p op-dev-test up gateway-service
```

### Vector-aggregated logs

Vector tails all Docker container JSON log files and writes parsed, structured logs to the `op-dev-test-log-data` named volume at `/var/log/oneplatform/<service_name>.log`. Each file is newline-delimited JSON.

```bash
# Exec into the vector container to read aggregated logs
docker exec -it op-dev-test-vector sh

# Inside the container:
ls /var/log/oneplatform/
tail -f /var/log/oneplatform/gateway-service.log
tail -f /var/log/oneplatform/auth-service.log

# Filter by level
grep '"level":"error"' /var/log/oneplatform/gateway-service.log | tail -20
```

### Query the Logging Service API

The Logging Service exposes a REST API via the gateway at `/api/v1/logs`. You need a valid JWT with `logs:read` scope or `admin` scope.

```bash
# Query latest logs (requires Bearer token)
curl -s http://127.0.0.1:4080/api/v1/logs \
  -H "Authorization: Bearer <your-jwt>" | jq .

# Filter by service
curl -s "http://127.0.0.1:4080/api/v1/logs?service=gateway-service&limit=50" \
  -H "Authorization: Bearer <your-jwt>" | jq .

# Filter by level
curl -s "http://127.0.0.1:4080/api/v1/logs?level=error&limit=100" \
  -H "Authorization: Bearer <your-jwt>" | jq .

# Filter by trace ID
curl -s "http://127.0.0.1:4080/api/v1/logs?traceId=<trace-id>" \
  -H "Authorization: Bearer <your-jwt>" | jq .

# Time range filter (ISO 8601)
curl -s "http://127.0.0.1:4080/api/v1/logs?from=2026-06-23T00:00:00Z&to=2026-06-24T00:00:00Z" \
  -H "Authorization: Bearer <your-jwt>" | jq .

# Export as JSONL (admin scope required)
curl -s "http://127.0.0.1:4080/api/v1/logs/export?from=2026-06-23T00:00:00Z&to=2026-06-24T00:00:00Z&format=jsonl" \
  -H "Authorization: Bearer <your-jwt>" > logs.jsonl

# Export as CSV
curl -s "http://127.0.0.1:4080/api/v1/logs/export?from=2026-06-23T00:00:00Z&to=2026-06-24T00:00:00Z&format=csv" \
  -H "Authorization: Bearer <your-jwt>" > logs.csv

# Fetch a single log event by ID
curl -s http://127.0.0.1:4080/api/v1/logs/<uuid> \
  -H "Authorization: Bearer <your-jwt>" | jq .

# Query audit events (audit:read or admin scope)
curl -s "http://127.0.0.1:4080/api/v1/audit-events?limit=50" \
  -H "Authorization: Bearer <your-jwt>" | jq .
```

---

## Common Issues

### CORS errors

**Symptom:** Browser console shows `CORS error` or the API returns `403 ORIGIN_NOT_ALLOWED`.

**How to diagnose:**

The CORS middleware returns a JSON body on rejection — the error is not a silent browser block.

```bash
# Check what origin is being rejected (look in gateway logs)
docker compose -f docker/docker-compose.dev-test.yml -p op-dev-test logs gateway-service 2>&1 | grep -i "ORIGIN_NOT_ALLOWED"

# Test CORS headers directly
curl -v -H "Origin: https://example.com" http://127.0.0.1:4080/healthz 2>&1 | grep -i "access-control"
```

**Relevant env var:** `OP_ALLOWED_ORIGINS` — comma-separated list of permitted origins.

```bash
# Check current setting
docker inspect op-dev-test-gateway | jq '.[0].Config.Env[] | select(startswith("OP_ALLOWED_ORIGINS"))'
```

**How to add an origin** — set `OP_ALLOWED_ORIGINS` before starting the stack:

```bash
OP_ALLOWED_ORIGINS="https://localhost:8443,https://myapp.example.com" \
  docker compose -f docker/docker-compose.dev-test.yml -p op-dev-test up -d
```

**Same-origin auto-detection:** requests where the `Origin` header host matches the `Host` request header are always allowed regardless of the allowlist. This covers the default Caddy → gateway path on `localhost`.

**Note:** requests without an `Origin` header (CLI tools, server SDK, curl without -H Origin) bypass CORS entirely — they still reach the API.

---

### Connection issues

**Check all service health at once:**

```bash
docker compose -f docker/docker-compose.dev-test.yml -p op-dev-test ps
```

**Check a specific service health endpoint:**

```bash
# Gateway (externally reachable)
curl -s http://127.0.0.1:4080/healthz | jq .

# Any service via exec
docker exec op-dev-test-auth wget -qO- http://localhost:3000/healthz
docker exec op-dev-test-ingestion wget -qO- http://localhost:3000/healthz
```

**Check PgBouncer connectivity:**

PgBouncer listens on port 5433 inside the container and uses `app_service_role` on database `oneplatform_app` as its health check user.

```bash
# Check PgBouncer health status
docker compose -f docker/docker-compose.dev-test.yml -p op-dev-test ps pgbouncer

# Check PgBouncer logs
docker compose -f docker/docker-compose.dev-test.yml -p op-dev-test logs pgbouncer

# Admin stats (from inside pgbouncer container)
docker exec -it op-dev-test-pgbouncer sh
# Then: psql -h localhost -p 5433 -U pgbouncer_admin -d pgbouncer
# SQL commands: SHOW POOLS; SHOW DATABASES; SHOW STATS; SHOW CLIENTS;
```

**Check Redis connectivity:**

```bash
# Health check
docker compose -f docker/docker-compose.dev-test.yml -p op-dev-test ps redis

# Connect with redis-cli
docker exec -it op-dev-test-redis sh
# Inside: redis-cli --user op_admin -a $(cat /data/init/redis_password_admin.txt | tr -d '[:space:]') ping

# Check revocation blocklist entries
# redis-cli> KEYS revocation:*
```

---

### Auth issues

**Check JWT token contents** (without verifying signature):

```bash
# Decode a JWT payload (base64 URL decode the middle segment)
echo "<your-jwt>" | cut -d. -f2 | base64 -d 2>/dev/null | jq .
```

**Check for a revoked token:**

```bash
# Get the jti from the decoded payload, then check Redis
docker exec op-dev-test-redis sh -c \
  'redis-cli --user op_admin -a $(cat /data/init/redis_password_admin.txt | tr -d "[:space:]") EXISTS revocation:<jti>'
```

**Check auth service logs for rejection reasons:**

```bash
docker compose -f docker/docker-compose.dev-test.yml -p op-dev-test logs auth-service 2>&1 | grep -E '"level":"(error|warn)"'
```

**Common auth error codes:**

| Code | Meaning |
|---|---|
| `UNAUTHORIZED` | Missing, expired, or invalid JWT / API key |
| `ORIGIN_NOT_ALLOWED` | CORS rejection (wrong origin) |
| `FORBIDDEN` | Valid token but insufficient scope |

Auth tokens carry `roles` and `scopes` claims. Unverified users (email not confirmed) are downgraded to `viewer` role and `[data:read, ontology:read, pipelines:read, apps:read, logs:read]` scopes regardless of what the token claims.

---

### Bootstrap / setup issues

**Check bootstrap status:**

```bash
curl -s http://127.0.0.1:4080/api/v1/bootstrap/status | jq .
# Response: { "completed": false, "bootstrapToken": "<64-hex-chars>" }
# or:        { "completed": true }
```

The `bootstrapToken` is returned in the status response before bootstrap completes, so the setup UI can read it without any credentials.

**Bootstrap token also appears in auth-service startup logs:**

```bash
docker compose -f docker/docker-compose.dev-test.yml -p op-dev-test logs auth-service 2>&1 | grep -i "bootstrap token"
```

**Reset bootstrap** (wipes bootstrap state from the database — for dev-test only):

```bash
# Connect to postgres and delete the bootstrap record
docker exec -it op-dev-test-postgres psql -U postgres -d oneplatform -c \
  "DELETE FROM auth.bootstrap_state;"

# Restart auth service to re-initialise
docker compose -f docker/docker-compose.dev-test.yml -p op-dev-test restart auth-service
```

---

## Distributed Tracing

### Access Jaeger UI

```
http://127.0.0.1:16687
```

Jaeger is bound to `127.0.0.1` only — not reachable from other machines on your network.

### Correlate requests across services using X-Request-ID

Every request gets a UUID v7 `X-Request-ID` assigned by the `requestIdMiddleware`. This ID is:
- Set on the request context (`c.var.requestId`)
- Echoed back in the `X-OnePlatform-Request-ID` response header
- Included in all structured log records

```bash
# Make a request and capture the request ID
curl -sv http://127.0.0.1:4080/api/v1/logs \
  -H "Authorization: Bearer <token>" 2>&1 | grep "X-OnePlatform-Request-ID"

# Then search logs for that ID
docker compose -f docker/docker-compose.dev-test.yml -p op-dev-test logs 2>&1 | grep "<request-id>"

# Or via the Logging Service API
curl -s "http://127.0.0.1:4080/api/v1/logs?traceId=<request-id>" \
  -H "Authorization: Bearer <token>" | jq .
```

### Use W3C trace IDs

The OTEL middleware propagates W3C `traceparent` headers (`00-<32hex-traceId>-<16hex-spanId>-01`). The `traceId` is also stored on `c.var.traceId` in every service.

```bash
# Pass a traceparent to trace a request end-to-end
curl -s http://127.0.0.1:4080/api/v1/logs \
  -H "Authorization: Bearer <token>" \
  -H "traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" \
  -v 2>&1 | grep -i "traceparent"
```

**In Jaeger:**
1. Open `http://127.0.0.1:16687`
2. Select a service from the dropdown (e.g. `gateway-service`)
3. Click **Find Traces**
4. Click a trace to see all spans across services
5. The `traceId` from the `traceparent` response header can be pasted directly into the Jaeger search bar

---

## Grafana Dashboards

### Access Grafana

```
http://127.0.0.1:3101
```

Default credentials (dev-test only): `admin` / `admin`

To change the password, set `OP_GRAFANA_PASSWORD` before starting the stack:

```bash
OP_GRAFANA_PASSWORD=mysecurepassword \
  docker compose -f docker/docker-compose.dev-test.yml -p op-dev-test up -d grafana
```

### Available dashboards

Two dashboards are provisioned automatically from `docker/grafana/provisioning/dashboards/json/`:

- **Platform Overview** (`platform-overview.json`) — top-level service health and request rates
- **Ingestion Dashboard** (`ingestion-dashboard.json`) — connector sync status and failure rates

Dashboards are read-only in the UI (edit the source JSON files and restart Grafana to apply changes, or wait up to 30 seconds for hot-reload).

### Configured datasource

| Name | Type | URL (internal) |
|---|---|---|
| Jaeger | Jaeger | `http://jaeger:16686` |

Prometheus is not deployed by default. The Grafana provisioning config has a commented-out block ready to enable it.

### Alerts

Three alert rules are provisioned from `docker/grafana/alerting/alert-rules.yml`:

| Alert | Condition | Severity |
|---|---|---|
| High Error Rate | >5% error spans on gateway-service in 5m | warning |
| Service Down (gateway) | 0 spans from gateway-service in 2m | critical |
| Auth Service Down | 0 spans from auth-service in 2m | critical |
| Sync Failure | >3 error spans on `sync.run` in ingestion-service in 5m | warning |

**Check alert state:**

```bash
# Grafana API — list firing alerts
curl -s http://admin:admin@127.0.0.1:3101/api/alertmanager/grafana/api/v2/alerts | jq .

# Or via the Grafana UI: Alerting → Alert rules
```

---

## Docker Debugging

### Exec into a container

```bash
# Application services use a minimal image — busybox sh is available
docker exec -it op-dev-test-gateway sh
docker exec -it op-dev-test-auth sh
docker exec -it op-dev-test-postgres bash

# Check environment variables inside a container
docker exec op-dev-test-gateway env | sort
```

### Check container health status

```bash
# All containers with health state
docker compose -f docker/docker-compose.dev-test.yml -p op-dev-test ps

# Detailed health output for a single container
docker inspect op-dev-test-gateway | jq '.[0].State.Health'

# Filter containers by the dev-test label
docker ps --filter "label=com.oneplatform.env=dev-test"
```

### Rebuild a specific service

```bash
# Rebuild and restart one service without touching others
docker compose -f docker/docker-compose.dev-test.yml -p op-dev-test up -d --build gateway-service

# Force a clean rebuild (no cache)
docker compose -f docker/docker-compose.dev-test.yml -p op-dev-test build --no-cache gateway-service
docker compose -f docker/docker-compose.dev-test.yml -p op-dev-test up -d gateway-service
```

### Check environment variables

```bash
# Print env for a running container
docker inspect op-dev-test-gateway | jq '.[0].Config.Env[]'

# Check a specific var
docker inspect op-dev-test-gateway | jq '.[0].Config.Env[] | select(startswith("OP_ALLOWED_ORIGINS"))'
docker inspect op-dev-test-gateway | jq '.[0].Config.Env[] | select(startswith("OTEL_"))'
```

### Stop and clean up the dev-test stack

```bash
# Stop all dev-test containers (data volumes preserved)
./docker/dev-test-stop.sh
# or manually:
docker compose -f docker/docker-compose.dev-test.yml -p op-dev-test down

# Full teardown including volumes (destroys all data)
docker compose -f docker/docker-compose.dev-test.yml -p op-dev-test down -v
```

---

## Database Debugging

All application services connect through **PgBouncer on port 5433** — never directly to PostgreSQL on port 5432. Each service has its own database and role (see `docker/pgbouncer/pgbouncer.ini`).

### PgBouncer database → role mapping

| Database | Role | Pool mode | Pool size |
|---|---|---|---|
| `oneplatform_gateway` | `gateway_service_role` | transaction | 15 |
| `oneplatform_auth` | `auth_service_role` | transaction | 20 |
| `oneplatform_ingestion` | `ingestion_service_role` | transaction | 25 |
| `oneplatform_app` | `app_service_role` | transaction | 15 |
| `oneplatform_logging` | `logging_service_role` | **session** | 30 |
| `oneplatform_plugin` | `plugin_service_role` | transaction | 10 |
| `oneplatform_execution` | `execution_service_role` | transaction | 10 |
| `oneplatform_ontology` | `ontology_service_role` | **session** | 15 |
| `oneplatform_pipeline` | `pipeline_service_role` | **session** | 25 |

Logging, Ontology, and Pipeline use **session mode** because they rely on advisory locks and `LISTEN`/`NOTIFY`. Placing them in transaction mode would break these features with `prepared statement requires 0 parameters` errors.

### Connect to PostgreSQL directly (host)

```bash
# Superuser access (host port 5532 → container 5432)
psql -h 127.0.0.1 -p 5532 -U postgres -d oneplatform

# Or via exec
docker exec -it op-dev-test-postgres psql -U postgres -d oneplatform
```

### Connect through PgBouncer (as a service would)

The per-service passwords are generated by `op-init` and stored in the `op-dev-test-init-data` volume under `/data/init/db_password_<role>.txt`. Read them from the pgbouncer container:

```bash
# Read the app service password
docker exec op-dev-test-pgbouncer cat /data/init/db_password_app.txt

# Connect as app_service_role through PgBouncer
PASS=$(docker exec op-dev-test-pgbouncer cat /data/init/db_password_app.txt | tr -d '[:space:]')
docker exec -it op-dev-test-pgbouncer psql -h localhost -p 5433 -U app_service_role -d oneplatform_app
```

### Useful queries

```sql
-- Check all tables (connected as postgres to the main db)
\dt auth.*
\dt gateway.*
\dt logging.*

-- Check bootstrap state
SELECT * FROM auth.bootstrap_state;

-- Check tenants
SELECT id, name, created_at FROM auth.tenants ORDER BY created_at DESC LIMIT 10;

-- Check users
SELECT id, email, email_verified, created_at FROM auth.users ORDER BY created_at DESC LIMIT 10;

-- Check recent log events (as logging_service_role)
SELECT id, service, level, message, created_at
FROM logging.log_events
ORDER BY created_at DESC
LIMIT 20;

-- Check for failed audit events
SELECT * FROM logging.audit_events WHERE result = 'failure' ORDER BY created_at DESC LIMIT 20;

-- PgBouncer admin console (from inside pgbouncer container)
-- psql -h localhost -p 5433 -U pgbouncer_admin -d pgbouncer
SHOW POOLS;       -- connection pool status
SHOW DATABASES;   -- database list and stats
SHOW STATS;       -- query rate and latency
SHOW CLIENTS;     -- connected clients
```

---

## Network Debugging

### Check Caddy configuration

The active Caddyfile is selected at startup by `OP_TLS_MODE`:

| `OP_TLS_MODE` | Caddyfile used | Notes |
|---|---|---|
| `off` (default dev-test) | `Caddyfile.nossl` | Plain HTTP on :80, no TLS |
| `internal` | `Caddyfile.dev` | Self-signed cert via Caddy internal CA |
| `acme` | `Caddyfile.prod.template` | Let's Encrypt ACME |

```bash
# Check which TLS mode is active
docker inspect op-dev-test-caddy | jq '.[0].Config.Env[] | select(startswith("OP_TLS_MODE"))'

# View Caddy logs (JSON structured)
docker compose -f docker/docker-compose.dev-test.yml -p op-dev-test logs caddy

# When using OP_TLS_MODE=internal, import the Caddy root CA to suppress browser warnings:
docker compose -f docker/docker-compose.dev-test.yml -p op-dev-test cp \
  caddy:/data/caddy/pki/authorities/local/root.crt /tmp/caddy-root.crt

# macOS
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain /tmp/caddy-root.crt

# Ubuntu/Debian
sudo cp /tmp/caddy-root.crt /usr/local/share/ca-certificates/caddy-root.crt && sudo update-ca-certificates
```

### Test endpoints with curl

```bash
# Health check via Caddy (public entry point)
curl -s http://localhost:8088/healthz | jq .

# Health check directly on gateway (bypass Caddy)
curl -s http://127.0.0.1:4080/healthz | jq .

# Readiness probe (checks DB + Redis connectivity)
curl -s http://127.0.0.1:4080/readyz | jq .

# API via Caddy
curl -s http://localhost:8088/api/v1/bootstrap/status | jq .

# API directly on gateway
curl -s http://127.0.0.1:4080/api/v1/bootstrap/status | jq .

# Test with an API key
curl -s http://127.0.0.1:4080/api/v1/logs \
  -H "X-API-Key: <your-api-key>" | jq .
```

### Check CORS response headers

```bash
# Preflight (OPTIONS) — should return 204 with CORS headers
curl -sv -X OPTIONS http://127.0.0.1:4080/api/v1/logs \
  -H "Origin: https://localhost:8443" \
  -H "Access-Control-Request-Method: GET" \
  2>&1 | grep -i "access-control"

# Actual request — CORS headers should appear on the response
curl -sv http://127.0.0.1:4080/api/v1/bootstrap/status \
  -H "Origin: https://localhost:8443" \
  2>&1 | grep -i "access-control"

# Test an origin NOT in the allowlist — expect 403 ORIGIN_NOT_ALLOWED
curl -s http://127.0.0.1:4080/api/v1/bootstrap/status \
  -H "Origin: https://evil.example.com" | jq .
```

### Check inter-service connectivity

All services communicate on the `op-dev-test-internal` bridge network. Service names resolve using Docker DNS.

```bash
# From inside the gateway container, ping another service
docker exec op-dev-test-gateway wget -qO- http://op-dev-test-auth:3000/healthz

# Check which networks a container is on
docker inspect op-dev-test-gateway | jq '.[0].NetworkSettings.Networks | keys'
```

---

## Quick Start Diagnostics

Run this sequence to get a fast picture of stack health:

```bash
# 1. Check which containers are running/unhealthy
docker compose -f docker/docker-compose.dev-test.yml -p op-dev-test ps

# 2. Check bootstrap status (no auth required)
curl -s http://127.0.0.1:4080/api/v1/bootstrap/status | jq .

# 3. Check gateway readiness (tests DB + Redis round-trip)
curl -s http://127.0.0.1:4080/readyz | jq .

# 4. Pull recent errors from all services
docker compose -f docker/docker-compose.dev-test.yml -p op-dev-test logs --tail=100 2>&1 | grep '"level":"error"'

# 5. Open Jaeger to see traces
open http://127.0.0.1:16687   # macOS
xdg-open http://127.0.0.1:16687  # Linux

# 6. Open Grafana
open http://127.0.0.1:3101    # macOS (admin/admin)
xdg-open http://127.0.0.1:3101   # Linux
```
