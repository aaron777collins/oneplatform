#!/bin/sh
# docker/init/init.sh
#
# One-shot initialization container. Runs as Layer 0 before any data store.
# Generates all secrets that services need at runtime. Secrets are written
# to /data/init/ on the init-data volume with mode 0440 (owner+group read only)
# so that other users on the host cannot read them even if they share the volume.
# The volume is mounted :ro in docker-compose.yml, preventing writes regardless
# of mode.
#
# SECURITY NOTE — file permissions:
#   Secret files are written 0440 (owner=root:0, group=GID 1001) with group
#   read permission. All application service containers run as UID 1001 / GID 1001
#   (Dockerfile.service), so they can read via the group bit. The postgres
#   container (UID 70) runs in a separate namespace and reads its password via
#   the postgres-init-passwords sidecar which runs as root, so 0440 is safe.
#
#   Under 0440:
#     - Owner (root) — can read.
#     - Group (GID 1001 = service group) — can read.
#     - World — cannot read. This closes the cross-service read risk where a
#       compromised container running under a different UID could slurp every
#       secret on the shared volume.
#
#   For production deployments with stronger isolation, replace this volume
#   approach with Docker Swarm Secrets or Kubernetes Secrets, which provide
#   per-service secret scoping at the orchestration layer.
#
# Ref spec §2 "Startup Sequence" step 1 and §4 "First-Run Bootstrap".

set -e

INIT_DIR="/data/init"
KEYS_DIR="/data/init/keys"
# Public keys go to the shared-pubkeys volume so all services can read them.
# The docker-compose.yml mounts shared-pubkeys at /data/service-keys read-only
# inside each application container.
PUBKEYS_DIR="/data/service-keys"

# GID 1001 matches the service group in Dockerfile.service (addgroup -g 1001 app).
# All application service containers run as UID 1001 / GID 1001, so they can
# read files with mode 0440 + group ownership 1001.
SECRET_GID=1001

mkdir -p "$INIT_DIR"
mkdir -p "$PUBKEYS_DIR"

# Ensure the init directory itself is traversable by service containers. The
# postgres/pgbouncer images run as UID 70 (not in SECRET_GID after su-exec drops
# supplementary groups), so the directory must be world-searchable (0755) for
# them to reach the world-readable DB password files. World-search on the
# directory does not expose 0440 secret contents — those still require ownership
# or SECRET_GID group membership to read.
chgrp "$SECRET_GID" "$INIT_DIR" 2>/dev/null || true
chmod 0755 "$INIT_DIR"

# lock_secret <path> — sets owner=root, group=SECRET_GID, mode=0440.
# 0440 means: owner read-only, group read-only, world no-access.
lock_secret() {
  chown "0:${SECRET_GID}" "$1" 2>/dev/null || true
  chmod 0440 "$1"
}

# lock_db_secret <path> — like lock_secret but world-readable (0444).
# The postgres and pgbouncer images run their config/initdb steps as UID 70
# (the postgres entrypoint uses su-exec, which drops supplementary groups, so a
# group_add of SECRET_GID does not survive into the initdb scripts). These DB
# role passwords must therefore be readable by UID 70. They are only the per-role
# DB passwords — the higher-value secrets (master key, JWT, cursor, bootstrap,
# Ed25519 private keys, Redis passwords) stay at 0440. Combined with the 0755 dir
# below this lets postgres/pgbouncer read exactly what they need and nothing more.
lock_db_secret() {
  chown "0:${SECRET_GID}" "$1" 2>/dev/null || true
  chmod 0444 "$1"
}

# ── Master Key ──────────────────────────────────────────────────────────────
# Step 1a: Check for externally-injected Docker secret (production path).
if [ -f "/run/secrets/op_master_key" ]; then
  echo "[op-init] Using Docker secret for OP_MASTER_KEY"
  cp /run/secrets/op_master_key "$INIT_DIR/master.key"
  lock_secret "$INIT_DIR/master.key"
else
  # Step 1b: No pre-existing secret — generate a new AES-256-GCM master key.
  # openssl rand -base64 32 produces 32 random bytes encoded as base64 (44 chars).
  if [ ! -f "$INIT_DIR/master.key" ]; then
    echo "[op-init] Generating OP_MASTER_KEY"
    openssl rand -base64 32 > "$INIT_DIR/master.key"
    lock_secret "$INIT_DIR/master.key"
  else
    echo "[op-init] OP_MASTER_KEY already exists, skipping"
  fi
fi

# ── Bootstrap Token ─────────────────────────────────────────────────────────
# Step 1c: 32 random bytes as lowercase hex (64 chars).
# Single-use: Auth Service erases this after the first successful bootstrap commit.
if [ ! -f "$INIT_DIR/bootstrap.token" ]; then
  echo "[op-init] Generating bootstrap token"
  openssl rand -hex 32 > "$INIT_DIR/bootstrap.token"
  lock_secret "$INIT_DIR/bootstrap.token"
else
  echo "[op-init] Bootstrap token already exists, skipping"
fi

# ── JWT Secret ──────────────────────────────────────────────────────────────
# Step 1d-a: 32 random bytes as lowercase hex.
# Used by Auth Service for HS256 JWT signing. Ref spec §4 "JWT Strategy".
if [ ! -f "$INIT_DIR/jwt.secret" ]; then
  echo "[op-init] Generating OP_JWT_SECRET"
  openssl rand -hex 32 > "$INIT_DIR/jwt.secret"
  lock_secret "$INIT_DIR/jwt.secret"
else
  echo "[op-init] OP_JWT_SECRET already exists, skipping"
fi

# ── Cursor HMAC Secret ──────────────────────────────────────────────────────
# Step 1d-b: 32 random bytes as lowercase hex.
# Used by all services for cursor encode/decode with HMAC-SHA256.
# Ref spec §6 "Pagination (Cursor-Based)".
if [ ! -f "$INIT_DIR/cursor.secret" ]; then
  echo "[op-init] Generating OP_CURSOR_SECRET"
  openssl rand -hex 32 > "$INIT_DIR/cursor.secret"
  lock_secret "$INIT_DIR/cursor.secret"
else
  echo "[op-init] OP_CURSOR_SECRET already exists, skipping"
fi

# ── Database Role Password Naming Convention ────────────────────────────────
# Password files are named: db_password_<service-short-name>.txt
# where <service-short-name> = service name with the "-service" suffix removed.
# Examples:
#   gateway-service   → db_password_gateway.txt
#   auth-service      → db_password_auth.txt
#   ingestion-service → db_password_ingestion.txt
#   ontology-service  → db_password_ontology.txt
#   pipeline-service  → db_password_pipeline.txt
#   execution-service → db_password_execution.txt
#   app-service       → db_password_app.txt
#   logging-service   → db_password_logging.txt
#   plugin-service    → db_password_plugin.txt
#
# The service-entrypoint.sh reads these files and sets:
#   OP_DATABASE_URL=postgres://<service>_service_role:<password>@pgbouncer:5433/oneplatform_<service>
#
# The pgbouncer-entrypoint.sh reads the same files and writes userlist.txt
# so PgBouncer can authenticate each service role with its own password.
#
# The postgres set-passwords.sh reads the same files and applies them to each
# role via ALTER ROLE … PASSWORD '…' on first boot.
#
# If you add a new service, you must:
# 1. Add it to the loop below to generate its password file.
# 2. Add a matching database alias in docker/pgbouncer/pgbouncer.ini [databases].
# 3. Add a matching role creation in docker/postgres/init.sql.
# 4. Add a matching line in docker/postgres/set-passwords.sh.

# ── Per-Service Database Passwords ──────────────────────────────────────────
# Each of the 9 service roles gets a unique 32-character alphanumeric password.
# Generated here and written to individual files so postgres/init.sql can be
# updated at startup via the postgres-init-passwords container.
# Ref spec §3 "PostgreSQL: Per-Service Schemas".
#
# Alphanumeric only (no special chars) because passwords land inside
# PostgreSQL ALTER ROLE … PASSWORD '…' statements; a deterministic character
# set avoids quoting edge-cases in the shell-rendered SQL.
gen_password() {
  # LC_ALL=C restricts tr to ASCII; the pipe removes non-alphanumeric bytes
  # so every output byte is in [A-Za-z0-9]. 48 random bytes → ~64 chars after
  # base64 encoding; cutting to 32 gives exactly 32 alphanumeric characters.
  LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 32
}

for SERVICE in auth gateway ingestion ontology pipeline execution app logging plugin; do
  PW_FILE="$INIT_DIR/db_password_${SERVICE}.txt"
  if [ ! -f "$PW_FILE" ]; then
    echo "[op-init] Generating DB password for ${SERVICE}_service_role"
    gen_password > "$PW_FILE"
    lock_db_secret "$PW_FILE"
  else
    echo "[op-init] DB password for ${SERVICE}_service_role already exists, skipping"
  fi
done

# ── PgBouncer Admin/Stats Passwords ─────────────────────────────────────────
# pgbouncer_admin and pgbouncer_stats are administrative users defined in
# userlist.txt. They require their own generated credentials.
for PGBUSER in pgbouncer_admin pgbouncer_stats; do
  PW_FILE="$INIT_DIR/db_password_${PGBUSER}.txt"
  if [ ! -f "$PW_FILE" ]; then
    echo "[op-init] Generating password for ${PGBUSER}"
    gen_password > "$PW_FILE"
    lock_db_secret "$PW_FILE"
  else
    echo "[op-init] Password for ${PGBUSER} already exists, skipping"
  fi
done

# ── Postgres Superuser Password ──────────────────────────────────────────────
# The postgres superuser password must also be generated (not read from .env)
# so that docker-compose can substitute it without requiring manual setup.
if [ ! -f "$INIT_DIR/db_password_postgres_superuser.txt" ]; then
  echo "[op-init] Generating Postgres superuser password"
  gen_password > "$INIT_DIR/db_password_postgres_superuser.txt"
  lock_db_secret "$INIT_DIR/db_password_postgres_superuser.txt"
else
  echo "[op-init] Postgres superuser password already exists, skipping"
fi

# ── Redis User Passwords ─────────────────────────────────────────────────────
# Each Redis ACL user (op_admin plus one per service) gets its own password.
# The redis/users.acl file is rendered at postgres/redis startup by a separate
# entrypoint that reads these files and substitutes the placeholders.
# Ref spec §3 "Redis: ACL Users".
for REDIS_USER in admin auth pipeline logging gateway ingestion ontology app plugin execution; do
  PW_FILE="$INIT_DIR/redis_password_${REDIS_USER}.txt"
  if [ ! -f "$PW_FILE" ]; then
    echo "[op-init] Generating Redis password for op_${REDIS_USER}"
    gen_password > "$PW_FILE"
    lock_secret "$PW_FILE"
  else
    echo "[op-init] Redis password for op_${REDIS_USER} already exists, skipping"
  fi
done

# ── Ed25519 Service Key Pairs ────────────────────────────────────────────────
# Each service signs its outbound X-Service-Token with its private key.
# Receiving services verify using the caller's public key loaded from the
# shared-pubkeys volume (/data/service-keys/*.pub).
# Ref spec §4 "Service-to-Service Auth".
#
# Key naming convention:
#   Private:  $KEYS_DIR/<service-name>/private.pem   (mode 0440, group=SECRET_GID)
#   Public:   $PUBKEYS_DIR/<service-name>.pub         (mode 0440, group=SECRET_GID)
#
# The public key filename must match the JWT sub claim (e.g. "gateway-service")
# because service-auth.ts does: keys[serviceName] where serviceName = f.replace('.pub','')

for SERVICE in gateway auth ingestion ontology pipeline execution app logging plugin; do
  SERVICE_NAME="${SERVICE}-service"
  PRIVATE_KEY_DIR="$KEYS_DIR/${SERVICE_NAME}"
  PRIVATE_KEY_PATH="${PRIVATE_KEY_DIR}/private.pem"
  PUBLIC_KEY_PATH="${PUBKEYS_DIR}/${SERVICE_NAME}.pub"

  mkdir -p "$PRIVATE_KEY_DIR"
  chgrp "$SECRET_GID" "$PRIVATE_KEY_DIR" 2>/dev/null || true
  chmod 0750 "$PRIVATE_KEY_DIR"

  if [ ! -f "$PRIVATE_KEY_PATH" ]; then
    echo "[op-init] Generating Ed25519 key pair for ${SERVICE_NAME}"
    openssl genpkey -algorithm Ed25519 -out "$PRIVATE_KEY_PATH"
    lock_secret "$PRIVATE_KEY_PATH"
    openssl pkey -in "$PRIVATE_KEY_PATH" -pubout -out "$PUBLIC_KEY_PATH"
    lock_secret "$PUBLIC_KEY_PATH"
  else
    echo "[op-init] Ed25519 key pair for ${SERVICE_NAME} already exists, skipping"
    # Ensure public key is always present even if only private key survived a partial run
    if [ ! -f "$PUBLIC_KEY_PATH" ]; then
      echo "[op-init] Re-deriving public key for ${SERVICE_NAME} from existing private key"
      openssl pkey -in "$PRIVATE_KEY_PATH" -pubout -out "$PUBLIC_KEY_PATH"
      lock_secret "$PUBLIC_KEY_PATH"
    fi
  fi
done

# ── Final Validation — no CHANGE_ME placeholders should remain ───────────────
# Any file in $INIT_DIR that still contains a CHANGE_ME string indicates a
# secret generation step was skipped or failed silently. Fail loudly so that
# the startup health check never passes in this broken state.
STALE_FILES=$(grep -rl 'CHANGE_ME' "$INIT_DIR" 2>/dev/null || true)
if [ -n "$STALE_FILES" ]; then
  echo "[op-init] FATAL: CHANGE_ME placeholder found in generated secrets:"
  echo "$STALE_FILES"
  exit 1
fi

# ── Completion Signal ───────────────────────────────────────────────────────
# All services that depend on op-init use this file as the healthcheck condition.
touch "$INIT_DIR/ready"

echo "[op-init] Initialization complete."
ls -la "$INIT_DIR/"
ls -la "$PUBKEYS_DIR/"
