-- ============================================================
-- Migration: 001_initial_schema
-- Ontology Service — all 8 tables in the ontology schema.
-- Idempotent: safe to run on every service startup.
-- ============================================================

CREATE SCHEMA IF NOT EXISTS ontology;

-- ============================================================
-- ontology.entities
-- ============================================================
CREATE TABLE IF NOT EXISTS ontology.entities (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID        NOT NULL,
  name         TEXT        NOT NULL,
  slug         TEXT        NOT NULL,
  version      INTEGER     NOT NULL DEFAULT 1,
  description  TEXT,
  is_public    BOOLEAN     NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   UUID        NOT NULL,
  deleted_at   TIMESTAMPTZ,

  CONSTRAINT uq_entity_tenant_slug      UNIQUE (tenant_id, slug),
  CONSTRAINT chk_entity_slug            CHECK (slug ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT chk_entity_name_length     CHECK (char_length(name) BETWEEN 1 AND 64),
  CONSTRAINT chk_entity_version_positive CHECK (version > 0)
);

CREATE INDEX IF NOT EXISTS idx_entities_tenant_id   ON ontology.entities (tenant_id)       WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_entities_tenant_slug ON ontology.entities (tenant_id, slug)  WHERE deleted_at IS NULL;

-- ============================================================
-- ontology.fields
-- ============================================================
CREATE TABLE IF NOT EXISTS ontology.fields (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id        UUID        NOT NULL REFERENCES ontology.entities(id) ON DELETE CASCADE,
  tenant_id        UUID        NOT NULL,
  name             TEXT        NOT NULL,
  slug             TEXT        NOT NULL,
  field_type       TEXT        NOT NULL,
  required         BOOLEAN     NOT NULL DEFAULT false,
  nullable         BOOLEAN     NOT NULL DEFAULT true,
  default_value    JSONB,
  validation_rules JSONB       NOT NULL DEFAULT '[]',
  enum_values      TEXT[],
  array_item_type  TEXT,
  ref_entity_id    UUID        REFERENCES ontology.entities(id) ON DELETE SET NULL,
  is_indexed       BOOLEAN     NOT NULL DEFAULT false,
  is_unique        BOOLEAN     NOT NULL DEFAULT false,
  sort_order       INTEGER     NOT NULL DEFAULT 0,
  system_generated BOOLEAN     NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ,

  CONSTRAINT uq_field_entity_slug UNIQUE (entity_id, slug),
  CONSTRAINT chk_field_slug       CHECK (slug ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT chk_field_slug_no_system_prefix CHECK (slug NOT LIKE '\_%'),
  CONSTRAINT chk_field_name_length CHECK (char_length(name) BETWEEN 1 AND 64),
  CONSTRAINT chk_field_type CHECK (field_type IN (
    'string', 'number', 'boolean', 'date', 'json', 'reference', 'enum', 'array'
  )),
  CONSTRAINT chk_enum_values CHECK (
    (field_type = 'enum' AND enum_values IS NOT NULL AND array_length(enum_values, 1) >= 1)
    OR field_type != 'enum'
  ),
  CONSTRAINT chk_array_item_type CHECK (
    (field_type = 'array' AND array_item_type IS NOT NULL)
    OR field_type != 'array'
  ),
  CONSTRAINT chk_ref_entity CHECK (
    (field_type = 'reference' AND ref_entity_id IS NOT NULL)
    OR field_type != 'reference'
  ),
  CONSTRAINT chk_required_not_nullable CHECK (
    NOT (required = true AND nullable = true AND default_value IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_fields_entity_id  ON ontology.fields (entity_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_fields_ref_entity ON ontology.fields (ref_entity_id)
  WHERE ref_entity_id IS NOT NULL AND deleted_at IS NULL;

-- ============================================================
-- ontology.relationships
-- ============================================================
CREATE TABLE IF NOT EXISTS ontology.relationships (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID        NOT NULL,
  from_entity_id    UUID        NOT NULL REFERENCES ontology.entities(id) ON DELETE CASCADE,
  to_entity_id      UUID        NOT NULL REFERENCES ontology.entities(id) ON DELETE CASCADE,
  relationship_type TEXT        NOT NULL,
  from_field_name   TEXT        NOT NULL,
  to_field_name     TEXT,
  join_table_name   TEXT,
  cascade_delete    BOOLEAN     NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_relationship       UNIQUE (from_entity_id, from_field_name),
  CONSTRAINT chk_relationship_type CHECK (relationship_type IN ('1:1', '1:N', 'M:N')),
  CONSTRAINT chk_mn_join_table     CHECK (
    (relationship_type = 'M:N' AND join_table_name IS NOT NULL)
    OR relationship_type != 'M:N'
  ),
  CONSTRAINT chk_no_self_ref       CHECK (from_entity_id != to_entity_id)
);

CREATE INDEX IF NOT EXISTS idx_relationships_from_entity ON ontology.relationships (from_entity_id);
CREATE INDEX IF NOT EXISTS idx_relationships_to_entity   ON ontology.relationships (to_entity_id);

-- ============================================================
-- ontology.mapping_rules
-- ============================================================
CREATE TABLE IF NOT EXISTS ontology.mapping_rules (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID        NOT NULL,
  connector_id      UUID        NOT NULL,
  source_field_path TEXT        NOT NULL,
  target_entity_id  UUID        NOT NULL REFERENCES ontology.entities(id) ON DELETE CASCADE,
  target_field_id   UUID        NOT NULL REFERENCES ontology.fields(id) ON DELETE CASCADE,
  transform_type    TEXT        NOT NULL DEFAULT 'direct',
  transform         TEXT,
  is_active         BOOLEAN     NOT NULL DEFAULT true,
  priority          INTEGER     NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chk_transform_type CHECK (transform_type IN ('direct', 'expression', 'constant', 'template')),
  CONSTRAINT chk_expression_not_null CHECK (
    (transform_type IN ('expression', 'constant', 'template') AND transform IS NOT NULL)
    OR transform_type = 'direct'
  )
);

CREATE INDEX IF NOT EXISTS idx_mapping_rules_connector     ON ontology.mapping_rules (connector_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_mapping_rules_target_entity ON ontology.mapping_rules (target_entity_id) WHERE is_active;

-- ============================================================
-- ontology.migrations
-- ============================================================
CREATE TABLE IF NOT EXISTS ontology.migrations (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID        NOT NULL,
  entity_id        UUID        NOT NULL REFERENCES ontology.entities(id),
  from_version     INTEGER     NOT NULL,
  to_version       INTEGER     NOT NULL,
  change_type      TEXT        NOT NULL,
  is_breaking      BOOLEAN     NOT NULL DEFAULT false,
  change_plan      JSONB       NOT NULL,
  status           TEXT        NOT NULL DEFAULT 'pending_confirmation',
  migration_job_id UUID,
  union_view_name  TEXT,
  started_at       TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  error_details    JSONB,
  confirmed_by     UUID,
  confirmed_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chk_migration_status CHECK (status IN (
    'pending_confirmation', 'confirmed', 'running', 'complete', 'failed', 'rolled_back'
  )),
  CONSTRAINT chk_migration_change_type CHECK (change_type IN (
    'add_field', 'remove_field', 'rename_field', 'change_field_type',
    'add_entity', 'remove_entity', 'add_relationship', 'remove_relationship',
    'change_validation', 'compound'
  ))
);

CREATE INDEX IF NOT EXISTS idx_migrations_entity_id ON ontology.migrations (entity_id);
CREATE INDEX IF NOT EXISTS idx_migrations_status    ON ontology.migrations (status)
  WHERE status NOT IN ('complete', 'rolled_back');
CREATE INDEX IF NOT EXISTS idx_migrations_tenant_id ON ontology.migrations (tenant_id);

-- ============================================================
-- ontology.shadow_table_registry
-- ============================================================
CREATE TABLE IF NOT EXISTS ontology.shadow_table_registry (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  migration_id  UUID        NOT NULL REFERENCES ontology.migrations(id) ON DELETE CASCADE,
  entity_type   TEXT        NOT NULL,
  batch_id      TEXT        NOT NULL,
  table_name    TEXT        NOT NULL,
  schema_name   TEXT        NOT NULL,
  row_count     BIGINT      NOT NULL,
  batch_index   INTEGER     NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'active',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_shadow_table UNIQUE (table_name, schema_name),
  CONSTRAINT chk_shadow_status CHECK (status IN ('active', 'dropped', 'corrupt', 'rollback_unavailable'))
);

CREATE INDEX IF NOT EXISTS idx_shadow_registry_migration ON ontology.shadow_table_registry (migration_id);
CREATE INDEX IF NOT EXISTS idx_shadow_registry_active    ON ontology.shadow_table_registry (status, created_at)
  WHERE status = 'active';

-- ============================================================
-- ontology.mapping_errors
-- ============================================================
CREATE TABLE IF NOT EXISTS ontology.mapping_errors (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID        NOT NULL,
  connector_id  UUID        NOT NULL,
  batch_id      TEXT        NOT NULL,
  raw_id        TEXT        NOT NULL,
  entity_type   TEXT        NOT NULL,
  error_fields  TEXT[]      NOT NULL,
  error_details JSONB       NOT NULL,
  raw_data      JSONB       NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mapping_errors_connector ON ontology.mapping_errors (connector_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mapping_errors_batch     ON ontology.mapping_errors (batch_id);
CREATE INDEX IF NOT EXISTS idx_mapping_errors_tenant    ON ontology.mapping_errors (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mapping_errors_raw_data  ON ontology.mapping_errors USING GIN (raw_data jsonb_path_ops);

-- ============================================================
-- ontology.draft_ontologies
-- ============================================================
CREATE TABLE IF NOT EXISTS ontology.draft_ontologies (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID        NOT NULL,
  connector_id     UUID        NOT NULL,
  inferred_schema  JSONB       NOT NULL,
  status           TEXT        NOT NULL DEFAULT 'draft',
  sample_batch_id  TEXT        NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at     TIMESTAMPTZ,
  confirmed_by     UUID,

  CONSTRAINT chk_draft_status CHECK (status IN ('draft', 'confirmed', 'rejected'))
);

CREATE INDEX IF NOT EXISTS idx_draft_ontologies_connector ON ontology.draft_ontologies (connector_id, status);
CREATE INDEX IF NOT EXISTS idx_draft_ontologies_tenant    ON ontology.draft_ontologies (tenant_id);
