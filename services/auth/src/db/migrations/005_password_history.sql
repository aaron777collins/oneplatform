-- migration: 005_password_history
--
-- Adds a password_history column to auth.users to store the last N bcrypt hashes.
-- On password change, the new hash is checked against this list and rejected if
-- it matches any of the last PASSWORD_HISTORY_DEPTH entries.
--
-- We use a TEXT[] array capped to PASSWORD_HISTORY_DEPTH entries (default 5).
-- Hashes are prepended (newest first) so trimming the tail is a simple slice.

ALTER TABLE auth.users
  ADD COLUMN IF NOT EXISTS password_history TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN auth.users.password_history IS
  'Last 5 bcrypt password hashes (newest-first). '
  'Checked on password change to prevent reuse within the history window.';
