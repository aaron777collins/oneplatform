-- ============================================================
-- Plugin Service initial schema
-- All tables reside in the `plugin` PostgreSQL schema.
-- The service connects via PgBouncer in transaction mode (ADR-5).
-- ============================================================

CREATE SCHEMA IF NOT EXISTS plugin;

-- ============================================================
-- plugin.plugins
-- Platform-wide installation record. One row per (id, version).
-- active_version_id is the pointer that the service resolves.
-- ============================================================
CREATE TABLE IF NOT EXISTS plugin.plugins (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Stable identity key from manifest. e.g. "com.example.shopify-connector"
    manifest_id         TEXT        NOT NULL,
    name                TEXT        NOT NULL,
    version             TEXT        NOT NULL,
    type                TEXT        NOT NULL
                        CHECK (type IN (
                            'connector','transformer','destination',
                            'auth-provider','widget'
                        )),

    status              TEXT        NOT NULL DEFAULT 'installed'
                        CHECK (status IN (
                            'installed','active','staged',
                            'draining','disabled','uninstalled'
                        )),

    bundle_bucket       TEXT        NOT NULL,
    bundle_key          TEXT,
    manifest            JSONB       NOT NULL,
    is_platform_wide    BOOLEAN     NOT NULL DEFAULT FALSE,
    gpg_fingerprint     TEXT,

    installed_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    installed_by        UUID        NOT NULL,
    uninstalled_at      TIMESTAMPTZ,
    bundle_delete_after TIMESTAMPTZ,

    CONSTRAINT plugins_manifest_version_unique UNIQUE (manifest_id, version)
);

-- Active-version pointer lookup (most frequent query path)
CREATE UNIQUE INDEX IF NOT EXISTS idx_plugins_active_per_manifest
    ON plugin.plugins (manifest_id)
    WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_plugins_name ON plugin.plugins USING GIN (to_tsvector('english', name));
CREATE INDEX IF NOT EXISTS idx_plugins_status ON plugin.plugins (status);
CREATE INDEX IF NOT EXISTS idx_plugins_type ON plugin.plugins (type);
CREATE INDEX IF NOT EXISTS idx_plugins_bundle_delete ON plugin.plugins (bundle_delete_after)
    WHERE bundle_delete_after IS NOT NULL;


-- ============================================================
-- plugin.instances
-- Per-tenant enablement of a plugin.
-- ============================================================
CREATE TABLE IF NOT EXISTS plugin.instances (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    plugin_manifest_id  TEXT        NOT NULL,
    plugin_id           UUID        NOT NULL REFERENCES plugin.plugins(id),

    tenant_id           UUID        NOT NULL,
    display_name        TEXT        NOT NULL,
    config              JSONB       NOT NULL DEFAULT '{}',

    enabled             TEXT        NOT NULL DEFAULT 'disabled'
                        CHECK (enabled IN ('enabled','disabling','disabled')),

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by          UUID        NOT NULL,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by          UUID,
    deleted_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_instances_plugin ON plugin.instances (plugin_manifest_id);
CREATE INDEX IF NOT EXISTS idx_instances_tenant ON plugin.instances (tenant_id);
CREATE INDEX IF NOT EXISTS idx_instances_enabled ON plugin.instances (enabled) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_instances_tenant_plugin ON plugin.instances (tenant_id, plugin_manifest_id)
    WHERE deleted_at IS NULL;


-- ============================================================
-- plugin.hooks
-- One row per hook declaration per instance.
-- ============================================================
CREATE TABLE IF NOT EXISTS plugin.hooks (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    plugin_id           UUID        NOT NULL REFERENCES plugin.plugins(id),
    instance_id         UUID        NOT NULL REFERENCES plugin.instances(id),
    tenant_id           UUID        NOT NULL,

    stage               TEXT        NOT NULL,
    criticality         TEXT        NOT NULL
                        CHECK (criticality IN ('critical','advisory')),

    priority            INTEGER     NOT NULL DEFAULT 100
                        CHECK (priority BETWEEN 0 AND 999),

    timeout_seconds     INTEGER     NOT NULL DEFAULT 30
                        CHECK (timeout_seconds BETWEEN 1 AND 300),

    entrypoint          TEXT        NOT NULL,

    state               TEXT        NOT NULL DEFAULT 'inactive'
                        CHECK (state IN ('inactive','active','staged','disabled')),

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hooks_stage_tenant_active
    ON plugin.hooks (stage, tenant_id)
    WHERE state = 'active';

CREATE INDEX IF NOT EXISTS idx_hooks_plugin_state
    ON plugin.hooks (plugin_id, state);

CREATE INDEX IF NOT EXISTS idx_hooks_instance ON plugin.hooks (instance_id);


-- ============================================================
-- plugin.approved_urls
-- Per-installation URL patterns explicitly approved by a platform admin.
-- ============================================================
CREATE TABLE IF NOT EXISTS plugin.approved_urls (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    plugin_id           UUID        NOT NULL REFERENCES plugin.plugins(id),
    url_pattern         TEXT        NOT NULL,
    approved_by         UUID        NOT NULL,
    approved_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT approved_urls_plugin_pattern_unique UNIQUE (plugin_id, url_pattern)
);

CREATE INDEX IF NOT EXISTS idx_approved_urls_plugin ON plugin.approved_urls (plugin_id);
