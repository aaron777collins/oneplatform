import type pg from "pg";
import type {
  PipelineRow,
  CreatePipelineData,
  UpdatePipelineData,
} from "./types.js";

// current_version is included so callers can display the version counter without
// needing a second query against pipeline_versions.
const PIPELINE_COLUMNS = `
  id, tenant_id, name, slug, description, definition,
  is_active, created_at, updated_at, created_by, current_version
`;

export class PipelineRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(data: CreatePipelineData): Promise<PipelineRow> {
    const result = await this.pool.query<PipelineRow>(
      `INSERT INTO pipeline.pipelines
         (tenant_id, name, slug, description, definition, is_active, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${PIPELINE_COLUMNS}`,
      [
        data.tenant_id,
        data.name,
        data.slug,
        data.description ?? null,
        JSON.stringify(data.definition),
        data.is_active ?? true,
        data.created_by,
      ]
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("INSERT INTO pipeline.pipelines returned no rows");
    }
    return row;
  }

  async findById(id: string): Promise<PipelineRow | null> {
    const result = await this.pool.query<PipelineRow>(
      `SELECT ${PIPELINE_COLUMNS}
         FROM pipeline.pipelines
        WHERE id = $1`,
      [id]
    );
    return result.rows[0] ?? null;
  }

  // Tenant-scoped lookup by primary key. Returns null when the pipeline ID
  // exists but belongs to a different tenant — callers get a consistent
  // not-found result rather than a data leak.
  async findByTenantAndId(
    tenantId: string,
    id: string
  ): Promise<PipelineRow | null> {
    const result = await this.pool.query<PipelineRow>(
      `SELECT ${PIPELINE_COLUMNS}
         FROM pipeline.pipelines
        WHERE id = $1
          AND tenant_id = $2`,
      [id, tenantId]
    );
    return result.rows[0] ?? null;
  }

  async findByTenantAndSlug(
    tenantId: string,
    slug: string
  ): Promise<PipelineRow | null> {
    const result = await this.pool.query<PipelineRow>(
      `SELECT ${PIPELINE_COLUMNS}
         FROM pipeline.pipelines
        WHERE tenant_id = $1
          AND slug = $2`,
      [tenantId, slug]
    );
    return result.rows[0] ?? null;
  }

  // Cursor-based paginated list for a tenant. Ordering by (created_at ASC, id ASC)
  // gives stable pages that tolerate concurrent inserts between page fetches.
  async findByTenantId(
    tenantId: string,
    options?: {
      cursor?: string;
      limit?: number;
      filterIsActive?: boolean;
    }
  ): Promise<PipelineRow[]> {
    const limit = options?.limit ?? 50;
    const conditions: string[] = ["tenant_id = $1"];
    const values: unknown[] = [tenantId];
    let idx = 2;

    if (options?.filterIsActive !== undefined) {
      conditions.push(`is_active = $${idx++}`);
      values.push(options.filterIsActive);
    }

    if (options?.cursor !== undefined) {
      conditions.push(`id > $${idx++}`);
      values.push(options.cursor);
    }

    values.push(limit);

    const result = await this.pool.query<PipelineRow>(
      `SELECT ${PIPELINE_COLUMNS}
         FROM pipeline.pipelines
        WHERE ${conditions.join(" AND ")}
        ORDER BY created_at ASC, id ASC
        LIMIT $${idx}`,
      values
    );
    return result.rows;
  }

  // update() wraps the snapshot + UPDATE in a single transaction so the version
  // record and the new pipeline state are always consistent — no partial writes.
  // The caller provides `updatedBy` so the version record knows who made the change.
  async update(
    id: string,
    data: UpdatePipelineData,
    updatedBy?: string
  ): Promise<PipelineRow | null> {
    const sets: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (data.name !== undefined) {
      sets.push(`name = $${idx++}`);
      values.push(data.name);
    }
    if (data.description !== undefined) {
      sets.push(`description = $${idx++}`);
      values.push(data.description); // null clears the column
    }
    if (data.definition !== undefined) {
      sets.push(`definition = $${idx++}`);
      values.push(JSON.stringify(data.definition));
    }
    if (data.is_active !== undefined) {
      sets.push(`is_active = $${idx++}`);
      values.push(data.is_active);
    }

    if (sets.length === 0) {
      throw new Error(
        `update() called with no fields to update for pipeline ${id}`
      );
    }

    // Increment the version counter on every update so current_version on the
    // pipeline row always reflects how many snapshots have been taken.
    sets.push("current_version = current_version + 1");
    sets.push("updated_at = now()");
    values.push(id);

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // Snapshot the current state before applying the update. We use SELECT …
      // FOR UPDATE to lock the row for the duration of the transaction, preventing
      // a concurrent update from racing between the snapshot read and the write.
      const snapshotResult = await client.query<PipelineRow>(
        `SELECT ${PIPELINE_COLUMNS}
           FROM pipeline.pipelines
          WHERE id = $1
          FOR UPDATE`,
        [id]
      );

      const existing = snapshotResult.rows[0];

      if (existing !== undefined && updatedBy !== undefined) {
        // The new version_number is current_version + 1 (the value after the
        // UPDATE below increments it). We compute it here before the UPDATE runs.
        const nextVersion = existing.current_version + 1;

        await client.query(
          `INSERT INTO pipeline.pipeline_versions
             (pipeline_id, tenant_id, version_number, definition_snapshot,
              name_at_version, description_at_version, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            id,
            existing.tenant_id,
            nextVersion,
            JSON.stringify(existing.definition),
            existing.name,
            existing.description ?? null,
            updatedBy,
          ]
        );
      }

      const result = await client.query<PipelineRow>(
        `UPDATE pipeline.pipelines
              SET ${sets.join(", ")}
            WHERE id = $${idx}
        RETURNING ${PIPELINE_COLUMNS}`,
        values
      );

      await client.query("COMMIT");
      return result.rows[0] ?? null;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  // Hard-delete a pipeline. Callers must verify no active runs exist before
  // calling this method (design spec §5.2 DELETE /api/v1/pipelines/{id}).
  // Cascade deletes runs, run_steps, run_logs, schedules, and triggers via FK.
  async delete(id: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM pipeline.pipelines WHERE id = $1`,
      [id]
    );
    return result.rowCount !== null && result.rowCount > 0;
  }
}
