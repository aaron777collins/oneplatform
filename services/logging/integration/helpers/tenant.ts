import { randomUUID } from "node:crypto";
import type pg from "pg";

/**
 * Creates a new unique tenant UUID for a test.
 * For logging, the tenant_id column in audit_events is TEXT (not UUID),
 * so the UUID string is used directly.
 */
export function newTenantId(): string {
  return randomUUID();
}

/**
 * Deletes all rows created by a test in the logging schema.
 *
 * logging.events is a partitioned table — DELETE with a WHERE clause on
 * service works fine across partitions but tests use service name as the
 * scope identifier since logging.events has no tenant_id column.
 * logging.audit_events has a tenant_id column (TEXT).
 *
 * For test isolation, tests should use a unique service name or trace_id
 * prefix derived from the tenantId when writing log events.
 */
export async function cleanupLoggingTenant(pool: pg.Pool, tenantId: string): Promise<void> {
  // audit_events has tenant_id as TEXT — use it directly
  await pool.query("DELETE FROM logging.audit_events WHERE tenant_id = $1", [tenantId]);
  // events has no tenant_id; tests must scope by trace_id or message prefix
  // Use the tenantId as a trace_id prefix to identify test-created rows
  await pool.query("DELETE FROM logging.events WHERE trace_id = $1", [tenantId]);
}
