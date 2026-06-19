#!/bin/sh
# docker/scripts/backup.sh
#
# Usage: ./backup.sh [output-dir]
#
# Creates a timestamped backup of all platform data stores:
#   - Postgres: pg_dump in custom format
#   - MinIO: mc mirror to local directory (skipped if mc is not available)
#   - Redis: BGSAVE + RDB file copy (polls LASTSAVE — does NOT sleep 2)
#
# Run from the repo root alongside docker-compose.yml:
#   ./docker/scripts/backup.sh ./backups
#
# SECURITY: Backup files contain all platform data including encrypted secrets.
# Protect backup files: chmod 700 <backup-dir>
# Do NOT store backups in the same location as the running stack.
#
# Ref: OA-8 in docs/designs/friction-fixes.md

set -e

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="${1:-./backups}/${TIMESTAMP}"

echo "[backup] Creating backup directory: ${BACKUP_DIR}"
mkdir -p "${BACKUP_DIR}"

# Warn about backup security immediately so the operator sees it before any
# data is written.
echo "[backup] WARNING: backup files contain all platform data including encrypted secrets."
echo "[backup] Restrict access after completion: chmod 700 ${BACKUP_DIR}"

# ── Postgres backup ──────────────────────────────────────────────────────────
# pg_dump in custom (-F custom) format: compressed, supports selective restore.
# Copies the dump file out of the container via `docker compose cp`.
echo "[backup] Backing up Postgres..."

if docker compose exec -T postgres pg_dump \
    -U postgres \
    -d oneplatform \
    -F custom \
    -f "/tmp/oneplatform_backup.dump"; then
  if docker compose cp "postgres:/tmp/oneplatform_backup.dump" "${BACKUP_DIR}/postgres.dump"; then
    # Clean up the temp file inside the container
    docker compose exec -T postgres rm -f /tmp/oneplatform_backup.dump
    echo "[backup] Postgres: OK (${BACKUP_DIR}/postgres.dump)"
  else
    echo "[backup] ERROR: Failed to copy postgres dump out of container." >&2
    exit 1
  fi
else
  echo "[backup] ERROR: pg_dump failed." >&2
  exit 1
fi

# ── MinIO backup ─────────────────────────────────────────────────────────────
# Uses MinIO Client (mc) to mirror all buckets. Skips with a warning if mc is
# not available — the operator can install mc and re-run the MinIO section.
echo "[backup] Backing up MinIO..."

# Run mc inside the minio container on the internal Docker network so that
# no host port mapping for MinIO is required.
MC_ALIAS="oneplatform_backup_$$"
if [ -z "${OP_MINIO_USER:-}" ] || [ -z "${OP_MINIO_PASSWORD:-}" ]; then
  echo "[backup] WARNING: OP_MINIO_USER or OP_MINIO_PASSWORD not set." >&2
  echo "[backup] MinIO backup skipped. Set these vars and re-run to include MinIO." >&2
else
  mkdir -p "${BACKUP_DIR}/minio"
  # Configure mc alias inside the container, then mirror to a temp dir, then
  # copy the files out. mc ships with the official minio/minio image.
  docker compose exec -T minio mc alias set "${MC_ALIAS}" "http://localhost:9000" "${OP_MINIO_USER}" "${OP_MINIO_PASSWORD}" --quiet
  docker compose exec -T minio mc mirror "${MC_ALIAS}" "/tmp/minio_backup" --quiet
  docker compose cp "minio:/tmp/minio_backup/." "${BACKUP_DIR}/minio"
  docker compose exec -T minio mc alias remove "${MC_ALIAS}" --quiet
  docker compose exec -T minio rm -rf /tmp/minio_backup
  echo "[backup] MinIO: OK (${BACKUP_DIR}/minio)"
fi

# ── Redis backup ─────────────────────────────────────────────────────────────
# BGSAVE triggers an asynchronous background save. We poll LASTSAVE (a Unix
# timestamp of the last successful save) until it changes — this is the correct
# approach. Using 'sleep 2' would be unreliable on large datasets.
echo "[backup] Backing up Redis..."

REDIS_ADMIN_PW=$(docker compose exec -T redis cat /data/init/redis_password_admin.txt 2>/dev/null | tr -d '[:space:]')
REDIS_AUTH=(--user op_admin -a "${REDIS_ADMIN_PW}")

BEFORE_SAVE=$(docker compose exec -T redis redis-cli "${REDIS_AUTH[@]}" LASTSAVE 2>/dev/null | tr -d '[:space:]')
if [ -z "${BEFORE_SAVE}" ]; then
  echo "[backup] ERROR: Could not read Redis LASTSAVE timestamp. Is Redis running?" >&2
  exit 1
fi

docker compose exec -T redis redis-cli "${REDIS_AUTH[@]}" BGSAVE > /dev/null
echo "[backup] Waiting for Redis BGSAVE to complete (polling LASTSAVE)..."

SAVE_COMPLETE=0
# Poll up to 60 seconds with 1-second intervals.
for i in $(seq 1 60); do
  AFTER_SAVE=$(docker compose exec -T redis redis-cli "${REDIS_AUTH[@]}" LASTSAVE 2>/dev/null | tr -d '[:space:]')
  if [ "${AFTER_SAVE}" != "${BEFORE_SAVE}" ]; then
    echo "[backup] BGSAVE complete (LASTSAVE: ${BEFORE_SAVE} → ${AFTER_SAVE})"
    SAVE_COMPLETE=1
    break
  fi
  sleep 1
done

if [ "${SAVE_COMPLETE}" -eq 0 ]; then
  echo "[backup] WARNING: BGSAVE did not complete within 60 seconds." >&2
  echo "[backup] The RDB file may be stale. Check Redis memory usage." >&2
fi

if docker compose cp "redis:/data/dump.rdb" "${BACKUP_DIR}/redis.rdb"; then
  echo "[backup] Redis: OK (${BACKUP_DIR}/redis.rdb)"
else
  echo "[backup] ERROR: Failed to copy Redis RDB file." >&2
  exit 1
fi

# ── Init-data volume backup ──────────────────────────────────────────────────
# The init-data volume contains bootstrap secrets (master key, JWT keys, etc.)
# that are generated once and never recreated. Losing this volume without a
# backup makes recovery impossible.
echo "[backup] Backing up init-data volume..."

mkdir -p "${BACKUP_DIR}/init-data"
# The init-data volume is mounted into multiple containers. We use a temporary
# alpine container to tar the contents out. This avoids depending on a
# specific service being up.
if docker run --rm \
    -v "$(docker volume ls -q | grep init-data | head -1):/vol:ro" \
    -v "$(cd "${BACKUP_DIR}/init-data" && pwd):/out" \
    alpine tar cf /out/init-data.tar -C /vol .; then
  echo "[backup] init-data: OK (${BACKUP_DIR}/init-data/init-data.tar)"
else
  echo "[backup] WARNING: init-data volume backup failed." >&2
  echo "[backup] The volume may not exist or Docker may lack permissions." >&2
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "[backup] Backup complete: ${BACKUP_DIR}"
echo "[backup] Contents:"
ls -lh "${BACKUP_DIR}/"
echo ""
echo "[backup] Secure backup files: chmod 700 ${BACKUP_DIR}"
