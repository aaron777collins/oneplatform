import type pg from "pg";
import type {
  ExecutionRow,
  CreateExecutionData,
  UpdateExecutionData,
} from "./types.js";
import type { ListExecutionsQueryInput } from "../schemas/index.js";

// All columns in SELECT order — mirrors execution.executions exactly.
const EXECUTION_COLUMNS = `
  id, tenant_id, type, status, language, sandbox_type,
  plugin_id, pipeline_id, pipeline_run_id, hook_context, code_hash,
  started_at, completed_at, duration_ms, memory_peak_mb, exit_code,
  error_code, error_message, error_stack, trace_id, initiated_by, sandbox_vm_run
`;

export class ExecutionRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(data: CreateExecutionData): Promise<ExecutionRow> {
    const result = await this.pool.query<ExecutionRow>(
      `INSERT INTO execution.executions
         (tenant_id, type, language, sandbox_type, trace_id, initiated_by,
          plugin_id, pipeline_id, pipeline_run_id, hook_context,
          code_hash, sandbox_vm_run)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING ${EXECUTION_COLUMNS}`,
      [
        data.tenant_id,
        data.type,
        data.language,
        data.sandbox_type,
        data.trace_id,
        data.initiated_by,
        data.plugin_id ?? null,
        data.pipeline_id ?? null,
        data.pipeline_run_id ?? null,
        data.hook_context ?? false,
        data.code_hash ?? null,
        data.sandbox_vm_run ?? null,
      ]
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("INSERT INTO execution.executions returned no rows");
    }
    return row;
  }

  // Unscoped lookup by id — used internally to locate a row when tenant context
  // is not yet established (e.g., SSE connection setup before auth check).
  async findById(id: string): Promise<ExecutionRow | null> {
    const result = await this.pool.query<ExecutionRow>(
      `SELECT ${EXECUTION_COLUMNS}
         FROM execution.executions
        WHERE id = $1`,
      [id]
    );
    return result.rows[0] ?? null;
  }

  // Tenant-scoped lookup — returns null for cross-tenant access attempts.
  // The response is identical to not-found, preventing tenant existence leakage.
  async findByTenantAndId(
    tenantId: string,
    id: string
  ): Promise<ExecutionRow | null> {
    const result = await this.pool.query<ExecutionRow>(
      `SELECT ${EXECUTION_COLUMNS}
         FROM execution.executions
        WHERE id = $1
          AND tenant_id = $2`,
      [id, tenantId]
    );
    return result.rows[0] ?? null;
  }

  // Paginated list of executions for a tenant. Supports optional status and type
  // filters from the ListExecutionsQuery schema. Cursor is the execution id.
  async findByTenantId(
    tenantId: string,
    query: ListExecutionsQueryInput
  ): Promise<ExecutionRow[]> {
    const limit = query.limit;
    const conditions: string[] = ["tenant_id = $1"];
    const values: unknown[] = [tenantId];
    let idx = 2;

    const statusFilter = query["filter[status][eq]"];
    if (statusFilter !== undefined) {
      conditions.push(`status = $${idx++}`);
      values.push(statusFilter);
    }

    const typeFilter = query["filter[type][eq]"];
    if (typeFilter !== undefined) {
      conditions.push(`type = $${idx++}`);
      values.push(typeFilter);
    }

    // Cursor-based pagination: cursor is the id of the last seen execution.
    // Ordered by started_at DESC, id DESC to give newest-first results with
    // stable ordering when started_at values collide.
    if (query.cursor !== undefined) {
      // Resolve the started_at for the cursor row so we can use a keyset cursor
      // that works correctly across the partition boundary.
      const cursorRow = await this.pool.query<{ started_at: Date }>(
        `SELECT started_at FROM execution.executions WHERE id = $1 LIMIT 1`,
        [query.cursor]
      );
      const cursorStartedAt = cursorRow.rows[0]?.["started_at"];
      if (cursorStartedAt !== undefined) {
        conditions.push(
          `(started_at, id) < ($${idx++}::timestamptz, $${idx++}::uuid)`
        );
        values.push(cursorStartedAt, query.cursor);
      }
    }

    values.push(limit);

    const result = await this.pool.query<ExecutionRow>(
      `SELECT ${EXECUTION_COLUMNS}
         FROM execution.executions
        WHERE ${conditions.join(" AND ")}
        ORDER BY started_at DESC, id DESC
        LIMIT $${idx}`,
      values
    );
    return result.rows;
  }

  // Updates execution status and optional completion fields. Used when the
  // sandbox returns a result or the timeout timer fires.
  async updateStatus(
    id: string,
    data: UpdateExecutionData
  ): Promise<ExecutionRow | null> {
    const sets: string[] = ["status = $1"];
    const values: unknown[] = [data.status];
    let idx = 2;

    if (data.completion !== undefined) {
      const c = data.completion;

      sets.push(`completed_at = $${idx++}`);
      values.push(c.completed_at);

      sets.push(`duration_ms = $${idx++}`);
      values.push(c.duration_ms);

      sets.push(`exit_code = $${idx++}`);
      values.push(c.exit_code);

      // Spread pattern: only push optional completion fields when present,
      // so we never assign null to fields that should remain null from the DB
      // default and never violate exactOptionalPropertyTypes.
      if (c.memory_peak_mb !== undefined) {
        sets.push(`memory_peak_mb = $${idx++}`);
        values.push(c.memory_peak_mb);
      }
      if (c.error_code !== undefined) {
        sets.push(`error_code = $${idx++}`);
        values.push(c.error_code);
      }
      if (c.error_message !== undefined) {
        sets.push(`error_message = $${idx++}`);
        values.push(c.error_message);
      }
      if (c.error_stack !== undefined) {
        sets.push(`error_stack = $${idx++}`);
        values.push(c.error_stack);
      }
    }

    values.push(id);

    const result = await this.pool.query<ExecutionRow>(
      `UPDATE execution.executions
            SET ${sets.join(", ")}
          WHERE id = $${idx}
      RETURNING ${EXECUTION_COLUMNS}`,
      values
    );
    return result.rows[0] ?? null;
  }

  // Returns all in-flight (pending or running) executions for a plugin.
  // Used by the plugin drain sequence to identify which executions to wait for.
  async findByPluginId(pluginId: string): Promise<ExecutionRow[]> {
    const result = await this.pool.query<ExecutionRow>(
      `SELECT ${EXECUTION_COLUMNS}
         FROM execution.executions
        WHERE plugin_id = $1
          AND status IN ('pending', 'running')`,
      [pluginId]
    );
    return result.rows;
  }

  // Count of in-flight executions for a plugin.
  // Faster than findByPluginId when only the count is needed (drain check, metrics).
  async countInflightByPluginId(pluginId: string): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT count(*) AS count
         FROM execution.executions
        WHERE plugin_id = $1
          AND status IN ('pending', 'running')`,
      [pluginId]
    );
    const row = result.rows[0];
    return row !== undefined ? parseInt(row["count"], 10) : 0;
  }

  // Creates a new monthly partition for both executions and execution_logs
  // if it does not already exist. Called at service startup and at the start
  // of each calendar month (background partition-creation job).
  //
  // monthStart / monthEnd must be ISO date strings, e.g. '2026-09-01' / '2026-10-01'.
  // The partition name is derived from monthStart.
  async ensurePartition(monthStart: string, monthEnd: string): Promise<void> {
    // Validate the format before interpolating into DDL. Month boundaries must
    // be YYYY-MM-DD strings. Only digits and hyphens are accepted — anything
    // else would be a bug in the caller, not user input.
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    if (!datePattern.test(monthStart) || !datePattern.test(monthEnd)) {
      throw new Error(
        `ensurePartition: invalid date format — expected YYYY-MM-DD, got "${monthStart}" / "${monthEnd}"`
      );
    }

    // Derive a safe partition suffix from monthStart (e.g., '2026_09').
    // We've already validated the format above so this slice is safe.
    const suffix = monthStart.slice(0, 7).replace("-", "_");

    // DDL cannot be parameterized in Postgres; the values are validated above.
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS execution.executions_${suffix}
         PARTITION OF execution.executions
         FOR VALUES FROM ('${monthStart}') TO ('${monthEnd}')`
    );

    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS execution.execution_logs_${suffix}
         PARTITION OF execution.execution_logs
         FOR VALUES FROM ('${monthStart}') TO ('${monthEnd}')`
    );
  }
}
