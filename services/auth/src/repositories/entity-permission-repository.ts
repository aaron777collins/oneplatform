import type pg from "pg";
import type { EntityPermission } from "./types.js";

const ENTITY_PERMISSION_COLUMNS = `
  id, tenant_id, entity_type, role, actions,
  field_restrictions, row_filter, created_at, updated_at
`;

export class EntityPermissionRepository {
  constructor(private readonly pool: pg.Pool) {}

  // Returns all permission rules for a given tenant + entity type, including
  // wildcard rules (entity_type = '*') which apply to all entities.
  async findByTenantAndEntity(
    tenantId: string,
    entityType: string
  ): Promise<EntityPermission[]> {
    const result = await this.pool.query<EntityPermission>(
      `SELECT ${ENTITY_PERMISSION_COLUMNS}
         FROM auth.entity_permissions
        WHERE tenant_id   = $1
          AND (entity_type = $2 OR entity_type = '*')
        ORDER BY entity_type ASC, role ASC`,
      [tenantId, entityType]
    );
    return result.rows;
  }
}
