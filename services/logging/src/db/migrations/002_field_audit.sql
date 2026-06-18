-- Logging Service — Field Audit Schema (G-125)
-- ADR-17: Logging Architecture
--
-- Two tables track field-level compliance data:
--   field_changes — immutable record of what changed, who changed it, before/after values
--   field_access  — record of which fields were read and for what declared purpose
--
-- Both tables are append-only. Sensitive field values are redacted by the application
-- layer before insertion; the DB schema stores whatever the service writes.
--
-- Schema is partition-friendly: the primary partition key (entity_type, entity_id) plus
-- a time column (changed_at / accessed_at) supports future range partitioning by time
-- without requiring a schema migration — ADD PARTITION is DDL-only at that point.

-- ---------------------------------------------------------------------------
-- logging.field_changes — one row per changed field per mutation operation
--
-- Separate rows per field (not a JSON blob of all changed fields) because:
--   1. Queries for "history of field X on entity Y" are selective index scans
--      rather than JSON operator scans.
--   2. Per-field rows can be individually retained or purged under compliance rules.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS logging.field_changes (
  id           UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id    TEXT        NOT NULL,
  user_id      TEXT        NOT NULL,
  entity_type  TEXT        NOT NULL,
  entity_id    TEXT        NOT NULL,
  field_name   TEXT        NOT NULL,
  -- NULL old_value means the field was created (action='create')
  -- NULL new_value means the field was deleted (action='delete')
  old_value    JSONB,
  new_value    JSONB,
  action       TEXT        NOT NULL CHECK (action IN ('create', 'update', 'delete')),
  source       TEXT        NOT NULL CHECK (source IN ('api', 'ui', 'system')),
  changed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Primary compliance query: all history for a specific field on a specific entity
-- This index drives getFieldHistory() — the most common read path.
CREATE INDEX IF NOT EXISTS field_changes_entity_field_time_idx
  ON logging.field_changes (entity_type, entity_id, field_name, changed_at DESC);

-- Secondary compliance query: all field changes on a specific entity (any field)
-- Drives getEntityAuditLog() without the field_name filter.
CREATE INDEX IF NOT EXISTS field_changes_entity_time_idx
  ON logging.field_changes (entity_type, entity_id, changed_at DESC);

-- Tenant-scoped compliance queries — admins querying across all entities for a tenant
CREATE INDEX IF NOT EXISTS field_changes_tenant_time_idx
  ON logging.field_changes (tenant_id, changed_at DESC);

-- User-level audit trail — "what fields did user X change?"
CREATE INDEX IF NOT EXISTS field_changes_user_time_idx
  ON logging.field_changes (user_id, changed_at DESC);

-- Retention support: find rows eligible for archival without a full scan
CREATE INDEX IF NOT EXISTS field_changes_changed_at_idx
  ON logging.field_changes (changed_at DESC);

-- ---------------------------------------------------------------------------
-- logging.field_access — one row per access event (may cover multiple fields)
--
-- Logging one row per access event (rather than one per field) because access
-- events are typically coarse ("viewed the connector details page") and the
-- exact list of fields is captured in the fields_accessed JSONB array.
-- This keeps the table from growing 10× per event on wide entities.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS logging.field_access (
  id               UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id        TEXT        NOT NULL,
  user_id          TEXT        NOT NULL,
  entity_type      TEXT        NOT NULL,
  entity_id        TEXT        NOT NULL,
  -- JSONB array of field name strings — ["name", "config", "schedule"]
  fields_accessed  JSONB       NOT NULL DEFAULT '[]',
  -- Declared purpose prevents raw access logs from being ambiguous for GDPR audits
  purpose          TEXT        NOT NULL CHECK (purpose IN ('view', 'export', 'api')),
  accessed_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Primary compliance query: all access events for a specific entity
-- Drives getEntityAccessLog() — the core read path for this table.
CREATE INDEX IF NOT EXISTS field_access_entity_time_idx
  ON logging.field_access (entity_type, entity_id, accessed_at DESC);

-- Tenant-scoped queries
CREATE INDEX IF NOT EXISTS field_access_tenant_time_idx
  ON logging.field_access (tenant_id, accessed_at DESC);

-- User-level access audit — "what did user X access?"
CREATE INDEX IF NOT EXISTS field_access_user_time_idx
  ON logging.field_access (user_id, accessed_at DESC);

-- Retention support
CREATE INDEX IF NOT EXISTS field_access_accessed_at_idx
  ON logging.field_access (accessed_at DESC);

-- ---------------------------------------------------------------------------
-- Grants — logging_service_role gets INSERT/SELECT on both new tables.
-- No UPDATE or DELETE: field audit records are immutable once written.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT ON logging.field_changes TO logging_service_role;
GRANT SELECT, INSERT ON logging.field_access  TO logging_service_role;
