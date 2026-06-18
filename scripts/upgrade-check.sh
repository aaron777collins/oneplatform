#!/usr/bin/env bash
# scripts/upgrade-check.sh
#
# Pre-upgrade validation script for the OnePlatform Docker Compose stack.
# Run this before every upgrade to confirm the stack is in a known-good state.
#
# Usage (from the repo root):
#   ./scripts/upgrade-check.sh
#
# Exit codes:
#   0 — all checks passed; safe to proceed with the upgrade
#   1 — one or more checks failed; resolve issues before upgrading
#
# What it checks:
#   - op-init completed successfully (/data/init/ready marker exists)
#   - All data store containers are in a healthy state
#   - All application service containers are in a healthy state
#   - PostgreSQL is reachable via PgBouncer (port 5433)
#   - Redis is reachable and responding
#   - Disk space on the Docker data root (warns at < 5 GB free)
#   - Current git commit and branch
#   - Database size per schema (informational — helps estimate migration duration)
#
# Prerequisites:
#   - Docker Compose plugin (docker compose)
#   - jq (optional — used only for formatting JSON health responses)
#   - Run as a user with permission to execute docker compose commands

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# Minimum free disk space (bytes) before the script warns about space.
# 5 GB leaves room for a full pg_dump + build cache on a typical install.
MIN_DISK_FREE_BYTES=$((5 * 1024 * 1024 * 1024))

# Application service names — must match the service keys in docker-compose.yml.
APP_SERVICES=(
  gateway-service
  auth-service
  ingestion-service
  ontology-service
  pipeline-service
  execution-service
  app-service
  logging-service
  plugin-service
)

# Data store service names checked separately (different health semantics).
DATA_SERVICES=(
  postgres
  redis
  minio
  pgbouncer
)

# PostgreSQL connection details for the PgBouncer reachability check.
# Uses the postgres superuser so the check works on a fresh or restored stack
# before service roles are verified. Reads the superuser password from the
# init-data volume via the running postgres container (not from .env).
PGBOUNCER_HOST="localhost"
PGBOUNCER_PORT="5433"
PG_USER="postgres"
PG_DB="oneplatform"

# ---------------------------------------------------------------------------
# State tracking
# ---------------------------------------------------------------------------

ERRORS=0
WARNINGS=0

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

log()  { printf '[upgrade-check] %s\n' "$*"; }
pass() { printf '[upgrade-check] PASS  %s\n' "$*"; }
warn() { printf '[upgrade-check] WARN  %s\n' "$*" >&2; WARNINGS=$((WARNINGS + 1)); }
fail() { printf '[upgrade-check] FAIL  %s\n' "$*" >&2; ERRORS=$((ERRORS + 1)); }
sep()  { log '---'; }

# ---------------------------------------------------------------------------
# Helper: check whether a container reports a healthy or running status.
#
# Docker Compose status strings include:
#   "Up X minutes (healthy)"     — has a healthcheck and it passed
#   "Up X minutes"               — no healthcheck defined but container is up
#   "Up X minutes (unhealthy)"   — healthcheck is failing
#   "Restarting (N) X ago"       — crash-looping
#   "Exit N"                     — stopped
#   (empty)                      — container does not exist
#
# We accept "healthy" or a plain "Up" without "(unhealthy)" as passing.
# ---------------------------------------------------------------------------
check_container_health() {
  local name="$1"
  local status

  # --format with Go template gives us just the Status column.
  status=$(docker compose ps --format "{{.Name}}\t{{.Status}}" 2>/dev/null \
    | grep -E "^${name}[[:space:]]" \
    | awk '{$1=""; print $0}' \
    | sed 's/^[[:space:]]*//')

  if [ -z "$status" ]; then
    fail "${name} — container not found (not running or wrong project directory)"
    return 1
  fi

  # "healthy" check first (explicit Docker health check passed)
  if echo "$status" | grep -q "(healthy)"; then
    pass "${name} is healthy"
    return 0
  fi

  # Reject known bad states before accepting a generic "Up"
  if echo "$status" | grep -qE "(unhealthy|Restarting|Exit|removing|dead)"; then
    fail "${name} — bad status: ${status}"
    return 1
  fi

  # Container is up but has no healthcheck — treat as passing for data stores
  # that define their own readiness probes outside Docker's HEALTHCHECK mechanism.
  if echo "$status" | grep -q "^Up"; then
    pass "${name} is running (no healthcheck)"
    return 0
  fi

  fail "${name} — unexpected status: ${status}"
  return 1
}

# ---------------------------------------------------------------------------
# Helper: resolve the path Docker uses for its data root so disk-space checks
# target the volume that actually stores container/volume data.
# Falls back to /var/lib/docker if docker info is unavailable.
# ---------------------------------------------------------------------------
docker_data_root() {
  docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo "/var/lib/docker"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

log "OnePlatform pre-upgrade validation"
log "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
sep

# --- Git state ---
GIT_COMMIT=$(git -C "$(dirname "$0")/.." log --oneline -1 2>/dev/null || echo "unknown")
GIT_BRANCH=$(git -C "$(dirname "$0")/.." rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
log "Git commit: ${GIT_COMMIT} (branch: ${GIT_BRANCH})"
sep

# --- op-init completion marker ---
# op-init writes /data/init/ready as its final step. All services wait for this
# file before starting. If it is absent the stack cannot function.
if docker compose exec -T op-init test -f /data/init/ready 2>/dev/null; then
  pass "op-init is complete (/data/init/ready exists)"
else
  # The op-init container may not have a running instance after first boot;
  # check via the init-data volume mounted on any running service instead.
  if docker compose exec -T auth-service test -f /data/init/ready 2>/dev/null; then
    pass "op-init is complete (/data/init/ready visible via auth-service mount)"
  else
    fail "op-init marker /data/init/ready not found — run: docker compose run --rm op-init"
  fi
fi

# --- Data store health ---
for svc in "${DATA_SERVICES[@]}"; do
  check_container_health "$svc"
done

# --- Application service health ---
for svc in "${APP_SERVICES[@]}"; do
  check_container_health "$svc"
done
sep

# --- PostgreSQL reachability via PgBouncer ---
# Reads the postgres superuser password from the init-data volume via the
# running postgres container rather than assuming a fixed password in .env.
PGPASSWORD=$(docker compose exec -T postgres \
  cat /data/init/db_password_postgres_superuser.txt 2>/dev/null \
  | tr -d '[:space:]') || true

if [ -z "$PGPASSWORD" ]; then
  # Fallback: try the POSTGRES_PASSWORD env var injected by docker-compose
  PGPASSWORD=$(docker compose exec -T postgres \
    printenv POSTGRES_PASSWORD 2>/dev/null | tr -d '[:space:]') || true
fi

if [ -n "$PGPASSWORD" ]; then
  # Use psql inside the postgres container, connecting outbound through
  # PgBouncer on the host-mapped port to verify the full connection path.
  if PGPASSWORD="$PGPASSWORD" docker compose exec -T postgres \
       psql -h "${PGBOUNCER_HOST}" -p "${PGBOUNCER_PORT}" \
            -U "${PG_USER}" -d "${PG_DB}" \
            -c "SELECT 1" -q --no-align -t 2>/dev/null | grep -q "^1$"; then
    pass "PostgreSQL reachable via PgBouncer (port ${PGBOUNCER_PORT})"
  else
    fail "PostgreSQL NOT reachable via PgBouncer — check pgbouncer logs"
  fi
else
  warn "Could not retrieve PostgreSQL superuser password — skipping PgBouncer connectivity check"
fi

# --- Redis reachability ---
# Reads the op_admin password from the init-data volume mounted on the redis
# container, then pings Redis to confirm it is accepting connections.
REDIS_ADMIN_PW=$(docker compose exec -T redis \
  cat /data/init/redis_password_admin.txt 2>/dev/null \
  | tr -d '[:space:]') || true

if [ -n "$REDIS_ADMIN_PW" ]; then
  PONG=$(docker compose exec -T redis \
    redis-cli --user op_admin -a "$REDIS_ADMIN_PW" PING 2>/dev/null \
    | tr -d '[:space:]') || true
  if [ "$PONG" = "PONG" ]; then
    pass "Redis reachable (PONG received)"
  else
    fail "Redis NOT responding to PING — response was: ${PONG:-<empty>}"
  fi
else
  warn "Could not retrieve Redis admin password — skipping Redis connectivity check"
fi
sep

# --- Disk space ---
DOCKER_ROOT=$(docker_data_root)
# df -k returns kilobytes; multiply by 1024 for bytes.
DISK_FREE_KB=$(df -k "$DOCKER_ROOT" 2>/dev/null | awk 'NR==2 {print $4}')

if [ -n "$DISK_FREE_KB" ]; then
  DISK_FREE_BYTES=$((DISK_FREE_KB * 1024))
  DISK_FREE_HUMAN=$(df -h "$DOCKER_ROOT" 2>/dev/null | awk 'NR==2 {print $4}')
  if [ "$DISK_FREE_BYTES" -ge "$MIN_DISK_FREE_BYTES" ]; then
    pass "Disk free: ${DISK_FREE_HUMAN} on ${DOCKER_ROOT} (>= 5G threshold)"
  else
    warn "Disk free: ${DISK_FREE_HUMAN} on ${DOCKER_ROOT} — less than 5G may be insufficient for build cache + backup"
  fi
else
  warn "Could not determine free disk space on ${DOCKER_ROOT}"
fi
sep

# --- Database size by schema (informational) ---
# Knowing schema sizes helps the operator estimate how long pg_dump and any
# pending migrations will take. This never causes the script to fail.
log "Database size by schema:"

if [ -n "$PGPASSWORD" ]; then
  SIZE_QUERY="
    SELECT
      nspname AS schema_name,
      pg_size_pretty(sum(pg_total_relation_size(c.oid))) AS total_size
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE nspname IN (
      'auth','ingestion','ontology','pipeline','execution',
      'app','logging','plugin','gateway'
    )
    GROUP BY nspname
    ORDER BY sum(pg_total_relation_size(c.oid)) DESC;
  "
  SIZE_OUTPUT=$(PGPASSWORD="$PGPASSWORD" docker compose exec -T postgres \
    psql -h "${PGBOUNCER_HOST}" -p "${PGBOUNCER_PORT}" \
         -U "${PG_USER}" -d "${PG_DB}" \
         -c "$SIZE_QUERY" --no-align -t 2>/dev/null) || SIZE_OUTPUT=""

  if [ -n "$SIZE_OUTPUT" ]; then
    while IFS= read -r line; do
      [ -n "$line" ] && log "  ${line}"
    done <<< "$SIZE_OUTPUT"
  else
    warn "Could not query database sizes (PgBouncer may not be forwarding queries yet)"
  fi
else
  warn "Skipping database size query — PostgreSQL password unavailable"
fi
sep

# --- Docker image versions ---
log "Current Docker image versions:"
docker compose images 2>/dev/null | while IFS= read -r line; do
  log "  ${line}"
done
sep

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

if [ "$ERRORS" -gt 0 ]; then
  log "Pre-upgrade validation FAILED — ${ERRORS} error(s), ${WARNINGS} warning(s)"
  log "Resolve all errors before proceeding. Warnings are informational."
  exit 1
elif [ "$WARNINGS" -gt 0 ]; then
  log "Pre-upgrade validation PASSED with ${WARNINGS} warning(s) — review warnings before proceeding"
  exit 0
else
  log "All checks PASSED. Stack is ready to upgrade."
  exit 0
fi
