import type pg from "pg";
import type { MappingRuleRow, CreateMappingRuleData, UpdateMappingRuleData } from "./types.js";

export interface MappingRuleRepository {
  create(data: CreateMappingRuleData): Promise<MappingRuleRow>;
  findByConnectorId(connectorId: string, activeOnly?: boolean): Promise<MappingRuleRow[]>;
  findByEntityId(entityId: string): Promise<MappingRuleRow[]>;
  findById(id: string): Promise<MappingRuleRow | null>;
  update(id: string, data: UpdateMappingRuleData): Promise<MappingRuleRow | null>;
  delete(id: string): Promise<boolean>;
}

export function createMappingRuleRepository(db: pg.Pool): MappingRuleRepository {
  return {
    async create(data) {
      const result = await db.query<MappingRuleRow>(
        `INSERT INTO ontology.mapping_rules
         (tenant_id, connector_id, source_field_path, target_entity_id,
          target_field_id, transform_type, transform, priority)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          data.tenant_id, data.connector_id, data.source_field_path,
          data.target_entity_id, data.target_field_id,
          data.transform_type ?? "direct", data.transform ?? null,
          data.priority ?? 0,
        ],
      );
      return result.rows[0]!;
    },

    async findByConnectorId(connectorId, activeOnly = true) {
      const where = activeOnly
        ? "connector_id = $1 AND is_active = true"
        : "connector_id = $1";
      const result = await db.query<MappingRuleRow>(
        `SELECT * FROM ontology.mapping_rules WHERE ${where} ORDER BY priority DESC, created_at`,
        [connectorId],
      );
      return result.rows;
    },

    async findByEntityId(entityId) {
      const result = await db.query<MappingRuleRow>(
        `SELECT * FROM ontology.mapping_rules
         WHERE target_entity_id = $1 AND is_active = true
         ORDER BY priority DESC, created_at`,
        [entityId],
      );
      return result.rows;
    },

    async findById(id) {
      const result = await db.query<MappingRuleRow>(
        `SELECT * FROM ontology.mapping_rules WHERE id = $1`,
        [id],
      );
      return result.rows[0] ?? null;
    },

    async update(id, data) {
      const sets: string[] = ["updated_at = now()"];
      const values: unknown[] = [];
      let idx = 1;

      if (data.source_field_path !== undefined) {
        values.push(data.source_field_path);
        sets.push(`source_field_path = $${idx++}`);
      }
      if (data.transform_type !== undefined) {
        values.push(data.transform_type);
        sets.push(`transform_type = $${idx++}`);
      }
      if (data.transform !== undefined) {
        values.push(data.transform);
        sets.push(`transform = $${idx++}`);
      }
      if (data.is_active !== undefined) {
        values.push(data.is_active);
        sets.push(`is_active = $${idx++}`);
      }
      if (data.priority !== undefined) {
        values.push(data.priority);
        sets.push(`priority = $${idx++}`);
      }

      values.push(id);
      const result = await db.query<MappingRuleRow>(
        `UPDATE ontology.mapping_rules SET ${sets.join(", ")}
         WHERE id = $${idx}
         RETURNING *`,
        values,
      );
      return result.rows[0] ?? null;
    },

    async delete(id) {
      const result = await db.query(
        `DELETE FROM ontology.mapping_rules WHERE id = $1`,
        [id],
      );
      return result.rowCount !== null && result.rowCount > 0;
    },
  };
}
