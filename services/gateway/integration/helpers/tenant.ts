import { randomUUID } from "node:crypto";
import type pg from "pg";

/**
 * Creates a new unique tenant UUID for a test.
 */
export function newTenantId(): string {
  return randomUUID();
}

/**
 * Deletes all rows created by a test in the gateway schema.
 * Gateway webhooks FK to auth.tenants — the auth tenant must also be
 * cleaned up after these rows, or deleted before auth cleanup.
 *
 * Deletion order follows FK constraints:
 *   webhook_deliveries → FK webhook_id → webhooks
 *   rate_limit_config  → FK tenant_id → auth.tenants
 *   webhooks           → FK tenant_id → auth.tenants
 */
export async function cleanupGatewayTenant(pool: pg.Pool, tenantId: string): Promise<void> {
  await pool.query(
    `DELETE FROM gateway.webhook_deliveries
     WHERE webhook_id IN (
       SELECT id FROM gateway.webhooks WHERE tenant_id = $1
     )`,
    [tenantId],
  );
  await pool.query("DELETE FROM gateway.rate_limit_config WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM gateway.webhooks WHERE tenant_id = $1", [tenantId]);
}
