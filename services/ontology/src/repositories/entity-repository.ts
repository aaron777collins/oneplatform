import type pg from "pg";
import type { EntityRow, CreateEntityData, UpdateEntityData } from "./types.js";

export interface EntityRepository {
  create(data: CreateEntityData): Promise<EntityRow>;
  findByTenantId(tenantId: string, cursor?: string, limit?: number): Promise<EntityRow[]>;
  findBySlug(tenantId: string, slug: string): Promise<EntityRow | null>;
  findById(tenantId: string, id: string): Promise<EntityRow | null>;
  updateOptimistic(id: string, tenantId: string, expectedVersion: number, data: UpdateEntityData): Promise<EntityRow | null>;
  bumpVersion(id: string): Promise<EntityRow | null>;
  softDelete(id: string, tenantId: string): Promise<boolean>;
  countDataRows(schemaName: string, entitySlug: string): Promise<number>;
}

export function createEntityRepository(db: pg.Pool): EntityRepository {
  return {
    async create(data) {
      const result = await db.query<EntityRow>(
        `INSERT INTO ontology.entities (tenant_id, name, slug, description, is_public, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [data.tenant_id, data.name, data.slug, data.description ?? null, data.is_public ?? false, data.created_by],
      );
      return result.rows[0]!;
    },

    async findByTenantId(tenantId, cursor, limit = 50) {
      if (cursor) {
        const result = await db.query<EntityRow>(
          `SELECT * FROM ontology.entities
           WHERE tenant_id = $1 AND deleted_at IS NULL AND id > $2
           ORDER BY id LIMIT $3`,
          [tenantId, cursor, limit],
        );
        return result.rows;
      }
      const result = await db.query<EntityRow>(
        `SELECT * FROM ontology.entities
         WHERE tenant_id = $1 AND deleted_at IS NULL
         ORDER BY id LIMIT $2`,
        [tenantId, limit],
      );
      return result.rows;
    },

    async findBySlug(tenantId, slug) {
      const result = await db.query<EntityRow>(
        `SELECT * FROM ontology.entities
         WHERE tenant_id = $1 AND slug = $2 AND deleted_at IS NULL`,
        [tenantId, slug],
      );
      return result.rows[0] ?? null;
    },

    async findById(tenantId, id) {
      const result = await db.query<EntityRow>(
        `SELECT * FROM ontology.entities
         WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
        [tenantId, id],
      );
      return result.rows[0] ?? null;
    },

    async updateOptimistic(id, tenantId, expectedVersion, data) {
      const sets: string[] = ["updated_at = now()", "version = version + 1"];
      const values: unknown[] = [];
      let paramIdx = 1;

      if (data.name !== undefined) {
        values.push(data.name);
        sets.push(`name = $${paramIdx++}`);
      }
      if (data.description !== undefined) {
        values.push(data.description);
        sets.push(`description = $${paramIdx++}`);
      }
      if (data.is_public !== undefined) {
        values.push(data.is_public);
        sets.push(`is_public = $${paramIdx++}`);
      }

      values.push(id, tenantId, expectedVersion);
      const result = await db.query<EntityRow>(
        `UPDATE ontology.entities SET ${sets.join(", ")}
         WHERE id = $${paramIdx++} AND tenant_id = $${paramIdx++} AND version = $${paramIdx++} AND deleted_at IS NULL
         RETURNING *`,
        values,
      );
      return result.rows[0] ?? null;
    },

    async bumpVersion(id) {
      const result = await db.query<EntityRow>(
        `UPDATE ontology.entities SET version = version + 1, updated_at = now()
         WHERE id = $1 AND deleted_at IS NULL
         RETURNING *`,
        [id],
      );
      return result.rows[0] ?? null;
    },

    async softDelete(id, tenantId) {
      const result = await db.query(
        `UPDATE ontology.entities SET deleted_at = now(), updated_at = now()
         WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
        [id, tenantId],
      );
      return result.rowCount !== null && result.rowCount > 0;
    },

    async countDataRows(schemaName, entitySlug) {
      const result = await db.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM "${schemaName}"."${entitySlug}"`,
      );
      return parseInt(result.rows[0]!["count"], 10);
    },
  };
}
