# OnePlatform — L2 Service Design: App Service

**Date:** 2026-06-10
**Status:** APPROVED
**Reference hierarchy:**
- L0: `docs/decisions/001-architecture-decisions.md` (ADR 1–29)
- L0: `docs/decisions/002-expanded-architecture-decisions.md` (ADR 30–36)
- L1: `docs/superpowers/specs/2026-06-10-oneplatform-design.md`
- **L2: This document** — App Service detailed design
- L3: `services/app/src/` — implementation

**ADRs governing this service:** ADR-25 (App Platform Design), ADR-26 (App-SDK and BFF Design), ADR-27 (App Access Control and OAuth Client Lifecycle), ADR-9 (Real-Time Communication), ADR-15 (App Routing and TLS), ADR-19 (Service-to-Service Authentication), ADR-29 (API Contract Standard)

---

## Table of Contents

1. [Service Overview](#1-service-overview)
2. [Database Schema](#2-database-schema)
3. [API Endpoints](#3-api-endpoints)
4. [Virtual File System](#4-virtual-file-system)
5. [Build Pipeline](#5-build-pipeline)
6. [Deployment and Rollback](#6-deployment-and-rollback)
7. [App Serving](#7-app-serving)
8. [BFF Pattern](#8-bff-pattern)
9. [OAuth Client Lifecycle](#9-oauth-client-lifecycle)
10. [Guest Sessions](#10-guest-sessions)
11. [WebSocket and Real-Time](#11-websocket-and-real-time)
12. [App-SDK Integration](#12-app-sdk-integration)
13. [Monaco Editor Support](#13-monaco-editor-support)
14. [Error Handling](#14-error-handling)
15. [Observability](#15-observability)
16. [Testing Strategy](#16-testing-strategy)
17. [Deployment Approach](#17-deployment-approach)

---

## 1. Service Overview

### Responsibility

The App Service is the code-first app builder and runtime for OnePlatform. It owns:

- **Virtual File System (VFS):** stores app source files (TypeScript/TSX/JSON) as rows in Postgres. Every file write is versioned with optimistic locking.
- **Build Pipeline:** assembles VFS source files into an in-memory file map, submits the map to the Execution Service sandbox (esbuild), uploads compiled artifacts to MinIO, and records the build result.
- **App Serving:** serves compiled JavaScript bundles from MinIO for production and preview modes with appropriate CDN headers.
- **BFF (Backend-for-Frontend):** intercepts all `@oneplatform/app-sdk` calls from browser apps, enforces authentication and RBAC, translates session cookies into internal service tokens, and forwards requests to downstream services (Ontology, Logging, etc.) over the internal network.
- **OAuth Client Lifecycle:** registers and manages OAuth 2.0 public clients (PKCE) with the Auth Service at deploy time.
- **Deployment and Rollback:** manages the `current_build_id` pointer that determines which build is live. Rollback is an O(1) pointer swap.
- **Guest Session Issuance:** proxies guest session creation requests to the Auth Service for apps with `access_mode = "public"`.
- **WebSocket Fan-Out:** maintains one SSE connection to the Gateway per active app and fans real-time events out to browser WebSocket connections.

### Port

`3006`

### Network Placement

The App Service runs on the `oneplatform-internal` network only. It is never directly reachable from the public internet. The Gateway routes inbound traffic to it.

Specific network reachability:
- **Inbound from Gateway:** `GET /apps/{slug}/*`, `GET /bff/*`, `ws://.../apps/{slug}/ws`, `GET /api/v1/apps/*`
- **Outbound to Auth Service** (port 3001): session validation, guest session creation, OAuth client registration
- **Outbound to Ontology Service** (port 3003): schema lookup for RBAC, BFF data forwarding, type-declaration generation for Monaco
- **Outbound to Execution Service** (port 3005): app-build job submission
- **Outbound to Logging Service** (port 3007): build-log query on behalf of callers
- **Outbound to MinIO** (port 9000): bundle upload and retrieval
- **Outbound to Redis** (port 6379): guest session key storage (`~guest-session:*`), event fan-out subscribe (`&events:*`)

The App Service has NO access to the `oneplatform-sandbox` network.

### Startup Dependencies

From `docker-compose.yml` (per ADR-24):

```yaml
app-service:
  depends_on:
    postgres:
      condition: service_healthy
    auth-service:
      condition: service_healthy
    minio:
      condition: service_healthy
```

Redis is accessed via a lazy connection — if Redis is unavailable on startup the service boots and degrades gracefully (guest session issuance fails with `SERVICE_UNAVAILABLE`; event subscription is retried with exponential backoff).

The Ontology Service and Execution Service are NOT hard startup dependencies. The App Service boots successfully without them and applies circuit-breaker behavior when they become unavailable.

### Internal Startup Sequence

1. Load `OP_MASTER_KEY` via `@oneplatform/core`'s `loadMasterKey()` (reads `/data/init/master.key`, falls back to `/run/secrets/op_master_key`, then env var).
2. Run Postgres migrations for the `app` schema (`drizzle-orm` with `migrate()`).
3. Load and warm the ontology cache (fetch full tenant snapshots from Ontology Service).
4. Subscribe to `events:*` Redis channel for real-time fan-out.
5. Start the BullMQ worker for background build-retention cleanup.
6. Start HTTP server on port 3006.
7. Signal `/readyz` healthy.

---

## 2. Database Schema

All tables live in the `app` Postgres schema. The App Service uses PgBouncer in **transaction mode** (pool size 15 per ADR-5). The `drizzle-orm` ORM is used for type-safe queries and migrations.

### 2.1 `app.apps`

```sql
CREATE TABLE app.apps (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID        NOT NULL,
  name              TEXT        NOT NULL,
  slug              TEXT        NOT NULL,
  description       TEXT,
  access_mode       TEXT        NOT NULL DEFAULT 'platform-user'
                                CHECK (access_mode IN ('platform-user', 'public')),
  current_build_id  UUID        REFERENCES app.builds(id) ON DELETE SET NULL,
  allowed_modules   TEXT[]      NOT NULL DEFAULT ARRAY['react','react-dom',
                                  '@oneplatform/app-sdk','@oneplatform/core','recharts'],
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        UUID        NOT NULL,
  deleted_at        TIMESTAMPTZ                       -- soft delete
);

-- Slug unique per tenant (authenticated apps)
CREATE UNIQUE INDEX app_apps_tenant_slug_idx
  ON app.apps (tenant_id, slug)
  WHERE deleted_at IS NULL;

-- Slug globally unique among public apps (unauthenticated routing requires global uniqueness)
CREATE UNIQUE INDEX app_apps_public_slug_idx
  ON app.apps (slug)
  WHERE access_mode = 'public' AND deleted_at IS NULL;

-- Fast lookups by tenant
CREATE INDEX app_apps_tenant_id_idx ON app.apps (tenant_id) WHERE deleted_at IS NULL;
```

**Rationale for `current_build_id` forward reference:** the `app.builds` table is created before `app.apps` in migrations; the FK is deferred to allow the circular reference (`apps` references `builds`, `builds` references `apps`). Both `current_build_id` and `app_id` are nullable at the SQL layer during the build creation transaction window. Drizzle migrations handle the creation order.

### 2.2 `app.files`

```sql
CREATE TABLE app.files (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id          UUID        NOT NULL REFERENCES app.apps(id) ON DELETE CASCADE,
  path            TEXT        NOT NULL,   -- POSIX path, e.g. /src/App.tsx
  content         TEXT        NOT NULL DEFAULT '',
  content_hash    TEXT        NOT NULL,   -- hex SHA-256 of content
  file_version    INTEGER     NOT NULL DEFAULT 1,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by      UUID        NOT NULL
);

-- Primary lookup: app + path uniqueness
CREATE UNIQUE INDEX app_files_app_path_idx ON app.files (app_id, path);

-- Fast directory listing (prefix scan)
CREATE INDEX app_files_app_id_idx ON app.files (app_id);
```

**Path constraints (enforced at the API layer before DB write):**
- Must start with `/`
- No `..` segments
- Max length 512 characters
- Only printable ASCII characters (no null bytes)
- Must end in one of: `.ts`, `.tsx`, `.js`, `.jsx`, `.json`, `.css`, `.html`, `.md`, `.svg`

### 2.3 `app.builds`

```sql
CREATE TABLE app.builds (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id          UUID        NOT NULL REFERENCES app.apps(id) ON DELETE CASCADE,
  version_number  INTEGER     NOT NULL,   -- auto-increment per app, see trigger below
  status          TEXT        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','building','success','failed')),
  bundle_path     TEXT,                   -- MinIO key: op-app-artifacts/{tenantId}/{appId}/builds/{buildId}/
  error_message   TEXT,                   -- populated on failure
  error_detail    JSONB,                  -- esbuild error objects with file/line/col
  build_manifest  JSONB,                  -- { buildId, appId, entrypoint, bundleSizeBytes,
                                          --   buildDurationMs, externalDependencies[] }
  built_at        TIMESTAMPTZ,
  built_by        UUID        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Sequence per app for version_number
CREATE SEQUENCE app.build_version_seq;

-- Enforce version_number uniqueness per app
CREATE UNIQUE INDEX app_builds_app_version_idx ON app.builds (app_id, version_number);

-- Sorted build history query
CREATE INDEX app_builds_app_id_created_idx ON app.builds (app_id, created_at DESC);

-- Status-filtered queries (e.g., latest successful build for preview)
CREATE INDEX app_builds_app_status_idx ON app.builds (app_id, status, created_at DESC);
```

`version_number` is assigned by the App Service at build creation time using:
```sql
SELECT COALESCE(MAX(version_number), 0) + 1 FROM app.builds WHERE app_id = $1
```
This SELECT is done inside the INSERT transaction. Concurrent build triggers for the same app are serialized by an advisory lock on `app_id` acquired in the service layer (using `pg_advisory_xact_lock(hashtext(app_id::text))`).

### 2.4 `app.env_vars`

```sql
CREATE TABLE app.env_vars (
  id           UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id       UUID    NOT NULL REFERENCES app.apps(id) ON DELETE CASCADE,
  key          TEXT    NOT NULL,
  value        TEXT    NOT NULL,   -- AES-256-GCM encrypted via OP_MASTER_KEY + HKDF-SHA256 per-row salt
  is_secret    BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX app_env_vars_app_key_idx ON app.env_vars (app_id, key);
```

Encryption follows the same pattern as `ingestion.credentials` (ADR-11): HKDF-SHA256 derives a per-row key from `OP_MASTER_KEY` + a random 32-byte salt stored alongside the encrypted blob. The `value` column stores a base64-encoded concatenation of `{ salt (32 bytes) || iv (12 bytes) || ciphertext || auth_tag (16 bytes) }`.

Secret env vars (`is_secret = true`) are never returned in API responses. Their value is masked as `"***"` in list responses. Non-secret values are returned in plaintext.

### 2.5 `app.roles`

```sql
CREATE TABLE app.roles (
  id          UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id      UUID    NOT NULL REFERENCES app.apps(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  permissions JSONB   NOT NULL DEFAULT '[]',
  -- permissions format: [{ entity: string, actions: ("create"|"read"|"update"|"delete"|"admin")[] }]
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX app_roles_app_name_idx ON app.roles (app_id, name);
```

App-level roles supplement platform roles. At runtime the App Service resolves effective permissions as `platform_roles UNION app_roles` for the requesting user.

### 2.6 `app.tenant_shares`

```sql
CREATE TABLE app.tenant_shares (
  id                  UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id              UUID    NOT NULL REFERENCES app.apps(id) ON DELETE CASCADE,
  external_tenant_id  UUID    NOT NULL,
  mapped_roles        TEXT[]  NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by          UUID    NOT NULL
);

CREATE UNIQUE INDEX app_tenant_shares_app_tenant_idx
  ON app.tenant_shares (app_id, external_tenant_id);
```

Cross-tenant sharing is disabled by default. Tenant admins must explicitly add entries. Platform admin can disable the feature globally via `OP_ENABLE_CROSS_TENANT_SHARING=false`.

### 2.7 `app.oauth_registrations`

```sql
CREATE TABLE app.oauth_registrations (
  id                 UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id             UUID    NOT NULL UNIQUE REFERENCES app.apps(id) ON DELETE CASCADE,
  client_id          TEXT    NOT NULL UNIQUE,
  -- Format: app:{appId}:{tenantId}
  client_secret_hash TEXT,
  -- NULL for public clients; bcrypt hash if applicable
  access_mode        TEXT    NOT NULL CHECK (access_mode IN ('platform-user', 'public')),
  registered_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

The `client_id` is deterministic: `app:{appId}:{tenantId}`. Registration is idempotent — the Auth Service uses `INSERT ... ON CONFLICT (client_id) DO UPDATE`. The App Service stores the registration locally to avoid a round-trip to Auth on every session validation.

### 2.8 `app.user_storage`

```sql
CREATE TABLE app.user_storage (
  id         UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id     UUID    NOT NULL REFERENCES app.apps(id) ON DELETE CASCADE,
  user_id    UUID    NOT NULL,
  key        TEXT    NOT NULL,    -- max 128 characters
  value      JSONB   NOT NULL,    -- max 64KB enforced at API layer
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX app_user_storage_app_user_key_idx
  ON app.user_storage (app_id, user_id, key);

-- Fast reads for a user's storage within an app
CREATE INDEX app_user_storage_app_user_idx
  ON app.user_storage (app_id, user_id);
```

Storage is per-app per-user, not global. Guest users may write to `user_storage` within a session; their `user_id` is the guest session ID. On guest session expiry the guest's storage records are retained but become inaccessible until the same guest re-authenticates (not possible by design — guest sessions are ephemeral and not recoverable).

---

## 3. API Endpoints

All endpoints follow the API Contract Standard (ADR-29): envelope `{ data: T }`, cursor pagination, filter DSL, standard error shape. The App Service creates its Hono app via `@oneplatform/core`'s `createApp()` factory which attaches the full middleware stack.

### 3.1 App Management

#### `GET /api/v1/apps`

Lists apps belonging to the authenticated user's tenant.

**Auth:** session cookie or API key. Platform user role required.

**Query params:** standard filter/sort/cursor/limit. Filterable fields: `name`, `slug`, `access_mode`, `created_at`.

**Response `200`:**
```typescript
{
  data: AppSummary[];
  pagination: { nextCursor: string | null; total: number };
}

interface AppSummary {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  description: string | null;
  accessMode: "platform-user" | "public";
  currentBuildId: string | null;
  currentBuildVersion: number | null;
  createdAt: string;
  updatedAt: string;
}
```

**Errors:** `401 UNAUTHORIZED`, `403 PERMISSION_DENIED`

---

#### `POST /api/v1/apps`

Creates a new app and seeds the VFS with the default template.

**Auth:** session cookie or API key. Tenant admin or developer role required.

**Request body (Zod schema):**
```typescript
const CreateAppSchema = z.object({
  name:        z.string().min(1).max(128),
  slug:        z.string().min(1).max(64).regex(/^[a-z0-9-]+$/,
               "slug must be lowercase alphanumeric with hyphens"),
  description: z.string().max(512).optional(),
  accessMode:  z.enum(["platform-user", "public"]).default("platform-user"),
});
```

**Behavior:**
1. Validate slug uniqueness (per-tenant for `platform-user`, global for `public`).
2. Insert `app.apps` row.
3. Seed VFS with default template (see Section 4.3).
4. Register OAuth client with Auth Service (`POST /internal/oauth/clients`).
5. Return created app.

**Response `201`:** `{ data: AppDetail }` (see `GET /api/v1/apps/{id}` shape)

**Errors:** `400 VALIDATION_ERROR`, `401 UNAUTHORIZED`, `403 PERMISSION_DENIED`, `409 CONFLICT` (slug taken)

---

#### `GET /api/v1/apps/{id}`

**Auth:** session cookie or API key. User must belong to app's tenant OR app has a `tenant_shares` entry for the user's tenant.

**Response `200`:**
```typescript
interface AppDetail {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  description: string | null;
  accessMode: "platform-user" | "public";
  currentBuildId: string | null;
  currentBuild: BuildSummary | null;
  allowedModules: string[];
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}
```

**Errors:** `401`, `403`, `404 NOT_FOUND`

---

#### `PATCH /api/v1/apps/{id}`

Partial update of app metadata. Changing `accessMode` from `platform-user` to `public` requires tenant admin role and triggers OAuth client re-registration.

**Auth:** session cookie or API key. Tenant admin or developer role.

**Request body (Zod schema):**
```typescript
const PatchAppSchema = z.object({
  name:           z.string().min(1).max(128).optional(),
  slug:           z.string().min(1).max(64).regex(/^[a-z0-9-]+$/).optional(),
  description:    z.string().max(512).nullable().optional(),
  accessMode:     z.enum(["platform-user", "public"]).optional(),
  allowedModules: z.array(z.string()).max(20).optional(),
}).strict();
```

**Response `200`:** `{ data: AppDetail }`

**Errors:** `400`, `401`, `403`, `404`, `409` (slug conflict)

---

#### `DELETE /api/v1/apps/{id}`

Soft-deletes the app (sets `deleted_at`). Deregisters the OAuth client with Auth Service. Does NOT delete MinIO artifacts (retention job handles them). Does NOT delete VFS files (cascade on hard delete only).

**Auth:** Tenant admin only.

**Response `204`**

**Errors:** `401`, `403`, `404`

---

### 3.2 Virtual File System

#### `GET /api/v1/apps/{id}/files`

Lists all files in the app's VFS. Returns metadata only (no content).

**Auth:** Developer or viewer role within the app's tenant.

**Response `200`:**
```typescript
{
  data: FileMeta[];
}

interface FileMeta {
  id: string;
  appId: string;
  path: string;
  contentHash: string;
  fileVersion: number;
  updatedAt: string;
  updatedBy: string;
  sizeBytes: number;  // derived: content.length
}
```

---

#### `GET /api/v1/apps/{id}/files/{path}`

Reads a single file. `{path}` is a URL-encoded POSIX path, e.g., `/src%2FApp.tsx`.

**Auth:** Developer or viewer role.

**Response `200`:**
```typescript
{
  data: {
    path: string;
    content: string;
    contentHash: string;
    fileVersion: number;
    updatedAt: string;
  }
}
```

**Errors:** `404 APP_FILE_NOT_FOUND`

---

#### `PUT /api/v1/apps/{id}/files/{path}`

Create or update a file. Performs optimistic locking via `file_version`.

**Auth:** Developer role.

**Request body (Zod schema):**
```typescript
const WriteFileSchema = z.object({
  content:     z.string().max(1_048_576),  // 1MB max per file
  fileVersion: z.number().int().min(0),    // 0 = create new; N = update existing at version N
});
```

**Behavior:**
1. Validate path (allowed extensions, no traversal).
2. Compute `content_hash = sha256(content)` hex.
3. If `fileVersion = 0`: `INSERT INTO app.files ... ON CONFLICT (app_id, path) DO NOTHING`. If 0 rows inserted (conflict = file already exists), return `409 CONFLICT`.
4. If `fileVersion > 0`: `UPDATE app.files SET content=$1, content_hash=$2, file_version=file_version+1, updated_at=now() WHERE app_id=$3 AND path=$4 AND file_version=$5`. If 0 rows updated, return `409 APP_FILE_VERSION_CONFLICT`.
5. Return updated file metadata.

**Response `200`:** `{ data: FileMeta }`

**Errors:** `400 VALIDATION_ERROR`, `403`, `404 NOT_FOUND` (app not found), `409 APP_FILE_VERSION_CONFLICT`, `413 APP_FILE_TOO_LARGE`

---

#### `DELETE /api/v1/apps/{id}/files/{path}`

Deletes a file from the VFS. Validates the file is not the entrypoint (`/src/index.tsx`) — deleting the entrypoint returns `422 APP_CANNOT_DELETE_ENTRYPOINT`.

**Auth:** Developer role.

**Response `204`**

**Errors:** `403`, `404`, `422 APP_CANNOT_DELETE_ENTRYPOINT`

---

#### `POST /api/v1/apps/{id}/files/rename`

Renames a file (changes its `path`). Implemented as a DELETE + PUT at the service layer within a transaction to avoid two round-trips.

**Request body:**
```typescript
const RenameFileSchema = z.object({
  fromPath: z.string(),
  toPath:   z.string(),
  fileVersion: z.number().int().min(1),
});
```

**Response `200`:** `{ data: FileMeta }` (the new path's metadata)

---

### 3.3 Build Pipeline

#### `POST /api/v1/apps/{id}/builds`

Triggers a new build. Fails if a build with `status = 'building'` or `status = 'pending'` already exists for this app (one concurrent build per app).

**Auth:** Developer role.

**Request body (Zod schema):**
```typescript
const TriggerBuildSchema = z.object({
  // No required fields. All options are optional.
  preview: z.boolean().default(false),  // true = incremental, uses esbuild context
}).optional();
```

**Behavior:** see Section 5 (Build Pipeline) for full flow.

**Response `202 Accepted`:**
```typescript
{
  data: {
    buildId: string;
    versionNumber: number;
    status: "pending";
    logsStreamUrl: string;  // /api/v1/apps/{id}/builds/{buildId}/logs/stream
  }
}
```

**Errors:** `409 APP_BUILD_IN_PROGRESS`, `422 APP_NO_FILES` (VFS has no files)

---

#### `GET /api/v1/apps/{id}/builds`

Lists build history for an app (newest first).

**Auth:** Developer or viewer role.

**Query params:** `?limit=20&cursor=...&filter[status][eq]=success`

**Response `200`:**
```typescript
{
  data: BuildSummary[];
  pagination: { nextCursor: string | null; total: number };
}

interface BuildSummary {
  id: string;
  appId: string;
  versionNumber: number;
  status: "pending" | "building" | "success" | "failed";
  bundlePath: string | null;
  buildManifest: BuildManifest | null;
  errorMessage: string | null;
  builtAt: string | null;
  builtBy: string;
  createdAt: string;
}
```

---

#### `GET /api/v1/apps/{id}/builds/{buildId}`

Single build detail with full error information.

**Response `200`:** `{ data: BuildSummary & { errorDetail: EsbuildError[] | null } }`

---

#### `GET /api/v1/apps/{id}/builds/{buildId}/logs/stream`

SSE stream of build log lines. Connection kept open until build transitions to `success` or `failed`, then a final `event: done` is sent and the connection is closed.

**Auth:** Developer or viewer role.

**SSE events:**
```
event: log
data: {"level":"info","message":"Starting esbuild...","ts":"2026-06-10T14:30:00.000Z"}

event: log
data: {"level":"error","message":"src/App.tsx:12:5: error: Cannot find module 'unknown'","ts":"..."}

event: done
data: {"status":"failed","buildId":"..."}
```

**Implementation:** The App Service stores log lines in Redis as a list (`app:build-logs:{buildId}`, TTL 24 hours). The Execution Service streams log lines back during the build job; the App Service appends each to Redis and publishes to a temporary pub/sub channel `app:build:{buildId}:log`. The SSE handler subscribes to this channel and replays any buffered lines first (for late-connecting clients), then streams live events.

---

#### `DELETE /api/v1/apps/{id}/builds/{buildId}`

Deletes a specific build record and its MinIO artifacts. Disallowed for `current_build_id` (returns `422 APP_CANNOT_DELETE_ACTIVE_BUILD`).

**Auth:** Developer role.

**Response `204`**

---

### 3.4 Deployment and Rollback

#### `POST /api/v1/apps/{id}/deploy`

Deploys a build by updating `current_build_id`. If no `buildId` is specified, deploys the latest successful build.

**Auth:** Developer or tenant admin role.

**Request body:**
```typescript
const DeploySchema = z.object({
  buildId: z.string().uuid().optional(),
});
```

**Behavior:**
1. Verify the specified (or latest) build has `status = 'success'`.
2. Atomically update `app.apps SET current_build_id = $1 WHERE id = $2`.
3. Register (or update) OAuth client with Auth Service (`POST /internal/oauth/clients`, idempotent upsert).
4. Publish `app.deployed` platform event to Redis `events:{tenantId}:app.deployed`.
5. Return deploy result.

**Response `200`:**
```typescript
{
  data: {
    appId: string;
    buildId: string;
    versionNumber: number;
    deployedAt: string;
    previousBuildId: string | null;
  }
}
```

**Errors:** `400 APP_BUILD_NOT_READY` (build not in success state), `404`

---

#### `POST /api/v1/apps/{id}/rollback`

Rolls back to a previous build.

**Auth:** Developer or tenant admin role.

**Request body:**
```typescript
const RollbackSchema = z.object({
  buildId: z.string().uuid(),
});
```

**Behavior:**
1. Verify `buildId` exists for this app and has `status = 'success'`.
2. Atomic `UPDATE app.apps SET current_build_id = $1 WHERE id = $2`.
3. Publish `app.rolled_back` platform event.

**Response `200`:** `{ data: { appId, fromBuildId, toBuildId, rolledBackAt } }`

**Errors:** `400 APP_BUILD_NOT_FOUND`, `400 APP_BUILD_NOT_READY`

---

### 3.5 Roles and Sharing

#### `GET /api/v1/apps/{id}/roles`

**Response `200`:** `{ data: AppRole[] }`

#### `POST /api/v1/apps/{id}/roles`

**Auth:** Developer or tenant admin.

**Request body:**
```typescript
const CreateRoleSchema = z.object({
  name: z.string().min(1).max(64),
  permissions: z.array(z.object({
    entity:  z.string(),
    actions: z.array(z.enum(["create", "read", "update", "delete", "admin"])),
  })).max(50),
});
```

**Response `201`:** `{ data: AppRole }`

#### `PATCH /api/v1/apps/{id}/roles/{roleId}`

Updates role permissions.

#### `DELETE /api/v1/apps/{id}/roles/{roleId}`

Removes an app role. Fails if any tenant user has this role assigned.

#### `POST /api/v1/apps/{id}/share`

Adds a cross-tenant sharing entry.

**Auth:** Tenant admin only.

**Request body:**
```typescript
const ShareAppSchema = z.object({
  tenantId:    z.string().uuid(),
  mappedRoles: z.array(z.string()).min(1),
});
```

**Response `201`:** `{ data: TenantShare }`

**Errors:** `403 APP_CROSS_TENANT_SHARING_DISABLED` (global feature flag off)

---

### 3.6 Environment Variables

#### `GET /api/v1/apps/{id}/env-vars`

Lists env var keys. Secret values are masked as `"***"`.

**Response `200`:**
```typescript
{
  data: {
    id: string;
    key: string;
    value: string;  // plaintext for non-secret, "***" for secret
    isSecret: boolean;
    updatedAt: string;
  }[];
}
```

#### `PUT /api/v1/apps/{id}/env-vars/{key}`

Create or update an env var. The value is encrypted before storage.

**Request body:**
```typescript
const EnvVarSchema = z.object({
  value:    z.string().max(4096),
  isSecret: z.boolean().default(false),
});
```

#### `DELETE /api/v1/apps/{id}/env-vars/{key}`

---

### 3.7 OAuth Client Management

#### `PATCH /api/v1/apps/{id}/oauth`

Adds custom redirect URIs. URIs are validated for exact-match pattern — no wildcards.

**Request body:**
```typescript
const PatchOAuthSchema = z.object({
  additionalRedirectUris: z.array(z.string().url()).max(10),
});
```

#### `DELETE /api/v1/apps/{id}/oauth/dev-redirect-uris`

Called by the `op app dev` CLI on shutdown to remove temporary localhost redirect URIs.

---

### 3.8 App Generation

#### `POST /api/v1/apps/generate`

Generates a starter app from an ontology entity selection.

**Auth:** Developer role.

**Request body:**
```typescript
const GenerateAppSchema = z.object({
  appName:     z.string().min(1).max(128),
  slug:        z.string().min(1).max(64).regex(/^[a-z0-9-]+$/),
  entityTypes: z.array(z.string()).min(1).max(10),
});
```

**Behavior:**
1. Fetch entity schemas from Ontology Service for each `entityType`.
2. Render starter app template (TypeScript source files with entity-specific substitutions).
3. Create app via internal `createApp()` logic.
4. Seed VFS with generated files.
5. Trigger initial build.
6. Return app detail with build ID.

**Response `201`:** `{ data: { app: AppDetail, buildId: string } }`

---

### 3.9 BFF Routes

All `/bff/*` routes are called by `@oneplatform/app-sdk` from within browser-hosted apps. They operate on the `op_session` or `op_guest_session` httpOnly cookie. See Section 8 for full BFF mechanics.

#### `GET /bff/me`

Returns the authenticated user's context.

**Response `200`:**
```typescript
{
  data: {
    id: string;
    email: string | null;   // null for guests
    displayName: string;
    tenantId: string;
    roles: string[];
    isGuest: boolean;
  }
}
```

#### `GET /bff/permissions`

Returns a permissions snapshot for the current user. Cached 5 minutes client-side; re-fetched on refresh.

**Response `200`:**
```typescript
{
  data: {
    permissions: {
      [entityType: string]: {
        create: boolean;
        read: boolean;
        update: boolean;
        delete: boolean;
        admin: boolean;
        allowedFields: string[] | "*";
        rowFilter: Record<string, unknown> | null;
      };
    };
    roles: string[];
    cachedAt: string;
  }
}
```

#### `GET /bff/data/{entity}`

Proxies a read query to the Ontology Service. Supports the standard filter DSL as query params.

**BFF enforcement:** session validation, RBAC check (read), row-filter injection, response field filtering.

**Response `200`:** passes through Ontology Service response envelope.

#### `POST /bff/data/{entity}`

Proxies a create mutation to the Ontology Service. RBAC check: `create`.

#### `PATCH /bff/data/{entity}/{id}`

Proxies an update. RBAC check: `update`.

#### `DELETE /bff/data/{entity}/{id}`

Proxies a delete. RBAC check: `delete`.

#### `GET /bff/data/{entity}/subscribe`

SSE subscription to entity events. App Service maintains a Redis pub/sub subscription for the entity and fans events to connected browsers. RBAC check: `read`.

**SSE events:**
```
event: data.created
data: {"entityType":"customer","entityId":"...","record":{...}}

event: data.updated
data: {"entityType":"customer","entityId":"...","changedFields":["status"],"record":{...}}
```

#### `GET /bff/storage/{key}`

Reads from `app.user_storage` for the current `(app_id, user_id, key)`.

**Response `200`:** `{ data: { key: string, value: unknown } }`

**Errors:** `404 APP_STORAGE_KEY_NOT_FOUND`

#### `PUT /bff/storage/{key}`

Upserts a value in `app.user_storage`. Value is validated: must be JSON-serializable, max 64KB serialized.

**Request body:** `{ value: unknown }`

**Errors:** `413 APP_STORAGE_VALUE_TOO_LARGE`

---

### 3.10 App Serving Routes

These routes are NOT under `/api/v1/`. They bypass the standard API envelope.

#### `GET /apps/{slug}/*`

Serves the production build bundle from MinIO. Resolves `slug` to `app_id` (per tenant from session, or global if public), reads `current_build_id`, fetches the artifact from MinIO, and streams it to the browser.

**Request headers checked:** `If-None-Match` (ETag), `If-Modified-Since`.

**Response headers set:**
```
Content-Type: application/javascript  (for bundle.js)
Cache-Control: public, max-age=31536000, immutable  (for versioned assets)
Cache-Control: no-cache  (for the HTML shell: /apps/{slug}/ index)
ETag: "{buildId}"
X-Content-Type-Options: nosniff
Content-Security-Policy: default-src 'self'; script-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'
```

**HTML shell response** for `GET /apps/{slug}/` (index):
The App Service generates and returns an HTML shell that:
1. Includes a `<script>` injecting `window.__OP_APP_CONFIG__ = { appId: "...", tenantId: "..." }`.
2. Loads the bundle: `<script type="module" src="/apps/{slug}/bundle.js?v={buildId}">`.
3. Contains a root `<div id="app">`.

The HTML shell is generated dynamically (never cached) so that `window.__OP_APP_CONFIG__` always reflects the current deploy.

**Auth (platform-user mode):** session cookie required. If absent, redirect to `/login?redirect=/apps/{slug}`.
**Auth (public mode):** guest session issued if no session cookie present.

**Errors:** `404 APP_NOT_FOUND`, `503 APP_NO_ACTIVE_BUILD` (no successful build deployed)

---

#### `GET /apps/{slug}/preview`

Serves the latest successful build regardless of `current_build_id`. Used by the Monaco editor preview pane.

**Same response shape as production serving.** Requires developer session (not available to guest users).

**Additional response header:**
```
X-Build-Status: preview
X-Build-Version: {latest versionNumber}
```

---

#### SSE endpoint for preview hot-reload:

#### `GET /apps/{slug}/preview/reload-stream`

SSE connection that the preview iframe maintains. Sends a `reload` event when a new incremental build completes.

```
event: reload
data: {"buildId":"...","versionNumber":42}
```

Connection kept alive until the developer closes the editor tab.

---

### 3.11 WebSocket

#### `ws://.../apps/{slug}/ws`

WebSocket endpoint for real-time bidirectional communication from browser-hosted apps (routed via Gateway). See Section 11.

---

### 3.12 Internal Endpoints

Internal endpoints validate `X-Service-Token` (Ed25519 JWT from a peer service). They reject requests without a valid service token with `403`.

#### `GET /internal/app/apps/{appId}`

Returns app metadata for inter-service use. Called by Pipeline Service when executing app-triggered pipelines.

#### `GET /internal/app/runtime-config/{appId}`

Returns non-secret env vars and runtime config for the specified app. Called by the `app-sdk` initialization flow.

---

## 4. Virtual File System

### 4.1 Design Rationale

App source files are stored in Postgres (not MinIO) because:
- Files are small text (typical total app: 5–100 files, 1KB–50KB each).
- They benefit from transactional writes (optimistic locking, rollback on error).
- They are queried frequently by the Monaco editor and build pipeline.
- Postgres full-text search could support future in-file search features.

MinIO stores only build artifacts (compiled bundles, 50KB–5MB gzipped). Artifacts are immutable once uploaded.

### 4.2 File Operations

All file operations go through the App Service VFS API. No direct Postgres access from the frontend or CLI.

**Write path:**
1. API layer validates path syntax and extension.
2. `content_hash = sha256hex(content)`.
3. `file_version` check for optimistic locking.
4. Upsert into `app.files`.
5. Return updated metadata.

**Read path:**
1. `SELECT content FROM app.files WHERE app_id = $1 AND path = $2`.
2. Stream content directly (no MinIO involved).

**Debounced saves from Monaco:** the `@oneplatform/app-sdk` editor integration debounces file saves by 500ms. The Monaco `onChange` handler sets a timer; each keystroke resets the timer. On the 500ms fire, a `PUT /api/v1/apps/{id}/files/{path}` request is sent with the current `fileVersion`. If the response is `409 APP_FILE_VERSION_CONFLICT`, the editor shows a banner: "File modified elsewhere — click to merge".

### 4.3 Default Template

When a new app is created, the following files are seeded into the VFS:

```
/package.json           — { name, version, dependencies }
/tsconfig.json          — strict TS config targeting ES2020
/src/index.tsx          — AppProvider wrapper + root component mount
/src/App.tsx            — empty component with useUser() example
```

The template files are stored as string constants in the App Service codebase (not in MinIO or Postgres until an app is created). The content is rendered with the app name and slug substituted.

### 4.4 File Versioning

`file_version` is an integer that starts at 1 and increments on every successful write. It implements optimistic concurrency control:

- Client sends the `fileVersion` it last read.
- Server compares: `WHERE file_version = $sent_version`.
- If no rows match (another write happened), returns `409 APP_FILE_VERSION_CONFLICT`.
- Clients (Monaco editor, `op app dev` CLI) handle conflicts by prompting the user.

This prevents silent overwrites in multi-user or multi-device scenarios without the overhead of advisory locks per file.

### 4.5 Content Hashing

`content_hash` (hex SHA-256) enables:
1. **Incremental builds:** the build pipeline can skip re-sending unchanged files to the sandbox.
2. **Diff views:** the Monaco diff editor can compare `content_hash` before fetching full content.
3. **Sync optimization:** the `op app dev` CLI uses hash comparison to avoid uploading unchanged files.

Hash is computed in the App Service, not the client. Clients cannot inject false hashes.

---

## 5. Build Pipeline

### 5.1 Overview

```
Developer / CLI
     │
     │  POST /api/v1/apps/{id}/builds
     ▼
App Service
     │  1. Acquire advisory lock on app_id
     │  2. Verify no concurrent build in progress
     │  3. Insert app.builds row (status: pending)
     │  4. Assemble VFS file map in-memory
     │  5. Release advisory lock
     │
     │  POST /internal/execution/execute
     │  { executionType: "app-build", files: {...}, entrypoint: "/src/index.tsx" }
     ▼
Execution Service (op-sandbox-vm)
     │  esbuild.build() or esbuild.context().rebuild()
     │  Output: bundle.js + bundle.js.map + build-manifest.json
     │  Stream log lines back via response chunks
     ▼
App Service (response handler)
     │  1. Upload 3 artifacts to MinIO
     │  2. Update app.builds: status=success|failed, bundle_path, build_manifest
     │  3. Store final log line in Redis
     │  4. Send SSE done event to log stream subscribers
     │  5. If preview mode and success: send SSE reload event to preview iframe
     │  6. Publish app.build.completed|failed platform event
     │
     └──► current_build_id is NOT automatically updated.
          Deploy is a separate explicit action.
```

### 5.2 VFS Assembly

Before submitting to the Execution Service, the App Service assembles a file map:

```typescript
interface AppBuildRequest {
  executionType: "app-build";
  appId: string;
  buildId: string;
  files: Record<string, string>;  // { "/src/App.tsx": "import React...", ... }
  entrypoint: string;             // "/src/index.tsx"
  target: "es2020";
  format: "esm";
  allowedModules: string[];       // from app.apps.allowed_modules
  envVars: Record<string, string>; // non-secret env vars only, for esbuild define
}
```

The file map is assembled in a single query:
```sql
SELECT path, content FROM app.files WHERE app_id = $1 ORDER BY path
```

Total VFS size is bounded: max 200 files per app (enforced at `PUT /api/v1/apps/{id}/files/{path}`), max 1MB per file. Total build payload is bounded at approximately 200MB before compression. The Execution Service rejects payloads over 50MB.

### 5.3 Execution Service Contract

The App Service submits a job to the Execution Service via:

```
POST /internal/execution/execute
X-Service-Token: <App Service Ed25519 JWT>
Content-Type: application/json

{
  "executionType": "app-build",
  "payload": { ...AppBuildRequest... },
  "timeout": 30000,
  "streaming": true
}
```

The Execution Service returns a streaming JSON-lines response where each line is a log chunk, and the final line is the result:

```
{"type":"log","level":"info","message":"Resolving dependencies...","ts":"..."}
{"type":"log","level":"info","message":"Bundling src/App.tsx...","ts":"..."}
{"type":"result","status":"success","files":{"bundle.js":"...base64...","bundle.js.map":"...","build-manifest.json":"..."}}
```

Or on failure:
```
{"type":"log","level":"error","message":"ERROR: src/App.tsx:12:5 ...","ts":"..."}
{"type":"result","status":"failed","error":{"message":"Build failed with 1 error","errors":[{"file":"src/App.tsx","line":12,"col":5,"text":"Cannot find module 'unknown-lib'","suggestion":"Add 'unknown-lib' to allowed_modules or remove the import."}]}}
```

### 5.4 MinIO Artifact Upload

On successful build, three files are uploaded to MinIO:

**Bucket:** `op-app-artifacts`
**Key prefix:** `{tenantId}/{appId}/builds/{buildId}/`

Files:
- `bundle.js` — ESM bundle (gzip-compressed by esbuild with `minify: true, sourcemap: false`)
- `bundle.js.map` — source map (uncompressed)
- `build-manifest.json` — `{ buildId, appId, tenantId, entrypoint, bundleSizeBytes, mapSizeBytes, buildDurationMs, externalDependencies[], builtAt }`

Upload is done in parallel using `Promise.all()`. If any upload fails, the build is marked `failed` with `error_message = "Artifact upload failed"`. The Execution Service result (raw files) is discarded — no partial artifacts in MinIO.

MinIO bucket `op-app-artifacts` has server-side encryption enabled (`SSE-S3`, AES-256 at rest). The App Service's IAM policy allows only `s3:PutObject`, `s3:GetObject`, and `s3:DeleteObject` on this bucket (per ADR-36).

### 5.5 Incremental Builds

For preview mode builds, the Execution Service maintains an esbuild context per `appId` in the sandbox:

- **First build:** `esbuild.context({ ...options }).build()` — full build, ~3s.
- **Subsequent builds:** `context.rebuild()` — incremental, ~200ms.
- **Context lifetime:** tied to the sandbox lifecycle. On sandbox recycle (every 1000 executions or 1 hour), the context is discarded and the next build is a full build.
- **Context key:** the Execution Service maps `appId → esbuildContext` in an LRU cache (max 100 active app contexts per sandbox instance).

The App Service signals preview mode with `preview: true` in the build request. The Execution Service handles the context management; the App Service has no visibility into whether a build was incremental.

### 5.6 Build Concurrency

One build per app at a time. Enforced by:
1. `SELECT COUNT(*) FROM app.builds WHERE app_id = $1 AND status IN ('pending', 'building')` before inserting.
2. If count > 0: return `409 APP_BUILD_IN_PROGRESS` with `{ data: { activeBuildId: "..." } }`.

Concurrent builds from the CLI and Monaco editor for the same app are thus serialized by the service layer. No distributed locking is needed because the check is within a transaction.

### 5.7 Build Retention

A BullMQ worker in the App Service runs a cleanup job every 24 hours:

```
For each app:
  SELECT id, bundle_path FROM app.builds
  WHERE app_id = $1 AND status = 'success'
  ORDER BY version_number DESC
  OFFSET 20  -- keep last 20 successful builds

For each build beyond the 20-build limit:
  DELETE MinIO objects at bundle_path/*
  DELETE FROM app.builds WHERE id = $1
  (never delete current_build_id)
```

Failed builds are purged after 7 days regardless of count.

---

## 6. Deployment and Rollback

### 6.1 Deploy Mechanics

Deployment is an atomic Postgres UPDATE:

```sql
UPDATE app.apps
SET current_build_id = $1, updated_at = now()
WHERE id = $2 AND tenant_id = $3
```

This is O(1). No data movement. No bundle copying. The next request to `GET /apps/{slug}/*` reads the new `current_build_id` and fetches the corresponding bundle from MinIO.

**Zero-downtime guarantee:** Because each request resolves the `current_build_id` at read time, there is no "swap" that affects in-flight requests. Requests served before the UPDATE complete with the old bundle; requests served after use the new bundle. No request sees an inconsistent state.

### 6.2 Rollback Mechanics

Rollback is identical to deploy — it is a `current_build_id` pointer change:

```sql
UPDATE app.apps
SET current_build_id = $1  -- the prior build ID
WHERE id = $2
```

Pre-conditions:
1. The target `buildId` must exist for this app.
2. The target build must have `status = 'success'`.
3. The target build's MinIO artifacts must still exist (verified before committing).

If the MinIO artifacts have been purged (outside the 20-build retention window), rollback fails with `400 APP_BUILD_ARTIFACTS_EXPIRED`.

### 6.3 Build Retention Impact on Rollback

The 20-build retention policy means only the last 20 successful builds are available for rollback. Attempting to rollback beyond that window returns `400 APP_BUILD_ARTIFACTS_EXPIRED`. Operators who need longer rollback windows can configure `APP_BUILD_RETENTION_COUNT` (env var, default 20, max 100).

### 6.4 Deploy Events

On every deploy and rollback, the App Service:
1. Publishes `app.deployed` or `app.rolled_back` platform event (ADR-30 event catalog).
2. Logs an audit event via the Logging Service.
3. Updates `app.oauth_registrations.updated_at`.

---

## 7. App Serving

### 7.1 Serving Architecture

The App Service serves bundles directly — it acts as a static file server proxying MinIO objects. It does NOT expose MinIO publicly. All requests to `/apps/{slug}/*` go through the App Service, which:

1. Resolves `slug` → `app_id` → `current_build_id`.
2. Constructs the MinIO key: `{tenantId}/{appId}/builds/{buildId}/{filename}`.
3. Fetches the object from MinIO using a presigned URL (generated internally, never exposed to the browser).
4. Streams the response to the browser.

**Why not direct MinIO presigned URLs to browsers?** Security: MinIO is not on the public network. Content-Security-Policy headers must be set by the App Service. URL structure would expose internal IDs.

### 7.2 HTML Shell Generation

For `GET /apps/{slug}/` (the app root), the App Service generates the HTML shell dynamically:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{app.name}</title>
</head>
<body>
  <div id="app"></div>
  <script>
    window.__OP_APP_CONFIG__ = {
      "appId": "{appId}",
      "tenantId": "{tenantId}",
      "bffOrigin": ""
    };
  </script>
  <script type="module" src="/apps/{slug}/bundle.js?v={buildId}"></script>
</body>
</html>
```

The `window.__OP_APP_CONFIG__` injection means the same compiled bundle (`bundle.js`) works in both preview mode and production without a rebuild — the runtime config is injected at serve time.

The HTML shell is served with `Cache-Control: no-cache` (so the injected config is always fresh). The `bundle.js` itself is served with `Cache-Control: public, max-age=31536000, immutable` (keyed by `?v={buildId}` so each build version is a different URL).

### 7.3 Access Control at Serving

**Platform-user mode apps:**
- Extract `op_session` cookie.
- Call `GET /internal/auth/validate` (cached 15s per token).
- If no valid session: `302 → /login?redirect=/apps/{slug}`.
- If valid session but wrong tenant (not in `tenant_shares`): `403 FORBIDDEN`.

**Public mode apps:**
- No `op_session` → call `POST /internal/auth/guest-sessions` → set `op_guest_session` cookie.
- Valid `op_guest_session` → continue.
- Guest sessions rate-limited at 100 req/min per IP (enforced by Gateway in front).

### 7.4 CDN Considerations

The App Service response headers are designed for CDN compatibility:

- `bundle.js`: `Cache-Control: public, max-age=31536000, immutable` — cache forever (URL changes on each build).
- `bundle.js.map`: `Cache-Control: public, max-age=31536000, immutable` — same.
- HTML shell: `Cache-Control: no-cache, must-revalidate` — always fresh.
- `ETag: "{buildId}"` on all bundle responses — enables conditional GET (`304 Not Modified`).

If an operator places a CDN (CloudFront, Cloudflare) in front of the platform, bundle responses can be edge-cached. The HTML shell should NOT be edge-cached (it contains the runtime config injection).

---

## 8. BFF Pattern

### 8.1 Mechanics

```
Browser app (running at /apps/{slug}/)
    │
    │  fetch("/bff/data/customers?filter[status][eq]=active", { credentials: "include" })
    │  Cookie: op_session=<httpOnly, SameSite=Strict>
    ▼
App Service BFF layer (Hono middleware on /bff/* routes)
    │
    │  Step 1: Session validation
    │    Extract op_session cookie value
    │    Check in-process cache (LRU, 15s TTL keyed by session token)
    │    If cache miss: GET /internal/auth/validate (Auth Service)
    │    Result: { userId, tenantId, roles, isGuest }
    │
    │  Step 2: App context resolution
    │    Determine which app this BFF instance serves
    │    (from the request origin / app slug embedded in the route)
    │    Verify session.tenantId === app.tenantId OR tenant_shares match
    │
    │  Step 3: RBAC enforcement
    │    Load ontology permission rules from local cache
    │    Determine effective roles (platform_roles UNION app_roles)
    │    Check: can roles perform {action} on {entity}?
    │    Fail-closed: if permission check fails → 403 PERMISSION_DENIED
    │    Inject row-level filter: if rowFilter defined for role
    │      → append filter[ownerId][eq]={userId} to query params
    │
    │  Step 4: Build internal request
    │    Method + path preserved (e.g., GET /internal/data/customers?filter[status][eq]=active&filter[ownerId][eq]={userId})
    │    Add headers:
    │      X-Service-Token: <App Service Ed25519 JWT>
    │      X-User-Context: <base64url(JSON { userId, tenantId, roles, isGuest })>
    │      X-Request-ID: <propagate from incoming request>
    │
    │  Step 5: Forward to Ontology Service
    │    Direct HTTP call on oneplatform-internal network (NOT via public Gateway)
    │    Timeout: 10s for reads, 30s for mutations
    │
    │  Step 6: Response transformation
    │    Strip internal headers (X-Service-Token etc.) from upstream response
    │    Apply field-level permission filtering:
    │      For each record in response.data[]:
    │        Remove fields not in role's allowedFields
    │    Return { data: filteredRecords, pagination: ... } to browser
    ▼
Browser app receives clean response. Never sees service tokens.
```

### 8.2 Session Cache

The BFF layer maintains a per-process in-memory LRU cache for session validation results:

```typescript
interface SessionCacheEntry {
  userId: string;
  tenantId: string;
  roles: string[];
  isGuest: boolean;
  expiresAt: number;  // ms since epoch
}

// LRU cache: max 1000 entries, TTL 15 seconds
const sessionCache = new LRUCache<string, SessionCacheEntry>({
  max: 1000,
  ttl: 15_000,
});
```

Cache key: the raw session cookie value (opaque string, never logged). On cache miss, a synchronous call to `GET /internal/auth/validate` is made before the BFF can proceed. If the Auth Service is unavailable, the BFF returns `503 SERVICE_UNAVAILABLE` (fail-closed).

The 15-second TTL means a revoked session is accepted for up to 15 seconds. This is the documented security trade-off (matching the 15-minute access token lifetime in the auth system — the BFF TTL is much shorter).

### 8.3 RBAC Enforcement

RBAC is evaluated using the ontology permission cache (populated via the same cache-warming mechanism as other services per ADR-12). The permission evaluation is:

```typescript
function checkPermission(
  userRoles: string[],
  entity: string,
  action: "create" | "read" | "update" | "delete" | "admin",
  ontologyCache: OntologyCache
): { allowed: boolean; allowedFields: string[] | "*"; rowFilter: Record<string,unknown> | null }
```

Field-level filtering on the response path:

```typescript
// After receiving Ontology Service response:
const filtered = response.data.map(record => {
  if (allowedFields === "*") return record;
  return Object.fromEntries(
    Object.entries(record).filter(([field]) => allowedFields.includes(field))
  );
});
```

Row-level filtering via query parameter injection:

```typescript
// Before forwarding to Ontology Service:
if (rowFilter) {
  for (const [field, value] of Object.entries(rowFilter)) {
    const resolvedValue = value === "$userId" ? userId : value;
    url.searchParams.append(`filter[${field}][eq]`, String(resolvedValue));
  }
}
```

### 8.4 Security Invariants

These invariants are enforced by the BFF middleware and are not bypassable by app code:

1. **Browser never receives service tokens.** The `X-Service-Token` header is set by the App Service and never echoed to the browser response.
2. **Internal services only accept `X-User-Context` with a valid `X-Service-Token`.** Enforced by `@oneplatform/core`'s `serviceAuth` middleware on every internal endpoint.
3. **RBAC is fail-closed.** If the ontology cache is empty, unavailable, or returns an unexpected error, the BFF returns `403 PERMISSION_DENIED` rather than allowing the request.
4. **Tenant isolation.** The BFF verifies `session.tenantId === app.tenantId` (or `tenant_shares` match) before ANY forwarding. This check cannot be influenced by request parameters.
5. **httpOnly cookies.** The `op_session` cookie is set with `HttpOnly; Secure; SameSite=Strict; Path=/`. It is inaccessible to JavaScript running in the browser app.

---

## 9. OAuth Client Lifecycle

### 9.1 Auto-Registration Flow

```
POST /api/v1/apps/{id}/deploy
     │
     ▼
App Service → POST /internal/oauth/clients (Auth Service)
{
  "clientId":     "app:{appId}:{tenantId}",
  "clientType":   "public",
  "redirectUris": [
    "{OP_BASE_URL}/apps/{slug}/auth/callback",
    "https://{slug}.apps.{domain}/auth/callback"  // only if OP_WILDCARD_DOMAIN set
  ],
  "allowedScopes": ["openid", "profile", "data:read", "data:write"],
  "tenantId":     "{tenantId}",
  "appId":        "{appId}",
  "accessMode":   "platform-user" | "public"
}
     │
     ▼
Auth Service: INSERT INTO auth.oauth_clients ... ON CONFLICT (client_id) DO UPDATE
     │
     ▼
App Service: UPDATE app.oauth_registrations SET updated_at = now()
```

The registration call is idempotent. Re-deploying updates the redirect URIs without invalidating existing sessions. The client ID is deterministic: `app:{appId}:{tenantId}`.

The Auth Service enforces that only the App Service (identified by its `X-Service-Token`) may register clients with the `app:` prefix. Any attempt by another service or user to register an `app:` prefixed client is rejected with `403 FORBIDDEN` (service RBAC matrix, ADR-19).

### 9.2 PKCE Enforcement

All app OAuth clients are `clientType: "public"`. The Auth Service enforces:
- No `client_secret` accepted for public clients.
- `code_challenge` and `code_challenge_method=S256` required at authorization.
- `code_verifier` required at token exchange.

App developers do not manage PKCE directly — the `@oneplatform/app-sdk`'s `AppProvider` handles the PKCE flow transparently. The session cookie approach in the BFF means PKCE is only used for the initial session establishment, not for every SDK call.

### 9.3 Redirect URI Management

**Registered at deploy:** path-based and (if `OP_WILDCARD_DOMAIN` set) subdomain URIs. No wildcards.

**Dev URIs (added by `op app dev`):**
```
op app dev --app {slug} --port 4000
  → PATCH /api/v1/apps/{id}/oauth { additionalRedirectUris: ["http://localhost:4000/auth/callback"] }
  → stored with created_at timestamp in Auth Service

On shutdown (SIGTERM/SIGINT):
  → DELETE /api/v1/apps/{id}/oauth/dev-redirect-uris
  → removes all dev redirect URIs for this app

Hourly cleanup job in Auth Service:
  → DELETE FROM auth.oauth_redirect_uris WHERE is_dev = true AND created_at < now() - INTERVAL '24 hours'
```

**No wildcard redirect URIs.** Each URI must be an exact match. The Auth Service rejects redirect URIs that contain `*`, `?`, or `#` characters.

### 9.4 App Deletion

When an app is soft-deleted:
1. The App Service calls `DELETE /internal/oauth/clients/app:{appId}:{tenantId}` on the Auth Service.
2. The Auth Service invalidates all active sessions for that client.
3. The `app.oauth_registrations` row is retained (for audit) but marked `deleted_at`.

---

## 10. Guest Sessions

### 10.1 Guest Session Issuance

When a request arrives at `GET /apps/{slug}/*` with no session cookie and the app has `access_mode = 'public'`:

```typescript
// App Service BFF / serving middleware
async function issueGuestSession(appId: string, tenantId: string, ip: string): Promise<string> {
  // Rate-limit: check Redis key guest-session:rate:{ip}
  const count = await redis.incr(`guest-session:rate:${ip}`);
  await redis.expire(`guest-session:rate:${ip}`, 60);  // 1-minute window
  if (count > 20) throw new AppError("GUEST_SESSION_RATE_LIMITED", 429);

  const response = await authService.post("/internal/auth/guest-sessions", {
    appId,
    tenantId,
    clientIp: ip,
  });
  return response.data.sessionToken;
}
```

The resulting `sessionToken` is set as an `op_guest_session` httpOnly cookie (same security attributes as `op_session`). It is separate from the primary session cookie to allow unauthenticated users to use public apps without affecting any existing authenticated session.

### 10.2 Rate Limiting

Guest session issuance is rate-limited at two layers:
1. **App Service Redis check:** 20 guest sessions per IP per minute (checked before calling Auth Service).
2. **Gateway rate limit tier:** all requests with `op_guest_session` cookie are limited to 100 req/min per IP (ADR-27).

If the per-app guest session creation rate exceeds 1000 sessions/hour, the App Service logs a WARN-level event and the platform admin is alerted. Platform admin can disable guest access for a specific app without affecting other apps.

### 10.3 Guest Session Data

- Guest sessions have `isGuest: true` in `useUser()`.
- `email` returns `null` for guests.
- Guests get the `guest` role, which has access only to entities explicitly marked `public: true` in the ontology.
- Guest sessions are stored in Redis (`guest-session:{token}`) with a 24-hour TTL.
- Guest users CAN write to `app.user_storage` — this allows public apps to persist per-visitor state (e.g., shopping cart, form progress). Storage is keyed by the guest session token as the `user_id`.

---

## 11. WebSocket and Real-Time

### 11.1 Architecture

```
Browser app
    │  ws://{platform}/apps/{slug}/ws
    │  (routed by Gateway → App Service)
    ▼
App Service WebSocket handler (per app)
    │  Maintains a map: { appSlug → Set<WebSocket> }
    │  Validates session cookie on upgrade handshake
    │
    │  Subscribes to Redis pub/sub: events:{tenantId}:data.*
    │  (one subscription per active app, shared across all connected browsers)
    │
    │  On event received:
    │    Fan out to all ws in Set<WebSocket> for this app
    ▼
Browser app receives message:
{
  "eventType": "data.updated",
  "entityType": "customer",
  "entityId": "...",
  "data": { "status": "active", ... }
}
```

The App Service maintains ONE Redis subscription per active app (not one per connected browser). Fan-out happens in the App Service process. This prevents Redis being overwhelmed by per-browser subscriptions.

### 11.2 Connection Lifecycle

**Upgrade handshake:**
1. Extract `op_session` cookie from the WebSocket upgrade request headers.
2. Validate session (same LRU cache as BFF).
3. Verify tenant access (same tenant isolation check as BFF).
4. Accept or reject upgrade (HTTP 101 or 401).

**Message flow:** one-directional from App Service to browser. The App Service only sends events; it does not process inbound WebSocket messages from the browser (inbound messages are silently discarded — the BFF HTTP endpoints handle mutations).

**Disconnection:** when a WebSocket is closed, its entry is removed from the `Set<WebSocket>`. If the set becomes empty for an app, the Redis subscription for that app is unsubscribed.

**Reconnection:** the `@oneplatform/app-sdk`'s `useSubscription` hook implements automatic reconnection with exponential backoff: 1s, 2s, 4s, 8s, 16s, 32s (max). After 10 consecutive failures, reconnection stops and `isConnected` stays `false`.

### 11.3 SSE Fan-Out for Gateway → App Service

For real-time data events from other services (e.g., a pipeline updating a record), the flow is:

1. Ontology Service emits `data.updated` to Redis pub/sub `events:{tenantId}:data.updated`.
2. App Service is subscribed to `events:*` on Redis.
3. App Service checks if any WebSocket clients are connected for apps in that tenant.
4. If yes, fan out the event to all connected `ws`.

### 11.4 Preview Hot-Reload SSE

The preview pane in the Monaco editor maintains an SSE connection to `GET /apps/{slug}/preview/reload-stream`. This is separate from the WebSocket and is used only for build completion notifications:

```
App Service build pipeline (on successful incremental build):
    → redis.publish(`app:preview-reload:{appId}`, JSON.stringify({ buildId, versionNumber }))

App Service SSE handler for /apps/{slug}/preview/reload-stream:
    → subscribed to app:preview-reload:{appId}
    → on message: send SSE event: reload to all connected preview panes
    → preview iframe: EventSource.onmessage → window.location.reload()
```

---

## 12. App-SDK Integration

### 12.1 `window.__OP_APP_CONFIG__` Injection

The App Service injects the runtime config into the HTML shell at serve time:

```javascript
window.__OP_APP_CONFIG__ = {
  "appId": "550e8400-e29b-41d4-a716-446655440000",
  "tenantId": "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
  "bffOrigin": ""  // empty = same origin; set to absolute URL for custom domain deployments
};
```

This injection:
- Is done in a `<script>` tag rendered by the App Service, NOT embedded in the bundle.
- Allows the same compiled bundle to be deployed to multiple environments.
- Does NOT expose sensitive data (no tokens, no keys).
- Is placed BEFORE the bundle `<script type="module">` tag, so it is readable synchronously at module init time.

### 12.2 `AppProvider` Initialization

The `AppProvider` component (from `@oneplatform/app-sdk`) reads `window.__OP_APP_CONFIG__` at mount:

```typescript
// In @oneplatform/app-sdk:
export function AppProvider({ children }: { children: ReactNode }) {
  const config = window.__OP_APP_CONFIG__;
  // Initialize BFF client with config.appId, config.tenantId
  // Prefetch /bff/me and /bff/permissions on mount
  // Set up WebSocket connection to /apps/{slug}/ws
  return <SDKContext.Provider value={sdkState}>{children}</SDKContext.Provider>;
}
```

The `AppProvider` MUST be the root wrapper of every OnePlatform-hosted app. If `window.__OP_APP_CONFIG__` is not set (e.g., app loaded outside the platform), `AppProvider` throws a clear error: `OnePlatformConfigError: window.__OP_APP_CONFIG__ is not defined. This app must be served by OnePlatform.`

### 12.3 Runtime Config for Secret Env Vars

Secret env vars are NOT inlined at build time (that would expose them in the bundle). Instead, the SDK fetches them at runtime:

```
AppProvider mount
    → GET /internal/app/runtime-config/{appId} (internal endpoint)
    X-Service-Token: (not used here — this is called by the browser-side SDK)

Actually:
    → The AppProvider calls GET /bff/runtime-config at initialization
    → App Service BFF: decrypts secret env vars using OP_MASTER_KEY
    → Returns { envVars: { KEY: "decrypted_value", ... } }
    → SDK stores in memory, never in localStorage
```

This endpoint is protected by session cookie — only authenticated users receive secret env vars.

### 12.4 SDK Hooks Implementation Summary

| Hook | BFF Endpoint | Caching | Real-Time |
|------|-------------|---------|-----------|
| `useQuery` | `GET /bff/data/{entity}` | Client: 30s staleTime | Refreshed on `useSubscription` event |
| `useMutation` | `POST/PATCH/DELETE /bff/data/{entity}` | None | Triggers refetch of related `useQuery` |
| `useSubscription` | `GET /bff/data/{entity}/subscribe` (SSE) or WebSocket | None | Live events |
| `useUser` | `GET /bff/me` | Client: session lifetime | N/A |
| `usePermission` | `GET /bff/permissions` (prefetched) | Client: 5 min | N/A |
| `useAppStorage` | `GET/PUT /bff/storage/{key}` | None | N/A |

---

## 13. Monaco Editor Support

### 13.1 TypeScript Intellisense

The App Service generates TypeScript type declarations for Monaco via `GET /api/v1/apps/{id}/type-declarations`. This endpoint:

1. Fetches the current ontology schema from the Ontology Service (cache hit expected).
2. Fetches the current allowed modules list from `app.apps.allowed_modules`.
3. Renders type declaration strings for:
   - All entities in the tenant's ontology (as TypeScript interfaces).
   - The `@oneplatform/app-sdk` hook API with entity-typed generics.
   - Any tenant-specific extensions.
4. Returns the declarations as a JSON array of `{ filename: string, content: string }` objects.

**Response `200`:**
```typescript
{
  data: {
    declarations: {
      filename: string;  // e.g., "oneplatform-sdk.d.ts", "ontology-types.d.ts"
      content: string;   // TypeScript declaration source
    }[];
  }
}
```

The frontend Monaco component calls this endpoint once on editor open and injects each declaration via:
```javascript
monaco.languages.typescript.typescriptDefaults.addExtraLib(
  declaration.content,
  `file:///node_modules/${declaration.filename}`
);
```

### 13.2 Ontology-Typed Completions

The generated `ontology-types.d.ts` includes interfaces for every entity in the tenant's ontology:

```typescript
// Auto-generated by App Service from tenant ontology
// Do not edit — regenerated on each schema change

declare module "@oneplatform/ontology-types" {
  export interface Customer {
    id: string;
    name: string;
    email: string;
    status: "active" | "inactive" | "pending";
    createdAt: string;
  }

  export interface Order {
    id: string;
    customerId: string;
    total: number;
    lineItems: OrderLineItem[];
    createdAt: string;
  }
  // ... one interface per entity
}
```

And the `oneplatform-sdk.d.ts` augments the SDK hooks with these types:

```typescript
// Auto-generated SDK augmentation
import type { Customer, Order } from "@oneplatform/ontology-types";

declare module "@oneplatform/app-sdk" {
  // Typed convenience wrappers
  export function useCustomers(options?: QueryOptions): QueryResult<Customer>;
  export function useOrders(options?: QueryOptions): QueryResult<Order>;
  export function useCustomerMutation(): MutationResult<Customer>;
  // Generic hooks still available for non-typed usage
}
```

### 13.3 Declaration Invalidation

Declarations are cached client-side. They are re-fetched when:
1. The editor is first opened.
2. The user is notified via SSE that the ontology has changed (`ontology.schema.changed` event, received via the WebSocket connection).
3. Every 5 minutes as a safety poll.

On the server side, the declaration generation result is cached in Redis (`app:type-decls:{tenantId}:{schemaVersion}`, TTL 1 hour) to avoid regenerating on every editor open.

### 13.4 Monaco Configuration

The frontend initializes Monaco with these settings for OnePlatform apps:

```typescript
monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
  target: monaco.languages.typescript.ScriptTarget.ES2020,
  module: monaco.languages.typescript.ModuleKind.ESNext,
  moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
  jsx: monaco.languages.typescript.JsxEmit.ReactJSX,
  strict: true,
  esModuleInterop: true,
  allowSyntheticDefaultImports: true,
  noUnusedLocals: false,   // relaxed for app development
  noUnusedParameters: false,
});

// Diagnostics: show errors inline, not as blocking
monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
  noSemanticValidation: false,
  noSyntaxValidation: false,
  diagnosticCodesToIgnore: [],
});
```

### 13.5 Diff View

For build history diff views, the Monaco diff editor is initialized with:
```typescript
monaco.editor.createDiffEditor(container, {
  originalEditable: false,
  readOnly: true,
  renderSideBySide: true,
});
```

Content for each version is fetched from `GET /api/v1/apps/{id}/builds/{buildId}/files/{path}` — an endpoint that returns the file content as it was at the time of that build. This content is stored in the `build_manifest.JSONB` field as a snapshot of file hashes (not full content — fetching the full content uses the `app.files` content at the time of build, which must be approximated via the file's `content_hash` at build time). 

**Practical implementation:** at build time, the App Service stores a snapshot of file paths and `content_hash` values in `build_manifest.fileSnapshot: { [path]: contentHash }`. When a diff is requested, it fetches the content from `app.files` WHERE `content_hash = {snapshot_hash}`. If the file has since been overwritten, the old content is unavailable (content is not versioned in Postgres — only the current version is stored). In this case, the diff view shows "File content no longer available for this version." Full content versioning is a future enhancement (would require a `app.file_history` table).

---

## 14. Error Handling

### 14.1 App-Service-Specific Error Codes

All errors follow the standard envelope (ADR-29: `{ error: { code, message, details, requestId } }`).

| Code | HTTP Status | Cause |
|------|-------------|-------|
| `APP_NOT_FOUND` | 404 | App does not exist or belongs to different tenant |
| `APP_FILE_NOT_FOUND` | 404 | File path not found in VFS |
| `APP_FILE_VERSION_CONFLICT` | 409 | Optimistic locking failure on file write |
| `APP_FILE_TOO_LARGE` | 413 | File content exceeds 1MB limit |
| `APP_FILE_INVALID_PATH` | 400 | Path traversal, invalid extension, or forbidden characters |
| `APP_CANNOT_DELETE_ENTRYPOINT` | 422 | Attempt to delete `/src/index.tsx` |
| `APP_BUILD_IN_PROGRESS` | 409 | Another build is already running for this app |
| `APP_BUILD_NOT_READY` | 400 | Build is not in `success` state for deploy/rollback |
| `APP_BUILD_ARTIFACTS_EXPIRED` | 400 | Build artifacts purged from MinIO (beyond retention) |
| `APP_CANNOT_DELETE_ACTIVE_BUILD` | 422 | Attempt to delete the currently deployed build |
| `APP_NO_ACTIVE_BUILD` | 503 | App has no successful build deployed (serving fails) |
| `APP_NO_FILES` | 422 | App VFS is empty — build would fail immediately |
| `APP_STORAGE_KEY_NOT_FOUND` | 404 | Key not found in `app.user_storage` |
| `APP_STORAGE_VALUE_TOO_LARGE` | 413 | JSON value exceeds 64KB |
| `APP_OAUTH_CLIENT_REGISTRATION_FAILED` | 502 | Auth Service rejected OAuth registration |
| `APP_CROSS_TENANT_SHARING_DISABLED` | 403 | Global feature flag prevents cross-tenant sharing |
| `APP_CANNOT_DELETE_ENTRYPOINT` | 422 | VFS entrypoint protection |
| `GUEST_SESSION_RATE_LIMITED` | 429 | Guest session creation rate limit hit |

### 14.2 Build Failure Handling

When a build fails:
1. `app.builds.status` is set to `'failed'`.
2. `error_message` contains a human-readable summary.
3. `error_detail` contains the structured esbuild error array with file/line/column information.
4. `current_build_id` is NOT changed — the app continues serving the last successful build.
5. A `app.build.failed` platform event is published.
6. The SSE log stream receives a final `event: done` with `{ status: "failed" }`.

The Monaco editor frontend renders build errors inline using the `error_detail` data:
- Each error is a decoration on the affected line/column.
- A collapsible "Build Errors" panel shows all errors with their messages.
- Clicking an error scrolls to the affected file and line.

### 14.3 Deployment Failure Handling

If `POST /api/v1/apps/{id}/deploy` fails after the `current_build_id` has been updated (e.g., OAuth registration fails), the App Service:
1. Rolls back `current_build_id` to the previous value in a compensating transaction.
2. Returns `502 APP_OAUTH_CLIENT_REGISTRATION_FAILED` with the original `currentBuildId`.
3. Logs an audit event with the failed deploy attempt.

This ensures no partial deploy state: either the full deploy (including OAuth registration) succeeds, or `current_build_id` reverts to the previous value.

### 14.4 BFF Error Handling

The BFF layer translates upstream errors from internal services:

| Upstream Error | BFF Response |
|---------------|-------------|
| Auth Service 401 | `401 UNAUTHORIZED` — session invalid |
| Auth Service 503 | `503 SERVICE_UNAVAILABLE` — fail-closed (do not allow through) |
| Ontology Service 403 | `403 PERMISSION_DENIED` |
| Ontology Service 404 | `404 ENTITY_NOT_FOUND` |
| Ontology Service 429 | `429 RATE_LIMIT_EXCEEDED` (propagated) |
| Ontology Service 503 | `503 SERVICE_UNAVAILABLE` |
| Network timeout | `504 GATEWAY_TIMEOUT` |

BFF errors include the `requestId` (W3C trace ID) in the error body, which correlates with logs in the Logging Service.

### 14.5 Circuit Breaker

The App Service implements circuit breakers for calls to the Execution Service and Auth Service:

```typescript
// Example circuit breaker config (using @oneplatform/core's CircuitBreaker)
const executionServiceBreaker = new CircuitBreaker({
  failureThreshold: 5,    // open after 5 failures in 60s
  successThreshold: 2,    // close after 2 successes
  timeout: 60_000,        // half-open probe interval: 60s
  onOpen: () => logger.warn("Execution Service circuit open — builds unavailable"),
  onClose: () => logger.info("Execution Service circuit closed — builds available"),
});
```

When the Execution Service circuit is open:
- `POST /api/v1/apps/{id}/builds` returns `503 SERVICE_UNAVAILABLE` with `retryAfter: 60`.
- Preview mode falls back to the last successful build (no new incremental builds).

When the Auth Service circuit is open:
- BFF returns `503 SERVICE_UNAVAILABLE` for all `/bff/*` requests (fail-closed).
- Serving of already-authenticated sessions continues using the 15-second session cache.

---

## 15. Observability

### 15.1 OpenTelemetry Spans

The App Service creates OTEL spans for all significant operations (in addition to the automatic spans from `@oneplatform/core`'s Hono instrumentation):

| Span Name | Attributes |
|-----------|-----------|
| `app.vfs.read` | `app.id`, `file.path`, `file.version` |
| `app.vfs.write` | `app.id`, `file.path`, `file.size_bytes` |
| `app.build.submit` | `app.id`, `build.id`, `build.file_count` |
| `app.build.upload` | `app.id`, `build.id`, `minio.bucket`, `minio.key_prefix` |
| `app.bff.validate_session` | `app.id`, `cache.hit` (bool) |
| `app.bff.rbac_check` | `app.id`, `entity`, `action`, `allowed` (bool) |
| `app.bff.forward` | `app.id`, `entity`, `upstream_service`, `upstream_status` |
| `app.serve.resolve` | `app.slug`, `build.id`, `cache.hit` (bool) |
| `app.oauth.register` | `app.id`, `client_id` |
| `app.guest_session.issue` | `app.id` |

### 15.2 Metrics

Exposed at `GET /metrics` (Prometheus format):

```
# Build pipeline
oneplatform_app_builds_total{status="success|failed|timeout"} counter
oneplatform_app_build_duration_seconds{quantile="0.5|0.95|0.99"} histogram
oneplatform_app_build_queue_depth gauge

# BFF
oneplatform_bff_requests_total{entity, action, status="allowed|denied|error"} counter
oneplatform_bff_session_cache_hits_total counter
oneplatform_bff_upstream_latency_seconds{upstream, quantile} histogram

# Serving
oneplatform_app_serve_requests_total{mode="production|preview", status} counter
oneplatform_app_minio_fetch_latency_seconds{quantile} histogram

# VFS
oneplatform_app_vfs_writes_total counter
oneplatform_app_vfs_version_conflicts_total counter

# WebSocket
oneplatform_app_ws_connections_active gauge
oneplatform_app_ws_events_fanned_out_total counter

# Guest sessions
oneplatform_app_guest_sessions_issued_total{app_id} counter
```

### 15.3 Health Checks

**`GET /healthz`** (liveness):
```json
{ "status": "ok", "service": "app", "version": "1.0.0" }
```

**`GET /readyz`** (readiness):
```json
{
  "status": "ready",
  "checks": {
    "postgres": "ok",
    "redis": "ok",
    "minio": "ok",
    "authService": "ok",
    "ontologyServiceCache": "ok"
  }
}
```

`authService` check: sends `HEAD /healthz` to Auth Service. If it fails, `readyz` returns `503` with the auth check showing `"degraded"`. The App Service continues to accept requests but BFF calls will fail.

`ontologyServiceCache` check: verifies the local ontology cache has at least one loaded tenant schema and was refreshed within the last 10 minutes.

### 15.4 Logging

All log events are published to Redis `logs:app` (non-audit) and `audit:app` (audit) channels using the `@oneplatform/core` log helper.

**Audit events logged by the App Service:**

| Action | Resource Type | Result |
|--------|--------------|--------|
| `app.create` | `app` | success/failure |
| `app.delete` | `app` | success |
| `app.deploy` | `app` | success/failure |
| `app.rollback` | `app` | success/failure |
| `app.bff.permission_denied` | `app` | failure |
| `app.oauth.register` | `oauth_client` | success/failure |
| `app.guest_session.create` | `guest_session` | success |
| `app.env_var.write` | `env_var` | success (key only, never value) |

---

## 16. Testing Strategy

### 16.1 Unit Tests

Located in `services/app/src/__tests__/unit/`.

**Targets:**
- VFS path validation logic (path traversal prevention, extension filtering).
- Content hash computation.
- Optimistic lock check SQL query generation.
- BFF session cache (LRU eviction, TTL expiry, concurrent access).
- BFF RBAC enforcement (field filtering, row filter injection).
- OAuth client ID determinism (`app:{appId}:{tenantId}` format).
- HTML shell generation (correct `__OP_APP_CONFIG__` injection).
- Env var encryption/decryption round-trips (AES-256-GCM with HKDF key derivation).
- Build retention cleanup logic (20-build window calculation).
- Guest session rate limit logic.

**Framework:** Vitest. No external dependencies (Postgres, Redis, MinIO) are called in unit tests — all are mocked via `vi.mock()`.

**Coverage target:** 90% line coverage for core business logic modules.

### 16.2 Integration Tests

Located in `services/app/src/__tests__/integration/`. Use a Docker Compose test environment (Postgres, Redis, MinIO) started by `vitest globalSetup`.

**Test cases:**

**VFS integration:**
- Create app, seed VFS, read files back — assert content_hash correctness.
- Concurrent writes with optimistic locking — assert conflict detection.
- Directory listing after multiple writes/deletes.
- Max-file-count enforcement (200 files per app).
- Max-file-size enforcement (1MB per file).

**Build pipeline integration (mocked Execution Service):**
- Submit build → assert `app.builds` row created with `status = 'building'`.
- Simulate successful execution response → assert MinIO upload, `status = 'success'`, `build_manifest` populated.
- Simulate failed execution response → assert `status = 'failed'`, `error_detail` populated, `current_build_id` unchanged.
- Concurrent build attempt → assert `409 APP_BUILD_IN_PROGRESS`.
- Build log SSE stream → assert log lines received and final done event.

**Deployment integration:**
- Full flow: create app → build → deploy → assert `current_build_id` updated.
- Rollback: deploy v2 → rollback to v1 → assert serving reverts.
- Deploy non-existent build → `400`.
- Deploy failed build → `400 APP_BUILD_NOT_READY`.

**BFF integration (mocked Auth and Ontology Services):**
- Valid session → RBAC allow → data forwarded correctly.
- Invalid session → `401`.
- RBAC deny → `403`.
- Field-level filtering → assert response fields reduced.
- Row-level filter injection → assert query params modified.
- Session cache hit → assert Auth Service not called again within 15s.

**OAuth lifecycle integration:**
- Create app → deploy → assert OAuth registration sent to Auth Service mock.
- Re-deploy → assert idempotent upsert (no duplicate registration).
- Delete app → assert OAuth deregistration sent.

**Guest session integration:**
- Public app → no cookie → guest session issued and cookie set.
- Rate limit: 20 guest sessions per IP per minute → 21st returns `429`.
- Platform-user app → no cookie → `302` redirect.

### 16.3 End-to-End Tests

Located in `services/app/src/__tests__/e2e/`. Use Playwright against a full-stack Docker Compose environment.

**Test cases:**

**Full build pipeline E2E:**
1. Create a new app via API.
2. Write a valid React component to VFS via API.
3. Trigger a build via API.
4. Poll build status until `success` or `failed` (timeout 60s).
5. Assert `bundle.js` is readable from `GET /apps/{slug}/bundle.js`.
6. Assert `build-manifest.json` has correct `bundleSizeBytes > 0`.

**Full deploy/rollback E2E:**
1. Build app (v1) → deploy → assert `GET /apps/{slug}/` returns HTML with correct `__OP_APP_CONFIG__`.
2. Modify a file → build (v2) → deploy → assert serving switches to v2.
3. Rollback to v1 → assert serving reverts to v1.

**Monaco editor E2E (Playwright UI test):**
1. Navigate to the app editor in the dashboard.
2. Type TypeScript code with an ontology entity (`useQuery<Customer>()`).
3. Assert Monaco shows no TypeScript errors (entity types are correctly injected).
4. Add an invalid import (`import x from 'unknown-package'`) → assert inline error appears.
5. Trigger build → assert build failure shown in error panel.

**BFF E2E:**
1. Browser navigates to `GET /apps/{slug}/` → served correctly.
2. JavaScript in the app calls `fetch("/bff/me")` → returns user context.
3. JavaScript calls `fetch("/bff/data/customers")` → returns data (seeded in test setup).
4. Logout → subsequent `/bff/me` call returns `401`.

**Guest session E2E:**
1. Create a public app → navigate to it without logging in.
2. Assert `op_guest_session` cookie is set.
3. Assert `GET /bff/me` returns `{ isGuest: true }`.
4. Assert calling `useQuery` for a non-public entity returns `403`.
5. Assert calling `useQuery` for a public entity returns data.

### 16.4 Contract Tests (Pact)

The App Service is a consumer of the Auth Service's internal validation API. A Pact consumer-driven contract test verifies:

- `GET /internal/auth/validate` with a valid session token → expected `{ userId, tenantId, roles }` shape.
- `GET /internal/auth/validate` with an expired token → `401` response shape.
- `POST /internal/auth/guest-sessions` → correct guest token response shape.
- `POST /internal/oauth/clients` → idempotent registration response shape.

These Pact tests run in CI alongside the Auth Service's provider verification.

### 16.5 Performance Tests

Benchmark targets run with `vitest bench`:

- VFS write throughput: 100 concurrent writes to different files within one app → all complete within 5s.
- Build job submission latency: time from `POST /api/v1/apps/{id}/builds` to Execution Service call initiation → under 200ms (not including build duration).
- BFF session cache hit path: `GET /bff/me` with warm cache → under 5ms p95.
- App serving (HTML shell generation): `GET /apps/{slug}/` → under 50ms p95 (excluding MinIO fetch).
- MinIO bundle fetch: `GET /apps/{slug}/bundle.js` → under 100ms p95 on local Docker network.

---

## 17. Deployment Approach

### 17.1 Docker Image

The App Service is built using the shared `docker/Dockerfile.service` multi-stage build:

```dockerfile
# Build stage
FROM node:20-alpine AS builder
WORKDIR /app
COPY pnpm-lock.yaml package.json ./
COPY packages/core ./packages/core
COPY services/app ./services/app
RUN corepack enable && pnpm install --frozen-lockfile
RUN pnpm --filter @oneplatform/app build

# Runtime stage
FROM node:20-alpine AS runtime
WORKDIR /app
RUN addgroup -S op && adduser -S op -G op
COPY --from=builder --chown=op:op /app/services/app/dist ./dist
COPY --from=builder --chown=op:op /app/node_modules ./node_modules
USER op
EXPOSE 3006
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:3006/healthz || exit 1
CMD ["node", "dist/index.js"]
```

### 17.2 Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | — | PgBouncer connection string for the `app` schema |
| `REDIS_URL` | Yes | — | Redis connection string |
| `MINIO_ENDPOINT` | Yes | — | MinIO endpoint URL |
| `MINIO_ACCESS_KEY` | Yes | — | MinIO access key (least-privilege IAM user) |
| `MINIO_SECRET_KEY` | Yes | — | MinIO secret key |
| `AUTH_SERVICE_URL` | Yes | `http://auth-service:3001` | Auth Service base URL |
| `ONTOLOGY_SERVICE_URL` | Yes | `http://ontology-service:3003` | Ontology Service base URL |
| `EXECUTION_SERVICE_URL` | Yes | `http://execution-service:3005` | Execution Service base URL |
| `LOGGING_SERVICE_URL` | Yes | `http://logging-service:3007` | Logging Service base URL |
| `OP_BASE_URL` | Yes | `http://localhost:3000` | Platform base URL (for OAuth redirect URIs) |
| `OP_WILDCARD_DOMAIN` | No | — | Wildcard domain for subdomain app routing |
| `APP_BUILD_RETENTION_COUNT` | No | `20` | Max successful builds retained per app |
| `OP_ENABLE_CROSS_TENANT_SHARING` | No | `false` | Enable cross-tenant app sharing |
| `SERVICE_PRIVATE_KEY_PATH` | Yes | `/data/service.key` | Ed25519 private key for X-Service-Token signing |
| `SERVICE_KEYS_DIR` | Yes | `/data/service-keys/` | Directory of peer service public keys |
| `NODE_ENV` | No | `production` | Node environment |
| `LOG_LEVEL` | No | `info` | Log level (debug/info/warn/error) |
| `PORT` | No | `3006` | Listen port |

### 17.3 Docker Compose Placement

```yaml
app-service:
  build:
    context: .
    dockerfile: docker/Dockerfile.service
    args:
      SERVICE: app
  image: oneplatform/app-service:${VERSION:-latest}
  ports: []                          # No external port exposure
  networks:
    - oneplatform-internal
  volumes:
    - app-data:/data                 # Service private key
    - service-keys:/data/service-keys:ro  # Peer public keys (read-only)
    - init-data:/data/init:ro        # Master key (read-only)
  environment:
    DATABASE_URL: postgres://app_service:${APP_DB_PASSWORD}@pgbouncer:5433/oneplatform
    REDIS_URL: redis://:${REDIS_PASSWORD}@redis:6379
    MINIO_ENDPOINT: http://minio:9000
    # ... other env vars from .env
  depends_on:
    postgres:
      condition: service_healthy
    auth-service:
      condition: service_healthy
    minio:
      condition: service_healthy
  healthcheck:
    test: ["CMD", "wget", "-qO-", "http://localhost:3006/healthz"]
    interval: 10s
    timeout: 5s
    start_period: 30s
    retries: 3
  restart: unless-stopped
  deploy:
    resources:
      limits:
        memory: 512M
        cpus: "1.0"
```

### 17.4 Database Migrations

Migrations are managed by `drizzle-orm/migrator`. They run automatically on service startup before the HTTP server starts.

Migration files are in `services/app/src/db/migrations/`. Each migration is a `.sql` file with a sequential name (e.g., `0001_create_apps_table.sql`).

The migration runner uses a dedicated Postgres role `app_service` with `USAGE` on the `app` schema and `SELECT, INSERT, UPDATE, DELETE` on all tables. The migration runner temporarily elevates to `app_schema_owner` (a role with `CREATE` on the `app` schema) for DDL operations only.

### 17.5 Rollout Strategy

The App Service is stateless with respect to in-flight HTTP requests (state is in Postgres, Redis, and MinIO). Rolling deploys are safe:

1. New container starts, runs migrations (idempotent), passes `/readyz`.
2. Gateway begins routing new requests to new container.
3. Old container drains in-flight requests (30-second drain window).
4. Old container stops.

The only stateful concern is WebSocket connections — existing WebSocket connections are terminated when the old container stops. The `@oneplatform/app-sdk` reconnection logic handles this transparently from the browser's perspective.

---

## Appendix A: Service Permission Matrix (App Service perspective)

From `@oneplatform/core/service-rbac.ts` (ADR-19), the App Service is authorized to call:

| Target Service | Allowed Endpoints |
|---------------|-----------------|
| Auth Service | `GET /internal/auth/validate`, `POST /internal/auth/guest-sessions`, `POST /internal/oauth/clients`, `DELETE /internal/oauth/clients/{clientId}` |
| Ontology Service | `GET /internal/ontology/schema`, `GET /internal/ontology/type-declarations`, `GET /internal/data/{entity}`, `POST /internal/data/{entity}`, `PATCH /internal/data/{entity}/{id}`, `DELETE /internal/data/{entity}/{id}` |
| Execution Service | `POST /internal/execution/execute` (app-build type only) |
| Logging Service | `GET /internal/logging/query` |

The App Service may NOT call: Ingestion Service, Pipeline Service (except via triggering through a browser app's `useMutation`, which goes through the Ontology Service), Plugin Service.

---

## Appendix B: Redis Key Namespace

The App Service's Redis ACL: `~guest-session:* &events:*` (per ADR-5).

| Key Pattern | Type | TTL | Purpose |
|-------------|------|-----|---------|
| `guest-session:rate:{ip}` | string (counter) | 60s | Guest session rate limit per IP |
| `app:build-logs:{buildId}` | list | 24h | Buffered build log lines for SSE replay |
| `app:session-validate:{token_hash}` | string (JSON) | 15s | Session validation cache (not persisted to Redis — in-process LRU only; no Redis key for this) |
| `app:type-decls:{tenantId}:{schemaVersion}` | string (JSON) | 1h | Cached type declaration generation |

The session cache is in-process LRU only and does NOT write to Redis. This avoids a Redis round-trip for the cache and limits session data exposure.

---

## Appendix C: MinIO Bucket Layout

**Bucket:** `op-app-artifacts`

```
{tenantId}/
  {appId}/
    builds/
      {buildId}/
        bundle.js
        bundle.js.map
        build-manifest.json
```

**IAM Policy for App Service user (`app-service-minio-user`):**
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::op-app-artifacts/*"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::op-app-artifacts"
    }
  ]
}
```

The App Service cannot create or delete the bucket itself (no `s3:CreateBucket`, `s3:DeleteBucket`). Bucket creation is handled by the `op-init` container on first startup.
