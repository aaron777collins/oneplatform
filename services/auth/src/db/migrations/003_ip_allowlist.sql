-- Migration: 003_ip_allowlist
--
-- Add ip_allowlist JSONB columns to auth.tenants and auth.api_keys.
--
-- WHY JSONB for the allowlist (not TEXT[]):
--   - The values are CIDR strings (e.g. "192.168.0.0/24"), not opaque labels.
--     JSONB gives us a typed JSON array that is straightforward to read from
--     application code as string[], while still being indexable if needed.
--   - TEXT[] would also work, but JSONB aligns with how `settings` is stored
--     on auth.tenants and avoids the need for custom cast functions.
--
-- Default is an empty array which means "allow all" — security is opt-in.

ALTER TABLE auth.tenants
  ADD COLUMN IF NOT EXISTS ip_allowlist JSONB NOT NULL DEFAULT '[]';

ALTER TABLE auth.api_keys
  ADD COLUMN IF NOT EXISTS ip_allowlist JSONB NOT NULL DEFAULT '[]';

-- GIN index allows containment queries (e.g. @>) if we later need
-- "find all tenants that allow IP X". Optional but cheap to add now.
CREATE INDEX IF NOT EXISTS idx_tenants_ip_allowlist
  ON auth.tenants USING GIN (ip_allowlist)
  WHERE ip_allowlist != '[]';

CREATE INDEX IF NOT EXISTS idx_api_keys_ip_allowlist
  ON auth.api_keys USING GIN (ip_allowlist)
  WHERE ip_allowlist != '[]';
