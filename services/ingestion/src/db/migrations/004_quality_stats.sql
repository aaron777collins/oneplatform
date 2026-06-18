-- ============================================================
-- Migration: 003_quality_stats
-- Ingestion Service — per-connector data quality statistics
--
-- Stores the running averages and field-level metadata used by the
-- DataQualityService to detect anomalies (null rate spikes, volume
-- drops, type mismatches). One row per connector; updated after each
-- processed batch. All aggregated stats are stored as JSONB to avoid
-- schema churn as the set of tracked metrics evolves.
--
-- Idempotent: uses IF NOT EXISTS throughout.
-- Applied by ingestion_service_role which owns the ingestion schema.
-- ============================================================

CREATE TABLE IF NOT EXISTS ingestion.connector_quality_stats (
  connector_id      UUID        PRIMARY KEY
                    REFERENCES ingestion.connectors(id) ON DELETE CASCADE,

  -- Rolling average batch record count (exponential moving average).
  avg_batch_size    DOUBLE PRECISION NOT NULL DEFAULT 0,

  -- Per-field rolling average null rates: { "fieldName": 0.03, ... }
  field_null_rates  JSONB       NOT NULL DEFAULT '{}',

  -- Per-field observed JS type distributions across all batches:
  -- { "fieldName": { "string": 142, "number": 8 }, ... }
  field_types       JSONB       NOT NULL DEFAULT '{}',

  -- Ordered list of all field names observed at least once.
  known_fields      TEXT[]      NOT NULL DEFAULT '{}',

  -- Count of batches included in the running averages. Used to gate
  -- volume checks (requires MIN_BATCHES_FOR_VOLUME_CHECK) and to
  -- tune the EMA smoothing factor during early convergence.
  batch_count       INTEGER     NOT NULL DEFAULT 0,

  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for the watchdog / retention jobs that scan all quality stats rows.
-- Single-column index on the PK is implicit; this index supports ordered
-- iteration needed by any future bulk export.
CREATE INDEX IF NOT EXISTS idx_quality_stats_updated_at
  ON ingestion.connector_quality_stats (updated_at DESC);
