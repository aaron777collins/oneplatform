import { randomUUID } from "node:crypto";
import type pg from "pg";

/**
 * Creates a new unique tenant UUID for a test.
 * Each test case must call this once and pass the returned tenantId
 * to all API calls and fixture builders.
 */
export function newTenantId(): string {
  return randomUUID();
}

/**
 * Deletes all rows created by a test in the auth schema.
 * Call in afterAll with the test's tenantId.
 *
 * Deletion order follows FK constraints:
 *   entity_permissions → api_keys → oauth_clients → roles → users → tenants
 *
 * The pool uses SUPERUSER credentials (op_test) so these deletes bypass RLS
 * without needing to set app.tenant_id or app.bypass_rls.
 */
export async function cleanupAuthTenant(pool: pg.Pool, tenantId: string): Promise<void> {
  await pool.query("DELETE FROM auth.entity_permissions WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM auth.api_keys WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM auth.oauth_clients WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM auth.roles WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM auth.users WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM auth.tenants WHERE id = $1", [tenantId]);
}
