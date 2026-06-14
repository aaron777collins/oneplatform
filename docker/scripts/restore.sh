#!/bin/sh
# docker/scripts/restore.sh
#
# Usage: ./restore.sh <backup-dir> --yes
#
# Restores platform data stores from a backup created by backup.sh:
#   - Postgres: pg_restore from .dump file
#   - MinIO: mc mirror from backup directory (skipped if mc is not available)
#   - Redis: copy .rdb file and trigger reload
#
# REQUIRED: Pass --yes to confirm the restore. Without it, the script exits.
#
# IMPORTANT: Stop application services before restoring to prevent data corruption:
#   docker compose stop gateway-service auth-service ingestion-service \
#     ontology-service pipeline-service execution-service app-service \
#     logging-service plugin-service
#
# Run from the repo root alongside docker-compose.yml:
#   ./docker/scripts/restore.sh ./backups/20260614_120000 --yes
#
# Ref: OA-8 in docs/designs/friction-fixes.md

set -e

BACKUP_DIR="${1:-}"
YES_FLAG="${2:-}"

# ── Validate arguments ────────────────────────────────────────────────────────
if [ -z "${BACKUP_DIR}" ]; then
  echo "Usage: $0 <backup-dir> --yes" >&2
  echo "Example: $0 ./backups/20260614_120000 --yes" >&2
  exit 1
fi

if [ "${YES_FLAG}" != "--yes" ]; then
  echo "ERROR: Restore requires explicit confirmation. Pass --yes to proceed." >&2
  echo "       This will OVERWRITE all current data with the backup." >&2
  echo "Usage: $0 ${BACKUP_DIR} --yes" >&2
  exit 1
fi

if [ ! -d "${BACKUP_DIR}" ]; then
  echo "ERROR: Backup directory does not exist: ${BACKUP_DIR}" >&2
  exit 1
fi

echo "[restore] WARNING: This will overwrite all current platform data."
echo "[restore] Backup source: ${BACKUP_DIR}"
echo "[restore] Proceeding in 5 seconds... (Ctrl-C to abort)"
sleep 5

echo "[restore] Starting restore from ${BACKUP_DIR}"

# ── Postgres restore ──────────────────────────────────────────────────────────
POSTGRES_DUMP="${BACKUP_DIR}/postgres.dump"
if [ -f "${POSTGRES_DUMP}" ]; then
  echo "[restore] Restoring Postgres..."

  # Copy dump file into the postgres container for pg_restore
  docker compose cp "${POSTGRES_DUMP}" "postgres:/tmp/restore.dump"

  # Drop and recreate the database to ensure a clean restore.
  # Using --clean --if-exists with pg_restore handles this more cleanly
  # than manual DROP/CREATE for the custom format.
  docker compose exec -T postgres pg_restore \
    -U postgres \
    -d oneplatform \
    --clean \
    --if-exists \
    --no-owner \
    --no-privileges \
    /tmp/restore.dump || {
    # pg_restore exits non-zero for warnings (e.g., objects that don't exist yet).
    # Check if it was a real failure by attempting a connection afterward.
    docker compose exec -T postgres psql -U postgres -d oneplatform -c "SELECT 1" > /dev/null 2>&1 || {
      echo "[restore] ERROR: Postgres restore failed and database is unreachable." >&2
      exit 1
    }
    echo "[restore] Postgres: restored with non-fatal warnings (this is normal)."
  }

  docker compose exec -T postgres rm -f /tmp/restore.dump
  echo "[restore] Postgres: OK"
else
  echo "[restore] WARNING: No postgres.dump found in ${BACKUP_DIR} — skipping Postgres restore." >&2
fi

# ── MinIO restore ─────────────────────────────────────────────────────────────
MINIO_BACKUP="${BACKUP_DIR}/minio"
if [ -d "${MINIO_BACKUP}" ]; then
  echo "[restore] Restoring MinIO..."

  if command -v mc > /dev/null 2>&1; then
    if [ -z "${OP_MINIO_USER:-}" ] || [ -z "${OP_MINIO_PASSWORD:-}" ]; then
      echo "[restore] WARNING: OP_MINIO_USER or OP_MINIO_PASSWORD not set." >&2
      echo "[restore] MinIO restore skipped. Set these vars and re-run." >&2
    else
      MC_ALIAS="oneplatform_restore_$$"
      mc alias set "${MC_ALIAS}" "http://localhost:9000" "${OP_MINIO_USER}" "${OP_MINIO_PASSWORD}" --quiet
      # Mirror from backup to MinIO (overwrites existing objects)
      mc mirror "${MINIO_BACKUP}" "${MC_ALIAS}" --overwrite --quiet
      mc alias remove "${MC_ALIAS}" --quiet
      echo "[restore] MinIO: OK"
    fi
  else
    echo "[restore] WARNING: 'mc' not found. MinIO restore skipped." >&2
    echo "[restore] Install mc from https://min.io/docs/minio/linux/reference/minio-mc.html" >&2
  fi
else
  echo "[restore] No MinIO backup found in ${BACKUP_DIR} — skipping MinIO restore."
fi

# ── Redis restore ─────────────────────────────────────────────────────────────
REDIS_RDB="${BACKUP_DIR}/redis.rdb"
if [ -f "${REDIS_RDB}" ]; then
  echo "[restore] Restoring Redis..."

  # Stop Redis before replacing the RDB file to prevent data corruption.
  # The 'redis' container is restarted after copying the file.
  docker compose stop redis

  docker compose cp "${REDIS_RDB}" "redis:/data/dump.rdb"

  docker compose start redis

  # Wait for Redis to become available before continuing
  echo "[restore] Waiting for Redis to become ready..."
  for i in $(seq 1 30); do
    if docker compose exec -T redis redis-cli PING 2>/dev/null | grep -q PONG; then
      echo "[restore] Redis: OK"
      break
    fi
    if [ "$i" -eq 30 ]; then
      echo "[restore] WARNING: Redis did not respond within 30 seconds after restore." >&2
    fi
    sleep 1
  done
else
  echo "[restore] No redis.rdb found in ${BACKUP_DIR} — skipping Redis restore."
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "[restore] Restore complete from ${BACKUP_DIR}"
echo "[restore] Start application services when ready:"
echo "  docker compose up -d gateway-service auth-service ingestion-service \\"
echo "    ontology-service pipeline-service execution-service app-service \\"
echo "    logging-service plugin-service"
