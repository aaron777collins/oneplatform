-- ============================================================
-- Migration: 001_initial_schema
-- Ingestion Service — connectors, credentials, sync_state,
--                     webhook_receivers, upload_jobs, batch_errors
--
-- Idempotent: uses IF NOT EXISTS and CREATE OR REPLACE throughout.
-- Applied by ingestion_service_role which owns the ingestion schema.
-- ============================================================

CREATE SCHEMA IF NOT EXISTS ingestion;

-- ============================================================
-- set_updated_at() trigger function
--
-- Shared helper for all tables with updated_at. OR REPLACE is
-- safe here: the function body is identical for every table.
-- ============================================================
CREATE OR REPLACE FUNCTION ingestion.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ============================================================
-- ingestion.connectors
--
-- One row per connector instance (a configured external data source
-- for a specific tenant). Config holds non-sensitive settings only;
-- all secrets live in ingestion.credentials.
--
-- RLS: tenants see only their own rows via current_setting('app.tenant_id').
-- The ingestion_service_role bypasses RLS (owns the table).
-- ============================================================
CREATE TABLE IF NOT EXISTS ingestion.connectors (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID        NOT NULL,
  plugin_id       TEXT        NOT NULL,   -- manifest.id of the connector plugin
  instance_id     UUID        NOT NULL,   -- plugin_instances.id in plugin schema
  name            TEXT        NOT NULL,
  description     TEXT,
  config          JSONB       NOT NULL DEFAULT '{}',
  sync_mode       TEXT        NOT NULL DEFAULT 'incremental'
                              CHECK (sync_mode IN ('full', 'incremental')),
  schedule_cron   TEXT,                   -- NULL means manual-only
  is_enabled      BOOLEAN     NOT NULL DEFAULT true,
  created_by      UUID        NOT NULL,   -- auth.users.id
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ,            -- soft delete

  CONSTRAINT connectors_name_tenant_unique UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS idx_connectors_tenant_id
  ON ingestion.connectors (tenant_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_connectors_plugin_id
  ON ingestion.connectors (plugin_id)
  WHERE deleted_at IS NULL;

CREATE OR REPLACE TRIGGER set_connectors_updated_at
  BEFORE UPDATE ON ingestion.connectors
  FOR EACH ROW EXECUTE FUNCTION ingestion.set_updated_at();

-- Row-level security: tenants see only their own connectors.
-- FORCE ROW LEVEL SECURITY ensures ingestion_service_role also checks
-- policy when it explicitly needs to bypass (it does so via SET LOCAL).
ALTER TABLE ingestion.connectors ENABLE ROW LEVEL SECURITY;

CREATE POLICY connectors_tenant_isolation ON ingestion.connectors
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE ingestion.connectors FORCE ROW LEVEL SECURITY;

-- ============================================================
-- ingestion.credentials
--
-- AES-256-GCM encrypted credential blobs. One row per (connector, field).
-- No RLS: only ingestion_service_role may access this table.
-- Ontology service cross-schema grant explicitly revokes SELECT here.
-- ============================================================
CREATE TABLE IF NOT EXISTS ingestion.credentials (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_id    UUID        NOT NULL REFERENCES ingestion.connectors(id) ON DELETE CASCADE,
  field_name      TEXT        NOT NULL,   -- e.g., "api_key", "password", "oauth_token"
  encrypted_blob  TEXT        NOT NULL,   -- base64(salt[32] | iv[12] | authTag[16] | ciphertext)
  key_version     INTEGER     NOT NULL DEFAULT 1,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT credentials_connector_field_unique UNIQUE (connector_id, field_name)
);

CREATE INDEX IF NOT EXISTS idx_credentials_connector_id
  ON ingestion.credentials (connector_id);

-- Index on key_version for the key-rotation job. A partial predicate cannot be
-- used here because PostgreSQL forbids subqueries in index predicates (the max
-- key version is not a constant). A plain b-tree index on key_version still lets
-- the rotation job efficiently range-scan rows below the current maximum.
CREATE INDEX IF NOT EXISTS idx_credentials_key_version
  ON ingestion.credentials (key_version);

CREATE OR REPLACE TRIGGER set_credentials_updated_at
  BEFORE UPDATE ON ingestion.credentials
  FOR EACH ROW EXECUTE FUNCTION ingestion.set_updated_at();

-- ============================================================
-- ingestion.sync_state
--
-- One row per connector. Tracks cursor position and last sync outcome.
-- The cursor is stored opaquely — the service never parses it, so
-- connectors using timestamps, sequence numbers, or pagination tokens
-- all work without schema changes.
-- ============================================================
CREATE TABLE IF NOT EXISTS ingestion.sync_state (
  connector_id     UUID        PRIMARY KEY REFERENCES ingestion.connectors(id) ON DELETE CASCADE,
  last_cursor      TEXT,                   -- opaque; passed directly to connector
  last_sync_at     TIMESTAMPTZ,
  last_sync_job_id TEXT,                   -- BullMQ job ID of last completed sync (integer string, not UUID)
  sync_mode        TEXT        NOT NULL DEFAULT 'incremental'
                               CHECK (sync_mode IN ('full', 'incremental')),
  status           TEXT        NOT NULL DEFAULT 'never_run'
                               CHECK (status IN ('never_run', 'running', 'success', 'failed', 'cancelled')),
  last_error       TEXT,                   -- human-readable error from last failed sync
  last_error_code  TEXT,                   -- machine-readable PluginError.code
  rows_last_sync   BIGINT      DEFAULT 0,
  rows_total       BIGINT      DEFAULT 0,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sync_state_status
  ON ingestion.sync_state (status);

-- ============================================================
-- ingestion.webhook_receivers
--
-- Inbound webhook endpoints. secret_hash holds a bcrypt hash for
-- user-facing "rotate secret" verification; the raw secret for
-- HMAC computation lives in ingestion.credentials (field_name = 'webhook_secret').
--
-- RLS: tenants see only their own rows.
-- ============================================================
CREATE TABLE IF NOT EXISTS ingestion.webhook_receivers (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID        NOT NULL,
  connector_id     UUID        REFERENCES ingestion.connectors(id) ON DELETE SET NULL,
  name             TEXT        NOT NULL,
  description      TEXT,
  path_suffix      TEXT        NOT NULL UNIQUE,  -- used as the {id} URL segment
  secret_hash      TEXT        NOT NULL,          -- bcrypt hash for rotate-secret flows
  hmac_algorithm   TEXT        NOT NULL DEFAULT 'sha256'
                               CHECK (hmac_algorithm IN ('sha256', 'sha512')),
  header_name      TEXT        NOT NULL DEFAULT 'X-Webhook-Signature',
  is_enabled       BOOLEAN     NOT NULL DEFAULT true,
  created_by       UUID        NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ,
  last_received_at TIMESTAMPTZ,
  events_received  BIGINT      NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_webhook_receivers_tenant_id
  ON ingestion.webhook_receivers (tenant_id)
  WHERE deleted_at IS NULL;

-- Routing lookup: this is the hot path for every inbound event.
-- Partial index excludes soft-deleted rows so routing never matches a
-- deleted receiver even if the caller supplies the old path suffix.
CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_receivers_path_suffix
  ON ingestion.webhook_receivers (path_suffix)
  WHERE deleted_at IS NULL;

CREATE OR REPLACE TRIGGER set_webhook_receivers_updated_at
  BEFORE UPDATE ON ingestion.webhook_receivers
  FOR EACH ROW EXECUTE FUNCTION ingestion.set_updated_at();

ALTER TABLE ingestion.webhook_receivers ENABLE ROW LEVEL SECURITY;

CREATE POLICY webhook_receivers_tenant_isolation ON ingestion.webhook_receivers
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE ingestion.webhook_receivers FORCE ROW LEVEL SECURITY;

-- ============================================================
-- ingestion.upload_jobs
--
-- Tracks file upload processing lifecycle. MinIO key is set after
-- the file is successfully streamed. inferred_schema is populated
-- after the first 200 rows are parsed.
--
-- RLS: tenants see only their own rows.
-- ============================================================
CREATE TABLE IF NOT EXISTS ingestion.upload_jobs (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID        NOT NULL,
  connector_id     UUID        REFERENCES ingestion.connectors(id) ON DELETE SET NULL,
  filename         TEXT        NOT NULL,
  content_type     TEXT        NOT NULL,   -- e.g., "text/csv", "application/json"
  file_size_bytes  BIGINT,
  minio_key        TEXT,                   -- file-uploads/{tenantId}/{jobId}/{filename}
  status           TEXT        NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending', 'uploading', 'parsing',
                                                 'staging', 'complete', 'failed')),
  rows_parsed      BIGINT      NOT NULL DEFAULT 0,
  rows_staged      BIGINT      NOT NULL DEFAULT 0,
  rows_failed      BIGINT      NOT NULL DEFAULT 0,
  error            TEXT,
  inferred_schema  JSONB,                  -- populated after parsing first 200 rows
  created_by       UUID        NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_upload_jobs_tenant_id
  ON ingestion.upload_jobs (tenant_id, created_at DESC);

-- Partial index covering only in-flight jobs; complete/failed rows
-- are excluded so background monitoring queries stay fast.
CREATE INDEX IF NOT EXISTS idx_upload_jobs_status
  ON ingestion.upload_jobs (status)
  WHERE status NOT IN ('complete', 'failed');

CREATE OR REPLACE TRIGGER set_upload_jobs_updated_at
  BEFORE UPDATE ON ingestion.upload_jobs
  FOR EACH ROW EXECUTE FUNCTION ingestion.set_updated_at();

ALTER TABLE ingestion.upload_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY upload_jobs_tenant_isolation ON ingestion.upload_jobs
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE ingestion.upload_jobs FORCE ROW LEVEL SECURITY;

-- ============================================================
-- ingestion.batch_errors
--
-- Per-record normalization failures within a sync batch. Rows here
-- do not abort the sync job; they are surfaced in the progress UI
-- and retained for 30 days by a background cleanup job.
-- ============================================================
CREATE TABLE IF NOT EXISTS ingestion.batch_errors (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_job_id   TEXT        NOT NULL,   -- BullMQ job ID
  batch_id      UUID        NOT NULL,
  connector_id  UUID        NOT NULL,
  source_id     TEXT        NOT NULL,
  error_code    TEXT        NOT NULL,
  error_message TEXT        NOT NULL,
  raw_record    JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_batch_errors_sync
  ON ingestion.batch_errors (sync_job_id, batch_id);

-- ============================================================
-- ingestion.schema_migrations
--
-- Migration runner bookkeeping. Matches the pattern used by the
-- gateway service (services/gateway/src/db/migrate.ts).
-- ============================================================
CREATE TABLE IF NOT EXISTS ingestion.schema_migrations (
  version    TEXT        PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- Cross-schema access grants
--
-- The Ontology Service needs SELECT on all ingestion tables to read
-- raw_* tables during mapping jobs. The credentials table is explicitly
-- excluded: credential values must never be readable outside the
-- ingestion service process.
-- ============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ontology_service_role') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA ingestion TO ontology_service_role';
    EXECUTE 'GRANT SELECT ON ALL TABLES IN SCHEMA ingestion TO ontology_service_role';
    -- Revoke credentials access from ontology: only ingestion_service_role
    -- may read encrypted blobs, enforcing the principle of least privilege.
    EXECUTE 'REVOKE SELECT ON ingestion.credentials FROM ontology_service_role';
  END IF;
END;
$$;
