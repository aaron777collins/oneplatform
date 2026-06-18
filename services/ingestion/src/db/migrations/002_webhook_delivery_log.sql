-- ============================================================
-- Migration: 002_webhook_delivery_log
-- Adds ingestion.webhook_delivery_log table for per-delivery
-- inspection.  Stores the last 100 deliveries per receiver;
-- the application layer prunes older rows on every INSERT.
--
-- Design notes:
--   - headers / body are stored as JSONB so the UI can render
--     individual fields without parsing text on the fly.
--   - body_truncated flags that the original payload exceeded
--     64 KiB and was cut before storage.
--   - signature_valid is tri-state: true/false/NULL.
--     NULL means the receiver was not found or was disabled
--     before HMAC verification could run.
--   - No RLS: the service role owns the table and the route
--     layer enforces tenant isolation before touching it.
-- ============================================================

CREATE TABLE IF NOT EXISTS ingestion.webhook_delivery_log (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id         UUID        NOT NULL
                                 REFERENCES ingestion.webhook_receivers(id)
                                 ON DELETE CASCADE,
  received_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  headers            JSONB       NOT NULL DEFAULT '{}',
  body               JSONB,                     -- NULL when body was not valid JSON
  body_raw           TEXT,                      -- fallback for non-JSON bodies (truncated to 64 KiB)
  body_truncated     BOOLEAN     NOT NULL DEFAULT false,
  signature_valid    BOOLEAN,                   -- NULL = HMAC not checked (receiver disabled / not found)
  status_code        INTEGER     NOT NULL DEFAULT 200,
  processing_time_ms INTEGER
);

-- Index for the paginated delivery history query: (webhook_id, received_at DESC).
-- Partial on recent rows is not possible without a fixed cutoff, so a plain
-- composite index is used; the 100-row cap per webhook keeps it small.
CREATE INDEX IF NOT EXISTS idx_webhook_delivery_log_webhook_id_received_at
  ON ingestion.webhook_delivery_log (webhook_id, received_at DESC);
