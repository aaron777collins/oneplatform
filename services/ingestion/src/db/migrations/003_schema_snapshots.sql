-- ============================================================
-- Migration: 003_schema_snapshots
-- Ingestion Service — schema_snapshots for drift detection
--
-- Stores the last N source schema snapshots per connector so
-- each sync run can detect when fields are added, removed, or
-- changed. A JSONB column carries the field array to avoid
-- normalising one row per field (this is read/written atomically
-- on every sync, not queried per-field).
--
-- Idempotent: uses IF NOT EXISTS throughout.
-- ============================================================

CREATE TABLE IF NOT EXISTS ingestion.schema_snapshots (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_id  UUID        NOT NULL REFERENCES ingestion.connectors(id) ON DELETE CASCADE,
  captured_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- JSON array of { name, type, nullable } objects representing every field
  -- seen in the batch at capture time.
  fields        JSONB       NOT NULL DEFAULT '[]'
);

-- Hot path: fetch the latest K snapshots for a connector to diff against.
CREATE INDEX IF NOT EXISTS idx_schema_snapshots_connector_captured
  ON ingestion.schema_snapshots (connector_id, captured_at DESC);
