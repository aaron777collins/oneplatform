# OnePlatform High Availability Guide

Deployment patterns and runbooks for eliminating single points of failure in
OnePlatform. The single-host Docker Compose stack described in
[DEPLOYMENT.md](DEPLOYMENT.md) and [OPERATIONS.md](OPERATIONS.md) is the
baseline. This guide describes what changes when you move to a multi-node HA
topology at the Large tier (50+ connectors, 10 M+ records/day).

For sizing guidance before committing to an HA deployment, read
[CAPACITY-PLANNING.md](CAPACITY-PLANNING.md) first.

**Jump to the section you need:**

| Topic | Section |
|---|---|
| PostgreSQL primary-replica replication | [§1 PostgreSQL HA](#1-postgresql-ha) |
| Redis Sentinel for BullMQ | [§2 Redis HA](#2-redis-ha) |
| Running 2+ service replicas | [§3 Service HA](#3-service-ha) |
| Caddy upstream configuration | [§4 Load Balancing](#4-load-balancing) |
| RTO/RPO targets, backup schedules, recovery runbooks | [§5 Disaster Recovery](#5-disaster-recovery) |
| Network topology | [§6 Network Architecture](#6-network-architecture) |
| Automated backup solution | [§8 Automated Backups](#8-automated-backups) |
| SLA tiers, uptime definition, maintenance windows | [§7 SLA Template](#7-service-level-agreement-sla-template) |

---

## 1. PostgreSQL HA

### 1.1 Replication topology

OnePlatform's single-host stack runs PostgreSQL as a single container. For HA,
deploy a primary with one or more streaming replicas. A three-node arrangement
covers most Large-tier deployments:

```
pg-primary   :5432   — accepts reads and writes
pg-replica-1 :5432   — streaming replica, read-only traffic
pg-replica-2 :5432   — streaming replica, standby for failover
```

PgBouncer runs on each application node and routes connections to the correct
PostgreSQL host. The application services themselves do not need to know which
host is primary — they always connect to PgBouncer.

### 1.2 Streaming replication setup

On **pg-primary**, add the following to `postgresql.conf`:

```ini
# postgresql.conf — primary

wal_level = replica
# Allow at least as many wal_senders as you have replicas plus a spare for backups.
max_wal_senders = 5
# Retain WAL segments until all replicas confirm receipt.
# Prevents the primary from discarding WAL that a slow replica still needs.
wal_keep_size = 1GB
# Synchronous replication to replica-1 only; replica-2 is async.
# Remove synchronous_standby_names for fully async (better performance, risk of
# 1-transaction loss on failover).
synchronous_standby_names = 'pg-replica-1'
```

Create a replication user on the primary:

```sql
-- Run as postgres superuser on pg-primary
CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD '<strong-password>';
```

Allow the replica hosts in `pg_hba.conf` on the primary:

```
# pg_hba.conf — primary
# Replace <replica-subnet> with the actual CIDR of your replica nodes
host  replication  replicator  <replica-subnet>/24  scram-sha-256
```

On each **replica**, bootstrap from the primary using `pg_basebackup`:

```bash
# Run on pg-replica-1 (repeat for pg-replica-2)
pg_basebackup \
  --host=pg-primary \
  --username=replicator \
  --pgdata=/var/lib/postgresql/data \
  --wal-method=stream \
  --progress \
  --verbose

# Create the standby signal file — this is what tells PostgreSQL to start
# in hot-standby (read-only replica) mode instead of primary mode.
touch /var/lib/postgresql/data/standby.signal
```

Add to `postgresql.conf` on each replica:

```ini
# postgresql.conf — replica
# application_name must match the value in synchronous_standby_names on the primary
# if you are using synchronous replication.
primary_conninfo = 'host=pg-primary port=5432 user=replicator password=<strong-password> application_name=pg-replica-1'
hot_standby = on
# Allow reads to lag behind primary by up to 30 seconds before refusing connections.
# This prevents a badly lagged replica from serving stale reads silently.
hot_standby_feedback = on
```

Verify replication is running on the primary:

```sql
-- pg-primary
SELECT client_addr, state, sent_lsn, write_lsn, flush_lsn, replay_lsn,
       sync_state
FROM pg_stat_replication;
-- state should be 'streaming' for each connected replica
```

### 1.3 PgBouncer read/write routing

PgBouncer maintains separate database aliases for write traffic (primary) and
read traffic (replica). Each service connects to the alias that matches its
workload.

Replace the single-host `pgbouncer.ini` `[databases]` entries with split aliases:

```ini
; pgbouncer.ini — HA configuration
; Write aliases — always point to pg-primary
oneplatform_gateway   = host=pg-primary   port=5432 dbname=oneplatform user=gateway_service_role   pool_size=15 pool_mode=transaction
oneplatform_auth      = host=pg-primary   port=5432 dbname=oneplatform user=auth_service_role      pool_size=20 pool_mode=transaction
oneplatform_ingestion = host=pg-primary   port=5432 dbname=oneplatform user=ingestion_service_role pool_size=25 pool_mode=transaction
oneplatform_app       = host=pg-primary   port=5432 dbname=oneplatform user=app_service_role       pool_size=15 pool_mode=transaction
oneplatform_logging   = host=pg-primary   port=5432 dbname=oneplatform user=logging_service_role   pool_size=30 pool_mode=transaction
oneplatform_plugin    = host=pg-primary   port=5432 dbname=oneplatform user=plugin_service_role    pool_size=10 pool_mode=transaction
oneplatform_execution = host=pg-primary   port=5432 dbname=oneplatform user=execution_service_role pool_size=10 pool_mode=transaction
; Session-mode services — advisory locks and LISTEN/NOTIFY require a persistent
; connection. Must never use transaction mode. These go to the primary only.
oneplatform_ontology  = host=pg-primary   port=5432 dbname=oneplatform user=ontology_service_role  pool_size=15 pool_mode=session
oneplatform_pipeline  = host=pg-primary   port=5432 dbname=oneplatform user=pipeline_service_role  pool_size=25 pool_mode=session

; Read-only aliases — point to pg-replica-1 (rotate to replica-2 manually on failover)
; Used by any future read-replica-aware service code that sets DATABASE_URL to
; the _ro alias. No existing service uses these by default — they are reserved for
; heavy read workloads (reporting, analytics) that you want to offload.
oneplatform_gateway_ro   = host=pg-replica-1 port=5432 dbname=oneplatform user=gateway_service_role   pool_size=10 pool_mode=transaction
oneplatform_auth_ro      = host=pg-replica-1 port=5432 dbname=oneplatform user=auth_service_role      pool_size=10 pool_mode=transaction
oneplatform_ontology_ro  = host=pg-replica-1 port=5432 dbname=oneplatform user=ontology_service_role  pool_size=10 pool_mode=transaction
```

Each application service has a `DATABASE_ALIAS` environment variable that maps
to a `[databases]` entry in `pgbouncer.ini`. The default alias names
(`oneplatform_<service>`) already target the primary. No service code change is
needed for the write path. Read-only aliases are available for future use when a
service is enhanced to route read queries separately.

### 1.4 Automatic failover with Patroni

Patroni manages leader election and failover using etcd or Consul as the
distributed consensus store. A three-node etcd cluster running alongside the
PostgreSQL nodes is the minimum for safe quorum.

**Install and configure Patroni** on each PostgreSQL node:

```yaml
# /etc/patroni/patroni.yml — pg-primary (adjust for each node)
scope: oneplatform-postgres
name: pg-primary

etcd3:
  hosts:
    - etcd-1:2379
    - etcd-2:2379
    - etcd-3:2379

bootstrap:
  dcs:
    ttl: 30
    loop_wait: 10
    # Wait 10 seconds before promoting a replica to avoid split-brain on transient
    # network partitions.
    retry_timeout: 10
    maximum_lag_on_failover: 10485760   # 10 MB — do not promote a far-behind replica
  initdb:
    - encoding: UTF8
    - data-checksums

postgresql:
  listen: 0.0.0.0:5432
  connect_address: pg-primary:5432
  data_dir: /var/lib/postgresql/data
  bin_dir: /usr/lib/postgresql/16/bin
  parameters:
    wal_level: replica
    max_wal_senders: 5
    wal_keep_size: 1GB
    hot_standby: on
    hot_standby_feedback: on

restapi:
  listen: 0.0.0.0:8008
  connect_address: pg-primary:8008
```

Start Patroni:

```bash
# On each node — systemd unit or Docker container
patronictl -c /etc/patroni/patroni.yml list
# Expected: one Leader, two Replica nodes, all in sync
```

**Notify PgBouncer on failover.** Patroni calls a `on_role_change` callback
when leadership changes. Write a callback script that updates
`pgbouncer.ini` and issues `RELOAD` to PgBouncer:

```bash
#!/bin/bash
# /etc/patroni/on_role_change.sh
# Patroni passes: action role cluster-name
ACTION=$1   # "master" | "replica" | "demote"
ROLE=$2

if [ "$ACTION" = "master" ]; then
  # Update all write aliases in pgbouncer.ini to point at this node
  CURRENT_HOST=$(hostname)
  sed -i "s/host=[^ ]*/host=${CURRENT_HOST}/" /etc/pgbouncer/pgbouncer.ini
  # Reload PgBouncer — RELOAD reconfigures pools without dropping existing connections
  psql -h 127.0.0.1 -p 5433 -U pgbouncer_admin pgbouncer -c "RELOAD;"
fi
```

Add to `patroni.yml`:

```yaml
postgresql:
  callbacks:
    on_role_change: /etc/patroni/on_role_change.sh
```

### 1.5 Alternative: pg_auto_failover

If you prefer a lighter-weight approach without etcd, `pg_auto_failover` from
Citus uses a dedicated monitor node for leader election:

```bash
# On the monitor node
pg_autoctl create monitor --pgdata /var/lib/postgresql/monitor --hostname monitor

# On pg-primary
pg_autoctl create postgres --pgdata /var/lib/postgresql/data \
  --hostname pg-primary \
  --monitor postgres://autoctl@monitor/pg_auto_failover

# On pg-replica-1
pg_autoctl create postgres --pgdata /var/lib/postgresql/data \
  --hostname pg-replica-1 \
  --monitor postgres://autoctl@monitor/pg_auto_failover
```

`pg_autoctl show state` reports primary / secondary / wait-primary / draining
states and handles automatic promotion.

### 1.6 Service connection strings

Each service reads `DATABASE_URL` at startup from the `init-data` volume via
`service-entrypoint.sh`. In HA deployments, the URL points at PgBouncer (which
is on each application node), not at PostgreSQL directly:

```
DATABASE_URL=postgres://<service>_service_role:<password>@pgbouncer:5433/oneplatform_<service>
```

No changes to application service code are needed. PgBouncer absorbs primary
failover transparently because `on_role_change.sh` updates the target host and
reloads PgBouncer before existing connections time out.

Services that need session-mode connections (`ontology-service`,
`pipeline-service`) will experience a brief connection reset during failover
while PgBouncer reconnects its session-mode pools to the new primary. Their
in-flight advisory locks will be released by PostgreSQL on connection drop;
BullMQ jobs in progress will be retried via the stall-check mechanism.

### 1.7 Backup and PITR strategy

`docker/scripts/backup.sh` takes a `pg_dump` snapshot. At Large tier, replace
or supplement this with continuous WAL archiving for point-in-time recovery.

**WAL archiving with pgBackRest:**

```ini
# /etc/pgbackrest/pgbackrest.conf — on pg-primary
[global]
repo1-path=/var/lib/pgbackrest
repo1-retention-full=2      # keep 2 full backups
repo1-retention-diff=7      # keep 7 differential backups

[oneplatform]
pg1-path=/var/lib/postgresql/data
```

Add to `postgresql.conf` on the primary:

```ini
archive_mode = on
archive_command = 'pgbackrest --stanza=oneplatform archive-push %p'
restore_command = 'pgbackrest --stanza=oneplatform archive-get %f %p'
```

Take a base backup nightly and archive WAL continuously:

```bash
# Nightly cron on pg-primary (run as postgres user)
0 2 * * * pgbackrest --stanza=oneplatform --type=diff backup
```

To restore to a point in time:

```bash
# Stop all application services first (see OPERATIONS.md §3 Backup and restore)
pgbackrest --stanza=oneplatform --type=time \
  --target="2026-06-18 03:45:00" \
  --target-action=promote \
  restore
```

For deployments that use a managed service (AWS RDS Multi-AZ, GCP Cloud SQL HA,
Azure Database for PostgreSQL Flexible Server), WAL archiving and automated
failover are provided by the platform. Point the PgBouncer `host=` entries at
the managed endpoint. The `on_role_change.sh` callback is unnecessary because
managed services present a stable DNS endpoint regardless of which physical node
is primary.

---

## 2. Redis HA

### 2.1 Redis Sentinel architecture

Redis Sentinel provides automatic master election and failover for BullMQ queues
and the session/rate-limit cache. The minimum supported topology is one Redis
primary, two Redis replicas, and three Sentinel processes:

```
redis-primary  :6379   — master, accepts reads and writes
redis-replica-1:6379   — replica, read-only
redis-replica-2:6379   — replica, read-only; becomes primary on failover

sentinel-1     :26379  — votes on failover
sentinel-2     :26379  — votes on failover
sentinel-3     :26379  — votes on failover (quorum = 2 out of 3)
```

Sentinels are lightweight processes and can share hosts with the Redis nodes or
with application nodes. The quorum of 2 means that at least 2 Sentinels must
agree before promoting a replica.

### 2.2 Redis Sentinel configuration

**Primary** (`redis.conf` on redis-primary — extends the existing
`docker/redis/redis.conf`):

```
# All settings from docker/redis/redis.conf apply unchanged.
# The replica nodes will connect to the primary automatically via
# sentinel-managed replication.
```

**Replicas** (`redis.conf` on redis-replica-1 and redis-replica-2):

```
# Start as replica of the primary. Sentinel will update this dynamically
# after a failover, so the static config is only used for the initial boot.
replicaof redis-primary 6379
replica-read-only yes

# Authenticate to the primary using the ACL admin user's password.
# Sentinel also needs this password to authenticate when issuing REPLICAOF
# commands during failover.
masterauth <redis_admin_password>

# Same ACL, memory, and persistence config as the primary.
appendonly yes
appendfsync everysec
maxmemory 256mb
maxmemory-policy allkeys-lru
aclfile /etc/redis/users.acl
```

**Sentinel** (`sentinel.conf` on each Sentinel node):

```
port 26379
# Monitor the primary with the name "oneplatform" — BullMQ and application
# services use this name when connecting via Sentinel.
sentinel monitor oneplatform redis-primary 6379 2
# Auth password — must match masterauth / the admin user password on Redis.
sentinel auth-pass oneplatform <redis_admin_password>
# Mark the primary as down if it does not respond within 5 seconds.
sentinel down-after-milliseconds oneplatform 5000
# Number of replicas that can simultaneously sync from the new primary after
# failover. 1 means they sync sequentially, avoiding simultaneous load spikes.
sentinel parallel-syncs oneplatform 1
# Wait 60 seconds before triggering another failover if the first one does not
# complete cleanly.
sentinel failover-timeout oneplatform 60000
```

Start Sentinels:

```bash
redis-sentinel /etc/redis/sentinel.conf
```

Verify from any Sentinel:

```bash
redis-cli -p 26379 SENTINEL masters
# Fields to check: name=oneplatform, flags=master, num-slaves=2, quorum=2
```

### 2.3 BullMQ Sentinel connection string

BullMQ connects to Redis via the `ioredis` library. To use Sentinel, pass a
Sentinel configuration object instead of a simple host:port:

```typescript
// packages/core/src/redis/createRedisClient.ts (or equivalent)
//
// Read sentinel addresses from environment so each deployment can specify
// its own topology without code changes.
import { Redis } from 'ioredis';

const sentinelHosts = (process.env.OP_REDIS_SENTINELS ?? '')
  .split(',')
  .filter(Boolean)
  .map((entry) => {
    const [host, port] = entry.trim().split(':');
    return { host, port: parseInt(port ?? '26379', 10) };
  });

// OP_REDIS_SENTINELS takes precedence over a single OP_REDIS_URL.
// This allows the same container image to work in both single-node (Compose)
// and Sentinel deployments via environment config alone.
export function createRedisClient(user: string, password: string): Redis {
  if (sentinelHosts.length > 0) {
    return new Redis({
      sentinels: sentinelHosts,
      name: process.env.OP_REDIS_SENTINEL_NAME ?? 'oneplatform',
      username: user,
      password,
      sentinelPassword: process.env.OP_REDIS_SENTINEL_PASSWORD,
      // Retry indefinitely — BullMQ workers should not give up on transient
      // Redis unavailability during a failover (typically < 10 seconds).
      maxRetriesPerRequest: null,
    });
  }

  return new Redis(process.env.OP_REDIS_URL ?? 'redis://localhost:6379', {
    username: user,
    password,
    maxRetriesPerRequest: null,
  });
}
```

Set the following environment variables on each application service in HA mode:

```bash
# .env — HA Redis Sentinel configuration
# Comma-separated list of sentinel host:port pairs
OP_REDIS_SENTINELS=sentinel-1:26379,sentinel-2:26379,sentinel-3:26379
# Must match the monitor name in sentinel.conf
OP_REDIS_SENTINEL_NAME=oneplatform
# The admin user password used by the Sentinel auth-pass directive
OP_REDIS_SENTINEL_PASSWORD=<redis_admin_password>
# OP_REDIS_URL is ignored when OP_REDIS_SENTINELS is set
```

### 2.4 Failover behavior and queue recovery

During a Sentinel-managed failover, Redis is unavailable for the duration of the
election — typically 5–15 seconds (bounded by `down-after-milliseconds` and the
time for replicas to complete the `REPLICAOF NO ONE` promotion).

**BullMQ behavior during failover:**

- Workers that are mid-job will lose their lock heartbeat. BullMQ's stall-check
  mechanism will move stalled jobs back to the `wait` queue after the
  `stalledInterval` (default: 30 seconds). Jobs are retried automatically.
- Jobs in the `wait`, `delayed`, and `failed` queues are fully durable because
  they are stored in Redis. When Redis recovers and Sentinel connects workers to
  the new primary, those jobs are immediately visible again.
- The `completed` queue may lose jobs added in the window before AOF sync on the
  old primary (at most 1 second with `appendfsync everysec`). Completed-job
  records are advisory — losing them does not affect correctness.

**To check queue state after a failover:**

```bash
# Connect to the new primary via Sentinel
SENTINEL_ADDR=sentinel-1:26379
NEW_PRIMARY=$(redis-cli -p 26379 -h sentinel-1 SENTINEL get-master-addr-by-name oneplatform)
# Returns: <host>\n<port>

# Check all queue waiting and active counts
for QUEUE in ingestion pipeline auth logging app plugin; do
  redis-cli -h <new-primary-host> -p 6379 \
    --user op_admin -a <admin-password> \
    LLEN "bull:queue:${QUEUE}:wait"
done
```

### 2.5 Cache warming after failover

Redis replicas stay in sync with the primary, so the cache is not cold after a
failover — the promoted replica already holds the full dataset. The only
potential stale state is keys written in the sub-second window before the old
primary's final AOF sync.

Keys that can safely be regenerated on demand (no warming needed):

- `ratelimit:*` — recreated on the next request
- `guest-session:*` — recreated on next guest session creation

Keys that must not be lost and are durably replicated:

- `auth:*`, `revocation:*` — session tokens and revocation list
- `bull:*` — BullMQ job state

If you observe unexpected rate limit resets after a failover, that is normal
and expected — the `allkeys-lru` eviction policy may also have trimmed counters
under memory pressure during the failover window.

---

## 3. Service HA

### 3.1 Stateless services (2+ replicas)

The following services hold no in-process state between requests and can be
scaled to any number of replicas behind a load balancer:

| Service | Container name (single-host) | HA replica count |
|---|---|---|
| `gateway-service` | `gateway-service` | 2+ |
| `auth-service` | `auth-service` | 2+ |
| `ontology-service` | `ontology-service` | 2+, but see note |
| `app-service` | `app-service` | 2+ |
| `logging-service` | `logging-service` | 2+ |
| `plugin-service` | `plugin-service` | 2+ |

**Ontology note:** Multiple `ontology-service` replicas can serve read traffic
simultaneously. Schema migrations use PostgreSQL advisory locks
(`pg_advisory_lock`) to serialize execution — if two replicas race on a
migration, one blocks until the other finishes. This is safe but means schema
migrations do not benefit from parallelism. Do not run migrations during peak
traffic when you have multiple replicas.

### 3.2 Stateful considerations (BullMQ-backed services)

`ingestion-service`, `pipeline-service`, and `execution-service` coordinate work
via BullMQ queues. Multiple replicas are safe and desirable — BullMQ distributes
jobs across all workers that subscribe to a queue, providing automatic load
balancing.

| Service | HA behavior |
|---|---|
| `ingestion-service` | Multiple replicas each subscribe to `bull:queue:ingestion`. Jobs are distributed across replicas. Each replica tracks its own in-flight batch in memory; a crash drops the batch and BullMQ re-queues the stalled job. |
| `pipeline-service` | Same pattern. Each replica subscribes to `bull:queue:pipeline`. Advisory locks in PostgreSQL ensure two replicas do not process the same pipeline run. |
| `execution-service` | Each replica maintains its own `OP_SANDBOX_POOL_SIZE` V8 isolates. Replicas do not share sandbox state. The Docker socket proxy (`docker-socket-proxy`) is a single container on the host — each execution-service replica dials `tcp://docker-socket-proxy:2375`. Ensure the proxy is co-located with or reachable from each application node. |

### 3.3 Health check endpoints

Every OnePlatform service exposes two health endpoints on port 3000 (internal):

| Endpoint | Meaning | Load balancer action |
|---|---|---|
| `GET /healthz` | Liveness: process is alive | Stop sending traffic if this fails 3 times |
| `GET /readyz` | Readiness: service is ready to serve | Do not send traffic until this returns 200 |

For a load balancer outside the Docker network, health checks must go through
Caddy or a dedicated health-check port mapping. See [§4 Load Balancing](#4-load-balancing).

Health check response format:

```json
{"status":"ok"}        // /healthz
{"status":"ready"}     // /readyz
```

A `readyz` check failing but `healthz` succeeding indicates the service is alive
but not yet ready — typically during startup or after a Redis/database
reconnection. The load balancer should remove the instance from rotation until
`readyz` passes, then re-add it without a restart.

### 3.4 Graceful shutdown and drain

All services are configured with `stop_grace_period: 45s` in
`docker/docker-compose.yml`. On receiving `SIGTERM`, the Hono HTTP server stops
accepting new requests and waits for in-flight requests to complete before
exiting.

For load balancer-managed deployments, the drain procedure before stopping an
instance is:

1. Remove the instance from the load balancer upstream pool (or set health check
   to fail by temporarily taking down `readyz`).
2. Wait for the load balancer's health-check interval to elapse so no new
   connections are routed to the instance (typically 10–30 seconds).
3. Send `SIGTERM` to the container. The service drains in-flight requests within
   45 seconds.
4. After the container exits, remove it from any persistent upstream configuration.

For BullMQ workers (`ingestion-service`, `pipeline-service`, `execution-service`),
the worker process pauses its BullMQ subscription before shutting down, allowing
in-progress jobs to complete. Jobs that cannot complete within the grace period
are abandoned and picked up by the stall-check mechanism on another replica.

**Zero-downtime rolling restart (Docker Compose):**

```bash
# Scale to 3 replicas, restart one at a time
# Remove container_name from the service definition first (required for >1 replica)
docker compose -f docker/docker-compose.yml up -d --scale gateway-service=3 --no-recreate

# Then rolling restart: stop one, let the LB drain, start it, repeat
for i in 1 2 3; do
  docker compose -f docker/docker-compose.yml stop oneplatform-gateway-service-${i}
  sleep 30   # allow in-flight requests to complete
  docker compose -f docker/docker-compose.yml start oneplatform-gateway-service-${i}
done
```

In a Kubernetes or Nomad deployment, the scheduler handles rolling restarts
natively via `RollingUpdate` strategy and `minReadySeconds` / `maxUnavailable`
configuration.

---

## 4. Load Balancing

### 4.1 Caddy upstream configuration for multiple service instances

The production Caddyfile template at `docker/caddy/Caddyfile.prod.template`
points at single named containers. In HA deployments, replace the single upstream
with a load-balanced upstream group using Caddy's `reverse_proxy` directive with
multiple backends:

```caddyfile
# Caddyfile — HA configuration (replaces Caddyfile.prod.template for multi-node)

{
    admin off
    email ${OP_TLS_EMAIL}
    log {
        output stdout
        format json
    }
}

${OP_DOMAIN} {
    header {
        Strict-Transport-Security  "max-age=31536000; includeSubDomains; preload"
        X-Content-Type-Options     "nosniff"
        X-Frame-Options            "DENY"
        Referrer-Policy            "strict-origin-when-cross-origin"
        Permissions-Policy         "camera=(), microphone=(), geolocation=()"
        Content-Security-Policy    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' wss://${OP_DOMAIN}; img-src 'self' data: blob:; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none';"
        -Server
    }

    handle /api/* {
        reverse_proxy {
            # List all gateway replicas. Caddy round-robins by default.
            to gateway-1:3000 gateway-2:3000 gateway-3:3000

            # Active health checks — Caddy probes /healthz on each backend
            # every 10 seconds. Unhealthy backends are removed from rotation.
            health_uri   /healthz
            health_interval 10s
            health_timeout  5s
            health_status   200

            # Passive health — if a backend returns 5xx or times out, mark it
            # as unhealthy for 30 seconds before retrying.
            fail_duration 30s
            max_fails     3

            # Retry the request on a different backend if the chosen one fails.
            # Only safe for idempotent requests (GET, HEAD). The gateway handles
            # retries for non-idempotent operations at the application layer.
            try_duration  5s
            try_interval  250ms

            header_up X-Forwarded-Proto {scheme}
            header_up X-Real-IP         {remote_host}
            # Flush response immediately — required for SSE streams.
            flush_interval -1
        }
    }

    handle {
        reverse_proxy {
            to frontend-1:80 frontend-2:80

            health_uri      /
            health_interval 15s
            health_timeout  5s
            health_status   200

            fail_duration 30s
            max_fails     3

            header_up X-Forwarded-Proto {scheme}
            header_up X-Real-IP         {remote_host}
        }
    }
}
```

### 4.2 Session affinity for SSE connections

Server-Sent Events (SSE) are long-lived HTTP connections. Once a client opens
an SSE stream to a specific gateway replica, all events for that stream come from
that replica. If the replica goes down, the client reconnects and the load
balancer assigns it to another healthy replica — this is handled transparently
by the SSE client library.

Caddy does not provide cookie-based session affinity in the Community Edition.
If you need sticky sessions (for debugging or for session-state that is not in
Redis), use a custom header approach:

```caddyfile
handle /api/events/* {
    reverse_proxy {
        to gateway-1:3000 gateway-2:3000

        # lb_policy cookie creates a sticky session using a Set-Cookie header.
        # The cookie value encodes the chosen upstream.
        lb_policy cookie op_lb_sticky
    }
}
```

For production, SSE stickiness is not required because the gateway reads
event state from Redis (`events:*` key prefix). Any gateway replica can serve
any SSE stream. The reconnect latency when a replica goes down is bounded by
the client's `EventSource` reconnect interval (typically 3 seconds).

### 4.3 WebSocket connection handling

WebSocket connections follow the same affinity logic as SSE. Once upgraded, the
connection is stateful. Caddy proxies WebSocket upgrades transparently:

```caddyfile
handle /api/ws/* {
    reverse_proxy {
        to gateway-1:3000 gateway-2:3000

        # WebSocket upgrade headers are forwarded automatically by Caddy's
        # reverse_proxy. No additional configuration is needed.
        # flush_interval -1 ensures frames are not buffered.
        flush_interval -1

        health_uri      /healthz
        health_interval 10s
    }
}
```

When a gateway replica goes down, all active WebSocket connections to that
replica are dropped. Clients must reconnect — ensure your frontend WebSocket
client has exponential backoff reconnect logic.

### 4.4 Health-check-based routing in external load balancers

If Caddy is behind an external load balancer (AWS ALB, GCP Load Balancing,
Nginx, HAProxy), configure health checks against the Caddy instances:

| Layer | Health check target | Protocol | Expected response |
|---|---|---|---|
| External LB → Caddy | `https://<caddy-node>/healthz` | HTTPS | 200 `{"status":"ok"}` |
| Caddy → gateway replicas | `http://gateway-N:3000/healthz` | HTTP | 200 `{"status":"ok"}` |
| Caddy → frontend replicas | `http://frontend-N:80/` | HTTP | 200 |

The `/healthz` path passes through the gateway's routing layer. A `200` response
confirms that Caddy, the gateway, and the gateway's dependencies (Redis,
PgBouncer) are all healthy.

---

## 5. Disaster Recovery

### 5.1 RTO/RPO targets by deployment tier

| Tier | RTO target | RPO target | Strategy |
|---|---|---|---|
| Small (single-host) | 1–2 hours | 24 hours (last daily backup) | Restore from `backup.sh` snapshot |
| Medium (external DB) | 30 minutes | 1 hour | RDS automated backup + daily `pg_dump` |
| Large (HA cluster) | < 5 minutes | < 10 seconds (1 WAL archive interval) | Patroni automatic failover + WAL archiving |

**RTO (Recovery Time Objective):** time from failure detection to service
restoration.

**RPO (Recovery Point Objective):** maximum data loss measured in time.

### 5.2 Backup schedule

#### PostgreSQL

| Backup type | Frequency | Retention | Tool | Storage |
|---|---|---|---|---|
| Full logical dump | Daily at 02:00 UTC | 7 days | `pg_dump` via `backup.sh` | Local `./backups/` or S3 |
| Differential base backup | Daily at 02:00 UTC | 2 full backups | pgBackRest | S3-compatible (MinIO or external) |
| WAL archive | Continuous (every segment, ~16 MB) | 14 days | pgBackRest `archive-push` | S3-compatible |

The existing `docker/scripts/backup.sh` handles the logical dump. For WAL
archiving, add pgBackRest alongside the PostgreSQL primary as shown in §1.7.

Set up the daily backup cron:

```bash
# crontab -e on the application host (or dedicated backup host)

# Full pg_dump backup via backup.sh (works for Small and Medium tiers)
0 2 * * * /opt/oneplatform/docker/scripts/backup.sh /opt/oneplatform/backups >> /var/log/oneplatform-backup.log 2>&1

# pgBackRest differential backup (Large tier — requires pgBackRest configured per §1.7)
0 3 * * * pgbackrest --stanza=oneplatform --type=diff backup >> /var/log/pgbackrest.log 2>&1

# Full pgBackRest base backup weekly on Sunday
0 4 * * 0 pgbackrest --stanza=oneplatform --type=full backup >> /var/log/pgbackrest.log 2>&1
```

#### Redis

Redis persistence is configured in `docker/redis/redis.conf`:

```
appendonly yes
appendfsync everysec   # at most 1 second of data loss
```

For HA deployments, the AOF on each replica provides an additional copy. To take
a periodic RDB snapshot for off-host archiving:

```bash
# Force an RDB snapshot (runs in background, non-blocking)
redis-cli --user op_admin -a <admin-password> BGSAVE

# Copy the dump.rdb from the redis-data volume to off-host storage
docker run --rm \
  -v oneplatform_redis-data:/data:ro \
  -v /opt/oneplatform/backups/redis:/backup \
  alpine sh -c "cp /data/dump.rdb /backup/redis-$(date +%Y%m%d_%H%M%S).rdb"
```

`backup.sh` already includes a Redis RDB snapshot step. Verify it in
`docker/scripts/backup.sh`.

### 5.3 Recovery procedures

#### Restore PostgreSQL from pg_dump (Small/Medium tier)

```bash
# 1. Stop all application services
docker compose -f docker/docker-compose.yml stop \
  caddy frontend \
  gateway-service auth-service ingestion-service ontology-service \
  pipeline-service execution-service app-service logging-service plugin-service

# 2. Restore using restore.sh
./docker/scripts/restore.sh ./backups/20260618_020000 --yes

# 3. Restart all application services
docker compose -f docker/docker-compose.yml up -d \
  gateway-service auth-service ingestion-service ontology-service \
  pipeline-service execution-service app-service logging-service plugin-service \
  frontend caddy
```

#### Restore PostgreSQL to a point in time (Large tier, pgBackRest)

```bash
# 1. Stop all application services on all nodes
# 2. On the target PostgreSQL node:
pgbackrest --stanza=oneplatform --type=time \
  --target="2026-06-18 03:45:00" \
  --target-action=promote \
  restore

# 3. Verify the restored timeline
psql -U postgres -c "SELECT pg_current_wal_lsn(), now();"

# 4. If using Patroni, reinitialize the cluster from the restored primary:
patronictl -c /etc/patroni/patroni.yml reinit oneplatform-postgres pg-replica-1
patronictl -c /etc/patroni/patroni.yml reinit oneplatform-postgres pg-replica-2

# 5. Restart application services
```

#### Rebuild Redis from scratch

Redis data loss is rare because replicas hold a copy and AOF provides
near-continuous durability. If all Redis nodes are lost simultaneously:

```bash
# 1. Start a fresh Redis instance (the existing docker/redis/redis.conf)
docker compose -f docker/docker-compose.yml up -d redis

# 2. Services will reconnect automatically. BullMQ queues are empty — any
#    jobs that were in flight at the time of data loss need to be re-submitted.
#    Review the application logs to identify which operations were in progress.

# 3. Auth tokens (auth:*) are gone — all active user sessions are invalidated.
#    Users will be prompted to log in again. This is the expected behavior.

# 4. Revocation list (revocation:*) is gone — previously revoked tokens are
#    no longer blocked. If you have recently revoked tokens for a security
#    incident, re-issue the revocation commands or rotate the JWT secret.
#    See OPERATIONS.md §6 (JWT secret rotation).
```

If an RDB snapshot is available from before the data loss:

```bash
# Stop Redis, restore the RDB, restart
docker compose -f docker/docker-compose.yml stop redis
docker run --rm \
  -v oneplatform_redis-data:/data \
  -v /opt/oneplatform/backups/redis:/backup:ro \
  alpine sh -c "cp /backup/redis-20260618_020000.rdb /data/dump.rdb"
docker compose -f docker/docker-compose.yml start redis
```

### 5.4 Runbooks for common failure scenarios

#### Scenario 1: PostgreSQL primary failure (HA cluster)

**Symptoms:** Services log `ECONNREFUSED` or `FATAL: role does not exist` errors
against PgBouncer. PgBouncer `SHOW POOLS` shows `cl_waiting` climbing.

```
Detected  → Patroni logs: "Leader key expired", promotes pg-replica-1
  ~5s     → pg-replica-1 becomes new primary, rejects writes during promotion window
  ~10s    → Patroni calls on_role_change.sh on new primary node
  ~10s    → PgBouncer pgbouncer.ini updated, RELOAD issued
  ~15s    → Applications reconnect through PgBouncer to new primary
  ~30s    → BullMQ stall-checker re-queues any stalled jobs
```

Manual verification after automatic failover:

```bash
# Confirm new leader
patronictl -c /etc/patroni/patroni.yml list
# Expected: pg-replica-1 as Leader, pg-primary as Replica (once it recovers)

# Confirm PgBouncer is pointing at new primary
psql -h pgbouncer -p 5433 -U pgbouncer_admin pgbouncer -c "SHOW DATABASES;"
# host column should show pg-replica-1 for all write aliases
```

#### Scenario 2: Redis primary failure (Sentinel cluster)

**Symptoms:** Services log `Connection refused` to Redis. BullMQ workers stop
processing. Rate limiting falls back to in-memory counters (if implemented).

```
Detected  → Sentinels mark master as subjectively down (SDOWN) at ~5s
  ~5s     → Sentinels reach quorum (2/3), mark master as objectively down (ODOWN)
  ~5s     → Sentinel elected to coordinate failover promotes replica with lowest replication lag
  ~8s     → New primary is announced via sentinel PUBLISH
  ~10s    → ioredis clients re-query Sentinel, connect to new primary
  ~30s    → BullMQ stall-checker re-queues any jobs stalled during the window
```

Manual verification:

```bash
redis-cli -p 26379 -h sentinel-1 SENTINEL masters
# flags should be "master" (not "s_down" or "o_down") after failover completes
```

#### Scenario 3: Single application service instance failure

**Symptoms:** Load balancer health checks fail for one gateway/auth/etc. replica.
Caddy (or external LB) marks it unhealthy and routes traffic to remaining replicas.

```
Detected  → Caddy passive health: 3 consecutive failures trigger fail_duration 30s
  0s      → Failed replica removed from Caddy upstream pool
  0s      → Remaining replicas absorb traffic (ensure replicas have headroom)
  ~30s    → Caddy retries health check against failed replica
  Manual  → Investigate and restart failed container
```

Restart the failed service:

```bash
docker compose -f docker/docker-compose.yml restart gateway-service
# Or for a named replica:
docker compose -f docker/docker-compose.yml up -d --no-deps --force-recreate gateway-service
```

Check logs for the crash cause:

```bash
docker compose -f docker/docker-compose.yml logs --tail=100 gateway-service
```

#### Scenario 4: Host failure (single-host deployment)

**Symptoms:** All services unavailable. No automatic recovery — requires manual
intervention.

```
1. Provision a replacement host with the same OS and Docker version.
2. Transfer the backup archive: ./backups/<date>/ and the .env file.
3. Restore: ./docker/scripts/restore.sh ./backups/<date> --yes
4. Start the stack: docker compose -f docker/docker-compose.yml up -d
5. Verify all services healthy: docker compose -f docker/docker-compose.yml ps
6. Update DNS to point OP_DOMAIN at the new host IP.
```

RTO for single-host host failure is bounded by host provisioning time (typically
30–60 minutes) plus restore time (proportional to database size).

---

## 6. Network Architecture

### 6.1 Network topology diagram

#### Single-host (current Docker Compose)

```
Internet
    │
    │ :80, :443
    ▼
┌─────────────────────────────────────────────────────────────────┐
│  Host                                                           │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  oneplatform-public (bridge)                             │  │
│  │                                                          │  │
│  │  ┌─────────┐    ┌─────────────────┐    ┌──────────┐    │  │
│  │  │  Caddy  │───▶│ gateway-service │    │ frontend │    │  │
│  │  │ :80/:443│    │    :3000        │    │  :80     │    │  │
│  │  └─────────┘    └────────┬────────┘    └──────────┘    │  │
│  └───────────────────────────┼────────────────────────────┘  │
│                               │ oneplatform-internal           │
│  ┌────────────────────────────┼──────────────────────────────┐  │
│  │  oneplatform-internal (bridge, internal: true)            │  │
│  │                            │                              │  │
│  │  auth  ingestion  ontology  pipeline  execution  app      │  │
│  │  logging  plugin                                          │  │
│  │                                                           │  │
│  │  pgbouncer:5433   postgres:5432   redis:6379   minio:9000 │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌──────────────────────────────────────────────┐              │
│  │  oneplatform-sandbox (bridge, internal: true) │              │
│  │  execution-service ──── docker-socket-proxy   │              │
│  │  op-sandbox-vm (Unix socket: /run/sandbox)    │              │
│  └──────────────────────────────────────────────┘              │
└─────────────────────────────────────────────────────────────────┘
```

#### Large-tier HA (multi-node)

```
Internet
    │
    │ :443
    ▼
┌──────────────────────────────┐
│  External Load Balancer      │  (AWS ALB / GCP LB / HAProxy)
│  Health check: /healthz      │
└──────┬────────────────┬──────┘
       │                │
  ┌────▼────┐      ┌────▼────┐
  │  App    │      │  App    │     Application nodes (N nodes)
  │ Node 1  │      │ Node 2  │
  │         │      │         │
  │  Caddy  │      │  Caddy  │     TLS termination on each node
  │  :443   │      │  :443   │     (shared TLS cert via cert manager)
  │         │      │         │
  │  gateway│      │  gateway│     2+ replicas per node
  │  auth   │      │  auth   │
  │  app    │      │  app    │
  │  ...    │      │  ...    │
  │         │      │         │
  │ PgBouncer      PgBouncer │     Local PgBouncer on each app node
  └──┬──────┘      └──────┬──┘
     │                    │
     └──────┬─────────────┘
            │ Internal DB network (separate, low-latency)
  ┌─────────▼──────────────────────────────────────────────┐
  │  Database nodes                                        │
  │                                                        │
  │  ┌─────────────┐  ┌──────────────┐  ┌──────────────┐ │
  │  │ pg-primary  │  │ pg-replica-1 │  │ pg-replica-2 │ │
  │  │   :5432     │  │   :5432      │  │   :5432      │ │
  │  │  (Patroni   │  │  (Patroni    │  │  (Patroni    │ │
  │  │   Leader)   │  │   Replica)   │  │   Replica)   │ │
  │  └─────────────┘  └──────────────┘  └──────────────┘ │
  │                                                        │
  │  ┌─────────────┐  ┌──────────────┐  ┌──────────────┐ │
  │  │redis-primary│  │redis-replica │  │redis-replica │ │
  │  │   :6379     │  │     -1:6379  │  │     -2:6379  │ │
  │  └─────────────┘  └──────────────┘  └──────────────┘ │
  │                                                        │
  │  ┌─────────────┐  ┌──────────────┐  ┌──────────────┐ │
  │  │  sentinel-1 │  │  sentinel-2  │  │  sentinel-3  │ │
  │  │   :26379    │  │   :26379     │  │   :26379     │ │
  │  └─────────────┘  └──────────────┘  └──────────────┘ │
  │                                                        │
  │  ┌──────────────────────────────────────────────────┐ │
  │  │  etcd cluster (3 nodes)  :2379                   │ │
  │  │  (Patroni consensus store)                       │ │
  │  └──────────────────────────────────────────────────┘ │
  └────────────────────────────────────────────────────────┘
```

### 6.2 Internal vs external network segmentation

| Network segment | Purpose | Exposure |
|---|---|---|
| `oneplatform-public` | Caddy and gateway/frontend bridges | Reachable from host; Caddy binds :80/:443 |
| `oneplatform-internal` | All service-to-service traffic | `internal: true` — not routable from host |
| `oneplatform-sandbox` | execution-service ↔ sandbox IPC | `internal: true` — isolated from all other traffic |
| DB network (HA only) | App nodes ↔ DB nodes | Separate VLAN or VPC peering; no internet exposure |

In HA deployments, add a dedicated network interface or VLAN for database
replication traffic. PostgreSQL streaming replication and Sentinel gossip
generate significant bandwidth during replica sync. Isolating this traffic
prevents it from saturating the network interface used by application traffic.

### 6.3 DNS and service discovery patterns

#### Within a single Docker Compose host

Docker Compose creates DNS entries for each service using the service name as
the hostname. Services reach each other at `http://<service-name>:3000` — for
example, `http://auth-service:3000/healthz`. No external DNS is involved for
internal traffic.

In the HA topology, this convention extends:

- Each application node runs its own Docker Compose stack with Caddy, gateway,
  auth, and other stateless services as containers.
- PgBouncer on each node is configured with the IP or hostname of the PostgreSQL
  primary (or updated by `on_role_change.sh` on failover).
- Redis Sentinel addresses are passed via `OP_REDIS_SENTINELS` environment
  variable; ioredis resolves the current primary dynamically via Sentinel.

#### Kubernetes or Nomad deployments

Replace Docker Compose service names with Kubernetes Service DNS names or
Consul service entries:

| Single-host name | Kubernetes equivalent |
|---|---|
| `gateway-service:3000` | `gateway-service.oneplatform.svc.cluster.local:3000` |
| `pgbouncer:5433` | `pgbouncer-svc.oneplatform.svc.cluster.local:5433` |
| `redis:6379` | Managed via Sentinel or Redis Operator |

For Sentinel on Kubernetes, deploy Redis using the
[Redis Sentinel Helm chart](https://github.com/bitnami/charts/tree/main/bitnami/redis)
(Bitnami) or a Redis Operator. The Sentinel service DNS name replaces the comma-
separated `OP_REDIS_SENTINELS` list.

#### DNS failover (simple HA without Patroni)

For a reduced-complexity HA setup, use DNS-based failover:

- Assign a stable DNS name to the PostgreSQL primary (e.g. `pg-primary.internal`).
- On failover, update the DNS A record to point at the promoted replica.
- PgBouncer resolves the hostname at connection time; existing connections are
  not affected until they are dropped and re-established.
- DNS TTL should be ≤ 30 seconds to minimise the failover window.

This approach trades simplicity for slower failover (bounded by DNS TTL +
PgBouncer reconnect time vs. Patroni's 10–15 second failover).

---

## 7. Service Level Agreement (SLA) Template

This section defines uptime tiers and operational commitments. Operators should
review and customise these targets to match contractual obligations with their
customers before deploying to production.

### 7.1 Tier definitions

| Tier | Target uptime | Allowed downtime / month | Typical use case |
|---|---|---|---|
| **Development** | No SLA | Unlimited | Local development, CI, staging |
| **Standard** | 99.5% | ≈ 3.65 hours | Small/medium production deployments |
| **Enterprise** | 99.9% | ≈ 43 minutes | Business-critical workloads |
| **Enterprise Plus** | 99.95% | ≈ 22 minutes | High-value, contractually committed |

Uptime is measured as a rolling 30-day window from the first day of each
calendar month.

### 7.2 What counts toward uptime

**In scope — downtime is counted when:**

- The Gateway API (`/api/v1/**`) returns HTTP 5xx for > 1% of requests over any
  5-minute window (error rate threshold).
- The Gateway API p99 latency exceeds 10 seconds for > 5 minutes continuously.
- Data pipeline execution is blocked for > 15 minutes (no pipeline runs complete
  that were scheduled within the measurement window).
- The frontend application (`/`) is unreachable for > 2 minutes.

**Out of scope — the following do not count as downtime:**

- Scheduled maintenance windows (see §7.4).
- Degraded performance that does not breach the error rate or latency thresholds.
- Failures caused by customer misconfiguration (invalid connector credentials,
  malformed pipeline YAML, resource quota exhaustion).
- External dependency outages (upstream databases, third-party APIs) beyond the
  platform's control.
- Force majeure events (natural disasters, widespread cloud-provider outages
  affecting multiple availability zones simultaneously).

### 7.3 Measurement methodology

Uptime is measured using the `/healthz` endpoint on the Gateway service.
A synthetic probe checks every 60 seconds from an external location. A
check is considered failed when:

1. The probe receives no HTTP response within 5 seconds, **or**
2. The response HTTP status is not 2xx.

Two consecutive failed checks (120 seconds) open a downtime incident. The
incident closes when two consecutive checks succeed.

Operators should configure an uptime monitoring service (e.g., Grafana Cloud,
Datadog Synthetics, UptimeRobot) pointing at `https://<your-domain>/healthz`.

### 7.4 Planned maintenance windows

Planned maintenance is excluded from SLA calculations when:

1. Customers are notified at least **48 hours in advance** for Standard tier
   or **5 business days** for Enterprise tier.
2. The maintenance window does not exceed **4 hours** per calendar month.
3. Maintenance is performed between **02:00–06:00 UTC** on weekdays or any
   time on weekends (unless otherwise agreed).

During maintenance, the platform should serve HTTP 503 with a
`Retry-After` header. Caddy can be configured to serve a maintenance page:

```caddyfile
# Add before the reverse_proxy directive to activate maintenance mode
respond /api/* "Service temporarily unavailable for maintenance" 503 {
    header Retry-After "3600"
}
```

### 7.5 Incident response targets

| Severity | Description | Initial response | Update frequency |
|---|---|---|---|
| **P1 — Critical** | Full outage, SLA breach in progress | 15 minutes | Every 30 minutes |
| **P2 — High** | Partial outage, >50% of API calls failing | 30 minutes | Every 60 minutes |
| **P3 — Medium** | Degraded performance, SLA at risk | 2 hours | Every 4 hours |
| **P4 — Low** | Minor issues, no SLA impact | Next business day | As resolved |

Response targets apply from the time an alert fires in the monitoring system,
not from when a customer reports the issue.

### 7.6 Backup and recovery commitments

| Metric | Target |
|---|---|
| Recovery Point Objective (RPO) | ≤ 1 hour (Standard), ≤ 15 minutes (Enterprise) |
| Recovery Time Objective (RTO) | ≤ 4 hours (Standard), ≤ 1 hour (Enterprise) |
| Backup retention | 7 days (Standard), 30 days (Enterprise) |
| Backup verification | Restore test performed monthly |

Backup procedures are documented in `docker/scripts/backup.sh`. Operators
should schedule automated backups (see §EE-019 in the HA guide) and perform
periodic restore drills to validate RPO/RTO targets.

### 7.7 Customisation checklist

Before publishing this SLA to customers, operators should:

- [ ] Confirm uptime tier with legal/commercial team and update §7.1.
- [ ] Agree maintenance window schedule with operations team and update §7.4.
- [ ] Configure external uptime monitoring pointed at `/healthz`.
- [ ] Set up incident escalation paths and update §7.5 contact information.
- [ ] Verify backup schedule meets the RPO in §7.6.
- [ ] Add this document (or a customer-facing version) to the service agreement.

---

## 8. Automated Backups

OnePlatform ships a backup script at `docker/scripts/backup.sh` that handles
all three data stores in a single run. The Docker Compose stack includes an
optional `op-backup` service that runs this script on a cron schedule.

### 8.1 What is backed up

| Data store | Method | Output |
|---|---|---|
| PostgreSQL | `pg_dump` (custom format, compressed) | `<timestamp>/postgres.dump` |
| Redis | `BGSAVE` + RDB file copy | `<timestamp>/redis.rdb` |
| MinIO | `mc mirror` (all buckets) | `<timestamp>/minio/` |
| init-data volume | `tar` via alpine container | `<timestamp>/init-data/init-data.tar` |

The init-data backup is critical — it contains the master key, JWT signing
keys, and bootstrap secrets generated by `op-init`. Losing this volume without
a backup makes recovery impossible even with a full Postgres dump.

### 8.2 Manual backup

Run the backup script manually from the repository root:

```bash
# Output goes to ./backups/<timestamp>/
./docker/scripts/backup.sh

# Custom output directory
./docker/scripts/backup.sh /mnt/nas/oneplatform-backups

# Required for MinIO backup
OP_MINIO_USER=minioadmin OP_MINIO_PASSWORD=<password> ./docker/scripts/backup.sh
```

### 8.3 Automated backup with Docker Compose

The `op-backup` service in `docker-compose.yml` runs the backup on a cron
schedule. Enable it by starting with the `backup` profile:

```bash
# Start the full stack including automated daily backups at 02:00 UTC
docker compose --profile backup up -d

# Override the schedule (e.g. every 6 hours)
OP_BACKUP_CRON="0 */6 * * *" docker compose --profile backup up -d

# Override the output directory
OP_BACKUP_DIR=/mnt/nas/backups docker compose --profile backup up -d
```

View backup logs:

```bash
docker compose logs op-backup -f
```

### 8.4 Off-host backup transfer

Backup files on the host are a single point of failure. Transfer completed
backups to a separate location:

```bash
# Example: rsync to a remote backup server
rsync -avz --remove-source-files ./backups/ backup-server:/data/oneplatform/

# Example: upload to S3-compatible storage
aws s3 sync ./backups/ s3://your-bucket/oneplatform-backups/ --storage-class STANDARD_IA
```

### 8.5 Restore procedure

See `docker/scripts/restore.sh` and [§5 Disaster Recovery](#5-disaster-recovery)
in this guide for full restore runbooks. Quick reference:

```bash
# Restore PostgreSQL from a specific backup
docker compose exec -T postgres pg_restore \
  -U postgres -d oneplatform -F custom \
  /tmp/postgres.dump < ./backups/<timestamp>/postgres.dump

# Verify backup integrity without restoring
pg_restore --list ./backups/<timestamp>/postgres.dump | head -20
```

### 8.6 Backup verification schedule

Automated backups are only valuable if they can be restored. Establish a
regular restore drill schedule:

| Frequency | Activity |
|---|---|
| Weekly | Verify backup files exist and are non-zero |
| Monthly | Restore PostgreSQL dump to a test container, run `SELECT count(*) FROM ...` |
| Quarterly | Full DR drill: restore all data stores to a test environment, verify app starts |
