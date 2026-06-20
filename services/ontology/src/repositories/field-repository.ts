import type pg from "pg";
import type { FieldRow, CreateFieldData, UpdateFieldData } from "./types.js";

export interface FieldRepository {
  create(data: CreateFieldData, client?: pg.PoolClient): Promise<FieldRow>;
  createMany(fields: CreateFieldData[], client?: pg.PoolClient): Promise<FieldRow[]>;
  findByEntityId(entityId: string): Promise<FieldRow[]>;
  /** Batch-load fields for multiple entities in a single query, eliminating N+1 on list operations. */
  findByEntityIds(entityIds: string[]): Promise<Map<string, FieldRow[]>>;
  findBySlug(entityId: string, slug: string): Promise<FieldRow | null>;
  findById(id: string): Promise<FieldRow | null>;
  update(id: string, data: UpdateFieldData): Promise<FieldRow | null>;
  softDelete(id: string): Promise<boolean>;
  softDeleteByEntityId(entityId: string): Promise<number>;
  hardDeleteByEntityId(entityId: string, client?: pg.PoolClient): Promise<number>;
}

export function createFieldRepository(db: pg.Pool): FieldRepository {
  async function insertField(data: CreateFieldData, queryFn: { query: (sql: string, params: unknown[]) => Promise<pg.QueryResult<FieldRow>> }): Promise<FieldRow> {
    const result = await queryFn.query(
      `INSERT INTO ontology.fields
       (entity_id, tenant_id, name, slug, field_type, required, nullable,
        default_value, validation_rules, enum_values, array_item_type,
        ref_entity_id, is_indexed, is_unique, sort_order, system_generated)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING *`,
      [
        data.entity_id, data.tenant_id, data.name, data.slug, data.field_type,
        data.required ?? false, data.nullable ?? true,
        data.default_value !== undefined ? JSON.stringify(data.default_value) : null,
        JSON.stringify(data.validation_rules ?? []),
        data.enum_values ?? null, data.array_item_type ?? null,
        data.ref_entity_id ?? null, data.is_indexed ?? false, data.is_unique ?? false,
        data.sort_order ?? 0, data.system_generated ?? false,
      ],
    );
    return result.rows[0]!;
  }

  return {
    async create(data, client) {
      return insertField(data, client ?? db);
    },

    async createMany(fields, client) {
      const results: FieldRow[] = [];
      for (const data of fields) {
        results.push(await insertField(data, client ?? db));
      }
      return results;
    },

    async findByEntityId(entityId) {
      const result = await db.query<FieldRow>(
        `SELECT * FROM ontology.fields
         WHERE entity_id = $1 AND deleted_at IS NULL
         ORDER BY sort_order, created_at`,
        [entityId],
      );
      return result.rows;
    },

    async findByEntityIds(entityIds) {
      // Empty input: skip the query entirely — ANY($1::uuid[]) would match nothing.
      if (entityIds.length === 0) return new Map();

      const result = await db.query<FieldRow>(
        `SELECT * FROM ontology.fields
         WHERE entity_id = ANY($1::uuid[]) AND deleted_at IS NULL
         ORDER BY entity_id, sort_order, created_at`,
        [entityIds],
      );

      // Group into a Map keyed by entity_id so callers get O(1) lookup per entity.
      const grouped = new Map<string, FieldRow[]>();
      for (const row of result.rows) {
        const bucket = grouped.get(row.entity_id) ?? [];
        bucket.push(row);
        grouped.set(row.entity_id, bucket);
      }
      return grouped;
    },

    async findBySlug(entityId, slug) {
      const result = await db.query<FieldRow>(
        `SELECT * FROM ontology.fields
         WHERE entity_id = $1 AND slug = $2 AND deleted_at IS NULL`,
        [entityId, slug],
      );
      return result.rows[0] ?? null;
    },

    async findById(id) {
      const result = await db.query<FieldRow>(
        `SELECT * FROM ontology.fields WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      );
      return result.rows[0] ?? null;
    },

    async update(id, data) {
      const sets: string[] = ["updated_at = now()"];
      const values: unknown[] = [];
      let idx = 1;

      if (data.name !== undefined) {
        values.push(data.name);
        sets.push(`name = $${idx++}`);
      }
      if (data.validation_rules !== undefined) {
        values.push(JSON.stringify(data.validation_rules));
        sets.push(`validation_rules = $${idx++}`);
      }
      if (data.is_indexed !== undefined) {
        values.push(data.is_indexed);
        sets.push(`is_indexed = $${idx++}`);
      }
      if (data.is_unique !== undefined) {
        values.push(data.is_unique);
        sets.push(`is_unique = $${idx++}`);
      }
      if (data.default_value !== undefined) {
        values.push(JSON.stringify(data.default_value));
        sets.push(`default_value = $${idx++}`);
      }

      values.push(id);
      const result = await db.query<FieldRow>(
        `UPDATE ontology.fields SET ${sets.join(", ")}
         WHERE id = $${idx} AND deleted_at IS NULL
         RETURNING *`,
        values,
      );
      return result.rows[0] ?? null;
    },

    async softDelete(id) {
      const result = await db.query(
        `UPDATE ontology.fields SET deleted_at = now(), updated_at = now()
         WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      );
      return result.rowCount !== null && result.rowCount > 0;
    },

    async softDeleteByEntityId(entityId) {
      const result = await db.query(
        `UPDATE ontology.fields SET deleted_at = now(), updated_at = now()
         WHERE entity_id = $1 AND deleted_at IS NULL`,
        [entityId],
      );
      return result.rowCount ?? 0;
    },

    async hardDeleteByEntityId(entityId, client) {
      // Use the provided client when operating inside a transaction so that
      // the DELETE is atomically bundled with the caller's BEGIN/COMMIT block.
      const result = await (client ?? db).query(
        `DELETE FROM ontology.fields WHERE entity_id = $1`,
        [entityId],
      );
      return result.rowCount ?? 0;
    },
  };
}
