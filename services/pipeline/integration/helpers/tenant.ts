import { randomUUID } from "node:crypto";
import type pg from "pg";

/**
 * Creates a new unique tenant UUID for a test.
 */
export function newTenantId(): string {
  return randomUUID();
}

/**
 * Deletes all rows created by a test in the pipeline schema.
 * Pipeline has RLS — the op_test SUPERUSER bypasses it for cleanup.
 *
 * Deletion order follows FK constraints (children before parents):
 *   run_logs   → FK run_id → runs
 *   run_steps  → FK run_id → runs
 *   runs       → FK pipeline_id → pipelines
 *   schedules  → FK pipeline_id → pipelines
 *   triggers   → FK pipeline_id → pipelines
 *   pipelines  → root
 */
export async function cleanupPipelineTenant(pool: pg.Pool, tenantId: string): Promise<void> {
  await pool.query("DELETE FROM pipeline.run_logs WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM pipeline.run_steps WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM pipeline.runs WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM pipeline.schedules WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM pipeline.triggers WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM pipeline.pipelines WHERE tenant_id = $1", [tenantId]);
}
