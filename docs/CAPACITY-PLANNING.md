# OnePlatform Capacity Planning Guide

Resource sizing and scaling recommendations for the OnePlatform Docker Compose
stack. Use this guide when provisioning a new deployment or evaluating whether
an existing host needs more resources.

All memory limits cited below match the defaults in `docker/docker-compose.yml`.
Raising a limit requires editing the `deploy.resources.limits` block for the
affected service and restarting it.

Related documents:
- [OPERATIONS.md](OPERATIONS.md) — day-to-day operations, including scaling commands
- [DEPLOYMENT.md](DEPLOYMENT.md) — initial setup and host prerequisites
- [MONITORING.md](MONITORING.md) — alert thresholds and dashboard setup

---

## Table of Contents

1. [Quick-Reference: Scaling Tiers](#1-quick-reference-scaling-tiers)
2. [Service Sizing](#2-service-sizing)
3. [Database Sizing](#3-database-sizing)
4. [Redis Sizing](#4-redis-sizing)
5. [Object Storage Sizing](#5-object-storage-sizing)
6. [Monitoring Thresholds and Alert Rules](#6-monitoring-thresholds-and-alert-rules)
7. [Tuning Checklist by Tier](#7-tuning-checklist-by-tier)

---

## 1. Quick-Reference: Scaling Tiers

Choose a tier based on expected connector count and daily record volume. Each
tier's hardware budget covers the entire stack — application services, data
stores, and the observability sidecar (Jaeger + Vector + Grafana).

| Tier | Connectors | Records/day | CPU | RAM | Storage | PostgreSQL | Redis |
|------|-----------|-------------|-----|-----|---------|-----------|-------|
| **Small** | 1–10 | < 100 K | 4 cores | 8 GB | 100 GB SSD | Bundled in Compose | Bundled in Compose |
| **Medium** | 10–50 | ~1 M | 8 cores | 16 GB | 500 GB SSD | External, 4 cores / 16 GB | Bundled or external |
| **Large** | 50+ | 10 M+ | 16+ cores | 32+ GB | 2+ TB SSD | HA cluster (streaming replica) | Redis Sentinel or Cluster |

**CPU is measured in physical or dedicated-virtual cores.** Shared or burstable
vCPUs (AWS `t3`, GCP `e2-standard`) underperform the table above during
sustained load. Use compute-optimised instances for the Pipeline and Gateway
services at Medium and Large tiers.

---

## 2. Service Sizing

Each service has a characteristic resource bottleneck that determines both the
default limits in `docker/docker-compose.yml` and the sensible upper bounds for
a single instance. When a single instance is saturated, scale horizontally
(additional replicas) unless noted otherwise.

### 2.1 Gateway

**Bottleneck:** CPU (request routing, JWT validation, rate-limit counter
increments against Redis).

| | Default limit | Recommended range |
|---|---|---|
| Memory | 512 MB | 256 MB – 1 GB |
| CPU | 0.5 cores | 0.5 – 2 cores |

Scale the gateway horizontally when API latency rises at high request
concurrency or when gateway CPU sustains above 80 %. JWT validation is
stateless, so any replica handles any request. Place an HTTP load balancer
(Caddy upstream round-robin or an external LB) in front of multiple gateway
replicas.

The gateway keeps no local state beyond in-process rate-limit counters, which
are authoritative in Redis — replicas can be added or removed without draining.

### 2.2 Auth

**Bottleneck:** Low resource. Sessions are stored in PostgreSQL; token
validation reads shared Ed25519 public keys from the `shared-pubkeys` volume.

| | Default limit | Recommended range |
|---|---|---|
| Memory | 512 MB | 256 MB – 512 MB |
| CPU | 0.5 cores | 0.25 – 1 core |

A single instance is sufficient for most deployments. Add a second replica only
when login-endpoint latency climbs under bursts (e.g., morning sign-in peaks
with many concurrent users). SMTP email delivery is async via a BullMQ queue
(`bull:auth:*`), so email volume does not directly affect auth-service latency.

### 2.3 Ingestion

**Bottleneck:** Memory (in-process batch buffers during connector syncs).
`OP_INGESTION_BATCH_SIZE` (default 1000 records) and
`OP_LARGE_SYNC_CONCURRENCY` (default 3 simultaneous large syncs) control how
many records are held in memory at once.

| | Default limit | Recommended range |
|---|---|---|
| Memory | 1 GB | 512 MB – 4 GB |
| CPU | 1 core | 0.5 – 2 cores |

Memory formula per worker:

```
batch_memory ≈ batch_size × avg_record_size_bytes × 3
              (3× accounts for source data, validated copy, and serialised form)
```

Example: 1 000 records at 2 KB each ≈ 6 MB per concurrent sync. With
`OP_LARGE_SYNC_CONCURRENCY=3` that is ~18 MB of batch pressure. The larger
driver of memory growth is connector plugin overhead and the per-connector
connection pool. Raise the container limit when you see OOM kills
(`docker stats` shows memory at or near the limit).

Scale horizontally by adding ingestion replicas and raising
`OP_LARGE_SYNC_CONCURRENCY` on each. BullMQ queues distribute sync jobs across
all replicas automatically.

### 2.4 Ontology

**Bottleneck:** Low resource. Serves schema reads (read-heavy). Uses advisory
locks and PostgreSQL `LISTEN/NOTIFY`, which require a persistent connection
(session pool mode in PgBouncer — do not switch to transaction mode).

| | Default limit | Recommended range |
|---|---|---|
| Memory | 512 MB | 256 MB – 512 MB |
| CPU | 0.5 cores | 0.25 – 0.5 cores |

Do not scale the ontology service horizontally during schema migrations.
Advisory locks serialize migration runs — if two replicas race on a migration,
one will block until the other completes. Running multiple replicas is safe
during steady-state read-heavy operation but provides only modest benefit given
the low resource footprint. Raise memory if large ontology graphs are loaded
into cache.

### 2.5 Pipeline

**Bottleneck:** CPU (DAG traversal, transformation logic, expression
evaluation).

| | Default limit | Recommended range |
|---|---|---|
| Memory | 1 GB | 512 MB – 2 GB |
| CPU | 1 core | 1 – 4 cores |

Scale horizontally for higher pipeline throughput. BullMQ distributes pipeline
run jobs across replicas. Memory pressure grows with the complexity and depth of
pipeline DAGs held in memory during execution; raise the limit if you observe
OOM kills on complex multi-step pipelines.

### 2.6 Execution

**Bottleneck:** Memory (sandbox VM pool). Each V8 isolate (`isolated-vm`) and
each Docker sandbox container consumes memory proportional to the plugin being
executed. `OP_SANDBOX_POOL_SIZE` (default 5) controls how many isolates are
pre-warmed.

| | Default limit | Recommended range |
|---|---|---|
| Memory | 2 GB | 1 GB – 4 GB per replica |
| CPU | 1 core | 1 – 2 cores |

Memory formula:

```
execution_memory ≈ OP_SANDBOX_POOL_SIZE × avg_plugin_vm_size
                 + overhead_per_replica (~200 MB)
```

The sandbox VM (`op-sandbox-vm`) runs with `--max-old-space-size=512` (512 MB
V8 heap). With `OP_SANDBOX_POOL_SIZE=5`, the sandbox container alone needs
~512 MB; the execution service container needs additional headroom for request
handling and Docker API calls to the socket proxy.

Scale execution horizontally for higher concurrent plugin/connector execution
throughput. Each replica maintains its own sandbox pool — the total pool across
N replicas is `N × OP_SANDBOX_POOL_SIZE`.

### 2.7 App

**Bottleneck:** Low-medium. Serves app assets (read from `app-data` volume and
MinIO) and handles app API calls.

| | Default limit | Recommended range |
|---|---|---|
| Memory | 1 GB | 256 MB – 1 GB |
| CPU | 1 core | 0.5 – 1 core |

Scale horizontally when app-page load latency rises. The service is stateless
with respect to request routing; app asset state lives on the `app-data` volume
(or MinIO for large deployments).

### 2.8 Logging

**Bottleneck:** I/O (high-throughput write path from all other services sending
audit and event records through BullMQ). CPU and memory requirements are modest;
PostgreSQL write throughput is the constraint.

| | Default limit | Recommended range |
|---|---|---|
| Memory | 512 MB | 256 MB – 1 GB |
| CPU | 0.5 cores | 0.25 – 1 core |

If the logging queue (`bull:log:*`, `bull:audit:*`) backs up, add replicas or
raise the PostgreSQL connection pool for the logging role (see section 3). When
log volume is very high, consider shipping logs to an external sink (Loki,
Elasticsearch) via the Vector pipeline rather than storing all events in
PostgreSQL — see `docker/vector/vector.yaml`.

### 2.9 Plugin

**Bottleneck:** Memory (`isolated-vm` instances per loaded plugin). Each plugin
that is loaded into the service's VM pool consumes heap proportional to its code
and state.

| | Default limit | Recommended range |
|---|---|---|
| Memory | 512 MB | 512 MB – 2 GB per loaded plugin set |
| CPU | 0.5 cores | 0.5 – 1 core |

Memory scales with the number of distinct plugins loaded concurrently, not with
request volume. Profile the plugins installed in your tenants and size
accordingly. Scale horizontally for higher concurrent plugin call throughput.

---

## 3. Database Sizing

### 3.1 PostgreSQL

PostgreSQL runs within the Compose stack by default with a 2 GB memory limit
and 200 maximum connections. For Medium and Large tiers, move PostgreSQL to a
dedicated host or managed service (RDS, Cloud SQL, etc.) before hitting these
limits.

**Disk estimation:**

```
disk_needed = (total_records × avg_row_size_bytes × 2)
                ↑ 2× accounts for indexes on primary key, tenant, and
                  frequently-queried columns (created_at, status, etc.)
            + WAL_storage
            + backup_retention
```

Concrete example for 10 M records at 2 KB average row size:

```
data + indexes ≈ 10,000,000 × 2,048 × 2 ≈ 40 GB
WAL (PITR)     ≈ 40 GB × 0.05 daily write fraction × 2 ≈ 4 GB/day
90-day backup  ≈ 40 GB × 3 (compressed at ~33% ratio) ≈ 120 GB
```

Add 25 % headroom for autovacuum working space and unexpected growth.

**Schema-level sizing reference** (approximate, read from a healthy instance
via the pre-upgrade validation script):

| Schema | Record type | Typical row size |
|--------|-------------|-----------------|
| `auth` | users, sessions, tokens | 0.5–1 KB |
| `ingestion` | connector configs, sync runs, job records | 1–3 KB |
| `ontology` | schema nodes, edges, type definitions | 2–5 KB |
| `pipeline` | pipeline definitions, run history | 2–8 KB |
| `execution` | execution records, sandbox logs | 1–4 KB |
| `app` | app definitions, asset manifests | 1–2 KB |
| `logging` | log entries, audit records | 0.5–2 KB |
| `plugin` | plugin registrations, invocation records | 1–3 KB |

**shared_buffers tuning:**

PostgreSQL defaults `shared_buffers` to 128 MB. For a dedicated database host,
set it to 25 % of available RAM:

```
# In docker/docker-compose.yml postgres command, or in postgresql.conf
# For a host with 16 GB RAM dedicated to PostgreSQL:
shared_buffers = 4GB
effective_cache_size = 12GB
```

This setting requires a container memory limit of at least `shared_buffers` +
500 MB for other PostgreSQL processes. A 2 GB container limit (the default)
allows up to ~1.5 GB `shared_buffers`.

### 3.2 PgBouncer Connection Pool

PgBouncer sits between application services and PostgreSQL, keeping the total
number of server-side connections bounded. PostgreSQL is configured with
`max_connections=200`. The current pool allocation in `docker/pgbouncer/pgbouncer.ini`:

| Service | Pool size | Pool mode |
|---------|----------|-----------|
| gateway | 15 | transaction |
| auth | 20 | transaction |
| ingestion | 25 | transaction |
| ontology | 15 | session |
| pipeline | 25 | session |
| execution | 10 | transaction |
| app | 15 | transaction |
| logging | 30 | transaction |
| plugin | 10 | transaction |
| **Total** | **165** | |

The remaining 35 connections (200 − 165) are reserved for superuser access,
manual queries, and admin consoles.

**Scaling the pool:**

When you add service replicas, the pool size per replica stays the same, but
total connections grow:

```
total_connections = replicas × pool_size_per_service
```

If `total_connections` would exceed 180 (safe ceiling below `max_connections`),
either raise `max_connections` on PostgreSQL (update the command in
`docker/docker-compose.yml`) or reduce per-service `pool_size` in
`pgbouncer.ini`.

Alert when `cl_waiting > 0` and `maxwait > 1` in `SHOW POOLS` — this means
the pool is exhausted and clients are queuing. See OPERATIONS.md §7 for the
tuning procedure.

### 3.3 WAL Storage for Point-in-Time Recovery

```
WAL_daily  ≈ daily_write_volume_GB × 1.1   (WAL amplification factor)
WAL_retain ≈ WAL_daily × retention_days × 2 (safety factor)
```

The default `backup.sh` captures a full pg_dump, not WAL streaming. For PITR,
configure `pg_basebackup` + WAL archiving to an external store (S3, MinIO with
a lifecycle policy). WAL volume at 1 M records/day with 2 KB writes ≈ 2 GB of
WAL per day. Retain at least 2× daily write volume on the archive destination.

---

## 4. Redis Sizing

Redis is configured with `maxmemory 256mb` and `maxmemory-policy allkeys-lru`
in `docker/redis/redis.conf`. The container limit is 512 MB (headroom for the
Redis process, AOF write buffer, and fragmentation).

### 4.1 Memory Components

```
redis_memory = session_tokens
             + rate_limit_counters
             + BullMQ_queue_jobs
             + pub/sub_buffers
             + Redis_process_overhead
```

**Session tokens (`auth:*`):** 1–2 KB per active session × concurrent active
users. For 1 000 concurrent sessions ≈ 1–2 MB. Tokens expire based on JWT TTL
(configured in `OP_JWT_SECRET`-related settings).

**Rate limit counters (`ratelimit:*`):** ~100 bytes per unique client per window.
These are safe to evict (`allkeys-lru` will evict them before tokens). At 10 000
unique clients per minute ≈ 1 MB.

**BullMQ queue jobs:** approximately 1 KB per job record. Memory usage depends
on queue depth and job retention TTL:

```
queue_memory ≈ max_concurrent_jobs × 1 KB
             + completed_job_retention_count × 1 KB
```

At `OP_SANDBOX_POOL_SIZE=5` with 3 ingestion workers, peak active jobs ≈ 20–50.
Completed jobs with a 24-hour TTL at 1 000 jobs/hour ≈ 24 000 entries × 1 KB
= 24 MB.

**Pub/sub buffers:** small; typically < 1 MB unless channels carry large payloads.

### 4.2 Raising Redis Memory

When `used_memory_human` approaches `maxmemory_human`, raise both settings in
sync:

```yaml
# docker/docker-compose.yml — redis service
deploy:
  resources:
    limits:
      memory: 1g        # was 512m
```

```
# docker/redis/redis.conf
maxmemory 768mb         # ~75% of container limit — leave headroom for AOF buffer
```

Recommended ranges:

| Queue depth | Concurrent sessions | Redis memory |
|-------------|---------------------|-------------|
| < 1 000 pending jobs | < 5 000 | 256 MB |
| 1 000–10 000 pending jobs | 5 000–50 000 | 512 MB – 1 GB |
| 10 000+ pending jobs | 50 000+ | 1 GB – 2 GB |

See OPERATIONS.md §4 and §7 for the Redis tuning procedure.

---

## 5. Object Storage Sizing

MinIO stores connector artifacts, execution outputs, and app assets. It runs
on the `minio-data` Docker volume by default.

**Estimate by workload type:**

| Data type | Size driver | Typical per-record |
|-----------|------------|-------------------|
| Connector raw artifacts | Records × payload size | 1–50 KB |
| Execution outputs | Jobs × output size | 10 KB – 10 MB |
| App assets | Assets × file size | 1 KB – 100 MB |

**Lifecycle policy recommendation:**

Set a retention policy on execution artifacts (90 days is a reasonable default
for audit purposes):

```bash
mc ilm add --expiry-days 90 op/execution-artifacts
```

At Medium and Large tiers, replace the local MinIO volume with an external
S3-compatible service. MinIO on a local volume is limited by the host disk IOPS
and capacity. Set `OP_MINIO_ENDPOINT` in `.env` to point at the external store.

---

## 6. Monitoring Thresholds and Alert Rules

These thresholds apply to the default single-host Docker Compose deployment.
Adjust for your specific workload after observing baseline metrics over at least
a week of normal operation.

### 6.1 Host-Level Thresholds

| Metric | Warning | Critical | Action |
|--------|---------|----------|--------|
| CPU utilisation (host) | 80 % sustained 5 min | 95 % sustained 1 min | Scale replicas or move to larger host |
| Memory utilisation (host) | 85 % | 95 % | Add RAM or migrate heavy services off-host |
| Disk utilisation (Docker data root) | 80 % | 90 % | Prune images, rotate logs, expand volume |
| Disk utilisation (PostgreSQL volume) | 75 % | 85 % | Add storage or archive old partitions |

### 6.2 Service-Level Thresholds

Monitor via `docker stats` or Grafana dashboards provisioned in
`docker/grafana/provisioning/`.

| Metric | Warning | Critical | Action |
|--------|---------|----------|--------|
| Service memory (% of container limit) | 85 % | 95 % | Raise limit or add replicas |
| Service CPU (% of container quota) | 80 % | 95 % | Add replicas or raise CPU limit |
| Service restart count (24 h) | > 3 | > 10 | Investigate OOM or crash loop |
| Health check failure (`/healthz`) | 1 failure | 3 consecutive | Page on-call, check logs |

### 6.3 Queue Depth Thresholds

Alert on the waiting-job count across all BullMQ queues. The monitoring shell
snippet from OPERATIONS.md §9 can be adapted for an alerting system:

| Queue | Warning | Critical | Action |
|-------|---------|----------|--------|
| `bull:queue:ingestion:wait` | > 500 | > 1 000 | Add ingestion replicas or raise `OP_LARGE_SYNC_CONCURRENCY` |
| `bull:queue:pipeline:wait` | > 200 | > 500 | Add pipeline replicas |
| `bull:queue:execution:wait` | > 100 | > 200 | Add execution replicas or raise `OP_SANDBOX_POOL_SIZE` |
| `bull:audit:wait` / `bull:log:wait` | > 1 000 | > 5 000 | Add logging replicas or increase logging pool size |
| Any queue `failed` count | > 10 | > 50 | Investigate DLQ, check service logs |

A queue depth growing without bound indicates either worker starvation (not
enough replicas or low `OP_LARGE_SYNC_CONCURRENCY`) or a persistent job failure
that is preventing workers from completing jobs.

### 6.4 Database Thresholds

| Metric | Warning | Critical | Action |
|--------|---------|----------|--------|
| PgBouncer `cl_waiting` | > 0 for 30 s | > 0 for 2 min | Raise `pool_size` in `pgbouncer.ini` |
| PgBouncer `maxwait` | > 1 s | > 5 s | Pool exhausted — raise `pool_size` or `max_connections` |
| PgBouncer utilisation (`sv_active / pool_size`) | > 80 % | > 95 % | Same as above |
| PostgreSQL `n_dead_tup / n_live_tup` ratio | > 10 % per table | > 30 % | Run `VACUUM ANALYZE` manually |
| PostgreSQL disk (volume) | 75 % | 85 % | Archive old partitions, expand volume |

### 6.5 Redis Thresholds

| Metric | Warning | Critical | Action |
|--------|---------|----------|--------|
| `used_memory` vs `maxmemory` | > 80 % | > 90 % | Raise `maxmemory` and container limit |
| `mem_fragmentation_ratio` | > 1.5 | > 2.0 | Run `MEMORY PURGE` |
| Connected clients | > 150 | > 180 | Check for connection leaks in service code |

---

## 7. Tuning Checklist by Tier

### Small tier (1–10 connectors, < 100 K records/day)

Use the defaults in `docker/docker-compose.yml`. No changes required.

- [ ] Verify host has at least 4 CPU cores and 8 GB RAM
- [ ] Verify host disk has at least 100 GB free on the Docker data root
- [ ] Set `OP_INGESTION_BATCH_SIZE=1000` (default)
- [ ] Set `OP_LARGE_SYNC_CONCURRENCY=3` (default)
- [ ] Set `OP_SANDBOX_POOL_SIZE=5` (default)
- [ ] Redis `maxmemory 256mb` (default)
- [ ] PostgreSQL connection limit 200 (default)
- [ ] Enable daily backup via cron: `./docker/scripts/backup.sh ./backups`

### Medium tier (10–50 connectors, ~1 M records/day)

- [ ] Provision 8 CPU cores and 16 GB RAM
- [ ] Move PostgreSQL to a dedicated host (8 CPU, 16 GB RAM, SSD IOPS ≥ 3000)
- [ ] Raise `ingestion-service` memory limit to 2 GB
- [ ] Raise `OP_LARGE_SYNC_CONCURRENCY` to 6–8
- [ ] Raise `OP_SANDBOX_POOL_SIZE` to 10
- [ ] Raise `execution-service` memory limit to 4 GB
- [ ] Raise Redis `maxmemory` to 512 MB and container limit to 1 GB
- [ ] Raise `logging` pool size in `pgbouncer.ini` to 50
- [ ] Set `shared_buffers = 4GB` on the dedicated PostgreSQL host
- [ ] Configure MinIO lifecycle policy: 90-day expiry on execution artifacts
- [ ] Ship logs to external sink (Loki or Elasticsearch) to reduce logging schema growth
- [ ] Scale gateway to 2 replicas if API concurrency exceeds 500 req/s

### Large tier (50+ connectors, 10 M+ records/day)

- [ ] Provision 3+ application nodes with 16+ cores and 32+ GB RAM each
- [ ] Deploy PostgreSQL HA (primary + streaming replica, automated failover via Patroni or managed RDS Multi-AZ)
- [ ] Deploy Redis Sentinel or Redis Cluster for high availability
- [ ] Replace local MinIO with external S3-compatible object storage
- [ ] Set `OP_LARGE_SYNC_CONCURRENCY` to 10+ per ingestion replica
- [ ] Run 3+ ingestion replicas and 3+ execution replicas behind a load balancer
- [ ] Raise PostgreSQL `max_connections` to 500; set `pool_size` per service accordingly
- [ ] Raise Redis `maxmemory` to 2 GB; use dedicated Redis instance (separate from queue and cache namespaces if possible)
- [ ] Use an external log aggregation platform; disable PostgreSQL-backed audit log for high-volume event streams
- [ ] Configure partition pruning on `execution.runs_YYYY_MM` and `logging.log_entries` — drop partitions beyond retention window monthly
- [ ] Run `pg_basebackup` + WAL archiving to S3 for point-in-time recovery (pg_dump alone is insufficient at this scale)
- [ ] Set up external Prometheus + Alertmanager against all service `/healthz` endpoints and the queue-depth monitoring script
