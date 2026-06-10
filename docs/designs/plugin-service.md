# Plugin Service — L2 Service Design

**Date:** 2026-06-10
**Status:** APPROVED
**Service:** Plugin Service
**Port:** 3008
**Reference hierarchy:**
- L0: `docs/decisions/001-architecture-decisions.md` (ADR 1–29)
- L0: `docs/decisions/002-expanded-architecture-decisions.md` (ADR 30–36; ADR-31, ADR-32, ADR-33 are primary)
- L1: `docs/superpowers/specs/2026-06-10-oneplatform-design.md` (§7.9, §8)
- **L2: This document**
- L3: `services/plugin-service/src/`

---

## Table of Contents

1. [Service Overview](#1-service-overview)
2. [Database Schema](#2-database-schema)
3. [API Endpoints](#3-api-endpoints)
4. [Plugin Installation Flow](#4-plugin-installation-flow)
5. [Plugin State Machine](#5-plugin-state-machine)
6. [Instance Management](#6-instance-management)
7. [Hook Registry](#7-hook-registry)
8. [Internal Endpoints](#8-internal-endpoints)
9. [Connector Registration](#9-connector-registration)
10. [Version Upgrade and Rollback](#10-version-upgrade-and-rollback)
11. [Uninstall Guards](#11-uninstall-guards)
12. [MinIO Integration](#12-minio-integration)
13. [Error Handling](#13-error-handling)
14. [Observability](#14-observability)
15. [Security Design](#15-security-design)
16. [Testing Strategy](#16-testing-strategy)
17. [Deployment](#17-deployment)

---

## 1. Service Overview

### 1.1 Responsibility

The Plugin Service manages the complete lifecycle of OnePlatform plugins: installation, validation, storage, enabling per-tenant, disabling, version upgrade, and uninstall. It is the authoritative registry for hooks and connectors, distributes plugin bundles to the Execution Service on demand, and registers connectors with the Ingestion Service when enabled.

The Plugin Service is a **lifecycle-only** service. It never executes plugin code. All code execution — including the entrypoint validation call made during installation — is delegated to the Execution Service.

### 1.2 Network Placement

```
oneplatform-public network:
  (none — the Plugin Service has no public-facing port)

oneplatform-internal network:
  Plugin Service  :3008   (internal only)

Outbound calls:
  → Execution Service  :3005   POST /internal/execution/run (entrypoint validation)
  → Execution Service  :3005   POST /internal/execution/plugin-drain
  → Execution Service  :3005   POST /internal/execution/plugin-cache-invalidate
  → Ingestion Service  :3002   POST /internal/ingestion/connectors (connector register)
  → Ingestion Service  :3002   DELETE /internal/ingestion/connectors/instance/{instanceId}
  → Ingestion Service  :3002   DELETE /internal/ingestion/connectors/plugin/{pluginId}
  → MinIO              :9000   S3 API (bundle upload / download)

Inbound internal calls:
  ← Gateway Service    :3000   → /api/v1/plugins/**  (proxied public API)
  ← Execution Service  :3005   → GET /internal/plugins/{id}/bundle
  ← App Service        :3006   → GET /internal/plugins/widgets
  ← Pipeline Service   :3004   → GET /internal/plugins/hooks
  ← Ingestion Service  :3002   → GET /internal/plugins/connectors
```

### 1.3 Startup Dependencies

The Plugin Service performs a health-gated startup sequence. It must not accept requests until all of the following pass:

| Dependency | Check | Failure action |
|---|---|---|
| PostgreSQL (via PgBouncer :5433) | `SELECT 1` | Retry with exponential backoff, max 60s |
| MinIO :9000 | `GET /minio/health/live` | Retry with exponential backoff, max 60s |
| `plugin-bundles` bucket exists | `HeadBucket` | Create bucket if missing, apply lifecycle policy |
| Redis (key-prefix `~plugin:*`) | `PING` | Retry with exponential backoff, max 30s |
| Database migrations | Drizzle migrate | Fatal if migration fails — container exits with code 1 |

The service does NOT wait for Execution Service or Ingestion Service at startup. Those are called lazily; inter-service failures produce 502 responses to the caller.

### 1.4 Environment Variables

| Variable | Description | Default |
|---|---|---|
| `DATABASE_URL` | PgBouncer connection string | Required |
| `REDIS_URL` | Redis connection string | Required |
| `OP_S3_ENDPOINT` | MinIO/S3 endpoint | `http://minio:9000` |
| `OP_S3_ACCESS_KEY` | MinIO access key | Required |
| `OP_S3_SECRET_KEY` | MinIO secret key | Required |
| `OP_S3_REGION` | S3 region | `us-east-1` |
| `OP_PLUGIN_BUNDLE_BUCKET` | S3 bucket for bundles | `plugin-bundles` |
| `OP_SERVICE_TOKEN_SECRET` | Shared inter-service signing secret | Required |
| `EXECUTION_SERVICE_URL` | Internal URL for Execution Service | `http://execution-service:3005` |
| `INGESTION_SERVICE_URL` | Internal URL for Ingestion Service | `http://ingestion-service:3002` |
| `OP_PLUGIN_BUNDLE_RETENTION_DAYS` | Days to retain bundle after uninstall | `7` |
| `OP_PLUGIN_UPGRADE_ROLLBACK_HOURS` | Hours old version is kept for rollback | `24` |
| `OP_PLUGIN_DRAIN_GRACE_SECONDS` | Grace period for disable drain | `60` |
| `LOG_LEVEL` | `debug` / `info` / `warn` / `error` | `info` |
| `NODE_ENV` | `development` / `production` | `production` |

---

## 2. Database Schema

All tables live in the `plugin` PostgreSQL schema. The Plugin Service connects via PgBouncer in **transaction mode** (per ADR Decision 5; the Plugin Service does not use `LISTEN/NOTIFY` or advisory locks).

```sql
-- ============================================================
-- plugin.plugins
-- Platform-wide installation record. One row per (id, version).
-- active_version_id is the pointer that the service resolves.
-- ============================================================
CREATE TABLE plugin.plugins (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Stable identity key from manifest. e.g. "com.example.shopify-connector"
    -- Combined with version forms a unique pair.
    manifest_id         TEXT        NOT NULL,
    name                TEXT        NOT NULL,
    version             TEXT        NOT NULL,          -- SemVer, e.g. "1.2.0"
    type                TEXT        NOT NULL
                        CHECK (type IN (
                            'connector','transformer','destination',
                            'auth-provider','widget'
                        )),

    -- Lifecycle status of this specific version record.
    -- 'installed'           — validated, stored, not yet active
    -- 'active'              — currently serving requests (at most one per manifest_id)
    -- 'staged'              — new version installed, pending atomic swap activation
    -- 'draining'            — old version during upgrade grace period
    -- 'disabled'            — explicitly disabled or post-drain holdover
    -- 'uninstalled'         — uninstall requested; bundle retained until retention expires
    status              TEXT        NOT NULL DEFAULT 'installed'
                        CHECK (status IN (
                            'installed','active','staged',
                            'draining','disabled','uninstalled'
                        )),

    -- MinIO reference — bucket + object key. Bundle bytes live in MinIO, not here.
    bundle_bucket       TEXT        NOT NULL,
    bundle_key          TEXT        NOT NULL,   -- e.g. "com.example.shopify-connector/1.2.0/bundle.js"

    -- Full manifest stored for display and validation replay. JSONB for query flexibility.
    manifest            JSONB       NOT NULL,

    -- Platform-wide flag: if true, available to ALL tenants without per-tenant install.
    is_platform_wide    BOOLEAN     NOT NULL DEFAULT FALSE,

    -- GPG: fingerprint stored if signed; NULL if unsigned.
    gpg_fingerprint     TEXT,

    -- Timestamps
    installed_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    installed_by        UUID        NOT NULL,   -- FK: auth.users.id (platform admin)
    uninstalled_at      TIMESTAMPTZ,
    bundle_delete_after TIMESTAMPTZ,            -- Computed: uninstalled_at + retention interval

    CONSTRAINT plugins_manifest_version_unique UNIQUE (manifest_id, version)
);

-- Active-version pointer lookup (most frequent query path)
CREATE UNIQUE INDEX idx_plugins_active_per_manifest
    ON plugin.plugins (manifest_id)
    WHERE status = 'active';

-- Full-text search on name + manifest_id for plugin listing
CREATE INDEX idx_plugins_name ON plugin.plugins USING GIN (to_tsvector('english', name));
CREATE INDEX idx_plugins_status ON plugin.plugins (status);
CREATE INDEX idx_plugins_type ON plugin.plugins (type);
CREATE INDEX idx_plugins_bundle_delete ON plugin.plugins (bundle_delete_after)
    WHERE bundle_delete_after IS NOT NULL;


-- ============================================================
-- plugin.instances
-- Per-tenant enablement of a plugin. A single plugin can have
-- multiple instances within one tenant (e.g., two Salesforce orgs).
-- ============================================================
CREATE TABLE plugin.instances (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Which plugin installation this instance belongs to.
    -- References the stable manifest_id, not the version-specific UUID,
    -- so the instance survives version upgrades.
    plugin_manifest_id  TEXT        NOT NULL,  -- FK: plugin.plugins.manifest_id (logical)

    -- Which specific version this instance currently targets.
    plugin_id           UUID        NOT NULL REFERENCES plugin.plugins(id),

    tenant_id           UUID        NOT NULL,

    -- Human-readable label chosen by the tenant admin.
    display_name        TEXT        NOT NULL,

    -- JSON-validated against manifest.configSchema at creation and on update.
    config              JSONB       NOT NULL DEFAULT '{}',

    -- 'enabled'    — hooks active, connector registered
    -- 'disabling'  — drain in progress (transitional, should not persist > 90s)
    -- 'disabled'   — gracefully stopped
    enabled             TEXT        NOT NULL DEFAULT 'disabled'
                        CHECK (enabled IN ('enabled','disabling','disabled')),

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by          UUID        NOT NULL,   -- FK: auth.users.id (tenant admin)
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by          UUID,

    -- Soft-delete: instances are never hard-deleted within the retention window.
    deleted_at          TIMESTAMPTZ
);

CREATE INDEX idx_instances_plugin ON plugin.instances (plugin_manifest_id);
CREATE INDEX idx_instances_tenant ON plugin.instances (tenant_id);
CREATE INDEX idx_instances_enabled ON plugin.instances (enabled) WHERE deleted_at IS NULL;
CREATE INDEX idx_instances_tenant_plugin ON plugin.instances (tenant_id, plugin_manifest_id)
    WHERE deleted_at IS NULL;


-- ============================================================
-- plugin.hooks
-- One row per hook declaration per instance.
-- Registered at enable time from manifest.hooks[].
-- ============================================================
CREATE TABLE plugin.hooks (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Back-references to the plugin installation and instance.
    plugin_id           UUID        NOT NULL REFERENCES plugin.plugins(id),
    instance_id         UUID        NOT NULL REFERENCES plugin.instances(id),

    tenant_id           UUID        NOT NULL,

    -- Hook stage. e.g. "before:ingestion.receive", "after:pipeline.complete"
    stage               TEXT        NOT NULL,

    -- 'critical'  — chain aborts on timeout or failure
    -- 'advisory'  — chain continues with pre-hook payload on failure
    criticality         TEXT        NOT NULL
                        CHECK (criticality IN ('critical','advisory')),

    -- Sort key within the stage for this tenant. Lower = earlier in chain.
    priority            INTEGER     NOT NULL DEFAULT 100
                        CHECK (priority BETWEEN 0 AND 999),

    -- Timeout in seconds for this hook invocation. Max 300.
    timeout_seconds     INTEGER     NOT NULL DEFAULT 30
                        CHECK (timeout_seconds BETWEEN 1 AND 300),

    -- Named export in bundle.js to call for this hook.
    entrypoint          TEXT        NOT NULL,

    -- Hook lifecycle state:
    -- 'inactive' — registered but instance not yet enabled
    -- 'active'   — live, returned in chain resolution queries
    -- 'staged'   — new version pre-registered, not yet in active chain
    -- 'disabled' — instance disabled or old version post-swap
    state               TEXT        NOT NULL DEFAULT 'inactive'
                        CHECK (state IN ('inactive','active','staged','disabled')),

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Primary hot path: resolve hook chain for a stage + tenant
CREATE INDEX idx_hooks_stage_tenant_active
    ON plugin.hooks (stage, tenant_id)
    WHERE state = 'active';

-- Used during version upgrade to transition 'staged' hooks atomically
CREATE INDEX idx_hooks_plugin_state
    ON plugin.hooks (plugin_id, state);

CREATE INDEX idx_hooks_instance ON plugin.hooks (instance_id);


-- ============================================================
-- plugin.approved_urls
-- Per-installation URL patterns explicitly approved by a platform admin.
-- Enforced by the Execution Service FetchProxy at runtime.
-- ============================================================
CREATE TABLE plugin.approved_urls (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- The plugin installation this approval belongs to (version-specific).
    plugin_id           UUID        NOT NULL REFERENCES plugin.plugins(id),

    -- Glob pattern from manifest.requiredExternalUrls, e.g.
    -- "https://api.shopify.com/**"
    url_pattern         TEXT        NOT NULL,

    approved_by         UUID        NOT NULL,   -- FK: auth.users.id (platform admin)
    approved_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT approved_urls_plugin_pattern_unique UNIQUE (plugin_id, url_pattern)
);

CREATE INDEX idx_approved_urls_plugin ON plugin.approved_urls (plugin_id);
```

### 2.1 Schema Notes

**Why `manifest_id` is TEXT, not a UUID FK.** The manifest ID is a reverse-domain string controlled by the plugin author (e.g., `com.example.shopify-connector`). Multiple version rows share the same `manifest_id` — it is the plugin's stable identity across upgrades. Using it as TEXT avoids a separate identity table and matches the external-facing ID that appears in all API responses and CLI output.

**Why `config` is JSONB, not a separate config table.** A plugin's config schema is plugin-defined and changes with each version. Storing config as JSONB with application-layer validation against `manifest.configSchema` (via Ajv) is simpler than EAV or schema-per-plugin tables. The trade-off (no DB-level field constraints) is acceptable because the application layer enforces the schema on every write.

**Why `plugin.instances.plugin_id` references the version row.** At any moment an instance is running a specific version of a plugin. During upgrade, the pointer is updated atomically. This allows the service to join instances → hooks without ambiguity about which version's hooks are active.

---

## 3. API Endpoints

### 3.1 Authentication

All public endpoints require a valid JWT Bearer token or API key. The Gateway Service validates the token and forwards it with the request. The Plugin Service performs a second-layer authorization check for role and scope.

Required scope for write operations: `plugins:manage`
Required scope for read operations: `plugins:read`
Inter-service calls carry an `X-Service-Token` header (HMAC-SHA256 signed per ADR Decision 19).

### 3.2 Public API Endpoints

#### GET /api/v1/plugins

List installed plugins. Platform-wide. No tenant scoping — all installed plugins are visible.

**Query parameters:**

| Parameter | Type | Description |
|---|---|---|
| `type` | `connector\|transformer\|destination\|auth-provider\|widget` | Filter by plugin type |
| `status` | `installed\|active\|disabled\|uninstalled` | Filter by status |
| `q` | string | Full-text search on name and manifest_id |
| `cursor` | string | Pagination cursor |
| `limit` | integer | Page size, default 50, max 100 |

**Response 200:**
```typescript
interface PluginListResponse {
  items: PluginSummary[];
  nextCursor: string | null;
  total: number;
}

interface PluginSummary {
  id: string;               // UUID of the active version row
  manifestId: string;       // e.g. "com.example.shopify-connector"
  name: string;
  version: string;
  type: PluginType;
  status: PluginStatus;
  description: string;
  author: string;
  installedAt: string;      // ISO 8601
  instanceCount: number;    // Total enabled instances across all tenants
}
```

**Errors:** 401, 403 (insufficient scope)

---

#### POST /api/v1/plugins

Install a plugin. Accepts a multipart form upload.

**Request (multipart/form-data):**

| Field | Type | Required | Description |
|---|---|---|---|
| `bundle` | File | Yes | The `.oppkg` file |
| `signature` | File | No | Detached GPG signature (`.sig` file) |
| `approveUrls` | `true\|false` | No | Auto-approve all requiredExternalUrls (default `false`) |
| `platformWide` | `true\|false` | No | Make available to all tenants (default `false`) |

**Zod validation schema (applied to parsed form fields, not the binary):**
```typescript
const InstallPluginSchema = z.object({
  approveUrls:  z.coerce.boolean().default(false),
  platformWide: z.coerce.boolean().default(false),
});
```

**Processing steps (see §4 for full detail):**
1. Receive multipart upload to temp file; verify Content-Type is `application/octet-stream` or `application/x-tar`.
2. Extract tarball, validate structure.
3. Parse and validate manifest against `PluginManifestZodSchema`.
4. Verify `bundleChecksum` (SHA-256) against extracted `dist/bundle.js`.
5. Verify GPG signature if `gpgFingerprint` present in manifest.
6. If `approveUrls=false` and `requiredExternalUrls` is non-empty, return 202 with approval required payload.
7. Call Execution Service to validate entrypoint is callable.
8. Store bundle in MinIO, insert `plugin.plugins` row.
9. Insert `plugin.approved_urls` rows for approved patterns.
10. Emit `plugin.installed` event.

**Response 201:**
```typescript
interface InstallPluginResponse {
  id: string;               // UUID of the new plugin.plugins row
  manifestId: string;
  name: string;
  version: string;
  type: PluginType;
  status: "installed";
  requiredApprovals?: UrlApprovalRequest[]; // Present when approveUrls=false and URLs exist
}

interface UrlApprovalRequest {
  urlPattern: string;
  reason: string;   // "Declared in manifest.requiredExternalUrls"
}
```

**Response 202 (approval required):**
Returned when `requiredExternalUrls` is non-empty and `approveUrls` was not set to `true`. The plugin is NOT stored yet. The caller must resubmit with explicit `approveUrls=true` or handle the approval flow.

**Response 200 (idempotent):**
Same `manifest_id` + `version` already installed; returns existing record unchanged.

**Errors:**

| Code | HTTP | Description |
|---|---|---|
| `INVALID_MANIFEST` | 422 | Manifest failed Zod validation; `details.fieldErrors` present |
| `CHECKSUM_MISMATCH` | 422 | SHA-256 of bundle.js does not match manifest.bundleChecksum |
| `GPG_VERIFICATION_FAILED` | 422 | GPG signature invalid or fingerprint not in trusted list |
| `INVALID_PACKAGE_STRUCTURE` | 422 | Tarball missing required files |
| `ENTRYPOINT_NOT_CALLABLE` | 422 | Execution Service could not call metadata() on entrypoint |
| `PLATFORM_VERSION_TOO_OLD` | 422 | manifest.minPlatformVersion exceeds current platform version |
| `CIRCULAR_DEPENDENCY` | 422 | Hook dependency graph contains a cycle |
| `UPLOAD_TOO_LARGE` | 413 | Bundle exceeds 50MB limit |

---

#### GET /api/v1/plugins/{id}

Fetch a single plugin installation record by its UUID or by its `manifestId`.

**Path parameter:** `id` — UUID of a `plugin.plugins` row, OR the `manifest_id` string (the service resolves `manifest_id` to the active version row).

**Response 200:**
```typescript
interface PluginDetailResponse {
  id: string;
  manifestId: string;
  name: string;
  version: string;
  type: PluginType;
  status: PluginStatus;
  manifest: PluginManifest;   // Full manifest object
  bundleSizeBytes: number;
  installedAt: string;
  installedBy: string;        // User ID (not email — no PII in plugin responses)
  gpgFingerprint: string | null;
  approvedUrls: string[];
  instances: PluginInstanceSummary[];
}

interface PluginInstanceSummary {
  instanceId: string;
  tenantId: string;
  displayName: string;
  enabled: "enabled" | "disabling" | "disabled";
  createdAt: string;
}
```

**Errors:** 404 (`PLUGIN_NOT_FOUND`)

---

#### DELETE /api/v1/plugins/{id}

Uninstall a plugin. Runs uninstall guards (§11) before proceeding.

**Query parameters:**

| Parameter | Type | Description |
|---|---|---|
| `confirmOrphan` | `true\|false` | Required if data orphan warning returned previously |

**Response 200:**
```typescript
interface UninstallResponse {
  manifestId: string;
  status: "uninstalled";
  bundleDeleteAfter: string;  // ISO 8601 — when physical deletion will occur
  orphanWarning?: OrphanWarning;
}

interface OrphanWarning {
  entityTypes: string[];
  totalRecords: number;
  message: string;
}
```

**Errors:**

| Code | HTTP | Description |
|---|---|---|
| `PLUGIN_HAS_ACTIVE_INSTANCES` | 422 | One or more instances are in `enabled` state |
| `PLUGIN_HAS_ACTIVE_JOBS` | 422 | Active BullMQ jobs reference this plugin |
| `ORPHAN_CONFIRMATION_REQUIRED` | 409 | Data orphan warning; resubmit with `?confirmOrphan=true` |

---

#### GET /api/v1/plugins/{id}/instances

List all instances of a plugin. Platform admins see all tenants; tenant admins see only their tenant.

**Response 200:**
```typescript
interface InstanceListResponse {
  items: PluginInstance[];
}

interface PluginInstance {
  instanceId: string;
  pluginManifestId: string;
  pluginId: string;          // Version-specific UUID
  tenantId: string;
  displayName: string;
  config: Record<string, unknown>;  // Scrubbed of credential fields
  enabled: "enabled" | "disabling" | "disabled";
  createdAt: string;
  updatedAt: string;
}
```

---

#### POST /api/v1/plugins/{id}/instances

Enable a plugin for a tenant (create an instance).

**Request body:**
```typescript
const CreateInstanceSchema = z.object({
  displayName: z.string().min(1).max(255),
  config:      z.record(z.unknown()).default({}),
});
```

**Processing steps:**
1. Resolve plugin by `id` (must be in `active` status).
2. Validate `config` against `manifest.configSchema` using Ajv draft-07.
3. Insert `plugin.instances` row with `enabled = 'disabled'`.
4. Insert `plugin.hooks` rows (state: `inactive`) from `manifest.hooks[]`.
5. Mark instance `enabled = 'enabled'`, hooks `state = 'active'`.
6. If plugin type is `connector`, call Ingestion Service registration (§9).
7. Emit `plugin.enabled` event.

**Response 201:**
```typescript
interface CreateInstanceResponse {
  instanceId: string;
  pluginManifestId: string;
  tenantId: string;
  displayName: string;
  enabled: "enabled";
  createdAt: string;
}
```

**Errors:**

| Code | HTTP | Description |
|---|---|---|
| `PLUGIN_NOT_ACTIVE` | 422 | Plugin is not in `active` status |
| `CONFIG_VALIDATION_FAILED` | 422 | Config does not conform to manifest.configSchema; `details.ajvErrors` present |
| `CONNECTOR_REGISTRATION_FAILED` | 502 | Ingestion Service returned non-2xx |

---

#### PATCH /api/v1/plugins/{id}/instances/{instanceId}

Update instance config or enable/disable an instance.

**Request body:**
```typescript
const PatchInstanceSchema = z.object({
  displayName: z.string().min(1).max(255).optional(),
  config:      z.record(z.unknown()).optional(),
  enabled:     z.boolean().optional(),
}).refine(
  data => Object.keys(data).length > 0,
  { message: "At least one field must be provided" }
);
```

**Processing for `enabled: false` (disable):**
1. Set instance `enabled = 'disabling'`.
2. Call Execution Service `POST /internal/execution/plugin-drain` with `{ pluginId: instance.plugin_manifest_id, tenantId: instance.tenant_id, instanceId: instance.id, gracePeriodMs: 60000 }`.
3. Set all instance hooks to `state = 'disabled'`.
4. If plugin type is `connector`, call Ingestion Service deregistration.
5. Send cache invalidation to Execution Service: `POST /internal/execution/plugin-cache-invalidate` with `{ pluginId: instance.plugin_manifest_id, tenantId: instance.tenant_id, newBundleVersion: currentVersion }`.
6. After drain acknowledgment (or 60s timeout), set instance `enabled = 'disabled'`.
7. Emit `plugin.disabled` event.

**Processing for `enabled: true` (re-enable):**
Identical to the create-instance enable path, reusing the existing instance row.

**Processing for config update:**
Re-validate config against current manifest.configSchema. If the instance is `enabled`, emit a Redis pub/sub cache-invalidate so the Execution Service re-fetches the updated config on next invocation. No drain required for config-only updates.

**Response 200:** Updated `PluginInstance` object.

**Errors:** 404 (`INSTANCE_NOT_FOUND`), 422 (`CONFIG_VALIDATION_FAILED`), 409 if trying to enable a plugin not in `active` status.

---

### 3.3 Upgrade Endpoints

#### POST /api/v1/plugins/{manifestId}/upgrade

Activate a staged version.

**Request body:**
```typescript
const UpgradeSchema = z.object({
  toVersion:   z.string(),                      // Target SemVer version (must be 'staged')
  scheduledAt: z.string().datetime().optional(), // ISO 8601; if absent, activate immediately
});
```

**Response 202:** Upgrade scheduled or in progress. See §10 for full procedure.

---

#### POST /api/v1/plugins/{manifestId}/rollback

Roll back to the previous version within the 24-hour window.

**Response 200** on success, **422** if rollback window expired.

---

### 3.4 Error Response Envelope

All error responses use the standard platform envelope:

```typescript
interface ErrorResponse {
  error: {
    code: string;            // Machine-readable error code
    message: string;         // Human-readable message
    requestId: string;       // X-Request-ID, for log correlation
    details?: Record<string, unknown>;  // Structured extra info (e.g., fieldErrors, ajvErrors)
  };
}
```

---

## 4. Plugin Installation Flow

### 4.1 Overview

```
Client (CLI / frontend)
    │
    │  POST /api/v1/plugins  (multipart: bundle.oppkg [+ bundle.sig])
    ▼
Plugin Service
    │
    ├─ 1. Receive multipart → temp file
    ├─ 2. Extract tarball   → validate file structure
    ├─ 3. Parse + validate manifest (Zod)
    ├─ 4. SHA-256 checksum verification
    ├─ 5. GPG verification (if gpgFingerprint present)
    ├─ 6. Platform version compatibility check
    ├─ 7. URL approval check / prompt
    ├─ 8. Circular dependency check on hooks
    ├─ 9. Entrypoint validation (→ Execution Service)
    ├─ 10. MinIO upload
    ├─ 11. Postgres insert (plugin.plugins + plugin.approved_urls)
    ├─ 12. Emit plugin.installed event
    └─ 13. Return 201
```

### 4.2 Tarball Extraction

The `.oppkg` file is a gzip-compressed tar archive. Required structure:

```
{plugin-id}-{version}.oppkg
├── plugin.manifest.json        (required)
├── dist/
│   ├── bundle.js               (required)
│   └── bundle.js.sha256        (required)
└── {anything else}             (ignored)
```

Extraction is performed with `tar -xzf` to a unique temp directory under `/tmp/oneplatform-plugins/{uuid}/`. Path traversal attacks are prevented by rejecting any tar entry whose resolved path does not start with the temp directory (zip-slip defense). The service reads at most 50MB of decompressed content; exceeding this limit returns `UPLOAD_TOO_LARGE`.

After processing the temp files are deleted unconditionally in a `finally` block.

### 4.3 Manifest Validation

The manifest is validated against the following Zod schema. This is the authoritative schema — the same object is also exported from `@oneplatform/plugin-sdk` for use in the `op plugin validate` CLI command.

```typescript
const HookDeclarationSchema = z.object({
  stage:       z.string().regex(/^(before|after):\w[\w.]*(?::\w+)?$/,
                 "Stage must be 'before:{name}' or 'after:{name}'"),
  criticality: z.enum(['critical', 'advisory']),
  priority:    z.number().int().min(0).max(999).default(100),
  timeout:     z.number().int().min(1).max(300).optional(),
  entrypoint:  z.string().min(1),
});

const PluginManifestSchema = z.object({
  manifestVersion:     z.literal('1'),
  id:                  z.string()
                         .regex(/^[a-z0-9]+(?:\.[a-z0-9-]+)+$/, "Must be reverse-domain format"),
  name:                z.string().min(1).max(100),
  version:             z.string().regex(/^\d+\.\d+\.\d+(?:[-+].+)?$/, "Must be SemVer"),
  type:                z.enum(['connector','transformer','destination','auth-provider','widget']),
  description:         z.string().max(200),
  author:              z.string().min(1),
  supportUrl:          z.string().url().optional(),
  homepageUrl:         z.string().url().optional(),
  icon:                z.string().optional(),
  minPlatformVersion:  z.string().regex(/^\d+\.\d+\.\d+/, "Must be SemVer"),
  entrypoint:          z.string().min(1),
  configSchema:        z.record(z.unknown()),   // JSON Schema object — structural validation only
  hooks:               z.array(HookDeclarationSchema),
  requiredExternalUrls: z.array(z.string()),
  requiredApis:        z.array(z.enum([
                         'credentials','fetch','cache','ontology','tracing'
                       ])),
  requiredCredentials: z.array(z.object({
                         name:        z.string().min(1),
                         description: z.string(),
                         type:        z.enum(['secret','password','token','certificate']),
                         required:    z.boolean(),
                       })),
  bundleChecksum:      z.string().regex(/^[0-9a-f]{64}$/, "Must be 64-char hex SHA-256"),
  gpgFingerprint:      z.string().optional(),
  tags:                z.array(z.string()).optional(),
  license:             z.string().min(1),
  changelog:           z.string().optional(),
});
```

All Zod errors are collected with `safeParse` and returned in the `details.fieldErrors` map of the `INVALID_MANIFEST` error response. The entire manifest is validated in a single pass — partial failures do not abort mid-validation.

### 4.4 Bundle Checksum Verification

```typescript
import { createHash } from 'node:crypto';

async function verifyBundleChecksum(
  bundlePath: string,
  expectedChecksum: string,
): Promise<void> {
  const hash = createHash('sha256');
  const stream = fs.createReadStream(bundlePath);

  await pipeline(stream, async function* (source) {
    for await (const chunk of source) {
      hash.update(chunk);
    }
  });

  const actual = hash.digest('hex');

  // Also verify the .sha256 sidecar file matches
  const sidecarChecksum = (await fs.readFile(bundlePath + '.sha256', 'utf8')).trim();

  if (actual !== expectedChecksum) {
    throw new PluginInstallError('CHECKSUM_MISMATCH', {
      expected: expectedChecksum,
      actual,
      source: 'manifest.bundleChecksum vs bundle.js content',
    });
  }

  if (sidecarChecksum !== expectedChecksum) {
    throw new PluginInstallError('CHECKSUM_MISMATCH', {
      expected: expectedChecksum,
      actual: sidecarChecksum,
      source: 'manifest.bundleChecksum vs bundle.js.sha256 sidecar',
    });
  }
}
```

The checksum is verified twice: against `manifest.bundleChecksum` and against the `dist/bundle.js.sha256` sidecar file. Both must match. This ensures the manifest and the sidecar agree with the bundle bytes.

### 4.5 GPG Signature Verification

GPG verification applies only when `manifest.gpgFingerprint` is non-null AND a `.sig` file was uploaded alongside the `.oppkg`.

**Configuration:** Platform admins manage trusted GPG public keys via:
- `POST /api/v1/admin/gpg-keys` — import a public key (armored text)
- `GET /api/v1/admin/gpg-keys` — list trusted fingerprints
- `DELETE /api/v1/admin/gpg-keys/{fingerprint}` — revoke trust

Trusted keys are stored in Postgres `plugin.trusted_gpg_keys` (not in this L2 scope but referenced here for completeness).

**Verification logic:**
1. Check `manifest.gpgFingerprint` against the `plugin.trusted_gpg_keys` table.
2. If fingerprint not found in trusted list: reject with `GPG_VERIFICATION_FAILED`.
3. Use `openpgp` (npm package, MIT license) to verify the detached signature over the raw `.oppkg` bytes using the stored public key.
4. If signature invalid: reject with `GPG_VERIFICATION_FAILED`.
5. If `manifest.gpgFingerprint` is set but no `.sig` file was uploaded: reject with `GPG_SIGNATURE_MISSING`.

When `manifest.gpgFingerprint` is absent, GPG verification is skipped entirely. No error is returned — GPG is optional.

### 4.6 Entrypoint Validation

Before storing the plugin, the Plugin Service calls the Execution Service to confirm the `entrypoint` named export is callable and returns valid metadata:

```
POST /internal/execution/run
{
  "pluginId":   "com.example.shopify-connector",
  "version":    "1.2.0",
  "entrypoint": "ShopifyConnector",
  "method":     "metadata",
  "args":       [],
  "bundleKey":  "com.example.shopify-connector/1.2.0/bundle.js",
  "bundleBucket": "plugin-bundles"
}
```

The Execution Service fetches the bundle from MinIO (using the same path the Plugin Service is about to write to — the Plugin Service uploads first, then calls for validation). If the call succeeds and returns a metadata object, validation passes. If the call fails (entrypoint not exported, metadata() throws, or bundle syntax error), the Plugin Service deletes the MinIO object and returns `ENTRYPOINT_NOT_CALLABLE`.

### 4.7 Circular Dependency Detection

Hook declarations can declare an optional `dependsOn: string[]` field in the manifest (list of stages that must have resolved before this hook runs). The Plugin Service builds a directed graph of hook stage dependencies and runs Kahn's algorithm to detect cycles. If a cycle exists, the install is rejected with `CIRCULAR_DEPENDENCY` and the `details.cycle` array showing the cycle path.

Note: the `dependsOn` field is not yet part of the v1 manifest schema. The circular dependency check in v1 applies only to implicit ordering (priority numbers within the same stage cannot create cycles, so v1 always passes this check). The check is implemented now so the guard exists when `dependsOn` is added in v2.

### 4.8 MinIO Storage

After all validation passes, the bundle is uploaded to MinIO. See §12 for full MinIO path conventions and retention policy.

---

## 5. Plugin State Machine

### 5.1 States

| State | Meaning | Scope |
|---|---|---|
| `installed` | Validated and stored; no tenant is using it yet | Platform-wide (version row) |
| `active` | The designated live version for this `manifest_id` | Platform-wide (version row) |
| `staged` | New version installed; pending activation via upgrade | Platform-wide (version row) |
| `draining` | Old version during upgrade grace period; no new dispatches | Platform-wide (version row) |
| `disabled` | Explicitly disabled or post-drain holdover (rollback window) | Platform-wide (version row) |
| `uninstalled` | Removed; bundle retained for retention period | Platform-wide (version row) |

Instance-level states mirror a subset:

| State | Meaning |
|---|---|
| `enabled` | Hooks active, connector registered |
| `disabling` | Drain in progress (transitional) |
| `disabled` | Gracefully stopped |

### 5.2 Transition Diagram

```
                    install (POST /api/v1/plugins)
                              │
                    ┌─────────▼────────┐
                    │    INSTALLED     │  Bundle in MinIO.
                    └─────────┬────────┘  Manifest validated.
                              │ (same manifest_id, new version)
                              │ install new version
                    ┌─────────▼────────┐
                    │     STAGED       │  New version ready.
                    └─────────┬────────┘  Old version still ACTIVE.
                              │ op plugin upgrade (atomic swap)
                    ┌─────────▼────────┐
                    │     ACTIVE       │  Hooks resolved. Connectors registered.
                    └─────────┬────────┘  At most ONE per manifest_id.
                              │ disable all instances, then DELETE /api/v1/plugins/{id}
                    ┌─────────▼────────┐
                    │   UNINSTALLED    │  Bundle retained OP_PLUGIN_BUNDLE_RETENTION_DAYS.
                    └──────────────────┘  Scheduled job deletes MinIO object.

  ACTIVE ──► DRAINING  (during version upgrade; 60s grace, no new dispatches)
  DRAINING ──► DISABLED (post-drain; retained 24h for rollback)
  DISABLED ──► UNINSTALLED (explicit DELETE, guards passed)

  INSTALLED ──► UNINSTALLED: only when zero instances exist (no tenants enabled it)
  ACTIVE ──► UNINSTALLED (direct): rejected, returns 422 "must disable all instances first"
  ENABLED instance ──► UNINSTALLED (direct): rejected, returns 422 "must disable first"
```

### 5.3 Guard Matrix

| Transition | Guards |
|---|---|
| `INSTALLED → ACTIVE` | Only via upgrade swap (§10); no direct path |
| `ACTIVE → DRAINING` | New staged version ready AND upgrade command issued |
| Any → `UNINSTALLED` | All instances must be `disabled`; no active BullMQ jobs; orphan confirmation if data exists |
| Instance `disabled → enabled` | Plugin must be in `active` status; config must validate |
| Instance `enabled → disabling` | Always allowed; initiates drain |

### 5.4 Invariants

These invariants are enforced by a CHECK constraint and application-level logic:

1. **At most one row per `manifest_id` can have `status = 'active'`.** Enforced by the unique partial index `idx_plugins_active_per_manifest`.
2. **An instance row cannot reference a plugin row in `uninstalled` status.** Enforced by application-layer guard before insert.
3. **A hook row in `active` state must have a corresponding instance row in `enabled` state.** Verified by the health check endpoint; repairs by the disable procedure.

---

## 6. Instance Management

### 6.1 Multi-Instance Model

A single plugin installation can be enabled multiple times within one tenant. Each enablement creates a distinct `plugin.instances` row with its own `config`, `display_name`, and `instance_id`. Hooks are registered once per instance — a tenant with two Shopify connector instances has two sets of hook rows in `plugin.hooks`.

The `TenantContext.instanceId` passed to the Execution Service is `plugin.instances.id`. The Execution Service caches bundles by `(pluginId, version)` and config by `instanceId`.

### 6.2 Config Validation

Config is validated against `manifest.configSchema` (JSON Schema Draft 7) using Ajv at every write operation:

- `POST /api/v1/plugins/{id}/instances` (on create)
- `PATCH /api/v1/plugins/{id}/instances/{instanceId}` (on config update)
- During version upgrade (existing config re-validated against new version's configSchema)

If re-validation fails during an upgrade (new version has a stricter configSchema), the upgrade is blocked with `CONFIG_MIGRATION_REQUIRED`. The platform admin must either update all affected instance configs before upgrading, or the plugin author must maintain backward compatibility in configSchema.

Ajv configuration:
```typescript
const ajv = new Ajv({
  allErrors: true,       // collect all errors, not just first
  strict: false,         // allow additional properties in config
  coerceTypes: false,    // no implicit type coercion — config must be typed correctly
});
addFormats(ajv);         // ajv-formats for date, email, uri, etc.
```

### 6.3 Credential Field Scrubbing

Instance configs are stored as-is in JSONB. However, when returning config in API responses, the Plugin Service scrubs any fields declared in `manifest.requiredCredentials` by replacing their values with `"[REDACTED]"`. The raw config (with credential values) is only ever passed to the Execution Service as part of a `TenantContext` — it is never returned in public API responses.

### 6.4 Enabling: Atomicity

Instance enable is a multi-step operation (insert instance row, insert hook rows, optionally register connector). These steps are wrapped in a Postgres transaction. If connector registration with the Ingestion Service fails (step outside the transaction), the transaction is rolled back and the instance reverts to `disabled`. The caller receives `CONNECTOR_REGISTRATION_FAILED`.

---

## 7. Hook Registry

### 7.1 Registration

Hooks are registered at instance enable time, not at install time. The Plugin Service reads `manifest.hooks[]` and inserts one `plugin.hooks` row per declaration per instance.

Example: a plugin with 3 hook declarations enabled by 2 tenants (one instance each) produces 6 hook rows.

### 7.2 Hook Lifecycle States

```
INACTIVE  ─► ACTIVE    (when instance is enabled)
ACTIVE    ─► DISABLED  (when instance is disabled)
INACTIVE  ─► STAGED    (when a new version is pre-registered for upgrade)
STAGED    ─► ACTIVE    (during atomic version swap — new version goes live)
ACTIVE    ─► DISABLED  (during atomic version swap — old version deactivated)
DISABLED  ─► ACTIVE    (when a disabled instance is re-enabled)
```

All transitions for a single instance's hooks happen in a single `UPDATE plugin.hooks SET state = ... WHERE instance_id = $1` statement inside a transaction. Partial hook state changes are not permitted.

### 7.3 Hook Chain Resolution

The Pipeline Service, Ingestion Service, Auth Service, and App Service query hook chains via the internal endpoint (§8.3). The Plugin Service resolves the chain with this query:

```sql
SELECT
    h.id,
    h.instance_id,
    h.plugin_id,
    h.tenant_id,
    h.stage,
    h.criticality,
    h.priority,
    h.timeout_seconds * 1000 AS timeout_ms,  -- convert to ms for ResolvedHook.timeoutMs
    h.entrypoint,
    p.manifest_id,
    p.bundle_key,
    p.bundle_bucket,
    p.version,
    i.config  -- scrubbed of credential fields in application layer
FROM plugin.hooks h
JOIN plugin.plugins p  ON h.plugin_id = p.id
JOIN plugin.instances i ON h.instance_id = i.id
WHERE h.stage     = $1
  AND h.tenant_id = $2
  AND h.state     = 'active'
ORDER BY h.priority ASC, h.id ASC;
```

The secondary sort by `h.id` ensures deterministic ordering when two hooks share the same priority value.

### 7.4 Priority Semantics

Priority is a number in the range 0–999. Lower numbers execute earlier in the chain. The default (100) places a hook in the middle of the priority space, leaving room for plugins that need to run before (0–99) or after (101–999) the default group.

Platform-internal hooks (if any are added in future) reserve priority 0–9 and 990–999. Third-party plugins are advised to use 10–989.

There is no conflict resolution for identical priority values beyond the deterministic secondary sort by UUID. Admins are responsible for ensuring meaningful priority assignments when multiple plugins register hooks on the same stage.

### 7.5 Hook Execution (Delegated)

The Plugin Service does not execute hooks. It provides the hook chain metadata; execution is the caller's responsibility. The resolved chain is a flat ordered array:

```typescript
interface ResolvedHook {
  hookId:         string;
  instanceId:     string;
  tenantId:       string;
  stage:          string;
  criticality:    "critical" | "advisory";
  priority:       number;
  timeoutMs:      number;  // Milliseconds — consistent with Node.js timeout APIs (timeout_seconds * 1000)
  entrypoint:     string;
  pluginId:       string;
  manifestId:     string;
  bundleBucket:   string;
  bundleKey:      string;
  version:        string;
  instanceConfig: Record<string, unknown>; // credential fields redacted
}
```

The caller (Pipeline Service, Ingestion Service, etc.) iterates this array and calls the Execution Service once per hook with the current data payload.

---

## 8. Internal Endpoints

All internal endpoints are on the `/internal/` path prefix. They require an `X-Service-Token` header containing an HMAC-SHA256 signature per ADR Decision 19. Requests without a valid service token receive `401`. The service token is validated by the `@oneplatform/core` inter-service auth middleware.

### 8.1 Bundle Delivery

```
GET /internal/plugins/{pluginId}/bundle
```

**Authorization:** Execution Service only (service token + RBAC matrix check).

**Path parameter:** `pluginId` — the `manifest_id` string (e.g., `com.example.shopify-connector`).

**Query parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `version` | string | No | Specific SemVer; defaults to the active version |

**Processing:**
1. Resolve `pluginId` + optional `version` to a `plugin.plugins` row.
2. If not found or status is `uninstalled`: return 404.
3. Fetch the bundle from MinIO using `bundle_bucket` + `bundle_key`.
4. Stream the response directly from MinIO to the caller (no buffer in Plugin Service memory).

**Response 200:**
- Content-Type: `application/octet-stream`
- `X-Plugin-Version`: resolved version string
- `X-Plugin-Checksum`: SHA-256 hex from `manifest.bundleChecksum`
- Body: raw bundle bytes (streaming)

**Response headers allow the Execution Service to:**
1. Verify checksum on receipt (belt-and-suspenders).
2. Cache by `(manifest_id, version)` keyed from `X-Plugin-Version`.

**Errors:** 404 (`PLUGIN_NOT_FOUND`), 503 if MinIO is unreachable.

### 8.2 Connector List

```
GET /internal/plugins/connectors
```

**Authorization:** Ingestion Service only.

**Query parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `tenantId` | UUID | Yes | Return connectors enabled for this tenant |

**Response 200:**
```typescript
interface ConnectorListResponse {
  connectors: EnabledConnector[];
}

interface EnabledConnector {
  instanceId:    string;
  pluginId:      string;   // manifest_id
  tenantId:      string;
  displayName:   string;
  metadata:      ConnectorMetadata;  // From manifest; includes outputSchema, supportsIncremental etc.
  version:       string;
  bundleBucket:  string;
  bundleKey:     string;
}
```

### 8.3 Hook Chain Resolution

```
GET /internal/plugins/hooks
```

**Authorization:** Pipeline Service, Ingestion Service, Auth Service, App Service (any internal service token).

**Query parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `stage` | string | Yes | e.g., `before:ingestion.receive` |
| `tenantId` | UUID | Yes | Tenant whose hooks to resolve |

**Response 200:**
```typescript
interface HookChainResponse {
  hooks: ResolvedHook[];  // Ordered by priority ASC (see §7.5 for shape)
}
```

**Response 200 with empty array:** valid — means no hooks registered for this stage+tenant. Callers must handle the empty case (proceed with no hooks, not an error).

**Performance target:** P99 < 10ms on the internal Docker network for a typical chain (≤ 20 hooks per stage+tenant). The query is indexed on `(stage, tenant_id)` WHERE `state = 'active'`.

### 8.4 Plugin Cache API

These endpoints back the `context.cache.*` API available to plugin code in the Execution Service sandbox. The Execution Service (which has no direct Redis access) proxies all cache operations to the Plugin Service, which stores them in Redis under scoped keys.

**Authorization:** Execution Service only (service token + RBAC matrix check).

```
GET    /internal/plugins/cache/:tenantId/:pluginId/:key
PUT    /internal/plugins/cache/:tenantId/:pluginId/:key
DELETE /internal/plugins/cache/:tenantId/:pluginId/:key
```

**Path parameters:**
- `tenantId` — UUID of the tenant scoping the cache entry
- `pluginId` — manifest ID of the plugin (e.g. `com.example.shopify-connector`)
- `key` — cache key (max 256 chars, URL-safe characters only)

**GET request:** Returns the cached value or 404 if not found.
```typescript
// Response: 200 OK
interface CacheGetResponse { value: unknown; }
// Response: 404 — key not found or expired
```

**PUT request:** Stores a value with optional TTL.
```typescript
const CachePutBodySchema = z.object({
  value:      z.unknown(),
  ttlSeconds: z.number().int().min(1).max(86400).optional().default(3600),
});
// Response: 200 OK — { stored: true }
```

**DELETE request:** Removes the key.
```typescript
// Response: 200 OK — { deleted: true }
```

**Redis key format:** `plugin:cache:{tenantId}:{pluginId}:{key}` — scoped to prevent cross-tenant and cross-plugin access. The Plugin Service Redis ACL (`~plugin:*`) covers these keys.

### 8.5 Drain Complete Callback

```
POST /internal/plugins/:manifestId/drain-complete
```

**Authorization:** Execution Service only (service token + RBAC matrix check).

Called by the Execution Service when a plugin drain initiated by the Plugin Service (step 3 of the upgrade procedure, §10.2) has completed — either all in-flight executions finished cleanly or the grace period expired and remaining executions were force-killed.

**Path parameter:** `manifestId` — the plugin's manifest ID (e.g. `com.example.shopify-connector`).

**Request body:**
```typescript
const DrainCompleteRequestSchema = z.object({
  manifestId:            z.string(),
  drainedAt:             z.string().datetime(),
  inflightAtDrainStart:  z.number().int(),
  inflightAtCompletion:  z.number().int(),  // 0 = clean drain; >0 = some were force-killed
  killedExecutions:      z.array(z.string().uuid()),
});
```

**Response:** `200 OK` with `{ received: true }`.

**Behavior:** The Plugin Service uses this callback to advance the upgrade state machine from "waiting for drain" to the atomic swap step (step 4). The callback unblocks the upgrade flow. If the callback is not received within 65 seconds of sending the drain signal, the Plugin Service proceeds with the swap anyway (fail-safe — the Execution Service's own drain grace period expires at 60 seconds, so a 5-second buffer is adequate).

### 8.5 Widget List

```
GET /internal/plugins/widgets
```

**Authorization:** App Service only.

**Query parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `tenantId` | UUID | Yes | Tenant whose widget plugins to return |

**Response 200:**
```typescript
interface WidgetListResponse {
  widgets: EnabledWidget[];
}

interface EnabledWidget {
  instanceId:    string;
  pluginId:      string;   // manifest_id
  displayName:   string;
  metadata:      WidgetMetadata;  // includes slots, minWidth, minHeight etc.
  version:       string;
  bundleBucket:  string;
  bundleKey:     string;
}
```

---

## 9. Connector Registration

### 9.1 Registration on Enable

When an instance of a `connector`-type plugin is enabled, the Plugin Service registers it with the Ingestion Service via:

```
POST /internal/ingestion/connectors
Content-Type: application/json
X-Service-Token: {hmac-signed token}

{
  "pluginId":    "com.example.shopify-connector",
  "instanceId":  "inst-uuid",
  "tenantId":    "tenant-uuid",
  "displayName": "My Shopify Store",
  "version":     "1.2.0",
  "metadata":    { ...ConnectorMetadata from manifest... }
}
```

The Ingestion Service responds 201 on success, or 409 if the `instanceId` is already registered (idempotent re-enable path). The Plugin Service treats 409 as success.

If the Ingestion Service returns a 5xx or the request times out (10s timeout), the Plugin Service aborts the enable transaction and returns `CONNECTOR_REGISTRATION_FAILED` to the caller. The instance remains in `disabled` state.

### 9.2 Deregistration on Disable

When an enabled connector instance is disabled:

```
DELETE /internal/ingestion/connectors/instance/{instanceId}
X-Service-Token: {hmac-signed token}
```

Deregistration is best-effort. If the Ingestion Service returns 5xx or is unreachable, the Plugin Service logs the failure and proceeds with the disable anyway (the instance is marked `disabled`). The Ingestion Service is expected to reconcile stale connector registrations via its own startup-time sync against `GET /internal/plugins/connectors`.

**Rationale for best-effort:** A connector that is disabled should not block the disable operation even if the Ingestion Service is temporarily unavailable. The Ingestion Service's startup reconciliation ensures eventual consistency.

### 9.3 Connector Deregistration on Uninstall

During uninstall, the Plugin Service issues a single `DELETE /internal/ingestion/connectors/plugin/{manifestId}` call which bulk-disables all connector instances for that plugin. This is more efficient than iterating instances individually. The call is made with a 10-second timeout. Partial failures are logged but do not block uninstall. The Ingestion Service reconciliation loop handles cleanup.

---

## 10. Version Upgrade and Rollback

### 10.1 Install New Version

When `POST /api/v1/plugins` receives a `.oppkg` with a `manifest_id` that already has an `active` row, the new version is stored with `status = 'staged'`. The existing `active` row is unchanged. No instances or hooks are modified.

The install response includes:
```typescript
{
  "status": "staged",
  "activeVersion": "1.1.0",
  "stagedVersion":  "1.2.0",
  "upgradeRequired": true
}
```

Multiple staged versions are not permitted. If a `staged` version already exists, the new install replaces it (the old staged bundle is deleted from MinIO).

### 10.2 Atomic Swap Procedure

The upgrade is initiated by `POST /api/v1/plugins/{manifestId}/upgrade`. The following steps execute in order:

**Step 1 — Pre-flight:**
- Confirm `staged` version exists.
- Re-validate all existing instance configs against the new version's `configSchema`. If any fail, return `CONFIG_MIGRATION_REQUIRED`.
- Pre-register new version's hooks in `plugin.hooks` with `state = 'staged'` (not yet in any active chain).

**Step 2 — Warm Execution Service cache:**
- Call Execution Service: `POST /internal/execution/plugin-cache-prefetch` with `{pluginId, version: stagedVersion}`. The Execution Service fetches and caches the new bundle from MinIO proactively. This eliminates cold-start latency at cutover.
- The Plugin Service waits up to 30s for the prefetch to complete. If it times out, the upgrade proceeds anyway (cache will warm on first request).

**Step 3 — Drain old version:**
- Mark old version `plugin.plugins.status = 'draining'`.
- Send drain signal to Execution Service: `POST /internal/execution/plugin-drain` with `{ pluginId: pluginManifestId, tenantId: null, gracePeriodMs: 60000 }` — `tenantId: null` signals a platform-wide drain for all tenants using this plugin.
- Wait up to 60 seconds for in-flight executions to complete. The Execution Service signals completion via `POST /internal/plugins/{manifestId}/drain-complete` (a reverse internal callback).

**Step 4 — Atomic pointer swap (single transaction):**
```sql
BEGIN;

-- Activate new version
UPDATE plugin.plugins
SET status = 'active', updated_at = now()
WHERE manifest_id = $1 AND version = $newVersion;

-- Deactivate old version
UPDATE plugin.plugins
SET status = 'disabled', updated_at = now()
WHERE manifest_id = $1 AND version = $oldVersion;

-- Activate new hooks
UPDATE plugin.hooks
SET state = 'active', updated_at = now()
WHERE plugin_id = $newPluginId AND state = 'staged';

-- Deactivate old hooks
UPDATE plugin.hooks
SET state = 'disabled', updated_at = now()
WHERE plugin_id = $oldPluginId AND state = 'active';

-- Update all instances to point to new version
UPDATE plugin.instances
SET plugin_id = $newPluginId, updated_at = now()
WHERE plugin_manifest_id = $1;

COMMIT;
```

This transaction is the only write that changes which version is active. The unique partial index on `(manifest_id) WHERE status = 'active'` enforces that only one version can be active. The transaction either fully commits or fully rolls back — there is no window where both versions are active or neither is active.

**Step 5 — Invalidate Execution Service cache for old version:**
- `POST /internal/execution/plugin-cache-invalidate` with `{ pluginId: pluginManifestId, tenantId: null, newBundleVersion: stagedVersion }` — `tenantId: null` invalidates across all tenants. The Execution Service evicts all cache entries for any tenant that had the old bundle version cached.

**Step 6 — Emit event:**
- Emit `plugin.upgraded` event (extends the plugin event catalog from ADR-30).

**Step 7 — Schedule old bundle cleanup:**
- Set `plugin.plugins.bundle_delete_after = now() + interval '24 hours'` on the old version row (the rollback window).

### 10.3 Rollback

`POST /api/v1/plugins/{manifestId}/rollback` is available within 24 hours of an upgrade.

The rollback executes the same atomic swap procedure in reverse:
1. Mark new version `draining`, send drain signal.
2. Wait up to 60 seconds for drain.
3. Execute the swap transaction: re-activate old version, re-activate old hooks, deactivate new hooks, revert instance pointers.
4. Emit `plugin.rolled_back` event.

After rollback, the new version row is left in `disabled` status with `bundle_delete_after = now() + interval '24 hours'`.

### 10.4 Scheduled Bundle Cleanup

A BullMQ job scheduled via the Plugin Service's startup worker runs every hour to delete MinIO bundles for `uninstalled` or `disabled` version rows where `bundle_delete_after <= now()`:

```sql
SELECT id, bundle_bucket, bundle_key, manifest_id, version
FROM plugin.plugins
WHERE bundle_delete_after <= now()
  AND status IN ('uninstalled', 'disabled');
```

For each row: delete the MinIO object, then set `bundle_key = NULL` and `bundle_delete_after = NULL` (marking cleanup complete). Rows with NULL `bundle_key` are excluded from future cleanup scans.

---

## 11. Uninstall Guards

`DELETE /api/v1/plugins/{id}` executes the following guards in order before proceeding. Any failed guard returns a non-2xx response and aborts the uninstall.

### 11.1 Active Instance Guard

```sql
SELECT COUNT(*) FROM plugin.instances
WHERE plugin_manifest_id = $1
  AND enabled IN ('enabled', 'disabling')
  AND deleted_at IS NULL;
```

If count > 0: return **422** with code `PLUGIN_HAS_ACTIVE_INSTANCES`.
Message: `"Cannot uninstall: {n} instance(s) are enabled. Disable all instances before uninstalling."`

The caller must explicitly disable all instances via `PATCH /api/v1/plugins/{id}/instances/{instanceId}` with `{ "enabled": false }`.

### 11.2 Active Jobs Guard

Query the BullMQ execution queue for active or waiting jobs referencing this plugin:

```typescript
const queue = new Queue('execution', { connection: redis });
const activeJobs = await queue.getJobs(['active', 'waiting', 'delayed']);
const pluginJobs = activeJobs.filter(job =>
  job.data.pluginManifestId === manifestId
);
```

If pluginJobs.length > 0: return **422** with code `PLUGIN_HAS_ACTIVE_JOBS`.
Message: `"Cannot uninstall: {n} active job(s) reference this plugin. Wait for jobs to complete or move them to DLQ."`

### 11.3 Data Orphan Warning

Query ontology data tables for records ingested by this plugin. This is an advisory check — it does not block uninstall, it produces a warning that requires explicit acknowledgment.

```sql
-- NOTE: This query is illustrative. The actual implementation queries
-- the Ontology Service via GET /internal/ontology/data-sources/{manifestId}/count
-- to avoid direct cross-schema data queries from the Plugin Service.
```

The Plugin Service calls `GET /internal/ontology/data-sources/{manifestId}/count` on the Ontology Service. If `count > 0`:
- Return **409** with code `ORPHAN_CONFIRMATION_REQUIRED`.
- Response body includes `OrphanWarning.entityTypes`, `OrphanWarning.totalRecords`, and `OrphanWarning.message`.
- The caller must resubmit with `?confirmOrphan=true`.
- Uninstall proceeds with the flag; the orphaned data is NOT deleted automatically.

If `?confirmOrphan=true` and data exists: the uninstall proceeds, and the service logs an audit event: `"Plugin uninstalled with {n} orphaned records. Admin {userId} confirmed."`

### 11.4 Proceed with Uninstall

After all guards pass:

1. Set all instance rows `deleted_at = now()`.
2. Set all hook rows `state = 'disabled'` for this plugin.
3. Deregister all connector instances with Ingestion Service (§9.3).
4. Set `plugin.plugins.status = 'uninstalled'`, `uninstalled_at = now()`, `bundle_delete_after = now() + interval '{retention} days'`.
5. Emit `plugin.uninstalled` event.
6. Return 200 with `UninstallResponse`.

The MinIO bundle is NOT deleted immediately. The cleanup worker (§10.4) handles deletion after the retention period.

---

## 12. MinIO Integration

### 12.1 Object Path Convention

All plugin bundles are stored in the `plugin-bundles` bucket under the path:

```
{manifest_id}/{version}/bundle.js
```

Examples:
```
com.example.shopify-connector/1.2.0/bundle.js
com.example.shopify-connector/1.1.0/bundle.js
com.internal.auth-provider/2.0.0-beta.1/bundle.js
```

The `manifest_id` and `version` are used directly as path segments. Both contain only lowercase alphanumerics, hyphens, dots, and forward slashes (from the reverse-domain format and SemVer), so no URL encoding is required.

### 12.2 Upload

Bundles are uploaded during installation using `@aws-sdk/client-s3` PutObject with:

```typescript
const putCommand = new PutObjectCommand({
  Bucket: 'plugin-bundles',
  Key:    `${manifestId}/${version}/bundle.js`,
  Body:   fs.createReadStream(bundlePath),
  ContentType: 'application/javascript',
  Metadata: {
    'x-plugin-manifest-id': manifestId,
    'x-plugin-version':     version,
    'x-plugin-checksum':    bundleChecksum,
    'x-installed-at':       new Date().toISOString(),
  },
  ChecksumSHA256: bundleChecksum,  // MinIO verifies on receipt
});
```

The `ChecksumSHA256` parameter instructs MinIO to verify the SHA-256 of the uploaded object on receipt. This provides end-to-end integrity: the Plugin Service verifies the checksum locally (§4.4) and MinIO verifies it again on write. A network corruption during upload is caught before the row is inserted into Postgres.

### 12.3 Download (Bundle Delivery)

The bundle delivery endpoint (§8.1) streams from MinIO to the caller:

```typescript
const getCommand = new GetObjectCommand({
  Bucket: bundleBucket,
  Key:    bundleKey,
});
const s3Response = await s3Client.send(getCommand);

// Stream directly to HTTP response — no in-memory buffer
if (s3Response.Body instanceof Readable) {
  s3Response.Body.pipe(res);
}
```

No bundle bytes are buffered in Plugin Service memory beyond the streaming window. This keeps the Plugin Service memory footprint small even for large bundles.

### 12.4 IAM Policy (MinIO)

The Plugin Service uses a dedicated MinIO service account scoped to its bucket:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:DeleteObject",
        "s3:HeadObject"
      ],
      "Resource": "arn:aws:s3:::plugin-bundles/*"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:HeadBucket", "s3:CreateBucket"],
      "Resource": "arn:aws:s3:::plugin-bundles"
    }
  ]
}
```

The Plugin Service cannot read from `app-builds`, `file-uploads`, or `config-exports` buckets. Principle of least privilege.

### 12.5 Lifecycle Policy

A MinIO object lifecycle policy is applied to the `plugin-bundles` bucket on startup (idempotently):

```xml
<LifecycleConfiguration>
  <Rule>
    <ID>delete-expired-bundles</ID>
    <Status>Enabled</Status>
    <Prefix/>
    <Expiration>
      <!-- Objects tagged for deletion are cleaned up after the retention period.
           The Plugin Service sets a custom tag x-delete-after on uninstall. -->
      <ExpiredObjectDeleteMarker>true</ExpiredObjectDeleteMarker>
    </Expiration>
  </Rule>
</LifecycleConfiguration>
```

The Plugin Service's cleanup worker (§10.4) is the primary deletion mechanism — the lifecycle policy is a backstop for objects whose cleanup worker entry was somehow lost. The worker is preferred over pure lifecycle policies because it allows the service to update Postgres (`bundle_key = NULL`) in the same operation as the S3 delete, keeping the two systems consistent.

---

## 13. Error Handling

### 13.1 Error Code Taxonomy

| Code | HTTP | Meaning | Retryable |
|---|---|---|---|
| `INVALID_MANIFEST` | 422 | Manifest Zod validation failed | No |
| `CHECKSUM_MISMATCH` | 422 | SHA-256 does not match manifest | No |
| `GPG_VERIFICATION_FAILED` | 422 | Signature invalid or key not trusted | No |
| `GPG_SIGNATURE_MISSING` | 422 | gpgFingerprint set but no .sig uploaded | No |
| `INVALID_PACKAGE_STRUCTURE` | 422 | Required files missing from tarball | No |
| `ENTRYPOINT_NOT_CALLABLE` | 422 | Execution Service could not call metadata() | No (fix the plugin) |
| `PLATFORM_VERSION_TOO_OLD` | 422 | Platform version below minPlatformVersion | No |
| `CIRCULAR_DEPENDENCY` | 422 | Hook dependency graph cycle detected | No |
| `UPLOAD_TOO_LARGE` | 413 | Bundle exceeds 50MB | No |
| `PLUGIN_NOT_FOUND` | 404 | Plugin ID / manifest_id not found | No |
| `INSTANCE_NOT_FOUND` | 404 | Instance ID not found | No |
| `PLUGIN_NOT_ACTIVE` | 422 | Plugin not in active status for instance ops | No |
| `CONFIG_VALIDATION_FAILED` | 422 | Config does not match configSchema | No |
| `CONFIG_MIGRATION_REQUIRED` | 422 | Upgrade blocked by incompatible config | No |
| `PLUGIN_HAS_ACTIVE_INSTANCES` | 422 | Uninstall blocked by enabled instances | No |
| `PLUGIN_HAS_ACTIVE_JOBS` | 422 | Uninstall blocked by active BullMQ jobs | Retry after jobs complete |
| `ORPHAN_CONFIRMATION_REQUIRED` | 409 | Data orphans exist; confirmOrphan required | No |
| `CONNECTOR_REGISTRATION_FAILED` | 502 | Ingestion Service call failed | Yes (retry enable) |
| `EXECUTION_VALIDATION_FAILED` | 502 | Execution Service call failed during install | Yes (retry install) |
| `STORAGE_UNAVAILABLE` | 503 | MinIO not reachable | Yes |
| `INTERNAL_ERROR` | 500 | Unexpected server error | Depends |

### 13.2 Invalid Manifest Response Shape

```json
{
  "error": {
    "code": "INVALID_MANIFEST",
    "message": "Plugin manifest validation failed: 3 error(s)",
    "requestId": "req-uuid",
    "details": {
      "fieldErrors": {
        "version": ["Invalid SemVer format"],
        "hooks[0].stage": ["Stage must be 'before:{name}' or 'after:{name}'"],
        "bundleChecksum": ["Must be 64-char hex SHA-256"]
      }
    }
  }
}
```

### 13.3 Checksum Mismatch Response Shape

```json
{
  "error": {
    "code": "CHECKSUM_MISMATCH",
    "message": "Bundle checksum verification failed",
    "requestId": "req-uuid",
    "details": {
      "expected": "a3f5...d2c1",
      "actual":   "b7e2...f091",
      "source":   "manifest.bundleChecksum vs bundle.js content"
    }
  }
}
```

### 13.4 Circular Dependency Detection

When `dependsOn` is introduced in manifest v2, the Plugin Service will detect cycles using Kahn's algorithm. The error response includes the cycle path:

```json
{
  "error": {
    "code": "CIRCULAR_DEPENDENCY",
    "message": "Hook dependency graph contains a cycle",
    "requestId": "req-uuid",
    "details": {
      "cycle": [
        "before:ingestion.receive",
        "before:ingestion.validate",
        "before:ingestion.receive"
      ]
    }
  }
}
```

### 13.5 Concurrent Operation Handling

Concurrent installs of the same `(manifest_id, version)` are handled by the unique constraint `plugins_manifest_version_unique`. The second concurrent request hits a Postgres unique constraint violation, which the service catches and converts to HTTP 200 (idempotent return of the existing record).

Concurrent enable operations for the same instance are prevented by optimistic locking: the PATCH endpoint uses `WHERE id = $1 AND enabled = $expectedCurrentState` in its UPDATE. If the row was modified between the read and the write, the update affects 0 rows and the service returns `409 CONFLICT`.

---

## 14. Observability

### 14.1 Structured Logging

All log events use the `@oneplatform/core` logger (pino-based). Each log line includes:
- `requestId` — propagated from `X-Request-ID` header
- `tenantId` — from JWT claim (where applicable)
- `service` — `"plugin-service"`
- `level`, `timestamp`, `message`

Key log events and their levels:

| Event | Level |
|---|---|
| Plugin install started | info |
| Manifest validation failed | warn |
| Checksum mismatch | warn |
| GPG verification failed | warn |
| Plugin installed successfully | info |
| Instance enabled | info |
| Instance disabled | info |
| Connector registration failed (Ingestion unreachable) | error |
| Version upgrade started | info |
| Atomic swap committed | info |
| Rollback completed | warn |
| Plugin uninstalled with orphan confirmation | warn |
| Bundle cleanup worker ran | debug |
| MinIO upload failed | error |

### 14.2 Metrics (Prometheus)

Exposed at `GET /metrics` (internal only, not through Gateway).

| Metric | Type | Description |
|---|---|---|
| `plugin_installs_total` | Counter | Labeled by `status` (success/failure) and `failure_reason` |
| `plugin_instances_active` | Gauge | Total enabled instances across all tenants |
| `plugin_hooks_active` | Gauge | Total active hooks across all tenants |
| `plugin_bundle_upload_duration_seconds` | Histogram | MinIO upload latency |
| `plugin_bundle_download_duration_seconds` | Histogram | MinIO download (bundle delivery) latency |
| `plugin_hook_resolution_duration_seconds` | Histogram | Time to resolve a hook chain query |
| `plugin_connector_registration_errors_total` | Counter | Ingestion Service call failures |
| `plugin_upgrade_total` | Counter | Labeled by `status` (success/rollback) |

### 14.3 Distributed Tracing

The Plugin Service uses `@oneplatform/core`'s OpenTelemetry wrapper. All inbound HTTP requests create a root span. Outbound calls to Execution Service, Ingestion Service, and MinIO create child spans. Trace context is propagated via `traceparent` and `tracestate` headers.

The span names for key operations:
- `plugin.install`
- `plugin.install.validate_manifest`
- `plugin.install.verify_checksum`
- `plugin.install.verify_gpg`
- `plugin.install.validate_entrypoint`
- `plugin.install.upload_bundle`
- `plugin.instance.enable`
- `plugin.instance.disable`
- `plugin.upgrade.swap`
- `plugin.hooks.resolve`
- `plugin.bundle.deliver`

### 14.4 Health Endpoints

```
GET /health/live    → 200 OK (liveness — always, even if DB is down)
GET /health/ready   → 200 OK | 503 (readiness — checks DB + MinIO connectivity)
```

Readiness check response:
```json
{
  "status": "ready",
  "checks": {
    "database": "ok",
    "minio":    "ok",
    "redis":    "ok"
  }
}
```

---

## 15. Security Design

### 15.1 Authorization Model

| Operation | Required Role | Required Scope |
|---|---|---|
| List plugins | Any authenticated | `plugins:read` |
| Install plugin | `platform-admin` | `plugins:manage` |
| Uninstall plugin | `platform-admin` | `plugins:manage` |
| Upgrade plugin version | `platform-admin` | `plugins:manage` |
| Enable plugin (create instance) | `tenant-admin` | `plugins:manage` |
| Disable / update instance | `tenant-admin` | `plugins:manage` |
| Internal endpoints | Service token only | N/A (no user scope) |

Tenant admins can only read or modify instances belonging to their own `tenantId` (extracted from JWT). Platform admins can operate across all tenants.

### 15.2 Manifest URL Pattern Validation

`requiredExternalUrls` patterns are validated at install time to prevent SSRF via approved URL patterns. The Plugin Service rejects any pattern that:

- Uses a non-HTTPS protocol (only `https://` is accepted in production).
- Contains a hostname that resolves to a private IP range (10.x, 172.16.x, 192.168.x, 127.x, ::1, 169.254.x).
- Matches any internal service hostname pattern (`*-service`, `localhost`, `minio`, `postgres`, `redis`, etc.).
- Uses a wildcard `**` in the hostname position (only path wildcards are allowed).

Example of a rejected pattern: `https://*/` (wildcard hostname — rejected).
Example of an accepted pattern: `https://api.shopify.com/**` (specific hostname, wildcard path).

These validations mirror the Gateway Service's SSRF prevention checks from ADR-30.

### 15.3 Bundle Execution Isolation

The Plugin Service never executes bundle code. Bundle bytes flow from MinIO to the Execution Service. The Plugin Service has no JavaScript runtime, no `eval`, and no `require` of plugin code. The service's attack surface is limited to:
- Multipart file upload (bounded at 50MB)
- Tarball extraction (zip-slip prevented)
- Manifest JSON parsing (Zod-validated, no `eval`)
- MinIO object operations (read/write only)

### 15.4 Credential Protection

Plugin instance `config` JSONB may contain credential values (e.g., API keys entered by tenant admins). These are:
- Stored in Postgres JSONB as-is (encryption at the field level is not applied; the database is inside the trusted network perimeter per the platform's threat model).
- Scrubbed from API responses (§6.3).
- Never logged by the Plugin Service.
- Only passed to the Execution Service as part of `TenantContext.config`, where they are injected into the sandbox context and never returned to the Plugin Service.

If field-level encryption is required in future, the `@oneplatform/core` credential encryption module (AES-256-GCM, per ADR Decision 11) should be applied to `config` JSONB values whose corresponding manifest field has `type: "secret" | "password" | "token" | "certificate"`.

### 15.5 GPG Trust Chain

GPG public keys are managed by platform admins via a dedicated admin API. The trust chain is:
1. Platform admin imports a GPG public key.
2. Key is stored in `plugin.trusted_gpg_keys` with the fingerprint as the primary key.
3. At install time, the `gpgFingerprint` in the manifest is matched against trusted keys.
4. If no match: install fails. No implicit trust of unknown keys.

This allows organizations to enforce that only internally-signed plugins can be installed by adding only their own signing key to the trusted list.

### 15.6 Redis Key Prefix ACL

Per ADR Decision 5, the Plugin Service's Redis user is scoped to `~plugin:* &events:*`:
- `plugin:*` — plugin state keys (drain state, cache invalidation pub/sub keys)
- `events:*` — event pub/sub channels (for emitting plugin lifecycle events)

The Plugin Service cannot access auth tokens, rate limit counters, pipeline queues, or any other service's keys.

---

## 16. Testing Strategy

### 16.1 Unit Tests

Unit tests cover pure functions without I/O. Test runner: Vitest.

| Unit | Tests |
|---|---|
| `validateManifest(manifest)` | Valid manifest passes; each required field missing fails; invalid SemVer fails; stage regex accepts valid stages and rejects invalid; bundleChecksum regex enforced |
| `verifyBundleChecksum(path, expected)` | Matching checksum passes; tampered bundle fails; sidecar mismatch fails |
| `scrubCredentialFields(config, credentials)` | Credential fields replaced with `[REDACTED]`; non-credential fields preserved |
| `buildHookChain(hooks)` | Sorted by priority ASC; secondary sort by id is deterministic; empty array handled |
| `detectCircularDependency(hooks)` | Linear chain passes; simple cycle detected; transitive cycle detected; empty hooks pass |
| `buildMinioKey(manifestId, version)` | Path constructed correctly; special characters in manifestId rejected |
| State machine transition guards | Each guard function tested independently with valid and invalid inputs |

### 16.2 Integration Tests

Integration tests run against a real Postgres and MinIO (Docker-based via `testcontainers`). Redis is mocked via `ioredis-mock`. Execution Service and Ingestion Service are mocked via `msw` (Mock Service Worker for Node.js).

**Installation flow tests:**
- Valid `.oppkg` installs successfully (201), bundle in MinIO, row in Postgres.
- Invalid manifest (missing field) returns 422 with correct fieldErrors.
- Checksum mismatch returns 422 with expected/actual in details.
- Same manifest_id + version installed twice returns 200 (idempotent).
- New version of existing plugin creates `staged` row.

**State machine integration tests:**
- `installed → (tenant enables) → instance created, hooks active`.
- `instance enabled → disable → drain signal sent to Execution mock → instance disabled`.
- Disable with active jobs: mock returns active jobs → 422 returned.
- Upgrade swap: staged version exists → upgrade called → single transaction committed → old version `disabled`, new version `active`, instance pointer updated, hook states swapped.
- Rollback within 24h: reverses swap atomically.
- Rollback after 24h: 422 returned.

**Uninstall guard tests:**
- Uninstall with enabled instance → 422 `PLUGIN_HAS_ACTIVE_INSTANCES`.
- Uninstall with active BullMQ jobs → 422 `PLUGIN_HAS_ACTIVE_JOBS` (Redis mock with active jobs).
- Uninstall with orphaned data → 409, resubmit with `confirmOrphan=true` → 200.
- Clean uninstall: guards pass → status set to `uninstalled`, bundle_delete_after set.

**Connector registration tests:**
- Enable connector instance → Ingestion mock receives registration call with correct payload.
- Disable connector instance → Ingestion mock receives deregistration call.
- Ingestion Service 5xx on enable → transaction rolled back, instance stays `disabled`.
- Ingestion Service 5xx on disable → disable proceeds anyway (best-effort), error logged.

**Hook resolution tests:**
- Active hooks for stage + tenant returned in priority order.
- `staged` hooks not returned until after swap.
- `disabled` hooks not returned.
- Empty result for stage with no plugins.

### 16.3 State Machine Contract Tests

A dedicated test suite (`plugin-state-machine.test.ts`) exhaustively tests all legal and illegal state transitions:

```typescript
describe('Plugin state machine', () => {
  it('rejects ENABLED → UNINSTALLED direct transition', async () => {
    // arrange: plugin with enabled instance
    // act: call DELETE /api/v1/plugins/{id}
    // assert: 422 PLUGIN_HAS_ACTIVE_INSTANCES
  });

  it('completes INSTALLED → UNINSTALLED when no instances exist', async () => { /* */ });

  it('executes atomic swap with no window where zero versions are active', async () => {
    // Uses a slow transaction simulation to verify the unique partial index
    // prevents both versions being active simultaneously.
  });

  it('rollback is idempotent on second call within window', async () => { /* */ });

  it('rollback returns 422 after 24h window', async () => { /* */ });
});
```

### 16.4 Performance Tests

Using `k6`:

- `GET /internal/plugins/hooks?stage=before:ingestion.receive&tenantId=X` — target P99 < 10ms at 200 RPS.
- `GET /internal/plugins/{id}/bundle` — target P99 < 50ms at 50 RPS on local Docker network (MinIO on same host).
- `POST /api/v1/plugins` with a 5MB `.oppkg` — target P99 < 5s end-to-end including MinIO upload and entrypoint validation.

### 16.5 Contract Tests (Pact)

Pact consumer-driven contract tests are written for the two internal endpoints consumed by other services:

- **Execution Service as consumer of Plugin Service** — `GET /internal/plugins/{id}/bundle` — verifies response headers and streaming body format.
- **Pipeline Service as consumer of Plugin Service** — `GET /internal/plugins/hooks` — verifies the `ResolvedHook` array shape and ordering.

Contract tests are run in CI before integration tests. A failed contract test blocks the merge.

---

## 17. Deployment

### 17.1 Docker Compose Service Definition

```yaml
plugin-service:
  build:
    context: .
    dockerfile: services/plugin-service/Dockerfile
  image: oneplatform/plugin-service:${VERSION:-latest}
  container_name: oneplatform-plugin-service
  restart: unless-stopped
  ports:
    - "127.0.0.1:3008:3008"    # Loopback only — not exposed to public
  networks:
    - oneplatform-internal
  environment:
    NODE_ENV:               production
    DATABASE_URL:           postgresql://plugin_svc:${PLUGIN_DB_PASS}@pgbouncer:5433/oneplatform
    REDIS_URL:              redis://:${REDIS_PASSWORD}@redis:6379
    OP_S3_ENDPOINT:         http://minio:9000
    OP_S3_ACCESS_KEY:       ${PLUGIN_MINIO_ACCESS_KEY}
    OP_S3_SECRET_KEY:       ${PLUGIN_MINIO_SECRET_KEY}
    OP_SERVICE_TOKEN_SECRET: ${OP_SERVICE_TOKEN_SECRET}
    EXECUTION_SERVICE_URL:  http://execution-service:3005
    INGESTION_SERVICE_URL:  http://ingestion-service:3002
    LOG_LEVEL:              info
  depends_on:
    pgbouncer:
      condition: service_healthy
    redis:
      condition: service_healthy
    minio:
      condition: service_healthy
  healthcheck:
    test: ["CMD", "curl", "-f", "http://localhost:3008/health/ready"]
    interval: 15s
    timeout: 5s
    retries: 3
    start_period: 20s
  volumes: []  # Stateless — all state in Postgres and MinIO
```

### 17.2 Database Migrations

Migrations are managed by Drizzle ORM and run automatically on container startup:

```typescript
// services/plugin-service/src/db/migrate.ts
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

await migrate(db, { migrationsFolder: './drizzle' });
```

Migrations are idempotent. The Drizzle journal tracks applied migrations. Running migrations on an already-migrated database is a no-op.

Migration files live at `services/plugin-service/drizzle/`. They are committed to the monorepo and versioned with the service. No runtime migration tool required — the service migrates itself on startup.

### 17.3 Connection Pooling

The Plugin Service is allocated 10 connections in PgBouncer's `default_pool_size` (per ADR Decision 5 connection pool sizing). The service maintains a pool of at most 10 simultaneous database connections via the Drizzle connection pool configuration:

```typescript
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});
```

### 17.4 Redis ACL

The Plugin Service Redis user is configured in `/etc/redis/acl.conf`:

```
user plugin-service on >PLUGIN_REDIS_PASSWORD
  ~plugin:* &events:*
  +@read +@write +@keyspace
  -select -flushdb -flushall -keys -debug
```

### 17.5 Source Layout

```
services/plugin-service/
├── src/
│   ├── index.ts                  — Hono app entry point, middleware registration
│   ├── routes/
│   │   ├── plugins.ts            — Public plugin CRUD routes
│   │   ├── instances.ts          — Instance lifecycle routes
│   │   ├── upgrade.ts            — Version upgrade / rollback routes
│   │   └── internal/
│   │       ├── bundle.ts         — GET /internal/plugins/{id}/bundle
│   │       ├── hooks.ts          — GET /internal/plugins/hooks
│   │       ├── connectors.ts     — GET /internal/plugins/connectors
│   │       └── widgets.ts        — GET /internal/plugins/widgets
│   ├── services/
│   │   ├── install.ts            — Installation orchestration
│   │   ├── lifecycle.ts          — Enable / disable / uninstall
│   │   ├── upgrade.ts            — Version swap and rollback
│   │   ├── hooks.ts              — Hook registry queries
│   │   ├── minio.ts              — MinIO upload / download / cleanup
│   │   ├── ingestion-client.ts   — HTTP client for Ingestion Service
│   │   └── execution-client.ts   — HTTP client for Execution Service
│   ├── validation/
│   │   ├── manifest.schema.ts    — PluginManifestSchema (Zod)
│   │   ├── checksum.ts           — SHA-256 verification
│   │   └── gpg.ts                — GPG signature verification
│   ├── db/
│   │   ├── schema.ts             — Drizzle table definitions
│   │   ├── queries.ts            — Typed query helpers
│   │   └── migrate.ts            — Migration runner
│   ├── workers/
│   │   └── bundle-cleanup.ts     — BullMQ worker for expired bundle deletion
│   └── errors.ts                 — PluginInstallError and error code constants
├── drizzle/                      — Migration SQL files
├── test/
│   ├── unit/
│   ├── integration/
│   └── state-machine/
├── Dockerfile
└── package.json
```

---

## Appendix A: Manifest Validation Quick Reference

Required fields (Zod will error if absent):
`manifestVersion`, `id`, `name`, `version`, `type`, `description`, `author`, `minPlatformVersion`, `entrypoint`, `configSchema`, `hooks`, `requiredExternalUrls`, `requiredApis`, `requiredCredentials`, `bundleChecksum`, `license`

Optional fields:
`supportUrl`, `homepageUrl`, `icon`, `gpgFingerprint`, `tags`, `changelog`

---

## Appendix B: Service RBAC Matrix (Plugin Service additions)

From ADR-33, these entries are in `@oneplatform/core/service-rbac.ts`:

| Caller | Target | Allowed Endpoints |
|---|---|---|
| Execution Service | Plugin Service | `GET /internal/plugins/{pluginId}/bundle` |
| Execution Service | Plugin Service | `GET/PUT/DELETE /internal/plugins/cache/{tenantId}/{pluginId}/{key}` |
| Execution Service | Plugin Service | `POST /internal/plugins/{manifestId}/drain-complete` |
| Execution Service | Ingestion Service | `GET /internal/ingestion/credentials/{credentialBundleId}/field/{key}` |
| App Service | Plugin Service | `GET /internal/plugins/widgets` |
| Pipeline Service | Plugin Service | `GET /internal/plugins/hooks` |
| Pipeline Service | Ingestion Service | `POST /internal/ingestion/sync` |
| Ingestion Service | Plugin Service | `GET /internal/plugins/connectors` |
| Plugin Service | Execution Service | `POST /internal/execution/run` (entrypoint validation) |
| Plugin Service | Execution Service | `POST /internal/execution/plugin-drain` |
| Plugin Service | Execution Service | `POST /internal/execution/plugin-cache-invalidate` |
| Plugin Service | Execution Service | `POST /internal/execution/plugin-cache-prefetch` |
| Plugin Service | Ingestion Service | `POST /internal/ingestion/connectors` |
| Plugin Service | Ingestion Service | `DELETE /internal/ingestion/connectors/instance/{instanceId}` |
| Plugin Service | Ingestion Service | `DELETE /internal/ingestion/connectors/plugin/{pluginId}` |

---

## Appendix C: Event Catalog (Plugin Service)

Events emitted to Redis pub/sub channel `events:{tenantId}:{eventType}` (picked up by Gateway Service for webhook/SSE fanout per ADR-30):

| Event type | Emitted on | Key data fields |
|---|---|---|
| `plugin.installed` | Successful install | `pluginId`, `pluginName`, `version`, `installedBy` |
| `plugin.enabled` | Instance enabled | `pluginId`, `pluginName`, `tenantId`, `instanceId`, `enabledBy` |
| `plugin.disabled` | Instance disabled | `pluginId`, `pluginName`, `tenantId`, `instanceId`, `disabledBy` |
| `plugin.uninstalled` | Uninstall complete | `pluginId`, `pluginName`, `uninstalledBy` |
| `plugin.upgraded` | Version swap committed | `pluginId`, `fromVersion`, `toVersion`, `upgradedBy` |
| `plugin.rolled_back` | Rollback complete | `pluginId`, `fromVersion`, `toVersion`, `rolledBackBy` |

Cache invalidation pub/sub (internal, not delivered to webhooks):

| Channel | Published on | Consumed by |
|---|---|---|
| `plugin:cache-invalidate:{manifestId}:{version}` | Disable, upgrade swap | Execution Service (in-memory LRU eviction) |
