-- App version control — G-072
-- Stores immutable snapshots of the VFS at a point in time so developers can
-- browse history, diff versions, and restore to any prior state.
--
-- version_number is auto-incremented per-app using a sequence-on-insert
-- pattern: MAX(version_number) + 1 inside the INSERT, protected by the unique
-- constraint so concurrent inserts are serialised without a separate counter
-- table.
--
-- files_snapshot holds the full VFS as JSONB (path → content map) so a version
-- is self-contained and can be restored without any additional file queries.
-- Maximum 100 versions per app — the oldest is pruned by the service layer
-- after each insert (not enforced here as a DB constraint so we avoid a
-- trigger and keep the pruning logic in application code where it is testable).

CREATE TABLE IF NOT EXISTS app.app_versions (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id          UUID        NOT NULL REFERENCES app.apps(id) ON DELETE CASCADE,
  version_number  INTEGER     NOT NULL,
  -- Full VFS snapshot: {"path": "content", ...}
  files_snapshot  JSONB       NOT NULL DEFAULT '{}',
  message         TEXT,
  created_by      UUID        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Uniqueness + fast lookup by (app_id, version_number)
CREATE UNIQUE INDEX IF NOT EXISTS app_versions_app_version_idx
  ON app.app_versions (app_id, version_number);

-- Most-recent-first listing
CREATE INDEX IF NOT EXISTS app_versions_app_created_idx
  ON app.app_versions (app_id, created_at DESC);
