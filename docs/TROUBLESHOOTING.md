# OnePlatform Troubleshooting Guide

> **How to use this guide.** Each issue follows the pattern:
> **Symptom** — what you observe in logs or behavior  
> **Cause** — why it happens  
> **Fix** — exact commands to resolve it
>
> Issues are organized by category. Use Ctrl+F with the exact log message or
> error text you are seeing to jump directly to the relevant section.
>
> Related documents: [DEPLOYMENT.md](./DEPLOYMENT.md)

---

## Table of Contents

1. [Startup Failures](#1-startup-failures)
2. [Authentication Issues](#2-authentication-issues)
3. [Database Issues](#3-database-issues)
4. [Redis Issues](#4-redis-issues)
5. [Queue Issues](#5-queue-issues)
6. [Network Issues](#6-network-issues)
7. [Docker and Container Issues](#7-docker-and-container-issues)
8. [Performance Issues](#8-performance-issues)
9. [Data Issues](#9-data-issues)
10. [Quick Reference: Diagnostic Commands](#10-quick-reference-diagnostic-commands)

---

## 1. Startup Failures

### 1.1 Service exits immediately — `/data/init/ready` missing

**Symptom**

A service container exits with code 1 within seconds of starting:

```
gateway-service  | [service-entrypoint] FATAL: op-init has not completed (/data/init/ready missing).
gateway-service  | [service-entrypoint] Ensure op-init ran successfully before starting services.
gateway-service exited with code 1
```

**Cause**

`op-init` generates all secrets and writes `/data/init/ready` as its final
step. Application services check for this file in `service-entrypoint.sh`
before reading any secret. If `op-init` never ran, failed mid-run, or the
`init-data` volume was wiped after a partial run, the guard fires.

**Fix**

```bash
# 1. Check whether op-init completed
docker compose -f docker/docker-compose.yml logs op-init

# 2a. If op-init never ran (fresh install or wiped volume):
docker compose -f docker/docker-compose.yml run --rm op-init

# 2b. If op-init logs show a CHANGE_ME error (see §1.2) or a missing file,
#     destroy the volume and regenerate:
docker compose -f docker/docker-compose.yml down -v
docker compose -f docker/docker-compose.yml run --rm op-init
docker compose -f docker/docker-compose.yml up -d

# 3. Verify the ready file exists:
docker compose -f docker/docker-compose.yml run --rm \
  -v oneplatform_init-data:/data/init:ro \
  alpine test -f /data/init/ready && echo "OK"
```

> Warning: `down -v` destroys ALL named volumes including PostgreSQL data.
> On a live system, investigate the partial run before destroying volumes.

---

### 1.2 Config validation error on startup

**Symptom**

Service starts but immediately throws and exits:

```
auth-service | Configuration validation failed:
auth-service |   OP_MINIO_PASSWORD: OP_MINIO_PASSWORD must be set to a non-placeholder value in production
auth-service exited with code 1
```

Or an earlier check in `service-entrypoint.sh`:

```
auth-service | [service-entrypoint] FATAL: OP_MINIO_PASSWORD is unset or still set to the placeholder value.
auth-service | [service-entrypoint] Set a strong password in .env before running docker compose up.
auth-service exited with code 1
```

**Cause**

`service-entrypoint.sh` explicitly rejects `OP_MINIO_PASSWORD` when it is
empty, `CHANGE_ME_minio`, or `dev_minio_password_change_me`. The Zod schema in
`packages/core/src/config.ts` (`minioPasswordSchema`) adds a second layer for
non-Compose deployments. Unlike secrets on the `init-data` volume,
`OP_MINIO_PASSWORD` is injected via Docker Compose `environment:` and must be
set in `.env` before any service starts.

Common Zod errors and their causes:

| Error path | Cause |
|---|---|
| `OP_MINIO_PASSWORD` | Placeholder value in `.env` |
| `OP_BASE_URL` | Not a valid URL (missing protocol, or empty) |
| `OP_JWT_SECRET: String must contain at least 32 character(s)` | Secret file truncated or empty |
| `OP_MASTER_KEY: String must contain at least 1 character(s)` | `master.key` missing from init volume |
| `OP_CURSOR_SECRET` | `cursor.secret` missing from init volume |
| `OP_ALLOWED_ORIGINS: Wildcard (*) is not allowed` | `NODE_ENV=production` with `OP_ALLOWED_ORIGINS=*` |

**Fix**

```bash
# For OP_MINIO_PASSWORD:
# Edit .env and set a strong value (min 12 chars, not the placeholder)
$EDITOR .env
# Then recreate the affected service(s)
docker compose -f docker/docker-compose.yml up -d --force-recreate auth-service

# For missing secret files — check what op-init produced:
docker compose -f docker/docker-compose.yml run --rm \
  -v oneplatform_init-data:/data/init:ro \
  alpine ls -la /data/init/

# Verify a specific secret file is non-empty:
docker compose -f docker/docker-compose.yml run --rm \
  -v oneplatform_init-data:/data/init:ro \
  alpine cat /data/init/jwt.secret

# For OP_BASE_URL — must be a full URL with protocol:
# Bad:  OP_BASE_URL=mysite.com
# Good: OP_BASE_URL=https://mysite.com
```

---

### 1.3 Database connection refused at startup

**Symptom**

```
ingestion-service | Error: connect ECONNREFUSED 127.0.0.1:5433
ingestion-service | Error: connect ECONNREFUSED pgbouncer:5433
```

Or PgBouncer itself fails health checks and services never become healthy:

```
pgbouncer        | Error: could not connect to server: Connection refused
```

**Cause**

There are two distinct cases:

- **PgBouncer not ready yet**: Docker Compose's `depends_on: condition:
  service_healthy` prevents application services from starting before
  PgBouncer's health check passes (`pg_isready -h localhost -p 5433`). If
  PgBouncer itself is waiting for PostgreSQL (`service_healthy` on postgres),
  the chain propagates. Transient delays during container startup are normal;
  persistent failure indicates a config problem.

- **PgBouncer `userlist.txt` not rendered**: The `pgbouncer-entrypoint.sh`
  reads password files from the init volume to render `userlist.txt`. If a
  password file is missing, PgBouncer refuses to start.

- **Wrong pool mode**: Ontology and pipeline services connect via
  `oneplatform_ontology` and `oneplatform_pipeline` aliases, both configured as
  `pool_mode=session`. All other services use `pool_mode=transaction`. Pointing
  an ontology or pipeline service at the wrong alias causes advisory lock
  failures and unexpected disconnects, not a startup failure — see §3.2.

**Fix**

```bash
# Check PgBouncer startup logs
docker compose -f docker/docker-compose.yml logs pgbouncer

# Check PostgreSQL is healthy
docker compose -f docker/docker-compose.yml ps postgres

# Manually verify PgBouncer userlist rendered correctly
docker compose -f docker/docker-compose.yml exec pgbouncer \
  cat /etc/pgbouncer/userlist.txt | head -5
# Should show quoted usernames and md5-hashed passwords, not CHANGE_ME strings

# If userlist is missing or contains CHANGE_ME, re-run op-init and restart:
docker compose -f docker/docker-compose.yml restart pgbouncer

# Test direct PgBouncer connectivity from inside the network:
docker compose -f docker/docker-compose.yml run --rm \
  --network oneplatform_oneplatform-internal \
  postgres:16-alpine pg_isready -h pgbouncer -p 5433
```

---

### 1.4 Redis authentication failed at startup

**Symptom**

```
redis            | [redis-entrypoint] FATAL: Redis password file missing: /data/init/redis_password_gateway.txt
redis exited with code 1
```

Or a service fails to connect:

```
gateway-service  | ReplyError: WRONGPASS invalid username-password pair
```

**Cause**

`redis-entrypoint.sh` renders `users.acl` by substituting
`REDIS_PASSWORD_<user>` placeholders from password files on the init volume. If
any of the 11 password files (`admin`, `auth`, `pipeline`, `logging`,
`gateway`, `ingestion`, `ontology`, `app`, `plugin`, `execution`) are missing,
Redis exits before starting. A mismatch between the rendered ACL and the
password a service reads from its own password file (e.g. after `op-init` was
re-run without destroying the existing Redis AOF) causes `WRONGPASS`.

**Fix**

```bash
# Inspect Redis startup logs
docker compose -f docker/docker-compose.yml logs redis

# Verify all 11 redis password files were generated:
docker compose -f docker/docker-compose.yml run --rm \
  -v oneplatform_init-data:/data/init:ro \
  alpine ls /data/init/ | grep redis_password_

# If any are missing, re-run op-init (it skips already-generated files):
docker compose -f docker/docker-compose.yml run --rm op-init
docker compose -f docker/docker-compose.yml restart redis

# If passwords are out-of-sync after a volume partial-wipe (WRONGPASS error),
# the only safe fix is a full re-init:
# WARNING: destroys all data on all volumes
docker compose -f docker/docker-compose.yml down -v
docker compose -f docker/docker-compose.yml run --rm op-init
docker compose -f docker/docker-compose.yml up -d

# To test Redis auth for a specific service without restarting:
PASS=$(docker compose -f docker/docker-compose.yml run --rm \
  -v oneplatform_init-data:/data/init:ro \
  alpine cat /data/init/redis_password_gateway.txt | tr -d '[:space:]')
docker compose -f docker/docker-compose.yml exec redis \
  redis-cli --user op_gateway -a "$PASS" ping
```

---

## 2. Authentication Issues

### 2.1 JWT verification failed

**Symptom**

```json
{"error":{"code":"UNAUTHORIZED","message":"JWT verification failed","requestId":"req_..."}}
```

Service logs show:

```
auth-service | JsonWebTokenError: invalid signature
```

Or on a different service receiving a forwarded JWT:

```
gateway-service | UnauthorizedError: JWT verification failed
```

**Cause**

All services share a single `OP_JWT_SECRET` loaded from `/data/init/jwt.secret`
by `service-entrypoint.sh`. The auth service signs tokens with it; every other
service verifies incoming JWTs with it. A mismatch occurs when:

- `op-init` was re-run and regenerated `jwt.secret` while services were still
  running with the old secret in memory.
- A service was restarted (picked up the new secret) while another was not
  (kept the old secret in memory).
- The init volume was partially replaced from a backup.

**Fix**

```bash
# Confirm all services loaded the same secret by checking container start times
# relative to the last op-init run:
docker compose -f docker/docker-compose.yml ps

# Rolling restart to force all services to re-read the current secret:
for SVC in gateway-service auth-service ingestion-service ontology-service \
           pipeline-service execution-service app-service logging-service plugin-service; do
  docker compose -f docker/docker-compose.yml restart "$SVC"
  sleep 2
done

# Verify the secret on the volume is non-empty and ≥32 hex chars:
docker compose -f docker/docker-compose.yml run --rm \
  -v oneplatform_init-data:/data/init:ro \
  alpine cat /data/init/jwt.secret
```

Access tokens have a 15-minute TTL (HS256), so users will need to re-authenticate
after the rolling restart completes.

---

### 2.2 Service token rejected (X-Service-Token)

**Symptom**

```
ingestion-service | UnauthorizedError: Service token verification failed
ingestion-service | Error: EdDSA signature verification failed for sub: gateway-service
```

Or:

```
auth-service | UnauthorizedError: Service token clock skew exceeded (>5min)
```

**Cause**

Services sign outbound `X-Service-Token` headers using their Ed25519 private
key (`/data/init/keys/<service-name>/private.pem`). Receiving services verify
the signature using the caller's public key loaded from
`/data/service-keys/<service-name>.pub`. Two failure modes:

- **Key pair mismatch**: Public key on `shared-pubkeys` volume does not
  correspond to the private key on `init-data`. This happens when `op-init`
  re-ran and regenerated keys while the public keys volume was not wiped, or
  vice versa.

- **Clock skew**: The token includes an `iat` (issued-at) claim. Receiving
  services reject tokens where `|now - iat| > 5 minutes`. Containers on
  different hosts can drift if NTP is misconfigured.

**Fix**

```bash
# Key pair mismatch: force re-generation
# The public key is always re-derived from the private key if missing:
docker compose -f docker/docker-compose.yml run --rm op-init
# op-init skips existing files, so to force new keys for a specific service
# you must remove the private key and re-run:
docker compose -f docker/docker-compose.yml run --rm \
  -v oneplatform_init-data:/data/init \
  alpine rm /data/init/keys/gateway-service/private.pem
docker compose -f docker/docker-compose.yml run --rm op-init
docker compose -f docker/docker-compose.yml restart gateway-service

# Clock skew: check host time
date
docker compose -f docker/docker-compose.yml exec gateway-service date
# Sync host NTP if they differ by more than a few seconds:
sudo timedatectl set-ntp true
# On Docker Desktop for Mac/Windows, restart Docker to sync VM clock.
```

---

### 2.3 Deactivated user can still access the API

**Symptom**

A user whose account was deactivated in the admin panel continues to make
successful API calls within the 15-minute access token window.

**Cause**

Access tokens are HS256 JWTs with a 15-minute TTL and are stateless — there is
no per-token revocation. Per-user revocation works by writing a
`revocation:user:{userId}` key to Redis. The auth service checks this key on
every request that passes a valid JWT. If the key is missing or expired in
Redis (eviction under `allkeys-lru` policy when memory is tight), the
revocation check passes silently and the deactivated user appears active.

**Fix**

```bash
# Check whether the revocation key exists (replace <userId> with actual UUID):
PASS=$(docker compose -f docker/docker-compose.yml run --rm \
  -v oneplatform_init-data:/data/init:ro \
  alpine cat /data/init/redis_password_auth.txt | tr -d '[:space:]')
docker compose -f docker/docker-compose.yml exec redis \
  redis-cli --user op_auth -a "$PASS" GET "revocation:user:<userId>"

# If key is missing (was evicted), manually write it with a TTL >= 15m:
docker compose -f docker/docker-compose.yml exec redis \
  redis-cli --user op_auth -a "$PASS" \
  SET "revocation:user:<userId>" 1 EX 900

# Prevent future eviction of auth keys: increase maxmemory in redis.conf
# and redeploy. The current limit is 256mb (matching the container memory limit).
# Rule of thumb: each revocation key is ~60 bytes; plan for peak concurrent users.

# Monitor Redis memory usage:
docker compose -f docker/docker-compose.yml exec redis \
  redis-cli --user op_admin -a "$ADMIN_PASS" INFO memory | grep used_memory_human
```

---

### 2.4 Bootstrap token not working

**Symptom**

The first-run setup wizard returns:

```json
{"error":{"code":"UNAUTHORIZED","message":"Invalid or expired bootstrap token"}}
```

**Cause**

`op-init` generates a 64-character hex bootstrap token in
`/data/init/bootstrap.token`. The auth service reads it via
`service-entrypoint.sh` as `OP_BOOTSTRAP_TOKEN`. On successful first-time admin
creation, the auth service deletes the file from disk (single-use semantics).
On subsequent restarts, `service-entrypoint.sh` exports `OP_BOOTSTRAP_TOKEN=""`
when the file is absent, and the auth service treats any bootstrap attempt as
invalid.

The token also does not exist if op-init ran on a volume that already had a
`bootstrap.token` file — `init.sh` skips generation for existing files.

**Fix**

```bash
# Check whether the file still exists:
docker compose -f docker/docker-compose.yml run --rm \
  -v oneplatform_init-data:/data/init:ro \
  alpine ls -la /data/init/bootstrap.token

# If the token was already consumed and you need to re-bootstrap (e.g., you
# lost the initial admin password), remove the consumed state and regenerate.
# WARNING: this also regenerates JWT and cursor secrets — restart all services.
docker compose -f docker/docker-compose.yml run --rm \
  -v oneplatform_init-data:/data/init \
  alpine rm /data/init/bootstrap.token
docker compose -f docker/docker-compose.yml run --rm op-init

# Read the new token to use in the setup wizard:
docker compose -f docker/docker-compose.yml run --rm \
  -v oneplatform_init-data:/data/init:ro \
  alpine cat /data/init/bootstrap.token

# Restart auth-service to pick up the new token:
docker compose -f docker/docker-compose.yml restart auth-service
```

---

### 2.5 OAuth flow fails — redirect URI mismatch or PKCE failure

**Symptom**

OAuth provider returns:

```
redirect_uri_mismatch: The redirect URI in the request did not match.
```

Or the auth service returns after callback:

```json
{"error":{"code":"UNAUTHORIZED","message":"PKCE code_verifier verification failed"}}
```

**Cause**

- **Redirect URI mismatch**: The `redirect_uri` parameter in the authorization
  request must exactly match a registered URI in the OAuth provider. The auth
  service builds redirect URIs using `OP_BASE_URL`. If `OP_BASE_URL` differs
  from the registered URI (trailing slash, HTTP vs HTTPS, wrong port), the
  provider rejects the callback.

- **PKCE failure**: The `code_verifier` sent in the token exchange does not
  match the `code_challenge` sent in the authorization request. This happens
  when the client session between the two requests is broken (missing cookie,
  session store flush, load balancer sticky-session misconfiguration).

**Fix**

```bash
# Verify OP_BASE_URL matches what is registered with the OAuth provider:
docker compose -f docker/docker-compose.yml exec auth-service \
  sh -c 'echo $OP_BASE_URL'

# For redirect URI mismatch: update OP_BASE_URL in .env to exactly match
# what is registered. Include protocol and port — no trailing slash.
# Good: OP_BASE_URL=https://myapp.example.com
# Bad:  OP_BASE_URL=https://myapp.example.com/

# For PKCE failure: ensure clients store code_verifier in the same session
# across the redirect. Check auth-service logs for the specific failure:
docker compose -f docker/docker-compose.yml logs auth-service --tail=50
```

---

## 3. Database Issues

### 3.1 Connection pool exhaustion

**Symptom**

Requests intermittently fail or hang. PgBouncer admin console shows high
`cl_waiting`:

```
pgbouncer=# SHOW POOLS;
 database              | user                   | cl_active | cl_waiting | sv_active | sv_idle
-----------------------+------------------------+-----------+------------+-----------+--------
 oneplatform_logging   | logging_service_role   |        30 |         47 |        30 |       0
```

Service logs:

```
logging-service | Error: timeout expired waiting to acquire connection from pool
```

**Cause**

`pgbouncer.ini` sets per-database `pool_size` values:

| Database alias        | Pool size | Mode        |
|-----------------------|-----------|-------------|
| `oneplatform_logging` | 30        | transaction |
| `oneplatform_ingestion` | 25      | transaction |
| `oneplatform_pipeline` | 25       | session     |
| `oneplatform_auth`    | 20        | transaction |
| `oneplatform_gateway` | 15        | transaction |
| `oneplatform_ontology` | 15       | session     |
| `oneplatform_app`     | 15        | transaction |
| `oneplatform_execution` | 10      | transaction |
| `oneplatform_plugin`  | 10        | transaction |

The total across all pools is 165 server connections, which leaves headroom
under PostgreSQL's `max_connections=200`. When request concurrency spikes
beyond a pool's capacity, clients queue in PgBouncer. Long-lived transactions
(e.g., a slow migration, an unfinished write held open by application code)
block pool slots.

**Fix**

```bash
# Connect to PgBouncer admin interface to diagnose:
PGBADMIN_PASS=$(docker compose -f docker/docker-compose.yml exec -T postgres \
  cat /data/init/db_password_pgbouncer_admin.txt | tr -d '[:space:]')
docker compose -f docker/docker-compose.yml run --rm \
  --network oneplatform_oneplatform-internal \
  postgres:16-alpine psql \
  "postgres://pgbouncer_admin:${PGBADMIN_PASS}@pgbouncer:5433/pgbouncer"

# Inside the admin console:
SHOW POOLS;      -- cl_waiting > 0 means clients are queuing
SHOW CLIENTS;    -- see per-connection state
SHOW SERVERS;    -- see server-side connections and their states
SHOW STATS;      -- query rate per database

# Identify long-running queries holding connections on Postgres:
docker compose -f docker/docker-compose.yml exec postgres \
  psql -U postgres -d oneplatform -c \
  "SELECT pid, now()-pg_stat_activity.query_start AS duration, query, state
   FROM pg_stat_activity
   WHERE state <> 'idle' AND now()-query_start > interval '30 seconds'
   ORDER BY duration DESC;"

# Terminate a stuck backend if needed (replace <pid>):
docker compose -f docker/docker-compose.yml exec postgres \
  psql -U postgres -d oneplatform -c "SELECT pg_terminate_backend(<pid>);"

# Longer term: increase pool_size for the affected database in pgbouncer.ini
# and restart PgBouncer. Each increment adds one PostgreSQL server connection.
# Ensure total pool_size across all databases stays under max_connections - 5.
```

---

### 3.2 Migration fails — advisory lock held by crashed process

**Symptom**

```
ontology-service  | Error: Knex: Timeout waiting to acquire advisory lock for migrations
ontology-service  | DETAIL: pg_try_advisory_lock returned false
pipeline-service  | MigrationLockError: Could not acquire migration lock
```

**Cause**

Ontology and pipeline services use session-mode PgBouncer
(`oneplatform_ontology` and `oneplatform_pipeline` aliases, both
`pool_mode=session`). Session mode is required because PostgreSQL advisory locks
are connection-scoped: releasing the connection releases the lock. In session
mode, the same PostgreSQL connection is held for the entire session.

When a service crashes mid-migration, the advisory lock may remain held in the
PostgreSQL backend if the backend has not been terminated. The next startup
attempt cannot acquire the lock and hangs or fails.

**Fix**

```bash
# Identify the backend holding the advisory lock:
docker compose -f docker/docker-compose.yml exec postgres \
  psql -U postgres -d oneplatform -c \
  "SELECT pid, usename, application_name, state, query
   FROM pg_stat_activity
   WHERE state <> 'idle';"

# Check advisory locks directly:
docker compose -f docker/docker-compose.yml exec postgres \
  psql -U postgres -d oneplatform -c \
  "SELECT pid, classid, objid, locktype
   FROM pg_locks
   WHERE locktype = 'advisory';"

# Terminate the backend holding the lock (replace <pid>):
docker compose -f docker/docker-compose.yml exec postgres \
  psql -U postgres -d oneplatform -c "SELECT pg_terminate_backend(<pid>);"

# Then restart the service so migration re-runs from scratch:
docker compose -f docker/docker-compose.yml restart ontology-service
```

---

### 3.3 Cross-schema access denied

**Symptom**

```
ontology-service | ERROR: permission denied for schema ingestion
ontology-service | ERROR: permission denied for table raw_contacts
```

**Cause**

`init.sql` grants the `ontology_service_role` `USAGE` on the `ingestion` schema
and `SELECT` on existing tables at init time (line 145–146). It also sets a
default privilege so future tables created by `ingestion_service_role` are
automatically readable by `ontology_service_role` (line 149–150). However, if
the PostgreSQL volume was partially restored from backup, or if tables were
created before the grants were applied, the default privileges may not cover
those tables.

No other cross-schema access is permitted. Any permission error other than
`ontology_service_role` reading `ingestion` tables is a schema isolation
violation and should be investigated.

**Fix**

```bash
# Re-apply the cross-schema grants for tables that pre-date the default privilege:
docker compose -f docker/docker-compose.yml exec postgres \
  psql -U postgres -d oneplatform -c \
  "GRANT SELECT ON ALL TABLES IN SCHEMA ingestion TO ontology_service_role;"

# Verify current grants on a specific table:
docker compose -f docker/docker-compose.yml exec postgres \
  psql -U postgres -d oneplatform -c \
  "\dp ingestion.raw_contacts"

# Verify ontology's search_path includes ingestion:
docker compose -f docker/docker-compose.yml exec postgres \
  psql -U postgres -d oneplatform -c \
  "SELECT rolname, rolconfig FROM pg_roles WHERE rolname = 'ontology_service_role';"
```

---

### 3.4 Slow queries — missing indexes, N+1 patterns, large table scans

**Symptom**

Request latency spikes, particularly on list endpoints. Service logs show long
database query durations. PgBouncer `sv_active` is high but `cl_waiting` is low
(the queries themselves are slow, not the pool).

**Fix**

```bash
# Enable pg_stat_statements for query tracking (in the running container):
docker compose -f docker/docker-compose.yml exec postgres \
  psql -U postgres -d oneplatform -c \
  "CREATE EXTENSION IF NOT EXISTS pg_stat_statements;"

# Find the slowest queries:
docker compose -f docker/docker-compose.yml exec postgres \
  psql -U postgres -d oneplatform -c \
  "SELECT query, calls, total_exec_time/calls AS avg_ms, rows/calls AS avg_rows
   FROM pg_stat_statements
   ORDER BY avg_ms DESC LIMIT 20;"

# Identify sequential scans on large tables:
docker compose -f docker/docker-compose.yml exec postgres \
  psql -U postgres -d oneplatform -c \
  "SELECT relname, seq_scan, idx_scan, n_live_tup
   FROM pg_stat_user_tables
   WHERE seq_scan > idx_scan AND n_live_tup > 1000
   ORDER BY seq_scan DESC;"

# EXPLAIN ANALYZE a specific query (replace schema and query):
docker compose -f docker/docker-compose.yml exec postgres \
  psql -U postgres -d oneplatform -c \
  "EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM ingestion.raw_contacts
   WHERE tenant_id = 'tenant-uuid' ORDER BY created_at DESC LIMIT 50;"

# Check VACUUM/ANALYZE status (table bloat causes slow scans):
docker compose -f docker/docker-compose.yml exec postgres \
  psql -U postgres -d oneplatform -c \
  "SELECT relname, last_vacuum, last_autovacuum, last_analyze, last_autoanalyze
   FROM pg_stat_user_tables ORDER BY last_autovacuum NULLS FIRST LIMIT 20;"
```

---

## 4. Redis Issues

### 4.1 NOPERM — ACL user accessing wrong key prefix

**Symptom**

```
gateway-service | ReplyError: NOPERM this user has no permissions to run the 'set' command or its subcommand
gateway-service | ReplyError: NOPERM No permissions to access a key
```

**Cause**

Each Redis ACL user (`op_gateway`, `op_auth`, etc.) has a strict key-prefix
allow-list defined in `users.acl.template`. For example:

- `op_gateway` may only access keys matching `ratelimit:*`, `gateway:*`, `webhook:*`
- `op_auth` may only access `auth:*`, `revocation:*`, `reset:*`, `bull:auth:*`

Any attempt to read or write a key outside the allowed prefix is rejected. This
most commonly occurs when a service writes a key with an incorrect namespace
(e.g., `op_gateway` attempting to write to `auth:session:...`), or when a new
key pattern is introduced without updating the ACL template.

**Fix**

```bash
# Confirm the exact command and key that triggered NOPERM:
# The ReplyError message from ioredis/BullMQ includes the command name.
# Cross-reference with users.acl.template for the affected user's allowed patterns:
cat /home/ubuntu/topics/oneplatform/docker/redis/users.acl.template

# ACL key patterns per service (from users.acl.template):
# op_auth:     auth:* revocation:* reset:* bull:auth:*
# op_gateway:  ratelimit:* gateway:* webhook:*
# op_ingestion: queue:ingestion:* ingestion:sync:* bull:ingestion:* bull:queue:ingestion:*
# op_ontology: ontology:*
# op_pipeline: queue:pipeline:* queue:execution:* bull:queue:pipeline:* bull:queue:execution:*
# op_logging:  log:* audit:* bull:audit:* bull:log:*
# op_app:      guest-session:* rate:guest-session:* app:* bff:* bull:app:* bull:queue:app:*
# op_plugin:   plugin:* bull:plugin:*
# op_execution: execution:*

# To add a new key pattern, edit users.acl.template and reload ACL without restart:
docker compose -f docker/docker-compose.yml exec redis \
  sh -c 'redis-cli --user op_admin -a "$ADMIN_PASS" ACL LOAD'
# (ACL LOAD re-reads the aclfile path specified in redis.conf)
```

---

### 4.2 OOM — maxmemory reached

**Symptom**

```
redis | # OOM command not allowed when used memory > 'maxmemory'.
gateway-service | ReplyError: OOM command not allowed when used memory > 'maxmemory'.
```

Or Redis evicts auth tokens (`auth:*` keys) under `allkeys-lru` policy, causing
spurious token invalidations.

**Cause**

`redis.conf` sets `maxmemory 256mb` with `maxmemory-policy allkeys-lru`. The
`allkeys-lru` policy is safe for rate limit counters (regenerated on next
request) and queue metadata (BullMQ rebuilds state). However, it will evict
auth session keys and revocation keys if memory pressure is high, which causes
false token rejections or revocation bypass respectively.

**Fix**

```bash
# Check current memory usage:
ADMIN_PASS=$(docker compose -f docker/docker-compose.yml run --rm \
  -v oneplatform_init-data:/data/init:ro \
  alpine cat /data/init/redis_password_admin.txt | tr -d '[:space:]')
docker compose -f docker/docker-compose.yml exec redis \
  redis-cli --user op_admin -a "$ADMIN_PASS" INFO memory

# Find the largest key types consuming memory:
docker compose -f docker/docker-compose.yml exec redis \
  redis-cli --user op_admin -a "$ADMIN_PASS" MEMORY DOCTOR

# Increase maxmemory (requires redis.conf edit + container restart):
# 1. Edit docker/redis/redis.conf: maxmemory 512mb
# 2. Edit docker/docker-compose.yml: memory limit on redis service to 512m
# 3. Restart Redis:
docker compose -f docker/docker-compose.yml up -d --force-recreate redis

# Identify keys without TTL that are accumulating (should be zero in normal operation):
docker compose -f docker/docker-compose.yml exec redis \
  redis-cli --user op_admin -a "$ADMIN_PASS" \
  OBJECT HELP  # Use SCAN + TTL in a script rather than KEYS in production
```

> Never run `KEYS *` against production Redis. Use `SCAN` with a `COUNT` hint
> to iterate without blocking the event loop.

---

### 4.3 BullMQ stalled jobs

**Symptom**

Jobs appear stuck in the `active` state indefinitely in queue monitoring.
Service logs show:

```
ingestion-service | BullMQ: job <jobId> stalled, moving to failed
ingestion-service | BullMQ: job <jobId> stalled more than allowed <maxStalledCount> times
```

**Cause**

BullMQ marks a job as stalled when the worker that took it (moved it from
`waiting` to `active`) stops sending heartbeats within `stalledInterval`. This
happens when:

- The worker process crashed mid-job (container OOM kill, unhandled exception).
- The job processing time exceeds `lockDuration` (the lock timeout).
- A node.js event loop blockage prevents the heartbeat from being sent.

Stalled jobs are moved to `failed` after `maxStalledCount` stalls. Jobs that
keep stalling without being moved to failed indicate a persistent processing
failure pattern.

**Fix**

```bash
# Check ingestion service logs for crash indicators:
docker compose -f docker/docker-compose.yml logs ingestion-service --tail=100

# Check for OOM kills:
docker inspect ingestion-service | \
  python3 -c "import sys,json; s=json.load(sys.stdin)[0]['State']; \
  print('OOMKilled:', s.get('OOMKilled'), 'ExitCode:', s.get('ExitCode'))"

# Inspect BullMQ queue state via Redis directly:
PASS=$(docker compose -f docker/docker-compose.yml run --rm \
  -v oneplatform_init-data:/data/init:ro \
  alpine cat /data/init/redis_password_ingestion.txt | tr -d '[:space:]')
docker compose -f docker/docker-compose.yml exec redis \
  redis-cli --user op_ingestion -a "$PASS" \
  LLEN "bull:ingestion:failed"

# Retry failed jobs via the BullMQ dashboard (if installed) or via direct API:
# POST /api/v1/admin/queues/ingestion/retry-failed

# Increase container memory limit in docker-compose.yml if OOM is the cause.
# For event-loop blockage, reduce concurrency:
# OP_INGESTION_BATCH_SIZE=250  (down from 1000 default)
# OP_LARGE_SYNC_CONCURRENCY=1  (down from 3 default)
```

---

### 4.4 Keys without TTL accumulating

**Symptom**

Redis memory grows unboundedly. `INFO keyspace` shows a large absolute key
count. Memory is not recovering even after reducing load.

**Cause**

Keys without a TTL are never evicted under `volatile-*` policies. Under
`allkeys-lru`, they are evicted only when memory pressure requires it. Causes:

- Application code writing a key without `EX`/`PX`/`EXAT` (missing TTL).
- An `SET` command that overwrites a key with a TTL, removing it silently.
- Orphaned BullMQ job metadata (completed jobs not cleaned up).

**Fix**

```bash
# Sample keys to find patterns without TTL:
# (Use SCAN, never KEYS in production)
docker compose -f docker/docker-compose.yml exec redis \
  redis-cli --user op_admin -a "$ADMIN_PASS" \
  SCAN 0 COUNT 500 | head -30
# Then check TTL on suspicious keys:
docker compose -f docker/docker-compose.yml exec redis \
  redis-cli --user op_admin -a "$ADMIN_PASS" TTL "suspect:key:name"
# TTL -1 means persistent (no expiry set). TTL -2 means key does not exist.

# For BullMQ: configure removeOnComplete and removeOnFail in job options
# to automatically clean completed/failed jobs after N entries or age.

# Manually expire a key that should not persist:
docker compose -f docker/docker-compose.yml exec redis \
  redis-cli --user op_admin -a "$ADMIN_PASS" EXPIRE "suspect:key:name" 3600
```

---

## 5. Queue Issues

### 5.1 Jobs stuck in waiting — no workers

**Symptom**

New jobs are enqueued but never processed. The `waiting` count grows. BullMQ
metrics show 0 active workers.

**Cause**

- The service that hosts the worker (ingestion, pipeline, app, logging) is
  crashed or unhealthy.
- The service started but failed to connect to Redis (ACL mismatch, network
  issue), preventing the worker from registering.
- `OP_INGESTION_BATCH_SIZE` or concurrency was set to 0 (invalid config rejected
  by Zod at startup, so the service would not be running — check logs).

**Fix**

```bash
# Check the relevant service is running and healthy:
docker compose -f docker/docker-compose.yml ps ingestion-service

# Check service logs for startup errors:
docker compose -f docker/docker-compose.yml logs ingestion-service --tail=50

# Check BullMQ worker registration via queue length comparison over time:
PASS=$(docker compose -f docker/docker-compose.yml run --rm \
  -v oneplatform_init-data:/data/init:ro \
  alpine cat /data/init/redis_password_ingestion.txt | tr -d '[:space:]')
docker compose -f docker/docker-compose.yml exec redis \
  redis-cli --user op_ingestion -a "$PASS" \
  LLEN "bull:ingestion:waiting"
# Run again after 30s — if count is unchanged and jobs are enqueued, no worker is active.

# Restart the worker service:
docker compose -f docker/docker-compose.yml restart ingestion-service
```

---

### 5.2 Dead-letter queue (DLQ) overflow

**Symptom**

```
ingestion-service | BullMQ: job <jobId> added to failed queue after 3 attempts
```

The `failed` queue length in BullMQ is growing. End-users see persistent sync
or pipeline execution failures.

**Cause**

BullMQ moves a job to the `failed` queue after exhausting its retry count. This
is expected for unrecoverable errors (e.g., a connector returns 401 permanently,
a schema validation failure). However, if the DLQ grows unboundedly it indicates
a recurring failure pattern that needs intervention — either a connector
credential is broken, a data format changed, or a target system is down.

**Fix**

```bash
# Get the count of failed jobs in each queue:
# Run for each service's password (ingestion, pipeline, app, logging):
docker compose -f docker/docker-compose.yml exec redis \
  redis-cli --user op_ingestion -a "$PASS" LLEN "bull:ingestion:failed"

# Inspect the first failed job's data and error:
docker compose -f docker/docker-compose.yml exec redis \
  redis-cli --user op_ingestion -a "$PASS" LRANGE "bull:ingestion:failed" 0 0

# Use the API to inspect specific job failures (replace <jobId>):
# GET /api/v1/admin/queues/ingestion/jobs/<jobId>

# After fixing the root cause (bad credentials, schema change):
# POST /api/v1/admin/queues/ingestion/retry-failed  -- retry all failed jobs
# POST /api/v1/admin/queues/ingestion/clean?grace=0&status=failed -- discard all
```

---

### 5.3 Duplicate job processing after stall recovery

**Symptom**

A job is processed twice. The same record appears duplicated in the database, or
a webhook fires twice for the same event.

**Cause**

When BullMQ recovers a stalled job, it re-adds it to the `waiting` queue. If
the original worker was not actually dead (slow network, event-loop hiccup)
and completes the job at the same time as the recovery worker, both workers
attempt to process the job. BullMQ uses Redis atomic operations to prevent
double-processing in normal cases, but at-least-once delivery is the guarantee
— exactly-once requires idempotency in the job handler.

**Fix**

Job handlers in ingestion and pipeline services must be idempotent. The standard
pattern is to use the job ID as an idempotency key in the database write:

```sql
INSERT INTO ingestion.sync_records (id, ...) VALUES ($1, ...)
ON CONFLICT (id) DO NOTHING;
```

If duplicates are already in the database:

```bash
# Identify duplicates (example for a hypothetical sync_records table):
docker compose -f docker/docker-compose.yml exec postgres \
  psql -U postgres -d oneplatform -c \
  "SELECT external_id, tenant_id, COUNT(*) FROM ingestion.sync_records
   GROUP BY external_id, tenant_id HAVING COUNT(*) > 1 LIMIT 20;"

# Increase lockDuration for long-running jobs to prevent premature stall detection:
# In the service's BullMQ worker options: { lockDuration: 60000 } (60 seconds)
```

---

## 6. Network Issues

### 6.1 Service can't reach another service

**Symptom**

```
gateway-service | Error: connect ECONNREFUSED auth-service:3000
gateway-service | FetchError: request to http://auth-service:3000/healthz failed
```

**Cause**

All application services communicate on the `oneplatform-internal` Docker
bridge network (`internal: true`, no host access). The `execution-service` also
needs `oneplatform-sandbox` to reach `docker-socket-proxy`. Services resolve
each other by Docker Compose service name (e.g., `http://auth-service:3000`).

Common causes:

- The target service is down or unhealthy (`docker compose ps` shows `unhealthy`).
- The calling service has an incorrect `SERVICE_MAP` URL in its environment
  (wrong service name or wrong port — all services listen on port 3000
  internally).
- The execution service was started without the `oneplatform-sandbox` network
  attachment, so it cannot reach `docker-socket-proxy` at `tcp://docker-socket-proxy:2375`.

**Fix**

```bash
# Check all service health statuses:
docker compose -f docker/docker-compose.yml ps

# Test connectivity between two containers (replace <source> and <target>):
docker compose -f docker/docker-compose.yml exec gateway-service \
  wget -qO- http://auth-service:3000/healthz

# Verify network attachments for a service:
docker inspect auth-service | python3 -c \
  "import sys,json; nets=json.load(sys.stdin)[0]['NetworkSettings']['Networks']; \
  [print(k) for k in nets]"
# Should show: oneplatform_oneplatform-internal
# execution-service should also show: oneplatform_oneplatform-sandbox

# Recreate the service to re-attach networks:
docker compose -f docker/docker-compose.yml up -d --force-recreate execution-service
```

---

### 6.2 Gateway returns 502 Bad Gateway

**Symptom**

```
HTTP/1.1 502 Bad Gateway
{"error":{"code":"SERVICE_UNAVAILABLE","message":"Upstream service unavailable"}}
```

**Cause**

The gateway proxies requests to upstream services using the `SERVICE_MAP`
environment variables (`AUTH_SERVICE_URL`, `INGESTION_SERVICE_URL`, etc.).
A 502 means the gateway connected to the upstream but the upstream failed to
respond (connection refused, reset, or timeout).

**Fix**

```bash
# Identify which upstream is failing from gateway logs:
docker compose -f docker/docker-compose.yml logs gateway-service --tail=50 | \
  grep -E "502|ECONNREFUSED|upstream"

# Check all upstream service health:
docker compose -f docker/docker-compose.yml ps

# Test the specific upstream directly from within the gateway container:
docker compose -f docker/docker-compose.yml exec gateway-service \
  wget -qO- http://auth-service:3000/healthz

# Verify SERVICE_MAP URLs are correct (all use port 3000):
docker compose -f docker/docker-compose.yml exec gateway-service \
  env | grep _SERVICE_URL

# Restart the failing upstream:
docker compose -f docker/docker-compose.yml restart auth-service
```

---

### 6.3 CORS errors in the browser

**Symptom**

Browser console shows:

```
Access to fetch at 'https://localhost/api/v1/...' from origin 'https://localhost'
has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present.
```

**Cause**

With Caddy as the TLS reverse proxy, both the frontend and the API are served
from the same origin (`https://localhost` in development, `https://your-domain`
in production). Same-origin requests do not trigger CORS at all in the normal
Caddy setup.

If you see CORS errors, the likely causes are:

1. `OP_ALLOWED_ORIGINS` is set to a stale value that does not match the actual
   domain being used (e.g., it still references `http://localhost:8080` from
   a pre-Caddy configuration).
2. A custom front-end dev server (e.g., Vite on port 5173) is running outside
   Docker and making requests to the API at `https://localhost`.

In production, wildcard (`*`) is rejected by the Zod schema (`originsSchema`
in `config.ts`) when `NODE_ENV=production`.

**Fix**

```bash
# For production — set OP_ALLOWED_ORIGINS to the actual public domain:
# OP_ALLOWED_ORIGINS=https://myapp.example.com

# For local dev with an out-of-Docker front-end (e.g., Vite on port 5173):
# OP_ALLOWED_ORIGINS=https://localhost:5173,https://localhost

# Recreate all services to pick up the new value:
docker compose -f docker/docker-compose.yml up -d --force-recreate

# Verify the header in a live response through Caddy:
curl -sk -v -H "Origin: https://localhost" https://localhost/api/v1/health 2>&1 | \
  grep -i "access-control"
```

---

### 6.4 Webhook delivery failures

**Symptom**

```
gateway-service | WebhookDeliveryError: HTTP targets are blocked (OP_WEBHOOK_ALLOW_HTTP=false)
gateway-service | WebhookDeliveryError: delivery failed for http://internal-server/hook
```

**Cause**

`OP_WEBHOOK_ALLOW_HTTP` defaults to `false` (defined in `gatewayConfigSchema`
in `config.ts`). Webhooks to `http://` endpoints are blocked. This is a
security default to prevent SSRF via webhook targets. All production webhook
endpoints must use `https://`.

In development or testing environments where HTTP targets are required (e.g.,
local webhook test servers), the setting must be explicitly enabled.

**Fix**

```bash
# For development only — enable HTTP webhook targets:
# In .env: OP_WEBHOOK_ALLOW_HTTP=true
# Then restart gateway:
docker compose -f docker/docker-compose.yml restart gateway-service

# To test webhook delivery manually (through Caddy):
curl -sk -X POST https://localhost/api/v1/webhooks/test \
  -H "Authorization: Bearer <token>" \
  -d '{"url":"https://webhook.site/..."}'

# Never set OP_WEBHOOK_ALLOW_HTTP=true in production — HTTP webhooks leak
# payload data and expose the platform to SSRF.
```

---

## 7. Docker and Container Issues

### 7.1 Container restart loop

**Symptom**

`docker compose ps` shows a service in `Restarting` state repeatedly:

```
NAME              IMAGE         STATUS                    PORTS
auth-service      ...           Restarting (1) 3s ago
```

**Cause**

Containers with `restart: unless-stopped` restart automatically on any non-zero
exit. The common causes:

- **Startup validation failure** (exit 1): secret file missing, Zod config
  error, MinIO password placeholder — see §1.1, §1.2.
- **OOM kill** (exit 137): container exceeded its memory limit
  (`deploy.resources.limits.memory`).
- **Read-only filesystem write** (exit 1): service code attempts to write
  outside of `/tmp` (tmpfs) or a declared volume. The `read_only: true`
  constraint is set on all application services.

**Fix**

```bash
# Check exit code and last log lines:
docker compose -f docker/docker-compose.yml logs auth-service --tail=30

# Check for OOM kill:
docker inspect auth-service | python3 -c \
  "import sys,json; s=json.load(sys.stdin)[0]['State']; \
  print('OOMKilled:', s.get('OOMKilled'), 'ExitCode:', s.get('ExitCode'))"
# OOMKilled: true → increase memory limit in docker-compose.yml

# Check for read-only filesystem errors (look for EROFS in logs):
docker compose -f docker/docker-compose.yml logs auth-service 2>&1 | grep -i "erofs\|read-only"
# If found: the service is writing to a path not covered by a tmpfs or volume mount.
# Fix: add a tmpfs mount or volume for that path in docker-compose.yml.

# Temporarily stop the restart loop to investigate:
docker compose -f docker/docker-compose.yml stop auth-service
docker compose -f docker/docker-compose.yml logs auth-service --tail=100
```

---

### 7.2 Volume permission errors

**Symptom**

```
auth-service | Error: EACCES: permission denied, open '/data/init/jwt.secret'
auth-service | Error: EACCES: permission denied, open '/data/app/uploads/...'
```

**Cause**

All secret files on `init-data` are written by `op-init` (running as root in
Alpine) with mode `0444`. Application service containers run as UID 1001 (set
in `Dockerfile.service`). The `init-data` volume is mounted read-only (`ro`),
and `service-entrypoint.sh` runs as the entrypoint shell before the Node.js
process inherits the UID. Mode `0444` (world-readable) allows the non-root
service UID to read secret files without running as root.

In practice, `service-entrypoint.sh` runs as the container's default user
(typically UID 1001 from the Dockerfile). If the file permissions on the init
volume were changed (e.g., by manually copying files), the service cannot read
them.

**Fix**

```bash
# Check file permissions on init-data:
docker compose -f docker/docker-compose.yml run --rm \
  -v oneplatform_init-data:/data/init:ro \
  alpine ls -la /data/init/

# Expected permissions: -r--r--r-- (0444) owned by root (UID 0)
# If permissions are wrong, fix them via op-init re-run:
docker compose -f docker/docker-compose.yml run --rm \
  -v oneplatform_init-data:/data/init \
  alpine chmod 0444 /data/init/*.txt /data/init/*.key /data/init/*.secret /data/init/*.token

# For app-data volume (UID 1001 must own it):
docker compose -f docker/docker-compose.yml run --rm \
  -v oneplatform_app-data:/data/app \
  --user root \
  alpine chown -R 1001:1001 /data/app

# Verify Dockerfile sets USER to 1001:
grep -n "USER" docker/Dockerfile.service
```

---

### 7.3 Docker socket proxy access denied

**Symptom**

```
execution-service | Error: connect ECONNREFUSED tcp://docker-socket-proxy:2375
execution-service | DockerError: connect EACCES /var/run/docker.sock
execution-service | Error: (HTTP code 403) unexpected — access forbidden
```

**Cause**

The execution service creates sandbox containers by connecting to
`docker-socket-proxy` (tecnativa/docker-socket-proxy) at
`tcp://docker-socket-proxy:2375`, set via `DOCKER_HOST` env var. The proxy
is configured to allow:

- `CONTAINERS=1` — create, list, inspect containers
- `IMAGES=1` — list and pull images
- `POST=1` — container creation
- `DELETE=1` — container deletion (the execution service explicitly removes
  sandbox containers after each run; `--rm` is not used because the service
  controls teardown timing to capture exit codes first)

If the execution service requests a Docker API endpoint the proxy is not
configured to allow (e.g., volume management, network management), the proxy
returns 403. If the execution service is not on `oneplatform-sandbox` network,
the connection is refused entirely.

**Fix**

```bash
# Check execution-service network membership:
docker inspect execution-service | python3 -c \
  "import sys,json; nets=json.load(sys.stdin)[0]['NetworkSettings']['Networks']; \
  [print(k) for k in nets]"
# Must include: oneplatform_oneplatform-sandbox

# Check docker-socket-proxy logs for denied requests:
docker compose -f docker/docker-compose.yml logs docker-socket-proxy --tail=30

# Test connectivity from execution-service:
docker compose -f docker/docker-compose.yml exec execution-service \
  wget -qO- http://docker-socket-proxy:2375/v1.41/containers/json

# If proxy is logging a 403 for a legitimate container operation,
# check the proxy's environment variables in docker-compose.yml:
# CONTAINERS=1, POST=1, IMAGES=1, DELETE=1 must all be set.
```

---

### 7.4 Build failures

**Symptom**

```
=> ERROR [service 7/8] RUN pnpm install --frozen-lockfile
#0 0.847 ERR_PNPM_OUTDATED_LOCKFILE: Cannot install with "frozen-lockfile"
```

Or:

```
=> ERROR [service 8/8] RUN pnpm run build
#0 12.4 ERROR: Cannot find module '@oneplatform/core'
```

**Cause**

- **Lockfile mismatch**: `pnpm-lock.yaml` is out of sync with `package.json`
  changes. The Dockerfile uses `--frozen-lockfile` to guarantee reproducible
  builds. Any `package.json` edit requires a `pnpm install` to update the lock
  file before building.

- **Node modules cache stale**: Docker layer cache has a node_modules layer
  from a previous build that doesn't reflect current dependencies. The build
  resolves packages from the stale cache, missing newly added workspace packages.

**Fix**

```bash
# Update the lockfile:
pnpm install  # from the repo root

# Rebuild without cache if modules are stale:
docker compose -f docker/docker-compose.yml build --no-cache auth-service

# Or rebuild all services:
docker compose -f docker/docker-compose.yml build --no-cache

# To rebuild only a specific service and restart it:
docker compose -f docker/docker-compose.yml up -d --build auth-service
```

### 7.X Vector container log collection fails on Docker Desktop (Mac / Windows / WSL2)

**Symptom**

The `oneplatform-vector` container starts but logs no output, or exits with:

```
Error reading directory: /var/lib/docker/containers — No such file or directory
```

**Cause**

`/var/lib/docker/containers` is the host path where Docker on **native Linux**
writes container JSON log files. On **Docker Desktop for Mac, Windows, and
WSL2**, the Docker daemon runs inside a hidden Linux VM and its container
filesystem is not mounted at this path on the host.

**Fix — Option A: Set `OP_DOCKER_DATA_ROOT` (WSL2 only)**

In WSL2, Docker Desktop may expose the container log directory via the WSL
virtual filesystem. Find the actual path:

```bash
# Run inside WSL2
ls /mnt/wsl/docker-desktop-data/data/docker/containers
```

If that directory exists, add to your `.env` file:

```
OP_DOCKER_DATA_ROOT=/mnt/wsl/docker-desktop-data/data/docker/containers
```

Then restart the stack:

```bash
docker compose -f docker/docker-compose.yml up -d vector
```

**Fix — Option B: Docker Desktop for Mac (Apple Silicon / Intel)**

The Docker VM filesystem is not directly accessible on macOS. You have two
options:

1. **Accept the limitation**: Vector log collection is disabled. Use
   `docker compose logs -f <service>` for local development. The application
   works fully without Vector.

2. **Use a syslog driver**: Configure the Docker logging driver in
   `docker-compose.yml` to write to a syslog socket that Vector can read via a
   Unix socket source. This requires changes to the Vector config and is only
   recommended if you specifically need structured log aggregation locally.

**Fix — Option C: Override `OP_DOCKER_DATA_ROOT` to an empty bind mount**

If you want Vector to run without errors but accept that it won't collect logs:

```bash
mkdir -p /tmp/docker-containers-empty
echo "OP_DOCKER_DATA_ROOT=/tmp/docker-containers-empty" >> .env
docker compose -f docker/docker-compose.yml up -d vector
```

**Verification**

```bash
docker compose -f docker/docker-compose.yml logs vector
# Should show Vector starting successfully with a "sources" line for docker_logs
```

---

## 8. Performance Issues

### 8.1 High API latency

**Symptom**

P95 request latency is high (>500ms). Gateway logs show slow upstream
responses. No errors, just slowness.

**Diagnosis and Fix**

Work through the layers systematically:

```bash
# Layer 1: PgBouncer pool saturation
# High cl_waiting means the bottleneck is DB connection contention:
PGBADMIN_PASS=$(docker compose -f docker/docker-compose.yml exec -T postgres \
  cat /data/init/db_password_pgbouncer_admin.txt | tr -d '[:space:]')
docker compose -f docker/docker-compose.yml run --rm \
  --network oneplatform_oneplatform-internal \
  postgres:16-alpine psql \
  "postgres://pgbouncer_admin:${PGBADMIN_PASS}@pgbouncer:5433/pgbouncer" \
  -c "SHOW POOLS;"
# If cl_waiting > 0 for any pool: see §3.1 (pool exhaustion)

# Layer 2: Redis slow commands
# SLOWLOG captures commands exceeding slowlog-log-slower-than (default 10ms):
docker compose -f docker/docker-compose.yml exec redis \
  redis-cli --user op_admin -a "$ADMIN_PASS" SLOWLOG GET 10

# Layer 3: Missing database indexes
# See §3.4 (slow queries section) for EXPLAIN ANALYZE workflow.

# Layer 4: Node.js event loop lag
# Check container CPU utilization:
docker stats --no-stream

# Layer 5: Container memory limits causing GC pressure
docker stats --no-stream --format "table {{.Name}}\t{{.MemUsage}}\t{{.MemPerc}}"
# If a service is at >80% of its memory limit, Node.js GC is running frequently.
# Increase the memory limit in docker-compose.yml for that service.
```

---

### 8.2 Memory pressure — container OOM or Node.js heap overflow

**Symptom**

Container is repeatedly OOM-killed (exit 137), or logs show:

```
auth-service | FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
auth-service | Aborted (core dumped)
```

**Cause**

Node.js has a default V8 heap limit of ~1.5 GB (64-bit). The container memory
limit in `docker-compose.yml` is set lower for most services (512m for gateway,
auth, ontology, logging, plugin; 1g for ingestion, pipeline, app; 2g for
execution). If Node.js heap grows to fill the container limit, Linux OOM-kills
the container.

**Fix**

```bash
# Confirm OOM kill:
docker inspect <service-name> | python3 -c \
  "import sys,json; s=json.load(sys.stdin)[0]['State']; print(s.get('OOMKilled'))"

# Check current memory usage per container:
docker stats --no-stream --format \
  "table {{.Name}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.MemLimit}}"

# Increase memory limit in docker-compose.yml:
# For ingestion-service processing large batches, 2g may be needed.
# Reduce OP_INGESTION_BATCH_SIZE to lower per-job memory usage instead:
# OP_INGESTION_BATCH_SIZE=250

# Set explicit Node.js heap limit to leave headroom for overhead:
# In the service's Dockerfile CMD or docker-compose.yml command:
# node --max-old-space-size=768 dist/index.js  (for a 1g container)
```

---

### 8.3 Disk full

**Symptom**

PostgreSQL write failures:

```
postgres | FATAL: could not write to file "pg_wal/...": No space left on device
```

Or MinIO upload failures:

```
ingestion-service | MinioError: upstream returned 500: disk full
```

Or Vector stops processing logs:

```
vector | Error flushing sink: No space left on device
```

**Cause**

The Docker host's disk fills from a combination of:

- **PostgreSQL WAL**: High write rate generates WAL faster than it can be
  checkpointed.
- **MinIO objects**: Data pipeline outputs accumulate in `minio-data` volume.
- **Vector log files**: Vector writes structured logs to `log-data` volume.
- **Docker overlay storage**: Each container's writable layer and named volumes
  share the host's Docker data root (typically `/var/lib/docker`).
- **Service JSON logs**: Docker's `json-file` driver retains up to 5×50 MB per
  container (set in `x-service-common` logging block = 250 MB max per service).

**Fix**

```bash
# Check host disk usage:
df -h /var/lib/docker

# Check Docker overlay storage breakdown:
docker system df -v

# Free space from stopped containers, dangling images, unused volumes:
# WARNING: only run this if you have confirmed nothing is in use
docker system prune -f

# Check PostgreSQL WAL size:
docker compose -f docker/docker-compose.yml exec postgres \
  psql -U postgres -c "SELECT pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), '0/0'));"
# Force checkpoint to reduce WAL retention:
docker compose -f docker/docker-compose.yml exec postgres \
  psql -U postgres -c "CHECKPOINT;"

# Identify large MinIO buckets:
docker compose -f docker/docker-compose.yml exec minio \
  du -sh /data/*

# Rotate Vector log files (Vector handles log-data volume):
docker compose -f docker/docker-compose.yml restart vector

# Check per-container log sizes:
find /var/lib/docker/containers -name "*.log" -exec du -sh {} \; | sort -h | tail -20
```

---

## 9. Data Issues

### 9.1 Credential decryption fails

**Symptom**

```
ingestion-service | CryptoError: Decryption failed: invalid authentication tag
ingestion-service | Error: Failed to decrypt connector credential for connector_id=<uuid>
```

**Cause**

Connector credentials are encrypted with the `OP_MASTER_KEY` (AES-256-GCM)
loaded from `/data/init/master.key`. If `op-init` is re-run and generates a new
`master.key`, or if the init volume is restored from backup with a different
key, all previously encrypted credentials become undecryptable. The old
ciphertext has an authentication tag computed against the old key — decryption
with the new key fails authentication.

**Fix**

```bash
# Confirm the master key on the volume matches what was used to encrypt:
# (Compare the key fingerprint, not the key itself)
docker compose -f docker/docker-compose.yml run --rm \
  -v oneplatform_init-data:/data/init:ro \
  alpine sh -c "cat /data/init/master.key | openssl dgst -sha256"

# If you have the original master.key backed up:
# 1. Stop all services
docker compose -f docker/docker-compose.yml stop

# 2. Replace the master.key on the volume with the original:
docker compose -f docker/docker-compose.yml run --rm \
  -v oneplatform_init-data:/data/init \
  alpine sh -c "echo '<original-key-value>' > /data/init/master.key && chmod 0444 /data/init/master.key"

# 3. Restart services
docker compose -f docker/docker-compose.yml start

# If the original key is lost, credentials must be re-entered by users.
# There is no recovery path — AES-256-GCM is not reversible without the key.

# To rotate the master key safely (without data loss):
# 1. Run the key rotation procedure via the admin API:
# POST /api/v1/admin/credentials/rotate-master-key
# (This re-encrypts all credentials with the new key atomically)
# 2. Only then replace master.key on the volume.
```

---

### 9.2 Tenant data isolation violation

**Symptom**

A user sees data belonging to another tenant. API response contains rows from
the wrong `tenant_id`.

**Cause**

Every table that stores tenant-scoped data includes a `tenant_id` column. Every
query must include `WHERE tenant_id = $1` (parameterized). An isolation
violation means a query was written without the tenant filter, or the filter was
removed during a refactor.

This is a **critical security issue** — treat it as a security incident.

**Fix**

```bash
# Immediately check whether the violation is query-layer or application-layer:
# Query PostgreSQL audit logs if pg_audit is enabled.

# Check which service returned the bad data (from gateway request logs):
docker compose -f docker/docker-compose.yml logs gateway-service | \
  grep "<request-id-from-client>"

# In the relevant service's query code, verify every SELECT on tenant-scoped
# tables includes: WHERE tenant_id = $tenantId (parameterized)

# Temporary mitigation: enable row-level security on the affected table:
docker compose -f docker/docker-compose.yml exec postgres \
  psql -U postgres -d oneplatform -c \
  "ALTER TABLE ingestion.raw_contacts ENABLE ROW LEVEL SECURITY;"

# File a P0 incident — cross-tenant data leakage is a privacy breach.
```

---

### 9.3 Orphaned records after entity deletion

**Symptom**

After deleting a connector, workspace, or pipeline, related records accumulate
in child tables. Disk usage grows despite deletions. Foreign key queries return
stale related data.

**Cause**

Entity deletion is designed to cascade through defined foreign key
`ON DELETE CASCADE` relationships. If a cascade is missing from a migration,
or a soft-delete pattern (setting `deleted_at`) is used without corresponding
cleanup jobs, child records become orphaned.

**Fix**

```bash
# Identify orphaned records (example: jobs with no parent pipeline):
docker compose -f docker/docker-compose.yml exec postgres \
  psql -U postgres -d oneplatform -c \
  "SELECT COUNT(*) FROM pipeline.jobs j
   WHERE NOT EXISTS (
     SELECT 1 FROM pipeline.pipelines p WHERE p.id = j.pipeline_id
   );"

# Clean up orphaned records (replace with actual table names):
docker compose -f docker/docker-compose.yml exec postgres \
  psql -U postgres -d oneplatform -c \
  "DELETE FROM pipeline.jobs j
   WHERE NOT EXISTS (
     SELECT 1 FROM pipeline.pipelines p WHERE p.id = j.pipeline_id
   );"

# Add the missing cascade in a migration:
# ALTER TABLE pipeline.jobs ADD CONSTRAINT fk_jobs_pipeline_id
#   FOREIGN KEY (pipeline_id) REFERENCES pipeline.pipelines(id) ON DELETE CASCADE;

# Check for soft-deleted records older than the retention period:
docker compose -f docker/docker-compose.yml exec postgres \
  psql -U postgres -d oneplatform -c \
  "SELECT COUNT(*) FROM app.apps WHERE deleted_at < NOW() - INTERVAL '30 days';"
```

---

## 10. Quick Reference: Diagnostic Commands

### Container Status

```bash
# All service statuses and health:
docker compose -f docker/docker-compose.yml ps

# Live resource usage (CPU, memory, network):
docker stats

# Follow logs for a specific service:
docker compose -f docker/docker-compose.yml logs -f auth-service

# Follow logs for all services simultaneously:
docker compose -f docker/docker-compose.yml logs -f
```

### Secret and Volume Inspection

```bash
# List all files on init-data volume:
docker compose -f docker/docker-compose.yml run --rm \
  -v oneplatform_init-data:/data/init:ro \
  alpine ls -la /data/init/

# Read a specific secret (example: jwt.secret):
docker compose -f docker/docker-compose.yml run --rm \
  -v oneplatform_init-data:/data/init:ro \
  alpine cat /data/init/jwt.secret

# List public keys on shared-pubkeys volume:
docker compose -f docker/docker-compose.yml run --rm \
  -v oneplatform_shared-pubkeys:/data/service-keys:ro \
  alpine ls -la /data/service-keys/
```

### PgBouncer Admin Console

```bash
# Connect to PgBouncer admin (replace $PGBADMIN_PASS):
docker compose -f docker/docker-compose.yml run --rm \
  --network oneplatform_oneplatform-internal \
  postgres:16-alpine psql \
  "postgres://pgbouncer_admin:${PGBADMIN_PASS}@pgbouncer:5433/pgbouncer"

# Useful admin queries (run inside the console):
# SHOW POOLS;         — pool utilization per database alias
# SHOW CLIENTS;       — active client connections
# SHOW SERVERS;       — active server connections
# SHOW STATS;         — query rates and averages
# SHOW CONFIG;        — current PgBouncer config values
# RECONNECT;          — force new server connections (after Postgres restart)
```

### Redis Diagnostics

```bash
# Read the admin password:
ADMIN_PASS=$(docker compose -f docker/docker-compose.yml run --rm \
  -v oneplatform_init-data:/data/init:ro \
  alpine cat /data/init/redis_password_admin.txt | tr -d '[:space:]')

# Connect to Redis as admin:
docker compose -f docker/docker-compose.yml exec redis \
  redis-cli --user op_admin -a "$ADMIN_PASS"

# Useful Redis commands:
# INFO all              — full server stats
# INFO memory           — memory usage breakdown
# INFO keyspace         — key counts per database
# SLOWLOG GET 20        — recent slow commands
# CLIENT LIST           — active client connections
# ACL LIST              — current ACL rules
# ACL WHOAMI            — current user identity
# DBSIZE                — total key count (admin only)
```

### PostgreSQL Diagnostics

```bash
# Connect as superuser:
docker compose -f docker/docker-compose.yml exec postgres \
  psql -U postgres -d oneplatform

# Useful queries:
# \dn            — list schemas
# \dp schema.*   — list permissions for schema tables
# SELECT * FROM pg_stat_activity WHERE state <> 'idle';
# SELECT * FROM pg_locks WHERE NOT granted;
# SELECT * FROM pg_stat_user_tables ORDER BY seq_scan DESC LIMIT 10;
# SELECT pg_size_pretty(pg_database_size('oneplatform'));
```

### Service Health Checks

All services expose `GET /healthz` on port 3000 (internal Docker network only).
External access goes through Caddy on port 443.

```bash
# Test any service health from inside a container (internal, no TLS):
docker compose -f docker/docker-compose.yml exec gateway-service \
  wget -qO- http://auth-service:3000/healthz

# Test the public gateway through Caddy:
curl -sk https://localhost/healthz

# Test the frontend through Caddy:
curl -sk https://localhost/
```

---

*For deployment configuration, see [DEPLOYMENT.md](./DEPLOYMENT.md).*  
*For architecture decisions referenced throughout this guide, see [decisions/001-architecture-decisions.md](./decisions/001-architecture-decisions.md).*
