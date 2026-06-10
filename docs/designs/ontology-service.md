# Ontology Service — L2 Service-Level Design

**Service:** ontology-service  
**Port:** 3003  
**Schema:** `ontology`  
**Network:** `oneplatform-internal`  
**PgBouncer pool mode:** Session (required for LISTEN/NOTIFY and advisory locks)  
**Document status:** Approved  
**Last updated:** 2026-06-10

---

## Table of Contents

1. [Service Overview](#1-service-overview)
2. [Database Schema](#2-database-schema)
3. [API Endpoints](#3-api-endpoints)
4. [Schema Engine](#4-schema-engine)
5. [Relationship Management](#5-relationship-management)
6. [Mapping Rules](#6-mapping-rules)
7. [Schema Migration System](#7-schema-migration-system)
8. [Code Generation](#8-code-generation)
9. [Ontology Cache](#9-ontology-cache)
10. [Internal Endpoints](#10-internal-endpoints)
11. [Inter-Service Communication](#11-inter-service-communication)
12. [Security Design](#12-security-design)
13. [Error Handling](#13-error-handling)
14. [Observability](#14-observability)
15. [Testing Strategy](#15-testing-strategy)
16. [Deployment](#16-deployment)

---

## 1. Service Overview

### Responsibility

The Ontology Service is the schema engine for OnePlatform. Every other service consumes its output; it is the canonical source of truth for what data looks like on this platform instance. Its specific responsibilities are:

- **Entity management:** CRUD for entity type definitions (name, version, description, fields, relationships). Entities map to dynamic tables in `tenant_{tenantId}.*`.
- **Field type system:** Enforces the 8 supported field types (string, number, boolean, date, json, reference, enum, array) with validation rules and default values.
- **Relationship management:** Tracks 1:1, 1:N, and M:N relationships between entities; generates join tables for M:N relationships.
- **Mapping rules:** Translates raw connector data (in `DataEnvelope` form) to typed entity records via configurable per-field mapping rules that include JS expression transforms.
- **Schema migration:** Detects backward-compatible vs. breaking schema changes; orchestrates UNION view dual-schema windows during migrations; manages per-batch shadow tables; coordinates the three-tier orphan cleanup background job.
- **Code generation:** Produces TypeScript interface types, Zod validators, and API route definitions from the live ontology schema. Generated artifacts are consumed by the Gateway Service for auto-generated REST endpoints.
- **Draft ontology management:** Stores schema shapes inferred from raw connector data before the user confirms a mapping.
- **Cache publication:** Publishes `ontology:changed` events to Redis pub/sub so all consumer services hot-swap their in-memory ontology snapshots.

### Network Placement

The service runs exclusively on `oneplatform-internal`. It does not have a public port and is not reachable from `oneplatform-public` or `oneplatform-sandbox`. All external access is brokered by the Gateway Service.

### Startup Dependencies

Before the service begins accepting requests it must satisfy the following startup checks, enforced by the `createApp()` readiness gate from `@oneplatform/core`:

| Dependency | Check | Failure action |
|---|---|---|
| PostgreSQL (via PgBouncer, session mode) | Run `SELECT 1` against `ontology` schema | Retry 5x with 2s backoff; abort with `STARTUP_FAILED` if all fail |
| Redis | PING to op_ontology ACL user | Retry 5x with 2s backoff; service can start degraded (no cache pub/sub) but logs warning |
| Execution Service | `GET http://execution-service:3005/readyz` | Retry 3x; log warning if unreachable. Mapping jobs are queued anyway; expression transforms will fail at job-process time if still down |
| `ontology` schema existence | `SELECT schema_name FROM information_schema.schemata WHERE schema_name='ontology'` | Run `CREATE SCHEMA IF NOT EXISTS ontology` + all migrations if schema absent |

The Docker Compose `healthcheck` for this service is `GET /healthz` with a 120s startup timeout and 10s interval.

The service subscribes to `LISTEN ontology_advisory` on its single session-mode connection at startup to participate in advisory-lock coordination for concurrent migration detection.

---

## 2. Database Schema

All tables live in the `ontology` schema, owned by `ontology_service_role`. No other service role has write access to these tables. The Ingestion Service has read access to `ingestion.*`; the Ontology Service has read access to `ingestion.*` (cross-schema read exception documented in the L1 design).

### 2.1 `ontology.entities`

```sql
CREATE TABLE ontology.entities (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID        NOT NULL,
  name          TEXT        NOT NULL,                 -- e.g. "Product", "Order"
  slug          TEXT        NOT NULL,                 -- URL-safe lowercase, e.g. "product"
  version       INTEGER     NOT NULL DEFAULT 1,
  description   TEXT,
  is_public     BOOLEAN     NOT NULL DEFAULT false,   -- guest role may read if true
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    UUID        NOT NULL,                 -- auth.users.id
  deleted_at    TIMESTAMPTZ,                          -- soft delete; NULL = active

  CONSTRAINT uq_entity_tenant_slug UNIQUE (tenant_id, slug),
  CONSTRAINT chk_entity_slug CHECK (slug ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT chk_entity_name_length CHECK (char_length(name) BETWEEN 1 AND 64),
  CONSTRAINT chk_entity_version_positive CHECK (version > 0)
);

CREATE INDEX idx_entities_tenant_id ON ontology.entities (tenant_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_entities_tenant_slug ON ontology.entities (tenant_id, slug) WHERE deleted_at IS NULL;
```

**Rationale for `slug`:** The entity slug is used in generated API paths (`/api/v1/data/{slug}`), table names (`tenant_{tenantId}.{slug}`), and Redis cache keys. Using a separate validated slug column avoids transforming `name` at call sites and prevents name changes from silently breaking URL paths.

**Rationale for soft delete:** Deleting an entity with existing data is a breaking change. Soft-delete preserves the row for migration audit, foreign key integrity on `ontology.fields`, and rollback reference.

### 2.2 `ontology.fields`

```sql
CREATE TABLE ontology.fields (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id       UUID        NOT NULL REFERENCES ontology.entities(id) ON DELETE CASCADE,
  tenant_id       UUID        NOT NULL,
  name            TEXT        NOT NULL,
  slug            TEXT        NOT NULL,               -- matches generated column name in tenant table
  field_type      TEXT        NOT NULL,
  -- field_type is one of: string | number | boolean | date | json | reference | enum | array
  required        BOOLEAN     NOT NULL DEFAULT false,
  nullable        BOOLEAN     NOT NULL DEFAULT true,
  default_value   JSONB,                              -- NULL means no default
  validation_rules JSONB      NOT NULL DEFAULT '[]',  -- array of ValidationRule objects
  enum_values     TEXT[],                             -- populated only when field_type = 'enum'
  array_item_type TEXT,                               -- populated only when field_type = 'array'
  ref_entity_id   UUID        REFERENCES ontology.entities(id) ON DELETE SET NULL,
  -- ref_entity_id populated only when field_type = 'reference'
  is_indexed      BOOLEAN     NOT NULL DEFAULT false,
  is_unique       BOOLEAN     NOT NULL DEFAULT false,
  sort_order      INTEGER     NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ,                        -- soft delete

  CONSTRAINT uq_field_entity_slug UNIQUE (entity_id, slug),
  CONSTRAINT chk_field_slug CHECK (slug ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT chk_field_name_length CHECK (char_length(name) BETWEEN 1 AND 64),
  CONSTRAINT chk_field_type CHECK (field_type IN (
    'string', 'number', 'boolean', 'date', 'json', 'reference', 'enum', 'array'
  )),
  CONSTRAINT chk_enum_values CHECK (
    (field_type = 'enum' AND enum_values IS NOT NULL AND array_length(enum_values, 1) >= 1)
    OR (field_type != 'enum')
  ),
  CONSTRAINT chk_array_item_type CHECK (
    (field_type = 'array' AND array_item_type IS NOT NULL)
    OR (field_type != 'array')
  ),
  CONSTRAINT chk_ref_entity CHECK (
    (field_type = 'reference' AND ref_entity_id IS NOT NULL)
    OR (field_type != 'reference')
  ),
  CONSTRAINT chk_required_not_nullable CHECK (
    NOT (required = true AND nullable = true AND default_value IS NULL)
    -- A required field with no default must be NOT NULL; allowing nullable=true here
    -- would mean the Zod validator and the Postgres column disagree.
    -- This constraint prevents that inconsistency at the schema level.
  )
);

CREATE INDEX idx_fields_entity_id ON ontology.fields (entity_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_fields_ref_entity ON ontology.fields (ref_entity_id) WHERE ref_entity_id IS NOT NULL AND deleted_at IS NULL;
```

**Rationale for `validation_rules` JSONB:** Validation rules are extensible (min/max length, regex pattern, min/max value, custom message). Using a JSONB array avoids a separate junction table for a per-field collection that is always read with the field. The structure of each element is:

```typescript
interface ValidationRule {
  type: 'min' | 'max' | 'minLength' | 'maxLength' | 'pattern' | 'email' | 'url' | 'custom';
  value?: number | string;
  message?: string;  // user-facing error message override
}
```

### 2.3 `ontology.relationships`

```sql
CREATE TABLE ontology.relationships (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID        NOT NULL,
  from_entity_id  UUID        NOT NULL REFERENCES ontology.entities(id) ON DELETE CASCADE,
  to_entity_id    UUID        NOT NULL REFERENCES ontology.entities(id) ON DELETE CASCADE,
  relationship_type TEXT      NOT NULL,  -- '1:1' | '1:N' | 'M:N'
  from_field_name TEXT        NOT NULL,  -- field name on the FROM entity side
  to_field_name   TEXT,                  -- field name on the TO entity side (for bidirectional nav)
  join_table_name TEXT,                  -- populated for M:N; e.g. "product_tag"
  cascade_delete  BOOLEAN     NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_relationship UNIQUE (from_entity_id, from_field_name),
  CONSTRAINT chk_relationship_type CHECK (relationship_type IN ('1:1', '1:N', 'M:N')),
  CONSTRAINT chk_mn_join_table CHECK (
    (relationship_type = 'M:N' AND join_table_name IS NOT NULL)
    OR (relationship_type != 'M:N')
  ),
  CONSTRAINT chk_no_self_ref CHECK (from_entity_id != to_entity_id)
);

CREATE INDEX idx_relationships_from_entity ON ontology.relationships (from_entity_id);
CREATE INDEX idx_relationships_to_entity   ON ontology.relationships (to_entity_id);
```

**M:N join table naming convention:** `{from_slug}_{to_slug}` (alphabetically sorted to ensure the same pair always resolves to the same name regardless of which direction the relationship was defined). Stored explicitly in `join_table_name` to make it queryable without recomputation.

### 2.4 `ontology.mapping_rules`

```sql
CREATE TABLE ontology.mapping_rules (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID        NOT NULL,
  connector_id        UUID        NOT NULL,  -- ingestion.connectors.id (read-only cross-schema ref)
  source_field_path   TEXT        NOT NULL,  -- dot-notation into DataEnvelope.data, e.g. "address.city"
  target_entity_id    UUID        NOT NULL REFERENCES ontology.entities(id) ON DELETE CASCADE,
  target_field_id     UUID        NOT NULL REFERENCES ontology.fields(id) ON DELETE CASCADE,
  transform_type      TEXT        NOT NULL DEFAULT 'direct',
  -- 'direct' | 'expression' | 'constant' | 'template'
  transform           TEXT,
  -- For 'expression': JS expression string, e.g. "value.trim().toLowerCase()"
  -- For 'constant': JSON-encoded constant value
  -- For 'template': string template with ${value} placeholder
  is_active           BOOLEAN     NOT NULL DEFAULT true,
  priority            INTEGER     NOT NULL DEFAULT 0,  -- higher = evaluated first for same field
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chk_transform_type CHECK (transform_type IN ('direct', 'expression', 'constant', 'template')),
  CONSTRAINT chk_expression_not_null CHECK (
    (transform_type IN ('expression', 'constant', 'template') AND transform IS NOT NULL)
    OR transform_type = 'direct'
  )
);

CREATE INDEX idx_mapping_rules_connector ON ontology.mapping_rules (connector_id) WHERE is_active;
CREATE INDEX idx_mapping_rules_target_entity ON ontology.mapping_rules (target_entity_id) WHERE is_active;
```

### 2.5 `ontology.migrations`

```sql
CREATE TABLE ontology.migrations (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID        NOT NULL,
  entity_id       UUID        NOT NULL REFERENCES ontology.entities(id),
  from_version    INTEGER     NOT NULL,
  to_version      INTEGER     NOT NULL,
  change_type     TEXT        NOT NULL,
  -- 'add_field' | 'remove_field' | 'rename_field' | 'change_field_type' |
  -- 'add_entity' | 'remove_entity' | 'add_relationship' | 'remove_relationship' |
  -- 'change_validation' | 'compound'
  is_breaking     BOOLEAN     NOT NULL DEFAULT false,
  change_plan     JSONB       NOT NULL,
  -- Describes affected row count, dependent pipelines, dependent apps, generated SQL plan
  status          TEXT        NOT NULL DEFAULT 'pending_confirmation',
  -- 'pending_confirmation' | 'confirmed' | 'running' | 'complete' | 'failed' | 'rolled_back'
  migration_job_id UUID,                              -- BullMQ job ID in Pipeline Service
  union_view_name TEXT,                               -- e.g. "v_product_migration_{id}"
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  error_details   JSONB,
  confirmed_by    UUID,                               -- auth.users.id
  confirmed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_migrations_entity_id ON ontology.migrations (entity_id);
CREATE INDEX idx_migrations_status    ON ontology.migrations (status) WHERE status NOT IN ('complete', 'rolled_back');
CREATE INDEX idx_migrations_tenant_id ON ontology.migrations (tenant_id);
```

### 2.6 `ontology.shadow_table_registry`

```sql
CREATE TABLE ontology.shadow_table_registry (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  migration_id    UUID        NOT NULL REFERENCES ontology.migrations(id) ON DELETE CASCADE,
  entity_type     TEXT        NOT NULL,               -- slug of the entity being migrated
  batch_id        TEXT        NOT NULL,               -- unique per batch, part of table name
  table_name      TEXT        NOT NULL,               -- e.g. "shadow_product_abc123"
  schema_name     TEXT        NOT NULL,               -- tenant schema where shadow table lives
  row_count       BIGINT      NOT NULL,               -- snapshotted row count at creation time
  batch_index     INTEGER     NOT NULL,               -- ordering within migration
  status          TEXT        NOT NULL DEFAULT 'active',
  -- 'active' | 'dropped' | 'corrupt' | 'rollback_unavailable'
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_shadow_table UNIQUE (table_name, schema_name)
);

CREATE INDEX idx_shadow_registry_migration ON ontology.shadow_table_registry (migration_id);
CREATE INDEX idx_shadow_registry_active    ON ontology.shadow_table_registry (status, created_at)
  WHERE status = 'active';
```

### 2.7 `ontology.mapping_errors`

```sql
CREATE TABLE ontology.mapping_errors (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID        NOT NULL,
  connector_id    UUID        NOT NULL,
  batch_id        TEXT        NOT NULL,               -- DataEnvelope._batchId
  raw_id          TEXT        NOT NULL,               -- DataEnvelope._id
  entity_type     TEXT        NOT NULL,               -- target entity slug
  error_fields    TEXT[]      NOT NULL,               -- field slugs that caused validation failure
  error_details   JSONB       NOT NULL,               -- per-field error messages from Zod
  raw_data        JSONB       NOT NULL,               -- full DataEnvelope.data at time of failure
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_mapping_errors_connector  ON ontology.mapping_errors (connector_id, created_at DESC);
CREATE INDEX idx_mapping_errors_batch      ON ontology.mapping_errors (batch_id);
CREATE INDEX idx_mapping_errors_tenant     ON ontology.mapping_errors (tenant_id, created_at DESC);
-- GIN index for JSON querying during error investigation
CREATE INDEX idx_mapping_errors_raw_data   ON ontology.mapping_errors USING GIN (raw_data jsonb_path_ops);
```

**Retention policy:** Mapping errors older than 30 days (configurable via `OP_MAPPING_ERROR_RETENTION_DAYS`) are deleted by a background job that runs daily at 02:00 UTC.

### 2.8 `ontology.draft_ontologies`

```sql
CREATE TABLE ontology.draft_ontologies (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID        NOT NULL,
  connector_id     UUID        NOT NULL,
  inferred_schema  JSONB       NOT NULL,
  -- Structure: { entityType: string, fields: InferredField[], sampleCount: number }
  status           TEXT        NOT NULL DEFAULT 'draft',
  -- 'draft' | 'confirmed' | 'rejected'
  sample_batch_id  TEXT        NOT NULL,              -- which batch was used for inference
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at     TIMESTAMPTZ,
  confirmed_by     UUID,

  CONSTRAINT chk_draft_status CHECK (status IN ('draft', 'confirmed', 'rejected'))
);

CREATE INDEX idx_draft_ontologies_connector ON ontology.draft_ontologies (connector_id, status);
CREATE INDEX idx_draft_ontologies_tenant    ON ontology.draft_ontologies (tenant_id);
```

### 2.9 Tenant Entity Tables (Dynamic)

When a user creates an entity (e.g., `Product` in tenant `abc-123`), the Ontology Service creates a table in the tenant's dedicated schema:

```sql
-- Created by Ontology Service when entity is provisioned
CREATE SCHEMA IF NOT EXISTS tenant_abc123;

-- Example: after creating entity "Product" with fields id, name, price, sku
CREATE TABLE tenant_abc123.product (
  _id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  _ingested_by  UUID,                                -- ontology.mapping_rules.connector_id (nullable: manually created)
  _created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  _updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  _version      INTEGER     NOT NULL DEFAULT 1,      -- optimistic concurrency
  _source_id    TEXT,                                -- original source system identifier

  -- User-defined fields follow (example):
  name          TEXT        NOT NULL,
  price         NUMERIC(19, 4),
  sku           TEXT        UNIQUE
);

-- RLS policy (always applied)
ALTER TABLE tenant_abc123.product ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_abc123.product
  USING (current_setting('app.tenant_id') = 'abc123');

-- Indexes for user-marked indexed fields
CREATE INDEX idx_product_sku ON tenant_abc123.product (sku) WHERE sku IS NOT NULL;
```

All system-reserved columns are prefixed with `_` to prevent collision with user-defined fields. The Ontology Service enforces this via a `chk_field_slug CHECK (slug NOT LIKE '\_%')` constraint on `ontology.fields`.

**Schema naming:** `tenant_{tenantId}` with hyphens stripped from the UUID. The mapping from `tenantId` to schema name is: `'tenant_' || replace(tenant_id::text, '-', '')`.

---

## 3. API Endpoints

All public endpoints are prefixed `/api/v1/ontology`. They require a valid Bearer JWT or API key. The Gateway validates the token before forwarding to the Ontology Service. The `@oneplatform/core` auth middleware extracts `c.var.user` from the validated token.

### 3.1 Authentication and Authorization

| Scope required | Applies to |
|---|---|
| `ontology:read` | All GET endpoints |
| `ontology:write` | POST, PATCH, DELETE endpoints |

All responses use the `ApiResponse<T>` envelope from `@oneplatform/core`. Errors use `ApiError`. Tenant isolation is enforced at the service level by appending `AND tenant_id = c.var.user.tenantId` to every query.

### 3.2 Entity Endpoints

#### `GET /api/v1/ontology`

List all active entity definitions for the calling tenant.

**Scope:** `ontology:read`

**Query parameters:**
```
cursor    string   Opaque cursor from previous response
limit     integer  1–100, default 50
```

**Response `200 OK`:**
```typescript
PaginatedResponse<{
  id: string;
  name: string;
  slug: string;
  version: number;
  description: string | null;
  isPublic: boolean;
  fieldCount: number;
  createdAt: string;
  updatedAt: string;
}>
```

#### `POST /api/v1/ontology`

Create a new entity type.

**Scope:** `ontology:write`

**Request body Zod schema:**
```typescript
const CreateEntitySchema = z.object({
  name: z.string().min(1).max(64),
  slug: z.string().regex(/^[a-z][a-z0-9_]*$/).max(64).optional(),
  // If omitted, derived from name: name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')
  description: z.string().max(512).optional(),
  isPublic: z.boolean().default(false),
  fields: z.array(FieldDefinitionSchema).min(0).max(200),
});

const FieldDefinitionSchema = z.object({
  name: z.string().min(1).max(64),
  slug: z.string().regex(/^[a-z][a-z0-9_]*$/).max(64).optional(),
  fieldType: z.enum(['string', 'number', 'boolean', 'date', 'json', 'reference', 'enum', 'array']),
  required: z.boolean().default(false),
  nullable: z.boolean().default(true),
  defaultValue: z.unknown().optional(),
  validationRules: z.array(ValidationRuleSchema).default([]),
  enumValues: z.array(z.string()).min(1).optional(),
  arrayItemType: z.enum(['string', 'number', 'boolean', 'date', 'json']).optional(),
  refEntitySlug: z.string().optional(),
  isIndexed: z.boolean().default(false),
  isUnique: z.boolean().default(false),
});

const ValidationRuleSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('min'), value: z.number(), message: z.string().optional() }),
  z.object({ type: z.literal('max'), value: z.number(), message: z.string().optional() }),
  z.object({ type: z.literal('minLength'), value: z.number().int().min(0), message: z.string().optional() }),
  z.object({ type: z.literal('maxLength'), value: z.number().int().min(1), message: z.string().optional() }),
  z.object({ type: z.literal('pattern'), value: z.string(), message: z.string().optional() }),
  z.object({ type: z.literal('email'), message: z.string().optional() }),
  z.object({ type: z.literal('url'), message: z.string().optional() }),
]);
```

**Response `201 Created`:**
```typescript
ApiResponse<EntityDetail>

interface EntityDetail {
  id: string;
  name: string;
  slug: string;
  version: number;
  description: string | null;
  isPublic: boolean;
  fields: FieldDetail[];
  createdAt: string;
  updatedAt: string;
}
```

**Errors:**
| Code | HTTP | Condition |
|---|---|---|
| `VALIDATION_ERROR` | 422 | Zod schema failure |
| `CONFLICT` | 409 | `slug` already in use within this tenant |
| `ONTOLOGY_RESERVED_SLUG` | 422 | Slug starts with `_` or equals a reserved word (`bulk`, `id`) |
| `ONTOLOGY_REF_NOT_FOUND` | 422 | `refEntitySlug` does not resolve to an existing entity |

**Side effects:** Creates `tenant_{tenantId}.{slug}` table with RLS. Bumps entity version. Publishes `ontology:changed` event to Redis.

#### `GET /api/v1/ontology/{entityType}`

Retrieve full entity definition including fields and relationships.

**Scope:** `ontology:read`

**Path:** `entityType` is the entity slug.

**Response `200 OK`:** `ApiResponse<EntityDetail & { relationships: RelationshipDetail[] }>`

**Errors:** `ENTITY_NOT_FOUND` (404) if entity does not exist or belongs to a different tenant.

#### `PATCH /api/v1/ontology/{entityType}`

Update entity metadata or fields. The service analyzes the diff to determine if this is a backward-compatible or breaking change and responds accordingly.

**Scope:** `ontology:write`

**Request body Zod schema:**
```typescript
const PatchEntitySchema = z.object({
  name: z.string().min(1).max(64).optional(),
  description: z.string().max(512).nullable().optional(),
  isPublic: z.boolean().optional(),
  addFields: z.array(FieldDefinitionSchema).optional(),
  removeFieldSlugs: z.array(z.string()).optional(),
  updateFields: z.array(z.object({
    slug: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    validationRules: z.array(ValidationRuleSchema).optional(),
    isIndexed: z.boolean().optional(),
    isUnique: z.boolean().optional(),
    defaultValue: z.unknown().optional(),
  })).optional(),
});
```

**Response `200 OK` (backward-compatible change):**
```typescript
ApiResponse<{
  entity: EntityDetail;
  changeType: 'backward_compatible';
  appliedImmediately: true;
}>
```

**Response `202 Accepted` (breaking change):**
```typescript
ApiResponse<{
  migration: MigrationPlan;
  changeType: 'breaking';
  requiresConfirmation: true;
}>

interface MigrationPlan {
  migrationId: string;
  entityType: string;
  fromVersion: number;
  toVersion: number;
  changes: ChangeDescription[];
  affectedRowCount: number;
  dependentPipelines: { id: string; name: string }[];
  dependentApps: { id: string; name: string }[];
  estimatedDurationMs: number | null;
  expiresAt: string;  // plan expires in 1 hour; must confirm before then
}
```

**Errors:**
| Code | HTTP | Condition |
|---|---|---|
| `ENTITY_NOT_FOUND` | 404 | Entity does not exist |
| `VALIDATION_ERROR` | 422 | Zod validation failure |
| `ONTOLOGY_MIGRATION_IN_PROGRESS` | 409 | Another migration is already running for this entity |
| `CONFLICT` | 409 | Optimistic lock: entity was modified since client last fetched it |

#### `DELETE /api/v1/ontology/{entityType}`

Mark entity as deleted (soft delete). If the entity has existing data records this is a breaking change requiring confirmation.

**Scope:** `ontology:write`

**Query parameters:**
```
confirm   boolean  Must be true if entity has existing data (enforced server-side)
```

**Response `204 No Content`** (no data) or **`202 Accepted`** (data exists, migration plan returned).

**Errors:** `ENTITY_HAS_DATA` (409) if records exist and `?confirm=true` not provided.

#### `POST /api/v1/ontology/{entityType}/validate`

Validate a data record against the entity's current Zod schema without persisting it.

**Scope:** `ontology:read`

**Request body:**
```typescript
const ValidateRecordSchema = z.object({
  data: z.record(z.unknown()),
});
```

**Response `200 OK`:**
```typescript
ApiResponse<{
  valid: boolean;
  errors: { field: string; code: string; message: string }[];
}>
```

### 3.3 Migration Endpoints

#### `GET /api/v1/ontology/migrations`

List migrations for the calling tenant, ordered by `created_at DESC`.

**Scope:** `ontology:read`

**Query parameters:** `cursor`, `limit`, `status` (filter by status)

**Response `200 OK`:** `PaginatedResponse<MigrationSummary>`

#### `GET /api/v1/ontology/migrations/{id}`

Get full migration details including change plan and current progress.

**Scope:** `ontology:read`

**Response `200 OK`:** `ApiResponse<MigrationDetail>`

```typescript
interface MigrationDetail {
  id: string;
  entityType: string;
  fromVersion: number;
  toVersion: number;
  changeType: string;
  isBreaking: boolean;
  status: 'pending_confirmation' | 'confirmed' | 'running' | 'complete' | 'failed' | 'rolled_back';
  changePlan: MigrationPlan;
  batchProgress?: {
    totalBatches: number;
    completedBatches: number;
    currentBatch: number | null;
  };
  startedAt: string | null;
  completedAt: string | null;
  errorDetails: Record<string, unknown> | null;
  createdAt: string;
}
```

#### `POST /api/v1/ontology/migrations/{id}/confirm`

Confirm execution of a breaking migration. The migration plan must not have expired.

**Scope:** `ontology:write`

**Response `202 Accepted`:**
```typescript
ApiResponse<{ migrationId: string; status: 'confirmed'; estimatedDurationMs: number | null }>
```

**Errors:**
| Code | HTTP | Condition |
|---|---|---|
| `MIGRATION_NOT_FOUND` | 404 | Migration ID does not exist |
| `MIGRATION_PLAN_EXPIRED` | 410 | Confirmation window (1 hour) has passed |
| `MIGRATION_WRONG_STATE` | 409 | Migration is not in `pending_confirmation` state |

#### `POST /api/v1/ontology/migrations/{id}/rollback`

Request rollback of a running or failed migration. Only available while `status` is `running` or `failed`.

**Scope:** `ontology:write`

**Response `202 Accepted`:** `ApiResponse<{ migrationId: string; status: 'rolling_back' }>`

#### `GET /api/v1/ontology/migrations/{id}/status`

Lightweight polling endpoint for migration progress. Returns current status and batch progress only (not full plan). Used by the frontend progress bar.

**Scope:** `ontology:read`

**Response `200 OK`:**
```typescript
ApiResponse<{
  status: string;
  batchProgress: { total: number; completed: number; current: number | null } | null;
  estimatedCompletionAt: string | null;
}>
```

---

## 4. Schema Engine

### 4.1 Entity CRUD Flow

**Create entity:**

```
1. Validate CreateEntitySchema (Zod)
2. Derive slug if not provided
3. Check slug uniqueness within tenant
4. BEGIN transaction
   a. INSERT ontology.entities
   b. INSERT ontology.fields (for each field in request)
   c. CREATE TABLE tenant_{tenantId}.{slug} with system columns + user columns
   d. ALTER TABLE ... ENABLE ROW LEVEL SECURITY
   e. CREATE POLICY tenant_isolation
   f. CREATE INDEX for each is_indexed=true field
5. COMMIT
6. Invalidate ontology cache: publish ontology:changed to Redis
7. Return EntityDetail
```

**If step 4 fails:** The transaction rolls back. The dynamic table is never created in a half-state because the DDL and the catalog insert are within the same transaction.

**Update entity (backward-compatible):**

```
1. Validate PatchEntitySchema
2. Compute diff (addFields, removeFieldSlugs, updateFields)
3. classify_change(diff) → 'backward_compatible'
4. BEGIN transaction
   a. UPDATE ontology.entities SET version = version + 1, updated_at = now()
   b. INSERT new fields into ontology.fields
   c. ALTER TABLE tenant_{tenantId}.{slug} ADD COLUMN {new_col} {pg_type} DEFAULT {default}
   d. For updateFields with is_indexed=true: CREATE INDEX CONCURRENTLY (outside transaction)
5. COMMIT
6. Publish ontology:changed
```

`ALTER TABLE ... ADD COLUMN` with a `DEFAULT` value is instantaneous in PostgreSQL 11+ (the default is stored in catalog, not written to every row) — no table lock is held beyond the brief DDL lock.

**Update entity (breaking):**

```
1. Validate PatchEntitySchema
2. classify_change(diff) → 'breaking'
3. Count affected rows: SELECT COUNT(*) FROM tenant_{tenantId}.{slug}
4. Resolve dependent pipelines: query pipeline.pipelines WHERE definition::text LIKE '%{entitySlug}%'
5. Resolve dependent apps: query app.apps WHERE config::text LIKE '%{entitySlug}%'
6. INSERT ontology.migrations with status='pending_confirmation', change_plan
7. Return 202 with MigrationPlan
```

### 4.2 Field Type System

The 8 supported field types map to PostgreSQL column types and Zod validators as follows:

| Field Type | PostgreSQL Type | Zod Validator | Notes |
|---|---|---|---|
| `string` | `TEXT` | `z.string()` | Validation rules: minLength, maxLength, pattern, email, url |
| `number` | `NUMERIC(19, 4)` | `z.number()` | Validation rules: min, max. NUMERIC avoids floating-point precision loss |
| `boolean` | `BOOLEAN` | `z.boolean()` | |
| `date` | `TIMESTAMPTZ` | `z.string().datetime()` | Always stored as UTC. API accepts ISO 8601 strings |
| `json` | `JSONB` | `z.record(z.unknown())` | Arbitrary structured data. GIN-indexed if `is_indexed=true` |
| `reference` | `UUID` | `z.string().uuid()` | Foreign key to `_id` of target entity. Stored as UUID, not full object |
| `enum` | `TEXT` | `z.enum([...])` | `enum_values` array stored in `ontology.fields`. DB uses CHECK constraint |
| `array` | `JSONB` | `z.array(...)` | Item type is one of the scalar types. Stored as JSONB array |

**Why `array` uses JSONB instead of a Postgres array type:** Postgres array types are not JSONB-composable, are harder to query across, and their elements cannot have mixed sub-structure. JSONB arrays are queryable with GIN indexes and composable with the rest of the platform's JSONB tooling.

**Default value enforcement:** Default values are stored as `JSONB` in `ontology.fields.default_value`. When generating the Zod validator for a field, if `default_value` is non-null the validator wraps with `.default(value)`. When generating the `ALTER TABLE` DDL for a new column, the default is embedded as a `DEFAULT {value}` clause.

**Validation rule Zod generation:**

```typescript
// Pseudocode for buildFieldZodValidator(field: FieldRow): ZodTypeAny
function buildFieldZodValidator(field: FieldRow): ZodTypeAny {
  let v: ZodTypeAny;

  switch (field.fieldType) {
    case 'string':
      v = z.string();
      for (const rule of field.validationRules) {
        if (rule.type === 'minLength') v = (v as ZodString).min(rule.value, rule.message);
        if (rule.type === 'maxLength') v = (v as ZodString).max(rule.value, rule.message);
        if (rule.type === 'pattern')   v = (v as ZodString).regex(new RegExp(rule.value), rule.message);
        if (rule.type === 'email')     v = (v as ZodString).email(rule.message);
        if (rule.type === 'url')       v = (v as ZodString).url(rule.message);
      }
      break;
    case 'number':
      v = z.number();
      for (const rule of field.validationRules) {
        if (rule.type === 'min') v = (v as ZodNumber).min(rule.value, rule.message);
        if (rule.type === 'max') v = (v as ZodNumber).max(rule.value, rule.message);
      }
      break;
    case 'enum':
      v = z.enum(field.enumValues as [string, ...string[]]);
      break;
    case 'array':
      v = z.array(buildScalarZodValidator(field.arrayItemType));
      break;
    case 'reference':
      v = z.string().uuid();
      break;
    // ... remaining types
  }

  if (field.nullable) v = v.nullable();
  if (!field.required) v = v.optional();
  if (field.defaultValue !== null) v = v.default(field.defaultValue);

  return v;
}
```

---

## 5. Relationship Management

### 5.1 Relationship Types

| Type | Postgres implementation | Join table |
|---|---|---|
| `1:1` | Foreign key column on the "from" entity table | None |
| `1:N` | Foreign key column on the "N" side entity table | None |
| `M:N` | No foreign keys on either entity table; separate join table in tenant schema | Yes |

### 5.2 Creating a Relationship

When a relationship is created via `PATCH /api/v1/ontology/{entityType}` (using a `addRelationship` sub-operation), the service:

**For `1:1` and `1:N`:**

```sql
-- 1:N example: Order has many OrderItems (from=OrderItem, to=Order, field_name=orderId)
ALTER TABLE tenant_abc123.order_item
  ADD COLUMN order_id UUID REFERENCES tenant_abc123.order(_id)
    ON DELETE {CASCADE if cascade_delete else RESTRICT};

CREATE INDEX idx_order_item_order_id ON tenant_abc123.order_item (order_id);
```

The foreign key column is added to the entity table using `ALTER TABLE ... ADD COLUMN` inside a transaction alongside the `ontology.relationships` catalog insert.

**For `M:N`:**

```sql
-- M:N example: Product has many Tags
CREATE TABLE tenant_abc123.product_tag (
  product_id  UUID NOT NULL REFERENCES tenant_abc123.product(_id) ON DELETE CASCADE,
  tag_id      UUID NOT NULL REFERENCES tenant_abc123.tag(_id)     ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, tag_id)
);
```

The join table name follows the `{from_slug}_{to_slug}` convention sorted alphabetically. The `join_table_name` is stored in `ontology.relationships` for queryability.

### 5.3 Cascade Delete Rules

`cascade_delete` on the relationship determines the `ON DELETE` behavior:

| `cascade_delete` | `ON DELETE` behavior |
|---|---|
| `false` (default) | `RESTRICT` — deletion of parent is blocked if children exist |
| `true` | `CASCADE` — deletion of parent deletes all children |

For M:N relationships, both sides always use `ON DELETE CASCADE` on the join table (the join record is implicitly deleted when either side is deleted). `cascade_delete` on M:N controls whether deleting from the join table cascades to the child entity.

### 5.4 Generated Fields for Relationships

For `1:1` and `1:N` relationships, the Ontology Service also inserts a corresponding `ontology.fields` record for the foreign key column (so code generation and mapping rules can reference it uniformly). This field has `field_type = 'reference'` and `ref_entity_id` pointing to the related entity. This field record is marked `system_generated = true` (via an additional boolean column on `ontology.fields`) to distinguish it from user-created fields.

---

## 6. Mapping Rules

### 6.1 Overview

Mapping rules define how raw connector data in `ingestion.raw_{connectorId}` (stored as `DataEnvelope`) is translated to typed entity records in `tenant_{tenantId}.{entitySlug}`.

The mapping worker is a BullMQ worker running inside the Ontology Service process. It consumes jobs from the `ontology:map` queue (enqueued by the Ingestion Service after each batch write). The worker:

```
1. Dequeue job: { tenantId, connectorId, batchId, rawIds[] }
2. Load active mapping rules for connectorId (from ontology cache or DB)
3. Load entity Zod validators for all target entities (from ontology cache or DB)
4. SELECT rows from ingestion.raw_{connectorId} WHERE _id = ANY(rawIds)
5. For each DataEnvelope:
   a. Apply mapping rules in priority order
   b. Resolve expression transforms (batch POST to Execution sandbox)
   c. Validate result against entity Zod schema
   d. Accumulate valid records and invalid records separately
6. BEGIN transaction
   a. UPSERT valid records into tenant_{tenantId}.{entitySlug} ON CONFLICT (_source_id) DO UPDATE
   b. INSERT failures into ontology.mapping_errors
7. COMMIT
8. Publish data.created / data.updated events for valid records
9. Acknowledge BullMQ job
```

The BullMQ worker uses the retry policy from ADR-13: exponential backoff, max 5 retries, base 1s, max 60s, DLQ after exhaustion.

### 6.2 Expression Transforms

Mapping rules with `transform_type = 'expression'` contain a JavaScript expression string in the `transform` column. The expression is evaluated against the source field value (`value` is the binding) in the Execution Service sandbox.

The Ontology Service batches all expression transforms for a single DataEnvelope into a single `POST /internal/execution/run` request to amortize the HTTP overhead:

```typescript
interface ExpressionBatchRequest {
  tenantId: string;
  expressions: Array<{
    id: string;        // correlation id (target field slug)
    expression: string;
    value: unknown;    // the source field value
    context: {        // additional bindings available in expression scope
      record: Record<string, unknown>;  // full DataEnvelope.data
    };
  }>;
  timeoutMs: number;  // 5000 (expression transforms are fast)
}
```

If the Execution Service is unreachable or times out, the entire batch for that DataEnvelope is marked as a mapping error (not a partial success). This is a known availability dependency — the worker retries via BullMQ backoff.

The Execution sandbox provides no I/O primitives for expression transforms (no `fetch`, no `db`). Only the `value` binding and the `context.record` binding are available. This limits the attack surface for malicious transform expressions.

### 6.3 Auto-Inference

When a new connector produces its first batch and no mapping rules exist, the Ontology Service's `/internal/ontology/infer` endpoint analyzes a sample of raw data and produces an `InferredSchema`:

```typescript
interface InferredSchema {
  entityType: string;          // inferred from connector name
  fields: Array<{
    path: string;              // dot-notation path in DataEnvelope.data
    suggestedSlug: string;     // camelCase → snake_case transformation
    inferredType: FieldType;   // based on value sampling
    confidence: number;        // 0–1, based on consistency across sample rows
    sampleValues: unknown[];   // up to 3 example values
    nullRate: number;          // fraction of sample rows where field is null
  }>;
  sampleCount: number;
}
```

Inference algorithm:
1. Sample up to 1000 rows from `ingestion.raw_{connectorId}`.
2. For each unique key path in `DataEnvelope.data` (depth-first, max 5 levels), collect all values.
3. Determine type: if all non-null values parse as ISO 8601 → `date`; all as numbers → `number`; all as booleans → `boolean`; all as objects → `json`; else → `string`.
4. Confidence is the fraction of rows where the field is present and matches the inferred type.

The result is stored as a `draft_ontologies` record. The user confirms or edits it in the UI, which then calls `POST /api/v1/ontology` (create entity) + the mapping rules creation endpoint.

---

## 7. Schema Migration System

### 7.1 Change Classification

On every `PATCH /api/v1/ontology/{entityType}` request, `classify_change(diff)` determines the migration path:

**Backward-compatible changes (applied immediately, no migration job):**
- Add a nullable field (with or without a default value)
- Add a new entity
- Widen a type (e.g., `number` → `string`)
- Add an enum value
- Change a validation rule to be less restrictive (increase maxLength, decrease minLength, etc.)
- Add a relationship (adds a column or join table; no data transformation required)
- Update entity metadata (`name`, `description`, `isPublic`)

**Breaking changes (require confirmation, generate migration job):**
- Remove a field
- Rename a field (treated as remove + add)
- Narrow a type (e.g., `string` → `number`)
- Remove an enum value
- Change validation rule to be more restrictive (would invalidate existing data)
- Remove an entity
- Remove a relationship
- Change `nullable: true` to `nullable: false` on an existing field
- Change `required: false` to `required: true` on a field without a default value

### 7.2 Migration Job Flow

On `POST /api/v1/ontology/migrations/{id}/confirm`:

```
1. Validate migration is in 'pending_confirmation' state
2. Validate confirmation window (created_at + 1h) has not expired
3. UPDATE ontology.migrations SET status='confirmed', confirmed_by, confirmed_at
4. Acquire advisory lock: pg_try_advisory_lock(entity_id hashcode)
   → If lock fails: return ONTOLOGY_MIGRATION_IN_PROGRESS (409)
5. UPDATE status='running', started_at=now()
6. CREATE UNION VIEW: v_{entitySlug}_migration_{migrationId}
   → View SELECT-normalizes both old-schema and new-schema rows
   → Queries hitting this entity use the view during migration
7. Enqueue BullMQ migration job to pipeline:migration queue
8. Release HTTP response (202)

Migration job (runs asynchronously in Pipeline Service BullMQ worker):
  For each batch of 1000 rows:
    a. BEGIN transaction
    b. CREATE TABLE tenant_{tenantId}.shadow_{entitySlug}_{batchId} AS
         SELECT * FROM tenant_{tenantId}.{entitySlug} WHERE _id IN (batch)
    c. INSERT INTO ontology.shadow_table_registry (row_count = actual count)
    d. Transform rows from old schema to new schema
    e. UPDATE tenant_{tenantId}.{entitySlug} SET {new fields} WHERE _id IN (batch)
    f. COMMIT (shadow table and registry entry atomic)

  On all batches complete:
    a. DROP VIEW v_{entitySlug}_migration_{migrationId}
    b. UPDATE ontology.migrations SET status='complete', completed_at
    c. Release pg advisory lock
    d. Publish ontology:changed to Redis

  On any batch failure:
    a. Rollback all completed batches in reverse order
    b. UPDATE status='failed', error_details
    c. DROP VIEW v_{entitySlug}_migration_{migrationId}
    d. Release advisory lock
    e. Publish ontology.migration.failed event
```

### 7.3 UNION View

During a migration, the entity's data table contains rows in both old and new schema format. The UNION view normalizes them so callers see a consistent schema:

```sql
-- Example: Product entity, adding required field 'category' (default 'uncategorized')
-- During migration, some rows have category, some don't

CREATE VIEW tenant_abc123.v_product_migration_xyz AS
  -- New-schema rows (already migrated)
  SELECT _id, _created_at, _updated_at, _version, _source_id, _ingested_by,
         name, price, sku, category
  FROM tenant_abc123.product
  WHERE category IS NOT NULL
UNION ALL
  -- Old-schema rows (not yet migrated): supply default for missing column
  SELECT _id, _created_at, _updated_at, _version, _source_id, _ingested_by,
         name, price, sku, 'uncategorized' AS category
  FROM tenant_abc123.product
  WHERE category IS NULL;
```

Queries from Gateway and App Service during the migration window are redirected to this view via the ontology cache: the `OntologySnapshot` for this entity includes `migrationViewName: 'v_product_migration_xyz'` so consumers use the view instead of the base table.

**10-second query timeout:** All queries against a UNION view have a per-query `statement_timeout = 10s` (vs. the normal 30s). This is enforced by the Ontology Service setting `SET LOCAL statement_timeout = '10s'` before running queries against an entity in `migrating` status. If a UNION query times out:
- The caller receives `503 Service Unavailable` with `Retry-After: 5`.
- The Logging Service records the timeout via async pub/sub.
- If UNION view timeouts exceed 10% of queries for that entity over a 5-minute window, the Logging Service emits a `system.health.degraded` event.

### 7.4 Shadow Tables and Rollback

Per ADR-14, each batch creates its own shadow table atomically with its registry entry in a single transaction:

```sql
-- Atomic: both succeed or neither does
BEGIN;

CREATE TABLE tenant_abc123.shadow_product_batch007 AS
  SELECT * FROM tenant_abc123.product
  WHERE _id IN ('uuid1', 'uuid2', ... /* 1000 IDs */);
-- Verify row count matches expected
DO $$
BEGIN
  IF (SELECT COUNT(*) FROM tenant_abc123.shadow_product_batch007) != 1000 THEN
    RAISE EXCEPTION 'Shadow table row count mismatch';
  END IF;
END $$;

INSERT INTO ontology.shadow_table_registry
  (migration_id, entity_type, batch_id, table_name, schema_name, row_count, batch_index)
VALUES
  ('migration-id', 'product', 'batch007', 'shadow_product_batch007', 'tenant_abc123', 1000, 7);

COMMIT;
```

**Rollback sequence:** On failure at batch N, the rollback restores batches N down to 1 in reverse order:

```
For batch_index from N down to 1:
  1. Check shadow_table_registry for batch: status='active', row_count matches
  2. If status='corrupt' or row_count mismatch:
     - Log warning: "batch {n} rollback unavailable — data may require manual recovery"
     - Skip this batch
  3. BEGIN transaction
     a. DELETE FROM tenant_{tenantId}.{slug} WHERE _id IN (SELECT _id FROM shadow_{slug}_{batchId})
     b. INSERT INTO tenant_{tenantId}.{slug} SELECT * FROM shadow_{slug}_{batchId}
     c. UPDATE shadow_table_registry SET status='dropped'
  4. COMMIT
  5. DROP TABLE tenant_{tenantId}.shadow_{slug}_{batchId}
```

### 7.5 Orphaned Shadow Table Cleanup

A background job runs inside the Ontology Service every hour (using `setInterval` guarded by a Redis distributed lock to prevent duplicate execution across replicas):

**Tier 1 — Registered, valid:**
```sql
-- Find registry entries with no active migration older than 24 hours
SELECT sr.* FROM ontology.shadow_table_registry sr
LEFT JOIN ontology.migrations m ON sr.migration_id = m.id
WHERE sr.status = 'active'
  AND sr.created_at < now() - interval '24 hours'
  AND (m.status NOT IN ('running', 'confirmed') OR m.id IS NULL);
```
For each result: verify shadow table exists in `information_schema.tables` AND row count matches. If both checks pass: DROP TABLE, UPDATE registry status='dropped'.

**Tier 2 — Registered, missing or corrupt:**
For registry entries where the shadow table does not exist in `information_schema.tables` OR the live row count does not match `shadow_table_registry.row_count`:
- UPDATE status='corrupt' (or 'rollback_unavailable')
- If a partial table exists: DROP TABLE
- Log warning with migration context

**Tier 3 — Unregistered shadow tables:**
```sql
-- Find tables in tenant schemas matching shadow_*_* pattern not in registry
SELECT table_schema, table_name
FROM information_schema.tables
WHERE table_name ~ '^shadow_[a-z][a-z0-9_]*_[a-z0-9]+$'
  AND table_schema LIKE 'tenant_%'
  AND (table_schema, table_name) NOT IN (
    SELECT schema_name, table_name FROM ontology.shadow_table_registry
  )
  AND (SELECT create_time FROM information_schema.tables ...) < now() - interval '48 hours';
```
For each result: log the unregistered table and DROP it.

### 7.6 Migration Timeout

Each migration has a configurable maximum duration (`OP_MIGRATION_TIMEOUT`, default 3600s / 1 hour). The migration job in the Pipeline Service BullMQ queue is configured with this as its hard timeout. On timeout:

1. BullMQ marks job as failed.
2. Pipeline Service publishes failure event.
3. Ontology Service migration worker (subscribed to migration job events) receives failure.
4. Triggers rollback sequence.
5. Drops UNION view.
6. Updates `ontology.migrations` status to `failed`.
7. Releases advisory lock.
8. Logging Service emits alert via `system.health.degraded` event.

---

## 8. Code Generation

### 8.1 Generated Artifacts

For each entity, the Ontology Service generates three artifacts on demand:

**TypeScript interface:**
```typescript
// Generated for entity "Product" (version 3)
// @oneplatform/generated/types/product.ts — DO NOT EDIT MANUALLY
// Generated at 2026-06-10T12:00:00Z from schema version 3

export interface Product {
  _id: string;
  _createdAt: string;
  _updatedAt: string;
  _version: number;
  _sourceId: string | null;
  name: string;
  price: number;
  sku: string | null;
  category: string;
}

export interface CreateProductInput {
  name: string;
  price: number;
  sku?: string | null;
  category: string;
}

export interface UpdateProductInput extends Partial<CreateProductInput> {}
```

**Zod validator:**
```typescript
// Generated Zod schema — used at runtime by Gateway and Ontology Service
export const ProductSchema = z.object({
  _id: z.string().uuid(),
  _createdAt: z.string().datetime(),
  _updatedAt: z.string().datetime(),
  _version: z.number().int(),
  _sourceId: z.string().nullable(),
  name: z.string().min(1).max(255),
  price: z.number().min(0),
  sku: z.string().nullable().optional(),
  category: z.enum(['electronics', 'clothing', 'food']),
});

export const CreateProductInputSchema = ProductSchema.omit({ _id: true, _createdAt: true, _updatedAt: true, _version: true });
export const UpdateProductInputSchema = CreateProductInputSchema.partial();
```

**API route definitions (for Gateway auto-generation):**
```typescript
// Consumed by Gateway Service to register data endpoints
export interface EntityRouteDefinition {
  entitySlug: string;
  entityName: string;
  schemaVersion: number;
  routes: {
    list:   { path: string; method: 'GET';    requiredScope: string };
    get:    { path: string; method: 'GET';    requiredScope: string };
    create: { path: string; method: 'POST';   requiredScope: string };
    update: { path: string; method: 'PATCH';  requiredScope: string };
    delete: { path: string; method: 'DELETE'; requiredScope: string };
  };
  isPublic: boolean;
  inputSchema: ZodObject<any>;
  outputSchema: ZodObject<any>;
}
```

### 8.2 Generation Trigger

Code generation is triggered:
1. Immediately after any backward-compatible entity change is committed.
2. After a breaking migration completes successfully.
3. On-demand via `GET /internal/ontology/schema?tenantId={id}` (returns the full schema snapshot including generated Zod validators serialized as code strings).

Generated artifacts are NOT written to disk. They are produced in-process by the Ontology Service and:
- Included in the `OntologySnapshot` returned via `/internal/ontology/schema` (as serialized code strings).
- Cached in Redis under `ontology:{tenantId}:{schemaVersion}` (TTL 300s, invalidated on version bump).

The `op sdk generate` CLI command calls the Ontology Service's public `GET /api/v1/ontology` and `/api/v1/openapi.json` endpoints and writes the generated types to disk for the consuming project. This is a separate external code generation flow from the internal runtime generation.

### 8.3 API Route Definition Generation

For each entity, the Gateway Service expects a `EntityRouteDefinition` to register the following auto-generated REST endpoints:

```
GET    /api/v1/data/{slug}           list records (paginated, filterable, sortable)
GET    /api/v1/data/{slug}/{id}      get single record
POST   /api/v1/data/{slug}           create record
PATCH  /api/v1/data/{slug}/{id}      update record
DELETE /api/v1/data/{slug}/{id}      delete record
POST   /api/v1/data/{slug}/bulk      bulk create/update/delete (up to 500 items)
```

These routes enforce the same filter DSL, pagination, and sorting conventions as all other platform resources (cursor-based pagination, `?filter[field][op]=value`, `?sort=field`).

---

## 9. Ontology Cache

### 9.1 Cache Structure

Each consumer service (Gateway, Auth, Pipeline, App, Ingestion) maintains an in-memory `OntologyCache` instance provided by `@oneplatform/core`:

```typescript
interface OntologySnapshot {
  tenantId: string;
  schemaVersion: number;
  fetchedAt: string;
  etag: string;
  entities: EntitySnapshot[];
}

interface EntitySnapshot {
  id: string;
  name: string;
  slug: string;
  version: number;
  isPublic: boolean;
  fields: FieldSnapshot[];
  relationships: RelationshipSnapshot[];
  zodValidator: string;       // serialized Zod schema (eval'd once at cache-warm time)
  tsType: string;             // serialized TS interface (for display/SDK only)
  routeDefinition: EntityRouteDefinition;
  migrationStatus: 'idle' | 'migrating' | 'complete';
  migrationViewName: string | null;  // non-null only during 'migrating'
}
```

The cache is keyed by `tenantId`. Multiple versions are not cached simultaneously — the cache always holds the latest confirmed version.

### 9.2 Startup Cache Warm

On service startup, each consumer calls:
```
GET http://ontology-service:3003/internal/ontology/schema?tenantId={id}
```
for each tenant it serves. For multi-tenant setups the service warms caches for all tenants in its auth.tenants list. The warm request carries `If-None-Match: {etag}` once an ETag is known.

### 9.3 Pub/Sub Invalidation

When the Ontology Service commits a schema change:

```typescript
// Published to Redis channel: ontology:changed
interface OntologyChangedEvent {
  tenantId: string;
  newVersion: number;
  diff: {
    addedEntities: string[];     // entity slugs
    removedEntities: string[];
    modifiedEntities: string[];
    changeType: 'add_field' | 'remove_field' | 'add_entity' | 'remove_entity' | 'migration_complete' | 'other';
  };
}
```

Consumer services subscribe to `ontology:changed` (Redis ACL: `&ontology:*`) and on receiving the event:
1. If `event.newVersion <= localCache.schemaVersion`: discard (stale event).
2. Else: fetch updated snapshot from `GET /internal/ontology/schema?tenantId={id}`.
3. Hot-swap the in-memory cache with the new snapshot.
4. Re-register any dynamically-generated Gateway routes for added/modified entities.

### 9.4 Five-Minute Safety Net Poll

Every consumer runs a background ticker every 5 minutes that:
```
GET /internal/ontology/schema?tenantId={id}
Headers: If-None-Match: {localCache.etag}
```
If the response is `200 OK` (ETag changed): hot-swap cache.  
If the response is `304 Not Modified`: no-op (near-zero cost).

This catches the rare scenario where a pub/sub message was missed (consumer restart between publish and reconnect, brief Redis network hiccup).

### 9.5 Stale Cache Behavior

If the Ontology Service is unreachable, consumers continue operating with their last-known cache. The stale-cache behavior is:
- **Reads:** Serve stale schema. Reads may succeed with outdated field definitions. This is acceptable for availability.
- **Writes that depend on the latest schema:** Fail with `503 SERVICE_UNAVAILABLE` with `X-OnePlatform-Degraded: ontology-cache-stale` header. The Gateway logs this as a degraded state event.

---

## 10. Internal Endpoints

Internal endpoints are only accessible from services with a valid `X-Service-Token` and are enforced by the service RBAC matrix in `@oneplatform/core/service-rbac.ts`.

### `GET /internal/ontology/schema`

Returns the full ontology snapshot for a tenant. Used by consumer services for cache warm and 5-minute polls.

**Authorized callers:** pipeline-service, app-service, ingestion-service (subscribe to changes only via pub/sub but may also fetch schema), gateway-service

**Query parameters:**
```
tenantId   string   (required)
```

**Request headers:**
```
X-Service-Token: {Ed25519 JWT}
If-None-Match: {etag}   (optional — returns 304 if schema unchanged)
```

**Response `200 OK`:**
```typescript
ApiResponse<OntologySnapshot> with ETag header
```

**Response `304 Not Modified`:** ETag matches current schema version. No body.

**Performance:** The snapshot is computed from the `ontology.*` tables and cached in Redis at `ontology:{tenantId}:{schemaVersion}` (TTL 300s). The cache is invalidated on every schema change. A cache miss triggers a full recompute from Postgres and re-caches the result.

### `POST /internal/ontology/map`

Apply mapping rules to a batch of raw DataEnvelopes. Called by Ingestion Service when a connector produces data and there is no mapping job queued (synchronous fast-path for small batches).

**Authorized callers:** ingestion-service

**Request body:**
```typescript
const MapRequestSchema = z.object({
  tenantId: z.string().uuid(),
  connectorId: z.string().uuid(),
  batchId: z.string(),
  records: z.array(DataEnvelopeSchema).min(1).max(100),
  // Synchronous mapping is limited to 100 records.
  // Larger batches should use the BullMQ job path.
});
```

**Response `200 OK`:**
```typescript
ApiResponse<{
  mapped: number;
  failed: number;
  errors: Array<{
    rawId: string;
    fields: string[];
    details: Record<string, string>;
  }>;
}>
```

**Behavior:** Runs the full mapping pipeline (rule resolution, expression transforms via Execution sandbox, Zod validation, upsert to tenant table). Returns a summary, not the mapped records. Failures are written to `ontology.mapping_errors`. Mapped records emit `data.created` / `data.updated` events.

### `POST /internal/ontology/infer`

Infer a schema from a sample of raw connector data. Called by Ingestion Service when a new connector produces its first batch.

**Authorized callers:** ingestion-service

**Request body:**
```typescript
const InferRequestSchema = z.object({
  tenantId: z.string().uuid(),
  connectorId: z.string().uuid(),
  sample: z.array(DataEnvelopeSchema).min(1).max(1000),
  entityTypeHint: z.string().optional(),  // e.g. connector name to seed inferred entity name
});
```

**Response `200 OK`:**
```typescript
ApiResponse<{
  draftId: string;   // ontology.draft_ontologies.id
  inferredSchema: InferredSchema;
}>
```

**Behavior:** Runs the inference algorithm (see Section 6.3). Saves the result as a `draft_ontologies` record. Returns the draft ID and inferred schema for display in the onboarding wizard.

---

## 11. Inter-Service Communication

### 11.1 Outbound Calls

| Target | Endpoint | When | Timeout |
|---|---|---|---|
| Execution Service | `POST /internal/execution/run` | Expression transforms during mapping | 5s per batch |
| Execution Service | `POST /internal/execution/run` | Future: custom validation expressions | 5s |

The Ontology Service calls the Execution Service synchronously during the mapping job. If Execution is unreachable, the mapping job fails and retries via BullMQ backoff (ADR-13). Expression transform calls are batched per DataEnvelope to minimize HTTP round trips.

The `POST /internal/execution/run` request for expression transforms:
```typescript
interface OntologyExpressionRunRequest {
  tenantId: string;
  code: string;         // Wrapped expression: `(function(value, context) { return (${expression}); })(value, context)`
  language: 'javascript';
  context: {
    value: unknown;
    record: Record<string, unknown>;
  };
  timeoutMs: 5000;
  memoryLimitMb: 32;    // Expression transforms are lightweight
  noIo: true;           // No fetch/db access allowed
}
```

### 11.2 Inbound Calls (from other services)

| Caller | Endpoint | Purpose |
|---|---|---|
| Gateway Service | All public `/api/v1/ontology/*` endpoints | User-facing ontology management |
| Ingestion Service | `POST /internal/ontology/map` | Synchronous small-batch mapping |
| Ingestion Service | `POST /internal/ontology/infer` | Schema inference from raw data |
| Pipeline Service | `GET /internal/ontology/schema` | Schema fetch for pipeline execution context |
| App Service | `GET /internal/ontology/schema` | Schema fetch for BFF data proxy |

### 11.3 Redis Pub/Sub (Publish)

The Ontology Service publishes to the following Redis channels (ACL: `&ontology:*`):

| Channel | Event payload | When |
|---|---|---|
| `ontology:changed` | `OntologyChangedEvent` | Any schema change committed |
| `ontology:migration:started` | `{ tenantId, entityType, fromVersion, toVersion, migrationId, estimatedRows }` | Migration confirmed and started |
| `ontology:migration:completed` | `{ tenantId, entityType, fromVersion, toVersion, migrationId, migratedRows, durationMs }` | Migration finishes |
| `ontology:migration:failed` | `{ tenantId, entityType, fromVersion, toVersion, migrationId, error }` | Migration fails or times out |

All published events conform to the `PlatformEvent` envelope from `@oneplatform/core`. The Gateway Service subscribes to `events:*` (fan-out to webhooks). Pipeline and Ingestion Services subscribe to `&ontology:*` to invalidate their caches.

---

## 12. Security Design

### 12.1 Authentication

All public endpoints require a valid JWT (Bearer) or API key. The `@oneplatform/core` auth middleware validates the token on every request. Internal endpoints require a valid `X-Service-Token` (Ed25519 JWT signed by the caller's service key) validated by the service RBAC matrix.

No endpoint accepts both user auth and service auth simultaneously — they are mutually exclusive paths in the middleware stack.

### 12.2 Tenant Isolation

Every query in the Ontology Service appends `tenant_id = c.var.user.tenantId` to the WHERE clause. This is enforced at the repository layer in a base query builder that does not allow callers to omit the tenant filter. Postgres RLS on `tenant_{tenantId}.*` tables provides a defense-in-depth second layer, enforced via `SET LOCAL app.tenant_id = $1` before every tenant-scoped query.

### 12.3 Expression Transform Safety

Mapping rule expression transforms run exclusively in the Execution Service's `isolated-vm` sandbox:
- No I/O primitives (`fetch`, `db`, `fs`) are injected.
- Memory limit: 32 MB.
- CPU timeout: 5 seconds.
- The Ontology Service never `eval()`s user-supplied expressions in its own process.

The expression string from `ontology.mapping_rules.transform` is passed to the Execution Service as a code string, not executed locally. This is a hard architectural constraint enforced by the service RBAC matrix (the Ontology Service is not permitted to execute arbitrary code except via the Execution Service).

### 12.4 Schema Injection Prevention

Entity slugs and field slugs are validated against `^[a-z][a-z0-9_]*$` before any DDL is generated. Table names and column names in generated DDL are always quoted with double quotes (`"entity_slug"`) using pg's identifier quoting. The Ontology Service never constructs DDL with raw user string concatenation — all identifiers pass through a `quotePgIdentifier(slug: string): string` utility that wraps with `"` and escapes internal double quotes.

Example: `quotePgIdentifier("product")` → `"product"`. If a slug somehow contained a double quote (prevented by the regex constraint), the function would escape it as `""`.

### 12.5 Breaking Change Authorization

Breaking changes require:
1. `ontology:write` scope (API key or role).
2. Explicit confirmation call to `POST /migrations/{id}/confirm` — migration cannot be triggered implicitly.
3. Confirmation within 1 hour of the migration plan being generated — expired plans must be regenerated.

This prevents accidental breaking changes from automated processes that might call `PATCH /api/v1/ontology/{entityType}` and receive a migration plan they did not intend to confirm.

### 12.6 Advisory Lock for Concurrent Migrations

The service acquires a Postgres advisory lock keyed on the entity's `id` before starting a migration. Only one migration per entity can run at a time. The lock is held for the duration of the migration and released on completion, failure, or rollback. `pg_try_advisory_lock` is used (non-blocking) — if the lock is already held, the service returns `409 ONTOLOGY_MIGRATION_IN_PROGRESS` immediately rather than blocking.

Advisory locks require session-mode PgBouncer (per ADR-5). The Ontology Service's PgBouncer pool is configured in session mode with 15 connections.

---

## 13. Error Handling

### 13.1 Service-Specific Error Codes

These extend the platform error registry from `@oneplatform/core/errors.ts`. All are prefixed `ONTOLOGY_`.

| Code | HTTP | Condition |
|---|---|---|
| `ONTOLOGY_ENTITY_NOT_FOUND` | 404 | Entity slug does not exist in this tenant |
| `ONTOLOGY_FIELD_NOT_FOUND` | 404 | Field slug does not exist on the entity |
| `ONTOLOGY_RESERVED_SLUG` | 422 | Slug conflicts with reserved words or system column prefix `_` |
| `ONTOLOGY_SLUG_CONFLICT` | 409 | Entity or field slug already in use |
| `ONTOLOGY_REF_NOT_FOUND` | 422 | `refEntitySlug` does not resolve |
| `ONTOLOGY_MIGRATION_IN_PROGRESS` | 409 | Another migration is running for this entity |
| `ONTOLOGY_MIGRATION_PLAN_EXPIRED` | 410 | Migration confirmation window elapsed |
| `ONTOLOGY_MIGRATION_WRONG_STATE` | 409 | Migration is not in the expected state for this operation |
| `ONTOLOGY_MIGRATION_NOT_FOUND` | 404 | Migration ID does not exist |
| `ONTOLOGY_ENTITY_HAS_DATA` | 409 | Attempted to delete entity with existing records without `confirm=true` |
| `ONTOLOGY_EXPRESSION_TIMEOUT` | 503 | Execution sandbox timed out on expression transform |
| `ONTOLOGY_EXPRESSION_ERROR` | 422 | Expression transform threw a runtime error |
| `ONTOLOGY_UNION_VIEW_TIMEOUT` | 503 | UNION view query exceeded 10s during active migration |
| `ONTOLOGY_SCHEMA_STALE` | 503 | Cache miss and Ontology Service unreachable |
| `ONTOLOGY_INFER_INSUFFICIENT_DATA` | 422 | Fewer than 10 sample rows provided for inference |
| `ONTOLOGY_DDL_FAILED` | 500 | Dynamic table DDL failed (logged with full SQL) |

### 13.2 Migration Failure Scenarios

**Scenario: Batch DDL fails mid-migration**

```
Symptom: ALTER TABLE / INSERT fails during a migration batch
Response:
  1. Transaction rolls back automatically (shadow table and registry entry not committed)
  2. Migration job marks batch as failed
  3. Rollback sequence executes for all previously committed batches in reverse order
  4. If rollback_unavailable for any batch (corrupt shadow table): log warning, skip, continue
  5. UNION view dropped
  6. ontology.migrations updated to status='failed', error_details
  7. Advisory lock released
  8. 'ontology.migration.failed' event published
  9. Frontend displays failure with rollback status (which batches were recovered vs. unavailable)
```

**Scenario: Execution Service unreachable during mapping job**

```
Symptom: POST /internal/execution/run times out (5s)
Response:
  1. BullMQ job retries with exponential backoff (5 max retries, 1s base, 60s max)
  2. If all retries exhausted: job moves to ontology:map:dlq
  3. Raw data remains in ingestion.raw_{connectorId} (not deleted)
  4. Mapping error record is NOT written (the raw data is preserved, not an application error)
  5. Alert visible in DLQ dashboard
  6. User can replay DLQ job once Execution Service recovers
```

**Scenario: Concurrent PATCH on same entity**

```
Symptom: Two simultaneous PATCH requests for the same entity
Response:
  1. Both requests read the entity at version N
  2. First request commits: entity now at version N+1
  3. Second request attempts UPDATE WHERE version = N → 0 rows affected
  4. Service detects 0-row update: return 409 CONFLICT with message
     "Entity was modified since you last fetched it. Fetch the latest version and retry."
  5. Client must re-fetch and re-apply its changes
```

Optimistic concurrency is enforced via `WHERE version = $expectedVersion` on all UPDATE queries to `ontology.entities`. The `version` column is also returned in all entity responses so clients have the token.

### 13.3 Invalid Schema Changes

Changes that would leave the database in an inconsistent state are rejected at the application layer before any DDL is executed:

- Removing a field that is the `from_field` of a relationship: rejected with `ONTOLOGY_FIELD_IN_USE` (409) listing the dependent relationship.
- Changing a `reference` field's `refEntityId` to point to a non-existent entity: rejected with `ONTOLOGY_REF_NOT_FOUND` (422).
- Reducing `enum_values` where existing data contains the removed value: classified as breaking (migration required).
- Adding a `required=true` field with no `defaultValue` to an entity with existing data: classified as breaking.
- Making a currently-nullable field `nullable=false` when null values exist in the data: classified as breaking.

---

## 14. Observability

### 14.1 Structured Logging

All logs are published via `@oneplatform/core`'s async log publisher (Redis `logs:ontology-service` channel). Log fields:

```typescript
interface OntologyLogEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  requestId: string;
  tenantId?: string;
  entitySlug?: string;
  migrationId?: string;
  batchId?: string;
  durationMs?: number;
  operation?: 'entity.create' | 'entity.update' | 'entity.delete' | 'migration.start' |
              'migration.batch' | 'migration.complete' | 'migration.rollback' |
              'mapping.batch' | 'mapping.error' | 'infer' | 'codegen';
}
```

### 14.2 OTEL Spans

The `@oneplatform/core` OTEL instrumentation auto-instruments all Hono routes and Postgres queries. The Ontology Service adds the following custom span attributes:

- `ontology.entity_slug` on all entity operations
- `ontology.schema_version` on schema fetch operations
- `ontology.migration_id` on all migration operations
- `ontology.batch_index` and `ontology.batch_size` on mapping and migration batch operations
- `ontology.change_type` (breaking / backward_compatible) on schema updates

### 14.3 Key Metrics

| Metric | Type | Labels |
|---|---|---|
| `ontology_entity_operations_total` | Counter | `operation`, `tenant_id`, `status` |
| `ontology_migration_duration_ms` | Histogram | `entity_slug`, `change_type`, `status` |
| `ontology_mapping_records_total` | Counter | `connector_id`, `status` (mapped/failed) |
| `ontology_mapping_batch_duration_ms` | Histogram | `connector_id` |
| `ontology_union_view_query_duration_ms` | Histogram | `entity_slug` |
| `ontology_union_view_timeouts_total` | Counter | `entity_slug` |
| `ontology_shadow_tables_active` | Gauge | — |
| `ontology_cache_invalidations_total` | Counter | `reason` (pubsub/poll) |
| `ontology_expression_transform_duration_ms` | Histogram | — |

### 14.4 Health Endpoints

`GET /healthz` — Returns `{ status: "ok", service: "ontology-service", version: "{semver}" }`. Always 200. Not auth-gated.

`GET /readyz` — Returns readiness of Postgres, Redis, and Execution Service connectivity:

```json
{
  "status": "ready",
  "checks": {
    "postgres": "ok",
    "redis": "ok",
    "execution_service": "ok"
  }
}
```

If Execution Service is unreachable, `readyz` returns `"execution_service": "degraded"` (not `"not-ready"`) — mapping jobs will fail but schema management still works. Only Postgres and Redis failures set `"status": "not-ready"`.

---

## 15. Testing Strategy

### 15.1 Unit Tests

Tested in isolation with no external dependencies (mocked Postgres, Redis, Execution Service):

| Component | What to test |
|---|---|
| `classify_change(diff)` | All combinations of field additions, removals, type changes. Regression test: each breaking change category in ADR-14 must have a test case |
| `buildFieldZodValidator(field)` | Each field type, each validation rule, nullable/required/default combinations |
| `generateDDL(entity)` | DDL string output for each field type; identifier quoting; system column inclusion |
| `quotePgIdentifier(slug)` | Slug escaping for edge cases |
| Inference algorithm | Type inference for each field type; confidence scoring; null rate calculation |
| Rollback sequence ordering | Verify batch order is reversed; corrupt batch is skipped with warning |
| UNION view query builder | Verify correct SQL is generated for add-field, remove-field, type-change migrations |
| `buildExpressionBatchRequest` | Batch assembly for Execution Service |

### 15.2 Integration Tests

Tested against a real PostgreSQL instance (test schema isolated per test run) and a mocked Redis/Execution Service:

| Scenario | What to verify |
|---|---|
| Entity create → tenant table exists | After `POST /api/v1/ontology`, `information_schema.tables` shows the new table with correct columns and RLS |
| Entity PATCH (add nullable field) | Column exists in tenant table; existing rows have NULL for the new column |
| Entity PATCH (add required field with default) | Column exists; existing rows have the default value (verified via Postgres catalog, not DDL re-execution) |
| Breaking change → migration plan returned | `PATCH` returns 202 with migration plan; entity version does not change until migration confirmed |
| Migration confirm → UNION view created | After confirm, `information_schema.views` shows the migration view |
| Migration batch processing | After all batches, rows have new schema; shadow tables exist in registry |
| Migration complete → UNION view dropped | After completion, view no longer exists; tenant table has all rows in new schema |
| Migration rollback | All rows restored to old schema from shadow tables; shadow tables dropped |
| Corrupt shadow table → rollback skips | Simulate corrupt shadow table; verify rollback continues with warning, not exception |
| Orphan cleanup job | Create an orphaned shadow table; run cleanup; verify it is dropped |
| Mapping worker | Post DataEnvelopes with mapping rules; verify records in tenant table; verify failures in mapping_errors |
| Mapping worker with expression transform | Stub Execution Service; verify transform is applied |
| Schema inference | Post sample DataEnvelopes; verify inferred schema types and confidence scores |
| Concurrent PATCH → conflict detection | Two simultaneous PATCH calls; verify exactly one succeeds and the other gets 409 |
| Advisory lock enforcement | Two simultaneous migration confirms; verify only one proceeds |
| Cache invalidation | Verify Redis `ontology:changed` is published after each schema change |
| ETag caching | Verify `GET /internal/ontology/schema` returns 304 when schema unchanged |

### 15.3 Migration-Specific Tests

These are run against a full test database with real BullMQ (or mocked in-process workers):

| Test | Scenario |
|---|---|
| `migration_add_enum_value` | Add value to enum; verify existing rows pass new Zod validator |
| `migration_remove_field` | Remove a field; verify column dropped from tenant table |
| `migration_change_type_string_to_enum` | Breaking type change; verify data migration converts string to enum value |
| `migration_large_batch` | 10,000 rows; verify batch boundaries (every 1000 rows) and shadow table per batch |
| `migration_timeout_abort` | Simulate migration job timeout; verify UNION view dropped and migration rolled back |
| `migration_mid_batch_failure` | Kill Postgres connection mid-batch; verify only that batch is rolled back, not previous batches |
| `migration_concurrent_queries` | During an active migration, run 100 concurrent queries against the entity; verify UNION view serves consistent results; verify 503 is returned on UNION timeout |
| `orphan_cleanup_all_three_tiers` | Create one registered-valid, one registered-corrupt, and one unregistered shadow table; run cleanup job; verify correct handling of each tier |

### 15.4 Contract Tests

The Ontology Service is a critical dependency for Gateway, Auth, Pipeline, and App Services. For each consumer:
- The `GET /internal/ontology/schema` response shape is contract-tested against the `OntologySnapshot` interface.
- The `ontology:changed` Redis event shape is contract-tested against `OntologyChangedEvent`.
- Breaking changes to these contracts require updating all consumer services in the same PR (enforced by TypeScript compilation in the monorepo).

---

## 16. Deployment

### 16.1 Docker Compose Service Definition

```yaml
ontology-service:
  image: oneplatform/ontology-service:${PLATFORM_VERSION}
  networks:
    - oneplatform-internal
  environment:
    PORT: 3003
    OP_SERVICE_NAME: ontology-service
    DATABASE_URL: postgresql://ontology_service_role:${ONTOLOGY_DB_PASSWORD}@pgbouncer:5432/oneplatform
    REDIS_URL: redis://:${REDIS_PASSWORD}@redis:6379
    REDIS_USERNAME: op_ontology
    OP_JWT_SECRET: ${OP_JWT_SECRET}
    OP_CURSOR_SECRET: ${OP_CURSOR_SECRET}
    OP_MASTER_KEY_PATH: /data/init/master.key
    OP_MIGRATION_TIMEOUT: ${OP_MIGRATION_TIMEOUT:-3600}
    OP_MAPPING_ERROR_RETENTION_DAYS: ${OP_MAPPING_ERROR_RETENTION_DAYS:-30}
    EXECUTION_SERVICE_URL: http://execution-service:3005
    NODE_ENV: production
  volumes:
    - service-keys:/data/service-keys:ro
    - ontology-service-key:/data:rw
    - init-data:/data/init:ro
  depends_on:
    pgbouncer:
      condition: service_healthy
    redis:
      condition: service_healthy
  healthcheck:
    test: ["CMD", "curl", "-f", "http://localhost:3003/healthz"]
    interval: 10s
    timeout: 5s
    retries: 12
    start_period: 120s
  restart: unless-stopped
```

### 16.2 Database Migrations (Schema Bootstrap)

The Ontology Service runs Postgres schema migrations using a custom migration runner in `@oneplatform/core/db-migrate.ts` on startup, before accepting requests:

1. `CREATE SCHEMA IF NOT EXISTS ontology`
2. `CREATE TABLE IF NOT EXISTS ontology.migrations_log (id, name, applied_at)` — tracks applied migrations
3. Apply all pending `.sql` files from `packages/ontology-service/migrations/` in lexicographic order
4. Log each applied migration to `ontology.migrations_log`

Migration files are named `{YYYYMMDD}_{sequence}_{description}.sql` (e.g., `20260601_001_initial_schema.sql`). They are idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`).

### 16.3 Scaling Considerations

The Ontology Service can run multiple replicas on the `oneplatform-internal` network. Stateless design enables horizontal scaling with the following caveats:

- **Advisory locks:** The session-mode PgBouncer pool means each replica holds its own Postgres connections. Advisory locks are per-connection in session mode, which means they are per-replica. `pg_try_advisory_lock` is used (non-blocking), and the `ontology.migrations` status column acts as a secondary coordination mechanism — a second replica checking the DB will see `status='running'` and reject a duplicate confirm attempt before even trying to acquire the lock.

- **Orphan cleanup job:** Uses a Redis distributed lock (`SET ontology:cleanup:lock {instanceId} NX EX 3600`) to ensure only one replica runs the cleanup at a time.

- **BullMQ workers:** Multiple replicas all connect to the same BullMQ queue (`ontology:map`). BullMQ handles worker concurrency natively — each job is consumed by exactly one worker. Worker concurrency per replica is configurable via `OP_MAPPING_CONCURRENCY` (default: 5).

- **PgBouncer session pool sizing:** With 15 session-mode connections shared across all replicas, the practical maximum is 2–3 replicas (each holding 5–7 connections). Scaling beyond 3 replicas requires increasing the PgBouncer session pool size and the Postgres `max_connections` accordingly. This is documented in the scaling wall notes in the L1 design (ADR-5).

### 16.4 Environment Variables Reference

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | 3003 | HTTP server port |
| `DATABASE_URL` | Yes | — | PgBouncer connection string (session mode) |
| `REDIS_URL` | Yes | — | Redis connection URL |
| `REDIS_USERNAME` | Yes | — | Redis ACL username (`op_ontology`) |
| `OP_JWT_SECRET` | Yes | — | HMAC-SHA256 secret for JWT validation |
| `OP_CURSOR_SECRET` | Yes | — | HMAC-SHA256 secret for cursor signing |
| `OP_MASTER_KEY_PATH` | Yes | `/data/init/master.key` | Path to AES-256-GCM master key |
| `OP_MIGRATION_TIMEOUT` | No | 3600 | Max migration duration in seconds |
| `OP_MAPPING_ERROR_RETENTION_DAYS` | No | 30 | Retention for mapping error records |
| `OP_MAPPING_CONCURRENCY` | No | 5 | BullMQ mapping worker concurrency per replica |
| `EXECUTION_SERVICE_URL` | Yes | — | URL of Execution Service |
| `NODE_ENV` | Yes | — | `development` or `production` |

---

## Appendix A: Data Flow Diagram

```
External source data
        |
        | (Ingestion Service writes DataEnvelope to ingestion.raw_{connectorId})
        | (Ingestion Service enqueues ontology:map BullMQ job)
        v
Ontology Service mapping worker (BullMQ consumer)
        |
        |-- Load mapping rules from cache / DB (ontology.mapping_rules)
        |-- Load Zod validators from cache (OntologySnapshot.zodValidator)
        |-- For expression transforms: POST /internal/execution/run (batch)
        |                                     |
        |                         Execution Service (isolated-vm sandbox)
        |                         Returns transform results
        |-- Validate each record against entity Zod schema
        |
        |-- Valid records: UPSERT → tenant_{tenantId}.{entitySlug}
        |-- Failed records: INSERT → ontology.mapping_errors
        |
        |-- Publish data.created / data.updated to Redis pub/sub
        v
tenant_{tenantId}.{entitySlug} (live entity table)
        |
        | Queried by:
        |-- Gateway Service (auto-generated REST endpoints via OntologySnapshot.routeDefinition)
        |-- App Service BFF (useQuery hooks)
        |-- Pipeline Service (step data access)
        +-- Ontology Service (migration UNION view, schema inference)

Schema change flow:
        |
        | User: PATCH /api/v1/ontology/{entityType} → Breaking change
        v
Ontology Service: INSERT ontology.migrations (pending_confirmation)
        |
        | User: POST /api/v1/ontology/migrations/{id}/confirm
        v
Ontology Service: Acquire advisory lock → Create UNION view → Enqueue migration job
        |
        | Pipeline Service BullMQ worker:
        |   For each batch of 1000 rows:
        |     BEGIN; CREATE shadow_table; INSERT registry; transform rows; COMMIT
        |
        | On complete: DROP UNION view → UPDATE migration status → Release lock
        |              PUBLISH ontology:changed to Redis
        v
Consumer services (Gateway, App, Pipeline, Ingestion):
  Receive ontology:changed → GET /internal/ontology/schema → Hot-swap cache
```

---

## Appendix B: Backward-Compatibility vs. Breaking Change Reference

| Change | Classification | Migration required |
|---|---|---|
| Add nullable field (with or without default) | Backward-compatible | No |
| Add required field with non-null default | Backward-compatible | No |
| Add required field without default to empty entity | Backward-compatible | No |
| Add required field without default to entity with data | Breaking | Yes |
| Add new entity | Backward-compatible | No |
| Add enum value | Backward-compatible | No |
| Remove enum value | Breaking | Yes |
| Widen type (string → json) | Backward-compatible | No |
| Narrow type (string → number) | Breaking | Yes |
| Remove field | Breaking | Yes |
| Rename field | Breaking | Yes (treated as remove + add) |
| Change nullable=true → nullable=false on empty entity | Backward-compatible | No |
| Change nullable=true → nullable=false with null values in data | Breaking | Yes |
| Change validation to less restrictive | Backward-compatible | No |
| Change validation to more restrictive | Breaking | Yes |
| Remove relationship | Breaking | Yes |
| Add relationship | Backward-compatible | No |
| Delete entity with no data | Backward-compatible | No |
| Delete entity with data | Breaking | Yes |
| Change is_public | Backward-compatible | No |

---

*This document is the canonical L2 design for the Ontology Service. Changes to interfaces, database schema, or migration protocols described here require updating this document and the corresponding ADRs before implementation begins.*
