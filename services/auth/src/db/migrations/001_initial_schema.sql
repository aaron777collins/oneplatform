-- ============================================================
-- Migration: 001_initial_schema
-- Auth Service — complete schema for all auth tables.
--
-- This migration is idempotent (IF NOT EXISTS everywhere).
-- Applied by auth_migrator_role which holds CREATE on the auth schema.
-- The auth_service_role used at runtime only holds DML privileges.
-- ============================================================

-- ============================================================
-- Schema setup (must precede all auth.* table creation)
-- ============================================================
CREATE SCHEMA IF NOT EXISTS auth;

-- ============================================================
-- schema_migrations tracking table
-- Must be created first so the migration runner can record this
-- migration after applying it.
-- ============================================================
CREATE TABLE IF NOT EXISTS auth.schema_migrations (
    version     TEXT PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- auth.tenants
-- ============================================================
CREATE TABLE IF NOT EXISTS auth.tenants (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                TEXT NOT NULL,
    slug                TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    settings            JSONB NOT NULL DEFAULT '{}',
    -- settings contains: { rateLimitTier: "standard"|"premium", maxUsers: int|null,
    --                       emailVerificationRequired: bool, allowedOAuthProviders: string[] }
    CONSTRAINT tenants_slug_unique UNIQUE (slug),
    CONSTRAINT tenants_name_not_empty CHECK (length(trim(name)) > 0),
    CONSTRAINT tenants_slug_format CHECK (slug ~ '^[a-z0-9][a-z0-9\-]{1,62}[a-z0-9]$')
);

CREATE INDEX IF NOT EXISTS idx_tenants_slug ON auth.tenants (slug);

-- ============================================================
-- auth.users
-- ============================================================
CREATE TABLE IF NOT EXISTS auth.users (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL REFERENCES auth.tenants(id) ON DELETE CASCADE,
    email               TEXT NOT NULL,
    -- email is NOT globally unique — the same email can exist in multiple tenants
    password_hash       TEXT,
    -- NULL for OAuth-only accounts
    email_verified      BOOLEAN NOT NULL DEFAULT false,
    is_active           BOOLEAN NOT NULL DEFAULT true,
    display_name        TEXT,
    roles               TEXT[] NOT NULL DEFAULT '{}',
    -- roles are names from auth.roles (denormalized for query performance)
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at       TIMESTAMPTZ,
    failed_login_count  INTEGER NOT NULL DEFAULT 0,
    locked_until        TIMESTAMPTZ,
    -- Account lockout: locked after 10 consecutive failed logins for 15 minutes
    metadata            JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT users_email_per_tenant_unique UNIQUE (tenant_id, email),
    CONSTRAINT users_email_format CHECK (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
    CONSTRAINT users_roles_valid CHECK (array_length(roles, 1) IS NULL OR array_length(roles, 1) <= 20)
);

CREATE INDEX IF NOT EXISTS idx_users_tenant_id ON auth.users (tenant_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON auth.users (lower(email));
CREATE INDEX IF NOT EXISTS idx_users_tenant_email ON auth.users (tenant_id, lower(email));
-- Partial index for active users only (most queries exclude inactive):
CREATE INDEX IF NOT EXISTS idx_users_active ON auth.users (tenant_id) WHERE is_active = true;

ALTER TABLE auth.users ENABLE ROW LEVEL SECURITY;

-- Drop before recreating so this migration stays idempotent on re-run.
-- The policy is not a schema object with IF NOT EXISTS support in all PG versions.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'auth'
          AND tablename  = 'users'
          AND policyname = 'users_tenant_isolation'
    ) THEN
        CREATE POLICY users_tenant_isolation ON auth.users
            USING (tenant_id = current_setting('app.tenant_id', true)::uuid
                   OR current_setting('app.bypass_rls', true) = 'true');
    END IF;
END
$$;

-- ============================================================
-- auth.sessions
-- ============================================================
-- One row per active refresh token. Refresh tokens are opaque strings stored
-- in Redis (keyed by token value); this table is the durable record that survives
-- Redis restarts. The Redis entry is the fast-path lookup; the Postgres row is
-- the source of truth for audit and forced logout.
CREATE TABLE IF NOT EXISTS auth.sessions (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    tenant_id               UUID NOT NULL REFERENCES auth.tenants(id) ON DELETE CASCADE,
    refresh_token_jti       UUID NOT NULL,
    -- The JTI of the CURRENT refresh token in this session's rotation chain.
    -- On each rotation, this value updates atomically.
    family_id               UUID NOT NULL DEFAULT gen_random_uuid(),
    -- family_id is assigned at session creation and never changes.
    -- If a refresh token is replayed (already-rotated token reused), the ENTIRE
    -- family is invalidated (all sessions with matching family_id).
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at              TIMESTAMPTZ NOT NULL,
    revoked_at              TIMESTAMPTZ,
    revoked_reason          TEXT,
    -- e.g., "logout", "password_reset", "admin_revoke", "token_replay_detected"
    user_agent              TEXT,
    ip_address              INET,

    CONSTRAINT sessions_refresh_token_jti_unique UNIQUE (refresh_token_jti),
    CONSTRAINT sessions_expires_after_created CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON auth.sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_tenant_id ON auth.sessions (tenant_id);
CREATE INDEX IF NOT EXISTS idx_sessions_family_id ON auth.sessions (family_id);
CREATE INDEX IF NOT EXISTS idx_sessions_refresh_token_jti ON auth.sessions (refresh_token_jti);
-- Partial index for active (non-expired, non-revoked) sessions:
CREATE INDEX IF NOT EXISTS idx_sessions_active ON auth.sessions (user_id)
    WHERE revoked_at IS NULL AND expires_at > now();

-- ============================================================
-- auth.api_keys
-- ============================================================
CREATE TABLE IF NOT EXISTS auth.api_keys (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    tenant_id           UUID NOT NULL REFERENCES auth.tenants(id) ON DELETE CASCADE,
    name                TEXT NOT NULL,
    key_hash            TEXT NOT NULL,
    -- bcrypt hash of the full key string (op_live_{32-char-random})
    key_prefix          TEXT NOT NULL,
    -- First 8 characters of the key after the op_live_ prefix.
    -- Used for fast lookup before bcrypt comparison.
    -- Full format: "op_live_" + 8-char-prefix + remaining chars
    scopes              TEXT[] NOT NULL DEFAULT '{}',
    expires_at          TIMESTAMPTZ,
    -- NULL means never expires. Revocation via Redis is always instant.
    last_used_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at          TIMESTAMPTZ,
    revoked_by          UUID REFERENCES auth.users(id),

    CONSTRAINT api_keys_name_not_empty CHECK (length(trim(name)) > 0),
    CONSTRAINT api_keys_prefix_length CHECK (length(key_prefix) = 8),
    CONSTRAINT api_keys_name_per_user UNIQUE (user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON auth.api_keys (user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_tenant_id ON auth.api_keys (tenant_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_key_prefix ON auth.api_keys (key_prefix);
-- Partial index for active (non-revoked, non-expired) keys:
CREATE INDEX IF NOT EXISTS idx_api_keys_active ON auth.api_keys (key_prefix)
    WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now());

-- ============================================================
-- auth.oauth_providers
-- ============================================================
CREATE TABLE IF NOT EXISTS auth.oauth_providers (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    tenant_id               UUID NOT NULL REFERENCES auth.tenants(id) ON DELETE CASCADE,
    provider                TEXT NOT NULL,
    -- "github" | "google"
    provider_user_id        TEXT NOT NULL,
    -- The user's ID within the provider (e.g., GitHub numeric user ID)
    provider_email          TEXT,
    -- Email returned by provider; may differ from auth.users.email
    access_token_encrypted  TEXT,
    -- AES-256-GCM encrypted provider access token (HKDF-derived per ADR-11)
    refresh_token_encrypted TEXT,
    token_expires_at        TIMESTAMPTZ,
    token_key_version       INTEGER NOT NULL DEFAULT 1,
    -- Key version for rotation; matches OP_MASTER_KEY version
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT oauth_providers_unique_per_user UNIQUE (user_id, provider),
    CONSTRAINT oauth_providers_unique_provider_user UNIQUE (provider, provider_user_id, tenant_id),
    CONSTRAINT oauth_providers_name_check CHECK (provider IN ('github', 'google'))
);

CREATE INDEX IF NOT EXISTS idx_oauth_providers_user_id ON auth.oauth_providers (user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_providers_provider_lookup ON auth.oauth_providers (provider, provider_user_id);

-- ============================================================
-- auth.roles
-- ============================================================
CREATE TABLE IF NOT EXISTS auth.roles (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID REFERENCES auth.tenants(id) ON DELETE CASCADE,
    -- NULL for platform-level predefined roles (platform-admin)
    name                TEXT NOT NULL,
    description         TEXT NOT NULL DEFAULT '',
    is_predefined       BOOLEAN NOT NULL DEFAULT false,
    -- Predefined roles cannot be deleted or renamed
    permissions         TEXT[] NOT NULL DEFAULT '{}',
    -- Array of scope strings: e.g., {"data:read", "data:write", "pipelines:manage"}
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT roles_unique_name_per_tenant UNIQUE (tenant_id, name),
    CONSTRAINT roles_name_not_empty CHECK (length(trim(name)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_roles_tenant_id ON auth.roles (tenant_id);
CREATE INDEX IF NOT EXISTS idx_roles_name ON auth.roles (name);

-- Seed predefined roles. ON CONFLICT DO NOTHING makes this idempotent.
-- tenant_id = NULL identifies platform-level roles shared across all tenants.
INSERT INTO auth.roles (id, tenant_id, name, description, is_predefined, permissions) VALUES
  (gen_random_uuid(), NULL, 'platform-admin',
   'Full access across all tenants', true,
   ARRAY['admin']),

  (gen_random_uuid(), NULL, 'tenant-admin',
   'Full access within own tenant', true,
   ARRAY['data:read','data:write','ontology:read','ontology:write',
         'pipelines:manage','apps:manage','apps:deploy','apps:read',
         'execution:run','plugins:read','plugins:manage',
         'users:read','users:manage','logs:read','webhooks:manage']),

  (gen_random_uuid(), NULL, 'developer',
   'Build and deploy apps and pipelines', true,
   ARRAY['data:read','data:write','ontology:read','pipelines:manage',
         'apps:manage','apps:deploy','apps:read','execution:run',
         'plugins:read','logs:read']),

  (gen_random_uuid(), NULL, 'editor',
   'Manage data, pipelines, and apps (no deploy)', true,
   ARRAY['data:read','data:write','ontology:read','pipelines:manage',
         'apps:manage','apps:read','logs:read']),

  (gen_random_uuid(), NULL, 'viewer',
   'Read-only access to data and apps', true,
   ARRAY['data:read','ontology:read','pipelines:read','apps:read','logs:read'])

ON CONFLICT (tenant_id, name) DO NOTHING;

-- ============================================================
-- auth.entity_permissions
-- ============================================================
-- Ontology-aware entity/field/row-level permissions.
-- One row per (tenant, entity_type, role) combination.
CREATE TABLE IF NOT EXISTS auth.entity_permissions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL REFERENCES auth.tenants(id) ON DELETE CASCADE,
    entity_type         TEXT NOT NULL,
    -- Ontology entity name, e.g., "customer", "order". "*" for all entities.
    role                TEXT NOT NULL,
    -- Role name this rule applies to
    actions             TEXT[] NOT NULL DEFAULT '{}',
    -- Allowed actions: "create" | "read" | "update" | "delete" | "admin"
    field_restrictions  JSONB NOT NULL DEFAULT '{}',
    -- { "deny_read": ["ssn", "credit_card"], "deny_write": ["created_at"] }
    row_filter          JSONB NOT NULL DEFAULT '{}',
    -- Row-level filter injected into queries: e.g., { "ownerId": "$userId" }
    -- "$userId" is substituted at query time with the requesting user's ID.
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT entity_permissions_unique UNIQUE (tenant_id, entity_type, role)
);

CREATE INDEX IF NOT EXISTS idx_entity_permissions_tenant_id ON auth.entity_permissions (tenant_id);
CREATE INDEX IF NOT EXISTS idx_entity_permissions_lookup ON auth.entity_permissions (tenant_id, entity_type, role);

-- ============================================================
-- auth.oauth_clients
-- ============================================================
-- OAuth 2.0 client registrations. Apps (via App Service) register here.
CREATE TABLE IF NOT EXISTS auth.oauth_clients (
    client_id           TEXT PRIMARY KEY,
    -- Deterministic format for app clients: "app:{appId}:{tenantId}"
    -- User-created clients: "client_{uuid}"
    client_secret_hash  TEXT,
    -- NULL for public clients (PKCE only, no client secret)
    client_type         TEXT NOT NULL DEFAULT 'public',
    -- "public" | "confidential"
    redirect_uris       TEXT[] NOT NULL DEFAULT '{}',
    allowed_scopes      TEXT[] NOT NULL DEFAULT '{}',
    tenant_id           UUID REFERENCES auth.tenants(id) ON DELETE CASCADE,
    app_id              UUID,
    -- Non-null for app-auto-registered clients. References app.apps but
    -- Auth Service does not have an FK to app schema by design.
    access_mode         TEXT NOT NULL DEFAULT 'platform-user',
    -- "platform-user" | "public"
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by_service  TEXT,
    -- Service that created this client (e.g., "app-service")

    CONSTRAINT oauth_clients_type_check CHECK (client_type IN ('public', 'confidential')),
    CONSTRAINT oauth_clients_access_mode_check CHECK (access_mode IN ('platform-user', 'public')),
    CONSTRAINT oauth_clients_secret_required CHECK (
        client_type != 'confidential' OR client_secret_hash IS NOT NULL
    )
);

CREATE INDEX IF NOT EXISTS idx_oauth_clients_tenant_id ON auth.oauth_clients (tenant_id);
CREATE INDEX IF NOT EXISTS idx_oauth_clients_app_id ON auth.oauth_clients (app_id) WHERE app_id IS NOT NULL;

-- ============================================================
-- auth.bootstrap_state
-- ============================================================
-- Single-row table. Prevents re-bootstrapping after initial setup.
CREATE TABLE IF NOT EXISTS auth.bootstrap_state (
    id                      INTEGER PRIMARY KEY DEFAULT 1,
    bootstrap_completed     BOOLEAN NOT NULL DEFAULT false,
    completed_at            TIMESTAMPTZ,
    admin_user_id           UUID REFERENCES auth.users(id),
    first_tenant_id         UUID REFERENCES auth.tenants(id),

    CONSTRAINT bootstrap_state_single_row CHECK (id = 1)
);

-- Insert the single row at migration time:
INSERT INTO auth.bootstrap_state (id, bootstrap_completed) VALUES (1, false)
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- auth.password_reset_tokens
-- ============================================================
-- Durable record of issued password reset tokens. The actual validation
-- is dual: JWT signature + this Postgres record (for revocation audit).
-- Redis is the fast-path single-use gate (reset:{jti}).
-- This table provides the audit trail and allows admin-side forced invalidation.
CREATE TABLE IF NOT EXISTS auth.password_reset_tokens (
    jti                 UUID PRIMARY KEY,
    user_id             UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at          TIMESTAMPTZ NOT NULL,
    used_at             TIMESTAMPTZ,
    -- NULL means unused (or expired without use)
    ip_address          INET,

    CONSTRAINT password_reset_expires_after_created CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_password_reset_user_id ON auth.password_reset_tokens (user_id);
-- Partial index for unused tokens (fast lookup during validation):
CREATE INDEX IF NOT EXISTS idx_password_reset_unused ON auth.password_reset_tokens (jti)
    WHERE used_at IS NULL;
