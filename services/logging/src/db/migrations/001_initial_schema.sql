-- Logging Service — Initial Schema
-- ADR-17: Logging Architecture, ADR-18: Redis Resilience
--
-- Why logging_service_role owns the schema: DROP TABLE on a partition requires
-- either superuser or table owner. By making logging_service_role the schema
-- owner, the retention job can drop partitions without needing superuser.

CREATE SCHEMA IF NOT EXISTS logging;

-- Role creation is idempotent; the DO block avoids an error if the role already
-- exists (CREATE ROLE IF NOT EXISTS is not available in all Postgres versions).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'logging_service_role') THEN
    CREATE ROLE logging_service_role;
  END IF;
END
$$;

ALTER SCHEMA logging OWNER TO logging_service_role;

-- ---------------------------------------------------------------------------
-- logging.events — time-partitioned by created_at (monthly partitions)
--
-- search_vec is GENERATED ALWAYS AS STORED so the tsvector is computed once
-- at insert time. Query-time to_tsvector() on millions of rows is too slow;
-- this trades storage for constant-time GIN index lookups.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS logging.events (
  id          UUID        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id   TEXT        NOT NULL DEFAULT '',
  trace_id    TEXT        NOT NULL DEFAULT '',
  service     TEXT        NOT NULL,
  level       TEXT        NOT NULL CHECK (level IN ('debug','info','warn','error')),
  message     TEXT        NOT NULL,
  metadata    JSONB       NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  search_vec  TSVECTOR    GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(message, '') || ' ' || coalesce(metadata::text, ''))
  ) STORED
) PARTITION BY RANGE (created_at);

-- Parent-level indexes: Postgres automatically propagates these to new partitions
-- created after this statement. They also cover queries that span partitions.
CREATE INDEX IF NOT EXISTS events_service_level_created_idx
  ON logging.events (service, level, created_at DESC);

-- Partial index: trace_id = '' is the default for system events; excluding those
-- keeps this index compact and useful only for actual trace correlation queries.
CREATE INDEX IF NOT EXISTS events_trace_id_created_idx
  ON logging.events (trace_id, created_at DESC)
  WHERE trace_id <> '';

CREATE INDEX IF NOT EXISTS events_search_vec_gin_idx
  ON logging.events USING GIN (search_vec);

CREATE INDEX IF NOT EXISTS events_created_at_idx
  ON logging.events (created_at DESC);

-- Tenant-scoped log queries — most API callers filter by tenant_id
CREATE INDEX IF NOT EXISTS events_tenant_id_created_idx
  ON logging.events (tenant_id, created_at DESC)
  WHERE tenant_id <> '';

-- ---------------------------------------------------------------------------
-- logging.audit_events — non-partitioned append-only table
--
-- Audit events are never hard-deleted within the 365-day retention window.
-- The archived flag is set only by the retention job after the window elapses.
-- job_id stores the BullMQ job ID to enforce at-most-once insertion for
-- replayed jobs (guaranteed-delivery semantics require idempotent consumers).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS logging.audit_events (
  id            UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  trace_id      TEXT        NOT NULL DEFAULT '',
  actor_id      TEXT        NOT NULL,
  actor_type    TEXT        NOT NULL CHECK (actor_type IN ('user','service','system')),
  tenant_id     TEXT        NOT NULL,
  action        TEXT        NOT NULL,
  resource_type TEXT        NOT NULL,
  resource_id   TEXT        NOT NULL,
  result        TEXT        NOT NULL CHECK (result IN ('success','failure')),
  metadata      JSONB       NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived      BOOLEAN     NOT NULL DEFAULT FALSE,
  job_id        TEXT
);

-- Deduplication key: if BullMQ replays the same job, ON CONFLICT (job_id) DO NOTHING
-- prevents a duplicate audit row.
CREATE UNIQUE INDEX IF NOT EXISTS audit_events_job_id_unique_idx
  ON logging.audit_events (job_id)
  WHERE job_id IS NOT NULL;

-- Compliance query: all actions on a resource
CREATE INDEX IF NOT EXISTS audit_events_resource_idx
  ON logging.audit_events (resource_type, resource_id, created_at DESC);

-- Actor audit trail
CREATE INDEX IF NOT EXISTS audit_events_actor_idx
  ON logging.audit_events (actor_id, created_at DESC);

-- Tenant-scoped compliance queries
CREATE INDEX IF NOT EXISTS audit_events_tenant_idx
  ON logging.audit_events (tenant_id, created_at DESC);

-- Trace correlation across audit and log events
CREATE INDEX IF NOT EXISTS audit_events_trace_id_idx
  ON logging.audit_events (trace_id, created_at DESC)
  WHERE trace_id <> '';

-- Retention job: find rows eligible for archival/deletion without a full-table scan
CREATE INDEX IF NOT EXISTS audit_events_retention_idx
  ON logging.audit_events (created_at DESC)
  WHERE archived = FALSE;

-- ---------------------------------------------------------------------------
-- logging.partition_registry — tracks partition lifecycle for retention job
--
-- Using a registry table rather than information_schema queries avoids
-- performance overhead in hot paths and provides drop/archive timestamps.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS logging.partition_registry (
  partition_name  TEXT        NOT NULL PRIMARY KEY,
  table_name      TEXT        NOT NULL,
  period_start    TIMESTAMPTZ NOT NULL,
  period_end      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  dropped_at      TIMESTAMPTZ,
  archived_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS partition_registry_table_period_idx
  ON logging.partition_registry (table_name, period_start);

-- ---------------------------------------------------------------------------
-- Initial monthly partitions: current month (2026-06) and next month (2026-07)
--
-- These are created inline so the first batch insert succeeds immediately.
-- The retention service's ensurePartitions() keeps the rolling window current.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS logging.events_2026_06
  PARTITION OF logging.events
  FOR VALUES FROM ('2026-06-01 00:00:00+00')
             TO   ('2026-07-01 00:00:00+00');

CREATE TABLE IF NOT EXISTS logging.events_2026_07
  PARTITION OF logging.events
  FOR VALUES FROM ('2026-07-01 00:00:00+00')
             TO   ('2026-08-01 00:00:00+00');

-- Register the initial partitions so the retention job can track them
INSERT INTO logging.partition_registry (partition_name, table_name, period_start, period_end)
VALUES
  ('events_2026_06', 'events', '2026-06-01 00:00:00+00', '2026-07-01 00:00:00+00'),
  ('events_2026_07', 'events', '2026-07-01 00:00:00+00', '2026-08-01 00:00:00+00')
ON CONFLICT (partition_name) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Grants — logging_service_role needs SELECT+INSERT on events (append-only
-- writes), SELECT+INSERT+UPDATE on audit_events (archived flag), and full
-- access to partition_registry (drop tracking).
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA logging TO logging_service_role;
GRANT SELECT, INSERT ON logging.events TO logging_service_role;
GRANT SELECT, INSERT, UPDATE ON logging.audit_events TO logging_service_role;
GRANT SELECT, INSERT, UPDATE ON logging.partition_registry TO logging_service_role;
