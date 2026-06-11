// Database row shapes for the execution schema.
// Column names mirror the SQL schema (snake_case) exactly — no transformation,
// so repository methods can return rows directly without a mapping step.
//
// Postgres driver (pg) behaviour:
//   - UUID columns arrive as string.
//   - TIMESTAMPTZ columns arrive as Date.
//   - INTEGER / REAL columns arrive as number | null.
//   - BOOLEAN columns arrive as boolean.
//   - JSONB columns arrive as the parsed value (object, array, etc.) | null.
//   - BIGSERIAL id in execution_logs arrives as number for typical row counts;
//     callers that store cursors must use string serialisation above ~2^53.

// ---------------------------------------------------------------------------
// execution.executions
// ---------------------------------------------------------------------------

export interface ExecutionRow {
  id: string;
  tenant_id: string;
  type: "code" | "connector-run" | "app-build" | "expression" | "plugin-drain";
  status: "pending" | "running" | "success" | "error" | "timeout" | "killed";
  language: "js" | "ts" | "python" | "go";
  sandbox_type: "isolated-vm" | "docker";
  plugin_id: string | null;
  pipeline_id: string | null;
  pipeline_run_id: string | null;
  hook_context: boolean;
  code_hash: string | null;
  started_at: Date;
  completed_at: Date | null;
  duration_ms: number | null;
  memory_peak_mb: number | null;
  exit_code: number | null;
  error_code: string | null;
  error_message: string | null;
  error_stack: string | null;
  trace_id: string;
  initiated_by: string;
  sandbox_vm_run: number | null;
}

// ---------------------------------------------------------------------------
// execution.execution_logs
// ---------------------------------------------------------------------------

export interface ExecutionLogRow {
  // BIGSERIAL — arrives as number from pg driver for typical row counts.
  id: number;
  execution_id: string;
  execution_date: Date;
  timestamp: Date;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  line_number: number;
  stream: "stdout" | "stderr";
  metadata: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Input types — create operations
// ---------------------------------------------------------------------------

export interface CreateExecutionData {
  tenant_id: string;
  type: "code" | "connector-run" | "app-build" | "expression" | "plugin-drain";
  language: "js" | "ts" | "python" | "go";
  sandbox_type: "isolated-vm" | "docker";
  trace_id: string;
  initiated_by: string;
  // Optional fields omitted from INSERT when absent (spread pattern required
  // per exactOptionalPropertyTypes — never assign undefined explicitly).
  plugin_id?: string;
  pipeline_id?: string;
  pipeline_run_id?: string;
  hook_context?: boolean;
  code_hash?: string;
  sandbox_vm_run?: number;
}

// Completion data supplied when transitioning to a terminal status.
export interface CompletionData {
  completed_at: Date;
  duration_ms: number;
  exit_code: number;
  memory_peak_mb?: number;
  error_code?: string;
  error_message?: string;
  error_stack?: string;
}

export interface UpdateExecutionData {
  status: "pending" | "running" | "success" | "error" | "timeout" | "killed";
  completion?: CompletionData;
}

export interface CreateExecutionLogData {
  execution_id: string;
  execution_date: Date;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  line_number: number;
  stream: "stdout" | "stderr";
  metadata?: Record<string, unknown>;
}
