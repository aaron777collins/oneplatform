-- App Service initial schema
-- All tables live in the `app` Postgres schema.
-- Design spec §2.1–§2.8

CREATE SCHEMA IF NOT EXISTS app;

-- ---------------------------------------------------------------------------
-- app.apps — core app registry
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS app.apps (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID        NOT NULL,
  name              TEXT        NOT NULL,
  slug              TEXT        NOT NULL,
  description       TEXT,
  access_mode       TEXT        NOT NULL DEFAULT 'platform-user'
                                CHECK (access_mode IN ('platform-user', 'public')),
  current_build_id  UUID,       -- FK added after app.builds is created
  allowed_modules   TEXT[]      NOT NULL DEFAULT ARRAY[
                                  'react','react-dom',
                                  '@oneplatform/app-sdk','@oneplatform/core','recharts'
                                ],
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        UUID        NOT NULL,
  deleted_at        TIMESTAMPTZ
);

-- Slug unique per tenant for platform-user apps
CREATE UNIQUE INDEX IF NOT EXISTS app_apps_tenant_slug_idx
  ON app.apps (tenant_id, slug)
  WHERE deleted_at IS NULL;

-- Slug globally unique among public apps (public app routing requires global uniqueness)
CREATE UNIQUE INDEX IF NOT EXISTS app_apps_public_slug_idx
  ON app.apps (slug)
  WHERE access_mode = 'public' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS app_apps_tenant_id_idx
  ON app.apps (tenant_id)
  WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- app.files — Virtual File System
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS app.files (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id          UUID        NOT NULL REFERENCES app.apps(id) ON DELETE CASCADE,
  path            TEXT        NOT NULL,
  content         TEXT        NOT NULL DEFAULT '',
  content_hash    TEXT        NOT NULL,
  file_version    INTEGER     NOT NULL DEFAULT 1,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by      UUID        NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS app_files_app_path_idx ON app.files (app_id, path);
CREATE INDEX IF NOT EXISTS app_files_app_id_idx ON app.files (app_id);

-- ---------------------------------------------------------------------------
-- app.builds — build pipeline records
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS app.builds (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id          UUID        NOT NULL REFERENCES app.apps(id) ON DELETE CASCADE,
  version_number  INTEGER     NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','building','success','failed')),
  bundle_path     TEXT,
  error_message   TEXT,
  error_detail    JSONB,
  build_manifest  JSONB,
  built_at        TIMESTAMPTZ,
  built_by        UUID        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS app_builds_app_version_idx ON app.builds (app_id, version_number);
CREATE INDEX IF NOT EXISTS app_builds_app_id_created_idx ON app.builds (app_id, created_at DESC);
CREATE INDEX IF NOT EXISTS app_builds_app_status_idx ON app.builds (app_id, status, created_at DESC);

-- Add current_build_id FK after app.builds exists (deferred forward reference).
-- Postgres has no ADD CONSTRAINT IF NOT EXISTS, so guard on pg_constraint to
-- keep the statement idempotent.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'app_apps_current_build_id_fkey'
  ) THEN
    ALTER TABLE app.apps
      ADD CONSTRAINT app_apps_current_build_id_fkey
      FOREIGN KEY (current_build_id) REFERENCES app.builds(id) ON DELETE SET NULL;
  END IF;
END$$;

-- ---------------------------------------------------------------------------
-- app.env_vars — encrypted environment variables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS app.env_vars (
  id           UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id       UUID    NOT NULL REFERENCES app.apps(id) ON DELETE CASCADE,
  key          TEXT    NOT NULL,
  value        TEXT    NOT NULL,
  is_secret    BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS app_env_vars_app_key_idx ON app.env_vars (app_id, key);

-- ---------------------------------------------------------------------------
-- app.roles — app-level RBAC roles
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS app.roles (
  id          UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id      UUID    NOT NULL REFERENCES app.apps(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  permissions JSONB   NOT NULL DEFAULT '[]',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS app_roles_app_name_idx ON app.roles (app_id, name);

-- ---------------------------------------------------------------------------
-- app.tenant_shares — cross-tenant sharing grants
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS app.tenant_shares (
  id                  UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id              UUID    NOT NULL REFERENCES app.apps(id) ON DELETE CASCADE,
  external_tenant_id  UUID    NOT NULL,
  mapped_roles        TEXT[]  NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by          UUID    NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS app_tenant_shares_app_tenant_idx
  ON app.tenant_shares (app_id, external_tenant_id);

-- ---------------------------------------------------------------------------
-- app.oauth_registrations — OAuth client records
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS app.oauth_registrations (
  id                 UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id             UUID    NOT NULL UNIQUE REFERENCES app.apps(id) ON DELETE CASCADE,
  client_id          TEXT    NOT NULL UNIQUE,
  client_secret_hash TEXT,
  access_mode        TEXT    NOT NULL CHECK (access_mode IN ('platform-user', 'public')),
  registered_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- app.user_storage — per-app per-user key/value storage
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS app.user_storage (
  id         UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id     UUID    NOT NULL REFERENCES app.apps(id) ON DELETE CASCADE,
  user_id    UUID    NOT NULL,
  key        TEXT    NOT NULL,
  value      JSONB   NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS app_user_storage_app_user_key_idx
  ON app.user_storage (app_id, user_id, key);

CREATE INDEX IF NOT EXISTS app_user_storage_app_user_idx
  ON app.user_storage (app_id, user_id);
