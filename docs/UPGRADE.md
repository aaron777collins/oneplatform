# OnePlatform Upgrade and Migration Guide

This guide covers version upgrades, database migrations, secret rotation, and rollback
procedures for the OnePlatform Docker Compose stack. Read the entire section relevant to
your upgrade type before executing any command.

---

## Table of Contents

1. [Pre-Upgrade Checklist](#1-pre-upgrade-checklist)
2. [Upgrade Types](#2-upgrade-types)
3. [Standard Upgrade Procedure](#3-standard-upgrade-procedure)
4. [Database Migrations](#4-database-migrations)
5. [Secret Rotation](#5-secret-rotation)
6. [Configuration Changes](#6-configuration-changes)
7. [Rollback Procedures](#7-rollback-procedures)
8. [Zero-Downtime Upgrades](#8-zero-downtime-upgrades)
9. [Version Compatibility Matrix](#9-version-compatibility-matrix)
10. [Post-Upgrade Verification](#10-post-upgrade-verification)
11. [Migration Checklist Template](#11-migration-checklist-template)

---

## 1. Pre-Upgrade Checklist

Complete every item before touching the running stack. Skipping steps here is the most
common cause of painful rollbacks.

**Estimated time: 20–40 minutes**

### 1.1 Back up everything

Run from the repo root. The script backs up Postgres, Redis, and MinIO (requires `mc`
in PATH for MinIO).

```bash
# Create a timestamped backup in ./backups/
./docker/scripts/backup.sh ./backups

# Confirm the backup directory was created and contains postgres.dump and redis.rdb
ls -lh ./backups/$(ls -t ./backups | head -1)/

# Secure the backup — it contains all platform data including encrypted credentials
chmod 700 ./backups/$(ls -t ./backups | head -1)/
```

Expected output: `postgres.dump`, `redis.rdb`, and optionally `minio/` directory.

If something goes wrong: If `backup.sh` exits with an error, resolve it before continuing.
A failed backup means you have no recovery path. Common causes: Postgres container not
running, Redis unreachable, MinIO credentials not exported in environment.

### 1.2 Record your current running versions

```bash
# Record what is currently deployed
docker compose images

# Record the current git commit
git log --oneline -1

# Record the current .env values (redact secrets before sharing)
grep -v 'PASSWORD\|SECRET\|KEY\|TOKEN' .env
```

Save this output to a file. You will need it if you need to match the old state.

### 1.3 Verify the current stack is healthy

```bash
# All services should show healthy or running — no restarting containers
docker compose ps

# Spot-check the gateway health endpoint through Caddy
curl -sfk https://localhost/healthz | jq .
```

Do not upgrade a stack that has services in a restart loop or showing unhealthy. Fix
the existing problems first.

### 1.4 Read the changelog for the target version

```bash
git fetch origin
git log HEAD..origin/main --oneline
```

Look for:
- `BREAKING:` — requires action before or after upgrade
- `MIGRATION:` — database schema changes included
- `ENV:` — new or removed environment variables
- `SECURITY:` — security fixes that may require secret rotation

### 1.5 Diff `.env.example` between versions

```bash
git diff HEAD origin/main -- .env.example
```

Any new variables in `.env.example` that lack defaults in the Zod schema
(`packages/core/src/config.ts`) will cause service startup failures. Add them to your
`.env` before pulling the new code.

### 1.6 Test on staging first

Always run the full upgrade procedure on a staging environment before applying to
production. A staging environment can be a second Docker host running the same
`docker-compose.yml` with a recent copy of production data.

```bash
# On staging: restore a recent production backup
./docker/scripts/restore.sh ./backups/<timestamp> --yes
docker compose up -d
```

### 1.7 Notify users

Send a maintenance window notification. All in-progress pipeline executions and ingestion
jobs will be interrupted when services stop. Jobs are re-queued via BullMQ on restart,
but users should not initiate long-running operations during the window.

---

## 2. Upgrade Types

### 2.1 Patch upgrade (e.g., 1.2.3 → 1.2.4)

**What changes:** Bug fixes, security patches, dependency updates. No database schema
changes, no new required environment variables.

**Required actions:**
- Complete the pre-upgrade checklist (section 1)
- Follow the standard upgrade procedure (section 3)
- No migration steps needed

**Downtime:** Yes — rolling restart causes ~1–2 minutes of service interruption unless
you are running replicas (see section 8 for zero-downtime options).

**Data loss risk:** None, assuming healthy pre-upgrade state.

### 2.2 Minor upgrade (e.g., 1.2.x → 1.3.0)

**What changes:** New features, additive database migrations (new tables, new columns
with defaults), new optional or required environment variables.

**Required actions:**
- Complete the pre-upgrade checklist (section 1)
- Diff `.env.example` and add any new required variables to `.env`
- Follow the standard upgrade procedure (section 3)
- Verify that auto-run migrations completed successfully (section 4)

**Downtime:** Yes — typically 3–10 minutes including migration time.

**Data loss risk:** None for additive migrations. See section 4 for the small window
where a migration failure leaves schema in a partial state.

### 2.3 Major upgrade (e.g., 1.x → 2.0)

**What changes:** Breaking API changes, destructive schema changes (column renames, type
changes, dropped tables), removed or renamed environment variables, changed auth flows.

**Required actions:**
- Read the dedicated migration guide for the major version (linked in the changelog)
- Complete the pre-upgrade checklist (section 1)
- Perform manual pre-migration steps documented in the changelog
- Follow the standard upgrade procedure (section 3)
- Verify all post-upgrade checks (section 10)
- Notify downstream API consumers about breaking changes

**Downtime:** Plan for 30–60 minutes or more.

**Data loss risk:** Higher than minor upgrades. The changelog will call out specific
data loss risks. Read it entirely before starting.

---

## 3. Standard Upgrade Procedure

The stack uses a layered architecture. Always stop in reverse startup order and start in
forward startup order to prevent dependency failures.

**Startup order (reference):**
```
Layer 0: op-init (one-shot, secret generation)
Layer 1: postgres, redis, minio, docker-socket-proxy
Layer 2: pgbouncer
Layer 3: gateway, auth, ingestion, ontology, pipeline, execution, app, logging, plugin
Layer 4: frontend
Layer 5: caddy  (TLS reverse proxy — start last, stop first)
```

**Estimated total time:** 10–20 minutes for most upgrades. Allow extra time for major
version migrations.

### Step 1 — Take the pre-upgrade backup (5 minutes)

```bash
./docker/scripts/backup.sh ./backups
BACKUP_TS=$(ls -t ./backups | head -1)
echo "Backup created: ./backups/${BACKUP_TS}"
```

Record `BACKUP_TS` — you will need it if rollback is required.

If something goes wrong: If the backup fails, stop here and do not proceed.

### Step 2 — Pull new code (1 minute)

```bash
git fetch origin
git checkout main
git pull origin main

# Verify you are on the intended version
git log --oneline -1
```

### Step 3 — Update environment variables (varies)

```bash
# Diff .env.example to find new or changed variables
git diff HEAD~1 HEAD -- .env.example

# Edit .env to add any new required variables
# Do not change auto-generated secrets (OP_JWT_SECRET, OP_MASTER_KEY, etc.)
# those are managed by op-init and live on the init-data volume
```

See section 6 for detailed guidance on handling new required environment variables.

If something goes wrong: If you are unsure whether a new variable is required, check
`packages/core/src/config.ts`. Variables with `.min(1)` or without `.optional()` will
cause startup failures if absent.

### Step 4 — Stop frontend and application services (1–2 minutes)

Stop in reverse layer order. Data stores remain running throughout the upgrade so that
migrations can execute against a live database.

```bash
# Layer 5: stop Caddy first (cuts off all inbound public traffic)
docker compose stop caddy

# Layer 4: stop frontend
docker compose stop frontend

# Layer 3: stop all application services
docker compose stop \
  gateway-service \
  auth-service \
  ingestion-service \
  ontology-service \
  pipeline-service \
  execution-service \
  app-service \
  logging-service \
  plugin-service

# Verify all application services are stopped (not just stopping)
docker compose ps --format "table {{.Name}}\t{{.Status}}"
```

The 45-second `stop_grace_period` in `docker-compose.yml` means Docker sends SIGTERM and
waits up to 45 seconds for graceful shutdown before SIGKILL. Node.js with PID 1 (via
`exec node dist/index.js` in `service-entrypoint.sh`) will receive SIGTERM correctly.

Do NOT stop pgbouncer, postgres, redis, or minio. They must remain running for
migrations to execute.

If something goes wrong: If a service does not stop within 60 seconds, use
`docker compose kill <service>`. Forced kill may leave BullMQ jobs in an in-progress
state; they will be retried on next startup.

### Step 5 — Build new images (5–15 minutes)

```bash
# Build all service images from the updated source
# --no-cache on major upgrades to avoid stale layers; omit on patch upgrades for speed
docker compose build --parallel

# Verify images were rebuilt (timestamps should be current)
docker compose images
```

If something goes wrong: Build failures are safe — no running services were affected.
Check the build logs for errors (`docker compose build <service>` to isolate). If the
build is broken on the target commit, revert to the previous commit with
`git checkout <previous-commit>` and rebuild.

### Step 6 — Start data layer and pgbouncer (should already be running)

```bash
# Verify data stores are healthy before starting application services
docker compose ps postgres redis minio pgbouncer

# If any data store is not running, start it explicitly
docker compose up -d postgres redis minio pgbouncer

# Wait for all health checks to pass (usually 10–30 seconds)
docker compose ps --format "table {{.Name}}\t{{.Status}}"
```

If something goes wrong: If postgres will not start, check logs with
`docker compose logs postgres`. A failed startup often means a corrupt data volume or
a volume owned by a different user. Do not proceed until all data stores are healthy.

### Step 7 — Start application services (2–5 minutes including migrations)

```bash
# Start all application services. Each service auto-runs its database migrations
# on startup before accepting traffic.
docker compose up -d \
  auth-service \
  ingestion-service \
  ontology-service \
  pipeline-service \
  execution-service \
  app-service \
  logging-service \
  plugin-service \
  gateway-service

# Watch migration progress in real time
docker compose logs -f --since 0s \
  auth-service \
  ingestion-service \
  ontology-service \
  pipeline-service \
  execution-service \
  app-service \
  logging-service \
  plugin-service
```

Press Ctrl-C to detach from the log stream once you see `[service-entrypoint] Secrets
loaded` and the service's own startup log indicating it is listening on port 3000.

If something goes wrong: See section 4 for migration failure diagnosis and recovery.

### Step 8 — Wait for health checks (1–2 minutes)

```bash
# Poll until all services show (healthy) — exit when none are (starting)
until docker compose ps --format "{{.Status}}" | grep -v "healthy\|running" | grep -vE "^$" | grep -qv "Up"; do
  echo "Waiting for services to become healthy..."
  docker compose ps --format "table {{.Name}}\t{{.Status}}"
  sleep 5
done

# Final status check
docker compose ps
```

### Step 9 — Start frontend and Caddy (30 seconds)

```bash
docker compose up -d frontend caddy

# Verify both are healthy
docker compose ps frontend caddy

# Smoke test through Caddy (use -k in dev for self-signed cert)
curl -sfk https://localhost/ > /dev/null && echo "Frontend via Caddy: OK"
```

### Step 10 — Run post-upgrade verification (section 10)

Do not declare the upgrade complete until all post-upgrade checks pass.

---

## 4. Database Migrations

### 4.1 How migrations work

Each service owns its own PostgreSQL schema and runs its own migrations. There is no
central migration runner. Migrations execute automatically when a service container starts
for the first time with new code.

Key properties of the migration system:
- **Idempotent:** Re-running migrations does not corrupt data or fail on already-applied
  changes. Each migration is guarded by `IF NOT EXISTS` or explicit version tracking.
- **Forward-only:** Migrations only add or transform. They do not drop columns or tables
  unless a major version changelog explicitly documents the destructive operation.
- **Isolated:** A migration failure in `auth-service` does not block `ingestion-service`
  from starting. Each service fails independently and loudly.
- **Connection routing:** All migrations connect through PgBouncer (port 5433) using the
  service's own role (`auth_service_role`, `ingestion_service_role`, etc.). PgBouncer
  must be healthy before migrations can run.

### 4.2 Monitoring migration progress

```bash
# Watch a specific service's migration logs
docker compose logs -f auth-service

# Watch all services simultaneously
docker compose logs -f \
  auth-service ingestion-service ontology-service pipeline-service \
  execution-service app-service logging-service plugin-service

# Check whether a service is past migrations and serving requests (through Caddy)
curl -sfk https://localhost/healthz | jq .
```

Successful migration output looks like:
```
[service-entrypoint] Secrets loaded for auth-service. Starting node...
[auth-service] Running migrations...
[auth-service] Migration 001_create_users: OK
[auth-service] Migration 002_add_sessions: OK
[auth-service] All migrations complete.
[auth-service] Listening on port 3000
```

### 4.3 Diagnosing migration failures

A service that fails during migration will exit and Docker will restart it (due to
`restart: unless-stopped`). You will see a crash loop in `docker compose ps`.

```bash
# Identify which service is crash-looping
docker compose ps

# Read the full failure log (including the migration error)
docker compose logs --tail=100 <failing-service>

# Common migration failure patterns:
# 1. "column already exists" — migration is not fully idempotent; check for IF NOT EXISTS guards
# 2. "permission denied" — service role lacks DDL rights on its schema; check init.sql grants
# 3. "connection refused" — PgBouncer is not healthy; check pgbouncer container status
# 4. "duplicate key value" — seed/fixture data insertion without ON CONFLICT; check migration SQL
```

### 4.4 Manual migration execution

If a service crashes during auto-run migration and you need to run the migration
manually to diagnose or patch it:

```bash
# Connect to the service's database as the superuser (bypasses PgBouncer)
docker compose exec postgres psql -U postgres -d oneplatform

# Or connect as the service role to test exact permissions
docker compose exec postgres psql \
  -U auth_service_role \
  -d oneplatform \
  -h localhost

# List existing schema objects for the service
\dt auth.*

# Manually apply a specific migration (adjust path to match the service's migration file)
docker compose exec auth-service node -e "
  const { runMigrations } = require('./dist/db/migrations');
  runMigrations().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
"
```

### 4.5 Schema rollback

Migrations are forward-only. There is no automatic down-migration. To roll back a schema
change:

1. Stop the affected service: `docker compose stop <service>`
2. Restore from the pre-upgrade backup (see section 7)
3. Deploy the previous version of the service

If a partial migration left the schema in an inconsistent state and restore is not an
option, you must manually reverse the migration SQL. Document what the migration did
(add column, create index, etc.) and write a compensating SQL statement. Always test
compensating SQL on a copy of the database before running it in production.

Data loss risk: Rolling back a schema change that added a column drops any data written
to that column since the upgrade. This is unavoidable without a more complex dual-write
strategy (see section 8).

### 4.6 Ontology service migration timeout

The ontology service has an `OP_MIGRATION_TIMEOUT` variable (default 3600 seconds).
Large schema migrations that involve restructuring ontology graphs can take many minutes
on large datasets. If you expect a long migration:

```bash
# Temporarily increase the migration timeout in .env before starting the service
OP_MIGRATION_TIMEOUT=7200  # 2 hours

# Monitor progress
docker compose logs -f ontology-service
```

---

## 5. Secret Rotation

### 5.1 Understanding the secret architecture

Secrets are divided into two categories:

**Volume-managed secrets** (generated by `op-init`, stored on `init-data` volume):
- `OP_JWT_SECRET` → `/data/init/jwt.secret`
- `OP_MASTER_KEY` → `/data/init/master.key`
- `OP_CURSOR_SECRET` → `/data/init/cursor.secret`
- Per-service DB passwords → `/data/init/db_password_<service>.txt`
- Per-service Redis passwords → `/data/init/redis_password_<service>.txt`
- Ed25519 private keys → `/data/init/keys/<service-name>/private.pem`
- Ed25519 public keys → `/data/service-keys/<service-name>.pub`

**Environment-managed secrets** (set in `.env`):
- `OP_MINIO_PASSWORD` — MinIO admin password
- `POSTGRES_PASSWORD` — Postgres superuser password

`op-init` is designed to run once. It skips any secret that already has a file in
`/data/init/`. To rotate a secret you must replace the file directly, then restart the
affected services.

### 5.2 Ed25519 service-to-service key rotation

Ed25519 keys authenticate service-to-service calls via signed JWTs. The deployment order
matters: services that verify tokens must receive the new public key before services that
sign tokens switch to the new private key. Reversing this order causes a window where
signature verification fails across the cluster.

**Estimated time:** 10–15 minutes

**Deploy public key first, then private key:**

```bash
# Step 1: Generate a new key pair (example for auth-service; repeat per service)
SERVICE_NAME="auth-service"

# Create a temporary directory for the new pair
mkdir -p /tmp/op-key-rotation/${SERVICE_NAME}

# Generate new Ed25519 private key
openssl genpkey -algorithm Ed25519 \
  -out /tmp/op-key-rotation/${SERVICE_NAME}/private.pem
chmod 0400 /tmp/op-key-rotation/${SERVICE_NAME}/private.pem

# Derive the new public key
openssl pkey \
  -in /tmp/op-key-rotation/${SERVICE_NAME}/private.pem \
  -pubout \
  -out /tmp/op-key-rotation/${SERVICE_NAME}/${SERVICE_NAME}.pub
chmod 0444 /tmp/op-key-rotation/${SERVICE_NAME}/${SERVICE_NAME}.pub

# Step 2: Copy the NEW public key into the shared-pubkeys volume
# All verifying services read from this volume at request time (not at startup),
# so they will immediately start accepting tokens signed by the new private key.
# Tokens signed by the OLD private key remain valid until all services are restarted.
docker compose cp \
  /tmp/op-key-rotation/${SERVICE_NAME}/${SERVICE_NAME}.pub \
  gateway-service:/data/service-keys/${SERVICE_NAME}.pub

# The shared-pubkeys volume is mounted at /data/service-keys on every service.
# Copying to one service's mount point updates the shared volume for all services.

# Verify the public key was updated
docker compose exec gateway-service \
  cat /data/service-keys/${SERVICE_NAME}.pub

# Step 3: Replace the private key on the init-data volume
docker compose cp \
  /tmp/op-key-rotation/${SERVICE_NAME}/private.pem \
  auth-service:/data/init/keys/${SERVICE_NAME}/private.pem

# Step 4: Restart the service that signs with the new private key
# service-entrypoint.sh re-reads OP_SERVICE_PRIVATE_KEY_PATH from the volume on startup
docker compose restart ${SERVICE_NAME}

# Step 5: Verify the restarted service is healthy
docker compose ps ${SERVICE_NAME}
curl -sfk https://localhost/healthz | jq .

# Step 6: Clean up the temporary key material from disk
rm -rf /tmp/op-key-rotation/${SERVICE_NAME}
```

If something goes wrong: If the restarted service cannot authenticate outbound calls,
it means the public key copy (step 2) or the private key copy (step 3) failed. Check
the file contents with `docker compose exec <service> cat /data/service-keys/<service>.pub`.
Restore the old key pair from your backup and restart.

### 5.3 JWT secret rotation

Rotating `OP_JWT_SECRET` invalidates all active user sessions. Every logged-in user will
be signed out and forced to re-authenticate. Plan this during a low-traffic window.

**Estimated time:** 5 minutes + user re-authentication disruption

```bash
# Step 1: Generate a new JWT secret (32 bytes hex = 64 characters)
NEW_JWT_SECRET=$(openssl rand -hex 32)
echo "New JWT secret: ${NEW_JWT_SECRET}"  # Save this temporarily

# Step 2: Back up the old secret
docker compose exec auth-service cat /data/init/jwt.secret > /tmp/old-jwt-secret.txt
chmod 0400 /tmp/old-jwt-secret.txt

# Step 3: Write the new secret to the init-data volume
# Use a temporary file to avoid shell argument injection
echo -n "${NEW_JWT_SECRET}" > /tmp/new-jwt-secret.txt
docker compose cp /tmp/new-jwt-secret.txt auth-service:/data/init/jwt.secret
rm /tmp/new-jwt-secret.txt

# Step 4: Restart all application services (they all read OP_JWT_SECRET at startup)
docker compose restart \
  auth-service \
  gateway-service \
  ingestion-service \
  ontology-service \
  pipeline-service \
  execution-service \
  app-service \
  logging-service \
  plugin-service

# Step 5: Verify all services are healthy
docker compose ps

# Step 6: All existing JWT tokens are now invalid. Users must log in again.
```

If something goes wrong: If services fail to start after rotation, check for an empty
or malformed jwt.secret file. The Zod schema (`OP_JWT_SECRET: z.string().min(32)`)
will cause services to fail with a clear error in their logs. Restore the old secret
from `/tmp/old-jwt-secret.txt` and restart.

### 5.4 Master key rotation (credential re-encryption)

`OP_MASTER_KEY` is an AES-256-GCM master key that encrypts stored connector credentials.
The `packages/core` encryption layer supports multi-version key rotation: credentials
encrypted with the old key are decrypted, then re-encrypted with the new key. The old
key must remain available until all credentials are migrated.

This is the most complex secret rotation. The multi-version support means there is no
instant cutover — both keys coexist during the migration window.

**Estimated time:** 15–60 minutes depending on the number of stored credentials

**Data loss risk:** High. If rotation fails midway and you cannot decrypt credentials,
users lose access to all stored connector configurations. Take a full backup immediately
before starting.

```bash
# Step 1: Full backup (MANDATORY — do not skip)
./docker/scripts/backup.sh ./backups
BACKUP_TS=$(ls -t ./backups | head -1)
echo "Backup: ./backups/${BACKUP_TS}"

# Step 2: Generate a new master key
NEW_MASTER_KEY=$(openssl rand -base64 32)
echo "New master key: ${NEW_MASTER_KEY}"  # Save this securely

# Step 3: Back up the current master key
docker compose exec auth-service cat /data/init/master.key > /tmp/old-master-key.txt
chmod 0400 /tmp/old-master-key.txt

# Step 4: Write the new key to the volume
echo -n "${NEW_MASTER_KEY}" > /tmp/new-master-key.txt
docker compose cp /tmp/new-master-key.txt auth-service:/data/init/master.key
rm /tmp/new-master-key.txt

# Step 5: Restart services that use credential encryption
# These services read OP_MASTER_KEY from the volume at startup.
# The multi-version key rotation logic handles re-encryption automatically.
docker compose restart \
  ingestion-service \
  pipeline-service \
  execution-service

# Step 6: Trigger credential re-encryption
# Each service exposes an admin endpoint to re-encrypt stored credentials.
# The old key value (still available in /tmp/old-master-key.txt) must be passed
# so the service can decrypt credentials encrypted under the old key.
# See the Admin API documentation for the exact endpoint signature.

# Step 7: Verify re-encryption completed
# Check service logs for "credential re-encryption complete" messages
docker compose logs --tail=200 ingestion-service | grep -i "re-encrypt\|master.key"

# Step 8: Remove the old key backup only after re-encryption is confirmed complete
# rm /tmp/old-master-key.txt
```

If something goes wrong: If re-encryption fails midway, services still hold the new
`OP_MASTER_KEY` but some credentials are encrypted under the old key. Restore the old
key immediately: `docker compose cp /tmp/old-master-key.txt auth-service:/data/init/master.key`
then restart affected services. Do not delete the old key backup until re-encryption is
fully confirmed.

### 5.5 MinIO password rotation

`OP_MINIO_PASSWORD` is set in `.env` and injected as an environment variable (not stored
on the `init-data` volume). Rotation requires updating both MinIO and the env var.

```bash
# Step 1: Generate new password
NEW_MINIO_PASSWORD=$(openssl rand -hex 32)

# Step 2: Update MinIO root credentials via mc
mc alias set op-local http://localhost:9000 minioadmin "${OP_MINIO_PASSWORD}"
mc admin user add op-local minioadmin "${NEW_MINIO_PASSWORD}"
# Note: MinIO credential update requires specific mc version; consult MinIO docs

# Step 3: Update .env
# Edit .env and set OP_MINIO_PASSWORD to the new value

# Step 4: Restart all services that use MinIO
# service-entrypoint.sh validates OP_MINIO_PASSWORD is not a placeholder on startup
docker compose up -d --force-recreate \
  gateway-service auth-service ingestion-service ontology-service \
  pipeline-service execution-service app-service logging-service plugin-service
```

---

## 6. Configuration Changes

### 6.1 Identifying required new variables

When upgrading, new variables added to `packages/core/src/config.ts` without a default
will cause service startup failures. The error message is explicit:

```
Configuration validation failed:
  OP_NEW_REQUIRED_VAR: Required
```

The complete set of validated variables per service is defined in the service-specific
schema (e.g., `gatewayConfigSchema`, `authConfigSchema`). Each service only validates
its own vars — a missing var for gateway-service does not affect auth-service.

```bash
# Diff the config schema between versions to see new required vars
git diff HEAD~1 HEAD -- packages/core/src/config.ts

# Check whether a new var has a default (safe) or is required (needs .env update)
# Pattern: z.string().min(1) with no .default() or .optional() = REQUIRED
# Pattern: .optional() or .default('value') = safe to omit
grep -A3 'OP_NEW_VAR' packages/core/src/config.ts
```

### 6.2 Applying environment variable changes

```bash
# Edit .env to add new variables (use .env.example as the reference)
vim .env

# Verify the var is present
grep OP_NEW_VAR .env

# Recreate only affected services (faster than full restart)
docker compose up -d --force-recreate gateway-service
```

### 6.3 Handling renamed or removed variables

If a variable was renamed or removed between versions:

```bash
# Check the service logs for the Zod validation error message
docker compose logs gateway-service | grep "Configuration validation"

# Identify the old name vs new name from the diff
git diff HEAD~1 HEAD -- packages/core/src/config.ts | grep '^[+-].*OP_'

# Update .env accordingly
```

If a variable was removed: Remove it from `.env` to keep the file clean, but leaving an
unused variable in `.env` is harmless — it is ignored.

### 6.4 Zod validation failures on startup

When a service exits immediately after startup with a non-zero exit code, read the logs:

```bash
docker compose logs --tail=50 auth-service
```

A Zod validation failure produces output like:

```
Configuration validation failed:
  OP_JWT_SECRET: String must contain at least 32 character(s)
  OP_DATABASE_URL: Invalid url
```

Each line maps directly to a field in the service's Zod schema. Fix the value in `.env`
or the relevant secret file, then restart the service.

---

## 7. Rollback Procedures

### 7.1 Full rollback from backup

Use this when the upgrade caused data corruption, migration failures that cannot be
resolved forward, or widespread service failures.

**Estimated time:** 15–30 minutes

**Data loss risk:** All data written since the backup was taken will be lost.

```bash
# Step 1: Stop all application services (leave data stores running)
docker compose stop \
  frontend \
  gateway-service auth-service ingestion-service ontology-service \
  pipeline-service execution-service app-service logging-service plugin-service

# Step 2: Restore from backup (confirm the backup timestamp)
ls ./backups/
./docker/scripts/restore.sh ./backups/<BACKUP_TS> --yes

# restore.sh stops and restarts Redis automatically.
# It restores Postgres (via pg_restore --clean --if-exists) and MinIO (via mc mirror).
# Non-fatal pg_restore warnings about objects that do not yet exist are normal.

# Step 3: Check out the previous code version
git log --oneline -5  # Find the previous commit hash
git checkout <previous-commit-hash>

# Step 4: Rebuild images from the previous code
docker compose build --parallel

# Step 5: Start application services
docker compose up -d \
  auth-service ingestion-service ontology-service pipeline-service \
  execution-service app-service logging-service plugin-service gateway-service

# Step 6: Wait for health checks
docker compose ps

# Step 7: Start frontend
docker compose up -d frontend

# Step 8: Verify health (section 10)
```

If something goes wrong during restore: If `pg_restore` reports that the database is
unreachable after restore, the dump file may be corrupt. Check `postgres.dump` integrity:
`pg_restore -l ./backups/<BACKUP_TS>/postgres.dump | head -20`. If the dump is unreadable,
you need a different backup set.

### 7.2 Partial rollback — revert a specific service

Use this when only one service is malfunctioning and others are healthy.

```bash
# Step 1: Stop the failing service
docker compose stop ingestion-service

# Step 2: Check out the previous service code
# (In a monorepo this requires checking out the whole repo at the previous commit,
# then rebuilding only the affected service)
git stash  # Or use a feature branch approach

# Step 3: Rebuild only the affected service image
docker compose build ingestion-service

# Step 4: Start the reverted service
docker compose up -d ingestion-service

# Step 5: Verify it is healthy
docker compose ps ingestion-service
docker compose logs --tail=50 ingestion-service
```

If the service ran a database migration before failing: You cannot safely run the old
service code against a schema that was partially migrated by the new code. You must
perform a full rollback (section 7.1) in this case.

### 7.3 Database rollback considerations

The migration system is forward-only. After a service applies migrations on startup, the
database schema is at the new version. If you revert the service image without restoring
the database, the old service code runs against the new schema.

Safe revert scenarios:
- The new version's migrations were purely additive (new columns with defaults, new tables)
  and the old service code ignores unknown columns. This is usually safe but requires
  verification.

Unsafe revert scenarios:
- The new version renamed a column, changed a column type, or dropped objects that the
  old service code expects. Always restore the database from backup in this case.

### 7.4 Assessing data loss before rollback

```bash
# Estimate how much data was written since the backup was taken
# (requires a Postgres connection)

# Data written to auth schema since backup timestamp
docker compose exec postgres psql -U postgres -d oneplatform -c "
  SELECT schemaname, relname, n_live_tup
  FROM pg_stat_user_tables
  WHERE schemaname IN ('auth', 'ingestion', 'ontology', 'pipeline', 'execution', 'app', 'logging', 'plugin')
  ORDER BY n_live_tup DESC;
"

# Check ingestion job completions since the backup (adjust timestamp)
docker compose exec postgres psql -U postgres -d oneplatform -c "
  SELECT COUNT(*) FROM ingestion.jobs
  WHERE completed_at > '2026-06-17 10:00:00'::timestamptz;
"
```

This gives an upper bound on data loss. Share this estimate with stakeholders before
proceeding with rollback.

---

## 8. Zero-Downtime Upgrades

The single-node Docker Compose stack does not support true zero-downtime upgrades because
there is only one container per service. The techniques in this section reduce downtime or
eliminate it when running in Docker Swarm or with a load balancer.

### 8.1 Migration compatibility requirement

Zero-downtime upgrades require that new migrations are backward-compatible with the
previous service version. Specifically:
- New columns must have defaults (the old service code does not write them, which is fine)
- No columns renamed or removed until a subsequent major version
- No type changes on existing columns
- New tables are always safe

If a migration is backward-incompatible, the old service instance will fail while the
new version's migration is running. There is no workaround for this in the Docker Compose
single-node configuration; take a maintenance window instead.

### 8.2 Rolling update strategy (Docker Swarm)

With Docker Swarm and `deploy.replicas: 2` (set in a Swarm-specific overlay), you can
perform a rolling update:

```bash
# Deploy updated stack to Swarm (rolling update by default)
docker stack deploy \
  -c docker/docker-compose.yml \
  -c docker/docker-compose.prod.yml \
  op

# Monitor the rolling update
docker stack ps op --filter desired-state=running
```

The Swarm scheduler updates one replica at a time, waits for it to be healthy, then
updates the next. The gateway continues serving traffic from the healthy replica during
the transition.

Note: `docker-compose.prod.yml` intentionally does not set `deploy.replicas`. The
`deploy:` key is silently ignored by standalone Docker Compose (see comment in
`docker-compose.prod.yml`). Replicas only take effect in Swarm mode.

### 8.3 Blue-green deployment pattern

For a full blue-green approach on a single host, the traffic switchover happens
at the Caddy/DNS level — not by rebinding host ports. Neither gateway-service
nor frontend binds host ports, so port-based cutover is not available.

```bash
# The "blue" stack (current) uses the default project name
# Start the "green" stack with a different project name

cd /path/to/oneplatform

# Copy .env for the green stack (no port changes needed — Caddy handles routing)
cp .env .env.green

# Start the green stack (it shares the same internal Docker networks
# as the blue stack, or uses an isolated project with its own networks)
docker compose --project-name op-green --env-file .env.green up -d \
  postgres redis minio pgbouncer \
  gateway-service auth-service ingestion-service ontology-service \
  pipeline-service execution-service app-service logging-service plugin-service \
  frontend

# Wait for green stack to be healthy
docker compose --project-name op-green ps

# Switch traffic at the Caddy or DNS level:
#   - For Caddy: update the upstream in the Caddyfile and reload
#     (e.g., change gateway-service to op-green_gateway-service:3000)
#   - For DNS: update the A record to point at the green host

# Once traffic is fully on green, stop the blue stack
docker compose --project-name op down
```

Green stack database migrations: The green stack must point at the same Postgres
instance (or a copy). If it shares the same Postgres, its migrations will run on the
shared database. If old-version service code is still running against the newly-migrated
schema, see section 8.1 for compatibility requirements.

---

## 9. Version Compatibility Matrix

### 9.1 Service version compatibility rules

All 9 services share the same codebase and are built from the same commit in the
monorepo. Running services from different commits is not supported and not tested.

The only supported configuration is: all services at the same version.

### 9.2 API versioning

The external API is versioned at the URL level: `/api/v1/`. A version 2 API (when
introduced) will coexist at `/api/v2/`. Breaking changes are never introduced within a
minor version series.

```bash
# Check which API version the gateway is serving (through Caddy)
curl -sk https://localhost/api/v1/health
```

### 9.3 SDK and CLI version compatibility

The `@oneplatform/sdk` and `@oneplatform/cli` packages are versioned independently and
follow semantic versioning relative to the service API.

| SDK/CLI version | Compatible service versions |
|---|---|
| 1.x | Any 1.x service version |
| 2.x | Any 2.x service version |

Breaking SDK changes (new major version) are accompanied by a migration guide in the
SDK package changelog.

### 9.4 Plugin compatibility

Plugins are loaded by `plugin-service` and call the platform via `@oneplatform/plugin-sdk`.
Plugin compatibility follows the same semver contract as the SDK: plugins built against
the `1.x` plugin-sdk are compatible with any `1.x` service version.

When upgrading from `1.x` to `2.x`, plugin authors must update to the new plugin-sdk
and republish. The admin console shows a compatibility warning for plugins built against
a previous major version.

---

## 10. Post-Upgrade Verification

Run these checks immediately after every upgrade. If any check fails, investigate before
declaring the upgrade complete.

**Estimated time:** 10 minutes

### 10.1 Health check all services

```bash
# All services should show (healthy) — none should show (unhealthy) or be restarting
docker compose ps

# Verify the gateway reports all backends healthy (through Caddy)
curl -sfk https://localhost/healthz | jq .
```

If a service shows (unhealthy): Read its logs — `docker compose logs --tail=100 <service>`.
Health check failures immediately after upgrade are most commonly caused by a
configuration validation failure (new required env var) or a migration that did not
complete.

### 10.2 Auth flow verification

```bash
# Verify the auth service responds (through Caddy)
curl -sfk https://localhost/api/v1/auth/health | jq .

# Attempt login (use real credentials from your instance)
curl -sfk -X POST https://localhost/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email": "admin@example.com", "password": "your-admin-password"}' \
  | jq '.token // "LOGIN FAILED"'

# Verify a protected endpoint with the returned token
TOKEN="<token from above>"
curl -sfk https://localhost/api/v1/connectors \
  -H "Authorization: Bearer ${TOKEN}" \
  | jq 'length'
```

### 10.3 Database connectivity

```bash
# Verify PgBouncer connection pooling is functional for each service
# (The gateway health endpoint exercises this internally, through Caddy)
curl -sfk https://localhost/api/v1/health | jq '.database'

# Direct PgBouncer check
docker compose exec pgbouncer psql \
  -h localhost -p 5433 -U pgbouncer_stats pgbouncer \
  -c "SHOW POOLS;" 2>/dev/null | head -20
```

### 10.4 Queue processing

```bash
# Verify BullMQ workers are running and processing jobs
# (Requires the logging service to be capturing queue events)
curl -sfk https://localhost/api/v1/admin/queues \
  -H "Authorization: Bearer ${TOKEN}" \
  | jq '.queues[] | {name: .name, waiting: .waiting, active: .active, failed: .failed}'
```

A non-zero `failed` count that was zero before the upgrade indicates migration-related
job failures. Check the failed jobs for the error message.

### 10.5 Log aggregation

```bash
# Verify Vector is collecting logs from running containers
docker compose ps vector
docker compose logs --tail=20 vector

# Verify logs are being written to the log-data volume
docker compose exec vector ls -la /var/log/oneplatform/
```

### 10.6 Ingestion pipeline smoke test

```bash
# Submit a minimal test ingestion job (through Caddy)
curl -sfk -X POST https://localhost/api/v1/ingestion/jobs \
  -H "Authorization: Bearer ${TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{"connector_id": "<test-connector-uuid>", "mode": "full"}' \
  | jq '{job_id: .id, status: .status}'

# Poll the job status until it reaches success or failed
JOB_ID="<job_id from above>"
curl -sfk https://localhost/api/v1/ingestion/jobs/${JOB_ID} \
  -H "Authorization: Bearer ${TOKEN}" \
  | jq '{status: .status, error: .error}'
```

### 10.7 Ed25519 service-to-service auth

```bash
# Verify service-to-service tokens work by triggering a cross-service call
# The gateway proxies requests to backend services using X-Service-Token headers
curl -sfk https://localhost/api/v1/ontology/schemas \
  -H "Authorization: Bearer ${TOKEN}" \
  | jq 'length'
```

A `401 Unauthorized` from a backend service (not the gateway) indicates a key mismatch
after rotation. Check that public keys on the shared-pubkeys volume match the private
keys services are using.

---

## 11. Migration Checklist Template

Copy this template for each upgrade. Fill in actuals as you go. Keep the completed
checklist in your incident log.

```
================================================================================
OnePlatform Upgrade Checklist
================================================================================
Date:                 _______________
Operator:             _______________
From version:         _______________
To version:           _______________
Upgrade type:         [ ] Patch  [ ] Minor  [ ] Major
Maintenance window:   _______________  to  _______________

PRE-UPGRADE
[ ] Backup created at: ./backups/_______________
    - postgres.dump:   [ ] present  size: _______
    - redis.rdb:       [ ] present  size: _______
    - minio/:          [ ] present  [ ] skipped (mc not installed)
[ ] Backup directory secured: chmod 700 ./backups/_______________
[ ] Stack verified healthy before upgrade: docker compose ps
[ ] Changelog reviewed — breaking changes noted: _______________
[ ] .env.example diff reviewed — new vars added to .env: _______________
[ ] Staging upgrade completed successfully: [ ] yes  [ ] skipped (patch only)
[ ] User notification sent: _______________

UPGRADE
[ ] Step 1: Backup taken (see above)
[ ] Step 2: New code pulled — git commit: _______________
[ ] Step 3: .env updated with new variables (if any): _______________
[ ] Step 4: Caddy stopped (cuts inbound traffic)
[ ] Step 4: Frontend stopped
[ ] Step 4: Application services stopped
[ ] Step 5: New images built — build time: _______
[ ] Step 6: Data stores healthy (postgres, redis, minio, pgbouncer)
[ ] Step 7: Application services started
[ ] Step 7: Migration logs reviewed — all migrations: [ ] OK  [ ] errors (see notes)
[ ] Step 8: All services healthy
[ ] Step 9: Frontend and Caddy started

POST-UPGRADE VERIFICATION
[ ] docker compose ps — all healthy: [ ] yes  [ ] no
[ ] GET /healthz — 200: [ ] yes  [ ] no
[ ] Auth flow (login + token): [ ] yes  [ ] no
[ ] Database connectivity check: [ ] yes  [ ] no
[ ] Queue processing check: [ ] yes  [ ] no
[ ] Log aggregation check: [ ] yes  [ ] no
[ ] Ingestion smoke test: [ ] yes  [ ] no  [ ] skipped
[ ] Service-to-service auth check: [ ] yes  [ ] no

OUTCOME
[ ] Upgrade completed successfully
[ ] Rollback performed — reason: _______________
    - Rollback type: [ ] Full (from backup)  [ ] Partial (single service)
    - Backup restored: ./backups/_______________
    - Data loss window: _______________  to  _______________

NOTES
_______________
________________________________________________________________________________
```

---

## Reference: Secret Files on the init-data Volume

The following files are generated by `op-init` and read by `service-entrypoint.sh`:

| File | Purpose | Consumers |
|---|---|---|
| `/data/init/ready` | Startup gate (health check) | All services |
| `/data/init/master.key` | AES-256-GCM master encryption key | All services |
| `/data/init/jwt.secret` | JWT signing secret (HS256) | All services |
| `/data/init/cursor.secret` | HMAC-SHA256 cursor secret | All services |
| `/data/init/bootstrap.token` | One-time admin bootstrap token | auth-service (deleted after use) |
| `/data/init/db_password_<svc>.txt` | Per-service Postgres role password | `<svc>-service`, pgbouncer |
| `/data/init/redis_password_<svc>.txt` | Per-service Redis ACL password | `<svc>-service` |
| `/data/init/keys/<svc>-service/private.pem` | Ed25519 private signing key | `<svc>-service` |
| `/data/service-keys/<svc>-service.pub` | Ed25519 public verification key | All services |

`op-init` will not overwrite existing files. To force regeneration of a secret,
delete the corresponding file and run `docker compose run --rm op-init`. This only
affects the specific secret whose file was deleted — all others are preserved.
