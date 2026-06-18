-- Migration 005: reconciliation_reports table
--
-- Stores the results of reconciliation jobs. Each row represents one completed
-- reconciliation run for a connector. The job_id is the BullMQ job UUID
-- generated at trigger time and serves as the stable external reference.
--
-- missing_in_platform / extra_in_platform / field_mismatches are stored as
-- JSONB arrays to avoid N+1 join queries at read time. The arrays are bounded
-- in practice by the reconciliation sampleSize (default 100 IDs) so storage
-- cost is negligible.

CREATE TABLE IF NOT EXISTS ingestion.reconciliation_reports (
  job_id              UUID        PRIMARY KEY,
  connector_id        UUID        NOT NULL
                                  REFERENCES ingestion.connectors(id)
                                  ON DELETE CASCADE,
  timestamp           TIMESTAMPTZ NOT NULL,
  source_count        BIGINT      NOT NULL,
  platform_count      BIGINT      NOT NULL,
  missing_in_platform JSONB       NOT NULL DEFAULT '[]',
  extra_in_platform   JSONB       NOT NULL DEFAULT '[]',
  field_mismatches    JSONB       NOT NULL DEFAULT '[]',
  match_rate          NUMERIC(6, 2) NOT NULL,
  status              TEXT        NOT NULL
                                  CHECK (status IN ('match', 'partial_match', 'mismatch')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for the primary query pattern: list reports for a connector newest-first.
CREATE INDEX IF NOT EXISTS idx_reconciliation_reports_connector_ts
  ON ingestion.reconciliation_reports (connector_id, timestamp DESC, job_id DESC);

-- RLS: reports are isolated per tenant via the connector FK.
-- The application enforces connector ownership before exposing reports so
-- we rely on connector-level RLS rather than duplicating tenant_id here.
ALTER TABLE ingestion.reconciliation_reports ENABLE ROW LEVEL SECURITY;
