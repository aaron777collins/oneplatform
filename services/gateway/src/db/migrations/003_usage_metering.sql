-- ============================================================
-- Migration: 003_usage_metering
-- Gateway Service — usage event log and pre-aggregated summaries
--
-- Design rationale:
--   usage_events is an append-only log keyed on (tenant_id, type, timestamp).
--   usage_summaries stores pre-aggregated hourly/daily/monthly buckets so
--   the billing API can answer "what did tenant X consume this month?" in a
--   single index-scan rather than a full event-log scan.
--   The aggregation job (MeteringService.flushPendingEvents) runs on a timer
--   and merges batched Redis counters into both tables atomically.
--
-- Idempotent: uses IF NOT EXISTS throughout.
-- ============================================================

-- ============================================================
-- gateway.usage_events
--
-- Append-only event log.  Each row records one discrete metering
-- event emitted by the middleware or service layer.  Rows are never
-- updated after insertion — corrections are new events with a negative
-- value (storage_delta can be negative to record freed space).
-- ============================================================
CREATE TABLE IF NOT EXISTS gateway.usage_events (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID        NOT NULL REFERENCES auth.tenants(id) ON DELETE CASCADE,
  type        TEXT        NOT NULL
              CHECK (type IN (
                'api_call',
                'rows_ingested',
                'rows_transformed',
                'storage_delta',
                'pipeline_execution'
              )),
  -- value semantics vary by type:
  --   api_call            → always 1 (count of requests)
  --   rows_ingested       → number of rows in the batch
  --   rows_transformed    → number of rows emitted by a pipeline step
  --   storage_delta       → signed byte delta (positive = added, negative = freed)
  --   pipeline_execution  → always 1 (count of pipeline runs)
  value       BIGINT      NOT NULL,
  -- metadata is a JSONB bag for type-specific context
  -- (e.g. endpoint + method for api_call, connectorId for rows_ingested)
  metadata    JSONB,
  timestamp   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Primary query pattern: events for a tenant in a time window, optionally
-- filtered by type.  The composite index covers all three dimensions.
CREATE INDEX IF NOT EXISTS idx_usage_events_tenant_type_ts
  ON gateway.usage_events(tenant_id, type, timestamp DESC);

-- Retention job: plain timestamp index enables fast range-delete of old rows.
CREATE INDEX IF NOT EXISTS idx_usage_events_timestamp
  ON gateway.usage_events(timestamp);

-- ============================================================
-- gateway.usage_summaries
--
-- Pre-aggregated buckets written by the metering flush job.
-- One row per (tenant_id, period_type, period_start, event_type).
-- The flush job uses ON CONFLICT DO UPDATE (upsert) so the same
-- bucket can be updated incrementally within a period.
-- ============================================================
CREATE TABLE IF NOT EXISTS gateway.usage_summaries (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID        NOT NULL REFERENCES auth.tenants(id) ON DELETE CASCADE,
  -- period_type distinguishes the bucket granularity
  period_type  TEXT        NOT NULL CHECK (period_type IN ('hourly', 'daily', 'monthly')),
  -- period_start is the truncated timestamp of the bucket
  -- (e.g. 2024-01-15 14:00:00 for hourly, 2024-01-15 00:00:00 for daily)
  period_start TIMESTAMPTZ NOT NULL,
  event_type   TEXT        NOT NULL
               CHECK (event_type IN (
                 'api_call',
                 'rows_ingested',
                 'rows_transformed',
                 'storage_delta',
                 'pipeline_execution'
               )),
  total_value  BIGINT      NOT NULL DEFAULT 0,
  event_count  BIGINT      NOT NULL DEFAULT 0,  -- number of events aggregated
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One summary row per (tenant, period granularity, bucket start, event type)
  CONSTRAINT usage_summaries_unique_bucket
    UNIQUE (tenant_id, period_type, period_start, event_type)
);

-- Lookup: all summary buckets for a tenant within a date range
CREATE INDEX IF NOT EXISTS idx_usage_summaries_tenant_period
  ON gateway.usage_summaries(tenant_id, period_type, period_start DESC);

-- updated_at trigger reuses the existing set_updated_at() function
CREATE OR REPLACE TRIGGER set_usage_summaries_updated_at
  BEFORE UPDATE ON gateway.usage_summaries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- gateway.billing_webhook_configs
--
-- One row per tenant, stores the configured billing webhook URL
-- and the threshold values that trigger a delivery.
-- ============================================================
CREATE TABLE IF NOT EXISTS gateway.billing_webhook_configs (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID        NOT NULL REFERENCES auth.tenants(id) ON DELETE CASCADE,
  url               TEXT        NOT NULL,
  -- provider discriminates Stripe vs. generic webhook delivery format
  provider          TEXT        NOT NULL DEFAULT 'custom'
                    CHECK (provider IN ('stripe', 'custom')),
  -- threshold fields: NULL means "never trigger on this dimension"
  api_call_threshold        BIGINT,
  rows_ingested_threshold   BIGINT,
  storage_bytes_threshold   BIGINT,
  -- secret for HMAC signing outbound webhook payloads (AES-256-GCM encrypted)
  secret_encrypted  TEXT,
  enabled           BOOLEAN     NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT billing_webhook_configs_tenant_unique UNIQUE (tenant_id)
);

CREATE OR REPLACE TRIGGER set_billing_webhook_configs_updated_at
  BEFORE UPDATE ON gateway.billing_webhook_configs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
