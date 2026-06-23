-- ============================================================
-- Migration: 001_initial_schema
-- Pipeline Service — pipelines, runs, run_steps, schedules,
--                    triggers, run_logs
--
-- Idempotent: uses IF NOT EXISTS and CREATE OR REPLACE throughout.
-- Applied by pipeline_migrator_role which owns the pipeline schema.
-- ============================================================

CREATE SCHEMA IF NOT EXISTS pipeline;

-- ============================================================
-- set_updated_at() trigger function
--
-- Shared helper for all tables with updated_at. OR REPLACE is
-- safe here: the function body is identical for every table.
-- ============================================================
CREATE OR REPLACE FUNCTION pipeline.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ============================================================
-- pipeline.pipelines
--
-- A pipeline definition. The definition JSONB field holds the
-- complete step graph and inline trigger configuration. Triggers
-- that require external registration (cron, event, webhook)
-- additionally have rows in pipeline.schedules or pipeline.triggers.
--
-- RLS: tenants see only their own rows. The bypass_rls pattern
-- allows internal service operations that span tenants (e.g.,
-- the cron scheduler which queries all enabled schedules).
-- ============================================================
CREATE TABLE IF NOT EXISTS pipeline.pipelines (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL,
    -- FK to auth.tenants(id) not enforced here — cross-schema FK avoided per ADR-5.
    -- Enforcement is at the application layer: tenantId validated against the
    -- auth.tenants table on pipeline creation via Auth Service service call.
    name                TEXT NOT NULL,
    slug                TEXT NOT NULL,
    description         TEXT,
    definition          JSONB NOT NULL DEFAULT '{}',
    -- Structure: { version: number, steps: Step[], entryStepId: string,
    --              triggers: TriggerConfig[], options: PipelineOptions }
    is_active           BOOLEAN NOT NULL DEFAULT true,
    -- is_active=false disables all triggers; existing runs can still complete.
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by          UUID NOT NULL,

    CONSTRAINT pipelines_slug_per_tenant_unique UNIQUE (tenant_id, slug),
    CONSTRAINT pipelines_name_not_empty CHECK (length(trim(name)) > 0),
    CONSTRAINT pipelines_slug_format CHECK (slug ~ '^[a-z0-9][a-z0-9\-]{1,62}[a-z0-9]$'),
    CONSTRAINT pipelines_definition_not_null CHECK (definition IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_pipelines_tenant_id ON pipeline.pipelines (tenant_id);
CREATE INDEX IF NOT EXISTS idx_pipelines_tenant_slug ON pipeline.pipelines (tenant_id, slug);
CREATE INDEX IF NOT EXISTS idx_pipelines_tenant_active ON pipeline.pipelines (tenant_id) WHERE is_active = true;

ALTER TABLE pipeline.pipelines ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'pipeline'
       AND tablename  = 'pipelines'
       AND policyname = 'pipelines_tenant_isolation'
  ) THEN
    CREATE POLICY pipelines_tenant_isolation ON pipeline.pipelines
        USING (tenant_id = current_setting('app.tenant_id', true)::uuid
               OR current_setting('app.bypass_rls', true) = 'true');
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'trg_pipelines_updated_at'
  ) THEN
    CREATE TRIGGER trg_pipelines_updated_at
    BEFORE UPDATE ON pipeline.pipelines
    FOR EACH ROW EXECUTE FUNCTION pipeline.set_updated_at();
  END IF;
END;
$$;

-- ============================================================
-- pipeline.runs
--
-- One row per pipeline run attempt. A run is created synchronously
-- when a trigger fires; execution happens asynchronously via BullMQ.
-- ============================================================
CREATE TABLE IF NOT EXISTS pipeline.runs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pipeline_id         UUID NOT NULL REFERENCES pipeline.pipelines(id) ON DELETE CASCADE,
    tenant_id           UUID NOT NULL,
    status              TEXT NOT NULL DEFAULT 'pending',
    -- Allowed values: pending | running | completed | failed | cancelled
    triggered_by        TEXT NOT NULL,
    -- Enum: 'manual' | 'schedule' | 'event' | 'webhook' | 'service'
    trigger_actor_id    UUID,
    -- manual: user UUID; schedule: schedule UUID; event/webhook: NULL
    trigger_meta        JSONB NOT NULL DEFAULT '{}',
    -- Additional trigger context (see design spec §2.2 for field details)
    input               JSONB NOT NULL DEFAULT '{}',
    started_at          TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ,
    error               JSONB,
    -- On failure: { code: string, message: string, stepId?: string, details?: unknown }
    bully_job_id        TEXT,
    -- BullMQ job ID for the pipeline:run queue entry.
    definition_snapshot JSONB NOT NULL DEFAULT '{}',
    -- Snapshot of pipeline.definition at run creation time.
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT runs_status_valid CHECK (
        status IN ('pending', 'running', 'completed', 'failed', 'cancelled')
    ),
    CONSTRAINT runs_triggered_by_valid CHECK (
        triggered_by IN ('manual', 'schedule', 'event', 'webhook', 'service')
    ),
    CONSTRAINT runs_completed_at_after_started CHECK (
        completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at
    )
);

CREATE INDEX IF NOT EXISTS idx_runs_pipeline_id ON pipeline.runs (pipeline_id);
CREATE INDEX IF NOT EXISTS idx_runs_tenant_id ON pipeline.runs (tenant_id);
CREATE INDEX IF NOT EXISTS idx_runs_tenant_status ON pipeline.runs (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_runs_pipeline_created ON pipeline.runs (pipeline_id, created_at DESC);
-- Partial index for active (non-terminal) runs — used by the concurrency mutex check:
CREATE INDEX IF NOT EXISTS idx_runs_active ON pipeline.runs (pipeline_id, status)
    WHERE status IN ('pending', 'running');

ALTER TABLE pipeline.runs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'pipeline'
       AND tablename  = 'runs'
       AND policyname = 'runs_tenant_isolation'
  ) THEN
    CREATE POLICY runs_tenant_isolation ON pipeline.runs
        USING (tenant_id = current_setting('app.tenant_id', true)::uuid
               OR current_setting('app.bypass_rls', true) = 'true');
  END IF;
END;
$$;

-- ============================================================
-- pipeline.run_steps
--
-- One row per step per run. Created eagerly when the run starts
-- (status='pending') so the UI can show the full step graph
-- immediately, with individual steps transitioning to 'running'
-- and then terminal states as execution proceeds.
-- ============================================================
CREATE TABLE IF NOT EXISTS pipeline.run_steps (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id              UUID NOT NULL REFERENCES pipeline.runs(id) ON DELETE CASCADE,
    tenant_id           UUID NOT NULL,
    step_id             TEXT NOT NULL,
    -- The step ID from the pipeline definition (user-defined, unique within a pipeline).
    step_name           TEXT NOT NULL,
    step_type           TEXT NOT NULL,
    -- 'code' | 'connector' | 'transformer' | 'conditional' | 'parallel' | 'webhook'
    status              TEXT NOT NULL DEFAULT 'pending',
    -- pending | running | completed | failed | skipped | cancelled
    attempt_count       INTEGER NOT NULL DEFAULT 0,
    -- Reserved for future step-level retry policy; always 0 in MVP.
    started_at          TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ,
    input               JSONB NOT NULL DEFAULT '{}',
    output              JSONB,
    error               JSONB,
    execution_id        UUID,
    -- The Execution Service execution ID, if this step triggered a sandbox execution.
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT run_steps_status_valid CHECK (
        status IN ('pending', 'running', 'completed', 'failed', 'skipped', 'cancelled')
    ),
    CONSTRAINT run_steps_step_type_valid CHECK (
        step_type IN ('code', 'connector', 'transformer', 'conditional', 'parallel', 'webhook')
    ),
    CONSTRAINT run_steps_step_id_per_run_unique UNIQUE (run_id, step_id)
);

CREATE INDEX IF NOT EXISTS idx_run_steps_run_id ON pipeline.run_steps (run_id);
CREATE INDEX IF NOT EXISTS idx_run_steps_run_status ON pipeline.run_steps (run_id, status);

ALTER TABLE pipeline.run_steps ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'pipeline'
       AND tablename  = 'run_steps'
       AND policyname = 'run_steps_tenant_isolation'
  ) THEN
    CREATE POLICY run_steps_tenant_isolation ON pipeline.run_steps
        USING (tenant_id = current_setting('app.tenant_id', true)::uuid
               OR current_setting('app.bypass_rls', true) = 'true');
  END IF;
END;
$$;

-- ============================================================
-- pipeline.schedules
--
-- Cron-based trigger registrations. One row per cron trigger
-- per pipeline. A single pipeline may have multiple schedules
-- (e.g., hourly + daily digest).
-- ============================================================
CREATE TABLE IF NOT EXISTS pipeline.schedules (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pipeline_id         UUID NOT NULL REFERENCES pipeline.pipelines(id) ON DELETE CASCADE,
    tenant_id           UUID NOT NULL,
    cron_expr           TEXT NOT NULL,
    -- Standard 5-field cron (minute hour dom month dow). Sub-minute rejected at app layer.
    timezone            TEXT NOT NULL DEFAULT 'UTC',
    enabled             BOOLEAN NOT NULL DEFAULT true,
    input_template      JSONB NOT NULL DEFAULT '{}',
    last_run_at         TIMESTAMPTZ,
    next_run_at         TIMESTAMPTZ,
    -- Recomputed after each trigger and on startup.
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT schedules_cron_not_empty CHECK (length(trim(cron_expr)) > 0),
    CONSTRAINT schedules_timezone_not_empty CHECK (length(trim(timezone)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_schedules_pipeline_id ON pipeline.schedules (pipeline_id);
CREATE INDEX IF NOT EXISTS idx_schedules_tenant_id ON pipeline.schedules (tenant_id);
-- Index for the cron scheduler loop — finds due schedules efficiently:
CREATE INDEX IF NOT EXISTS idx_schedules_next_run_enabled ON pipeline.schedules (next_run_at)
    WHERE enabled = true;

ALTER TABLE pipeline.schedules ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'pipeline'
       AND tablename  = 'schedules'
       AND policyname = 'schedules_tenant_isolation'
  ) THEN
    CREATE POLICY schedules_tenant_isolation ON pipeline.schedules
        USING (tenant_id = current_setting('app.tenant_id', true)::uuid
               OR current_setting('app.bypass_rls', true) = 'true');
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'trg_schedules_updated_at'
  ) THEN
    CREATE TRIGGER trg_schedules_updated_at
    BEFORE UPDATE ON pipeline.schedules
    FOR EACH ROW EXECUTE FUNCTION pipeline.set_updated_at();
  END IF;
END;
$$;

-- ============================================================
-- pipeline.triggers
--
-- Event-driven and webhook trigger registrations. Not used for
-- cron (which has its own table) or manual triggers (which have
-- no persistent config).
-- ============================================================
CREATE TABLE IF NOT EXISTS pipeline.triggers (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pipeline_id         UUID NOT NULL REFERENCES pipeline.pipelines(id) ON DELETE CASCADE,
    tenant_id           UUID NOT NULL,
    trigger_type        TEXT NOT NULL,
    -- 'event' | 'webhook'
    config              JSONB NOT NULL DEFAULT '{}',
    -- event: { channel, eventType?, filter? }
    -- webhook: { slug, secret (HMAC), allowedMethods }
    enabled             BOOLEAN NOT NULL DEFAULT true,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT triggers_type_valid CHECK (trigger_type IN ('event', 'webhook'))
);

CREATE INDEX IF NOT EXISTS idx_triggers_pipeline_id ON pipeline.triggers (pipeline_id);
CREATE INDEX IF NOT EXISTS idx_triggers_tenant_id ON pipeline.triggers (tenant_id);
CREATE INDEX IF NOT EXISTS idx_triggers_type_enabled ON pipeline.triggers (trigger_type, enabled);

ALTER TABLE pipeline.triggers ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'pipeline'
       AND tablename  = 'triggers'
       AND policyname = 'triggers_tenant_isolation'
  ) THEN
    CREATE POLICY triggers_tenant_isolation ON pipeline.triggers
        USING (tenant_id = current_setting('app.tenant_id', true)::uuid
               OR current_setting('app.bypass_rls', true) = 'true');
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'trg_triggers_updated_at'
  ) THEN
    CREATE TRIGGER trg_triggers_updated_at
    BEFORE UPDATE ON pipeline.triggers
    FOR EACH ROW EXECUTE FUNCTION pipeline.set_updated_at();
  END IF;
END;
$$;

-- ============================================================
-- pipeline.run_logs
--
-- Append-only log entries for pipeline runs. Used for SSE
-- streaming and the run log viewer. BIGSERIAL id is the SSE
-- cursor — clients reconnect with Last-Event-ID to resume.
-- ============================================================
CREATE TABLE IF NOT EXISTS pipeline.run_logs (
    id                  BIGSERIAL PRIMARY KEY,
    run_id              UUID NOT NULL REFERENCES pipeline.runs(id) ON DELETE CASCADE,
    tenant_id           UUID NOT NULL,
    step_id             TEXT,
    -- NULL for pipeline-level log entries (trigger events, completion events, etc.)
    level               TEXT NOT NULL DEFAULT 'info',
    -- 'debug' | 'info' | 'warn' | 'error'
    message             TEXT NOT NULL,
    details             JSONB,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT run_logs_level_valid CHECK (level IN ('debug', 'info', 'warn', 'error'))
);

-- Covering index for SSE streaming: cursor-based poll by (run_id, id > last_seen_id)
CREATE INDEX IF NOT EXISTS idx_run_logs_run_id_cursor ON pipeline.run_logs (run_id, id);
CREATE INDEX IF NOT EXISTS idx_run_logs_tenant ON pipeline.run_logs (tenant_id);

ALTER TABLE pipeline.run_logs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'pipeline'
       AND tablename  = 'run_logs'
       AND policyname = 'run_logs_tenant_isolation'
  ) THEN
    CREATE POLICY run_logs_tenant_isolation ON pipeline.run_logs
        USING (tenant_id = current_setting('app.tenant_id', true)::uuid
               OR current_setting('app.bypass_rls', true) = 'true');
  END IF;
END;
$$;

-- ============================================================
-- pipeline.schema_migrations
--
-- Version tracking table used by the migration runner to ensure
-- each migration is applied exactly once.
-- ============================================================
CREATE TABLE IF NOT EXISTS pipeline.schema_migrations (
    version    TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- Idempotency constraint for event-triggered runs (§19.3)
--
-- In a multi-instance deployment, multiple pipeline service
-- instances may receive the same Redis pub/sub event simultaneously.
-- This ensures only one run is created per (pipeline_id, eventId) pair —
-- duplicate INSERTs fail silently.
--
-- A table UNIQUE constraint cannot index an expression or carry a WHERE clause,
-- so the idempotency guard is expressed as a partial UNIQUE INDEX over the
-- extracted eventId, scoped to event-triggered runs.
-- ============================================================
CREATE UNIQUE INDEX IF NOT EXISTS runs_event_idempotency_unique
    ON pipeline.runs (pipeline_id, (trigger_meta->>'eventId'))
    WHERE triggered_by = 'event' AND trigger_meta->>'eventId' IS NOT NULL;
