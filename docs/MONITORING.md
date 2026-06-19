# OnePlatform Monitoring and Alerting Guide

This guide covers the full observability stack for OnePlatform: health checks,
structured logging, log aggregation via Vector, metrics collection with
Prometheus, distributed tracing with OpenTelemetry, Grafana dashboards, and
alerting rules. A DevOps engineer starting from a fresh `docker compose up`
should be able to follow this end-to-end.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Health Endpoints](#2-health-endpoints)
3. [Structured Logging](#3-structured-logging)
4. [Vector Log Aggregation](#4-vector-log-aggregation)
5. [Metrics Collection](#5-metrics-collection)
6. [Database Monitoring](#6-database-monitoring)
7. [Redis Monitoring](#7-redis-monitoring)
8. [Queue Monitoring](#8-queue-monitoring)
9. [Alerting Rules](#9-alerting-rules)
10. [Grafana Dashboards](#10-grafana-dashboards)
11. [Distributed Tracing](#11-distributed-tracing)

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Docker Compose Stack                             │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  caddy  :80/:443  (ONLY service with host port bindings)         │  │
│  │  TLS termination → proxies to gateway-service:3000 / frontend:80 │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐              │
│  │ gateway  │  │   auth   │  │ingestion │  │ ontology │  ...          │
│  │ :3000    │  │ :3000    │  │ :3000    │  │ :3000    │              │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘              │
│       │              │              │              │                     │
│       └──────────────┴──────────────┴──────────────┘                   │
│                              │                                          │
│                    stdout/stderr (JSON)                                 │
│                              │                                          │
│                    Docker json-file driver                              │
│                    /var/lib/docker/containers/                          │
│                              │                                          │
│                    ┌─────────▼──────────┐                              │
│                    │      Vector        │  tail (read-only bind mount) │
│                    │  0.39.0-alpine     │─────────────────────────────▶│
│                    │                    │  /var/log/oneplatform/       │
│                    └─────────┬──────────┘    <container-id>.log        │
│                              │                                          │
│                   Optional additional sinks                             │
│                   (Loki / Elasticsearch / S3)                           │
│                                                                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                             │
│  │ postgres │  │  redis   │  │  minio   │                             │
│  │  :5432   │  │  :6379   │  │  :9000   │                             │
│  └──────────┘  └──────────┘  └──────────┘                             │
│       │               │             │                                   │
│  pgbouncer        redis INFO     Prometheus                            │
│  :5433            pub/sub        /minio/v2/metrics/cluster             │
│  SHOW STATS       ACL users                                            │
│                                                                         │
│  ┌───────────────────────────────────────────┐                         │
│  │            Health Check Flow              │                         │
│  │  Docker Compose HEALTHCHECK (10s interval)│                         │
│  │  wget http://localhost:3000/healthz        │                         │
│  │  (internal — bypasses Caddy)               │                         │
│  │  → 200 OK: service is alive               │                         │
│  │  → 503: service degraded / restarting     │                         │
│  └───────────────────────────────────────────┘                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### What flows where

| Signal | Source | Transport | Destination |
|--------|--------|-----------|-------------|
| Application logs | All services (stdout/stderr) | Docker json-file → Vector file tail | `/var/log/oneplatform/` + optional sinks |
| Real-time log stream | All services | Redis pub/sub `logs:<service>` | Live consumers (tailing) |
| Audit events | Any service calling `logger.audit()` | BullMQ `audit.event` queue → logging-service | PostgreSQL audit table |
| Liveness signal | All services `/healthz` | Docker HEALTHCHECK (wget, internal) | Docker engine health state |
| External health probe | Caddy | `https://<domain>/healthz` | UptimeRobot / Pingdom / Blackbox Exporter |
| Readiness signal | All services `/readyz` | External monitoring via Caddy | Traffic routing decisions |
| TLS certificate status | Caddy | Caddy's built-in ACME client | Auto-renewal via Let's Encrypt |
| Storage metrics | MinIO | Prometheus scrape `:9000/minio/v2/metrics/cluster` | Prometheus |
| Pool metrics | PgBouncer | `psql SHOW STATS` / pgbouncer_exporter | Prometheus |
| Cache metrics | Redis | redis_exporter `:9121/metrics` | Prometheus |
| Traces | Any service with OTEL enabled | OTLP/HTTP → `OTEL_EXPORTER_OTLP_ENDPOINT` | Jaeger / Tempo |

---

## 2. Health Endpoints

All nine application services listen on **port 3000** inside their containers.
No application service has a host port binding — all are accessible only on the
`oneplatform-internal` Docker network. External traffic reaches the stack through
Caddy (the TLS reverse proxy), which binds host ports 80 and 443 and proxies
requests to `gateway-service:3000` and `frontend:80` internally.

### Endpoint summary

| Service | Container name | `/healthz` checks | `/readyz` checks | Notes |
|---------|---------------|-------------------|-----------------|-------|
| gateway | `gateway-service` | postgres (`SELECT 1`), redis (`PING`) | postgres only | Returns `status: healthy` or `status: degraded` |
| auth | `auth-service` | postgres, redis (via core `healthz`) | postgres, redis (via core `readyz`) | Uses shared `@oneplatform/core` handlers |
| ingestion | `ingestion-service` | process alive | postgres, redis, minio, masterKey present | MinIO: putObject sentinel probe; masterKey must be ≥32 bytes |
| ontology | `ontology-service` | process alive | postgres, redis | Uses shared core handlers |
| pipeline | `pipeline-service` | process alive | postgres, redis, pipeline:run queue depth, pipeline:cron queue depth | Queue counts are informational — do not cause 503 |
| execution | `execution-service` | process alive | postgres, sandbox Unix socket ping | 503 if sandbox socket unreachable |
| app | `app-service` | process alive | postgres, redis, minio, authService (degraded-safe) | `authService` fail → degraded, not 503; service serves cached sessions |
| logging | `logging-service` | process alive | postgres, redis | Uses shared core handlers |
| plugin | `plugin-service` | process alive | postgres, minio (bundle ping), redis | |

### `/healthz` response shape

```json
{
  "status": "ok",
  "service": "gateway",
  "uptime": 3842
}
```

The gateway additionally sets `status: "healthy"` or `"degraded"` and includes
a `checks` map:

```json
{
  "status": "healthy",
  "service": "gateway",
  "uptime": 3842,
  "checks": {
    "postgres": "ok",
    "redis": "ok"
  }
}
```

### `/readyz` response shape

```json
{
  "status": "ready",
  "service": "pipeline",
  "version": "1.2.0",
  "checks": {
    "postgres": "ok",
    "redis": "ok"
  },
  "queues": {
    "pipeline:run":  { "active": 2, "waiting": 0, "failed": 0, "dlq": 0 },
    "pipeline:cron": { "active": 1, "waiting": 0, "failed": 0 }
  },
  "uptime": 3842
}
```

### Polling health from the host

```bash
# Liveness — through Caddy (the only service with host port bindings).
# Use -k (--insecure) in development with Caddy's self-signed certificate.
curl -sk https://localhost/healthz | jq .

# Readiness — through Caddy
curl -sk https://localhost/readyz | jq .

# All services via Docker exec (bypasses Caddy; always plain HTTP on port 3000)
for svc in gateway-service auth-service ingestion-service ontology-service \
           pipeline-service execution-service app-service logging-service plugin-service; do
  echo "=== $svc ==="
  docker exec "$svc" wget -qO- http://localhost:3000/healthz
  echo
done
```

### Docker Compose health check configuration

Every application service uses this configuration (from `docker-compose.yml`):

```yaml
healthcheck:
  test: ["CMD-SHELL", "wget -qO- http://localhost:3000/healthz || exit 1"]
  interval: 10s
  timeout: 5s
  retries: 5
  start_period: 20s
```

View current health state:

```bash
docker compose ps
# or for a specific service
docker inspect --format='{{.State.Health.Status}}' gateway-service
```

---

## 3. Structured Logging

### Log format

Every service uses `createLogger()` from `@oneplatform/core`. All log lines
are JSON, emitted directly to stdout (debug/info) or stderr (warn/error) so
Docker's json-file driver captures them unmodified.

**LogEvent schema:**

```json
{
  "timestamp": "2026-06-17T14:23:01.042Z",
  "traceId":   "0192f3a1-4b2e-7d8c-a1b2-c3d4e5f60718",
  "service":   "gateway-service",
  "level":     "info",
  "message":   "Webhook delivery succeeded",
  "metadata":  {
    "webhookId": "wh_01j2...",
    "tenantId":  "tenant_abc",
    "statusCode": 200,
    "durationMs": 134
  }
}
```

**AuditEvent schema** (written to BullMQ, persisted by logging-service):

```json
{
  "timestamp":    "2026-06-17T14:23:01.042Z",
  "traceId":      "0192f3a1-4b2e-7d8c-a1b2-c3d4e5f60718",
  "actorId":      "user_01j2...",
  "actorType":    "user",
  "tenantId":     "tenant_abc",
  "action":       "connector.create",
  "resourceType": "connector",
  "resourceId":   "conn_01j2...",
  "result":       "success",
  "metadata":     { "connectorType": "postgres" }
}
```

### Log levels

| Level | Numeric | Written to | When to use |
|-------|---------|-----------|-------------|
| `debug` | 0 | stdout | Detailed diagnostic info; disabled in production by default |
| `info` | 1 | stdout | Normal operation milestones (request received, job started) |
| `warn` | 2 | stderr | Recoverable problems (retry #2, degraded dependency) |
| `error` | 3 | stderr | Unrecoverable errors, failed requests, unexpected state |

Warn and error go to **stderr** deliberately — container runtimes and Docker
log drivers treat stderr as a higher-severity stream, making it easy to filter
for problems with `docker compose logs gateway-service 2>&1 1>/dev/null`.

### Configuring log level per service

Set `OP_LOG_LEVEL` in the service's environment before startup. The value is
read once at module load and applies for the lifetime of the process.

```bash
# In docker-compose.override.yml (do not edit docker-compose.yml directly)
services:
  gateway-service:
    environment:
      OP_LOG_LEVEL: debug

  ingestion-service:
    environment:
      OP_LOG_LEVEL: warn   # only warn/error in high-volume production
```

Valid values: `debug`, `info` (default), `warn`, `error`.

### Real-time log tailing via Redis pub/sub

The logger also publishes every log event to `logs:<service>` on Redis. This
secondary channel is for live consumers (e.g. a monitoring dashboard) and is
fire-and-forget — Redis pub/sub failures are swallowed so they never affect
the stdout transport.

```bash
# Subscribe to all gateway-service logs in real time
PASS=$(docker compose -f docker/docker-compose.yml exec -T redis \
  cat /data/init/redis_password_admin.txt | tr -d '[:space:]')
redis-cli -a "$PASS" --user op_admin SUBSCRIBE logs:gateway-service
```

---

## 4. Vector Log Aggregation

### How Vector collects logs

Vector runs as a sidecar container (`oneplatform-vector`) and tails Docker
container JSON log files directly from the host filesystem. This avoids
mounting the Docker socket — the design choice explained in
`docker/vector/vector.yaml`:

```
/var/lib/docker/containers/<id>/<id>-json.log  ← Docker json-file driver
        │
        │  (read-only bind mount: /var/lib/docker/containers)
        ▼
  Vector (UID 65534, GID 0) — file source, remap transform
        │
        ▼
  /var/log/oneplatform/<container-id>.log  ← log-data named volume
```

The `parse_docker_json` transform:
1. Unwraps the Docker json-file envelope (`{"log":"...", "stream":"...", "time":"..."}`).
2. Attempts to parse the inner log line as JSON (our services emit structured JSON).
3. Merges top-level fields (`level`, `service`, `traceId`, `tenantId`, etc.) for
   easy filtering in downstream sinks.
4. Extracts the container ID from the file path for per-file routing.

**Important:** Log files are named by container ID, not by service name, because
Vector has no Docker API access to resolve names. Use the container ID → service
name mapping from `docker inspect` when correlating files.

```bash
# Map container IDs to service names
docker ps --format '{{.ID}}\t{{.Names}}' | sort
```

### Viewing aggregated logs

```bash
# All logs from the log-data volume (requires a temporary container)
docker run --rm \
  -v oneplatform_log-data:/var/log/oneplatform:ro \
  alpine sh -c 'ls /var/log/oneplatform/'

# Stream logs for a specific container
CONTAINER_ID=$(docker inspect --format='{{.Id}}' gateway-service | cut -c1-12)
docker run --rm \
  -v oneplatform_log-data:/var/log/oneplatform:ro \
  alpine tail -f /var/log/oneplatform/${CONTAINER_ID}.log
```

### Adding a Loki sink

Append the following to `docker/vector/vector.yaml`:

```yaml
sinks:
  loki:
    type: loki
    inputs:
      - parse_docker_json
    endpoint: http://loki:3100
    encoding:
      codec: json
    # Use the service field merged from the inner JSON log for routing.
    # Falls back to the container_id if the inner log is not structured JSON.
    labels:
      service: "{{ service }}"
      level:   "{{ level }}"
      env:     "production"
    # Loki requires logs to arrive in chronological order per stream.
    # out_of_order_action: rewrite rewrites the timestamp rather than dropping.
    out_of_order_action: rewrite
```

Restart Vector after editing:

```bash
docker compose restart vector
```

### Adding an Elasticsearch sink

```yaml
sinks:
  elasticsearch:
    type: elasticsearch
    inputs:
      - parse_docker_json
    endpoints:
      - http://elasticsearch:9200
    index: "oneplatform-logs-%Y.%m.%d"
    encoding:
      codec: json
    auth:
      strategy: basic
      user: elastic
      password: "${ELASTIC_PASSWORD}"
    # Bulk ingest for throughput; flush every 1s or 500 events
    batch:
      max_events: 500
      timeout_secs: 1
```

### Filtering by service or level

Add a filter transform before the sink to reduce ingested volume:

```yaml
transforms:
  # Only forward warn and error to Elasticsearch (reduces cost)
  filter_errors_only:
    type: filter
    inputs:
      - parse_docker_json
    condition:
      type: vrl
      source: |
        .level == "warn" || .level == "error"

sinks:
  elasticsearch:
    inputs:
      - filter_errors_only
    # ... rest of sink config
```

### Log rotation

Docker's json-file driver handles rotation automatically via the limits set in
`docker-compose.yml`:

```yaml
logging:
  driver: "json-file"
  options:
    max-size: "50m"   # rotate when file reaches 50 MB
    max-file: "5"     # keep at most 5 rotated files per container
```

Maximum disk usage per service: **250 MB** (50 MB × 5 files). Across all 9
services + infrastructure containers that is roughly **3 GB** of raw Docker
logs. The `log-data` volume for Vector's parsed output does not have built-in
rotation — add a Vector `file` sink with `compression: gzip` and a cron job
to remove files older than N days, or route to object storage instead.

---

## 5. Metrics Collection

### Adding Prometheus to the stack

Create `docker/prometheus/prometheus.yml`:

```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

scrape_configs:

  # Caddy exposes a Prometheus metrics endpoint at /metrics (enabled via the
  # metrics global option in the Caddyfile). This is internal-only.
  - job_name: caddy
    static_configs:
      - targets: ['caddy:2019']
    metrics_path: /metrics

  # MinIO built-in Prometheus endpoint
  - job_name: minio
    static_configs:
      - targets: ['minio:9000']
    metrics_path: /minio/v2/metrics/cluster
    scheme: http

  # redis_exporter — scrapes Redis INFO and exposes Prometheus metrics
  - job_name: redis
    static_configs:
      - targets: ['redis-exporter:9121']

  # pgbouncer_exporter — scrapes PgBouncer SHOW STATS/POOLS/CLIENTS
  - job_name: pgbouncer
    static_configs:
      - targets: ['pgbouncer-exporter:9127']
```

Add the exporters to `docker-compose.override.yml` (do not modify
`docker-compose.yml` directly):

```yaml
services:
  prometheus:
    image: prom/prometheus:v2.52.0
    container_name: prometheus
    volumes:
      - ./prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - prometheus-data:/prometheus
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--storage.tsdb.path=/prometheus'
      - '--storage.tsdb.retention.time=30d'
      - '--web.enable-lifecycle'
    ports:
      - "127.0.0.1:9090:9090"
    networks:
      - oneplatform-internal
    restart: unless-stopped

  redis-exporter:
    image: oliver006/redis_exporter:v1.61.0-alpine
    container_name: redis-exporter
    environment:
      # op_admin has full access — needed for INFO, MONITOR, and key-count commands
      REDIS_ADDR: redis://redis:6379
      REDIS_USER: op_admin
      REDIS_PASSWORD_FILE: /data/init/redis_password_admin.txt
    volumes:
      - init-data:/data/init:ro
    networks:
      - oneplatform-internal
    depends_on:
      redis:
        condition: service_healthy
    restart: unless-stopped

  pgbouncer-exporter:
    image: prometheuscommunity/pgbouncer-exporter:v0.7.0
    container_name: pgbouncer-exporter
    environment:
      DATA_SOURCE_NAME: "postgresql://pgbouncer_stats:${PGBOUNCER_STATS_PASSWORD}@pgbouncer:5433/pgbouncer?sslmode=disable"
    networks:
      - oneplatform-internal
    depends_on:
      pgbouncer:
        condition: service_healthy
    restart: unless-stopped

  grafana:
    image: grafana/grafana:10.4.3
    container_name: grafana
    environment:
      GF_SECURITY_ADMIN_USER: admin
      GF_SECURITY_ADMIN_PASSWORD: "${GRAFANA_ADMIN_PASSWORD:-changeme}"
      GF_USERS_ALLOW_SIGN_UP: "false"
    volumes:
      - grafana-data:/var/lib/grafana
    ports:
      - "127.0.0.1:3001:3000"
    networks:
      - oneplatform-internal
    depends_on:
      - prometheus
    restart: unless-stopped

volumes:
  prometheus-data:
  grafana-data:
```

### MinIO metrics

MinIO exposes a Prometheus-compatible endpoint at
`http://minio:9000/minio/v2/metrics/cluster` with no authentication required
from within the internal network. Key metrics:

```bash
# Verify the endpoint is reachable
docker compose exec gateway-service wget -qO- http://minio:9000/minio/v2/metrics/cluster | grep minio_cluster

# Key metrics to watch
# minio_cluster_capacity_usable_total_bytes  — usable storage capacity
# minio_cluster_capacity_usable_free_bytes   — free usable storage
# minio_s3_requests_total                    — request rate by method and status
# minio_s3_requests_errors_total             — error rate
# minio_node_disk_used_bytes                 — per-node disk usage
```

---

## 6. Database Monitoring

PgBouncer listens on port **5433** inside the `oneplatform-internal` network.
It uses two roles for monitoring: `pgbouncer_admin` (full admin access) and
`pgbouncer_stats` (read-only stats access).

### Pool configuration reference

From `docker/pgbouncer/pgbouncer.ini`:

| Database alias | PostgreSQL user | Pool size | Pool mode | Notes |
|----------------|----------------|-----------|-----------|-------|
| `oneplatform_gateway` | `gateway_service_role` | 15 | transaction | |
| `oneplatform_auth` | `auth_service_role` | 20 | transaction | |
| `oneplatform_ingestion` | `ingestion_service_role` | 25 | transaction | |
| `oneplatform_app` | `app_service_role` | 15 | transaction | |
| `oneplatform_logging` | `logging_service_role` | 30 | transaction | Highest — audit log throughput |
| `oneplatform_plugin` | `plugin_service_role` | 10 | transaction | |
| `oneplatform_execution` | `execution_service_role` | 10 | transaction | |
| `oneplatform_ontology` | `ontology_service_role` | 15 | **session** | Advisory locks + LISTEN |
| `oneplatform_pipeline` | `pipeline_service_role` | 25 | **session** | Advisory locks + LISTEN |

Global limits: `max_client_conn = 200`, `default_pool_size = 20`.

### Key SHOW commands

Connect to the PgBouncer admin console from the host:

```bash
PGBOUNCER_PASS=$(docker compose -f docker/docker-compose.yml exec -T postgres \
  cat /data/init/db_password_pgbouncer_admin.txt | tr -d '[:space:]')
psql "postgresql://pgbouncer_admin:${PGBOUNCER_PASS}@localhost:5433/pgbouncer"
```

Or via `docker exec`:

```bash
docker exec -it pgbouncer \
  psql "postgresql://pgbouncer_admin@localhost:5433/pgbouncer" \
  -c "SHOW STATS;"
```

**SHOW STATS** — per-database throughput:

```sql
SHOW STATS;
-- Key columns:
-- database       : alias name (e.g. oneplatform_auth)
-- total_xact_count : cumulative transactions
-- total_query_count: cumulative queries
-- total_xact_time  : cumulative transaction time (µs)
-- total_query_time : cumulative query time (µs)
-- total_wait_time  : cumulative client wait time (µs)
-- avg_xact_count   : transactions per second (rolling 60s)
-- avg_query_time   : average query duration (µs) — alert if > 100ms
-- avg_wait_time    : average client wait time (µs) — alert if > 50ms
```

**SHOW POOLS** — live pool state:

```sql
SHOW POOLS;
-- Key columns:
-- database    : alias name
-- user        : PostgreSQL role
-- cl_active   : clients with an assigned server connection
-- cl_waiting  : clients waiting for a connection — alert if > 0 for sustained period
-- sv_active   : server connections in use
-- sv_idle     : server connections idle — alert if this is 0 and cl_waiting > 0
-- sv_login    : connections currently authenticating
-- maxwait     : age of oldest waiting client (seconds) — alert if > 5
-- pool_mode   : transaction | session
```

**SHOW CLIENTS** — individual client connections:

```sql
SHOW CLIENTS;
-- Lists every active client connection with state, database, user, and wait time.
-- Use to identify which service is saturating a pool.
```

**SHOW SERVERS** — server (PostgreSQL) connections:

```sql
SHOW SERVERS;
-- Lists every server connection with state (active/idle/login) and transaction age.
```

### Key metrics to watch

| Metric | Source | Alert threshold |
|--------|--------|----------------|
| `cl_waiting` per pool | SHOW POOLS | > 0 for > 30s |
| `maxwait` per pool | SHOW POOLS | > 5 seconds |
| `avg_wait_time` | SHOW STATS | > 50,000 µs (50 ms) |
| `avg_query_time` | SHOW STATS | > 100,000 µs (100 ms) |
| Total `sv_active` across all pools | SHOW POOLS sum | > 160 (80% of max_client_conn=200) |

---

## 7. Redis Monitoring

Redis 7 is configured with:
- AOF persistence (`appendfsync everysec`)
- `maxmemory 256mb` with `allkeys-lru` eviction (matches Docker resource limit)
- ACL-based per-service users (no default user access)

### Connecting with the admin user

```bash
REDIS_PASS=$(docker compose -f docker/docker-compose.yml exec -T redis \
  cat /data/init/redis_password_admin.txt | tr -d '[:space:]')
redis-cli -h localhost -p 6379 --user op_admin -a "$REDIS_PASS"
```

Or via `docker exec`:

```bash
docker exec redis sh -c \
  'PASS=$(cat /data/init/redis_password_admin.txt | tr -d "[:space:]") && \
   redis-cli --user op_admin -a "$PASS" INFO'
```

### Key INFO sections

**Memory:**

```
INFO memory
# used_memory_human         — current memory usage (alert if > 200 MB of 256 MB limit)
# used_memory_peak_human    — peak memory since start
# mem_fragmentation_ratio   — alert if > 1.5 (fragmentation wasting RAM)
# maxmemory_human           — configured limit (256.00M)
# maxmemory_policy          — allkeys-lru (expected)
```

**Stats (eviction and keyspace hits):**

```
INFO stats
# evicted_keys              — cumulative evictions; alert if growing rapidly
#                             (auth tokens being evicted means login failures)
# keyspace_hits             — cache hit count
# keyspace_misses           — cache miss count
# total_commands_processed  — commands per second baseline
# rejected_connections      — alert if > 0 (maxclients reached)
```

**Clients:**

```
INFO clients
# connected_clients         — total connections; alert if approaching maxclients
# blocked_clients           — clients blocked on BLPOP/BRPOP/BLMOVE
```

**Persistence:**

```
INFO persistence
# aof_enabled               — should be 1
# aof_last_rewrite_status   — should be "ok"
# aof_last_bgrewrite_status — should be "ok"
```

**Keyspace:**

```
INFO keyspace
# db0: keys=<N>,expires=<N>,avg_ttl=<N>
```

### Per-ACL-user key namespace reference

From `docker/redis/users.acl.template`:

| Redis user | Key prefix(es) | Used by |
|-----------|---------------|---------|
| `op_gateway` | `ratelimit:*`, `gateway:*`, `webhook:*` | Gateway rate limiting, webhook state |
| `op_auth` | `auth:*`, `revocation:*`, `reset:*`, `bull:auth:*` | Session tokens, token revocation, password resets |
| `op_ingestion` | `queue:ingestion:*`, `ingestion:sync:*`, `bull:ingestion:*`, `bull:queue:ingestion:*` | Ingestion BullMQ queues |
| `op_ontology` | `ontology:*` | Ontology cache, pub/sub invalidation |
| `op_pipeline` | `queue:pipeline:*`, `queue:execution:*`, `bull:queue:pipeline:*`, `bull:queue:execution:*` | Pipeline + execution BullMQ queues |
| `op_execution` | `execution:*` | Execution service state |
| `op_app` | `guest-session:*`, `rate:guest-session:*`, `app:*`, `bff:*`, `bull:app:*`, `bull:queue:app:*` | App sessions, BFF cache |
| `op_logging` | `log:*`, `audit:*`, `bull:audit:*`, `bull:log:*` | Log and audit queues |
| `op_plugin` | `plugin:*`, `bull:plugin:*` | Plugin state and queues |

### Monitoring eviction risk for auth tokens

Auth tokens (`auth:*`) must not be evicted — eviction means a valid session
becomes invalid without the user logging out. The `allkeys-lru` policy evicts
any key, including auth tokens, when the 256 MB limit is reached.

```bash
# Count auth keys
redis-cli --user op_admin -a "$REDIS_PASS" SCAN 0 MATCH "auth:*" COUNT 10000 | grep -c ":"

# Check memory used by auth keys (Redis 4.0+)
redis-cli --user op_admin -a "$REDIS_PASS" \
  DEBUG OBJECT auth:example_token_key 2>/dev/null | grep serializedlength
```

If auth key count grows toward the memory limit, either increase `maxmemory` in
`docker/redis/redis.conf` and the Docker resource limit in `docker-compose.yml`,
or implement shorter session TTLs.

---

## 8. Queue Monitoring

### BullMQ queue inventory

BullMQ queues are stored in Redis. Each queue's metadata lives under
`bull:<queue-name>:*` keys, scoped to the ACL user that owns it.

| Queue name | Service | ACL user | Job type | DLQ |
|-----------|---------|----------|----------|-----|
| `bull:auth:*` | auth-service | op_auth | auth events | `bull:auth:*:dlq` |
| `bull:ingestion:*` | ingestion-service | op_ingestion | sync jobs | `bull:ingestion:*:dlq` |
| `bull:queue:ingestion:*` | ingestion-service | op_ingestion | batch processing | - |
| `bull:queue:pipeline:*` | pipeline-service | op_pipeline | pipeline runs | - |
| `bull:queue:execution:*` | pipeline-service | op_pipeline | execution jobs | - |
| `bull:app:*` | app-service | op_app | app build jobs | `bull:app:*:dlq` |
| `bull:queue:app:*` | app-service | op_app | app queue | - |
| `bull:audit:*` | logging-service | op_logging | audit events | - |
| `bull:log:*` | logging-service | op_logging | log processing | - |
| `bull:plugin:*` | plugin-service | op_plugin | plugin lifecycle | `bull:plugin:*:dlq` |

The platform standard retry policy (from `packages/core/src/queue.ts`):
- **5 attempts** with **exponential backoff starting at 1 second**
- Total wait before failure: ~31 seconds
- Completed jobs: removed immediately (`removeOnComplete: { count: 0 }`)
- Failed jobs: retained up to 100 (`removeOnFail: { count: 100 }`)

### Queue depth via pipeline /readyz

The pipeline service `/readyz` exposes live queue counts:

```bash
docker compose exec gateway-service wget -qO- http://pipeline-service:3000/readyz | jq .queues
```

Output:

```json
{
  "pipeline:run":  { "active": 2, "waiting": 5, "failed": 0, "dlq": 0 },
  "pipeline:cron": { "active": 1, "waiting": 0, "failed": 0 }
}
```

### Querying queue metrics directly from Redis

```bash
REDIS_PASS=$(docker compose -f docker/docker-compose.yml exec -T redis \
  cat /data/init/redis_password_admin.txt | tr -d '[:space:]')

# Active jobs in any BullMQ queue (admin access required)
redis-cli --user op_admin -a "$REDIS_PASS" \
  LLEN "bull:queue:ingestion:active"

# Waiting jobs
redis-cli --user op_admin -a "$REDIS_PASS" \
  LLEN "bull:queue:ingestion:wait"

# Failed job count
redis-cli --user op_admin -a "$REDIS_PASS" \
  ZCOUNT "bull:queue:ingestion:failed" -inf +inf

# Delayed job count
redis-cli --user op_admin -a "$REDIS_PASS" \
  ZCOUNT "bull:queue:ingestion:delayed" -inf +inf
```

### BullMQ Board (web dashboard)

[BullMQ Board](https://github.com/felixmosh/bull-board) provides a UI for
browsing jobs, retrying failures, and examining DLQ contents.

Add to `docker-compose.override.yml`:

```yaml
services:
  bull-board:
    image: deadly0/bull-board:latest
    container_name: bull-board
    environment:
      REDIS_HOST: redis
      REDIS_PORT: "6379"
      REDIS_PASSWORD: "${OP_REDIS_PASSWORD_ADMIN}"
      REDIS_USER: op_admin
      # List the queue names to display
      QUEUE_PREFIX: "bull"
    ports:
      - "127.0.0.1:3002:3000"
    networks:
      - oneplatform-internal
    depends_on:
      redis:
        condition: service_healthy
    restart: unless-stopped
```

Access at `http://localhost:3002` (internal only; never expose publicly).

### Monitoring stalled jobs

BullMQ marks a job as stalled if the worker holds the lock but does not extend
it within the lock duration. Stalled jobs are re-queued automatically (up to
the attempts limit). Monitor with:

```bash
redis-cli --user op_admin -a "$REDIS_PASS" \
  SMEMBERS "bull:queue:ingestion:stalled"
```

An increasing stalled count indicates workers are crashing mid-job or the
lock duration is too short relative to job execution time.

### DLQ depth tracking

```bash
# Count items in the ingestion DLQ
redis-cli --user op_admin -a "$REDIS_PASS" \
  ZCOUNT "bull:queue:ingestion:dlq:failed" -inf +inf
```

Alert when any DLQ depth exceeds 0 — jobs in the DLQ are unrecoverable without
manual intervention.

---

## 9. Alerting Rules

### Prometheus alertmanager rules

Create `docker/prometheus/alerts.yml`:

```yaml
groups:
  - name: oneplatform.service_health
    interval: 30s
    rules:

      - alert: ServiceHealthCheckFailing
        # A Docker HEALTHCHECK failure means Docker has been unable to get a 200
        # from /healthz for retries × interval (50s). The container is in
        # "unhealthy" state and will be replaced by restart: unless-stopped.
        expr: |
          time() - container_last_seen{name=~".*-service"} > 120
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Service {{ $labels.name }} is not responding"
          description: "Container {{ $labels.name }} has not been seen for > 2 minutes."

      - alert: ContainerRestarting
        expr: |
          increase(container_start_time_seconds{name=~".*-service"}[5m]) > 2
        for: 0m
        labels:
          severity: warning
        annotations:
          summary: "Container {{ $labels.name }} is restarting"
          description: "Container {{ $labels.name }} has restarted more than twice in 5 minutes."

  - name: oneplatform.redis
    rules:

      - alert: RedisMemoryHigh
        # At 90% of the 256 MB limit, auth token eviction becomes likely.
        expr: |
          redis_memory_used_bytes / redis_config_maxmemory * 100 > 90
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Redis memory usage is above 90%"
          description: "Redis is using {{ $value | humanize }}% of its 256 MB limit. Auth token eviction may occur."

      - alert: RedisMemoryCritical
        expr: |
          redis_memory_used_bytes / redis_config_maxmemory * 100 > 98
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Redis memory usage is critical (>98%)"
          description: "Redis will begin evicting keys immediately. Increase maxmemory or reduce key TTLs."

      - alert: RedisEvictingKeys
        expr: |
          increase(redis_evicted_keys_total[5m]) > 0
        for: 0m
        labels:
          severity: warning
        annotations:
          summary: "Redis is evicting keys"
          description: "{{ $value }} keys evicted in the last 5 minutes. Check if auth:* keys are affected."

      - alert: RedisDown
        expr: |
          redis_up == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Redis is unreachable"
          description: "redis_exporter cannot reach Redis. All services will begin failing."

  - name: oneplatform.pgbouncer
    rules:

      - alert: PgBouncerPoolExhausted
        # cl_waiting > 0 means clients are queueing — latency will spike.
        expr: |
          pgbouncer_pools_client_waiting_connections > 0
        for: 30s
        labels:
          severity: warning
        annotations:
          summary: "PgBouncer pool exhausted for {{ $labels.database }}"
          description: "{{ $value }} clients are waiting for a connection in pool {{ $labels.database }}."

      - alert: PgBouncerHighWaitTime
        # maxwait > 5s means a client has been waiting 5 seconds for a connection.
        expr: |
          pgbouncer_pools_client_maxwait_seconds > 5
        for: 10s
        labels:
          severity: critical
        annotations:
          summary: "PgBouncer client waiting > 5s in pool {{ $labels.database }}"
          description: "Max client wait is {{ $value }}s. Increase pool_size for {{ $labels.database }} or scale horizontally."

      - alert: PgBouncerDown
        expr: |
          pgbouncer_up == 0
        for: 30s
        labels:
          severity: critical
        annotations:
          summary: "PgBouncer is unreachable"
          description: "All database connections will fail. Services cannot process requests."

  - name: oneplatform.queues
    rules:

      - alert: QueueDepthGrowing
        # Waiting jobs growing for 10 minutes indicates workers can't keep up
        # or workers have crashed.
        expr: |
          increase(redis_key_size{key=~"bull:.*:wait"}[10m]) > 100
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "BullMQ queue {{ $labels.key }} depth growing"
          description: "Queue {{ $labels.key }} has grown by {{ $value }} jobs in 10 minutes."

      - alert: DLQNonEmpty
        # Any job reaching the DLQ means automatic retries are exhausted.
        # Manual intervention is required.
        expr: |
          redis_key_size{key=~"bull:.*:dlq:failed"} > 0
        for: 0m
        labels:
          severity: warning
        annotations:
          summary: "Dead-letter queue {{ $labels.key }} has {{ $value }} jobs"
          description: "Jobs in DLQ require manual inspection. Check failed job details via Bull Board."

  - name: oneplatform.minio
    rules:

      - alert: MinIODiskSpaceLow
        expr: |
          minio_cluster_capacity_usable_free_bytes / minio_cluster_capacity_usable_total_bytes * 100 < 20
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "MinIO free disk space below 20%"
          description: "MinIO has {{ $value | humanize }}% free space. Ingestion uploads may fail."

      - alert: MinIODiskSpaceCritical
        expr: |
          minio_cluster_capacity_usable_free_bytes / minio_cluster_capacity_usable_total_bytes * 100 < 5
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "MinIO free disk space below 5%"
          description: "MinIO disk is nearly full. Uploads will fail immediately."

      - alert: MinIOErrorRateHigh
        expr: |
          rate(minio_s3_requests_errors_total[5m]) / rate(minio_s3_requests_total[5m]) > 0.05
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "MinIO error rate exceeds 5%"
          description: "MinIO is returning errors on {{ $value | humanizePercentage }} of S3 requests."
```

Add the rules file to `prometheus.yml`:

```yaml
rule_files:
  - /etc/prometheus/alerts.yml
```

### Alertmanager configuration

Create `docker/prometheus/alertmanager.yml`:

```yaml
global:
  resolve_timeout: 5m

route:
  group_by: ['alertname', 'severity']
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 12h
  receiver: default

  routes:
    - match:
        severity: critical
      receiver: pagerduty
      continue: true

receivers:
  - name: default
    slack_configs:
      - api_url: "${SLACK_WEBHOOK_URL}"
        channel: '#oneplatform-alerts'
        text: |
          {{ range .Alerts }}
          *{{ .Annotations.summary }}*
          {{ .Annotations.description }}
          Severity: {{ .Labels.severity }}
          {{ end }}

  - name: pagerduty
    pagerduty_configs:
      - routing_key: "${PAGERDUTY_ROUTING_KEY}"
        description: "{{ .CommonAnnotations.summary }}"
```

---

## 10. Grafana Dashboards

### Service health overview dashboard

This dashboard shows all nine services' uptime and health check state in a
single view. Save as `docker/grafana/dashboards/service-health.json`:

```json
{
  "title": "OnePlatform — Service Health",
  "uid":   "op-service-health",
  "time":  { "from": "now-1h", "to": "now" },
  "refresh": "30s",
  "panels": [
    {
      "id": 1,
      "type": "stat",
      "title": "Services Healthy",
      "gridPos": { "x": 0, "y": 0, "w": 4, "h": 4 },
      "options": {
        "reduceOptions": { "calcs": ["lastNotNull"] },
        "colorMode": "background",
        "thresholds": {
          "steps": [
            { "value": null, "color": "red" },
            { "value": 9,    "color": "green" }
          ]
        }
      },
      "targets": [
        {
          "expr": "count(container_last_seen{name=~\".*-service\"} > (time() - 120))",
          "legendFormat": "Healthy services"
        }
      ]
    },
    {
      "id": 2,
      "type": "table",
      "title": "Container Status",
      "gridPos": { "x": 0, "y": 4, "w": 24, "h": 8 },
      "transformations": [
        { "id": "organize", "options": { "renameByName": { "name": "Service", "value": "Last Seen (s ago)" } } }
      ],
      "targets": [
        {
          "expr": "time() - container_last_seen{name=~\".*-service\"}",
          "legendFormat": "{{ name }}",
          "instant": true
        }
      ]
    },
    {
      "id": 3,
      "type": "timeseries",
      "title": "Container Restarts (5m window)",
      "gridPos": { "x": 0, "y": 12, "w": 24, "h": 8 },
      "targets": [
        {
          "expr": "increase(container_start_time_seconds{name=~\".*-service\"}[5m])",
          "legendFormat": "{{ name }}"
        }
      ]
    },
    {
      "id": 4,
      "type": "timeseries",
      "title": "Redis Memory Usage",
      "gridPos": { "x": 0, "y": 20, "w": 12, "h": 8 },
      "fieldConfig": {
        "defaults": {
          "unit": "bytes",
          "thresholds": {
            "steps": [
              { "value": null,       "color": "green" },
              { "value": 230686720,  "color": "yellow" },
              { "value": 256000000,  "color": "red" }
            ]
          }
        }
      },
      "targets": [
        {
          "expr": "redis_memory_used_bytes",
          "legendFormat": "Used"
        },
        {
          "expr": "redis_config_maxmemory",
          "legendFormat": "Limit (256 MB)"
        }
      ]
    },
    {
      "id": 5,
      "type": "timeseries",
      "title": "PgBouncer — Clients Waiting",
      "gridPos": { "x": 12, "y": 20, "w": 12, "h": 8 },
      "targets": [
        {
          "expr": "pgbouncer_pools_client_waiting_connections",
          "legendFormat": "{{ database }}"
        }
      ]
    },
    {
      "id": 6,
      "type": "timeseries",
      "title": "MinIO — S3 Request Rate",
      "gridPos": { "x": 0, "y": 28, "w": 12, "h": 8 },
      "targets": [
        {
          "expr": "rate(minio_s3_requests_total[5m])",
          "legendFormat": "{{ api }}"
        }
      ]
    },
    {
      "id": 7,
      "type": "timeseries",
      "title": "MinIO — Disk Usage",
      "gridPos": { "x": 12, "y": 28, "w": 12, "h": 8 },
      "fieldConfig": { "defaults": { "unit": "bytes" } },
      "targets": [
        {
          "expr": "minio_cluster_capacity_usable_total_bytes - minio_cluster_capacity_usable_free_bytes",
          "legendFormat": "Used"
        },
        {
          "expr": "minio_cluster_capacity_usable_total_bytes",
          "legendFormat": "Total"
        }
      ]
    },
    {
      "id": 8,
      "type": "timeseries",
      "title": "BullMQ — Queue Depths",
      "description": "Requires redis_exporter with key-size tracking enabled",
      "gridPos": { "x": 0, "y": 36, "w": 24, "h": 8 },
      "targets": [
        {
          "expr": "redis_key_size{key=~\"bull:.*:wait\"}",
          "legendFormat": "waiting — {{ key }}"
        },
        {
          "expr": "redis_key_size{key=~\"bull:.*:active\"}",
          "legendFormat": "active — {{ key }}"
        },
        {
          "expr": "redis_key_size{key=~\"bull:.*:failed\"}",
          "legendFormat": "failed — {{ key }}"
        }
      ]
    }
  ],
  "schemaVersion": 38
}
```

### Provisioning Grafana dashboards automatically

Create `docker/grafana/provisioning/dashboards/default.yml`:

```yaml
apiVersion: 1
providers:
  - name: OnePlatform
    type: file
    disableDeletion: false
    updateIntervalSeconds: 30
    options:
      path: /var/lib/grafana/dashboards
```

Mount in `docker-compose.override.yml`:

```yaml
services:
  grafana:
    volumes:
      - grafana-data:/var/lib/grafana
      - ./grafana/provisioning:/etc/grafana/provisioning:ro
      - ./grafana/dashboards:/var/lib/grafana/dashboards:ro
```

### Adding a Prometheus data source automatically

Create `docker/grafana/provisioning/datasources/prometheus.yml`:

```yaml
apiVersion: 1
datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true
    editable: false
```

---

## 11. Distributed Tracing

### Trace ID propagation

Every service generates a UUID v7 request ID via the `requestIdMiddleware` in
`@oneplatform/core`. This ID is available as `c.var.requestId` and appears in
the `X-Request-ID` response header.

The `createLogger()` function binds a `traceId` (a UUID v4 generated at logger
construction time) and embeds it in every `LogEvent`. To correlate a child
service's logs with a parent request, call `logger.withTraceId(traceId)`:

```typescript
// In a request handler — extract the upstream trace ID and bind the logger to it
const upstreamTraceId = c.req.header("X-Trace-Id") ?? randomUUID();
const requestLogger = logger.withTraceId(upstreamTraceId);

// All subsequent log calls on requestLogger include the same traceId
requestLogger.info("Processing pipeline run", { pipelineId });
```

The gateway propagates `X-Trace-Id` downstream on all proxied requests. Any
service receiving a request with this header should extract it and pass it to
`logger.withTraceId()` so the full call chain shares one trace ID in logs.

### OpenTelemetry setup

The logging service accepts `OTEL_EXPORTER_OTLP_ENDPOINT` from
`packages/core/src/config.ts`. To enable OTLP trace export:

1. Start a Jaeger or Tempo backend.
2. Set the environment variable on any service that should export traces.

Add to `docker-compose.override.yml`:

```yaml
services:
  jaeger:
    image: jaegertracing/all-in-one:1.57
    container_name: jaeger
    environment:
      COLLECTOR_OTLP_ENABLED: "true"
    ports:
      - "127.0.0.1:16686:16686"   # Jaeger UI
      - "127.0.0.1:4318:4318"     # OTLP/HTTP receiver
    networks:
      - oneplatform-internal
    restart: unless-stopped

  # Enable OTEL export on the logging service
  logging-service:
    environment:
      OTEL_EXPORTER_OTLP_ENDPOINT: http://jaeger:4318
      OTEL_SERVICE_NAME: logging-service
      OTEL_RESOURCE_ATTRIBUTES: deployment.environment=production
```

### Instrumenting a service with OTEL SDK

Install the OpenTelemetry SDK into a service:

```bash
pnpm --filter @oneplatform/logging add \
  @opentelemetry/sdk-node \
  @opentelemetry/auto-instrumentations-node \
  @opentelemetry/exporter-trace-otlp-http
```

Create `services/logging/src/tracing.ts` and call it before any other imports:

```typescript
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { Resource } from "@opentelemetry/resources";
import { SEMRESATTRS_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

const endpoint = process.env["OTEL_EXPORTER_OTLP_ENDPOINT"];

// Only initialize OTEL if an endpoint is configured. This keeps the service
// start-up path clean in environments without a tracing backend.
if (endpoint) {
  const sdk = new NodeSDK({
    resource: new Resource({
      [SEMRESATTRS_SERVICE_NAME]: process.env["SERVICE_NAME"] ?? "logging-service",
    }),
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    instrumentations: [getNodeAutoInstrumentations()],
  });

  sdk.start();

  process.on("SIGTERM", () => {
    sdk.shutdown().catch(console.error);
  });
}
```

### Connecting logs to traces

Because `traceId` is a first-class field in every `LogEvent`, correlating logs
and traces requires only matching the trace ID:

1. In Jaeger: find the trace by ID from the `X-Request-ID` or `X-Trace-Id`
   response header.
2. In Grafana (with Loki): use the Explore panel with `{service="gateway-service"} | json | traceId = "0192f3a1-..."`.
3. In Elasticsearch: `GET /oneplatform-logs-*/_search` with a `term` query on
   `traceId`.

### Zipkin integration

Replace the OTLP exporter with the Zipkin exporter:

```bash
pnpm --filter @oneplatform/logging add @opentelemetry/exporter-zipkin
```

```typescript
import { ZipkinExporter } from "@opentelemetry/exporter-zipkin";

const sdk = new NodeSDK({
  traceExporter: new ZipkinExporter({
    url: `${process.env["ZIPKIN_ENDPOINT"]}/api/v2/spans`,
  }),
  // ...
});
```

Add Zipkin to `docker-compose.override.yml`:

```yaml
services:
  zipkin:
    image: openzipkin/zipkin:3.3
    container_name: zipkin
    ports:
      - "127.0.0.1:9411:9411"
    networks:
      - oneplatform-internal
    restart: unless-stopped
```

---

## Quick-start checklist

For a DevOps engineer setting up monitoring from scratch:

- [ ] `docker compose up` — confirm all 9 services and caddy report `healthy` via `docker compose ps`
- [ ] Verify external access: `curl -sk https://localhost/healthz | jq .` returns `{"status":"ok",...}`
- [ ] Create `docker-compose.override.yml` with Prometheus, redis_exporter, pgbouncer_exporter, and Grafana services
- [ ] Create `docker/prometheus/prometheus.yml` with the three scrape jobs (minio, redis, pgbouncer)
- [ ] Create `docker/prometheus/alerts.yml` with the alert rules from Section 9
- [ ] Import `docker/grafana/dashboards/service-health.json` into Grafana
- [ ] Set up Grafana provisioning for the Prometheus datasource and dashboard
- [ ] (Optional) Add Vector Loki or Elasticsearch sink to `docker/vector/vector.yaml` for searchable logs
- [ ] (Optional) Add Jaeger to `docker-compose.override.yml` and set `OTEL_EXPORTER_OTLP_ENDPOINT` on services
- [ ] Verify `OP_LOG_LEVEL=debug` on one service, tail its logs, and confirm JSON format
- [ ] Verify Redis memory headroom: `redis-cli INFO memory | grep used_memory_human`
- [ ] Verify PgBouncer pool health: `psql .../pgbouncer -c "SHOW POOLS;"`
- [ ] Verify MinIO metrics (internal only): `docker compose exec gateway-service wget -qO- http://minio:9000/minio/v2/metrics/cluster | grep minio_cluster`
