-- migration: 006_dev_seed
--
-- Upserts a known dev admin user so the dev-test stack always has working
-- credentials after a docker-compose rebuild, even when the postgres-data
-- volume is wiped.
--
-- WHY this is here and not in a separate script:
--   The auth migration runner executes every file in this directory in
--   lexicographic order on service startup, inside a transaction per file.
--   Putting the seed here guarantees it runs before any service accepts
--   traffic, on every fresh database — no manual post-start step required.
--
-- SECURITY:
--   The bcrypt hash below was generated with cost factor 12 and is valid only
--   for the password "DevPassword123!". Any deployment that wipes volumes and
--   re-bootstraps receives this well-known hash. Never run this migration in
--   a production environment. This file should be excluded from the production
--   compose image (or removed from the migration directory before production
--   deployment).
--
-- IDEMPOTENCY:
--   - The tenant INSERT uses ON CONFLICT DO NOTHING so re-running is safe.
--   - The user INSERT uses ON CONFLICT (tenant_id, email) DO UPDATE so the
--     password hash and account state are always reset to the known values.
--   - The user is placed into the first (or only) tenant that already exists
--     from bootstrap; a dev-corp tenant is created only on a completely fresh
--     database where no tenant exists yet. This prevents adding a spurious
--     second tenant on existing live instances and breaking the single-tenant
--     auto-resolve in the login route.

DO $$
DECLARE
  v_tenant_id UUID;
  v_dev_email TEXT := 'aaron777collins@gmail.com';
  -- bcrypt hash of 'DevPassword123!' at cost factor 12.
  -- Regenerate with: node -e "require('bcrypt').hash('DevPassword123!',12).then(console.log)"
  v_dev_hash  TEXT := '$2b$12$cHqkFZrByKAFTyttgki99Odald4hQKCiLvPfdunFEjOsIzPL0rpHC';
BEGIN
  -- 1. Use the tenant created during bootstrap if one exists; otherwise create
  --    a dev tenant. This keeps the tenant count at 1 on all paths so the
  --    login route's single-tenant auto-resolve (no tenantId in POST body)
  --    continues to work correctly.
  SELECT id INTO v_tenant_id FROM auth.tenants ORDER BY created_at LIMIT 1;

  IF v_tenant_id IS NULL THEN
    -- Fresh database — no bootstrap tenant yet. Create one now so the user
    -- has somewhere to live. Slug 'dev-corp' satisfies the regex constraint.
    INSERT INTO auth.tenants (name, slug)
    VALUES ('Dev Corp', 'dev-corp')
    ON CONFLICT (slug) DO NOTHING;

    SELECT id INTO v_tenant_id FROM auth.tenants WHERE slug = 'dev-corp';
  END IF;

  -- 2. Upsert the dev admin user with the known bcrypt hash.
  --    ON CONFLICT DO UPDATE resets password_hash and account state on every
  --    run so credentials are always predictable after a rebuild.
  INSERT INTO auth.users (
    tenant_id,
    email,
    password_hash,
    email_verified,
    is_active,
    roles,
    failed_login_count,
    locked_until,
    password_history
  )
  VALUES (
    v_tenant_id,
    v_dev_email,
    v_dev_hash,
    true,              -- pre-verified, no email round-trip in dev
    true,
    ARRAY['platform-admin'],
    0,
    NULL,
    '{}'::TEXT[]
  )
  ON CONFLICT (tenant_id, email) DO UPDATE
    SET password_hash       = EXCLUDED.password_hash,
        email_verified      = true,
        is_active           = true,
        roles               = ARRAY['platform-admin'],
        failed_login_count  = 0,
        locked_until        = NULL,
        password_history    = '{}'::TEXT[];

  -- 3. Mark bootstrap complete (only on fresh databases where it isn't yet).
  --    Records the admin user and tenant in bootstrap_state so the API
  --    bootstrap endpoint is permanently disabled.
  UPDATE auth.bootstrap_state
  SET bootstrap_completed = true,
      completed_at        = COALESCE(completed_at, now()),
      admin_user_id       = COALESCE(
                              admin_user_id,
                              (SELECT id FROM auth.users WHERE tenant_id = v_tenant_id AND email = v_dev_email)
                            ),
      first_tenant_id     = COALESCE(first_tenant_id, v_tenant_id)
  WHERE id = 1
    AND bootstrap_completed = false;

END $$;
