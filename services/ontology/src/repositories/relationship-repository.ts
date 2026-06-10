import type pg from "pg";
import type { RelationshipRow, CreateRelationshipData } from "./types.js";

export interface RelationshipRepository {
  create(data: CreateRelationshipData, client?: pg.PoolClient): Promise<RelationshipRow>;
  findByEntityId(entityId: string): Promise<RelationshipRow[]>;
  findById(id: string): Promise<RelationshipRow | null>;
  findByFromEntityAndField(fromEntityId: string, fromFieldName: string): Promise<RelationshipRow | null>;
  delete(id: string): Promise<boolean>;
  deleteByEntityId(entityId: string): Promise<number>;
}

export function createRelationshipRepository(db: pg.Pool): RelationshipRepository {
  return {
    async create(data, client) {
      const queryFn = client ?? db;
      const result = await queryFn.query<RelationshipRow>(
        `INSERT INTO ontology.relationships
         (tenant_id, from_entity_id, to_entity_id, relationship_type,
          from_field_name, to_field_name, join_table_name, cascade_delete)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          data.tenant_id, data.from_entity_id, data.to_entity_id,
          data.relationship_type, data.from_field_name,
          data.to_field_name ?? null, data.join_table_name ?? null,
          data.cascade_delete ?? false,
        ],
      );
      return result.rows[0]!;
    },

    async findByEntityId(entityId) {
      const result = await db.query<RelationshipRow>(
        `SELECT * FROM ontology.relationships
         WHERE from_entity_id = $1 OR to_entity_id = $1
         ORDER BY created_at`,
        [entityId],
      );
      return result.rows;
    },

    async findById(id) {
      const result = await db.query<RelationshipRow>(
        `SELECT * FROM ontology.relationships WHERE id = $1`,
        [id],
      );
      return result.rows[0] ?? null;
    },

    async findByFromEntityAndField(fromEntityId, fromFieldName) {
      const result = await db.query<RelationshipRow>(
        `SELECT * FROM ontology.relationships
         WHERE from_entity_id = $1 AND from_field_name = $2`,
        [fromEntityId, fromFieldName],
      );
      return result.rows[0] ?? null;
    },

    async delete(id) {
      const result = await db.query(
        `DELETE FROM ontology.relationships WHERE id = $1`,
        [id],
      );
      return result.rowCount !== null && result.rowCount > 0;
    },

    async deleteByEntityId(entityId) {
      const result = await db.query(
        `DELETE FROM ontology.relationships WHERE from_entity_id = $1 OR to_entity_id = $1`,
        [entityId],
      );
      return result.rowCount ?? 0;
    },
  };
}
