# OnePlatform Backup and Disaster Recovery Guide

## Table of Contents

1. [Backup Strategy Overview](#1-backup-strategy-overview)
2. [Using backup.sh](#2-using-backupsh)
3. [Using restore.sh](#3-using-restoresh)
4. [Database Backup](#4-database-backup)
5. [Redis Backup](#5-redis-backup)
6. [Object Storage Backup](#6-object-storage-backup)
7. [Secret Backup](#7-secret-backup)
8. [Automated Backup Schedule](#8-automated-backup-schedule)
9. [Disaster Recovery Procedure](#9-disaster-recovery-procedure)
10. [Partial Recovery](#10-partial-recovery)
11. [Backup Validation](#11-backup-validation)
12. [Off-Site Backup](#12-off-site-backup)

---

## 1. Backup Strategy Overview

### What Needs Backing Up

OnePlatform stores state across four distinct systems. Each has different characteristics, backup mechanisms, and recovery implications.

| System | Docker Volume | Content | Risk if Lost |
|--------|--------------|---------|--------------|
| PostgreSQL | `postgres-data` | All application data across 9 schemas | Complete data loss |
| Redis | `redis-data` | BullMQ job queues, rate-limit state, session cache | In-flight jobs lost, eventual consistency |
| MinIO | `minio-data` | Object storage (connector assets, plugin packages, exports) | File/artifact loss |
| Secrets (init-data) | `init-data` | JWT secret, master key, all DB/Redis passwords, Ed25519 private keys | **Stack unrecoverable without these** |
| Public keys | `shared-pubkeys` | Ed25519 public keys (derived from private keys) | Derived — can regenerate from init-data |
| App state | `app-data` | App-service filesystem state | Low volume, application-specific |
| Plugin state | `plugin-data` | Plugin-service filesystem state | Low volume, plugin-specific |
| Aggregated logs | `log-data` | Structured logs written by Vector | Append-only, informational |

Volumes not worth backing up: `sandbox-socket` (IPC socket — ephemeral, recreated on start).

### The init-data Volume is the Most Critical Asset

Every cryptographic secret the stack uses lives in the `init-data` Docker volume at `/data/init/`. This includes:

- `master.key` — AES-256-GCM master key used to encrypt all stored credentials (`OP_MASTER_KEY`)
- `jwt.secret` — HS256 JWT signing secret
- `cursor.secret` — HMAC-SHA256 cursor signing secret
- `bootstrap.token` — one-time admin bootstrap token (may be empty after first use)
- `db_password_<service>.txt` — per-service PostgreSQL role passwords (9 services + postgres superuser + pgbouncer_admin + pgbouncer_stats)
- `redis_password_<user>.txt` — per-service Redis ACL passwords (10 users including op_admin)
- `keys/<service>-service/private.pem` — Ed25519 private keys for service-to-service auth (9 services)

Without these secrets, a PostgreSQL backup is useless: the database contains AES-256-GCM encrypted data that can only be decrypted with the original `master.key`. Without the database passwords, PgBouncer and every service will refuse to start.

**Always back up init-data alongside the database. Never separate them.**

### RPO and RTO Targets

| Tier | Recovery Point Objective | Recovery Time Objective | Mechanism |
|------|-------------------------|------------------------|-----------|
| Full DR | 24 hours | 2–4 hours | Daily full backup + documented runbook |
| Database only | 1 hour | 30 minutes | Hourly pg_dump |
| Redis | 15 minutes | 5 minutes | BullMQ jobs re-enqueue from DB state |
| MinIO | 24 hours | 1 hour | Daily mirror |

For PITR (Point-In-Time Recovery) better than 24 hours, see [Section 4 — WAL Archiving](#wal-archiving-for-point-in-time-recovery).

### Backup Types

**Full backup (backup.sh):** Dumps the entire `oneplatform` database with `pg_dump -F custom`, triggers an RDB snapshot for Redis, and mirrors all MinIO buckets. Suitable for daily execution. Takes 2–15 minutes depending on data volume.

**Secrets-only backup:** Exports the `init-data` volume to an encrypted tar archive. Run this immediately after first deployment and whenever secrets rotate. This is a fast operation (seconds) and produces a small file.

**Incremental database backup:** Not directly provided by backup.sh. Use WAL archiving (see Section 4) to achieve sub-hourly RPO without running full `pg_dump` every hour.

---

## 2. Using backup.sh

Located at `docker/scripts/backup.sh`. Run from the repository root alongside `docker-compose.yml`.

### What It Backs Up

| Component | Method | Output File |
|-----------|--------|-------------|
| PostgreSQL | `pg_dump -F custom` (compressed custom format) | `<timestamp>/postgres.dump` |
| Redis | `BGSAVE` + RDB file copy | `<timestamp>/redis.rdb` |
| MinIO | `mc mirror` (requires `mc` in PATH and credentials) | `<timestamp>/minio/` |

**What it does NOT back up:** The `init-data` volume (secrets). Back that up separately — see [Section 7](#7-secret-backup).

### Prerequisites

- Docker Compose stack must be running (`docker compose ps` shows services as healthy)
- Run as a user with permission to execute `docker compose` commands
- For MinIO backup: `mc` (MinIO Client) must be installed and `OP_MINIO_USER`/`OP_MINIO_PASSWORD` must be set

### Basic Usage

```bash
# Run from the repo root
cd /path/to/oneplatform

# Back up to ./backups/<timestamp>/
./docker/scripts/backup.sh

# Back up to a specific directory
./docker/scripts/backup.sh /mnt/backup-disk/oneplatform

# Back up with MinIO credentials
OP_MINIO_USER=minioadmin OP_MINIO_PASSWORD=yourpassword \
  ./docker/scripts/backup.sh /mnt/backup-disk/oneplatform
```

### Output Format

```
/mnt/backup-disk/oneplatform/
└── 20260617_143022/
    ├── postgres.dump    # pg_dump custom format (compressed)
    ├── redis.rdb        # Redis RDB snapshot
    └── minio/           # MinIO bucket mirror (if mc available)
        ├── uploads/
        ├── exports/
        └── plugins/
```

The timestamp format is `YYYYMMDD_HHMMSS` in the server's local timezone.

### How Each Component Is Backed Up

**PostgreSQL:** Runs `pg_dump -U postgres -d oneplatform -F custom` inside the `postgres` container, writes to `/tmp/oneplatform_backup.dump`, then copies that file out with `docker compose cp`. The custom format (`-F custom`) is compressed and supports selective table/schema restore with `pg_restore`. The temporary file inside the container is removed immediately after copy.

**Redis:** Reads the `op_admin` password from `/data/init/redis_password_admin.txt` inside the container, then:
1. Records the current `LASTSAVE` timestamp
2. Issues `BGSAVE` to trigger an asynchronous background save
3. Polls `LASTSAVE` every second for up to 60 seconds until it changes
4. Copies `/data/dump.rdb` out of the container

This polling approach is correct — using a fixed sleep is unreliable for large datasets. If `BGSAVE` does not complete within 60 seconds, the script warns but continues with whatever RDB exists on disk (which may be from a previous save cycle). On a stack with < 100 MB Redis memory usage, BGSAVE typically completes within 2–5 seconds.

**MinIO:** Creates a temporary `mc` alias (named `oneplatform_backup_<PID>` to avoid collisions), runs `mc mirror` to copy all buckets to `<backup-dir>/minio/`, then removes the alias. The alias is removed even on failure because of `set -e`. If `mc` is not installed or credentials are not provided, the MinIO backup is skipped with a warning — the script does not fail.

### Exit Codes

| Code | Meaning |
|------|---------|
| 0 | All attempted backups succeeded |
| 1 | PostgreSQL backup failed (script aborts immediately) |
| 1 | Could not copy postgres dump out of container (script aborts) |
| 1 | Could not read Redis LASTSAVE (Redis is not running) |
| 1 | Could not copy Redis RDB file out of container |

MinIO failures are warnings, not errors — the script continues and exits 0 if Postgres and Redis succeed.

### Securing the Backup Directory

```bash
# The script reminds you, but do this immediately after backup completes:
chmod 700 /mnt/backup-disk/oneplatform/20260617_143022

# The backup contains all platform data including encrypted (but crackable) secrets.
# Store backups on encrypted storage or encrypt them before off-site transfer.
```

### Estimated Backup Size and Duration

| Scenario | Postgres dump | Redis RDB | MinIO | Total | Duration |
|----------|--------------|-----------|-------|-------|----------|
| Small (< 1M records) | 50–200 MB | 5–20 MB | variable | 100–500 MB | 2–5 min |
| Medium (10M records) | 500 MB–2 GB | 20–100 MB | variable | 1–5 GB | 5–15 min |
| Large (100M records) | 5–20 GB | 100–500 MB | variable | 10–30 GB | 20–60 min |

MinIO size depends entirely on what objects are stored; it is not included in the above estimates.

---

## 3. Using restore.sh

Located at `docker/scripts/restore.sh`. Run from the repository root alongside `docker-compose.yml`.

### What It Restores

| Component | Method | Source File |
|-----------|--------|-------------|
| PostgreSQL | `pg_restore --clean --if-exists` | `<backup-dir>/postgres.dump` |
| Redis | Stop container, copy RDB file, restart | `<backup-dir>/redis.rdb` |
| MinIO | `mc mirror --overwrite` | `<backup-dir>/minio/` |

**What it does NOT restore:** The `init-data` volume (secrets). Restore those separately before running this script — see [Section 7](#7-secret-backup).

### Prerequisites

Before running restore.sh:

1. The database and Redis containers must be running (they are restored into running containers, except Redis which is briefly stopped)
2. All application services must be stopped to prevent writes during restore
3. Secrets in `init-data` must match the backup being restored (see warning below)
4. For MinIO restore: `mc` must be installed and credentials must be set

**Critical: secrets must match the backup.** The PostgreSQL dump contains AES-256-GCM encrypted data keyed to the `master.key` that was active when the backup was taken. If you restore the database with a different `master.key`, all encrypted credential fields will be unreadable. Always restore secrets and database together from the same backup set.

### Stop Application Services First

```bash
# Stop all application services — leave postgres, redis, minio running
docker compose stop gateway-service auth-service ingestion-service \
  ontology-service pipeline-service execution-service app-service \
  logging-service plugin-service
```

### Usage

```bash
# Restore from a specific backup directory — requires --yes
./docker/scripts/restore.sh ./backups/20260617_143022 --yes

# Restore from an absolute path
./docker/scripts/restore.sh /mnt/backup-disk/oneplatform/20260617_143022 --yes

# Restore with MinIO credentials
OP_MINIO_USER=minioadmin OP_MINIO_PASSWORD=yourpassword \
  ./docker/scripts/restore.sh /mnt/backup-disk/oneplatform/20260617_143022 --yes
```

The `--yes` flag is required. Without it the script exits immediately with an error. After printing a warning it waits 5 seconds before proceeding — press Ctrl-C to abort.

### What Happens During Restore

**PostgreSQL:** Copies `postgres.dump` into the container at `/tmp/restore.dump`, then runs:
```
pg_restore -U postgres -d oneplatform --clean --if-exists --no-owner --no-privileges
```
The `--clean --if-exists` flags drop and recreate all objects before restoring, giving a clean slate without requiring a manual `DROP DATABASE`. `pg_restore` exits non-zero for harmless warnings (e.g., "object does not exist to drop"); the script handles this by testing a `SELECT 1` query — if the database is reachable after pg_restore, the restore succeeded.

**Redis:** Stops the `redis` container (to prevent the running instance from overwriting the file), copies `redis.rdb` to `/data/dump.rdb` inside the container, then starts it. Redis loads the RDB on startup. The script polls `redis-cli PING` for up to 30 seconds waiting for `PONG`.

**MinIO:** Mirrors `<backup-dir>/minio/` to the live MinIO instance using `mc mirror --overwrite`. Objects in MinIO not present in the backup are left in place (mirror is not a sync-with-delete). To fully replace MinIO state, empty the buckets first.

### Verify After Restore

```bash
# Check postgres is reachable and has data
docker compose exec postgres psql -U postgres -d oneplatform \
  -c "SELECT schemaname, count(*) FROM pg_tables GROUP BY schemaname ORDER BY schemaname;"

# Check Redis is populated
ADMIN_PW=$(docker compose exec -T redis cat /data/init/redis_password_admin.txt | tr -d '[:space:]')
docker compose exec redis redis-cli --user op_admin -a "$ADMIN_PW" INFO keyspace

# Check MinIO buckets
mc alias set op http://localhost:9000 "$OP_MINIO_USER" "$OP_MINIO_PASSWORD"
mc ls op/
```

### Start Services After Restore

```bash
docker compose up -d gateway-service auth-service ingestion-service \
  ontology-service pipeline-service execution-service app-service \
  logging-service plugin-service
```

---

## 4. Database Backup

### pg_dump Per-Schema vs Full Database

The backup.sh script dumps the entire `oneplatform` database, which includes all 9 service schemas in a single file. This is the recommended approach for full backups — it captures referential integrity across schemas and restores in a single operation.

To dump a single schema for partial recovery:

```bash
# Dump only the auth schema
docker compose exec -T postgres pg_dump \
  -U postgres \
  -d oneplatform \
  -n auth \
  -F custom \
  -f /tmp/auth_schema.dump

docker compose cp postgres:/tmp/auth_schema.dump ./auth_schema_$(date +%Y%m%d_%H%M%S).dump
docker compose exec -T postgres rm -f /tmp/auth_schema.dump
```

Available schemas: `auth`, `ingestion`, `ontology`, `pipeline`, `execution`, `app`, `logging`, `plugin`, `gateway`

To dump only a specific table:

```bash
docker compose exec -T postgres pg_dump \
  -U postgres \
  -d oneplatform \
  -n auth \
  -t users \
  -F custom \
  -f /tmp/auth_users.dump
```

### Listing Backup Contents Without Restoring

Before restoring, inspect the contents of a dump file:

```bash
# List all objects in a dump
pg_restore --list ./backups/20260617_143022/postgres.dump

# Count objects by type
pg_restore --list ./backups/20260617_143022/postgres.dump | \
  awk '{print $2}' | sort | uniq -c | sort -rn
```

If `pg_restore` is not available on the host, run it inside the postgres container:

```bash
docker compose cp ./backups/20260617_143022/postgres.dump postgres:/tmp/check.dump
docker compose exec postgres pg_restore --list /tmp/check.dump
docker compose exec -T postgres rm /tmp/check.dump
```

### WAL Archiving for Point-In-Time Recovery

The default stack does not configure WAL archiving. To achieve sub-hourly RPO, enable WAL archiving in PostgreSQL:

**Step 1: Configure PostgreSQL for WAL archiving**

Create `docker/postgres/postgresql.conf` with:

```ini
wal_level = replica
archive_mode = on
archive_command = 'cp %p /var/lib/postgresql/wal_archive/%f'
archive_timeout = 300
```

Mount this file in docker-compose.yml under the postgres service:

```yaml
volumes:
  - ./postgres/postgresql.conf:/etc/postgresql/postgresql.conf:ro
  - wal-archive:/var/lib/postgresql/wal_archive
```

And add `wal-archive` to the volumes section.

**Step 2: Take a base backup**

```bash
# Take a base backup (required before WAL files are useful)
docker compose exec postgres pg_basebackup \
  -U postgres \
  -D /var/lib/postgresql/basebackup \
  -Ft -z -P

docker compose cp postgres:/var/lib/postgresql/basebackup/base.tar.gz \
  ./backups/basebackup_$(date +%Y%m%d_%H%M%S).tar.gz
```

**Step 3: Copy WAL files off-host regularly**

```bash
# Add to cron — copy new WAL files every 5 minutes
*/5 * * * * rsync -a /var/lib/docker/volumes/oneplatform_wal-archive/_data/ \
  /mnt/backup-disk/wal-archive/
```

**Note:** WAL archiving significantly increases disk I/O and storage requirements. For most deployments, daily pg_dump with an acceptable RPO of 24 hours is sufficient. WAL archiving is recommended only when RPO requirements are under 1 hour.

### Backup Validation

Always validate a backup before relying on it:

```bash
# Verify the dump is parseable (fast — does not restore data)
pg_restore --list ./backups/20260617_143022/postgres.dump > /dev/null && echo "VALID"

# Full test restore to a separate database (requires postgres running)
docker compose exec postgres createdb -U postgres oneplatform_test

docker compose cp ./backups/20260617_143022/postgres.dump postgres:/tmp/test.dump
docker compose exec postgres pg_restore \
  -U postgres \
  -d oneplatform_test \
  --no-owner \
  --no-privileges \
  /tmp/test.dump

# Check row counts in test database
docker compose exec postgres psql -U postgres -d oneplatform_test \
  -c "SELECT schemaname, tablename, n_live_tup FROM pg_stat_user_tables ORDER BY n_live_tup DESC LIMIT 20;"

# Clean up
docker compose exec postgres dropdb -U postgres oneplatform_test
docker compose exec -T postgres rm /tmp/test.dump
```

### Estimating Backup Size

```bash
# Check database size before taking a backup
docker compose exec postgres psql -U postgres -d oneplatform -c "
  SELECT
    schema_name,
    pg_size_pretty(sum(table_size)) AS size
  FROM (
    SELECT
      nspname AS schema_name,
      pg_total_relation_size(c.oid) AS table_size
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
  ) t
  GROUP BY schema_name
  ORDER BY sum(table_size) DESC;
"

# Total database size
docker compose exec postgres psql -U postgres -c \
  "SELECT pg_size_pretty(pg_database_size('oneplatform'));"
```

The pg_dump custom format compresses data; expect the dump file to be 20–40% of the raw database size for typical workloads with text-heavy data.

---

## 5. Redis Backup

### Redis Persistence Configuration

The stack configures Redis with both RDB (snapshotting) and AOF (append-only file) persistence. The AOF file provides crash recovery between RDB snapshots. See `docker/redis/redis.conf` for the exact configuration.

### What the RDB Backup Contains

The RDB snapshot captures all Redis keys at the moment `BGSAVE` completes. This includes:

- BullMQ job queues (waiting, active, delayed, completed, failed)
- Rate-limit counters (short-lived keys, not critical)
- Any session or cache data stored by services

**Data loss warning:** The RDB backup only captures a point-in-time snapshot. Any jobs that entered the queue between the last BGSAVE and the backup will be missing from the backup. On restore, jobs that were in `active` state (being processed) at backup time will appear as stuck active jobs in BullMQ — these must be manually reconciled or cleaned up after restore.

**BullMQ jobs and PostgreSQL:** Most job data is also recorded in PostgreSQL (pipeline runs, execution records, etc.). If jobs are lost from Redis but their originating records exist in PostgreSQL, jobs can often be re-triggered from the application UI. Redis state for BullMQ is recoverable to some degree from PostgreSQL state.

### Manual Redis Backup

```bash
# Trigger a BGSAVE and wait for completion, then copy the RDB
ADMIN_PW=$(docker compose exec -T redis cat /data/init/redis_password_admin.txt | tr -d '[:space:]')

BEFORE=$(docker compose exec -T redis redis-cli --user op_admin -a "$ADMIN_PW" LASTSAVE | tr -d '[:space:]')
docker compose exec -T redis redis-cli --user op_admin -a "$ADMIN_PW" BGSAVE

# Wait for save to complete
for i in $(seq 1 60); do
  AFTER=$(docker compose exec -T redis redis-cli --user op_admin -a "$ADMIN_PW" LASTSAVE | tr -d '[:space:]')
  [ "$AFTER" != "$BEFORE" ] && echo "BGSAVE complete" && break
  sleep 1
done

docker compose cp redis:/data/dump.rdb ./redis_$(date +%Y%m%d_%H%M%S).rdb
```

### Checking Redis Memory Usage Before Backup

```bash
ADMIN_PW=$(docker compose exec -T redis cat /data/init/redis_password_admin.txt | tr -d '[:space:]')
docker compose exec redis redis-cli --user op_admin -a "$ADMIN_PW" INFO memory | grep used_memory_human
```

The stack limits Redis to 512 MB (`deploy.resources.limits.memory: 512m`). Expect RDB files to be 10–200 MB.

### Restoring Redis

**Option 1 (automated):** Use restore.sh as documented in Section 3.

**Option 2 (manual):**

```bash
# Stop Redis
docker compose stop redis

# Copy the RDB file into the container
docker compose cp ./redis_20260617_143022.rdb redis:/data/dump.rdb

# Start Redis — it loads the RDB on startup
docker compose start redis

# Verify
ADMIN_PW=$(docker compose exec -T redis cat /data/init/redis_password_admin.txt | tr -d '[:space:]')
docker compose exec redis redis-cli --user op_admin -a "$ADMIN_PW" PING
docker compose exec redis redis-cli --user op_admin -a "$ADMIN_PW" INFO keyspace
```

### AOF Recovery

If the RDB is missing or corrupt but an AOF file exists at `/data/appendonly.aof` inside the container, Redis will prefer the AOF for recovery (it has higher durability). The restore.sh script only handles RDB files. To restore from AOF:

```bash
# Check AOF file integrity
docker compose exec redis redis-check-aof /data/appendonly.aof

# If the AOF is truncated (common after crash), repair it
docker compose exec redis redis-check-aof --fix /data/appendonly.aof
```

---

## 6. Object Storage Backup

### MinIO Data Overview

MinIO stores binary objects that cannot be reconstructed from the database: uploaded connector credential files, exported data artifacts, plugin packages, and similar binary assets. The database records metadata (object keys, bucket names) but not the objects themselves.

### Prerequisites: Install MinIO Client

```bash
# Linux x86_64
curl -fsSL https://dl.min.io/client/mc/release/linux-amd64/mc -o /usr/local/bin/mc
chmod +x /usr/local/bin/mc

# Verify
mc --version
```

### Mirror All Buckets to a Local Directory

```bash
export OP_MINIO_USER=minioadmin
export OP_MINIO_PASSWORD=yourpassword

MC_ALIAS="op_backup_$(date +%s)"
mc alias set "$MC_ALIAS" http://localhost:9000 "$OP_MINIO_USER" "$OP_MINIO_PASSWORD"

mc mirror "$MC_ALIAS" /mnt/backup-disk/minio-mirror/

mc alias remove "$MC_ALIAS"
```

### Mirror to Off-Site S3

```bash
# Mirror MinIO to AWS S3
mc alias set aws-backup https://s3.amazonaws.com "$AWS_ACCESS_KEY" "$AWS_SECRET_KEY"
mc mirror "$MC_ALIAS" "aws-backup/your-bucket-name/oneplatform-minio/"
```

### Mirror to Backblaze B2

```bash
mc alias set b2-backup https://s3.us-west-004.backblazeb2.com "$B2_KEY_ID" "$B2_APP_KEY"
mc mirror "$MC_ALIAS" "b2-backup/your-bucket-name/oneplatform-minio/"
```

### Listing Buckets and Object Counts

```bash
mc alias set op http://localhost:9000 "$OP_MINIO_USER" "$OP_MINIO_PASSWORD"

# List all buckets
mc ls op/

# Count objects and total size per bucket
mc du --depth 1 op/
```

### Bucket Lifecycle Policies for Automatic Cleanup

Large deployments accumulate export artifacts and temporary objects. Set retention policies to avoid unbounded growth:

```bash
# Delete objects in the "exports" bucket older than 30 days
mc ilm rule add op/exports --expire-days 30

# Delete objects in the "temp" bucket older than 7 days
mc ilm rule add op/temp --expire-days 7

# View existing lifecycle rules
mc ilm rule ls op/exports
```

### Restoring MinIO Data

```bash
# Mirror from local backup back to MinIO (overwrites matching objects)
mc mirror /mnt/backup-disk/minio-mirror/ op/ --overwrite

# Mirror from S3 back to MinIO
mc mirror "aws-backup/your-bucket-name/oneplatform-minio/" op/ --overwrite
```

**Note:** `mc mirror --overwrite` does not delete objects in the destination that are absent from the source. To fully restore to the exact backup state, clear the buckets first:

```bash
# WARNING: deletes all objects in a bucket
mc rm --recursive --force op/exports
mc mirror /mnt/backup-disk/minio-mirror/exports/ op/exports/ --overwrite
```

---

## 7. Secret Backup

### Why This Section Is Critical

The `init-data` Docker volume is the single most important asset to back up. Without it:

- All AES-256-GCM encrypted data in PostgreSQL cannot be decrypted
- PgBouncer cannot authenticate any service (all DB passwords are stored here)
- Redis ACL authentication fails for all services
- Service-to-service JWT verification fails (private keys are gone)
- The entire stack cannot restart

A PostgreSQL backup without the matching `init-data` backup is unrecoverable.

### What Is in init-data

All files are at `/data/init/` inside the `init-data` volume (mode 0400 — readable only by root):

```
/data/init/
├── ready                              # Completion signal file
├── master.key                         # AES-256-GCM master key (32 bytes base64)
├── jwt.secret                         # HS256 JWT secret (64 hex chars)
├── cursor.secret                      # HMAC-SHA256 cursor secret (64 hex chars)
├── bootstrap.token                    # One-time bootstrap token (may be empty)
├── db_password_auth.txt               # 32-char alphanumeric
├── db_password_gateway.txt
├── db_password_ingestion.txt
├── db_password_ontology.txt
├── db_password_pipeline.txt
├── db_password_execution.txt
├── db_password_app.txt
├── db_password_logging.txt
├── db_password_plugin.txt
├── db_password_postgres_superuser.txt # PostgreSQL superuser password
├── db_password_pgbouncer_admin.txt    # PgBouncer admin user password
├── db_password_pgbouncer_stats.txt    # PgBouncer stats user password
├── redis_password_admin.txt           # op_admin Redis ACL password
├── redis_password_auth.txt
├── redis_password_gateway.txt
├── redis_password_ingestion.txt
├── redis_password_ontology.txt
├── redis_password_pipeline.txt
├── redis_password_execution.txt
├── redis_password_app.txt
├── redis_password_logging.txt
├── redis_password_plugin.txt
└── keys/
    ├── auth-service/private.pem       # Ed25519 private key
    ├── gateway-service/private.pem
    ├── ingestion-service/private.pem
    ├── ontology-service/private.pem
    ├── pipeline-service/private.pem
    ├── execution-service/private.pem
    ├── app-service/private.pem
    ├── logging-service/private.pem
    └── plugin-service/private.pem
```

### Backing Up init-data (Encrypted)

Never store secrets unencrypted. Use GPG symmetric encryption or, better, asymmetric encryption with a stored key:

```bash
# Create an encrypted tar archive of the init-data volume
# The volume data lives on the host at the Docker volume path
INIT_VOLUME_PATH=$(docker volume inspect oneplatform_init-data --format '{{ .Mountpoint }}')

# GPG symmetric encryption (requires passphrase at restore time)
tar -czf - -C "$INIT_VOLUME_PATH" . | \
  gpg --symmetric --cipher-algo AES256 \
  --output /mnt/backup-disk/secrets/init-data_$(date +%Y%m%d_%H%M%S).tar.gz.gpg

chmod 600 /mnt/backup-disk/secrets/init-data_$(date +%Y%m%d_%H%M%S).tar.gz.gpg
```

**Alternatively**, use OpenSSL:

```bash
INIT_VOLUME_PATH=$(docker volume inspect oneplatform_init-data --format '{{ .Mountpoint }}')

tar -czf - -C "$INIT_VOLUME_PATH" . | \
  openssl enc -aes-256-cbc -pbkdf2 -iter 600000 \
  -out /mnt/backup-disk/secrets/init-data_$(date +%Y%m%d_%H%M%S).tar.gz.enc

chmod 600 /mnt/backup-disk/secrets/*.enc
```

### Restoring init-data

**Restoring into the existing volume (in-place restore):**

```bash
# Stop all services first
docker compose stop

# Get the volume mount path
INIT_VOLUME_PATH=$(docker volume inspect oneplatform_init-data --format '{{ .Mountpoint }}')

# Decrypt and restore (GPG)
gpg --decrypt /mnt/backup-disk/secrets/init-data_20260617_143022.tar.gz.gpg | \
  tar -xzf - -C "$INIT_VOLUME_PATH"

# Decrypt and restore (OpenSSL)
openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 \
  -in /mnt/backup-disk/secrets/init-data_20260617_143022.tar.gz.enc | \
  tar -xzf - -C "$INIT_VOLUME_PATH"

# Fix permissions — init.sh sets 0400 but tar may not preserve them on all systems
chmod 0400 "$INIT_VOLUME_PATH"/*.txt "$INIT_VOLUME_PATH"/*.key "$INIT_VOLUME_PATH"/*.secret "$INIT_VOLUME_PATH"/*.token 2>/dev/null || true
find "$INIT_VOLUME_PATH/keys" -name "*.pem" -exec chmod 0400 {} \;
```

**Restoring to a fresh Docker volume:**

```bash
# Create the volume if it does not exist
docker volume create oneplatform_init-data

INIT_VOLUME_PATH=$(docker volume inspect oneplatform_init-data --format '{{ .Mountpoint }}')

# Then follow the same restore steps above
```

### Deriving public keys from init-data after restore

After restoring init-data, the `shared-pubkeys` volume (which stores Ed25519 public keys) must also be populated. Public keys can be derived from the private keys in init-data:

```bash
# Run op-init to re-derive public keys from existing private keys
# init.sh is idempotent — it skips generation if files already exist
# and re-derives public keys from existing private keys if only private keys are present
docker compose run --rm op-init
```

### Storing Secret Backups Securely

- Store secret backups on separate physical media from the database backup
- Never commit secret backups to version control
- Consider using a hardware security module (HSM) or a secrets manager (HashiCorp Vault, AWS Secrets Manager) for production deployments
- Keep at least two copies in geographically separate locations
- Document the GPG/OpenSSL passphrase in a physical password manager (not digital — if the server is compromised, a digital copy may also be at risk)

---

## 8. Automated Backup Schedule

### Recommended Schedule

| Frequency | What | Retention |
|-----------|------|-----------|
| Hourly | PostgreSQL full dump | Keep 24 most recent |
| Every 6 hours | Redis RDB | Keep 4 most recent |
| Daily at 02:00 | Full backup (Postgres + Redis + MinIO) | Keep 7 daily |
| Weekly on Sunday at 03:00 | Full backup | Keep 4 weekly |
| Monthly on 1st at 04:00 | Full backup | Keep 12 monthly |
| After first deployment | Secrets (init-data) | Keep forever (offline) |

### Crontab Setup

Run `crontab -e` as the user who has permission to run `docker compose`, then paste:

```cron
# OnePlatform backup schedule
# Requires: REPO=/path/to/oneplatform, BACKUP_ROOT=/mnt/backup-disk/oneplatform
# Edit REPO and BACKUP_ROOT to match your installation.

REPO=/opt/oneplatform
BACKUP_ROOT=/mnt/backup-disk/oneplatform
OP_MINIO_USER=minioadmin
OP_MINIO_PASSWORD=yourpassword

# Hourly PostgreSQL backup (runs at minute 5 of every hour)
5 * * * * cd "$REPO" && docker compose exec -T postgres pg_dump -U postgres -d oneplatform -F custom -f /tmp/op_hourly.dump && docker compose cp postgres:/tmp/op_hourly.dump "$BACKUP_ROOT/hourly/postgres_$(date +\%Y\%m\%d_\%H\%M\%S).dump" && docker compose exec -T postgres rm -f /tmp/op_hourly.dump && find "$BACKUP_ROOT/hourly" -name "postgres_*.dump" -mmin +1500 -delete 2>&1 | logger -t oneplatform-backup

# Every 6 hours: Redis RDB backup (at minute 10, hours 0/6/12/18)
10 0,6,12,18 * * * cd "$REPO" && bash docker/scripts/backup.sh "$BACKUP_ROOT/redis-only" && find "$BACKUP_ROOT/redis-only" -mindepth 1 -maxdepth 1 -type d -mhour +25 | sort | head -n -4 | xargs rm -rf 2>&1 | logger -t oneplatform-backup

# Daily full backup at 02:00
0 2 * * * cd "$REPO" && OP_MINIO_USER="$OP_MINIO_USER" OP_MINIO_PASSWORD="$OP_MINIO_PASSWORD" bash docker/scripts/backup.sh "$BACKUP_ROOT/daily" && chmod 700 "$BACKUP_ROOT/daily/"* && find "$BACKUP_ROOT/daily" -mindepth 1 -maxdepth 1 -type d -mtime +7 | xargs rm -rf 2>&1 | logger -t oneplatform-backup

# Weekly full backup on Sunday at 03:00
0 3 * * 0 cd "$REPO" && OP_MINIO_USER="$OP_MINIO_USER" OP_MINIO_PASSWORD="$OP_MINIO_PASSWORD" bash docker/scripts/backup.sh "$BACKUP_ROOT/weekly" && chmod 700 "$BACKUP_ROOT/weekly/"* && find "$BACKUP_ROOT/weekly" -mindepth 1 -maxdepth 1 -type d -mtime +29 | xargs rm -rf 2>&1 | logger -t oneplatform-backup

# Monthly full backup on 1st at 04:00
0 4 1 * * cd "$REPO" && OP_MINIO_USER="$OP_MINIO_USER" OP_MINIO_PASSWORD="$OP_MINIO_PASSWORD" bash docker/scripts/backup.sh "$BACKUP_ROOT/monthly" && chmod 700 "$BACKUP_ROOT/monthly/"* && find "$BACKUP_ROOT/monthly" -mindepth 1 -maxdepth 1 -type d -mtime +366 | xargs rm -rf 2>&1 | logger -t oneplatform-backup
```

### Backup Wrapper Script with Alerting

For production use, wrap backup.sh in a script that sends alerts on failure. Create `/opt/oneplatform/docker/scripts/backup-cron.sh`:

```bash
#!/bin/bash
# backup-cron.sh — wrapper for cron execution with alerting on failure
# Usage: backup-cron.sh <backup-root> [--notify-email admin@example.com]

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
BACKUP_ROOT="${1:?ERROR: backup root directory required}"
NOTIFY_EMAIL="${3:-}"  # $2 is --notify-email flag, $3 is the address

LOG_FILE="/var/log/oneplatform/backup_$(date +%Y%m%d_%H%M%S).log"
mkdir -p /var/log/oneplatform

if bash "$REPO/docker/scripts/backup.sh" "$BACKUP_ROOT" > "$LOG_FILE" 2>&1; then
  echo "Backup succeeded: $(tail -1 "$LOG_FILE")" | logger -t oneplatform-backup
else
  EXIT_CODE=$?
  MSG="OnePlatform backup FAILED (exit $EXIT_CODE). See $LOG_FILE"
  echo "$MSG" | logger -t oneplatform-backup
  if [ -n "$NOTIFY_EMAIL" ]; then
    mail -s "ALERT: OnePlatform backup failed" "$NOTIFY_EMAIL" < "$LOG_FILE"
  fi
  exit $EXIT_CODE
fi
```

### Retention Policy Implementation

The cron entries above use `find -mtime +N -delete` for rotation. For more robust retention across reboots and time-zone changes, use a dedicated tool:

```bash
# Install logrotate-style rotation with findutils
# Keep last 7 daily backups:
find "$BACKUP_ROOT/daily" -mindepth 1 -maxdepth 1 -type d | \
  sort -r | \
  tail -n +8 | \
  xargs rm -rf
```

---

## 9. Disaster Recovery Procedure

This section covers a complete recovery from scratch: new host, all data lost, restoring from backup.

### Prerequisites Checklist

Before starting recovery, confirm you have:

- [ ] A backup directory from backup.sh (e.g., `20260617_143022/`)
- [ ] The encrypted init-data archive (secrets backup)
- [ ] The GPG or OpenSSL passphrase for the secrets archive
- [ ] The repository cloned on the new host
- [ ] Docker and Docker Compose installed
- [ ] `mc` (MinIO Client) installed if MinIO data needs restoring
- [ ] `OP_MINIO_USER` and `OP_MINIO_PASSWORD` noted from the original deployment's `.env`

---

### Disaster Recovery Runbook

Print this section. Follow every step in order. Check each box.

#### Phase 1: Prepare the Host

- [ ] **1.1** Install Docker Engine and Docker Compose plugin
  ```bash
  curl -fsSL https://get.docker.com | sh
  docker --version
  docker compose version
  ```

- [ ] **1.2** Clone the repository
  ```bash
  git clone https://github.com/your-org/oneplatform.git /opt/oneplatform
  cd /opt/oneplatform
  ```

- [ ] **1.3** Create the backup mount directory and copy backup files to the host
  ```bash
  mkdir -p /mnt/restore
  # Copy or mount your backup media here
  # ls /mnt/restore/20260617_143022/
  ```

#### Phase 2: Restore Secrets

**This must happen before any data store is started. The database and Redis use secrets from init-data on startup.**

- [ ] **2.1** Create Docker volumes for secrets
  ```bash
  docker volume create oneplatform_init-data
  docker volume create oneplatform_shared-pubkeys
  ```

- [ ] **2.2** Get the init-data volume mount path
  ```bash
  INIT_VOLUME_PATH=$(docker volume inspect oneplatform_init-data --format '{{ .Mountpoint }}')
  echo "Init data path: $INIT_VOLUME_PATH"
  ```

- [ ] **2.3** Decrypt and restore the secrets archive
  ```bash
  # If encrypted with GPG:
  gpg --decrypt /mnt/restore/secrets/init-data_20260617_143022.tar.gz.gpg | \
    tar -xzf - -C "$INIT_VOLUME_PATH"

  # If encrypted with OpenSSL:
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 \
    -in /mnt/restore/secrets/init-data_20260617_143022.tar.gz.enc | \
    tar -xzf - -C "$INIT_VOLUME_PATH"
  ```

- [ ] **2.4** Fix file permissions
  ```bash
  find "$INIT_VOLUME_PATH" -maxdepth 1 -type f -exec chmod 0400 {} \;
  find "$INIT_VOLUME_PATH/keys" -name "*.pem" -exec chmod 0400 {} \;
  ```

- [ ] **2.5** Verify secrets are present
  ```bash
  ls -la "$INIT_VOLUME_PATH/"
  # Expected: master.key, jwt.secret, cursor.secret, bootstrap.token,
  #           db_password_*.txt, redis_password_*.txt, keys/
  ls -la "$INIT_VOLUME_PATH/keys/"
  # Expected: one directory per service, each with private.pem
  ```

- [ ] **2.6** Derive public keys by running op-init (idempotent — skips generation, re-derives public keys)
  ```bash
  cd /opt/oneplatform
  docker compose run --rm op-init
  # Expected output: "[op-init] Initialization complete."
  ```

#### Phase 3: Start Data Stores Only

- [ ] **3.1** Start PostgreSQL, Redis, MinIO, and PgBouncer
  ```bash
  cd /opt/oneplatform
  docker compose up -d postgres redis minio pgbouncer
  ```

- [ ] **3.2** Wait for all data stores to become healthy
  ```bash
  # Poll until healthy (up to 2 minutes)
  for i in $(seq 1 24); do
    docker compose ps --format "table {{.Name}}\t{{.Status}}" | grep -E "postgres|redis|minio|pgbouncer"
    docker compose ps | grep -q "unhealthy\|starting" || break
    echo "Waiting for data stores... ($i/24)"
    sleep 5
  done
  docker compose ps
  ```

#### Phase 4: Restore PostgreSQL

- [ ] **4.1** Stop application services (they are not running yet, but be certain)
  ```bash
  docker compose stop gateway-service auth-service ingestion-service \
    ontology-service pipeline-service execution-service app-service \
    logging-service plugin-service 2>/dev/null || true
  ```

- [ ] **4.2** Run restore.sh for PostgreSQL
  ```bash
  ./docker/scripts/restore.sh /mnt/restore/20260617_143022 --yes
  ```

- [ ] **4.3** Verify PostgreSQL restore
  ```bash
  docker compose exec postgres psql -U postgres -d oneplatform \
    -c "SELECT schemaname, count(*) as tables FROM pg_tables GROUP BY schemaname ORDER BY schemaname;"
  ```
  Expected: rows for `auth`, `ingestion`, `ontology`, `pipeline`, `execution`, `app`, `logging`, `plugin`, `gateway`

#### Phase 5: Restore Redis

restore.sh handles Redis as part of step 4.2 above. Verify:

- [ ] **5.1** Confirm Redis is populated
  ```bash
  ADMIN_PW=$(docker compose exec -T redis cat /data/init/redis_password_admin.txt | tr -d '[:space:]')
  docker compose exec redis redis-cli --user op_admin -a "$ADMIN_PW" INFO keyspace
  docker compose exec redis redis-cli --user op_admin -a "$ADMIN_PW" INFO memory | grep used_memory_human
  ```

#### Phase 6: Restore MinIO

- [ ] **6.1** Install mc if not present
  ```bash
  which mc || (curl -fsSL https://dl.min.io/client/mc/release/linux-amd64/mc -o /usr/local/bin/mc && chmod +x /usr/local/bin/mc)
  ```

- [ ] **6.2** Set MinIO credentials (from your original .env or secrets)
  ```bash
  export OP_MINIO_USER=minioadmin
  export OP_MINIO_PASSWORD=yourpassword
  ```

- [ ] **6.3** Mirror MinIO backup to the live instance
  ```bash
  mc alias set op_restore http://localhost:9000 "$OP_MINIO_USER" "$OP_MINIO_PASSWORD"
  mc mirror /mnt/restore/20260617_143022/minio/ op_restore/ --overwrite
  mc alias remove op_restore
  ```

- [ ] **6.4** Verify MinIO buckets
  ```bash
  mc alias set op http://localhost:9000 "$OP_MINIO_USER" "$OP_MINIO_PASSWORD"
  mc ls op/
  mc du --depth 1 op/
  mc alias remove op
  ```

#### Phase 7: Start Application Services

- [ ] **7.1** Start all application services, frontend, and Caddy
  ```bash
  cd /opt/oneplatform
  docker compose up -d gateway-service auth-service ingestion-service \
    ontology-service pipeline-service execution-service app-service \
    logging-service plugin-service frontend caddy
  ```

- [ ] **7.2** Wait for services to become healthy (they run database migrations on startup)
  ```bash
  for i in $(seq 1 36); do
    docker compose ps --format "table {{.Name}}\t{{.Status}}"
    docker compose ps | grep -qE "unhealthy|starting" || break
    echo "Waiting for services... ($i/36)"
    sleep 5
  done
  ```

- [ ] **7.3** Confirm all services are healthy
  ```bash
  docker compose ps
  # All services should show "healthy"
  ```

#### Phase 8: Smoke Test

- [ ] **8.1** Test the API gateway through Caddy
  ```bash
  curl -fk https://localhost/healthz && echo "Gateway via Caddy: OK"
  ```

- [ ] **8.2** Test the frontend through Caddy
  ```bash
  curl -fk https://localhost/ | head -5
  ```

- [ ] **8.3** Log in through the UI and verify data is present

- [ ] **8.4** Check service logs for errors
  ```bash
  docker compose logs --since 5m --no-log-prefix gateway-service auth-service | grep -i error
  ```

#### Phase 9: Post-Recovery

- [ ] **9.1** Re-configure MinIO credentials in `.env` if they changed
- [ ] **9.2** Re-schedule cron backup jobs on the new host
- [ ] **9.3** Test a backup to confirm the new host's backup pipeline works
  ```bash
  ./docker/scripts/backup.sh /mnt/backup-disk/oneplatform/post-recovery-test
  ```
- [ ] **9.4** Document the incident: what failed, how long recovery took, what to improve

---

## 10. Partial Recovery

### Recovering a Single Service's Database Schema

If only one service's data is corrupted or needs rollback, restore just its schema:

```bash
# Stop only the affected service
docker compose stop auth-service

# Dump only the auth schema from the backup into a temp file
docker compose cp ./backups/20260617_143022/postgres.dump postgres:/tmp/restore.dump

# Restore only the auth schema
docker compose exec -T postgres pg_restore \
  -U postgres \
  -d oneplatform \
  --schema=auth \
  --clean \
  --if-exists \
  --no-owner \
  --no-privileges \
  /tmp/restore.dump

docker compose exec -T postgres rm -f /tmp/restore.dump

# Restart the service
docker compose start auth-service
```

Available schemas: `auth`, `ingestion`, `ontology`, `pipeline`, `execution`, `app`, `logging`, `plugin`, `gateway`

### Recovering from Corrupted Redis State

If Redis data is corrupted (e.g., bad RDB file, truncated AOF), the safest recovery path is to flush Redis and let services rebuild their state from PostgreSQL:

```bash
ADMIN_PW=$(docker compose exec -T redis cat /data/init/redis_password_admin.txt | tr -d '[:space:]')

# Option 1: Flush all Redis data (data is rebuilt by services on restart)
docker compose exec redis redis-cli --user op_admin -a "$ADMIN_PW" FLUSHALL

# Option 2: Flush only a specific database (if services use db-per-service partitioning)
docker compose exec redis redis-cli --user op_admin -a "$ADMIN_PW" SELECT 0
docker compose exec redis redis-cli --user op_admin -a "$ADMIN_PW" FLUSHDB

# Restart all services to re-populate caches and re-register queues
docker compose restart gateway-service auth-service ingestion-service \
  ontology-service pipeline-service execution-service app-service \
  logging-service plugin-service
```

**BullMQ job recovery after FLUSHALL:** Jobs that were waiting or delayed in BullMQ are lost after FLUSHALL. To re-trigger pending pipeline runs, use the OnePlatform admin UI or API to identify pipeline runs in `pending` or `running` state in PostgreSQL and re-enqueue them.

```sql
-- Find pipeline runs that may need re-queuing after Redis flush
SELECT id, pipeline_id, status, created_at
FROM pipeline.runs
WHERE status IN ('pending', 'running')
ORDER BY created_at DESC
LIMIT 50;
```

### Recovering from MinIO Data Loss

If specific objects are missing or corrupt in MinIO, restore just those objects:

```bash
# Restore a specific bucket from backup
mc alias set op http://localhost:9000 "$OP_MINIO_USER" "$OP_MINIO_PASSWORD"
mc mirror /mnt/backup-disk/oneplatform/20260617_143022/minio/uploads/ op/uploads/ --overwrite

# Restore a specific object
mc cp /mnt/backup-disk/oneplatform/20260617_143022/minio/uploads/some-file.pdf op/uploads/some-file.pdf
```

### Recovering from a Failed Op-Init

If the `init-data` volume is empty or partially populated (e.g., after accidental volume deletion):

**If you have a secrets backup:** Follow Phase 2 of the Disaster Recovery Runbook above.

**If you do NOT have a secrets backup:** You cannot recover encrypted database data. The only path forward is to re-initialize from scratch:

```bash
# WARNING: This destroys ALL existing data. Only do this if you have no secrets backup
# and accept that all encrypted data is unrecoverable.

docker compose down -v  # removes all volumes including postgres-data
docker compose run --rm op-init  # generates fresh secrets
docker compose up -d
# The stack starts fresh with no application data
```

---

## 11. Backup Validation

### Automated Validation Script

Create `/opt/oneplatform/docker/scripts/validate-backup.sh`:

```bash
#!/bin/bash
# validate-backup.sh — verify a backup directory is complete and restorable
# Usage: validate-backup.sh <backup-dir>
#
# Checks:
#   1. All expected files are present
#   2. Files are non-empty
#   3. postgres.dump is parseable by pg_restore
#   4. redis.rdb passes redis-check-rdb (if available)
#   5. SHA256 checksums match (if checksum file exists)

set -e

BACKUP_DIR="${1:?Usage: validate-backup.sh <backup-dir>}"

ERRORS=0

check() {
  local desc="$1"
  local file="$2"
  if [ ! -f "$file" ]; then
    echo "FAIL: $desc — file missing: $file" >&2
    ERRORS=$((ERRORS + 1))
  elif [ ! -s "$file" ]; then
    echo "FAIL: $desc — file is empty: $file" >&2
    ERRORS=$((ERRORS + 1))
  else
    echo "OK:   $desc ($file, $(du -sh "$file" | cut -f1))"
  fi
}

echo "Validating backup: $BACKUP_DIR"
echo ""

# Check required files
check "PostgreSQL dump"  "$BACKUP_DIR/postgres.dump"
check "Redis RDB"        "$BACKUP_DIR/redis.rdb"

# Validate postgres.dump is parseable
if [ -f "$BACKUP_DIR/postgres.dump" ]; then
  if pg_restore --list "$BACKUP_DIR/postgres.dump" > /dev/null 2>&1; then
    echo "OK:   postgres.dump is parseable by pg_restore"
  else
    echo "FAIL: postgres.dump failed pg_restore --list" >&2
    ERRORS=$((ERRORS + 1))
  fi
fi

# Validate redis.rdb with redis-check-rdb if available
if [ -f "$BACKUP_DIR/redis.rdb" ]; then
  if command -v redis-check-rdb > /dev/null 2>&1; then
    if redis-check-rdb "$BACKUP_DIR/redis.rdb" > /dev/null 2>&1; then
      echo "OK:   redis.rdb passes redis-check-rdb"
    else
      echo "FAIL: redis.rdb failed redis-check-rdb" >&2
      ERRORS=$((ERRORS + 1))
    fi
  else
    echo "SKIP: redis-check-rdb not available — install redis-tools to enable"
  fi
fi

# Verify checksums if a checksum file was generated
if [ -f "$BACKUP_DIR/SHA256SUMS" ]; then
  if sha256sum --check "$BACKUP_DIR/SHA256SUMS" --quiet; then
    echo "OK:   SHA256 checksums match"
  else
    echo "FAIL: SHA256 checksum mismatch" >&2
    ERRORS=$((ERRORS + 1))
  fi
else
  echo "SKIP: no SHA256SUMS file — generate checksums after backup with:"
  echo "      sha256sum $BACKUP_DIR/postgres.dump $BACKUP_DIR/redis.rdb > $BACKUP_DIR/SHA256SUMS"
fi

echo ""
if [ "$ERRORS" -eq 0 ]; then
  echo "Validation PASSED (0 errors)"
else
  echo "Validation FAILED ($ERRORS errors)" >&2
  exit 1
fi
```

### Generating Checksums at Backup Time

Modify your cron backup to generate checksums immediately after backup completes:

```bash
./docker/scripts/backup.sh /mnt/backup-disk/oneplatform/daily

# Find the most recently created backup directory
LATEST=$(find /mnt/backup-disk/oneplatform/daily -mindepth 1 -maxdepth 1 -type d | sort | tail -1)

# Generate checksums
sha256sum "$LATEST"/postgres.dump "$LATEST"/redis.rdb > "$LATEST/SHA256SUMS"

# Validate immediately
./docker/scripts/validate-backup.sh "$LATEST"
```

### Periodic Restore Drills

A backup that has never been tested is a hypothesis, not a backup. Run a full restore drill monthly:

```bash
#!/bin/bash
# restore-drill.sh — restore to a separate test environment to verify backup integrity
# Requires: a second Docker Compose environment or isolated namespace

BACKUP_DIR="${1:?backup directory required}"
TEST_PROJECT="oneplatform_drill"

echo "Starting restore drill from $BACKUP_DIR"

# Spin up isolated test stack with a different project name
docker compose -p "$TEST_PROJECT" up -d postgres redis minio pgbouncer

# Wait for healthy state
sleep 15

# Restore into the test stack
BACKUP_DIR="$BACKUP_DIR" docker compose -p "$TEST_PROJECT" exec -T postgres \
  pg_restore -U postgres -d oneplatform --clean --if-exists --no-owner --no-privileges \
  /tmp/restore.dump

# Run spot checks
docker compose -p "$TEST_PROJECT" exec postgres \
  psql -U postgres -d oneplatform \
  -c "SELECT count(*) FROM auth.users;"

echo "Restore drill complete"

# Tear down test stack
docker compose -p "$TEST_PROJECT" down -v
```

### Alerting on Backup Failures

Add backup status monitoring via cron output capture:

```cron
# Send cron output to syslog and email on failure
MAILTO=ops@example.com
5 * * * * cd /opt/oneplatform && bash docker/scripts/backup.sh /mnt/backup-disk/oneplatform/hourly || echo "BACKUP FAILED at $(date)" | mail -s "OnePlatform backup failure" ops@example.com
```

Or use a monitoring tool that watches for a "last successful backup" timestamp file:

```bash
# At the end of a successful backup, touch a sentinel file
touch /var/lib/oneplatform/last-backup-ok

# Monitor this file's mtime — alert if older than 26 hours
find /var/lib/oneplatform -name last-backup-ok -mmin +1560 && echo "BACKUP OVERDUE"
```

---

## 12. Off-Site Backup

### Why Off-Site Backup Is Required

Local backups protect against application bugs, accidental deletion, and partial hardware failure. They do not protect against:

- Host server total loss (fire, theft, hardware failure)
- Ransomware that encrypts the backup disk along with the data
- Datacenter outage

Always maintain at least one off-site copy.

### Option 1: S3-Compatible Object Storage (Recommended)

```bash
# Install AWS CLI or use mc for any S3-compatible provider
pip install awscli

# Configure credentials
aws configure --profile oneplatform-backup

# Sync backup directory to S3
aws s3 sync /mnt/backup-disk/oneplatform/ \
  s3://your-bucket/oneplatform-backups/ \
  --profile oneplatform-backup \
  --storage-class STANDARD_IA \
  --sse AES256 \
  --delete

# Or use mc (works with AWS S3, Backblaze B2, MinIO, Wasabi, etc.)
mc alias set s3-offsite https://s3.amazonaws.com "$AWS_ACCESS_KEY" "$AWS_SECRET_KEY"
mc mirror /mnt/backup-disk/oneplatform/ s3-offsite/your-bucket/oneplatform-backups/ --overwrite --remove
```

Add to cron (run after the daily backup):

```cron
30 2 * * * aws s3 sync /mnt/backup-disk/oneplatform/daily/ s3://your-bucket/oneplatform-backups/daily/ --profile oneplatform-backup --storage-class STANDARD_IA --sse AES256 --delete 2>&1 | logger -t oneplatform-offsite
```

### Option 2: Backblaze B2 via mc

Backblaze B2 is cost-effective for large backups:

```bash
mc alias set b2 https://s3.us-west-004.backblazeb2.com "$B2_KEY_ID" "$B2_APP_KEY"
mc mirror /mnt/backup-disk/oneplatform/ b2/your-bucket/oneplatform/ --overwrite --remove
```

### Option 3: Encrypted Rsync to a Remote Host

```bash
# Rsync to a remote server over SSH
rsync -avz --delete \
  -e "ssh -i /home/ubuntu/.ssh/backup_key -o StrictHostKeyChecking=yes" \
  /mnt/backup-disk/oneplatform/ \
  backup@remote-host.example.com:/backups/oneplatform/
```

### Encrypting Before Transfer

Always encrypt backups that leave your infrastructure, even if the transport is TLS. The recipient host or storage bucket may be compromised independently:

```bash
# Encrypt the backup archive before upload
tar -czf - /mnt/backup-disk/oneplatform/20260617_143022/ | \
  gpg --symmetric --cipher-algo AES256 --batch --passphrase-file /etc/oneplatform/backup-passphrase | \
  aws s3 cp - s3://your-bucket/oneplatform-backups/20260617_143022.tar.gz.gpg \
    --profile oneplatform-backup

# Or encrypt at rest after upload (S3 server-side encryption)
aws s3 sync /mnt/backup-disk/oneplatform/20260617_143022/ \
  s3://your-bucket/oneplatform-backups/20260617_143022/ \
  --sse aws:kms \
  --ssekms-key-id your-kms-key-id
```

### Geographic Redundancy

For critical deployments, use storage in a different geographic region:

```bash
# Cross-region replication with AWS S3
aws s3 sync \
  s3://your-bucket-us-east/oneplatform-backups/ \
  s3://your-bucket-eu-west/oneplatform-backups/ \
  --source-region us-east-1 \
  --region eu-west-1

# Backblaze B2 across regions
mc alias set b2-eu https://s3.eu-central-003.backblazeb2.com "$B2_KEY_ID" "$B2_APP_KEY"
mc mirror b2/us-bucket/oneplatform/ b2-eu/eu-bucket/oneplatform/ --overwrite
```

### Backup Retention in Off-Site Storage

Configure lifecycle rules on your off-site bucket to automatically expire old backups:

```bash
# AWS S3 lifecycle policy — keep daily backups for 30 days, weekly for 90 days
aws s3api put-bucket-lifecycle-configuration \
  --bucket your-bucket \
  --lifecycle-configuration '{
    "Rules": [
      {
        "ID": "delete-old-daily-backups",
        "Filter": {"Prefix": "oneplatform-backups/daily/"},
        "Status": "Enabled",
        "Expiration": {"Days": 30}
      },
      {
        "ID": "transition-weekly-to-glacier",
        "Filter": {"Prefix": "oneplatform-backups/weekly/"},
        "Status": "Enabled",
        "Transitions": [{"Days": 7, "StorageClass": "GLACIER"}],
        "Expiration": {"Days": 365}
      }
    ]
  }'
```

### Verifying Off-Site Backups Are Current

Add a monitoring check that alerts if the most recent off-site backup is older than expected:

```bash
# Check that S3 has a backup from the last 26 hours
LATEST_S3=$(aws s3 ls s3://your-bucket/oneplatform-backups/daily/ --profile oneplatform-backup \
  | sort | tail -1 | awk '{print $2}' | tr -d '/')

if [ -z "$LATEST_S3" ]; then
  echo "ALERT: No daily backups found in S3" | logger -t oneplatform-backup-check
  exit 1
fi

echo "Latest S3 backup: $LATEST_S3" | logger -t oneplatform-backup-check
```
