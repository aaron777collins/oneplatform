import { randomUUID } from "node:crypto";
import type pg from "pg";

/**
 * Creates a new unique tenant UUID for a test.
 */
export function newTenantId(): string {
  return randomUUID();
}

/**
 * Deletes all rows created by a test in the app schema.
 * App has no RLS — tenant isolation relies on unique tenant UUIDs
 * and explicit cleanup here.
 *
 * Deletion order follows FK constraints (children before parents):
 *   user_storage        → FK app_id → apps
 *   oauth_registrations → FK app_id → apps
 *   tenant_shares       → FK app_id → apps
 *   app.roles           → FK app_id → apps
 *   env_vars            → FK app_id → apps
 *   files               → FK app_id → apps
 *   builds              → FK app_id → apps (also sets current_build_id NULL on cascade)
 *   apps                → root
 */
export async function cleanupAppTenant(pool: pg.Pool, tenantId: string): Promise<void> {
  await pool.query(
    `DELETE FROM app.user_storage
     WHERE app_id IN (SELECT id FROM app.apps WHERE tenant_id = $1)`,
    [tenantId],
  );
  await pool.query(
    `DELETE FROM app.oauth_registrations
     WHERE app_id IN (SELECT id FROM app.apps WHERE tenant_id = $1)`,
    [tenantId],
  );
  await pool.query(
    `DELETE FROM app.tenant_shares
     WHERE app_id IN (SELECT id FROM app.apps WHERE tenant_id = $1)`,
    [tenantId],
  );
  await pool.query(
    `DELETE FROM app.roles
     WHERE app_id IN (SELECT id FROM app.apps WHERE tenant_id = $1)`,
    [tenantId],
  );
  await pool.query(
    `DELETE FROM app.env_vars
     WHERE app_id IN (SELECT id FROM app.apps WHERE tenant_id = $1)`,
    [tenantId],
  );
  await pool.query(
    `DELETE FROM app.files
     WHERE app_id IN (SELECT id FROM app.apps WHERE tenant_id = $1)`,
    [tenantId],
  );
  // Null out current_build_id before deleting builds to avoid FK cycle
  await pool.query(
    "UPDATE app.apps SET current_build_id = NULL WHERE tenant_id = $1",
    [tenantId],
  );
  await pool.query(
    `DELETE FROM app.builds
     WHERE app_id IN (SELECT id FROM app.apps WHERE tenant_id = $1)`,
    [tenantId],
  );
  await pool.query("DELETE FROM app.apps WHERE tenant_id = $1", [tenantId]);
}
