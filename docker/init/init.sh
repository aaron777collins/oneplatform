#!/bin/sh
# docker/init/init.sh
#
# One-shot initialization container. Runs as Layer 0 before any data store.
# Generates all secrets that services need at runtime. Secrets are written
# to /data/init/ on the init-data volume with mode 0400 so only root can read them.
#
# Ref spec §2 "Startup Sequence" step 1 and §4 "First-Run Bootstrap".

set -e

INIT_DIR="/data/init"

mkdir -p "$INIT_DIR"

# ── Master Key ──────────────────────────────────────────────────────────────
# Step 1a: Check for externally-injected Docker secret (production path).
if [ -f "/run/secrets/op_master_key" ]; then
  echo "[op-init] Using Docker secret for OP_MASTER_KEY"
  cp /run/secrets/op_master_key "$INIT_DIR/master.key"
  chmod 0400 "$INIT_DIR/master.key"
else
  # Step 1b: No pre-existing secret — generate a new AES-256-GCM master key.
  # openssl rand -base64 32 produces 32 random bytes encoded as base64 (44 chars).
  if [ ! -f "$INIT_DIR/master.key" ]; then
    echo "[op-init] Generating OP_MASTER_KEY"
    openssl rand -base64 32 > "$INIT_DIR/master.key"
    chmod 0400 "$INIT_DIR/master.key"
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
  chmod 0400 "$INIT_DIR/bootstrap.token"
else
  echo "[op-init] Bootstrap token already exists, skipping"
fi

# ── JWT Secret ──────────────────────────────────────────────────────────────
# Step 1d-a: 32 random bytes as lowercase hex.
# Used by Auth Service for HS256 JWT signing. Ref spec §4 "JWT Strategy".
if [ ! -f "$INIT_DIR/jwt.secret" ]; then
  echo "[op-init] Generating OP_JWT_SECRET"
  openssl rand -hex 32 > "$INIT_DIR/jwt.secret"
  chmod 0400 "$INIT_DIR/jwt.secret"
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
  chmod 0400 "$INIT_DIR/cursor.secret"
else
  echo "[op-init] OP_CURSOR_SECRET already exists, skipping"
fi

# ── Completion Signal ───────────────────────────────────────────────────────
# All services that depend on op-init use this file as the healthcheck condition.
touch "$INIT_DIR/ready"

echo "[op-init] Initialization complete."
ls -la "$INIT_DIR/"
