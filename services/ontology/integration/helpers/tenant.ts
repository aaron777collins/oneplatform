import { randomUUID } from "node:crypto";
import type pg from "pg";

/**
 * Creates a new unique tenant UUID for a test.
 */
export function newTenantId(): string {
  return randomUUID();
}

/**
 * Deletes all rows created by a test in the ontology schema.
 * Ontology has no RLS — tenant isolation in tests relies on unique tenant UUIDs
 * and explicit cleanup here.
 *
 * Deletion order follows FK constraints (children before parents):
 *   shadow_table_registry → migrations
 *   mapping_errors, draft_ontologies (no FK children)
 *   mapping_rules → fields → entities
 *   relationships (FK to entities, deleted with entities via CASCADE but
 *     explicit delete avoids FK violation when entities are removed first)
 */
export async function cleanupOntologyTenant(pool: pg.Pool, tenantId: string): Promise<void> {
  // Shadow registry references migrations — delete first
  await pool.query(
    `DELETE FROM ontology.shadow_table_registry
     WHERE migration_id IN (
       SELECT id FROM ontology.migrations WHERE tenant_id = $1
     )`,
    [tenantId],
  );
  await pool.query("DELETE FROM ontology.migrations WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM ontology.mapping_errors WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM ontology.draft_ontologies WHERE tenant_id = $1", [tenantId]);
  // mapping_rules reference entities and fields — delete before fields/entities
  await pool.query("DELETE FROM ontology.mapping_rules WHERE tenant_id = $1", [tenantId]);
  // relationships reference entities — delete before entities
  await pool.query("DELETE FROM ontology.relationships WHERE tenant_id = $1", [tenantId]);
  // fields cascade-delete with entities but explicit delete is clearer
  await pool.query("DELETE FROM ontology.fields WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM ontology.entities WHERE tenant_id = $1", [tenantId]);
}
