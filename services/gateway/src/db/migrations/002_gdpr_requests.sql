-- ============================================================
-- Migration: 002_gdpr_requests
-- Gateway Service — GDPR data subject request tracking
--
-- GDPR requests are tenant-scoped and user-scoped. The gateway
-- owns this table because it is the orchestrator that fans out
-- deletion/access/export calls to each downstream service.
--
-- Idempotent: uses IF NOT EXISTS throughout.
-- ============================================================

-- GDPR request status lifecycle:
--   pending     → request accepted, not yet processed
--   processing  → fan-out to downstream services in progress
--   completed   → all downstream services confirmed completion
--   failed      → one or more downstream services failed (see error_detail)
CREATE TABLE IF NOT EXISTS gateway.gdpr_requests (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID        NOT NULL REFERENCES auth.tenants(id) ON DELETE CASCADE,
  -- user_id is stored as text rather than a FK to auth.users so that deletion
  -- requests survive the user being anonymised (the row must persist for audit).
  user_id         TEXT        NOT NULL,
  type            TEXT        NOT NULL CHECK (type IN ('access', 'deletion', 'export')),
  status          TEXT        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  -- requester_id tracks WHO submitted the request (may differ from user_id when
  -- a platform-admin submits on behalf of a user).
  requester_id    TEXT        NOT NULL,
  requested_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ,
  -- result_url holds a signed download URL for export requests once the archive
  -- is ready. NULL for access/deletion requests.
  result_url      TEXT,
  -- error_detail captures the first failure message for debugging; never returned
  -- to callers directly — only visible in internal logs and admin queries.
  error_detail    TEXT,

  CONSTRAINT gdpr_requests_result_url_only_for_export
    CHECK (result_url IS NULL OR type = 'export')
);

-- Efficient lookups: list all GDPR requests for a tenant ordered by submission time
CREATE INDEX IF NOT EXISTS idx_gdpr_requests_tenant_id_requested_at
  ON gateway.gdpr_requests(tenant_id, requested_at DESC);

-- Efficient lookups: list all GDPR requests for a specific user within a tenant
CREATE INDEX IF NOT EXISTS idx_gdpr_requests_tenant_user
  ON gateway.gdpr_requests(tenant_id, user_id);

-- Poll for pending requests that can be retried or monitored
CREATE INDEX IF NOT EXISTS idx_gdpr_requests_status
  ON gateway.gdpr_requests(status)
  WHERE status IN ('pending', 'processing');
