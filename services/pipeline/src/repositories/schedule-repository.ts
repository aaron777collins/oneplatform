import type pg from "pg";
import type {
  ScheduleRow,
  CreateScheduleData,
  UpdateScheduleData,
} from "./types.js";

const SCHEDULE_COLUMNS = `
  id, pipeline_id, tenant_id, cron_expr, timezone,
  enabled, input_template, last_run_at, next_run_at,
  created_at, updated_at
`;

export class ScheduleRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(data: CreateScheduleData): Promise<ScheduleRow> {
    const result = await this.pool.query<ScheduleRow>(
      `INSERT INTO pipeline.schedules
         (pipeline_id, tenant_id, cron_expr, timezone,
          enabled, input_template, next_run_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${SCHEDULE_COLUMNS}`,
      [
        data.pipeline_id,
        data.tenant_id,
        data.cron_expr,
        data.timezone ?? "UTC",
        data.enabled ?? true,
        JSON.stringify(data.input_template ?? {}),
        data.next_run_at ?? null,
      ]
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("INSERT INTO pipeline.schedules returned no rows");
    }
    return row;
  }

  async findById(id: string): Promise<ScheduleRow | null> {
    const result = await this.pool.query<ScheduleRow>(
      `SELECT ${SCHEDULE_COLUMNS}
         FROM pipeline.schedules
        WHERE id = $1`,
      [id]
    );
    return result.rows[0] ?? null;
  }

  async findByPipelineId(pipelineId: string): Promise<ScheduleRow[]> {
    const result = await this.pool.query<ScheduleRow>(
      `SELECT ${SCHEDULE_COLUMNS}
         FROM pipeline.schedules
        WHERE pipeline_id = $1
        ORDER BY created_at ASC, id ASC`,
      [pipelineId]
    );
    return result.rows;
  }

  // Cursor-based paginated list for a tenant across all pipelines.
  async findByTenantId(
    tenantId: string,
    options?: { cursor?: string; limit?: number }
  ): Promise<ScheduleRow[]> {
    const limit = options?.limit ?? 50;

    if (options?.cursor !== undefined) {
      const result = await this.pool.query<ScheduleRow>(
        `SELECT ${SCHEDULE_COLUMNS}
           FROM pipeline.schedules
          WHERE tenant_id = $1
            AND id > $2
          ORDER BY created_at ASC, id ASC
          LIMIT $3`,
        [tenantId, options.cursor, limit]
      );
      return result.rows;
    }

    const result = await this.pool.query<ScheduleRow>(
      `SELECT ${SCHEDULE_COLUMNS}
         FROM pipeline.schedules
        WHERE tenant_id = $1
        ORDER BY created_at ASC, id ASC
        LIMIT $2`,
      [tenantId, limit]
    );
    return result.rows;
  }

  async update(
    id: string,
    data: UpdateScheduleData
  ): Promise<ScheduleRow | null> {
    const sets: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (data.cron_expr !== undefined) {
      sets.push(`cron_expr = $${idx++}`);
      values.push(data.cron_expr);
    }
    if (data.timezone !== undefined) {
      sets.push(`timezone = $${idx++}`);
      values.push(data.timezone);
    }
    if (data.enabled !== undefined) {
      sets.push(`enabled = $${idx++}`);
      values.push(data.enabled);
    }
    if (data.input_template !== undefined) {
      sets.push(`input_template = $${idx++}`);
      values.push(JSON.stringify(data.input_template));
    }
    if (data.next_run_at !== undefined) {
      sets.push(`next_run_at = $${idx++}`);
      values.push(data.next_run_at);
    }
    if (data.last_run_at !== undefined) {
      sets.push(`last_run_at = $${idx++}`);
      values.push(data.last_run_at);
    }

    if (sets.length === 0) {
      throw new Error(
        `update() called with no fields to update for schedule ${id}`
      );
    }

    sets.push("updated_at = now()");
    values.push(id);

    const result = await this.pool.query<ScheduleRow>(
      `UPDATE pipeline.schedules
            SET ${sets.join(", ")}
          WHERE id = $${idx}
      RETURNING ${SCHEDULE_COLUMNS}`,
      values
    );
    return result.rows[0] ?? null;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM pipeline.schedules WHERE id = $1`,
      [id]
    );
    return result.rowCount !== null && result.rowCount > 0;
  }

  // Returns all enabled schedules whose next_run_at is at or before the
  // provided threshold (typically now()). Used by the cron scheduler loop
  // which wakes every 30 seconds and processes due schedules.
  async findDueSchedules(asOf: Date): Promise<ScheduleRow[]> {
    const result = await this.pool.query<ScheduleRow>(
      `SELECT ${SCHEDULE_COLUMNS}
         FROM pipeline.schedules
        WHERE enabled = true
          AND next_run_at <= $1
        ORDER BY next_run_at ASC`,
      [asOf]
    );
    return result.rows;
  }

  // Atomically advances the schedule's next_run_at and records the last run
  // timestamp. Uses a conditional UPDATE — only the instance that wins the
  // UPDATE (sees rowCount=1) enqueues the run. Other instances see 0 rows
  // and skip, preventing duplicate cron runs in multi-instance deployments
  // (design spec §19.3).
  async updateNextRunAt(
    id: string,
    lastRunAt: Date,
    nextRunAt: Date,
    // The currentNextRunAt guard ensures the UPDATE is a no-op if another
    // instance already advanced the schedule in the same cron tick.
    currentNextRunAt: Date
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE pipeline.schedules
            SET next_run_at  = $1,
                last_run_at  = $2,
                updated_at   = now()
          WHERE id = $3
            AND next_run_at  = $4
            AND enabled      = true`,
      [nextRunAt, lastRunAt, id, currentNextRunAt]
    );
    return result.rowCount !== null && result.rowCount > 0;
  }
}
