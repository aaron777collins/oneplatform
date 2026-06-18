-- Migration: 004_tenant_branding
--
-- Add a `branding` JSONB column to auth.tenants to store per-tenant white-label
-- configuration: logo, favicon, colors, app name, support email, and custom CSS.
--
-- WHY JSONB (not individual columns):
--   - The branding fields are always read and written together — there is no
--     query that filters or indexes on individual color values. JSONB avoids
--     an ever-growing list of nullable columns for optional cosmetic settings.
--   - Aligns with how `settings` and `ip_allowlist` are stored on the same table.
--
-- Default is an empty object {} which means "use platform defaults".
-- The application layer (BrandingService.getBranding) fills in defaults at
-- read time rather than baking them into SQL so we can change defaults without
-- a migration.

ALTER TABLE auth.tenants
  ADD COLUMN IF NOT EXISTS branding JSONB NOT NULL DEFAULT '{}';
