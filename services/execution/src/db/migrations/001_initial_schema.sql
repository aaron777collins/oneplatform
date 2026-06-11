-- ============================================================
-- Migration: 001_initial_schema
-- Execution Service — executions, execution_logs
--
-- Idempotent: uses IF NOT EXISTS and DO $$ ... $$ guards throughout.
-- Applied by execution_migrator_role which owns the execution schema.
--
-- Tables are PARTITIONED BY RANGE (monthly buckets). Initial partitions
-- are created here for the launch window; additional partitions are
-- created at service startup and at the start of each calendar month
-- by the service's ensurePartition() method.
-- ============================================================

CREATE SCHEMA IF NOT EXISTS execution;

-- ============================================================
-- execution.executions
--
-- One row per execution request. Partitioned by started_at so
-- retention-based cleanup can drop whole monthly partitions without
-- a table scan. The composite primary key (id, started_at) is
-- required by Postgres for partitioned tables — the partition key
-- must be part of any unique constraint.
--
-- RLS: tenants see only their own rows via app.tenant_id session var.
-- app.bypass_rls = 'true' allows service-level cross-tenant queries
-- (e.g., drain checks across all tenants for a platform-wide plugin).
-- ============================================================
CREATE TABLE IF NOT EXISTS execution.executions (
    id              UUID         NOT NULL DEFAULT gen_random_uuid(),
    tenant_id       UUID         NOT NULL,
    -- FK to auth.tenants not enforced here — cross-schema FK avoided per ADR-5.
    type            TEXT         NOT NULL,
    -- 'code' | 'connector-run' | 'app-build' | 'expression' | 'plugin-drain'
    status          TEXT         NOT NULL DEFAULT 'pending',
    -- 'pending' | 'running' | 'success' | 'error' | 'timeout' | 'killed'
    language        TEXT         NOT NULL DEFAULT 'js',
    -- 'js' | 'ts' | 'python' | 'go'
    sandbox_type    TEXT         NOT NULL DEFAULT 'isolated-vm',
    -- 'isolated-vm' | 'docker'
    plugin_id       UUID,
    -- NULL for non-plugin executions
    pipeline_id     UUID,
    -- NULL if not triggered by a pipeline
    pipeline_run_id UUID,
    -- NULL if not triggered by a pipeline run
    hook_context    BOOLEAN      NOT NULL DEFAULT FALSE,
    -- TRUE if running inside a hook chain; used for HookRecursionError enforcement
    code_hash       TEXT,
    -- SHA-256 of the code that was executed; for dedup/audit
    started_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    completed_at    TIMESTAMPTZ,
    duration_ms     INTEGER,
    -- NULL until completed
    memory_peak_mb  REAL,
    -- NULL until completed; reported by sandbox at completion
    exit_code       INTEGER,
    -- NULL until completed; 0=success, non-zero=error
    error_code      TEXT,
    -- NULL on success; e.g. 'EXECUTION_TIMEOUT', 'EXECUTION_OOM'
    error_message   TEXT,
    -- NULL on success; human-readable
    error_stack     TEXT,
    -- NULL on success; sanitized stack trace (never returned to users via API)
    trace_id        TEXT         NOT NULL,
    -- W3C trace context propagated from caller; required for distributed tracing
    initiated_by    TEXT         NOT NULL,
    -- 'pipeline-service' | 'app-service' | 'ontology-service' | 'api'
    sandbox_vm_run  INTEGER,
    -- sandbox-vm execution counter at time of dispatch; correlates anomalies with recycle cycles
    PRIMARY KEY (id, started_at)
    -- partition key (started_at) must be included in PK per Postgres partitioning rules
) PARTITION BY RANGE (started_at);

-- ============================================================
-- execution.executions constraints (applied to the parent table;
-- inherited by all partitions).
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'executions_type_valid'
       AND conrelid = 'execution.executions'::regclass
  ) THEN
    ALTER TABLE execution.executions ADD CONSTRAINT executions_type_valid
        CHECK (type IN ('code', 'connector-run', 'app-build', 'expression', 'plugin-drain'));
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'executions_status_valid'
       AND conrelid = 'execution.executions'::regclass
  ) THEN
    ALTER TABLE execution.executions ADD CONSTRAINT executions_status_valid
        CHECK (status IN ('pending', 'running', 'success', 'error', 'timeout', 'killed'));
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'executions_language_valid'
       AND conrelid = 'execution.executions'::regclass
  ) THEN
    ALTER TABLE execution.executions ADD CONSTRAINT executions_language_valid
        CHECK (language IN ('js', 'ts', 'python', 'go'));
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'executions_sandbox_type_valid'
       AND conrelid = 'execution.executions'::regclass
  ) THEN
    ALTER TABLE execution.executions ADD CONSTRAINT executions_sandbox_type_valid
        CHECK (sandbox_type IN ('isolated-vm', 'docker'));
  END IF;
END;
$$;

-- ============================================================
-- Indexes on the parent table — Postgres propagates them to
-- each partition that is created subsequently.
-- ============================================================

-- Primary access pattern: tenant's execution history, newest first.
CREATE INDEX IF NOT EXISTS idx_executions_tenant_started
    ON execution.executions (tenant_id, started_at DESC);

-- Fast lookup for in-flight executions (used by drain and concurrency checks).
-- Partial index kept small by excluding terminal statuses.
CREATE INDEX IF NOT EXISTS idx_executions_active_status
    ON execution.executions (status)
    WHERE status IN ('pending', 'running');

-- Plugin drain: find all in-flight executions for a specific plugin.
CREATE INDEX IF NOT EXISTS idx_executions_plugin_id
    ON execution.executions (plugin_id)
    WHERE plugin_id IS NOT NULL;

-- Pipeline run correlation: join from pipeline service run records.
CREATE INDEX IF NOT EXISTS idx_executions_pipeline_run_id
    ON execution.executions (pipeline_run_id)
    WHERE pipeline_run_id IS NOT NULL;

-- Distributed trace lookup for debugging and incident correlation.
CREATE INDEX IF NOT EXISTS idx_executions_trace_id
    ON execution.executions (trace_id);

-- ============================================================
-- RLS on the parent table (policies are inherited by partitions).
-- ============================================================
ALTER TABLE execution.executions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'execution'
       AND tablename  = 'executions'
       AND policyname = 'executions_tenant_isolation'
  ) THEN
    CREATE POLICY executions_tenant_isolation ON execution.executions
        USING (
            tenant_id = current_setting('app.tenant_id', true)::uuid
            OR current_setting('app.bypass_rls', true) = 'true'
        );
  END IF;
END;
$$;

-- ============================================================
-- Initial monthly partitions.
--
-- The service creates 3 months of partitions at startup (current
-- month + 2 ahead) and re-runs on the 1st of each month.
-- We create 2026-01 (historical), 2026-06 (current at design time),
-- 2026-07, and 2026-08 to cover the current period on first deploy.
-- ============================================================
CREATE TABLE IF NOT EXISTS execution.executions_2026_01
    PARTITION OF execution.executions
    FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');

CREATE TABLE IF NOT EXISTS execution.executions_2026_06
    PARTITION OF execution.executions
    FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

CREATE TABLE IF NOT EXISTS execution.executions_2026_07
    PARTITION OF execution.executions
    FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');

CREATE TABLE IF NOT EXISTS execution.executions_2026_08
    PARTITION OF execution.executions
    FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');

-- ============================================================
-- execution.execution_logs
--
-- Append-only log lines for each execution. Co-partitioned with
-- execution.executions on the same monthly boundaries so both tables
-- can be dropped together during retention cleanup, avoiding orphaned
-- log rows in a dropped execution partition.
--
-- execution_date is denormalized from the parent execution's started_at;
-- this is the partition routing key for log writes.
--
-- The BIGSERIAL id is the SSE cursor — clients reconnect with
-- Last-Event-ID set to the last received line_number.
-- ============================================================
CREATE TABLE IF NOT EXISTS execution.execution_logs (
    id              BIGSERIAL,
    execution_id    UUID         NOT NULL,
    execution_date  TIMESTAMPTZ  NOT NULL,
    -- Denormalized from executions.started_at; routes insert to correct partition.
    timestamp       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    level           TEXT         NOT NULL DEFAULT 'info',
    -- 'debug' | 'info' | 'warn' | 'error'
    message         TEXT         NOT NULL,
    line_number     INTEGER      NOT NULL,
    -- Sequential 1-based counter within the execution; used as SSE resume cursor.
    stream          TEXT         NOT NULL DEFAULT 'stdout',
    -- 'stdout' | 'stderr'
    metadata        JSONB,
    -- Optional structured metadata attached by the sandbox logger.
    PRIMARY KEY (id, execution_date)
    -- Partition key (execution_date) required in PK per Postgres partitioning rules.
) PARTITION BY RANGE (execution_date);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'execution_logs_level_valid'
       AND conrelid = 'execution.execution_logs'::regclass
  ) THEN
    ALTER TABLE execution.execution_logs ADD CONSTRAINT execution_logs_level_valid
        CHECK (level IN ('debug', 'info', 'warn', 'error'));
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'execution_logs_stream_valid'
       AND conrelid = 'execution.execution_logs'::regclass
  ) THEN
    ALTER TABLE execution.execution_logs ADD CONSTRAINT execution_logs_stream_valid
        CHECK (stream IN ('stdout', 'stderr'));
  END IF;
END;
$$;

-- ============================================================
-- Indexes on execution_logs parent table.
-- ============================================================

-- Primary SSE access pattern: fetch all lines for an execution in order,
-- or fetch lines after a given line_number for resume.
CREATE INDEX IF NOT EXISTS idx_execution_logs_exec_line
    ON execution.execution_logs (execution_id, line_number);

-- Timestamp-ordered access for monitoring UIs that show real-time log feed.
CREATE INDEX IF NOT EXISTS idx_execution_logs_exec_timestamp
    ON execution.execution_logs (execution_id, timestamp);

-- RLS on execution_logs: isolate by execution_id joins to executions.tenant_id.
-- We enforce via a policy that looks up tenant through app.tenant_id and requires
-- bypass for internal service ops. Direct tenant_id is not stored on log rows
-- to avoid the storage overhead on a high-volume table; bypass mode is used for
-- all service-internal log writes.
ALTER TABLE execution.execution_logs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'execution'
       AND tablename  = 'execution_logs'
       AND policyname = 'execution_logs_tenant_isolation'
  ) THEN
    -- Log rows are readable if the corresponding execution belongs to the current
    -- tenant OR bypass_rls is active. Write path always uses bypass (service role).
    CREATE POLICY execution_logs_tenant_isolation ON execution.execution_logs
        USING (
            EXISTS (
                SELECT 1
                  FROM execution.executions e
                 WHERE e.id = execution_id
                   AND e.tenant_id = current_setting('app.tenant_id', true)::uuid
            )
            OR current_setting('app.bypass_rls', true) = 'true'
        );
  END IF;
END;
$$;

-- ============================================================
-- Log partitions — co-partitioned with executions.
-- ============================================================
CREATE TABLE IF NOT EXISTS execution.execution_logs_2026_01
    PARTITION OF execution.execution_logs
    FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');

CREATE TABLE IF NOT EXISTS execution.execution_logs_2026_06
    PARTITION OF execution.execution_logs
    FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

CREATE TABLE IF NOT EXISTS execution.execution_logs_2026_07
    PARTITION OF execution.execution_logs
    FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');

CREATE TABLE IF NOT EXISTS execution.execution_logs_2026_08
    PARTITION OF execution.execution_logs
    FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');

-- ============================================================
-- execution.schema_migrations
--
-- Version tracking table used by the migration runner to ensure
-- each migration is applied exactly once.
-- ============================================================
CREATE TABLE IF NOT EXISTS execution.schema_migrations (
    version    TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- Grants — execution_service_role gets exactly the permissions
-- it needs and nothing more (principle of least privilege, §16.2).
-- ============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'execution_service_role') THEN
    GRANT USAGE ON SCHEMA execution TO execution_service_role;
    GRANT SELECT, INSERT, UPDATE ON execution.executions TO execution_service_role;
    GRANT SELECT, INSERT ON execution.execution_logs TO execution_service_role;
    GRANT SELECT ON execution.schema_migrations TO execution_service_role;
    -- Sequence grant needed for BIGSERIAL on execution_logs
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA execution TO execution_service_role;
  END IF;
END;
$$;
