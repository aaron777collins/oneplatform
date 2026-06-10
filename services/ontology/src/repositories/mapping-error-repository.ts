import type pg from "pg";
import type { MappingErrorRow, CreateMappingErrorData } from "./types.js";

export interface MappingErrorRepository {
  create(data: CreateMappingErrorData, client?: pg.PoolClient): Promise<MappingErrorRow>;
  createMany(errors: CreateMappingErrorData[], client?: pg.PoolClient): Promise<number>;
  findByConnectorId(connectorId: string, cursor?: string, limit?: number): Promise<MappingErrorRow[]>;
  findByBatchId(batchId: string): Promise<MappingErrorRow[]>;
  deleteOlderThan(days: number): Promise<number>;
}

export function createMappingErrorRepository(db: pg.Pool): MappingErrorRepository {
  return {
    async create(data, client) {
      const queryFn = client ?? db;
      const result = await queryFn.query<MappingErrorRow>(
        `INSERT INTO ontology.mapping_errors
         (tenant_id, connector_id, batch_id, raw_id, entity_type,
          error_fields, error_details, raw_data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          data.tenant_id, data.connector_id, data.batch_id, data.raw_id,
          data.entity_type, data.error_fields,
          JSON.stringify(data.error_details), JSON.stringify(data.raw_data),
        ],
      );
      return result.rows[0]!;
    },

    async createMany(errors, client) {
      if (errors.length === 0) return 0;

      const queryFn = client ?? db;
      const placeholders: string[] = [];
      const values: unknown[] = [];
      let idx = 1;

      for (const e of errors) {
        placeholders.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`);
        values.push(
          e.tenant_id, e.connector_id, e.batch_id, e.raw_id,
          e.entity_type, e.error_fields,
          JSON.stringify(e.error_details), JSON.stringify(e.raw_data),
        );
      }

      const result = await queryFn.query(
        `INSERT INTO ontology.mapping_errors
         (tenant_id, connector_id, batch_id, raw_id, entity_type,
          error_fields, error_details, raw_data)
         VALUES ${placeholders.join(", ")}`,
        values,
      );
      return result.rowCount ?? 0;
    },

    async findByConnectorId(connectorId, cursor, limit = 50) {
      if (cursor) {
        const result = await db.query<MappingErrorRow>(
          `SELECT * FROM ontology.mapping_errors
           WHERE connector_id = $1 AND id < $2
           ORDER BY created_at DESC LIMIT $3`,
          [connectorId, cursor, limit],
        );
        return result.rows;
      }
      const result = await db.query<MappingErrorRow>(
        `SELECT * FROM ontology.mapping_errors
         WHERE connector_id = $1
         ORDER BY created_at DESC LIMIT $2`,
        [connectorId, limit],
      );
      return result.rows;
    },

    async findByBatchId(batchId) {
      const result = await db.query<MappingErrorRow>(
        `SELECT * FROM ontology.mapping_errors WHERE batch_id = $1 ORDER BY created_at`,
        [batchId],
      );
      return result.rows;
    },

    async deleteOlderThan(days) {
      const result = await db.query(
        `DELETE FROM ontology.mapping_errors WHERE created_at < now() - make_interval(days => $1)`,
        [days],
      );
      return result.rowCount ?? 0;
    },
  };
}
