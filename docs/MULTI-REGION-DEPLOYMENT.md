# OnePlatform Multi-Region Deployment Guide

Comprehensive guide for deploying OnePlatform across multiple geographic
regions. Covers architecture patterns, database and cache replication,
service configuration, networking, data consistency, operational procedures,
and example configurations for Docker Compose, Helm, and Terraform.

**Prerequisites:** Read these documents first — they describe the
single-region baseline that this guide extends.

| Document | Why |
|---|---|
| [DEPLOYMENT.md](DEPLOYMENT.md) | Single-host Docker Compose setup |
| [HIGH-AVAILABILITY.md](HIGH-AVAILABILITY.md) | Intra-region HA (PostgreSQL replication, Redis Sentinel, Patroni) |
| [CAPACITY-PLANNING.md](CAPACITY-PLANNING.md) | Resource sizing per tier |
| [OPERATIONS.md](OPERATIONS.md) | Day-to-day operations, backup, monitoring |

---

## Table of Contents

1. [Why Multi-Region](#1-why-multi-region)
2. [Architecture Patterns](#2-architecture-patterns)
3. [Database Replication](#3-database-replication)
4. [Redis Replication](#4-redis-replication)
5. [Service Configuration](#5-service-configuration)
6. [Network and DNS](#6-network-and-dns)
7. [Data Consistency](#7-data-consistency)
8. [Operational Procedures](#8-operational-procedures)
9. [Example Configurations](#9-example-configurations)
10. [Cost Estimation Framework](#10-cost-estimation-framework)

---

## 1. Why Multi-Region

Multi-region deployment serves three purposes:

1. **Latency reduction.** Users on different continents hit a region
   close to them instead of routing all traffic to a single data center.
   OnePlatform's gateway adds ~2 ms of processing overhead; cross-continent
   RTT (100-300 ms) dominates the user experience.
2. **Disaster recovery.** A full region outage (cloud provider failure,
   natural disaster, regulatory takedown) does not take the platform offline.
3. **Data residency.** Some tenants require that their data stays within a
   specific jurisdiction (EU, AU, etc.). Multi-region allows tenant-affinity
   routing so that a tenant's data never leaves their designated region.

Not every deployment needs multi-region. Use the decision matrix in
[section 2.5](#25-decision-matrix) to determine whether it is warranted.

---

## 2. Architecture Patterns

OnePlatform supports three multi-region patterns. Each trades off latency,
consistency, operational complexity, and cost differently.

### 2.1 Active-Active

Both regions serve read and write traffic simultaneously. Data is replicated
bidirectionally.

```
┌─────────────────────┐         ┌─────────────────────┐
│     Region US-East  │◄───────►│    Region EU-West   │
│                     │  bidir  │                     │
│  GeoDNS ──► Caddy   │  repli- │  GeoDNS ──► Caddy   │
│  Caddy ──► Gateway  │  cation │  Caddy ──► Gateway  │
│  Gateway ──► Svc*   │         │  Gateway ──► Svc*   │
│  PG Primary + Redis │         │  PG Primary + Redis │
└─────────────────────┘         └─────────────────────┘
```

**Characteristics:**

| Attribute | Value |
|---|---|
| Read latency | Low — served locally |
| Write latency | Low — writes accepted locally |
| Consistency | Eventual (conflict resolution required) |
| Failover time | Near-zero (traffic already flowing to both) |
| Complexity | High — bidirectional replication, conflict resolution |
| Best for | Global user base, latency-critical workloads |

**OnePlatform-specific considerations:**

- The ontology service uses advisory locks for schema migrations. In
  Active-Active, only one region should run ontology migrations at a time.
  Use a distributed lock (etcd or a dedicated migration-leader election)
  to serialize migrations.
- BullMQ job queues must be region-local. A pipeline job created in
  US-East must execute in US-East to avoid cross-region data fetches
  during execution. See [section 4.3](#43-bullmq-job-queue-considerations).
- Conflict resolution for the `connectors`, `pipelines`, and `apps`
  tables requires last-writer-wins with logical clocks. See
  [section 7.2](#72-conflict-resolution-strategies).

### 2.2 Active-Passive

One region (primary) serves all traffic. The secondary region is a warm
standby that receives replicated data and can be promoted on failover.

```
┌─────────────────────┐         ┌─────────────────────┐
│   Region US-East    │────────►│   Region EU-West    │
│   (PRIMARY)         │  async  │   (STANDBY)         │
│                     │  stream │                     │
│  DNS ──► Caddy      │  repli- │  Caddy (idle)       │
│  Caddy ──► Gateway  │  cation │  Gateway (idle)     │
│  Gateway ──► Svc*   │         │  Svc* (idle)        │
│  PG Primary + Redis │         │  PG Replica + Redis │
└─────────────────────┘         └─────────────────────┘
```

**Characteristics:**

| Attribute | Value |
|---|---|
| Read latency | Low for primary-region users; high for distant users |
| Write latency | Low for primary-region users |
| Consistency | Strong (single writer) |
| Failover time | 1-5 minutes (DNS propagation + promotion) |
| Complexity | Low — standard streaming replication |
| Best for | Compliance-first deployments, low global traffic |

**OnePlatform-specific considerations:**

- All 9 services run in the standby region but with their health
  endpoints excluded from DNS. They stay warm (connected to local PG
  replica, local Redis replica) so that promotion only requires DNS
  cutover and PG promotion — no cold-start.
- The standby region's PgBouncer connects to the local PG replica in
  read-only mode. On failover, `on_role_change.sh` (from
  HIGH-AVAILABILITY.md §1.4) promotes the replica and repoints PgBouncer.

### 2.3 Read-Local-Write-Primary

Reads are served from the nearest region. Writes are routed to the primary
region. This is the recommended starting point for most OnePlatform
multi-region deployments.

```
┌─────────────────────┐         ┌─────────────────────┐
│   Region US-East    │────────►│   Region EU-West    │
│   (PRIMARY)         │  async  │   (READ REPLICA)    │
│                     │  stream │                     │
│  GeoDNS ──► Caddy   │  repli- │  GeoDNS ──► Caddy   │
│  Caddy ──► Gateway  │  cation │  Caddy ──► Gateway  │
│  reads + writes     │         │  reads local        │
│  PG Primary + Redis │         │  writes ──► US-East │
│                     │         │  PG Replica + Redis │
└─────────────────────┘         └─────────────────────┘
```

**Characteristics:**

| Attribute | Value |
|---|---|
| Read latency | Low — served locally |
| Write latency | High for non-primary users (cross-region RTT) |
| Consistency | Strong for reads-after-own-writes (with session affinity) |
| Failover time | 1-5 minutes (promote replica, update DNS) |
| Complexity | Medium — unidirectional replication, write forwarding |
| Best for | Read-heavy workloads, moderate global traffic |

**OnePlatform-specific considerations:**

- The gateway service in each read-replica region must detect write
  requests (POST, PUT, PATCH, DELETE on non-read-only endpoints) and
  forward them to the primary region's gateway. This is configured in
  Caddy rather than in application code — see
  [section 5.3](#53-caddy-load-balancer-configuration-for-geo-routing).
- Replication lag means a user in EU-West who creates a connector may
  not see it in the list for up to `max_standby_streaming_delay`
  (default 30 seconds). Mitigate with session affinity: after a write,
  pin the user's reads to the primary for a short window. See
  [section 7.4](#74-cross-region-transaction-patterns).

### 2.4 Pattern Comparison

| Factor | Active-Active | Active-Passive | Read-Local-Write-Primary |
|---|---|---|---|
| Read latency | Low everywhere | Low in primary only | Low everywhere |
| Write latency | Low everywhere | Low in primary only | High in secondary |
| Consistency | Eventual | Strong | Strong (with lag) |
| Failover time | ~0 | 1-5 min | 1-5 min |
| Conflict resolution | Required | Not needed | Not needed |
| PostgreSQL setup | Logical (bidirectional) | Streaming | Streaming |
| Redis setup | Cross-region replication | Replica | Replica |
| Operational complexity | High | Low | Medium |
| Cost | 2x compute + replication | 2x compute (idle standby) | 2x compute (active reads) |
| OnePlatform fit | Advanced teams only | DR / compliance | Recommended default |

### 2.5 Decision Matrix

Answer these questions to choose a pattern:

```
1. Do you have users on multiple continents?
   No  → Single-region with HA (see HIGH-AVAILABILITY.md)
   Yes → Continue

2. Is your workload primarily reads (>80% GET)?
   Yes → Read-Local-Write-Primary
   No  → Continue

3. Can you tolerate eventual consistency and implement conflict resolution?
   Yes → Active-Active
   No  → Continue

4. Is sub-second failover required?
   Yes → Active-Active
   No  → Active-Passive or Read-Local-Write-Primary

5. Is data residency (GDPR, etc.) the primary driver?
   Yes → Tenant-affinity routing on top of any pattern (§7.3)
   No  → Read-Local-Write-Primary (simplest multi-region pattern)
```

---

## 3. Database Replication

This section extends HIGH-AVAILABILITY.md §1 (which covers intra-region
replication) to cross-region replication.

### 3.1 PostgreSQL Streaming Replication (Primary to Standby)

Streaming replication is the foundation for Active-Passive and
Read-Local-Write-Primary. The standby region runs one or more PG replicas
that stream WAL from the primary region.

**On the primary region's PostgreSQL (pg-primary-us):**

```ini
# postgresql.conf — primary region
wal_level = replica
max_wal_senders = 10
wal_keep_size = 4GB

# Synchronous replication within the region (intra-region replica).
# Cross-region replicas are ALWAYS asynchronous to avoid blocking writes
# on inter-region latency (100-300 ms RTT).
synchronous_standby_names = 'pg-replica-us-1'

# Archive WAL to object storage for PITR and to bridge transient
# cross-region network outages.
archive_mode = on
archive_command = 'pgbackrest --stanza=oneplatform archive-push %p'
```

Create a dedicated replication user for the remote region:

```sql
-- Run on pg-primary-us
CREATE ROLE replicator_eu WITH REPLICATION LOGIN PASSWORD '<strong-password>';
```

Allow the remote region in `pg_hba.conf`:

```
# pg_hba.conf — primary region
# Intra-region replicas
host  replication  replicator     10.0.0.0/16    scram-sha-256
# Cross-region replica in EU-West (VPN / VPC peering CIDR)
host  replication  replicator_eu  10.1.0.0/16    scram-sha-256
```

**On the standby region's PostgreSQL (pg-standby-eu):**

```bash
# Bootstrap from the primary over the inter-region VPN link
pg_basebackup \
  --host=pg-primary-us.vpn.internal \
  --port=5432 \
  --username=replicator_eu \
  --pgdata=/var/lib/postgresql/data \
  --wal-method=stream \
  --checkpoint=fast \
  --progress \
  --verbose

touch /var/lib/postgresql/data/standby.signal
```

```ini
# postgresql.conf — standby region
primary_conninfo = 'host=pg-primary-us.vpn.internal port=5432 user=replicator_eu password=<strong-password> application_name=pg-standby-eu'
hot_standby = on
hot_standby_feedback = on

# Accept up to 5 seconds of replication lag before canceling long-running
# read queries on the standby. This prevents stale reads from holding back
# WAL replay.
max_standby_streaming_delay = 5s

# Recovery target for PITR failover (optional — only set when restoring
# from a specific point in time)
# recovery_target_time = '2026-01-15 14:30:00 UTC'

# WAL archive for fetching any WAL segments missed during a network outage
restore_command = 'pgbackrest --stanza=oneplatform archive-get %f %p'
```

**Verify cross-region replication on the primary:**

```sql
SELECT client_addr, application_name, state, sent_lsn, write_lsn,
       flush_lsn, replay_lsn, sync_state,
       pg_wal_lsn_diff(sent_lsn, replay_lsn) AS replay_lag_bytes
FROM pg_stat_replication
WHERE application_name = 'pg-standby-eu';
```

Expected: `state = 'streaming'`, `sync_state = 'async'`, and
`replay_lag_bytes` under 10 MB during normal operation.

### 3.2 Logical Replication for Selective Table Sync

When Active-Active requires bidirectional replication, or when only specific
tables (e.g., shared ontology definitions) need to be available in both
regions, use PostgreSQL logical replication.

**On the primary (publisher):**

```sql
-- Create a publication for shared reference data
CREATE PUBLICATION oneplatform_shared FOR TABLE
  ontology_types,
  ontology_fields,
  ontology_relations,
  system_settings,
  permission_definitions
WITH (publish = 'insert, update, delete');

-- Create a publication for all tenant data (Active-Active only)
CREATE PUBLICATION oneplatform_all FOR ALL TABLES
WITH (publish = 'insert, update, delete');
```

**On the secondary (subscriber):**

```sql
-- Subscribe to shared reference data
CREATE SUBSCRIPTION oneplatform_shared_sub
  CONNECTION 'host=pg-primary-us.vpn.internal port=5432 dbname=oneplatform user=replicator_eu password=<strong-password>'
  PUBLICATION oneplatform_shared
  WITH (
    copy_data = true,
    create_slot = true,
    slot_name = 'eu_shared_sub',
    synchronous_commit = off
  );
```

**Bidirectional logical replication (Active-Active):**

Both regions are publishers and subscribers simultaneously. This requires
careful conflict avoidance:

```sql
-- Region US-East: publish all tables
CREATE PUBLICATION us_east_pub FOR ALL TABLES;

-- Region EU-West: subscribe to US-East
CREATE SUBSCRIPTION us_east_sub
  CONNECTION 'host=pg-primary-us.vpn.internal ...'
  PUBLICATION us_east_pub
  WITH (copy_data = true, origin = 'none');
  -- origin = 'none' prevents replication loops:
  -- rows replicated FROM us-east are not re-published TO us-east

-- Region EU-West: publish all tables
CREATE PUBLICATION eu_west_pub FOR ALL TABLES;

-- Region US-East: subscribe to EU-West
CREATE SUBSCRIPTION eu_west_sub
  CONNECTION 'host=pg-primary-eu.vpn.internal ...'
  PUBLICATION eu_west_pub
  WITH (copy_data = false, origin = 'none');
```

**Conflict handling:** Logical replication applies changes in commit order.
If the same row is modified in both regions before replication catches up,
the subscriber will hit a unique constraint violation or see stale data
overwritten. See [section 7](#7-data-consistency) for conflict resolution
strategies.

### 3.3 PgBouncer Configuration for Multi-Region

Each region runs its own PgBouncer instance. The configuration differs based
on the deployment pattern.

**Read-Local-Write-Primary — secondary region PgBouncer:**

```ini
; pgbouncer.ini — EU-West region (read-replica)
[databases]
; Write aliases route to the PRIMARY region over VPN
oneplatform_gateway   = host=pg-primary-us.vpn.internal port=5432 dbname=oneplatform user=gateway_service_role   pool_size=10 pool_mode=transaction
oneplatform_auth      = host=pg-primary-us.vpn.internal port=5432 dbname=oneplatform user=auth_service_role      pool_size=15 pool_mode=transaction
oneplatform_ingestion = host=pg-primary-us.vpn.internal port=5432 dbname=oneplatform user=ingestion_service_role pool_size=20 pool_mode=transaction
oneplatform_app       = host=pg-primary-us.vpn.internal port=5432 dbname=oneplatform user=app_service_role       pool_size=10 pool_mode=transaction
oneplatform_logging   = host=pg-primary-us.vpn.internal port=5432 dbname=oneplatform user=logging_service_role   pool_size=25 pool_mode=transaction
oneplatform_plugin    = host=pg-primary-us.vpn.internal port=5432 dbname=oneplatform user=plugin_service_role    pool_size=10 pool_mode=transaction
oneplatform_execution = host=pg-primary-us.vpn.internal port=5432 dbname=oneplatform user=execution_service_role pool_size=10 pool_mode=transaction
oneplatform_ontology  = host=pg-primary-us.vpn.internal port=5432 dbname=oneplatform user=ontology_service_role  pool_size=10 pool_mode=session
oneplatform_pipeline  = host=pg-primary-us.vpn.internal port=5432 dbname=oneplatform user=pipeline_service_role  pool_size=20 pool_mode=session

; Read-only aliases route to the LOCAL replica
oneplatform_gateway_ro   = host=pg-standby-eu port=5432 dbname=oneplatform user=gateway_service_role   pool_size=15 pool_mode=transaction
oneplatform_auth_ro      = host=pg-standby-eu port=5432 dbname=oneplatform user=auth_service_role      pool_size=15 pool_mode=transaction
oneplatform_ontology_ro  = host=pg-standby-eu port=5432 dbname=oneplatform user=ontology_service_role  pool_size=15 pool_mode=transaction
oneplatform_ingestion_ro = host=pg-standby-eu port=5432 dbname=oneplatform user=ingestion_service_role pool_size=20 pool_mode=transaction
oneplatform_app_ro       = host=pg-standby-eu port=5432 dbname=oneplatform user=app_service_role       pool_size=10 pool_mode=transaction
oneplatform_logging_ro   = host=pg-standby-eu port=5432 dbname=oneplatform user=logging_service_role   pool_size=20 pool_mode=transaction

[pgbouncer]
listen_port = 5433
listen_addr = 0.0.0.0
auth_type = md5
auth_file = /etc/pgbouncer/userlist.txt
; Higher max_client_conn to accommodate both local reads and remote writes
max_client_conn = 300
default_pool_size = 20
; Longer server_connect_timeout for cross-region connections
server_connect_timeout = 10
server_idle_timeout = 60
client_idle_timeout = 600
admin_users = pgbouncer_admin
stats_users = pgbouncer_stats
```

### 3.4 Failover Procedures

#### 3.4.1 Automatic Failover with Patroni (Cross-Region)

Extend the Patroni configuration from HIGH-AVAILABILITY.md §1.4 to include
cross-region nodes. The key constraint: **only nodes within the primary
region participate in leader election.** Cross-region standbys are non-voting
members that stream data but never become leader automatically.

```yaml
# /etc/patroni/patroni.yml — pg-standby-eu (cross-region standby)
scope: oneplatform-postgres
name: pg-standby-eu

etcd3:
  hosts:
    # Connect to the PRIMARY region's etcd cluster over VPN
    - etcd-us-1.vpn.internal:2379
    - etcd-us-2.vpn.internal:2379
    - etcd-us-3.vpn.internal:2379

bootstrap:
  dcs:
    ttl: 30
    loop_wait: 10
    retry_timeout: 10
    maximum_lag_on_failover: 10485760

postgresql:
  listen: 0.0.0.0:5432
  connect_address: pg-standby-eu.vpn.internal:5432
  data_dir: /var/lib/postgresql/data
  parameters:
    hot_standby: on

tags:
  # nofailover prevents this node from being promoted automatically.
  # Cross-region promotion is a manual decision to avoid split-brain
  # when the VPN link goes down.
  nofailover: true
  # noloadbalance excludes this node from read-replica load balancing
  # within the primary region's HAProxy/PgBouncer. It serves reads only
  # for the EU-West region.
  noloadbalance: true
  # clonefrom allows other standbys to clone from this node instead of
  # crossing the WAN to the primary.
  clonefrom: true
```

#### 3.4.2 Manual Cross-Region Failover

When the primary region is completely unavailable:

```bash
# Step 1: Verify the primary is truly down (not a network partition)
patronictl -c /etc/patroni/patroni.yml list
# If the leader shows "unknown" for > 60 seconds, proceed

# Step 2: Remove the nofailover tag from the EU standby
patronictl -c /etc/patroni/patroni.yml edit-config \
  --set 'tags.nofailover=false' pg-standby-eu

# Step 3: Promote the EU standby to primary
patronictl -c /etc/patroni/patroni.yml failover \
  --candidate pg-standby-eu \
  --force

# Step 4: Verify promotion
psql -h pg-standby-eu -U postgres -c "SELECT pg_is_in_recovery();"
# Expected: f (false — this node is now the primary)

# Step 5: Update DNS to point to the EU region
# (See section 6 for DNS procedures)

# Step 6: Update PgBouncer in the EU region to point writes to local PG
sed -i 's/host=pg-primary-us.vpn.internal/host=pg-standby-eu/' \
  /etc/pgbouncer/pgbouncer.ini
psql -h 127.0.0.1 -p 5433 -U pgbouncer_admin pgbouncer -c "RELOAD;"
```

#### 3.4.3 Split-Brain Prevention

Split-brain occurs when both regions believe they are the primary. Prevention
strategies, in order of priority:

1. **Single etcd cluster in the primary region.** Patroni uses this cluster
   for leader election. If the cross-region network fails, the EU standby
   loses contact with etcd and cannot promote itself (because `nofailover`
   is set and etcd is unreachable).

2. **Fencing via cloud API.** Before promoting a new primary, the failover
   script powers off or network-isolates the old primary's compute instances
   using the cloud provider's API:

   ```bash
   # AWS example: stop the old primary's instance
   aws ec2 stop-instances --instance-ids i-0abc123def456 --region us-east-1

   # GCP example: stop the old primary
   gcloud compute instances stop pg-primary-us --zone us-east1-b
   ```

3. **PostgreSQL timeline divergence.** After promotion, the new primary
   advances to a new WAL timeline. Even if the old primary comes back online,
   it cannot accept writes on the old timeline — it must be re-basebackuped
   from the new primary before rejoining.

4. **Application-level write lock.** The gateway service checks a
   `region_write_lock` key in Redis before accepting write requests. During
   failover, set this key in the old region (if reachable) to block any
   stale writes:

   ```bash
   redis-cli -h redis-us --user op_admin -a "$PASS" \
     SET region_write_lock "locked" EX 3600
   ```

---

## 4. Redis Replication

### 4.1 Redis Sentinel for HA Within a Region

Each region runs a Redis Sentinel cluster for automatic failover of the
local Redis master. This is the intra-region baseline described in
HIGH-AVAILABILITY.md; it is a prerequisite for multi-region.

```
Region US-East:
  redis-us-master  ◄──  redis-us-replica-1
                   ◄──  redis-us-replica-2
  sentinel-us-1, sentinel-us-2, sentinel-us-3

Region EU-West:
  redis-eu-master  ◄──  redis-eu-replica-1
                   ◄──  redis-eu-replica-2
  sentinel-eu-1, sentinel-eu-2, sentinel-eu-3
```

Sentinel configuration (same in both regions, adjusted for hostnames):

```conf
# sentinel.conf — region US-East
port 26379
sentinel monitor oneplatform-redis redis-us-master 6379 2
sentinel down-after-milliseconds oneplatform-redis 5000
sentinel failover-timeout oneplatform-redis 30000
sentinel parallel-syncs oneplatform-redis 1
sentinel auth-pass oneplatform-redis <redis-admin-password>
```

### 4.2 Redis Cross-Region Replication

Redis does not natively support bidirectional replication. Options for
cross-region data availability:

**Option A: Independent Redis per region (recommended for most patterns)**

Each region has its own Redis instance. Data is not replicated between
regions. This works for:
- Rate-limit counters (region-local is correct — each region enforces its
  own limits)
- BullMQ job queues (jobs execute in the region where they were created)
- Auth session tokens (if using session affinity; otherwise, use
  PostgreSQL-backed sessions)

**Option B: Redis replication via REPLICAOF (Active-Passive only)**

The standby region's Redis is a read replica of the primary's Redis:

```conf
# redis.conf — EU-West (standby region)
replicaof redis-us-master.vpn.internal 6379
masterauth <redis-admin-password>
masteruser op_admin
```

On failover, promote the EU Redis to master:

```bash
redis-cli -h redis-eu-master --user op_admin -a "$PASS" REPLICAOF NO ONE
```

**Option C: Application-level cache sync (Active-Active)**

For Active-Active, replicate only the keys that need global visibility.
Use a lightweight sync daemon that subscribes to Redis keyspace
notifications in one region and writes to the other:

```bash
# Conceptual — implemented as a small Node.js sidecar
# Region US subscriber
redis-cli -h redis-us-master --user op_admin -a "$PASS" \
  --subscribe '__keyevent@0__:set'
# For each received key, read the value and SET it in EU
```

In practice, OnePlatform's cache keys are either:
- **Region-local** (rate limits, BullMQ jobs, ephemeral session data) —
  no sync needed
- **Globally consistent** (auth tokens, tenant settings) — store in
  PostgreSQL, not Redis

This means **Option A (independent Redis per region)** is sufficient for
all three deployment patterns.

### 4.3 BullMQ Job Queue Considerations

OnePlatform uses BullMQ for background job processing in the pipeline,
ingestion, and execution services. Multi-region job queues require careful
design.

**Region-local queues (recommended):**

Each region has its own BullMQ queues in its local Redis. Jobs created in
a region are processed in that region.

```
Region US-East:
  redis-us → bull:pipeline:* → pipeline-service-us
  redis-us → bull:ingestion:* → ingestion-service-us

Region EU-West:
  redis-eu → bull:pipeline:* → pipeline-service-eu
  redis-eu → bull:ingestion:* → ingestion-service-eu
```

**When a user in EU-West creates a pipeline run (write operation):**

- In Read-Local-Write-Primary: the write goes to US-East. The pipeline
  job is created in US-East's Redis and processed by US-East's pipeline
  service. The result replicates back to EU-West via PG streaming.
- In Active-Active: the write stays in EU-West. The pipeline job is
  created in EU-West's Redis and processed locally. Results replicate
  bidirectionally via logical replication.

**Global job queues (advanced — only for Active-Active):**

If a job must be processed by a specific region (e.g., a connector that
talks to an EU-only API), use a job routing header:

```typescript
// pipeline-service — job creation
await pipelineQueue.add('run-pipeline', {
  pipelineId: '...',
  tenantId: '...',
  targetRegion: 'eu-west',  // routing hint
}, {
  // Jobs stay in the local queue. A cross-region dispatcher
  // moves jobs to the target region if needed.
});
```

The cross-region dispatcher is a sidecar process that polls the local
queue for jobs with a `targetRegion` different from the current region,
removes them, and re-enqueues them in the target region's Redis over VPN.

### 4.4 Cache Invalidation Across Regions

OnePlatform uses Redis for caching ontology definitions, permission checks,
and rate-limit counters. Cache invalidation strategies per cache type:

| Cache | Key pattern | Strategy | Reason |
|---|---|---|---|
| Ontology | `ontology:<tenantId>:*` | TTL-based (60s) | Ontology changes are infrequent; 60s staleness is acceptable |
| Permissions | `perm:<tenantId>:<userId>:*` | TTL-based (30s) | Permission changes are administrative and infrequent |
| Rate limits | `ratelimit:<tenantId>:*` | Region-local only | Each region enforces its own rate limits independently |
| Auth tokens | `auth:token:<jti>` | Not cached in Redis | Tokens are validated against PostgreSQL or JWT signature |
| Session | `session:<sessionId>` | DB-backed + short TTL | Sessions stored in PG, cached locally for 60s |

**Cross-region invalidation for ontology changes:**

When the ontology service updates a type definition, it publishes a Redis
`PUBLISH` message on channel `ontology:invalidate`:

```typescript
// ontology-service — after updating a type
await redis.publish('ontology:invalidate', JSON.stringify({
  tenantId,
  typeId,
  timestamp: Date.now(),
}));
```

The cross-region invalidation sidecar subscribes to this channel and
forwards the message to the other region's Redis:

```typescript
// cross-region-invalidation sidecar
const localRedis = new Redis(LOCAL_REDIS_URL);
const remoteRedis = new Redis(REMOTE_REDIS_URL);

localRedis.subscribe('ontology:invalidate');
localRedis.on('message', (channel, message) => {
  // Publish to the remote region's Redis
  remoteRedis.publish(channel, message);
});
```

Services in the remote region listen on the same channel and clear their
local cache entries.

---

## 5. Service Configuration

### 5.1 Per-Region Environment Variables

Each region's `.env` file contains region-specific values. Variables common
to all regions are in a shared base.

**Base `.env` (shared across regions):**

```bash
# .env.base — shared configuration
OP_BASE_URL=https://platform.example.com
OP_ALLOWED_ORIGINS=https://platform.example.com
OP_GLOBAL_RATE_LIMIT=10000
OP_INGESTION_BATCH_SIZE=1000
OP_LARGE_SYNC_CONCURRENCY=3
OP_REQUIRE_EMAIL_VERIFICATION=true
OP_SMTP_HOST=smtp.sendgrid.net
OP_SMTP_PORT=587
OP_SMTP_FROM=noreply@example.com
```

**Region-specific `.env.us-east`:**

```bash
# .env.us-east — US-East region overrides
source .env.base

# Region identity
OP_REGION=us-east
OP_REGION_ROLE=primary              # primary | standby | read-replica

# Database — primary region connects to local PG
OP_DATABASE_HOST=pg-primary-us
OP_DATABASE_HOST_RO=pg-replica-us-1

# Redis — local instance
OP_REDIS_HOST=redis-us-master
OP_REDIS_SENTINEL_HOSTS=sentinel-us-1:26379,sentinel-us-2:26379,sentinel-us-3:26379

# Caddy
OP_DOMAIN=platform.example.com
OP_TLS_EMAIL=ops@example.com

# Inter-region VPN
OP_PEER_REGIONS=eu-west
OP_PEER_EU_WEST_GATEWAY=https://eu-west.internal.example.com:3000
```

**Region-specific `.env.eu-west`:**

```bash
# .env.eu-west — EU-West region overrides
source .env.base

# Region identity
OP_REGION=eu-west
OP_REGION_ROLE=read-replica

# Database — read-replica region
# Writes go through PgBouncer which routes to the primary over VPN
OP_DATABASE_HOST=pg-standby-eu
OP_DATABASE_HOST_RO=pg-standby-eu

# Redis — local instance (independent, not a replica)
OP_REDIS_HOST=redis-eu-master
OP_REDIS_SENTINEL_HOSTS=sentinel-eu-1:26379,sentinel-eu-2:26379,sentinel-eu-3:26379

# Caddy
OP_DOMAIN=eu.platform.example.com
OP_TLS_EMAIL=ops@example.com

# Inter-region
OP_PEER_REGIONS=us-east
OP_PEER_US_EAST_GATEWAY=https://us-east.internal.example.com:3000
OP_PRIMARY_GATEWAY_URL=https://us-east.internal.example.com:3000
```

### 5.2 Service Discovery Across Regions

OnePlatform services discover each other via environment variables
(`ONTOLOGY_SERVICE_URL`, `AUTH_SERVICE_URL`, etc.) that point to
Docker Compose service names or Kubernetes service DNS.

**Within a region:** No change. Services use the same `http://<service>:3000`
URLs as single-region.

**Cross-region (for write forwarding):** The gateway service in a
read-replica region needs the primary region's gateway URL. This is
configured via `OP_PRIMARY_GATEWAY_URL`.

**DNS-based discovery (Kubernetes):**

Use ExternalName services or headless services with endpoint slices to
expose the primary region's gateway in the secondary region's cluster:

```yaml
# k8s/externalname-primary-gateway.yaml — deployed in EU-West cluster
apiVersion: v1
kind: Service
metadata:
  name: primary-gateway
  namespace: oneplatform
spec:
  type: ExternalName
  externalName: gateway.oneplatform.us-east.svc.cluster.local
  # Requires cross-cluster DNS resolution (e.g., via Istio multicluster
  # or Cilium cluster mesh)
```

**Service mesh (advanced):**

For Istio multicluster or Linkerd multicluster, configure a
`ServiceEntry` or `mirror` policy so that write requests are transparently
routed to the primary cluster:

```yaml
# istio/serviceentry-primary-gateway.yaml — EU-West cluster
apiVersion: networking.istio.io/v1
kind: ServiceEntry
metadata:
  name: primary-gateway
  namespace: oneplatform
spec:
  hosts:
    - gateway.oneplatform.us-east.global
  location: MESH_EXTERNAL
  ports:
    - number: 3000
      name: http
      protocol: HTTP
  resolution: DNS
  endpoints:
    - address: 10.1.0.50  # VPN IP of US-East gateway LB
      ports:
        http: 3000
```

### 5.3 Caddy Load Balancer Configuration for Geo-Routing

Caddy runs in each region as the TLS-terminating reverse proxy. The
configuration differs based on region role.

**Primary region Caddyfile (US-East):**

```caddyfile
# Caddyfile — US-East (primary)
{
    admin off
    email {$OP_TLS_EMAIL}
    log {
        output stdout
        format json
    }
}

{$OP_DOMAIN} {
    header {
        Strict-Transport-Security  "max-age=31536000; includeSubDomains; preload"
        X-Content-Type-Options     "nosniff"
        X-Frame-Options            "DENY"
        Referrer-Policy            "strict-origin-when-cross-origin"
        Permissions-Policy         "camera=(), microphone=(), geolocation=()"
        -Server
        # Region header for debugging
        X-OP-Region "us-east"
    }

    handle /api/* {
        reverse_proxy gateway-service:3000 {
            header_up X-Forwarded-Proto {scheme}
            header_up X-Real-IP {remote_host}
            header_up X-OP-Region "us-east"
            flush_interval -1
            # Health check — remove unhealthy upstreams
            health_uri /healthz
            health_interval 10s
            health_timeout 5s
        }
    }

    handle {
        reverse_proxy frontend:80 {
            header_up X-Forwarded-Proto {scheme}
            header_up X-Real-IP {remote_host}
        }
    }
}
```

**Read-replica region Caddyfile (EU-West):**

```caddyfile
# Caddyfile — EU-West (read-replica)
# Reads are served locally; writes are forwarded to the primary region.
{
    admin off
    email {$OP_TLS_EMAIL}
    log {
        output stdout
        format json
    }
}

{$OP_DOMAIN} {
    header {
        Strict-Transport-Security  "max-age=31536000; includeSubDomains; preload"
        X-Content-Type-Options     "nosniff"
        X-Frame-Options            "DENY"
        Referrer-Policy            "strict-origin-when-cross-origin"
        Permissions-Policy         "camera=(), microphone=(), geolocation=()"
        -Server
        X-OP-Region "eu-west"
    }

    # Write requests → forward to primary region
    @write_methods {
        method POST PUT PATCH DELETE
        path /api/*
    }

    # Exempt health and status endpoints from write forwarding
    @local_writes {
        method POST
        path /api/v1/auth/login
        path /api/v1/auth/token/refresh
        path /api/v1/auth/logout
    }

    handle @local_writes {
        reverse_proxy gateway-service:3000 {
            header_up X-Forwarded-Proto {scheme}
            header_up X-Real-IP {remote_host}
            header_up X-OP-Region "eu-west"
            flush_interval -1
        }
    }

    handle @write_methods {
        reverse_proxy {$OP_PRIMARY_GATEWAY_URL} {
            header_up X-Forwarded-Proto {scheme}
            header_up X-Real-IP {remote_host}
            header_up X-OP-Region "eu-west"
            header_up X-Forwarded-Region "eu-west"
            flush_interval -1

            # Cross-region timeout: allow extra time for VPN latency
            transport http {
                dial_timeout 10s
                response_header_timeout 30s
                tls_insecure_skip_verify  # Only if using internal TLS with self-signed certs
            }

            # Circuit breaker: if primary is unreachable, return 503
            # instead of hanging
            fail_duration 30s
            max_fails 3
            unhealthy_status 502 503 504
        }
    }

    # Read requests → serve locally
    handle /api/* {
        reverse_proxy gateway-service:3000 {
            header_up X-Forwarded-Proto {scheme}
            header_up X-Real-IP {remote_host}
            header_up X-OP-Region "eu-west"
            flush_interval -1
            health_uri /healthz
            health_interval 10s
            health_timeout 5s
        }
    }

    handle {
        reverse_proxy frontend:80 {
            header_up X-Forwarded-Proto {scheme}
            header_up X-Real-IP {remote_host}
        }
    }
}
```

### 5.4 Health Check and Circuit Breaker Settings

Each service exposes a `/healthz` endpoint. In multi-region, health checks
serve double duty: local load balancing and cross-region liveness detection.

**Per-service health check configuration:**

| Service | Interval | Timeout | Unhealthy after | Recovery after |
|---|---|---|---|---|
| gateway | 10s | 5s | 3 failures | 2 successes |
| auth | 10s | 5s | 3 failures | 2 successes |
| ingestion | 15s | 10s | 3 failures | 2 successes |
| ontology | 10s | 5s | 3 failures | 2 successes |
| pipeline | 15s | 10s | 3 failures | 2 successes |
| execution | 15s | 10s | 3 failures | 2 successes |
| app | 10s | 5s | 3 failures | 2 successes |
| logging | 10s | 5s | 3 failures | 2 successes |
| plugin | 10s | 5s | 3 failures | 2 successes |

**Cross-region circuit breaker (in the read-replica Caddy):**

When the primary region's gateway is unreachable:

1. After `max_fails` (3) consecutive failures within `fail_duration` (30s),
   Caddy marks the primary upstream as unhealthy.
2. Write requests return HTTP 503 with a `Retry-After: 30` header.
3. Caddy retries the health check every 10 seconds.
4. After 2 consecutive successes, the upstream is marked healthy and write
   forwarding resumes.

The frontend should detect 503 responses on write operations and display a
"Write operations temporarily unavailable — please retry" banner rather
than a hard error.

---

## 6. Network and DNS

### 6.1 GeoDNS / Latency-Based Routing

Use DNS to route users to the nearest region. Two approaches:

**Route53 latency-based routing (AWS):**

```
; Route53 record sets
platform.example.com.  A  ALIAS  us-east-lb.elb.amazonaws.com   [latency: us-east-1]
platform.example.com.  A  ALIAS  eu-west-lb.elb.amazonaws.com   [latency: eu-west-1]

; Health checks
us-east-health  →  https://platform.example.com/healthz  (evaluated from us-east-1)
eu-west-health  →  https://eu.platform.example.com/healthz  (evaluated from eu-west-1)
```

When both regions are healthy, users receive the IP of the nearest region.
When a region's health check fails, Route53 automatically routes all traffic
to the surviving region.

**Cloudflare GeoDNS (multi-cloud):**

```json
{
  "type": "A",
  "name": "platform.example.com",
  "content": "203.0.113.10",
  "proxied": true,
  "data": {
    "geo": {
      "NA": "203.0.113.10",
      "EU": "198.51.100.20",
      "default": "203.0.113.10"
    }
  }
}
```

Cloudflare Load Balancing with geo-steering provides automatic failover,
health checks, and geographic traffic distribution without managing DNS
records manually.

**TTL recommendations:**

| Record | TTL | Reason |
|---|---|---|
| A/AAAA for regions | 60s | Fast failover on region outage |
| CNAME for services | 300s | Stable within a region |
| MX/TXT | 3600s | Rarely changes |

### 6.2 Inter-Region Networking

**Option A: VPN (WireGuard)**

The simplest inter-region link. Each region runs a WireGuard peer.

```ini
# /etc/wireguard/wg0.conf — US-East region
[Interface]
Address = 10.0.0.1/24
ListenPort = 51820
PrivateKey = <us-east-private-key>

[Peer]
# EU-West
PublicKey = <eu-west-public-key>
AllowedIPs = 10.1.0.0/24
Endpoint = eu-west.public.example.com:51820
PersistentKeepalive = 25
```

```ini
# /etc/wireguard/wg0.conf — EU-West region
[Interface]
Address = 10.1.0.1/24
ListenPort = 51820
PrivateKey = <eu-west-private-key>

[Peer]
# US-East
PublicKey = <us-east-public-key>
AllowedIPs = 10.0.0.0/24
Endpoint = us-east.public.example.com:51820
PersistentKeepalive = 25
```

**Option B: VPC Peering (single cloud provider)**

For AWS:

```bash
# Create peering connection
aws ec2 create-vpc-peering-connection \
  --vpc-id vpc-us-east-123 \
  --peer-vpc-id vpc-eu-west-456 \
  --peer-region eu-west-1

# Accept in the peer region
aws ec2 accept-vpc-peering-connection \
  --vpc-peering-connection-id pcx-abc123 \
  --region eu-west-1

# Add routes in both VPCs
aws ec2 create-route \
  --route-table-id rtb-us-east \
  --destination-cidr-block 10.1.0.0/16 \
  --vpc-peering-connection-id pcx-abc123

aws ec2 create-route \
  --route-table-id rtb-eu-west \
  --destination-cidr-block 10.0.0.0/16 \
  --vpc-peering-connection-id pcx-abc123 \
  --region eu-west-1
```

**Option C: Transit Gateway (AWS, 3+ regions)**

For deployments with three or more regions, a Transit Gateway hub-and-spoke
topology avoids O(n^2) peering connections:

```
                  ┌───────────────┐
    US-East ──────│ Transit GW    │────── EU-West
                  │ (us-east-1)   │
    AP-SE ────────│               │
                  └───────────────┘
```

### 6.3 TLS Certificate Management

Each region needs valid TLS certificates for its public-facing domain.

**Scenario A: Single domain, multiple regions**

All regions serve `platform.example.com`. Caddy's ACME HTTP-01 challenge
works if each region's Caddy can receive HTTP traffic on port 80. With
GeoDNS, the ACME server may hit either region — both must be able to
complete the challenge.

Recommendation: Use DNS-01 challenge with a shared DNS provider API key:

```caddyfile
{
    admin off
    email {$OP_TLS_EMAIL}
    acme_dns cloudflare {$CF_API_TOKEN}
}
```

**Scenario B: Per-region subdomains**

Each region has its own subdomain (`us.platform.example.com`,
`eu.platform.example.com`). Standard HTTP-01 ACME works independently
in each region.

**Scenario C: Wildcard certificate**

Issue a wildcard certificate for `*.platform.example.com` using DNS-01
challenge. All regions share the same certificate stored in a secrets
manager (AWS Secrets Manager, HashiCorp Vault):

```bash
# Generate wildcard cert with certbot
certbot certonly \
  --dns-cloudflare \
  --dns-cloudflare-credentials /etc/letsencrypt/cloudflare.ini \
  -d "*.platform.example.com" \
  -d "platform.example.com"
```

### 6.4 Latency Budgets and Timeout Tuning

Cross-region adds 50-300 ms of RTT depending on geography. Budget
accordingly:

```
Intra-region request path:
  Client → Caddy → Gateway → Service → PG/Redis → Response
  Budget: 200 ms p95

Cross-region write (Read-Local-Write-Primary):
  Client → Caddy-EU → Gateway-US (VPN) → Service-US → PG-US → Response
  Budget: 500 ms p95

Cross-region replication (async):
  PG-US WAL → VPN → PG-EU replay
  Budget: < 5 seconds p99 lag
```

**Timeout settings per component:**

| Component | Setting | Intra-region | Cross-region |
|---|---|---|---|
| Caddy upstream | `dial_timeout` | 5s | 10s |
| Caddy upstream | `response_header_timeout` | 15s | 30s |
| Gateway → service | `fetch timeout` | 10s | 25s |
| PgBouncer | `server_connect_timeout` | 5s | 15s |
| PgBouncer | `query_timeout` | 30s | 60s |
| Redis client | `connectTimeout` | 2s | 5s |
| Redis client | `commandTimeout` | 5s | 10s |
| BullMQ job | `stalledInterval` | 30s | 60s |
| BullMQ job | `lockDuration` | 30s | 60s |

---

## 7. Data Consistency

### 7.1 Eventual Consistency Model

In Read-Local-Write-Primary and Active-Passive, the secondary region sees
data that is slightly behind the primary. The staleness window equals the
PostgreSQL streaming replication lag (typically < 1 second, but up to
`max_standby_streaming_delay` under load).

**What this means for OnePlatform users:**

| Operation | Staleness impact | Mitigation |
|---|---|---|
| View connector list | May not show connector created < 1s ago | Acceptable — UI polls every 5s |
| View pipeline run status | May show "running" for an already-completed run | Acceptable — status refreshes automatically |
| View ontology types | May not show a just-created type | Cache TTL (60s) already applies |
| Login after password change | New password may not be visible on replica | Route auth writes + reads to primary |
| View audit logs | Logs may appear with 1-5s delay | Acceptable for audit use cases |

### 7.2 Conflict Resolution Strategies

Only relevant for Active-Active. When the same row is modified in two
regions before replication delivers the changes, a conflict occurs.

**Strategy 1: Last-Writer-Wins (LWW) with logical timestamps**

Add an `updated_at_clock` column (hybrid logical clock) to every table:

```sql
ALTER TABLE connectors ADD COLUMN updated_at_clock BIGINT DEFAULT 0;
ALTER TABLE pipelines ADD COLUMN updated_at_clock BIGINT DEFAULT 0;
ALTER TABLE apps ADD COLUMN updated_at_clock BIGINT DEFAULT 0;
```

Each write increments the clock:

```sql
UPDATE connectors
SET name = 'new-name',
    updated_at_clock = GREATEST(updated_at_clock, :incoming_clock) + 1,
    updated_at = NOW()
WHERE id = :id
  AND updated_at_clock < :incoming_clock;
-- If the WHERE clause eliminates the row, the incoming change is stale
-- and is silently dropped (last-writer-wins).
```

**Strategy 2: CRDTs for specific data structures**

Some OnePlatform data structures are natural fits for CRDTs:

| Data | CRDT type | Behavior |
|---|---|---|
| Connector tags | G-Set (grow-only set) | Tags added in either region merge without conflict |
| Pipeline enabled/disabled | LWW-Register | Last toggle wins |
| App permissions | OR-Set (observed-remove set) | Permissions added/removed merge correctly |
| Audit logs | G-Counter per region + merge | Append-only, no conflicts possible |

**Strategy 3: Region-affinity (conflict avoidance)**

Assign each tenant to a home region. All writes for that tenant go to the
home region. Other regions serve reads from replicated data. This eliminates
conflicts entirely while preserving read locality. See
[section 7.3](#73-tenant-affinity-routing).

### 7.3 Tenant-Affinity Routing

Assign each tenant a `home_region` in the tenant record:

```sql
ALTER TABLE tenants ADD COLUMN home_region VARCHAR(32) NOT NULL DEFAULT 'us-east';
```

The gateway service reads `home_region` from the tenant context (already
available via the `X-User-Context` header after authentication) and routes
write requests accordingly:

```typescript
// gateway-service — tenant-affinity routing middleware
import { Context, Next } from 'hono';

export async function tenantAffinityMiddleware(c: Context, next: Next) {
  const tenantId = c.get('tenantId');
  const currentRegion = process.env.OP_REGION;

  // Read-only requests are always served locally
  if (['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    return next();
  }

  // Look up tenant's home region (cached for 60s)
  const homeRegion = await getTenantHomeRegion(tenantId);

  if (homeRegion === currentRegion) {
    // Tenant is in their home region — process locally
    return next();
  }

  // Forward the write to the tenant's home region
  const peerGatewayUrl = process.env[`OP_PEER_${homeRegion.toUpperCase().replace('-', '_')}_GATEWAY`];
  if (!peerGatewayUrl) {
    // No peer configured — fall back to local processing
    return next();
  }

  const response = await fetch(`${peerGatewayUrl}${c.req.path}`, {
    method: c.req.method,
    headers: c.req.raw.headers,
    body: c.req.raw.body,
  });

  return new Response(response.body, {
    status: response.status,
    headers: response.headers,
  });
}
```

**Sticky sessions after writes:**

After a write operation, set a short-lived cookie that pins subsequent
reads to the primary region. This ensures the user sees their own writes
immediately:

```typescript
// gateway-service — after a successful write
c.header('Set-Cookie',
  `op_read_primary=1; Path=/; Max-Age=10; Secure; HttpOnly; SameSite=Strict`
);
```

The Caddy configuration in the read-replica region checks for this cookie
and forwards reads to the primary when present:

```caddyfile
@read_primary_cookie {
    header_regexp Cookie op_read_primary=1
    method GET HEAD
    path /api/*
}

handle @read_primary_cookie {
    reverse_proxy {$OP_PRIMARY_GATEWAY_URL} {
        header_up X-Forwarded-Proto {scheme}
        header_up X-Real-IP {remote_host}
        transport http {
            dial_timeout 10s
        }
    }
}
```

### 7.4 Cross-Region Transaction Patterns

OnePlatform does not use distributed transactions (2PC) across regions.
The latency cost (2+ RTTs per transaction) and complexity (distributed
lock manager) are prohibitive. Instead, use saga-based patterns.

**Pipeline execution saga (cross-region):**

When a pipeline run involves connectors in different regions:

```
1. pipeline-service (home region) creates PipelineRun record
2. For each step:
   a. If connector's data source is in the local region → execute locally
   b. If connector's data source is in another region → POST to that
      region's execution-service with a callback URL
   c. Remote execution-service processes the step and POSTs results
      back to the callback URL
3. pipeline-service aggregates results and updates PipelineRun status
4. If any step fails:
   a. Execute compensating actions for completed steps
   b. Mark PipelineRun as "failed" with details of which steps succeeded
```

**Eventual consistency guarantee:**

OnePlatform guarantees that after all replication catches up, every region
sees the same data. The maximum window for divergence is bounded by:

```
max_divergence = max(pg_replication_lag, redis_cache_ttl)
```

Under normal conditions: < 5 seconds for PG replication + 60 seconds for
cache TTL = **65 seconds maximum** before all regions converge.

---

## 8. Operational Procedures

### 8.1 Region Failover Runbook

**Prerequisites:**
- [ ] VPN/peering link between regions is active
- [ ] Standby PG is streaming and lag < 10 MB
- [ ] Standby Redis is running (independent or replica)
- [ ] DNS TTL is set to 60s for the platform domain
- [ ] Monitoring dashboards show both regions

**Step-by-step failover (primary region US-East is down):**

```
Phase 1: Detect and confirm (0-2 minutes)
──────────────────────────────────────────
1. Alertmanager fires "region_us_east_down" alert (3 consecutive health
   check failures over 30 seconds).
2. On-call engineer verifies:
   - Check cloud provider status page
   - Attempt SSH to US-East bastion
   - Check cross-region VPN link status
3. Decision: if US-East is confirmed unreachable for > 2 minutes, proceed
   with failover.

Phase 2: Fence the old primary (2-3 minutes)
─────────────────────────────────────────────
4. If cloud API is reachable, stop the old primary's PG instance:
   $ aws ec2 stop-instances --instance-ids <pg-primary-us-instance>
5. Set the write lock in US-East Redis (if reachable):
   $ redis-cli -h redis-us-master SET region_write_lock "locked" EX 3600

Phase 3: Promote the standby (3-5 minutes)
──────────────────────────────────────────
6. Promote PostgreSQL in EU-West:
   $ patronictl -c /etc/patroni/patroni.yml failover \
       --candidate pg-standby-eu --force
   OR (if not using Patroni):
   $ psql -h pg-standby-eu -U postgres \
       -c "SELECT pg_promote(true, 60);"
7. Verify promotion:
   $ psql -h pg-standby-eu -U postgres \
       -c "SELECT pg_is_in_recovery();"
   # Expected: f
8. Update PgBouncer in EU-West to point writes to local PG:
   $ sed -i 's/host=pg-primary-us.vpn.internal/host=pg-standby-eu/' \
       /etc/pgbouncer/pgbouncer.ini
   $ psql -h 127.0.0.1 -p 5433 -U pgbouncer_admin pgbouncer \
       -c "RELOAD;"
9. If using Redis replication, promote EU Redis:
   $ redis-cli -h redis-eu-master REPLICAOF NO ONE

Phase 4: DNS cutover (5-7 minutes)
──────────────────────────────────
10. Update DNS to point all traffic to EU-West:
    # Route53
    $ aws route53 change-resource-record-sets \
        --hosted-zone-id Z123ABC \
        --change-batch '{
          "Changes": [{
            "Action": "UPSERT",
            "ResourceRecordSet": {
              "Name": "platform.example.com",
              "Type": "A",
              "AliasTarget": {
                "DNSName": "eu-west-lb.elb.amazonaws.com",
                "HostedZoneId": "Z456DEF",
                "EvaluateTargetHealth": true
              }
            }
          }]
        }'
    # OR Cloudflare
    $ curl -X PATCH "https://api.cloudflare.com/client/v4/zones/<zone>/dns_records/<record>" \
        -H "Authorization: Bearer <token>" \
        -d '{"content": "198.51.100.20"}'
11. Wait for DNS propagation (60-300 seconds depending on TTL).

Phase 5: Verify and communicate (7-10 minutes)
───────────────────────────────────────────────
12. Verify all 9 services are healthy in EU-West:
    $ for svc in gateway auth ingestion ontology pipeline execution app logging plugin; do
        curl -sf "http://${svc}-service:3000/healthz" && echo "${svc}: OK" || echo "${svc}: FAIL"
      done
13. Verify write operations work:
    $ curl -X POST "https://platform.example.com/api/v1/healthz/write-test"
14. Update status page: "Platform operating in degraded mode from EU-West.
    Some operations may have higher latency."
15. Notify team in Slack/PagerDuty: failover complete.
```

**Total estimated failover time: 5-10 minutes** (dominated by DNS
propagation). With pre-warmed standby services and 60s DNS TTL, the
user-visible outage is 2-5 minutes.

### 8.2 Region Addition Checklist

Adding a new region (e.g., AP-Southeast) to an existing multi-region
deployment:

```
Infrastructure provisioning:
  [ ] Provision compute instances (see CAPACITY-PLANNING.md for sizing)
  [ ] Provision managed PostgreSQL replica OR self-hosted PG standby
  [ ] Provision Redis instance
  [ ] Provision object storage (MinIO or S3-compatible)
  [ ] Set up VPN/peering to existing regions

Database setup:
  [ ] Create replication user on primary for the new region
  [ ] Add pg_hba.conf entry on primary for new region's CIDR
  [ ] Run pg_basebackup from primary to new region
  [ ] Verify streaming replication is active (pg_stat_replication)
  [ ] Configure PgBouncer in new region (write aliases → primary, read → local)

Redis setup:
  [ ] Deploy Redis with Sentinel in new region
  [ ] Configure ACL users matching existing regions
  [ ] (If needed) Set up cross-region invalidation sidecar

Service deployment:
  [ ] Deploy all 9 services with region-specific .env
  [ ] Deploy Caddy with region-appropriate Caddyfile
  [ ] Deploy frontend with matching configuration
  [ ] Run op-init for secret generation (or replicate secrets from primary)
  [ ] Verify all service health checks pass

DNS and networking:
  [ ] Add GeoDNS record for new region
  [ ] Set health check for new region in DNS provider
  [ ] Verify latency from target geography is within budget

Testing:
  [ ] Verify read operations return correct data
  [ ] Verify write forwarding to primary works
  [ ] Verify replication lag is within bounds
  [ ] Run integration test suite against new region endpoint
  [ ] Test failover TO new region
  [ ] Test failover FROM new region

Monitoring:
  [ ] Add new region to Grafana dashboards
  [ ] Configure Alertmanager rules for new region
  [ ] Add new region to replication lag alerts
  [ ] Verify cross-region latency monitoring is active
```

### 8.3 Monitoring and Alerting Per Region

**Grafana dashboard panels per region:**

```
Row 1: Region Overview
  - Region status (UP/DOWN) — big number panel
  - Active connections per service — gauge
  - Requests per second — graph
  - Error rate (5xx) — graph

Row 2: Database
  - PG replication lag (bytes and seconds) — graph
  - PG connections (active/idle/waiting) — stacked bar
  - PG query latency p50/p95/p99 — graph
  - WAL generation rate — graph

Row 3: Redis
  - Redis memory usage — gauge
  - Redis command rate — graph
  - BullMQ queue depth per queue — graph
  - BullMQ job completion rate — graph

Row 4: Cross-Region
  - VPN link latency — graph
  - VPN throughput — graph
  - Cross-region write forwarding latency — graph
  - DNS resolution time — graph
```

**Alertmanager rules:**

```yaml
# alerts/multi-region.yml
groups:
  - name: multi-region
    rules:
      # Replication lag exceeds 30 seconds
      - alert: PGReplicationLagHigh
        expr: pg_replication_lag_seconds > 30
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "PG replication lag is {{ $value }}s in {{ $labels.region }}"
          runbook: "docs/MULTI-REGION-DEPLOYMENT.md#81-region-failover-runbook"

      # Replication lag exceeds 5 minutes — risk of data loss on failover
      - alert: PGReplicationLagCritical
        expr: pg_replication_lag_seconds > 300
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "PG replication lag is {{ $value }}s — failover will lose data"

      # Cross-region VPN latency spike
      - alert: CrossRegionLatencyHigh
        expr: probe_duration_seconds{job="cross_region_vpn"} > 0.3
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Cross-region latency is {{ $value }}s (threshold: 300ms)"

      # Region health check failures
      - alert: RegionUnhealthy
        expr: up{job="region_health"} == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Region {{ $labels.region }} is unreachable"
          runbook: "docs/MULTI-REGION-DEPLOYMENT.md#81-region-failover-runbook"

      # Write forwarding errors from read-replica region
      - alert: WriteForwardingErrors
        expr: rate(caddy_reverse_proxy_upstreams_fails_total{upstream="primary_gateway"}[5m]) > 0.1
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Write forwarding from {{ $labels.region }} to primary is failing"

      # BullMQ queue depth growing (jobs not being processed)
      - alert: BullMQQueueBacklog
        expr: bull_queue_waiting_total > 1000
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "BullMQ queue {{ $labels.queue }} in {{ $labels.region }} has {{ $value }} waiting jobs"
```

### 8.4 Capacity Planning Across Regions

Extend the tiers from CAPACITY-PLANNING.md for multi-region:

| Tier | Regions | Per-Region Compute | Per-Region PG | Per-Region Redis | Est. Monthly Cost |
|---|---|---|---|---|---|
| Multi-Small | 2 | 4 cores, 8 GB | Streaming replica | Standalone | $400-800 |
| Multi-Medium | 2 | 8 cores, 16 GB | HA cluster (3 nodes) | Sentinel (3 nodes) | $1,500-3,000 |
| Multi-Large | 3+ | 16+ cores, 32+ GB | HA cluster + logical replication | Sentinel + cross-region sync | $5,000-15,000 |

**Bandwidth estimation for cross-region replication:**

```
WAL generation rate ≈ 10 MB/min at Medium tier
                    ≈ 100 MB/min at Large tier

Cross-region bandwidth needed:
  Medium: 10 MB/min × 60 = 600 MB/hour ≈ 15 GB/day
  Large: 100 MB/min × 60 = 6 GB/hour ≈ 144 GB/day

AWS inter-region transfer cost: ~$0.02/GB
  Medium: 15 GB × $0.02 = $0.30/day = $9/month
  Large: 144 GB × $0.02 = $2.88/day = $86/month
```

---

## 9. Example Configurations

### 9.1 Docker Compose Override for 2-Region Setup

Use this override alongside the base `docker-compose.yml` and
`docker-compose.prod.yml`. One copy runs in each region with the
appropriate `.env` file.

```yaml
# docker/docker-compose.multi-region.yml
#
# Multi-region override for OnePlatform.
#
# Usage (primary region):
#   docker compose \
#     -f docker/docker-compose.yml \
#     -f docker/docker-compose.prod.yml \
#     -f docker/docker-compose.multi-region.yml \
#     --env-file .env.us-east \
#     up -d
#
# Usage (read-replica region):
#   docker compose \
#     -f docker/docker-compose.yml \
#     -f docker/docker-compose.prod.yml \
#     -f docker/docker-compose.multi-region.yml \
#     --env-file .env.eu-west \
#     up -d

services:
  # Override Caddy to use region-specific Caddyfile
  caddy:
    volumes:
      - ./caddy/Caddyfile.${OP_REGION}:/etc/caddy/Caddyfile:ro

  # Gateway: inject region identity and peer configuration
  gateway-service:
    environment:
      OP_REGION: ${OP_REGION}
      OP_REGION_ROLE: ${OP_REGION_ROLE}
      OP_PRIMARY_GATEWAY_URL: ${OP_PRIMARY_GATEWAY_URL:-}
      OP_PEER_REGIONS: ${OP_PEER_REGIONS:-}

  # All services: inject region identity for logging and metrics
  auth-service:
    environment:
      OP_REGION: ${OP_REGION}

  ingestion-service:
    environment:
      OP_REGION: ${OP_REGION}

  ontology-service:
    environment:
      OP_REGION: ${OP_REGION}

  pipeline-service:
    environment:
      OP_REGION: ${OP_REGION}
      OP_REGION_ROLE: ${OP_REGION_ROLE}

  execution-service:
    environment:
      OP_REGION: ${OP_REGION}

  app-service:
    environment:
      OP_REGION: ${OP_REGION}

  logging-service:
    environment:
      OP_REGION: ${OP_REGION}

  plugin-service:
    environment:
      OP_REGION: ${OP_REGION}

  # PgBouncer: use region-specific config
  pgbouncer:
    volumes:
      - ./pgbouncer/pgbouncer.${OP_REGION}.ini:/etc/pgbouncer/pgbouncer.ini:ro
      - ./pgbouncer/userlist.txt.template:/etc/pgbouncer/userlist.txt.template:ro
      - ./pgbouncer/pgbouncer-entrypoint.sh:/usr/local/bin/pgbouncer-entrypoint.sh:ro
      - init-data:/data/init:ro

  # Redis: configure Sentinel for HA within the region
  redis:
    command:
      - redis-server
      - /etc/redis/redis.conf
      - --bind
      - "0.0.0.0"
    environment:
      OP_REGION: ${OP_REGION}

  # Cross-region invalidation sidecar (only for Active-Active / Read-Local)
  cache-invalidation:
    image: node:20-alpine
    volumes:
      - ./scripts/cache-invalidation.js:/app/index.js:ro
    environment:
      LOCAL_REDIS_URL: redis://redis:6379
      REMOTE_REDIS_URL: ${OP_REMOTE_REDIS_URL:-}
      OP_REGION: ${OP_REGION}
    networks:
      - oneplatform-internal
    restart: unless-stopped
    depends_on:
      redis:
        condition: service_healthy
    profiles:
      - multi-region-active
```

### 9.2 Helm Values for Multi-Region Kubernetes

**Primary region values (`values-us-east.yaml`):**

```yaml
# deploy/helm/oneplatform/values-us-east.yaml
# Primary region — serves reads and writes

global:
  imageRegistry: "ghcr.io/myorg"
  imageTag: "v1.2.0"

baseUrl: "https://platform.example.com"
allowedOrigins: "https://platform.example.com"

# Region configuration
region:
  name: "us-east"
  role: "primary"    # primary | standby | read-replica
  peers:
    - name: "eu-west"
      gatewayUrl: "https://eu-west.internal.example.com:3000"

# PostgreSQL — use external managed database (RDS / Cloud SQL)
postgresql:
  enabled: false

externalPostgresql:
  host: "oneplatform-primary.us-east-1.rds.amazonaws.com"
  port: 5432
  database: oneplatform
  username: postgres
  passwordSecretKey: "postgresPassword"

# Redis — use external managed Redis (ElastiCache)
redis:
  enabled: false

externalRedis:
  host: "oneplatform.us-east-1.cache.amazonaws.com"
  port: 6379
  passwordSecretKey: "redisPassword"

# Service replicas — scale for primary region traffic
gateway:
  replicaCount: 3
  resources:
    limits:
      cpu: "1"
      memory: "1Gi"
  env:
    OP_REGION: "us-east"
    OP_REGION_ROLE: "primary"

auth:
  replicaCount: 2
  env:
    OP_REGION: "us-east"

ingestion:
  replicaCount: 3
  env:
    OP_REGION: "us-east"

pipeline:
  replicaCount: 2
  env:
    OP_REGION: "us-east"

# Ingress — region-specific
ingress:
  enabled: true
  className: "nginx"
  hostname: "platform.example.com"
  annotations:
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    nginx.ingress.kubernetes.io/proxy-body-size: "100m"
  tls:
    enabled: true
    secretName: "oneplatform-tls-us-east"
    certManagerIssuer: "letsencrypt-prod"
```

**Read-replica region values (`values-eu-west.yaml`):**

```yaml
# deploy/helm/oneplatform/values-eu-west.yaml
# Read-replica region — serves reads locally, forwards writes to primary

global:
  imageRegistry: "ghcr.io/myorg"
  imageTag: "v1.2.0"

baseUrl: "https://platform.example.com"
allowedOrigins: "https://platform.example.com"

region:
  name: "eu-west"
  role: "read-replica"
  primaryGatewayUrl: "https://us-east.internal.example.com:3000"
  peers:
    - name: "us-east"
      gatewayUrl: "https://us-east.internal.example.com:3000"

# PostgreSQL — read replica of the primary
postgresql:
  enabled: false

externalPostgresql:
  host: "oneplatform-replica.eu-west-1.rds.amazonaws.com"
  port: 5432
  database: oneplatform
  username: postgres
  passwordSecretKey: "postgresPassword"

# For write operations, PgBouncer routes to primary region
pgbouncer:
  writeHost: "oneplatform-primary.us-east-1.rds.amazonaws.com"
  readHost: "oneplatform-replica.eu-west-1.rds.amazonaws.com"

# Redis — independent instance (not a replica of primary)
redis:
  enabled: false

externalRedis:
  host: "oneplatform.eu-west-1.cache.amazonaws.com"
  port: 6379
  passwordSecretKey: "redisPassword"

# Service replicas — fewer replicas, read-heavy workload
gateway:
  replicaCount: 2
  resources:
    limits:
      cpu: "1"
      memory: "1Gi"
  env:
    OP_REGION: "eu-west"
    OP_REGION_ROLE: "read-replica"
    OP_PRIMARY_GATEWAY_URL: "https://us-east.internal.example.com:3000"

auth:
  replicaCount: 1
  env:
    OP_REGION: "eu-west"

ingestion:
  replicaCount: 2
  env:
    OP_REGION: "eu-west"

pipeline:
  replicaCount: 1
  env:
    OP_REGION: "eu-west"

# Ingress
ingress:
  enabled: true
  className: "nginx"
  hostname: "eu.platform.example.com"
  annotations:
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    nginx.ingress.kubernetes.io/proxy-body-size: "100m"
  tls:
    enabled: true
    secretName: "oneplatform-tls-eu-west"
    certManagerIssuer: "letsencrypt-prod"
```

### 9.3 Terraform/Pulumi Skeleton

A complete Terraform skeleton is provided in `deploy/terraform/multi-region/`.
See [the Terraform files](#terraform-skeleton-reference) for the full
implementation. The skeleton provisions:

- VPC with public/private subnets per region
- RDS PostgreSQL primary + cross-region read replica
- ElastiCache Redis per region
- ECS Fargate cluster running all 9 OnePlatform services
- Application Load Balancer with health checks
- Route53 latency-based DNS records
- VPC peering between regions
- Security groups restricting inter-region traffic to VPN CIDR
- CloudWatch alarms for replication lag and cross-region latency

Usage:

```bash
cd deploy/terraform/multi-region

# Initialize
terraform init

# Plan for 2-region deployment
terraform plan \
  -var='regions=["us-east-1","eu-west-1"]' \
  -var='primary_region=us-east-1' \
  -var='domain=platform.example.com' \
  -var='image_tag=v1.2.0'

# Apply
terraform apply \
  -var='regions=["us-east-1","eu-west-1"]' \
  -var='primary_region=us-east-1' \
  -var='domain=platform.example.com' \
  -var='image_tag=v1.2.0'
```

---

## 10. Cost Estimation Framework

Use this framework to estimate the monthly cost of a multi-region deployment.
All prices are approximate (AWS us-east-1 / eu-west-1, as of 2026).

### 10.1 Compute

| Component | Instance type | Per-region monthly | Notes |
|---|---|---|---|
| 9 services (ECS Fargate) | 0.5 vCPU, 1 GB each | $160 | 9 tasks x ~$18/mo |
| Gateway (scaled to 3) | 1 vCPU, 2 GB each | $105 | 3 tasks x ~$35/mo |
| Caddy | 0.25 vCPU, 512 MB | $9 | Minimal |
| **Subtotal** | | **$274/region** | |

### 10.2 Database

| Component | Instance type | Per-region monthly | Notes |
|---|---|---|---|
| RDS PostgreSQL primary | db.r6g.large (2 vCPU, 16 GB) | $230 | Primary region only |
| RDS PostgreSQL replica | db.r6g.large (2 vCPU, 16 GB) | $230 | Each additional region |
| Storage (100 GB gp3) | | $12 | Per instance |
| **Subtotal (primary)** | | **$242** | |
| **Subtotal (replica)** | | **$242/region** | |

### 10.3 Cache

| Component | Instance type | Per-region monthly | Notes |
|---|---|---|---|
| ElastiCache Redis | cache.r6g.large (2 vCPU, 13 GB) | $195 | Per region |
| **Subtotal** | | **$195/region** | |

### 10.4 Networking

| Component | Estimated monthly | Notes |
|---|---|---|
| VPC peering (per pair) | $0 | No hourly charge; pay for data transfer |
| Inter-region data transfer | $9-86 | Depends on WAL volume (§8.4) |
| ALB | $22/region | Hourly + LCU |
| Route53 hosted zone | $0.50 | Plus $0.60/M queries |
| NAT Gateway | $45/region | Hourly + data processing |
| **Subtotal (2 regions)** | **$140-220** | |

### 10.5 Total Estimates

| Deployment | Monthly estimate |
|---|---|
| 2-region Active-Passive (Medium tier) | $1,200-1,800 |
| 2-region Read-Local-Write-Primary (Medium tier) | $1,400-2,000 |
| 2-region Active-Active (Medium tier) | $1,600-2,400 |
| 3-region Read-Local-Write-Primary (Large tier) | $4,500-7,000 |

These estimates exclude:
- Object storage (S3/MinIO) — highly variable based on data volume
- Monitoring stack (Grafana Cloud, Datadog, etc.)
- DNS query volume
- Support plans
- Reserved instance / savings plan discounts (typically 30-50% off)
