import type pg from "pg";
import type {
  PipelineRow,
  CreatePipelineData,
  UpdatePipelineData,
} from "./types.js";

const PIPELINE_COLUMNS = `
  id, tenant_id, name, slug, description, definition,
  is_active, created_at, updated_at, created_by
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

  async update(
    id: string,
    data: UpdatePipelineData
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

    sets.push("updated_at = now()");
    values.push(id);

    const result = await this.pool.query<PipelineRow>(
      `UPDATE pipeline.pipelines
            SET ${sets.join(", ")}
          WHERE id = $${idx}
      RETURNING ${PIPELINE_COLUMNS}`,
      values
    );
    return result.rows[0] ?? null;
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
