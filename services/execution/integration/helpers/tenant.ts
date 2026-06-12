import { randomUUID } from "node:crypto";
import type pg from "pg";

/**
 * Creates a new unique tenant UUID for a test.
 */
export function newTenantId(): string {
  return randomUUID();
}

/**
 * Deletes all rows created by a test in the execution schema.
 * Execution tables are RANGE-partitioned by started_at but tenant_id-filtered
 * DELETEs work correctly across all partitions.
 *
 * Deletion order follows FK constraints:
 *   execution_logs → FK (execution_id, execution_started_at) → executions
 *   executions     → root (partitioned table)
 */
export async function cleanupExecutionTenant(pool: pg.Pool, tenantId: string): Promise<void> {
  await pool.query("DELETE FROM execution.execution_logs WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM execution.executions WHERE tenant_id = $1", [tenantId]);
}
