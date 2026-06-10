import type pg from "pg";
import type { ShadowRegistryRow, CreateShadowRegistryData } from "./types.js";

export interface ShadowRegistryRepository {
  create(data: CreateShadowRegistryData, client?: pg.PoolClient): Promise<ShadowRegistryRow>;
  findByMigrationId(migrationId: string): Promise<ShadowRegistryRow[]>;
  findActiveOrphans(olderThanHours: number): Promise<ShadowRegistryRow[]>;
  findUnregisteredShadowTables(olderThanHours: number): Promise<Array<{ table_schema: string; table_name: string }>>;
  updateStatus(id: string, status: string): Promise<boolean>;
}

export function createShadowRegistryRepository(db: pg.Pool): ShadowRegistryRepository {
  return {
    async create(data, client) {
      const queryFn = client ?? db;
      const result = await queryFn.query<ShadowRegistryRow>(
        `INSERT INTO ontology.shadow_table_registry
         (migration_id, entity_type, batch_id, table_name, schema_name, row_count, batch_index)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          data.migration_id, data.entity_type, data.batch_id,
          data.table_name, data.schema_name, data.row_count, data.batch_index,
        ],
      );
      return result.rows[0]!;
    },

    async findByMigrationId(migrationId) {
      const result = await db.query<ShadowRegistryRow>(
        `SELECT * FROM ontology.shadow_table_registry
         WHERE migration_id = $1
         ORDER BY batch_index`,
        [migrationId],
      );
      return result.rows;
    },

    async findActiveOrphans(olderThanHours) {
      const result = await db.query<ShadowRegistryRow>(
        `SELECT sr.* FROM ontology.shadow_table_registry sr
         LEFT JOIN ontology.migrations m ON sr.migration_id = m.id
         WHERE sr.status = 'active'
           AND sr.created_at < now() - make_interval(hours => $1)
           AND (m.status NOT IN ('running', 'confirmed') OR m.id IS NULL)`,
        [olderThanHours],
      );
      return result.rows;
    },

    async findUnregisteredShadowTables(olderThanHours) {
      const result = await db.query<{ table_schema: string; table_name: string }>(
        `SELECT t.table_schema, t.table_name
         FROM information_schema.tables t
         WHERE t.table_name ~ '^shadow_[a-z][a-z0-9_]*_[a-z0-9]+$'
           AND t.table_schema LIKE 'tenant_%'
           AND NOT EXISTS (
             SELECT 1 FROM ontology.shadow_table_registry sr
             WHERE sr.schema_name = t.table_schema AND sr.table_name = t.table_name
           )`,
      );
      return result.rows;
    },

    async updateStatus(id, status) {
      const result = await db.query(
        `UPDATE ontology.shadow_table_registry SET status = $1 WHERE id = $2`,
        [status, id],
      );
      return result.rowCount !== null && result.rowCount > 0;
    },
  };
}
