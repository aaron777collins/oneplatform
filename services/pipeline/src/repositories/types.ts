// Database row shapes for the pipeline schema.
// Column names mirror the SQL schema (snake_case) exactly — no transformation,
// so repository methods can return them directly.
// Row types use Date for timestamptz and string for uuid (pg driver behaviour).
// BIGSERIAL id columns arrive as number from pg when values fit in a 32-bit safe
// integer, but at high volume they exceed Number.MAX_SAFE_INTEGER, so id is typed
// as number here and callers that persist cursors should use string serialisation.

// ---------------------------------------------------------------------------
// pipeline.pipelines
// ---------------------------------------------------------------------------

export interface PipelineRow {
  id: string;
  tenant_id: string;
  name: string;
  slug: string;
  description: string | null;
  definition: Record<string, unknown>;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
  created_by: string;
  // Monotonically increasing counter; 0 until the first update is applied.
  current_version: number;
}

// ---------------------------------------------------------------------------
// pipeline.pipeline_versions
// ---------------------------------------------------------------------------

export interface PipelineVersionRow {
  id: string;
  pipeline_id: string;
  tenant_id: string;
  version_number: number;
  definition_snapshot: Record<string, unknown>;
  name_at_version: string;
  description_at_version: string | null;
  created_at: Date;
  created_by: string;
}

// ---------------------------------------------------------------------------
// pipeline.runs
// ---------------------------------------------------------------------------

export interface RunRow {
  id: string;
  pipeline_id: string;
  tenant_id: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  triggered_by: "manual" | "schedule" | "event" | "webhook" | "service";
  trigger_actor_id: string | null;
  trigger_meta: Record<string, unknown>;
  input: Record<string, unknown>;
  started_at: Date | null;
  completed_at: Date | null;
  error: Record<string, unknown> | null;
  bully_job_id: string | null;
  definition_snapshot: Record<string, unknown>;
  created_at: Date;
}

// ---------------------------------------------------------------------------
// pipeline.run_steps
// ---------------------------------------------------------------------------

export interface RunStepRow {
  id: string;
  run_id: string;
  tenant_id: string;
  step_id: string;
  step_name: string;
  step_type:
    | "code"
    | "connector"
    | "transformer"
    | "conditional"
    | "parallel"
    | "webhook";
  status:
    | "pending"
    | "running"
    | "completed"
    | "failed"
    | "skipped"
    | "cancelled";
  attempt_count: number;
  started_at: Date | null;
  completed_at: Date | null;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  execution_id: string | null;
  created_at: Date;
}

// ---------------------------------------------------------------------------
// pipeline.schedules
// ---------------------------------------------------------------------------

export interface ScheduleRow {
  id: string;
  pipeline_id: string;
  tenant_id: string;
  cron_expr: string;
  timezone: string;
  enabled: boolean;
  input_template: Record<string, unknown>;
  last_run_at: Date | null;
  next_run_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

// ---------------------------------------------------------------------------
// pipeline.triggers
// ---------------------------------------------------------------------------

export interface TriggerRow {
  id: string;
  pipeline_id: string;
  tenant_id: string;
  trigger_type: "event" | "webhook";
  config: Record<string, unknown>;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

// ---------------------------------------------------------------------------
// pipeline.run_logs
// ---------------------------------------------------------------------------

export interface RunLogRow {
  // BIGSERIAL — arrives as number from pg driver for typical row counts.
  id: number;
  run_id: string;
  tenant_id: string;
  step_id: string | null;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  details: Record<string, unknown> | null;
  created_at: Date;
}

// ---------------------------------------------------------------------------
// Input types — create operations
// ---------------------------------------------------------------------------

export interface CreatePipelineData {
  tenant_id: string;
  name: string;
  slug: string;
  description?: string;
  definition: Record<string, unknown>;
  is_active?: boolean;
  created_by: string;
}

export interface UpdatePipelineData {
  name?: string;
  // null explicitly clears description; undefined means do not touch it.
  description?: string | null;
  definition?: Record<string, unknown>;
  is_active?: boolean;
}

export interface CreateRunData {
  pipeline_id: string;
  tenant_id: string;
  triggered_by: "manual" | "schedule" | "event" | "webhook" | "service";
  trigger_actor_id?: string;
  trigger_meta?: Record<string, unknown>;
  input?: Record<string, unknown>;
  bully_job_id?: string;
  definition_snapshot: Record<string, unknown>;
}

export interface UpdateRunData {
  status?: "pending" | "running" | "completed" | "failed" | "cancelled";
  started_at?: Date;
  completed_at?: Date;
  error?: Record<string, unknown> | null;
  bully_job_id?: string;
}

export interface CreateRunStepData {
  run_id: string;
  tenant_id: string;
  step_id: string;
  step_name: string;
  step_type:
    | "code"
    | "connector"
    | "transformer"
    | "conditional"
    | "parallel"
    | "webhook";
  input?: Record<string, unknown>;
}

export interface UpdateRunStepData {
  status?:
    | "pending"
    | "running"
    | "completed"
    | "failed"
    | "skipped"
    | "cancelled";
  started_at?: Date;
  completed_at?: Date;
  output?: Record<string, unknown> | null;
  error?: Record<string, unknown> | null;
  execution_id?: string;
  attempt_count?: number;
}

export interface CreateScheduleData {
  pipeline_id: string;
  tenant_id: string;
  cron_expr: string;
  timezone?: string;
  enabled?: boolean;
  input_template?: Record<string, unknown>;
  next_run_at?: Date;
}

export interface UpdateScheduleData {
  cron_expr?: string;
  timezone?: string;
  enabled?: boolean;
  input_template?: Record<string, unknown>;
  next_run_at?: Date;
  last_run_at?: Date;
}

export interface CreateTriggerData {
  pipeline_id: string;
  tenant_id: string;
  trigger_type: "event" | "webhook";
  config: Record<string, unknown>;
  enabled?: boolean;
}

export interface CreateRunLogData {
  run_id: string;
  tenant_id: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  step_id?: string;
  details?: Record<string, unknown>;
}

export interface CreatePipelineVersionData {
  pipeline_id: string;
  tenant_id: string;
  version_number: number;
  definition_snapshot: Record<string, unknown>;
  name_at_version: string;
  description_at_version?: string | null;
  created_by: string;
}
