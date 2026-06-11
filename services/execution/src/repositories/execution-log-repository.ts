import type pg from "pg";
import type { ExecutionLogRow, CreateExecutionLogData } from "./types.js";

const LOG_COLUMNS = `
  id, execution_id, execution_date, timestamp, level,
  message, line_number, stream, metadata
`;

export class ExecutionLogRepository {
  constructor(private readonly pool: pg.Pool) {}

  // Appends a single log line. Called inline from the SSE fan-out path as each
  // log message arrives from the sandbox socket; writes are intentionally
  // individual to preserve ordering and enable real-time streaming.
  async append(data: CreateExecutionLogData): Promise<ExecutionLogRow> {
    const result = await this.pool.query<ExecutionLogRow>(
      `INSERT INTO execution.execution_logs
         (execution_id, execution_date, level, message, line_number, stream, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${LOG_COLUMNS}`,
      [
        data.execution_id,
        data.execution_date,
        data.level,
        data.message,
        data.line_number,
        data.stream,
        data.metadata !== undefined ? JSON.stringify(data.metadata) : null,
      ]
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(
        `INSERT INTO execution.execution_logs returned no rows for execution ${data.execution_id}`
      );
    }
    return row;
  }

  // Inserts multiple log lines in a single round-trip. Used when the sandbox
  // sends a burst of log output (e.g., connector-run verbose mode) and
  // individual appends would create unacceptable DB round-trip overhead.
  // Lines are inserted in the order provided; line_number uniqueness within
  // an execution is the caller's responsibility.
  async appendBatch(lines: readonly CreateExecutionLogData[]): Promise<void> {
    if (lines.length === 0) {
      return;
    }

    const valueClauses: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    for (const line of lines) {
      valueClauses.push(
        `($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`
      );
      values.push(
        line.execution_id,
        line.execution_date,
        line.level,
        line.message,
        line.line_number,
        line.stream,
        line.metadata !== undefined ? JSON.stringify(line.metadata) : null
      );
    }

    await this.pool.query(
      `INSERT INTO execution.execution_logs
         (execution_id, execution_date, level, message, line_number, stream, metadata)
       VALUES ${valueClauses.join(", ")}`,
      values
    );
  }

  // Returns log lines for an execution in line_number ascending order.
  // The optional afterLineNumber parameter supports the Last-Event-ID SSE
  // resume pattern: reconnecting clients send the last received line number
  // and receive only lines they have not yet seen.
  async findByExecutionId(
    executionId: string,
    query?: { limit?: number; afterLineNumber?: number }
  ): Promise<ExecutionLogRow[]> {
    const limit = query?.limit ?? 500;

    if (query?.afterLineNumber !== undefined) {
      const result = await this.pool.query<ExecutionLogRow>(
        `SELECT ${LOG_COLUMNS}
           FROM execution.execution_logs
          WHERE execution_id = $1
            AND line_number > $2
          ORDER BY line_number ASC
          LIMIT $3`,
        [executionId, query.afterLineNumber, limit]
      );
      return result.rows;
    }

    const result = await this.pool.query<ExecutionLogRow>(
      `SELECT ${LOG_COLUMNS}
         FROM execution.execution_logs
        WHERE execution_id = $1
        ORDER BY line_number ASC
        LIMIT $2`,
      [executionId, limit]
    );
    return result.rows;
  }

  // Returns log lines strictly after afterLineNumber. Dedicated method for the
  // SSE resume path so the intent is explicit at the call site.
  // Returns an empty array (never null) when no new lines exist, so callers
  // can check execution terminal state and close the stream cleanly.
  async findSince(
    executionId: string,
    afterLineNumber: number,
    limit?: number
  ): Promise<ExecutionLogRow[]> {
    const result = await this.pool.query<ExecutionLogRow>(
      `SELECT ${LOG_COLUMNS}
         FROM execution.execution_logs
        WHERE execution_id = $1
          AND line_number > $2
        ORDER BY line_number ASC
        LIMIT $3`,
      [executionId, afterLineNumber, limit ?? 500]
    );
    return result.rows;
  }

  // Returns the total number of log lines stored for an execution.
  // Used by the truncation guard: if count >= 10 000 the incoming line is
  // discarded and a terminal "[truncated after 10000 lines]" entry is appended.
  async countByExecutionId(executionId: string): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT count(*) AS count
         FROM execution.execution_logs
        WHERE execution_id = $1`,
      [executionId]
    );
    const row = result.rows[0];
    return row !== undefined ? parseInt(row["count"], 10) : 0;
  }
}
