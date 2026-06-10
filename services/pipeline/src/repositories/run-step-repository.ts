import type pg from "pg";
import type { RunStepRow, CreateRunStepData, UpdateRunStepData } from "./types.js";

const RUN_STEP_COLUMNS = `
  id, run_id, tenant_id, step_id, step_name, step_type,
  status, attempt_count, started_at, completed_at,
  input, output, error, execution_id, created_at
`;

export class RunStepRepository {
  constructor(private readonly pool: pg.Pool) {}

  // Inserts all steps for a run in a single statement for atomicity.
  // Called at run start to eagerly create all run_step rows in 'pending'
  // state so the UI can render the full step graph immediately.
  async createBatch(steps: CreateRunStepData[]): Promise<RunStepRow[]> {
    if (steps.length === 0) {
      return [];
    }

    // Build a multi-row VALUES clause. Each step occupies 5 parameters.
    const valuePlaceholders: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    for (const step of steps) {
      valuePlaceholders.push(
        `($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`
      );
      values.push(
        step.run_id,
        step.tenant_id,
        step.step_id,
        step.step_name,
        step.step_type,
        JSON.stringify(step.input ?? {})
      );
    }

    const result = await this.pool.query<RunStepRow>(
      `INSERT INTO pipeline.run_steps
         (run_id, tenant_id, step_id, step_name, step_type, input)
       VALUES ${valuePlaceholders.join(", ")}
       RETURNING ${RUN_STEP_COLUMNS}`,
      values
    );
    return result.rows;
  }

  // Returns all steps for a run ordered by creation time.
  // The display order follows definition_snapshot.executionOrder,
  // but DB insertion order from createBatch provides a stable secondary sort.
  async findByRunId(runId: string): Promise<RunStepRow[]> {
    const result = await this.pool.query<RunStepRow>(
      `SELECT ${RUN_STEP_COLUMNS}
         FROM pipeline.run_steps
        WHERE run_id = $1
        ORDER BY created_at ASC, id ASC`,
      [runId]
    );
    return result.rows;
  }

  // Transitions a single step's status. Also sets the appropriate timestamp
  // (started_at when moving to 'running', completed_at when reaching a terminal state).
  async updateStatus(
    runId: string,
    stepId: string,
    data: UpdateRunStepData
  ): Promise<RunStepRow | null> {
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
    if (data.execution_id !== undefined) {
      sets.push(`execution_id = $${idx++}`);
      values.push(data.execution_id);
    }
    if (data.attempt_count !== undefined) {
      sets.push(`attempt_count = $${idx++}`);
      values.push(data.attempt_count);
    }

    if (sets.length === 0) {
      throw new Error(
        `updateStatus() called with no fields for run_step (run=${runId}, step=${stepId})`
      );
    }

    values.push(runId, stepId);

    const result = await this.pool.query<RunStepRow>(
      `UPDATE pipeline.run_steps
            SET ${sets.join(", ")}
          WHERE run_id = $${idx}
            AND step_id = $${idx + 1}
      RETURNING ${RUN_STEP_COLUMNS}`,
      values
    );
    return result.rows[0] ?? null;
  }

  // Writes the step's output after successful execution.
  // Separated from updateStatus because output can be large JSONB and is
  // only set on success — keeping status updates lean for the common path.
  async updateOutput(
    runId: string,
    stepId: string,
    output: Record<string, unknown>
  ): Promise<RunStepRow | null> {
    const result = await this.pool.query<RunStepRow>(
      `UPDATE pipeline.run_steps
            SET output = $1
          WHERE run_id = $2
            AND step_id = $3
      RETURNING ${RUN_STEP_COLUMNS}`,
      [JSON.stringify(output), runId, stepId]
    );
    return result.rows[0] ?? null;
  }
}
