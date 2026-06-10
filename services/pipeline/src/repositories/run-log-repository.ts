import type pg from "pg";
import type { RunLogRow, CreateRunLogData } from "./types.js";

const RUN_LOG_COLUMNS = `
  id, run_id, tenant_id, step_id, level, message, details, created_at
`;

export class RunLogRepository {
  constructor(private readonly pool: pg.Pool) {}

  // Appends a single log entry. Called inline during step execution within
  // the BullMQ worker; writes are synchronous to preserve ordering guarantees.
  async append(data: CreateRunLogData): Promise<RunLogRow> {
    const result = await this.pool.query<RunLogRow>(
      `INSERT INTO pipeline.run_logs
         (run_id, tenant_id, step_id, level, message, details)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${RUN_LOG_COLUMNS}`,
      [
        data.run_id,
        data.tenant_id,
        data.step_id ?? null,
        data.level,
        data.message,
        data.details !== undefined ? JSON.stringify(data.details) : null,
      ]
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(
        `INSERT INTO pipeline.run_logs returned no rows for run ${data.run_id}`
      );
    }
    return row;
  }

  // Returns up to `limit` log entries for a run, in ascending id order.
  // The optional afterId cursor enables the SSE polling loop to fetch only
  // new entries since the last successful poll.
  async findByRunId(
    runId: string,
    options?: { limit?: number; afterId?: number }
  ): Promise<RunLogRow[]> {
    const limit = options?.limit ?? 100;

    if (options?.afterId !== undefined) {
      const result = await this.pool.query<RunLogRow>(
        `SELECT ${RUN_LOG_COLUMNS}
           FROM pipeline.run_logs
          WHERE run_id = $1
            AND id > $2
          ORDER BY id ASC
          LIMIT $3`,
        [runId, options.afterId, limit]
      );
      return result.rows;
    }

    const result = await this.pool.query<RunLogRow>(
      `SELECT ${RUN_LOG_COLUMNS}
         FROM pipeline.run_logs
        WHERE run_id = $1
        ORDER BY id ASC
        LIMIT $2`,
      [runId, limit]
    );
    return result.rows;
  }

  // Returns log entries with id strictly greater than lastSeenId.
  // Used by the SSE streaming handler to poll for new entries at 500ms
  // intervals. Returns an empty array (not null) when there are no new entries
  // so callers can check run terminal state and close the stream.
  async findByRunIdSince(
    runId: string,
    lastSeenId: number,
    limit?: number
  ): Promise<RunLogRow[]> {
    const result = await this.pool.query<RunLogRow>(
      `SELECT ${RUN_LOG_COLUMNS}
         FROM pipeline.run_logs
        WHERE run_id = $1
          AND id > $2
        ORDER BY id ASC
        LIMIT $3`,
      [runId, lastSeenId, limit ?? 100]
    );
    return result.rows;
  }
}
