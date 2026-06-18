-- App Service embed token schema — G-071
-- Stores issued embed tokens so they can be listed and revoked.
-- Tokens are signed JWTs; this table is the revocation / metadata store.
-- Design: token payload carries all policy; the table is the source of truth
-- for revocation status and audit listing only.

CREATE TABLE IF NOT EXISTS app.embed_tokens (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id           UUID        NOT NULL REFERENCES app.apps(id) ON DELETE CASCADE,
  tenant_id        UUID        NOT NULL,
  -- Comma-separated list is avoided here; jsonb keeps the allowedOrigins policy
  -- structured so queries can validate membership without string splitting.
  allowed_origins  JSONB       NOT NULL DEFAULT '[]',
  permissions      TEXT        NOT NULL DEFAULT 'read'
                               CHECK (permissions IN ('read', 'read-write')),
  expires_at       TIMESTAMPTZ NOT NULL,
  revoked_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by       UUID        NOT NULL
);

-- Fast lookup by app + tenant when listing active tokens.
CREATE INDEX IF NOT EXISTS embed_tokens_app_tenant_idx
  ON app.embed_tokens (app_id, tenant_id)
  WHERE revoked_at IS NULL;

-- Fast revocation lookup by token id — used on every embed request.
CREATE INDEX IF NOT EXISTS embed_tokens_id_revoked_idx
  ON app.embed_tokens (id)
  WHERE revoked_at IS NULL;
