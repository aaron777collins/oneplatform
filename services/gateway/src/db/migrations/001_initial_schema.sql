-- ============================================================
-- Migration: 001_initial_schema
-- Gateway Service — webhooks, webhook_deliveries, rate_limit_config
--
-- Idempotent: uses IF NOT EXISTS throughout.
-- Applied by gateway_service_role which holds USAGE + CREATE on gateway schema.
-- ============================================================

CREATE SCHEMA IF NOT EXISTS gateway;

-- ============================================================
-- set_updated_at() trigger function
--
-- Shared helper used by all tables with an updated_at column.
-- IF NOT EXISTS prevents failure when multiple Gateway replicas race at startup.
-- ============================================================
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ============================================================
-- gateway.webhooks
--
-- Registered outbound webhook endpoints. One row per endpoint URL
-- registered by a tenant. Fan-out logic lives in application code.
-- ============================================================
CREATE TABLE IF NOT EXISTS gateway.webhooks (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID        NOT NULL REFERENCES auth.tenants(id) ON DELETE CASCADE,
  url             TEXT        NOT NULL,
  events          TEXT[]      NOT NULL,  -- event type patterns, e.g. {"pipeline.*","data.created"}
  secret_hash     TEXT        NOT NULL,  -- bcrypt hash of the 32-byte raw secret
  secret_encrypted TEXT       NOT NULL,  -- AES-256-GCM ciphertext; used by delivery worker to sign payloads
  description     TEXT,
  enabled         BOOLEAN     NOT NULL DEFAULT true,
  custom_headers  JSONB,                 -- {"Authorization": "Bearer <token>"}
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  throttled_until TIMESTAMPTZ,           -- NULL = not throttled; set when consecutive_failures >= 5
  total_deliveries       BIGINT NOT NULL DEFAULT 0,
  successful_deliveries  BIGINT NOT NULL DEFAULT 0,
  failed_deliveries      BIGINT NOT NULL DEFAULT 0,
  last_delivery_at       TIMESTAMPTZ,
  last_delivery_status   TEXT CHECK (last_delivery_status IN ('success', 'failed')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT webhooks_url_not_empty    CHECK (url <> ''),
  CONSTRAINT webhooks_events_not_empty CHECK (array_length(events, 1) > 0),
  CONSTRAINT webhooks_max_events       CHECK (array_length(events, 1) <= 50)
);

-- Efficient lookup: all enabled webhooks for a tenant (fan-out on event receipt)
CREATE INDEX IF NOT EXISTS idx_webhooks_tenant_id
  ON gateway.webhooks(tenant_id)
  WHERE enabled = true;

-- Throttle check: find throttled webhooks that are ready to un-throttle
CREATE INDEX IF NOT EXISTS idx_webhooks_throttled_until
  ON gateway.webhooks(throttled_until)
  WHERE throttled_until IS NOT NULL;

-- updated_at trigger
CREATE OR REPLACE TRIGGER set_webhooks_updated_at
  BEFORE UPDATE ON gateway.webhooks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- gateway.webhook_deliveries
--
-- Delivery log. Retains the last 100 deliveries per webhook,
-- with a 7-day time-based retention enforced by a background job.
-- The success column is computed so the delivery worker never
-- miscategorises a result via a boolean flag.
-- ============================================================
CREATE TABLE IF NOT EXISTS gateway.webhook_deliveries (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id      UUID        NOT NULL REFERENCES gateway.webhooks(id) ON DELETE CASCADE,
  tenant_id       UUID        NOT NULL,  -- denormalized for retention job efficiency
  event_id        UUID        NOT NULL,  -- PlatformEvent.eventId (idempotency key)
  event_type      TEXT        NOT NULL,
  delivery_id     UUID        NOT NULL,  -- stable across retries; UUIDv4 generated at first attempt
  attempt         INTEGER     NOT NULL DEFAULT 1,
  requested_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at    TIMESTAMPTZ,
  status_code     INTEGER,               -- NULL on timeout or DNS failure
  response_body   TEXT,                  -- first 1024 bytes of response body
  error           TEXT,                  -- error message if no HTTP response
  duration_ms     INTEGER,
  success         BOOLEAN     NOT NULL GENERATED ALWAYS AS (
                    status_code >= 200 AND status_code < 300
                  ) STORED,

  CONSTRAINT webhook_deliveries_attempt_positive CHECK (attempt >= 1 AND attempt <= 9)
);

-- Fan-out: all deliveries for a specific webhook in reverse chronological order
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook_id_requested_at
  ON gateway.webhook_deliveries(webhook_id, requested_at DESC);

-- Retention job: delete deliveries older than 7 days
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_requested_at
  ON gateway.webhook_deliveries(requested_at)
  WHERE requested_at < now() - INTERVAL '7 days';

-- Idempotency lookup: has this event_id + webhook already been successfully delivered?
CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_deliveries_event_delivery
  ON gateway.webhook_deliveries(webhook_id, event_id, attempt);

-- ============================================================
-- gateway.rate_limit_config
--
-- Per-tenant rate limit tier overrides. Global defaults come from
-- environment variables; this table stores only deviations from those
-- defaults. Cached in-memory (LRU, 1000 entries, 5-minute TTL) and
-- invalidated via Redis pub/sub on update.
-- ============================================================
CREATE TABLE IF NOT EXISTS gateway.rate_limit_config (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID        NOT NULL REFERENCES auth.tenants(id) ON DELETE CASCADE,
  tier_name        TEXT        NOT NULL,  -- 'standard' | 'pro' | 'enterprise' | 'custom'

  -- Per-tenant limits (NULL = use global default)
  req_per_min_tenant     INTEGER CHECK (req_per_min_tenant > 0),
  req_per_min_api_key    INTEGER CHECK (req_per_min_api_key > 0),
  burst_multiplier       NUMERIC(4,2) DEFAULT 2.0 CHECK (burst_multiplier >= 1.0 AND burst_multiplier <= 10.0),
  burst_duration_sec     INTEGER DEFAULT 5 CHECK (burst_duration_sec BETWEEN 1 AND 60),

  -- Specific API-key overrides (NULL = no key-level customization)
  api_key_overrides      JSONB,  -- {"keyId": {"req_per_min": 2000}}

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT rate_limit_config_tenant_unique UNIQUE (tenant_id)
);

CREATE OR REPLACE TRIGGER set_rate_limit_config_updated_at
  BEFORE UPDATE ON gateway.rate_limit_config
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
