-- ============================================================
-- Migration: 002_pipeline_versions
-- Pipeline Service — version history for pipeline definitions
--
-- Every PATCH to a pipeline.pipelines row snapshots the
-- pre-update state here before the UPDATE is applied.
-- This gives callers a full audit trail and enables rollback.
--
-- Design decisions:
--   - Separate table (not a JSON array column on pipelines) so
--     that individual versions can be indexed, enumerated, and
--     deleted without deserialising the parent row.
--   - version_number starts at 1 and increments per pipeline,
--     NOT globally, so the caller-facing "version 3" always
--     means "the third snapshot taken for this pipeline".
--   - definition_snapshot is the definition *before* the update
--     that caused this version record to be written.
-- ============================================================

CREATE TABLE IF NOT EXISTS pipeline.pipeline_versions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pipeline_id         UUID NOT NULL REFERENCES pipeline.pipelines(id) ON DELETE CASCADE,
    tenant_id           UUID NOT NULL,
    -- Version number is per-pipeline and monotonically increasing.
    version_number      INTEGER NOT NULL,
    -- Snapshot of pipeline.pipelines.definition at the moment this version
    -- was created (i.e., the state that was about to be replaced).
    definition_snapshot JSONB NOT NULL,
    -- Metadata about the update that displaced this version.
    name_at_version     TEXT NOT NULL,
    description_at_version TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by          UUID NOT NULL,

    CONSTRAINT pipeline_versions_unique_version UNIQUE (pipeline_id, version_number),
    CONSTRAINT pipeline_versions_number_positive CHECK (version_number > 0)
);

-- Lookup by pipeline with ordered version list — most common access pattern.
CREATE INDEX IF NOT EXISTS idx_pipeline_versions_pipeline_id
    ON pipeline.pipeline_versions (pipeline_id, version_number DESC);

-- Tenant-scoped lookup — mirrors pipelines table access pattern.
CREATE INDEX IF NOT EXISTS idx_pipeline_versions_tenant_id
    ON pipeline.pipeline_versions (tenant_id);

ALTER TABLE pipeline.pipeline_versions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'pipeline'
       AND tablename  = 'pipeline_versions'
       AND policyname = 'pipeline_versions_tenant_isolation'
  ) THEN
    CREATE POLICY pipeline_versions_tenant_isolation ON pipeline.pipeline_versions
        USING (tenant_id = current_setting('app.tenant_id', true)::uuid
               OR current_setting('app.bypass_rls', true) = 'true');
  END IF;
END;
$$;

-- Add current_version to pipelines so callers can read the version number
-- without issuing a second query to pipeline_versions.
-- Starts at 0 (no snapshots taken yet); increments each time a snapshot is saved.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'pipeline'
       AND table_name   = 'pipelines'
       AND column_name  = 'current_version'
  ) THEN
    ALTER TABLE pipeline.pipelines
      ADD COLUMN current_version INTEGER NOT NULL DEFAULT 0;
  END IF;
END;
$$;
