import type pg from "pg";
import type { Role, CreateRoleData, UpdateRoleData } from "./types.js";

const ROLE_COLUMNS = `
  id, tenant_id, name, description, is_predefined,
  permissions, created_at, updated_at
`;

export class RoleRepository {
  constructor(private readonly pool: pg.Pool) {}

  // Returns both tenant-scoped roles and platform-level predefined roles
  // (where tenant_id IS NULL), since predefined roles are visible to all tenants.
  async findByTenantId(tenantId: string): Promise<Role[]> {
    const result = await this.pool.query<Role>(
      `SELECT ${ROLE_COLUMNS}
         FROM auth.roles
        WHERE tenant_id = $1
           OR tenant_id IS NULL
        ORDER BY is_predefined DESC, name ASC`,
      [tenantId]
    );
    return result.rows;
  }

  async findByName(tenantId: string, name: string): Promise<Role | null> {
    const result = await this.pool.query<Role>(
      `SELECT ${ROLE_COLUMNS}
         FROM auth.roles
        WHERE (tenant_id = $1 OR tenant_id IS NULL)
          AND name = $2`,
      [tenantId, name]
    );
    return result.rows[0] ?? null;
  }

  async create(data: CreateRoleData): Promise<Role> {
    const result = await this.pool.query<Role>(
      `INSERT INTO auth.roles
              (tenant_id, name, description, is_predefined, permissions)
            VALUES ($1, $2, $3, $4, $5)
         RETURNING ${ROLE_COLUMNS}`,
      [
        data.tenant_id,
        data.name,
        data.description ?? "",
        data.is_predefined ?? false,
        data.permissions ?? [],
      ]
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("INSERT INTO auth.roles returned no rows");
    }
    return row;
  }

  async update(id: string, data: UpdateRoleData): Promise<Role> {
    const sets: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (data.description !== undefined) {
      sets.push(`description = $${idx++}`);
      values.push(data.description);
    }
    if (data.permissions !== undefined) {
      sets.push(`permissions = $${idx++}`);
      values.push(data.permissions);
    }

    if (sets.length === 0) {
      throw new Error("update() called with no fields to update for role " + id);
    }

    sets.push(`updated_at = now()`);
    values.push(id);

    const result = await this.pool.query<Role>(
      `UPDATE auth.roles
            SET ${sets.join(", ")}
          WHERE id           = $${idx}
            AND is_predefined = false
      RETURNING ${ROLE_COLUMNS}`,
      values
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(
        `UPDATE auth.roles found no updatable row with id=${id} (row may not exist or is predefined)`
      );
    }
    return row;
  }
}
