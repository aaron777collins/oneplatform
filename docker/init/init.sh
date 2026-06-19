#!/bin/sh
# docker/init/init.sh
#
# One-shot initialization container. Runs as Layer 0 before any data store.
# Generates all secrets that services need at runtime. Secrets are written
# to /data/init/ on the init-data volume with mode 0444 (world-readable) so that
# service containers (UID 1001) and postgres (UID 70) can read them. The volume
# is mounted :ro in docker-compose.yml, preventing writes regardless of mode.
#
# Ref spec §2 "Startup Sequence" step 1 and §4 "First-Run Bootstrap".

set -e

INIT_DIR="/data/init"
KEYS_DIR="/data/init/keys"
# Public keys go to the shared-pubkeys volume so all services can read them.
# The docker-compose.yml mounts shared-pubkeys at /data/service-keys read-only
# inside each application container.
PUBKEYS_DIR="/data/service-keys"

mkdir -p "$INIT_DIR"
mkdir -p "$PUBKEYS_DIR"

# ── Master Key ──────────────────────────────────────────────────────────────
# Step 1a: Check for externally-injected Docker secret (production path).
if [ -f "/run/secrets/op_master_key" ]; then
  echo "[op-init] Using Docker secret for OP_MASTER_KEY"
  cp /run/secrets/op_master_key "$INIT_DIR/master.key"
  chmod 0444 "$INIT_DIR/master.key"
else
  # Step 1b: No pre-existing secret — generate a new AES-256-GCM master key.
  # openssl rand -base64 32 produces 32 random bytes encoded as base64 (44 chars).
  if [ ! -f "$INIT_DIR/master.key" ]; then
    echo "[op-init] Generating OP_MASTER_KEY"
    openssl rand -base64 32 > "$INIT_DIR/master.key"
    chmod 0444 "$INIT_DIR/master.key"
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
  chmod 0444 "$INIT_DIR/bootstrap.token"
else
  echo "[op-init] Bootstrap token already exists, skipping"
fi

# ── JWT Secret ──────────────────────────────────────────────────────────────
# Step 1d-a: 32 random bytes as lowercase hex.
# Used by Auth Service for HS256 JWT signing. Ref spec §4 "JWT Strategy".
if [ ! -f "$INIT_DIR/jwt.secret" ]; then
  echo "[op-init] Generating OP_JWT_SECRET"
  openssl rand -hex 32 > "$INIT_DIR/jwt.secret"
  chmod 0444 "$INIT_DIR/jwt.secret"
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
  chmod 0444 "$INIT_DIR/cursor.secret"
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
    chmod 0444 "$PW_FILE"
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
    chmod 0444 "$PW_FILE"
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
  chmod 0444 "$INIT_DIR/db_password_postgres_superuser.txt"
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
    chmod 0444 "$PW_FILE"
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
#   Private:  $KEYS_DIR/<service-name>/private.pem   (mode 0444, volume is :ro)
#   Public:   $PUBKEYS_DIR/<service-name>.pub         (mode 0444, all services)
#
# The public key filename must match the JWT sub claim (e.g. "gateway-service")
# because service-auth.ts does: keys[serviceName] where serviceName = f.replace('.pub','')

for SERVICE in gateway auth ingestion ontology pipeline execution app logging plugin; do
  SERVICE_NAME="${SERVICE}-service"
  PRIVATE_KEY_DIR="$KEYS_DIR/${SERVICE_NAME}"
  PRIVATE_KEY_PATH="${PRIVATE_KEY_DIR}/private.pem"
  PUBLIC_KEY_PATH="${PUBKEYS_DIR}/${SERVICE_NAME}.pub"

  mkdir -p "$PRIVATE_KEY_DIR"

  if [ ! -f "$PRIVATE_KEY_PATH" ]; then
    echo "[op-init] Generating Ed25519 key pair for ${SERVICE_NAME}"
    openssl genpkey -algorithm Ed25519 -out "$PRIVATE_KEY_PATH"
    chmod 0444 "$PRIVATE_KEY_PATH"
    openssl pkey -in "$PRIVATE_KEY_PATH" -pubout -out "$PUBLIC_KEY_PATH"
    chmod 0444 "$PUBLIC_KEY_PATH"
  else
    echo "[op-init] Ed25519 key pair for ${SERVICE_NAME} already exists, skipping"
    # Ensure public key is always present even if only private key survived a partial run
    if [ ! -f "$PUBLIC_KEY_PATH" ]; then
      echo "[op-init] Re-deriving public key for ${SERVICE_NAME} from existing private key"
      openssl pkey -in "$PRIVATE_KEY_PATH" -pubout -out "$PUBLIC_KEY_PATH"
      chmod 0444 "$PUBLIC_KEY_PATH"
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
