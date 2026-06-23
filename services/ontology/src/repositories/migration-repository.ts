import type pg from "pg";
import type { MigrationRow, CreateMigrationData } from "./types.js";

export interface MigrationRepository {
  create(data: CreateMigrationData): Promise<MigrationRow>;
  findById(id: string): Promise<MigrationRow | null>;
  findByTenantId(tenantId: string, status?: string, cursor?: string, limit?: number): Promise<MigrationRow[]>;
  findActiveByEntityId(entityId: string): Promise<MigrationRow | null>;
  /** Batch-load active migrations for multiple entities in a single query, eliminating N+1 on snapshot builds. */
  findActiveByEntityIds(entityIds: string[]): Promise<Map<string, MigrationRow>>;
  updateStatus(id: string, status: string, extra?: Record<string, unknown>): Promise<MigrationRow | null>;
  setConfirmed(id: string, confirmedBy: string): Promise<MigrationRow | null>;
  /** Same as setConfirmed but runs on the provided transaction client so the
   *  UPDATE is atomic with the advisory lock acquired in that transaction. */
  setConfirmedWithClient(client: pg.PoolClient, id: string, confirmedBy: string): Promise<MigrationRow | null>;
  /** Pass the transaction client so the status update is in the same transaction as any DDL. */
  setRunning(id: string, unionViewName: string, client?: pg.PoolClient): Promise<MigrationRow | null>;
  setComplete(id: string): Promise<MigrationRow | null>;
  setFailed(id: string, errorDetails: Record<string, unknown>): Promise<MigrationRow | null>;
  setRolledBack(id: string): Promise<MigrationRow | null>;
}

export function createMigrationRepository(db: pg.Pool): MigrationRepository {
  return {
    async create(data) {
      const result = await db.query<MigrationRow>(
        `INSERT INTO ontology.migrations
         (tenant_id, entity_id, from_version, to_version, change_type, is_breaking, change_plan)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          data.tenant_id, data.entity_id, data.from_version, data.to_version,
          data.change_type, data.is_breaking, JSON.stringify(data.change_plan),
        ],
      );
      return result.rows[0]!;
    },

    async findById(id) {
      const result = await db.query<MigrationRow>(
        `SELECT * FROM ontology.migrations WHERE id = $1`,
        [id],
      );
      return result.rows[0] ?? null;
    },

    async findByTenantId(tenantId, status, cursor, limit = 50) {
      const conditions = ["tenant_id = $1"];
      const values: unknown[] = [tenantId];
      let idx = 2;

      if (status) {
        conditions.push(`status = $${idx++}`);
        values.push(status);
      }
      if (cursor) {
        conditions.push(`id < $${idx++}`);
        values.push(cursor);
      }

      values.push(limit);
      const result = await db.query<MigrationRow>(
        `SELECT * FROM ontology.migrations
         WHERE ${conditions.join(" AND ")}
         ORDER BY created_at DESC LIMIT $${idx}`,
        values,
      );
      return result.rows;
    },

    async findActiveByEntityId(entityId) {
      const result = await db.query<MigrationRow>(
        `SELECT * FROM ontology.migrations
         WHERE entity_id = $1 AND status IN ('pending_confirmation', 'confirmed', 'running')
         ORDER BY created_at DESC LIMIT 1`,
        [entityId],
      );
      return result.rows[0] ?? null;
    },

    async findActiveByEntityIds(entityIds) {
      if (entityIds.length === 0) return new Map();

      // DISTINCT ON keeps only the latest active migration per entity
      // (ordered by created_at DESC per entity_id).
      const result = await db.query<MigrationRow>(
        `SELECT DISTINCT ON (entity_id) *
         FROM ontology.migrations
         WHERE entity_id = ANY($1::uuid[]) AND status IN ('pending_confirmation', 'confirmed', 'running')
         ORDER BY entity_id, created_at DESC`,
        [entityIds],
      );

      const grouped = new Map<string, MigrationRow>();
      for (const row of result.rows) {
        grouped.set(row.entity_id, row);
      }
      return grouped;
    },

    async updateStatus(id, status, extra) {
      const ALLOWED_COLUMNS = new Set([
        "confirmed_by", "confirmed_at", "started_at", "completed_at",
        "error_details", "union_view_name",
      ]);

      const sets = ["status = $1"];
      const values: unknown[] = [status];
      let idx = 2;

      if (extra) {
        for (const [key, value] of Object.entries(extra)) {
          if (!ALLOWED_COLUMNS.has(key)) {
            throw new Error(`Invalid column name in migration update: ${key}`);
          }
          if (key === "error_details") {
            values.push(JSON.stringify(value));
          } else {
            values.push(value);
          }
          sets.push(`"${key}" = $${idx++}`);
        }
      }

      values.push(id);
      const result = await db.query<MigrationRow>(
        `UPDATE ontology.migrations SET ${sets.join(", ")}
         WHERE id = $${idx}
         RETURNING *`,
        values,
      );
      return result.rows[0] ?? null;
    },

    async setConfirmed(id, confirmedBy) {
      const result = await db.query<MigrationRow>(
        `UPDATE ontology.migrations
         SET status = 'confirmed', confirmed_by = $1, confirmed_at = now()
         WHERE id = $2 AND status = 'pending_confirmation'
         RETURNING *`,
        [confirmedBy, id],
      );
      return result.rows[0] ?? null;
    },

    async setConfirmedWithClient(client, id, confirmedBy) {
      // Runs the same UPDATE as setConfirmed but on the caller's transaction
      // client so it is committed atomically with the advisory lock.
      const result = await client.query<MigrationRow>(
        `UPDATE ontology.migrations
         SET status = 'confirmed', confirmed_by = $1, confirmed_at = now()
         WHERE id = $2 AND status = 'pending_confirmation'
         RETURNING *`,
        [confirmedBy, id],
      );
      return result.rows[0] ?? null;
    },

    async setRunning(id, unionViewName, client) {
      // Use the provided transaction client when available so this UPDATE is
      // atomic with the CREATE VIEW DDL that runs in the same transaction.
      const queryFn = client ?? db;
      const result = await queryFn.query<MigrationRow>(
        `UPDATE ontology.migrations
         SET status = 'running', started_at = now(), union_view_name = $1
         WHERE id = $2 AND status = 'confirmed'
         RETURNING *`,
        [unionViewName, id],
      );
      return result.rows[0] ?? null;
    },

    async setComplete(id) {
      const result = await db.query<MigrationRow>(
        `UPDATE ontology.migrations
         SET status = 'complete', completed_at = now()
         WHERE id = $1 AND status = 'running'
         RETURNING *`,
        [id],
      );
      return result.rows[0] ?? null;
    },

    async setFailed(id, errorDetails) {
      const result = await db.query<MigrationRow>(
        `UPDATE ontology.migrations
         SET status = 'failed', error_details = $1, completed_at = now()
         WHERE id = $2
         RETURNING *`,
        [JSON.stringify(errorDetails), id],
      );
      return result.rows[0] ?? null;
    },

    async setRolledBack(id) {
      const result = await db.query<MigrationRow>(
        `UPDATE ontology.migrations
         SET status = 'rolled_back', completed_at = now()
         WHERE id = $1
         RETURNING *`,
        [id],
      );
      return result.rows[0] ?? null;
    },
  };
}
