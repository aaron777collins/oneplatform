import { randomUUID } from "node:crypto";
import type pg from "pg";

/**
 * Creates a new unique tenant UUID for a test.
 */
export function newTenantId(): string {
  return randomUUID();
}

/**
 * Deletes all rows created by a test in the plugin schema.
 * Plugin has no RLS — tenant isolation relies on unique tenant UUIDs
 * and explicit cleanup here.
 *
 * Deletion order follows FK constraints (children before parents):
 *   hooks         → FK instance_id → instances, FK plugin_id → plugins
 *   instances     → FK plugin_id → plugins
 *   approved_urls → FK plugin_id → plugins
 *   plugins       → root (no tenant_id — platform-wide registry)
 *
 * Note: plugin.plugins is a platform-wide table with no tenant_id.
 * Tests that create plugins should use a deterministic manifest_id
 * incorporating tenantId so they can be cleaned up safely.
 * instances and hooks do have tenant_id.
 */
export async function cleanupPluginTenant(pool: pg.Pool, tenantId: string): Promise<void> {
  // hooks reference instances — delete before instances
  await pool.query("DELETE FROM plugin.hooks WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM plugin.instances WHERE tenant_id = $1", [tenantId]);
}
