import type pg from "pg";
import type { RelationshipRow, CreateRelationshipData } from "./types.js";

export interface RelationshipRepository {
  create(data: CreateRelationshipData, client?: pg.PoolClient): Promise<RelationshipRow>;
  findByEntityId(entityId: string): Promise<RelationshipRow[]>;
  /** Batch-load relationships for multiple entities in a single query, eliminating N+1 on snapshot builds. */
  findByEntityIds(entityIds: string[]): Promise<Map<string, RelationshipRow[]>>;
  findById(id: string): Promise<RelationshipRow | null>;
  findByFromEntityAndField(fromEntityId: string, fromFieldName: string): Promise<RelationshipRow | null>;
  /** Pass tenantId to enforce tenant isolation on delete. */
  delete(id: string, tenantId?: string): Promise<boolean>;
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

    async findByEntityIds(entityIds) {
      if (entityIds.length === 0) return new Map();

      const result = await db.query<RelationshipRow>(
        `SELECT * FROM ontology.relationships
         WHERE from_entity_id = ANY($1::uuid[]) OR to_entity_id = ANY($1::uuid[])
         ORDER BY created_at`,
        [entityIds],
      );

      // A relationship references two entities, so index it under both entity IDs.
      const grouped = new Map<string, RelationshipRow[]>();
      const addToGroup = (key: string, row: RelationshipRow) => {
        const bucket = grouped.get(key) ?? [];
        bucket.push(row);
        grouped.set(key, bucket);
      };
      for (const row of result.rows) {
        addToGroup(row.from_entity_id, row);
        if (row.to_entity_id !== row.from_entity_id) {
          addToGroup(row.to_entity_id, row);
        }
      }
      return grouped;
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

    async delete(id, tenantId) {
      // When tenantId is provided, add AND tenant_id = $2 to prevent cross-tenant
      // deletion in the event of an ID collision or caller mistake.
      if (tenantId !== undefined) {
        const result = await db.query(
          `DELETE FROM ontology.relationships WHERE id = $1 AND tenant_id = $2`,
          [id, tenantId],
        );
        return result.rowCount !== null && result.rowCount > 0;
      }
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
