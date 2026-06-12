import { randomUUID } from "node:crypto";
import type pg from "pg";

/**
 * Creates a new unique tenant UUID for a test.
 */
export function newTenantId(): string {
  return randomUUID();
}

/**
 * Deletes all rows created by a test in the ingestion schema.
 * Deletion order follows FK constraints (children before parents):
 *   credentials → via connector_id FK
 *   sync_state  → via connector_id FK
 *   batch_errors (no FK to connectors but references connector_id)
 *   upload_jobs → via tenant_id (connector FK is nullable)
 *   webhook_receivers → via tenant_id
 *   connectors → via tenant_id (parent)
 *
 * Ingestion has RLS — the op_test SUPERUSER bypasses it for cleanup.
 */
export async function cleanupIngestionTenant(pool: pg.Pool, tenantId: string): Promise<void> {
  // batch_errors reference connector_id — delete before connectors
  await pool.query(
    `DELETE FROM ingestion.batch_errors
     WHERE connector_id IN (
       SELECT id FROM ingestion.connectors WHERE tenant_id = $1
     )`,
    [tenantId],
  );
  // credentials cascade-delete with connectors but explicit delete avoids surprise
  await pool.query(
    `DELETE FROM ingestion.credentials
     WHERE connector_id IN (
       SELECT id FROM ingestion.connectors WHERE tenant_id = $1
     )`,
    [tenantId],
  );
  // sync_state has a PK that is also the FK — cascades but explicit is safer
  await pool.query(
    `DELETE FROM ingestion.sync_state
     WHERE connector_id IN (
       SELECT id FROM ingestion.connectors WHERE tenant_id = $1
     )`,
    [tenantId],
  );
  await pool.query("DELETE FROM ingestion.upload_jobs WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM ingestion.webhook_receivers WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM ingestion.connectors WHERE tenant_id = $1", [tenantId]);
}
