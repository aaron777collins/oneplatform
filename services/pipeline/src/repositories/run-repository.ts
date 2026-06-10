import type pg from "pg";
import type { RunRow, CreateRunData, UpdateRunData } from "./types.js";

const RUN_COLUMNS = `
  id, pipeline_id, tenant_id, status, triggered_by,
  trigger_actor_id, trigger_meta, input, started_at, completed_at,
  error, bully_job_id, definition_snapshot, created_at
`;

export class RunRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(data: CreateRunData): Promise<RunRow> {
    const result = await this.pool.query<RunRow>(
      `INSERT INTO pipeline.runs
         (pipeline_id, tenant_id, triggered_by, trigger_actor_id,
          trigger_meta, input, bully_job_id, definition_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${RUN_COLUMNS}`,
      [
        data.pipeline_id,
        data.tenant_id,
        data.triggered_by,
        data.trigger_actor_id ?? null,
        JSON.stringify(data.trigger_meta ?? {}),
        JSON.stringify(data.input ?? {}),
        data.bully_job_id ?? null,
        JSON.stringify(data.definition_snapshot),
      ]
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("INSERT INTO pipeline.runs returned no rows");
    }
    return row;
  }

  async findById(id: string): Promise<RunRow | null> {
    const result = await this.pool.query<RunRow>(
      `SELECT ${RUN_COLUMNS}
         FROM pipeline.runs
        WHERE id = $1`,
      [id]
    );
    return result.rows[0] ?? null;
  }

  // Tenant-scoped lookup — returns null for cross-tenant access attempts.
  async findByTenantAndId(
    tenantId: string,
    id: string
  ): Promise<RunRow | null> {
    const result = await this.pool.query<RunRow>(
      `SELECT ${RUN_COLUMNS}
         FROM pipeline.runs
        WHERE id = $1
          AND tenant_id = $2`,
      [id, tenantId]
    );
    return result.rows[0] ?? null;
  }

  // Cursor-based paginated list scoped to a pipeline.
  // Ordered by created_at DESC (newest first) for run history views.
  async findByPipelineId(
    pipelineId: string,
    options?: { cursor?: string; limit?: number }
  ): Promise<RunRow[]> {
    const limit = options?.limit ?? 50;

    if (options?.cursor !== undefined) {
      const result = await this.pool.query<RunRow>(
        `SELECT ${RUN_COLUMNS}
           FROM pipeline.runs
          WHERE pipeline_id = $1
            AND id < $2
          ORDER BY created_at DESC, id DESC
          LIMIT $3`,
        [pipelineId, options.cursor, limit]
      );
      return result.rows;
    }

    const result = await this.pool.query<RunRow>(
      `SELECT ${RUN_COLUMNS}
         FROM pipeline.runs
        WHERE pipeline_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT $2`,
      [pipelineId, limit]
    );
    return result.rows;
  }

  // Cursor-based paginated list scoped to a tenant (across all pipelines).
  async findByTenantId(
    tenantId: string,
    options?: {
      cursor?: string;
      limit?: number;
      filterStatus?: RunRow["status"];
    }
  ): Promise<RunRow[]> {
    const limit = options?.limit ?? 50;
    const conditions: string[] = ["tenant_id = $1"];
    const values: unknown[] = [tenantId];
    let idx = 2;

    if (options?.filterStatus !== undefined) {
      conditions.push(`status = $${idx++}`);
      values.push(options.filterStatus);
    }

    if (options?.cursor !== undefined) {
      conditions.push(`id < $${idx++}`);
      values.push(options.cursor);
    }

    values.push(limit);

    const result = await this.pool.query<RunRow>(
      `SELECT ${RUN_COLUMNS}
         FROM pipeline.runs
        WHERE ${conditions.join(" AND ")}
        ORDER BY created_at DESC, id DESC
        LIMIT $${idx}`,
      values
    );
    return result.rows;
  }

  async updateStatus(id: string, data: UpdateRunData): Promise<RunRow | null> {
    const sets: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (data.status !== undefined) {
      sets.push(`status = $${idx++}`);
      values.push(data.status);
    }
    if (data.started_at !== undefined) {
      sets.push(`started_at = $${idx++}`);
      values.push(data.started_at);
    }
    if (data.completed_at !== undefined) {
      sets.push(`completed_at = $${idx++}`);
      values.push(data.completed_at);
    }
    if (data.error !== undefined) {
      sets.push(`error = $${idx++}`);
      values.push(data.error !== null ? JSON.stringify(data.error) : null);
    }
    if (data.bully_job_id !== undefined) {
      sets.push(`bully_job_id = $${idx++}`);
      values.push(data.bully_job_id);
    }

    if (sets.length === 0) {
      throw new Error(
        `updateStatus() called with no fields to update for run ${id}`
      );
    }

    values.push(id);

    const result = await this.pool.query<RunRow>(
      `UPDATE pipeline.runs
            SET ${sets.join(", ")}
          WHERE id = $${idx}
      RETURNING ${RUN_COLUMNS}`,
      values
    );
    return result.rows[0] ?? null;
  }

  // Returns the count of active (pending or running) runs for a pipeline.
  // Used by the concurrency check before creating a new run when
  // allowConcurrentRuns=false is set in the pipeline's options.
  async countActiveByPipelineId(pipelineId: string): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT count(*) AS count
         FROM pipeline.runs
        WHERE pipeline_id = $1
          AND status IN ('pending', 'running')`,
      [pipelineId]
    );
    const row = result.rows[0];
    return row !== undefined ? parseInt(row["count"], 10) : 0;
  }
}
