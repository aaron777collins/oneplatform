# OnePlatform Operations Guide

Day-to-day operations reference for the OnePlatform Docker Compose stack. This
guide assumes the platform is already running. For initial setup, see
[DEPLOYMENT.md](DEPLOYMENT.md).

**2am incident? Jump to the section you need:**

| Problem | Section |
|---|---|
| Service down / won't start | [Service Management](#1-service-management) |
| Health check failing | [Health Monitoring](#2-health-monitoring) |
| Database errors / connection pool exhausted | [Database Operations](#3-database-operations) |
| Redis errors / queue stalled | [Redis Operations](#4-redis-operations) / [Queue Management](#9-queue-management) |
| Disk full / storage issues | [Object Storage](#5-object-storage) |
| Secret rotation needed | [Secret Management](#6-secret-management) |
| High load / OOM | [Scaling](#7-scaling) |
| Need to search logs | [Log Management](#8-log-management) |

All `docker compose` commands must be run from the repo root where
`docker/docker-compose.yml` lives, or use the `-f` flag explicitly:

```bash
# Shorthand used throughout this guide — set once in your shell
export COMPOSE="docker compose -f /path/to/oneplatform/docker/docker-compose.yml"
```

---

## 1. Service Management

### Stack layout

| Layer | Services | Networks | Host ports |
|---|---|---|---|
| 0 — Init | `op-init` (one-shot) | none | none |
| 1 — Data stores | `postgres`, `redis`, `minio`, `docker-socket-proxy` | `oneplatform-internal` | none |
| 2 — Pooler | `pgbouncer` | `oneplatform-internal` | none |
| 3 — App services | `gateway`, `auth`, `ingestion`, `ontology`, `pipeline`, `execution`, `app`, `logging`, `plugin` | `oneplatform-internal` | none |
| 4 — Frontend | `frontend` | `oneplatform-internal` | none |
| 5 — TLS proxy | `caddy` | `oneplatform-internal` + `oneplatform-public` | `80:80`, `443:443` |

Only `caddy` binds host ports (80 and 443). `gateway-service` and `frontend`
are internal-only — they communicate via the `oneplatform-internal` bridge
and are reached exclusively through Caddy. All internal service-to-service
traffic stays on the isolated `oneplatform-internal` bridge
(`internal: true` — not routable from the host).

### Start / stop the entire stack

```bash
# Start everything in the background
docker compose -f docker/docker-compose.yml up -d

# Stop everything (keeps volumes)
docker compose -f docker/docker-compose.yml down

# Stop and remove all volumes (DESTRUCTIVE — wipes all data)
docker compose -f docker/docker-compose.yml down -v
```

### Start / stop individual services

```bash
# Restart one service without touching the rest
docker compose -f docker/docker-compose.yml restart gateway-service

# Stop a single service
docker compose -f docker/docker-compose.yml stop ingestion-service

# Start it again
docker compose -f docker/docker-compose.yml start ingestion-service

# Force-recreate a single service (picks up config changes)
docker compose -f docker/docker-compose.yml up -d --no-deps --force-recreate ontology-service
```

### View status

```bash
# Quick health overview — shows State and Health columns
docker compose -f docker/docker-compose.yml ps

# Show resource usage (CPU, memory, net I/O)
docker stats --no-stream \
  gateway-service auth-service ingestion-service ontology-service \
  pipeline-service execution-service app-service logging-service plugin-service
```

Expected healthy output from `ps`:

```
NAME                  IMAGE       SERVICE            CREATED   STATUS                    PORTS
caddy                 ...         caddy              ...       Up X minutes (healthy)    0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp
gateway-service       ...         gateway-service    ...       Up X minutes (healthy)
auth-service          ...         auth-service       ...       Up X minutes (healthy)
...
```

Note that `gateway-service` and `frontend` show no host port binding — they are
accessed only through Caddy.

Any service showing `(unhealthy)` or `(health: starting)` past its
`start_period` needs investigation.

### View logs

```bash
# Tail one service
docker compose -f docker/docker-compose.yml logs -f gateway-service

# Tail multiple services simultaneously
docker compose -f docker/docker-compose.yml logs -f auth-service ingestion-service

# Last 200 lines, no follow
docker compose -f docker/docker-compose.yml logs --tail=200 execution-service

# All services since a point in time
docker compose -f docker/docker-compose.yml logs --since 1h
```

Log rotation is configured per-service in `docker/docker-compose.yml`
(`x-service-common`):

```yaml
logging:
  driver: "json-file"
  options:
    max-size: "50m"
    max-file: "5"
```

Each service retains up to 250 MB of raw logs on disk (5 files × 50 MB).
Vector aggregates these into structured JSON at `/var/log/oneplatform/` on the
`log-data` volume — see [Log Management](#8-log-management).

### Graceful restart procedure (zero-config-change restart)

```bash
# 45-second stop grace period is set on all services (stop_grace_period: 45s).
# This lets in-flight requests complete before the process is killed.
docker compose -f docker/docker-compose.yml restart <service-name>
```

### Apply a configuration change (.env change)

```bash
# Edit .env, then recreate only the affected service
docker compose -f docker/docker-compose.yml up -d --no-deps <service-name>
```

The service-entrypoint reads secrets from the `init-data` volume at startup, not
from `.env`. `.env` only controls the environment variables listed in the
`environment:` block of `docker/docker-compose.yml`. Secret changes (JWT,
master key, etc.) require the secret rotation procedure in
[Secret Management](#6-secret-management).

---

## 2. Health Monitoring

Every application service exposes two HTTP endpoints on its internal port 3000:

| Endpoint | Purpose | Expected response |
|---|---|---|
| `GET /healthz` | Liveness — is the process alive? | `200 OK` |
| `GET /readyz` | Readiness — is the service ready to serve traffic? | `200 OK` |

Docker Compose polls `/healthz` every 10 seconds with a 5-second timeout and
5 retries before marking the container unhealthy. The `start_period` is 20
seconds for app services, allowing time for Node.js startup and DB migrations.

### Check health from the host (via Caddy)

```bash
# Caddy is the only service with host port bindings — reach the gateway through it.
# Use -k (--insecure) in development if using Caddy's self-signed certificate.
curl -sk https://localhost/healthz
# Expected: {"status":"ok"}

curl -sk https://localhost/readyz
# Expected: {"status":"ready"}
```

### Check health of internal services

Because all application services are on `oneplatform-internal` (not reachable from the
host), exec into a container on the same network:

```bash
# Check auth-service health from within the gateway container
docker compose -f docker/docker-compose.yml exec gateway-service \
  wget -qO- http://auth-service:3000/healthz
# Expected: {"status":"ok"}

# Or check directly inside the target container
docker compose -f docker/docker-compose.yml exec auth-service \
  wget -qO- http://localhost:3000/healthz

# Internal checks always use http:// and port 3000 — TLS is terminated at Caddy,
# not between internal services.
```

### Infrastructure health checks

```bash
# PostgreSQL — pg_isready via pgbouncer (port 5433)
docker compose -f docker/docker-compose.yml exec pgbouncer \
  pg_isready -h localhost -p 5433
# Expected: localhost:5433 - accepting connections

# Redis
REDIS_ADMIN_PW=$(docker compose -f docker/docker-compose.yml exec -T redis \
  cat /data/init/redis_password_admin.txt | tr -d '[:space:]')
docker compose -f docker/docker-compose.yml exec redis \
  redis-cli --user op_admin -a "$REDIS_ADMIN_PW" PING
# Expected: PONG

# MinIO
docker compose -f docker/docker-compose.yml exec minio \
  curl -sf http://localhost:9000/minio/health/live
# Expected: (empty body, HTTP 200)
```

### Automated monitoring integration

The `/healthz` endpoint on each service returns JSON. For uptime monitoring
systems (UptimeRobot, Pingdom, Prometheus Blackbox Exporter), monitor through
Caddy:

```
https://<domain>/healthz   — HTTP 200 means Caddy and gateway are both up
https://<domain>/          — HTTP 200 means Caddy and frontend are both up
```

For internal health checks (e.g., from within the Docker network), use the
service hostname directly without TLS:

```
http://gateway-service:3000/healthz   — internal-only, via Docker network
```

For Prometheus scraping, add a Blackbox Exporter target per-service by exec'ing
into the `oneplatform-internal` network or by temporarily enabling the debug
port mapping commented out in `docker/docker-compose.yml` (127.0.0.1 only).

---

## 3. Database Operations

### Connection architecture

```
App Service → PgBouncer :5433 → PostgreSQL :5432
              (oneplatform_<service> alias)
              per-service DB role
              per-service schema
```

PgBouncer is configured in `docker/pgbouncer/pgbouncer.ini`. Each service has
its own database alias, role, and password — see `docker/init/init.sh` for the
naming convention.

**Pool modes** (critical distinction):

| Service | Pool mode | Reason |
|---|---|---|
| gateway, auth, ingestion, app, logging, plugin, execution | transaction | Connections returned after each transaction — most efficient |
| ontology, pipeline | **session** | These services use advisory locks (`SELECT pg_advisory_lock()`) and `LISTEN/NOTIFY`, which require a persistent connection |

If you ever move ontology or pipeline to transaction mode, advisory locks will
silently break across connection reuse.

### PgBouncer monitoring

Connect to the PgBouncer admin console:

```bash
# Read the admin password
PGB_ADMIN_PW=$(docker compose -f docker/docker-compose.yml exec -T postgres \
  cat /data/init/db_password_pgbouncer_admin.txt 2>/dev/null | tr -d '[:space:]')

# Open the admin console (psql inside the pgbouncer container)
docker compose -f docker/docker-compose.yml exec pgbouncer \
  psql -h localhost -p 5433 -U pgbouncer_admin pgbouncer
```

Useful commands inside the console:

```sql
-- Overall pool statistics
SHOW STATS;

-- Per-pool connection state
SHOW POOLS;
-- Key columns:
--   cl_active:  clients currently executing queries
--   cl_waiting: clients waiting for a server connection (bad if non-zero and growing)
--   sv_active:  server connections in use
--   sv_idle:    server connections idle in pool
--   sv_used:    server connections used but not yet returned
--   maxwait:    seconds the oldest waiting client has been waiting

-- List databases and their current pool sizes
SHOW DATABASES;

-- Active client connections
SHOW CLIENTS;

-- Server connections
SHOW SERVERS;

-- Configuration
SHOW CONFIG;
```

Healthy pool example:

```
 database             | cl_active | cl_waiting | sv_active | sv_idle | maxwait
 oneplatform_auth     |         2 |          0 |         2 |        8|       0
 oneplatform_logging  |         5 |          0 |         5 |       15|       0
```

**Warning signs:**
- `cl_waiting > 0` and `maxwait > 1`: pool exhausted, consider raising `pool_size` in `docker/pgbouncer/pgbouncer.ini`
- `sv_used` growing without returning: connection leak in service code

### Running queries directly

```bash
# Superuser access (use sparingly — prefer per-service roles)
docker compose -f docker/docker-compose.yml exec postgres \
  psql -U postgres -d oneplatform

# Per-service role via PgBouncer (as the service would connect)
SERVICE=auth
DB_PW=$(docker compose -f docker/docker-compose.yml exec -T postgres \
  cat /data/init/db_password_${SERVICE}.txt | tr -d '[:space:]')
docker compose -f docker/docker-compose.yml exec pgbouncer \
  psql "postgres://${SERVICE}_service_role:${DB_PW}@localhost:5433/oneplatform_${SERVICE}"
```

### Per-service schema isolation

Each service operates in its own PostgreSQL schema (e.g. `auth`, `ingestion`,
`ontology`). The service role only has privileges on its own schema.

```sql
-- List all service schemas
\dn

-- Inspect objects in a specific schema
SET search_path TO auth;
\dt    -- tables
\dv    -- views
\df    -- functions
```

### Running manual migrations

Migrations are applied automatically at service startup. To re-run or check
migration state manually:

```bash
# Check current migration state (example for auth service)
docker compose -f docker/docker-compose.yml exec postgres \
  psql -U postgres -d oneplatform \
  -c "SELECT id, name, executed_at FROM auth.schema_migrations ORDER BY executed_at DESC LIMIT 10;"

# If a migration is stuck, check ontology-service logs first
docker compose -f docker/docker-compose.yml logs --tail=100 ontology-service

# Force re-run a migration (rare — understand the migration before doing this)
docker compose -f docker/docker-compose.yml exec postgres \
  psql -U postgres -d oneplatform \
  -c "DELETE FROM auth.schema_migrations WHERE id = '<migration-id>';"
# Then restart the service to re-apply
docker compose -f docker/docker-compose.yml restart auth-service
```

The ontology service uses advisory locks via PgBouncer session mode to prevent
concurrent migrations. If a migration appears stuck, check for orphaned advisory
locks:

```sql
-- Check for held advisory locks
SELECT pid, usename, granted, classid, objid
FROM pg_locks
JOIN pg_stat_activity USING (pid)
WHERE locktype = 'advisory';

-- Terminate a specific blocking connection (replace <pid>)
SELECT pg_terminate_backend(<pid>);
```

### Backup and restore

```bash
# Full backup (Postgres + MinIO + Redis)
./docker/scripts/backup.sh ./backups

# Restore from a backup
# restore.sh does NOT stop application services automatically — you must stop
# them first to prevent writes during restore.
docker compose -f docker/docker-compose.yml stop \
  caddy frontend \
  gateway-service auth-service ingestion-service ontology-service \
  pipeline-service execution-service app-service logging-service plugin-service
./docker/scripts/restore.sh ./backups/20260617_020000 --yes
docker compose -f docker/docker-compose.yml up -d \
  gateway-service auth-service ingestion-service ontology-service \
  pipeline-service execution-service app-service logging-service plugin-service \
  frontend caddy
```

See `docker/scripts/backup.sh` and `docker/scripts/restore.sh` for full details.

---

## 4. Redis Operations

### Key namespace per service

Each service has its own ACL user (`op_<service>`) with access restricted to its
key prefixes (defined in `docker/redis/users.acl.template`):

| ACL user | Key prefixes | Pub/Sub channels |
|---|---|---|
| `op_auth` | `auth:*`, `revocation:*`, `reset:*`, `bull:auth:*` | `auth:*`, `revocation:*` |
| `op_gateway` | `ratelimit:*`, `gateway:*`, `webhook:*` | `events:*` |
| `op_ingestion` | `queue:ingestion:*`, `ingestion:sync:*`, `bull:ingestion:*`, `bull:queue:ingestion:*` | `ontology:*` |
| `op_ontology` | `ontology:*` | `ontology:*` |
| `op_pipeline` | `queue:pipeline:*`, `queue:execution:*`, `bull:queue:pipeline:*`, `bull:queue:execution:*` | `ontology:*` |
| `op_execution` | `execution:*` | `execution:*` |
| `op_app` | `guest-session:*`, `rate:guest-session:*`, `app:*`, `bff:*`, `bull:app:*`, `bull:queue:app:*` | `events:*`, `app:*` |
| `op_logging` | `log:*`, `audit:*`, `bull:audit:*`, `bull:log:*` | `logs:*`, `audit:*` |
| `op_plugin` | `plugin:*`, `bull:plugin:*` | `events:*` |

Service ACL users (`op_auth`, `op_gateway`, etc.) are denied `FLUSHDB`, `FLUSHALL`,
`KEYS`, and `DEBUG`. The `op_admin` user has `+@all` (full access) and can
execute `FLUSHALL` — use it only in an explicit data-wipe scenario such as a clean
reinstall.

### Connect as op_admin

```bash
REDIS_ADMIN_PW=$(docker compose -f docker/docker-compose.yml exec -T redis \
  cat /data/init/redis_password_admin.txt | tr -d '[:space:]')
docker compose -f docker/docker-compose.yml exec redis \
  redis-cli --user op_admin -a "$REDIS_ADMIN_PW"
```

### Memory monitoring

```bash
# Memory summary
docker compose -f docker/docker-compose.yml exec redis \
  redis-cli --user op_admin -a "$REDIS_ADMIN_PW" INFO memory

# Key fields to watch:
#   used_memory_human:       current allocation
#   used_memory_peak_human:  historical peak
#   maxmemory_human:         hard limit (256mb, set in docker/redis/redis.conf)
#   maxmemory_policy:        allkeys-lru
#   mem_fragmentation_ratio: >1.5 indicates fragmentation; consider MEMORY PURGE

# Overall server info
docker compose -f docker/docker-compose.yml exec redis \
  redis-cli --user op_admin -a "$REDIS_ADMIN_PW" INFO server

# Connected clients
docker compose -f docker/docker-compose.yml exec redis \
  redis-cli --user op_admin -a "$REDIS_ADMIN_PW" CLIENT LIST
```

Redis is configured with `maxmemory 256mb` and `maxmemory-policy allkeys-lru`.
When memory is tight:

- **Rate limit counters** (`ratelimit:*`) are safe to evict — they regenerate on
  the next request.
- **Auth tokens** (`auth:*`) and **revocation lists** (`revocation:*`) must not
  be evicted. If token volume is high, raise `maxmemory` in
  `docker/redis/redis.conf` and update the matching Docker resource limit in
  `docker/docker-compose.yml`.

### Inspect keys for a service

```bash
# Use SCAN, never KEYS — KEYS blocks Redis on large datasets
# Count keys matching a prefix (op_admin only)
docker compose -f docker/docker-compose.yml exec redis \
  redis-cli --user op_admin -a "$REDIS_ADMIN_PW" \
  --scan --pattern "auth:*" | wc -l

# Inspect a specific key
docker compose -f docker/docker-compose.yml exec redis \
  redis-cli --user op_admin -a "$REDIS_ADMIN_PW" \
  TYPE auth:session:abc123
# then: GET / HGETALL / LRANGE / SMEMBERS depending on type
```

### Clearing stale keys (targeted — never FLUSHALL)

```bash
# Delete all keys matching a pattern safely with SCAN + DEL
docker compose -f docker/docker-compose.yml exec redis \
  redis-cli --user op_admin -a "$REDIS_ADMIN_PW" \
  --scan --pattern "ratelimit:*" | xargs -r \
  docker compose -f docker/docker-compose.yml exec -T redis \
  redis-cli --user op_admin -a "$REDIS_ADMIN_PW" DEL
```

Avoid `FLUSHDB` or `FLUSHALL` in normal operations — they wipe all data in the
database or the entire Redis instance. Service users (`op_auth`, `op_gateway`, etc.)
are ACL-denied these commands. `op_admin` can execute them. To wipe all data for a
clean reinstall, stop Redis and remove the `redis-data` Docker volume — that is
safer than FLUSHALL because it also clears the AOF and RDB files.

### Reload ACL without restart

If you modify `docker/redis/users.acl.template` and re-render the ACL file, you
can hot-reload without a Redis restart:

```bash
# After re-rendering /tmp/users.acl inside the container:
docker compose -f docker/docker-compose.yml exec redis \
  redis-cli --user op_admin -a "$REDIS_ADMIN_PW" ACL LOAD
# Expected: OK

# Verify the reloaded ACL
docker compose -f docker/docker-compose.yml exec redis \
  redis-cli --user op_admin -a "$REDIS_ADMIN_PW" ACL LIST
```

Note: `ACL LOAD` reads from the `aclfile` path configured in
`docker/redis/redis.conf` (`/etc/redis/users.acl`). The redis-entrypoint writes
the rendered file to `/tmp/users.acl` and passes it via `--aclfile` on the
command line — so after a restart the rendered path is authoritative.

---

## 5. Object Storage

MinIO stores connector artifacts, execution outputs, and app assets. It runs
on the `oneplatform-internal` network; the MinIO Console is not exposed to the
host by default.

### Access the MinIO Console

The MinIO Console listens on port 9001 inside the container. To access it,
temporarily port-forward:

```bash
docker compose -f docker/docker-compose.yml exec minio \
  sh -c 'echo $MINIO_ROOT_USER'   # confirm username

# Forward from host (adjust host port as needed)
# Add to docker-compose.yml ports: section temporarily:
#   - "127.0.0.1:9001:9001"
# Then open http://localhost:9001 in your browser
```

### Use mc (MinIO Client) from the host

```bash
# Install mc: https://min.io/docs/minio/linux/reference/minio-mc.html
mc alias set op http://localhost:9000 "$OP_MINIO_USER" "$OP_MINIO_PASSWORD"

# List all buckets
mc ls op

# Check storage usage per bucket
mc du op

# Storage usage across all buckets
mc admin info op
```

### Bucket management

```bash
# List buckets
mc ls op

# Create a bucket (normally done by service initialization)
mc mb op/my-bucket

# Check object count and total size
mc du op/bucket-name

# List objects with metadata
mc ls --recursive op/bucket-name | head -50
```

### Lifecycle policies (retention)

```bash
# Set a 90-day expiry on execution artifacts
mc ilm add --expiry-days 90 op/execution-artifacts

# View current lifecycle rules
mc ilm ls op/execution-artifacts

# Remove a lifecycle rule
mc ilm rm --id <rule-id> op/execution-artifacts
```

### Storage usage monitoring

```bash
# Overall storage used on the MinIO data volume
docker system df -v | grep minio-data

# Or inspect the volume directly
docker volume inspect oneplatform_minio-data
```

If MinIO is approaching disk capacity, lifecycle policies or manual cleanup of
old execution artifacts are the first levers. For high-volume deployments,
replace the local MinIO with an S3-compatible service — update `OP_MINIO_USER`,
`OP_MINIO_PASSWORD`, and add `OP_MINIO_ENDPOINT` to `.env`.

---

## 6. Secret Management

All secrets are generated by `op-init` at first run and written to the
`init-data` volume at `/data/init/`. Services read them via
`docker/service-entrypoint.sh`. The secret files are mode `0400` inside the
volume.

### Secret inventory

| File in `/data/init/` | Purpose | Used by |
|---|---|---|
| `master.key` | AES-256-GCM master encryption key (base64) | All services |
| `jwt.secret` | HS256 JWT signing secret (hex) | auth-service |
| `cursor.secret` | HMAC-SHA256 cursor signing secret (hex) | All services |
| `bootstrap.token` | One-time bootstrap token (hex, deleted after use) | auth-service |
| `db_password_<service>.txt` | PostgreSQL role password per service | Each service, pgbouncer |
| `db_password_pgbouncer_admin.txt` | PgBouncer admin password | pgbouncer |
| `db_password_pgbouncer_stats.txt` | PgBouncer stats password | pgbouncer |
| `db_password_postgres_superuser.txt` | PostgreSQL superuser password | postgres container |
| `redis_password_<user>.txt` | Redis ACL user password | Each service, redis |
| `keys/<service-name>/private.pem` | Ed25519 private key for service tokens | Issuing service |
| `/data/service-keys/<service-name>.pub` | Ed25519 public key for token verification | All receiving services |

### Ed25519 key rotation

Service-to-service JWTs are signed with per-service Ed25519 keys. Rotate when
a private key is suspected compromised or per your security policy.

```bash
SERVICE_NAME="auth-service"   # replace with target service

# 1. Generate new key pair into the init-data volume
docker compose -f docker/docker-compose.yml run --rm -v oneplatform_init-data:/data/init \
  alpine sh -c "
    apk add --no-cache openssl &&
    openssl genpkey -algorithm Ed25519 \
      -out /data/init/keys/${SERVICE_NAME}/private.pem.new &&
    chmod 0400 /data/init/keys/${SERVICE_NAME}/private.pem.new
  "

# 2. Derive and publish the new public key immediately so receivers can verify
#    both old and new tokens during the rollover window
docker compose -f docker/docker-compose.yml run --rm \
  -v oneplatform_init-data:/data/init \
  -v oneplatform_shared-pubkeys:/data/service-keys \
  alpine sh -c "
    apk add --no-cache openssl &&
    openssl pkey \
      -in /data/init/keys/${SERVICE_NAME}/private.pem.new \
      -pubout \
      -out /data/service-keys/${SERVICE_NAME}.pub.new &&
    chmod 0444 /data/service-keys/${SERVICE_NAME}.pub.new
  "

# 3. Atomically swap in the new keys
docker compose -f docker/docker-compose.yml run --rm \
  -v oneplatform_init-data:/data/init \
  -v oneplatform_shared-pubkeys:/data/service-keys \
  alpine sh -c "
    mv /data/init/keys/${SERVICE_NAME}/private.pem.new \
       /data/init/keys/${SERVICE_NAME}/private.pem &&
    mv /data/service-keys/${SERVICE_NAME}.pub.new \
       /data/service-keys/${SERVICE_NAME}.pub
  "

# 4. Restart the issuing service to load the new private key
docker compose -f docker/docker-compose.yml restart ${SERVICE_NAME}

# 5. Restart all receiving services so they reload public keys from the volume
#    (can be done rolling if you have multiple replicas behind a load balancer)
docker compose -f docker/docker-compose.yml restart \
  gateway-service auth-service ingestion-service ontology-service \
  pipeline-service execution-service app-service logging-service plugin-service
```

### JWT secret rotation

Rotating `jwt.secret` invalidates all active user sessions immediately.
Schedule this during a maintenance window or accept the forced logout.

```bash
# 1. Generate and write new secret
docker compose -f docker/docker-compose.yml run --rm \
  -v oneplatform_init-data:/data/init \
  alpine sh -c "
    openssl rand -hex 32 > /data/init/jwt.secret.new &&
    chmod 0400 /data/init/jwt.secret.new &&
    mv /data/init/jwt.secret.new /data/init/jwt.secret
  "

# 2. Restart auth-service to pick up the new secret (all services read jwt.secret at startup)
docker compose -f docker/docker-compose.yml restart auth-service

# 3. Restart all other services that validate JWTs
docker compose -f docker/docker-compose.yml restart \
  gateway-service ingestion-service ontology-service pipeline-service \
  execution-service app-service logging-service plugin-service
```

All active user sessions are invalidated when `jwt.secret` changes. Users will
need to log in again.

### Master key rotation

The master key encrypts sensitive data at rest (connector credentials, API keys,
etc.). Rotation requires re-encrypting all data encrypted with the old key.

**Warning:** This is a maintenance operation. Stop all application services
before rotating to prevent partial reads with the old key.

```bash
# 1. Stop application services
docker compose -f docker/docker-compose.yml stop \
  gateway-service auth-service ingestion-service ontology-service \
  pipeline-service execution-service app-service logging-service plugin-service

# 2. Back up current data before any rotation
./docker/scripts/backup.sh ./backups/pre-master-key-rotation

# 3. Generate a new master key
docker compose -f docker/docker-compose.yml run --rm \
  -v oneplatform_init-data:/data/init \
  alpine sh -c "
    openssl rand -base64 32 > /data/init/master.key.new &&
    chmod 0400 /data/init/master.key.new
  "

# 4. Run the re-encryption migration (this command is service-specific — check
#    the service's migration scripts for the exact invocation)
#    Example for auth-service:
docker compose -f docker/docker-compose.yml run --rm \
  -v oneplatform_init-data:/data/init \
  -v oneplatform_shared-pubkeys:/data/service-keys \
  auth-service \
  node dist/cli.js re-encrypt \
    --old-key-file /data/init/master.key \
    --new-key-file /data/init/master.key.new

# 5. Swap in the new key
docker compose -f docker/docker-compose.yml run --rm \
  -v oneplatform_init-data:/data/init \
  alpine sh -c "mv /data/init/master.key.new /data/init/master.key"

# 6. Restart services
docker compose -f docker/docker-compose.yml up -d \
  gateway-service auth-service ingestion-service ontology-service \
  pipeline-service execution-service app-service logging-service plugin-service
```

### Bootstrap token lifecycle

The bootstrap token is a one-time secret used during first-run setup. The auth
service deletes `bootstrap.token` from the volume after it is consumed. If you
need to re-run bootstrap (e.g., after wiping the database):

```bash
# Regenerate the bootstrap token
docker compose -f docker/docker-compose.yml run --rm \
  -v oneplatform_init-data:/data/init \
  alpine sh -c "
    openssl rand -hex 32 > /data/init/bootstrap.token &&
    chmod 0400 /data/init/bootstrap.token
  "

# Restart auth-service to pick up the new token
docker compose -f docker/docker-compose.yml restart auth-service
```

The bootstrap token file is intentionally absent once bootstrap completes
(`service-entrypoint.sh` exports an empty string if the file is missing — this
is expected normal operation, not an error).

### Database password rotation

```bash
SERVICE=auth   # replace with target service

# 1. Generate new password
NEW_PW=$(LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 32)

# 2. Write to init-data volume
docker compose -f docker/docker-compose.yml run --rm \
  -v oneplatform_init-data:/data/init \
  alpine sh -c "printf '%s' '$NEW_PW' > /data/init/db_password_${SERVICE}.txt && chmod 0400 /data/init/db_password_${SERVICE}.txt"

# 3. Update the PostgreSQL role
docker compose -f docker/docker-compose.yml exec postgres \
  psql -U postgres -d oneplatform \
  -c "ALTER ROLE ${SERVICE}_service_role PASSWORD '$NEW_PW';"

# 4. Restart PgBouncer (re-renders userlist.txt from the new password files)
docker compose -f docker/docker-compose.yml restart pgbouncer

# 5. Restart the service
docker compose -f docker/docker-compose.yml restart ${SERVICE}-service
```

---

## 7. Scaling

### Resource limits per service

Defined in the `deploy.resources.limits` block in `docker/docker-compose.yml`:

| Service | Memory limit | CPU limit | Notes |
|---|---|---|---|
| `gateway-service` | 512 MB | 0.5 | Scale replicas for request throughput |
| `auth-service` | 512 MB | 0.5 | Session storage is in Postgres |
| `ingestion-service` | 1 GB | 1.0 | Memory for batch buffers; raise for large syncs |
| `ontology-service` | 512 MB | 0.5 | Read-heavy; scale for schema query throughput |
| `pipeline-service` | 1 GB | 1.0 | Raise for complex pipeline DAGs |
| `execution-service` | 2 GB | 1.0 | Sandbox processes need headroom |
| `app-service` | 1 GB | 1.0 | |
| `logging-service` | 512 MB | 0.5 | Raise if log write throughput is high |
| `plugin-service` | 512 MB | 0.5 | |
| `postgres` | 2 GB | 2.0 | Tune `shared_buffers` if raising |
| `redis` | 512 MB | 0.5 | Includes `maxmemory 256mb` configured in `docker/redis/redis.conf` |
| `pgbouncer` | 256 MB | 0.25 | Pool overhead is small |
| `vector` | 256 MB | 0.25 | |

### When to scale what

| Symptom | Scale target |
|---|---|
| High API latency, gateway CPU high | `gateway-service` replicas |
| Login/token endpoint slow | `auth-service` replicas |
| Connector syncs queued, not starting | `ingestion-service` replicas (or raise `OP_LARGE_SYNC_CONCURRENCY`) |
| Schema migrations slow | `ontology-service` memory (not replicas — advisory locks serialize migration) |
| Pipeline execution backlog | `pipeline-service` replicas |
| Plugin/connector timeout, sandbox pool exhausted | `execution-service` replicas or `OP_SANDBOX_POOL_SIZE` |
| App page load slow | `app-service` replicas |
| Log writes dropping | `logging-service` replicas |

### Scale a service (Docker Compose single-host)

```bash
# Scale to 3 gateway replicas (removes the container_name to allow multiple)
docker compose -f docker/docker-compose.yml up -d --scale gateway-service=3
```

Note: services with a `container_name:` set in `docker/docker-compose.yml`
cannot be scaled without first removing the fixed name. For production scaling,
see the horizontal scaling guidance in [DEPLOYMENT.md](DEPLOYMENT.md).

### PgBouncer pool size tuning

Each service's pool size is set in `docker/pgbouncer/pgbouncer.ini`. Raise when
you see `cl_waiting > 0` persistently in `SHOW POOLS`:

```ini
; Raise logging from 30 to 50 connections
oneplatform_logging = host=postgres port=5432 dbname=oneplatform \
  user=logging_service_role pool_size=50 pool_mode=transaction
```

The constraint is `max_connections=200` set on the PostgreSQL server
(`docker/docker-compose.yml` postgres command). Sum of all pool sizes should not
exceed 180 (leaving headroom for superuser/admin connections):

| Service | Current pool size |
|---|---|
| gateway | 15 |
| auth | 20 |
| ingestion | 25 |
| ontology | 15 |
| pipeline | 25 |
| execution | 10 |
| app | 15 |
| logging | 30 |
| plugin | 10 |
| **Total** | **165** |

### Redis memory tuning

`maxmemory` is configured in `docker/redis/redis.conf`. The Docker Compose
resource limit in `docker/docker-compose.yml` must be raised in sync:

```yaml
# docker/docker-compose.yml — redis service
deploy:
  resources:
    limits:
      memory: 1g   # was 512m
```

```
# docker/redis/redis.conf
maxmemory 768mb    # headroom below the container limit
```

Restart Redis after changing `redis.conf`:

```bash
docker compose -f docker/docker-compose.yml up -d --no-deps --force-recreate redis
```

---

## 8. Log Management

### Log aggregation architecture

```
Docker container stdout/stderr
  → Docker json-file driver (/var/lib/docker/containers/<id>/<id>-json.log)
  → Vector (tails host log files, read-only mount)
  → Parsed structured JSON
  → log-data volume (/var/log/oneplatform/<container-id>.log)
```

Vector configuration is at `docker/vector/vector.yaml`. It uses file-based
collection (not docker socket) to stay within the security model — Vector runs
as `nobody:root` with read-only access to Docker JSON log files.

### Structured log format

Services emit JSON logs via their logger. After Vector parses the Docker
envelope, top-level fields include:

| Field | Type | Description |
|---|---|---|
| `level` | string | `debug`, `info`, `warn`, `error` |
| `message` | string | Human-readable message |
| `time` | string | ISO 8601 timestamp from Docker |
| `requestId` | string | Request trace ID (present on HTTP requests) |
| `tenantId` | string | Tenant identifier (present on tenant-scoped requests) |
| `service` | string | Service name (e.g. `auth-service`) |
| `container_id` | string | Docker container ID (from file path) |
| `stream` | string | `stdout` or `stderr` |

### Log levels

Log level is controlled by the `OP_LOG_LEVEL` environment variable on each service
(defaults to `info` in production). To enable debug logging temporarily:

```bash
# Edit .env to add OP_LOG_LEVEL=debug for a service, then recreate it
docker compose -f docker/docker-compose.yml up -d --no-deps --force-recreate auth-service
```

Reset to `info` the same way when done. `debug` logs are verbose and will fill
disk quickly.

### Searching structured logs

```bash
# Search Vector-aggregated logs for a specific tenant
find /var/lib/docker/volumes/oneplatform_log-data/_data -name "*.log" -exec \
  grep -l '"tenantId":"<tenant-id>"' {} \;

# Tail all aggregated logs, filter by level=error (requires jq)
find /var/lib/docker/volumes/oneplatform_log-data/_data -name "*.log" | \
  xargs tail -f | jq -c 'select(.level == "error")'

# Search by requestId across all containers
grep '"requestId":"<trace-id>"' \
  /var/lib/docker/volumes/oneplatform_log-data/_data/*.log

# Search raw Docker JSON logs for a specific service without Vector
docker compose -f docker/docker-compose.yml logs --since 30m gateway-service \
  | grep '"level":"error"'
```

### Shipping logs to an external system

Add an additional sink in `docker/vector/vector.yaml`. Example for Loki:

```yaml
sinks:
  loki:
    type: loki
    inputs:
      - parse_docker_json
    endpoint: http://loki:3100
    labels:
      service: "{{ service }}"
      level: "{{ level }}"
    encoding:
      codec: json
```

Restart Vector after editing:

```bash
docker compose -f docker/docker-compose.yml restart vector
```

### Log rotation

Docker's json-file driver rotates logs automatically per the settings in
`docker/docker-compose.yml` (`max-size: 50m`, `max-file: 5`). No manual
rotation is needed.

The Vector-aggregated files at `/var/log/oneplatform/` on the `log-data` volume
do not rotate automatically by default. To add rotation, configure a Vector
`file` sink with a time-based path pattern, or run logrotate against the volume:

```bash
# Check current size of the log-data volume
docker run --rm -v oneplatform_log-data:/logs alpine du -sh /logs
```

---

## 9. Queue Management

BullMQ queues are backed by Redis. Each service has its own queue namespace:

| Queue key prefix | Service | Purpose |
|---|---|---|
| `bull:auth:*` | auth-service | Email verification, password reset |
| `bull:ingestion:*`, `bull:queue:ingestion:*` | ingestion-service | Connector sync jobs |
| `bull:queue:pipeline:*`, `bull:queue:execution:*` | pipeline-service | Pipeline runs |
| `bull:audit:*`, `bull:log:*` | logging-service | Async audit log writes |
| `bull:app:*`, `bull:queue:app:*` | app-service | App asset processing |
| `bull:plugin:*` | plugin-service | Plugin execution |

### Inspect queue state

BullMQ stores jobs as Redis hashes. Use the `op_admin` user to inspect across
all queues:

```bash
REDIS_ADMIN_PW=$(docker compose -f docker/docker-compose.yml exec -T redis \
  cat /data/init/redis_password_admin.txt | tr -d '[:space:]')
REDIS="docker compose -f docker/docker-compose.yml exec redis redis-cli --user op_admin -a $REDIS_ADMIN_PW"

# List all BullMQ queue names (finds keys like bull:<queue>:wait, :active, :failed, :completed)
$REDIS --scan --pattern "bull:*:wait" | sed 's/:wait$//' | sort -u

# Count jobs in each state for a queue (e.g. ingestion:sync)
$REDIS LLEN "bull:queue:ingestion:wait"       # waiting
$REDIS LLEN "bull:queue:ingestion:active"     # in-progress
$REDIS ZCARD "bull:queue:ingestion:failed"    # failed / DLQ
$REDIS ZCARD "bull:queue:ingestion:completed" # completed (kept for TTL period)
$REDIS ZCARD "bull:queue:ingestion:delayed"   # scheduled for future
$REDIS ZCARD "bull:queue:ingestion:stalled-check" # stall check set
```

### Stalled job recovery

BullMQ marks jobs as stalled when a worker crashes while processing them. They
are automatically moved back to `wait` on the next stall check interval. If
stalled jobs are not recovering:

```bash
# Check the stalled check key TTL — if expired, BullMQ is not running a checker
$REDIS TTL "bull:queue:ingestion:stalled-check"
# If -2 (key doesn't exist), the worker process is likely down

# Check if the service is running and its worker loop is active
docker compose -f docker/docker-compose.yml ps ingestion-service
docker compose -f docker/docker-compose.yml logs --tail=50 ingestion-service

# Force-restart the service to re-initialize the stall checker
docker compose -f docker/docker-compose.yml restart ingestion-service
```

### DLQ (failed job) processing

Failed jobs accumulate in the `failed` sorted set. Inspect the most recently
failed jobs:

```bash
# Get the 5 most recently failed jobs in the ingestion queue
$REDIS ZRANGE "bull:queue:ingestion:failed" 0 4 WITHSCORES REV

# Get full job data for a job ID (e.g. "12345")
$REDIS HGETALL "bull:queue:ingestion:12345"
# Key fields: name, data, opts, attemptsMade, failedReason, stacktrace
```

To retry a failed job, use the BullMQ admin API or the platform's job management
UI, which calls the relevant service endpoint. Manual retries via Redis are
possible but should be a last resort — BullMQ's internal state is denormalized
across multiple keys.

### Queue metrics for monitoring

```bash
# Quick health summary across all queues
for QUEUE in ingestion pipeline auth logging app plugin; do
  WAIT=$($REDIS LLEN "bull:queue:${QUEUE}:wait" 2>/dev/null || echo 0)
  ACTIVE=$($REDIS LLEN "bull:queue:${QUEUE}:active" 2>/dev/null || echo 0)
  FAILED=$($REDIS ZCARD "bull:queue:${QUEUE}:failed" 2>/dev/null || echo 0)
  echo "bull:queue:${QUEUE}: wait=${WAIT} active=${ACTIVE} failed=${FAILED}"
done
```

---

## 10. Routine Maintenance

### Daily / automated

| Task | Command | When |
|---|---|---|
| Backup | `./docker/scripts/backup.sh ./backups` | Daily, automated via cron |
| Check all service health | `docker compose -f docker/docker-compose.yml ps` | On-call alert |
| Queue health check | See [Queue Management](#9-queue-management) | On-call alert |

### Weekly

**PostgreSQL VACUUM and ANALYZE**

PostgreSQL autovacuum runs continuously, but after large batch operations
(connector syncs, log inserts) a manual vacuum can reclaim space faster:

```bash
# VACUUM ANALYZE on the most active tables (logging, ingestion)
docker compose -f docker/docker-compose.yml exec postgres \
  psql -U postgres -d oneplatform \
  -c "VACUUM ANALYZE logging.log_entries;"

docker compose -f docker/docker-compose.yml exec postgres \
  psql -U postgres -d oneplatform \
  -c "VACUUM ANALYZE ingestion.sync_runs;"

# Check table bloat (identifies tables that need vacuuming)
docker compose -f docker/docker-compose.yml exec postgres \
  psql -U postgres -d oneplatform -c "
    SELECT schemaname, tablename,
           pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS total_size,
           n_dead_tup, n_live_tup,
           round(n_dead_tup::numeric / NULLIF(n_live_tup + n_dead_tup, 0) * 100, 1) AS dead_pct
    FROM pg_stat_user_tables
    ORDER BY n_dead_tup DESC
    LIMIT 20;
  "
```

**Redis memory optimization**

```bash
REDIS_ADMIN_PW=$(docker compose -f docker/docker-compose.yml exec -T redis \
  cat /data/init/redis_password_admin.txt | tr -d '[:space:]')

# Report memory fragmentation
docker compose -f docker/docker-compose.yml exec redis \
  redis-cli --user op_admin -a "$REDIS_ADMIN_PW" \
  INFO memory | grep mem_fragmentation_ratio

# If fragmentation ratio > 1.5, release fragmented memory
docker compose -f docker/docker-compose.yml exec redis \
  redis-cli --user op_admin -a "$REDIS_ADMIN_PW" MEMORY PURGE
```

### Monthly

**Prune old execution artifacts**

Execution output objects in MinIO accumulate over time. Set lifecycle policies
to auto-expire them (see [Object Storage](#5-object-storage)), or prune manually:

```bash
mc alias set op http://localhost:9000 "$OP_MINIO_USER" "$OP_MINIO_PASSWORD"
# Delete objects older than 90 days in execution-outputs bucket
mc rm --recursive --older-than 90d op/execution-outputs
```

**Prune old log data**

Remove aggregated log files older than your retention window from the `log-data`
volume:

```bash
docker run --rm -v oneplatform_log-data:/logs alpine \
  find /logs -name "*.log" -mtime +90 -delete
```

**Prune completed BullMQ jobs**

BullMQ keeps completed jobs for a configurable TTL. If the TTL was set high or
not set, prune manually:

```bash
REDIS_ADMIN_PW=$(docker compose -f docker/docker-compose.yml exec -T redis \
  cat /data/init/redis_password_admin.txt | tr -d '[:space:]')
REDIS="docker compose -f docker/docker-compose.yml exec redis redis-cli --user op_admin -a $REDIS_ADMIN_PW"

# Remove completed jobs older than 7 days (Unix timestamp arithmetic)
CUTOFF=$(date -d '7 days ago' +%s)000   # milliseconds
for QUEUE in ingestion pipeline auth logging app plugin; do
  $REDIS ZREMRANGEBYSCORE "bull:queue:${QUEUE}:completed" 0 "$CUTOFF"
done
```

**Trim PostgreSQL execution partition tables**

If the execution service uses table partitioning for run history, drop partitions
older than the retention window:

```bash
# List partitions (naming convention is execution.runs_YYYY_MM)
docker compose -f docker/docker-compose.yml exec postgres \
  psql -U postgres -d oneplatform -c "
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'execution'
      AND tablename LIKE 'runs_%'
    ORDER BY tablename;
  "

# Drop a specific month's partition after confirming it is beyond retention
docker compose -f docker/docker-compose.yml exec postgres \
  psql -U postgres -d oneplatform \
  -c "DROP TABLE execution.runs_2025_10;"
```

**Check Docker volume disk usage**

```bash
docker system df -v | grep -E "(VOLUME|oneplatform)"

# Clean up unused images (does not affect running containers)
docker image prune -f
```

### Certificate renewal (TLS termination at reverse proxy)

TLS is terminated by the reverse proxy in front of the gateway (Nginx, Caddy, or
a cloud load balancer — see [DEPLOYMENT.md](DEPLOYMENT.md)). Certificate renewal
is managed at the proxy layer, not inside the OnePlatform stack. After renewal:

```bash
# Test that the new certificate is served correctly
openssl s_client -connect your-domain.com:443 -servername your-domain.com </dev/null \
  | openssl x509 -noout -dates

# If using Caddy, renewal is automatic. For Nginx + Certbot:
certbot renew --deploy-hook "nginx -s reload"
```

No changes to the OnePlatform Docker Compose stack are required for certificate
renewal.
