-- Add soft-delete support to auth.tenants.
--
-- WHY soft delete instead of hard delete:
--   Users and all related records reference tenant_id. A hard delete with
--   ON DELETE CASCADE would permanently destroy user accounts, sessions, and
--   audit history. Soft delete preserves the audit trail and allows recovery
--   while preventing new activity (the deleted_at check is enforced at the
--   application layer on all tenant lookups).

ALTER TABLE auth.tenants
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_tenants_deleted_at ON auth.tenants (deleted_at)
  WHERE deleted_at IS NULL;
