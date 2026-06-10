import type pg from "pg";
import type { DraftOntologyRow, CreateDraftData } from "./types.js";

export interface DraftRepository {
  create(data: CreateDraftData): Promise<DraftOntologyRow>;
  findById(id: string): Promise<DraftOntologyRow | null>;
  findByConnectorId(connectorId: string, status?: string): Promise<DraftOntologyRow[]>;
  findByTenantId(tenantId: string): Promise<DraftOntologyRow[]>;
  confirm(id: string, confirmedBy: string): Promise<DraftOntologyRow | null>;
  reject(id: string): Promise<boolean>;
}

export function createDraftRepository(db: pg.Pool): DraftRepository {
  return {
    async create(data) {
      const result = await db.query<DraftOntologyRow>(
        `INSERT INTO ontology.draft_ontologies
         (tenant_id, connector_id, inferred_schema, sample_batch_id)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [
          data.tenant_id, data.connector_id,
          JSON.stringify(data.inferred_schema), data.sample_batch_id,
        ],
      );
      return result.rows[0]!;
    },

    async findById(id) {
      const result = await db.query<DraftOntologyRow>(
        `SELECT * FROM ontology.draft_ontologies WHERE id = $1`,
        [id],
      );
      return result.rows[0] ?? null;
    },

    async findByConnectorId(connectorId, status) {
      if (status) {
        const result = await db.query<DraftOntologyRow>(
          `SELECT * FROM ontology.draft_ontologies
           WHERE connector_id = $1 AND status = $2
           ORDER BY created_at DESC`,
          [connectorId, status],
        );
        return result.rows;
      }
      const result = await db.query<DraftOntologyRow>(
        `SELECT * FROM ontology.draft_ontologies
         WHERE connector_id = $1
         ORDER BY created_at DESC`,
        [connectorId],
      );
      return result.rows;
    },

    async findByTenantId(tenantId) {
      const result = await db.query<DraftOntologyRow>(
        `SELECT * FROM ontology.draft_ontologies
         WHERE tenant_id = $1
         ORDER BY created_at DESC`,
        [tenantId],
      );
      return result.rows;
    },

    async confirm(id, confirmedBy) {
      const result = await db.query<DraftOntologyRow>(
        `UPDATE ontology.draft_ontologies
         SET status = 'confirmed', confirmed_at = now(), confirmed_by = $1, updated_at = now()
         WHERE id = $2 AND status = 'draft'
         RETURNING *`,
        [confirmedBy, id],
      );
      return result.rows[0] ?? null;
    },

    async reject(id) {
      const result = await db.query(
        `UPDATE ontology.draft_ontologies
         SET status = 'rejected', updated_at = now()
         WHERE id = $1 AND status = 'draft'`,
        [id],
      );
      return result.rowCount !== null && result.rowCount > 0;
    },
  };
}
