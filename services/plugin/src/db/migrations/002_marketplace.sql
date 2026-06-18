-- ============================================================
-- Plugin Marketplace schema
-- Extends the plugin schema with a community registry.
-- All tables reside in the `plugin` PostgreSQL schema.
-- ============================================================

-- ============================================================
-- plugin.marketplace_plugins
-- Community registry entries. Each row is a published plugin.
-- A plugin may be published independently from installation —
-- publishing registers it in the browseable catalog, while
-- installation (plugin.plugins) tracks tenant-level deployment.
-- ============================================================
CREATE TABLE IF NOT EXISTS plugin.marketplace_plugins (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Must match PluginManifest.id format (reverse-domain).
    name            TEXT        NOT NULL UNIQUE,

    display_name    TEXT        NOT NULL,
    description     TEXT        NOT NULL,
    version         TEXT        NOT NULL,

    type            TEXT        NOT NULL
                    CHECK (type IN (
                        'connector','transformer','destination',
                        'auth-provider','custom'
                    )),

    author_name     TEXT        NOT NULL,
    author_email    TEXT,

    category        TEXT        NOT NULL DEFAULT 'other',

    -- JSON array of tag strings, indexed for GIN queries.
    tags            JSONB       NOT NULL DEFAULT '[]',

    -- Manifest stored verbatim for schema validation / install flow.
    manifest        JSONB       NOT NULL,

    -- Cumulative install count — incremented by the install route.
    downloads       BIGINT      NOT NULL DEFAULT 0
                    CHECK (downloads >= 0),

    -- Denormalised average & count, updated on every rating upsert.
    -- Computing these inline avoids an aggregate join on every list query.
    rating_average  NUMERIC(3,2) NOT NULL DEFAULT 0
                    CHECK (rating_average >= 0 AND rating_average <= 5),
    rating_count    INTEGER      NOT NULL DEFAULT 0
                    CHECK (rating_count >= 0),

    -- Verified badge is granted by platform admins only.
    verified        BOOLEAN     NOT NULL DEFAULT FALSE,

    published_by    UUID        NOT NULL,
    published_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Full-text search on name + description using a generated tsvector column.
-- The stored tsvector is updated automatically via trigger, making FTS lookups
-- a simple index scan rather than an on-the-fly to_tsvector() call.
ALTER TABLE plugin.marketplace_plugins
    ADD COLUMN IF NOT EXISTS search_vector TSVECTOR
    GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(display_name, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(description, '')), 'B') ||
        setweight(to_tsvector('english', coalesce(name, '')), 'C')
    ) STORED;

CREATE INDEX IF NOT EXISTS idx_marketplace_search
    ON plugin.marketplace_plugins USING GIN (search_vector);

CREATE INDEX IF NOT EXISTS idx_marketplace_type
    ON plugin.marketplace_plugins (type);

CREATE INDEX IF NOT EXISTS idx_marketplace_category
    ON plugin.marketplace_plugins (category);

CREATE INDEX IF NOT EXISTS idx_marketplace_downloads
    ON plugin.marketplace_plugins (downloads DESC);

CREATE INDEX IF NOT EXISTS idx_marketplace_rating
    ON plugin.marketplace_plugins (rating_average DESC);

CREATE INDEX IF NOT EXISTS idx_marketplace_published_at
    ON plugin.marketplace_plugins (published_at DESC);

CREATE INDEX IF NOT EXISTS idx_marketplace_tags
    ON plugin.marketplace_plugins USING GIN (tags);


-- ============================================================
-- plugin.plugin_ratings
-- One row per (user, marketplace_plugin). Upsert semantics —
-- a user can change their rating but not submit multiple rows.
-- ============================================================
CREATE TABLE IF NOT EXISTS plugin.plugin_ratings (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

    marketplace_plugin_id UUID      NOT NULL
                        REFERENCES plugin.marketplace_plugins(id)
                        ON DELETE CASCADE,

    user_id             UUID        NOT NULL,

    -- 1–5 integer stars, enforced by CHECK.
    rating              SMALLINT    NOT NULL
                        CHECK (rating BETWEEN 1 AND 5),

    review              TEXT,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- One rating per user per plugin.
    CONSTRAINT plugin_ratings_user_plugin_unique
        UNIQUE (marketplace_plugin_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_ratings_plugin
    ON plugin.plugin_ratings (marketplace_plugin_id);

CREATE INDEX IF NOT EXISTS idx_ratings_user
    ON plugin.plugin_ratings (user_id);
