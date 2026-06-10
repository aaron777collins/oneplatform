import { AppError } from "@oneplatform/core";

// ---------------------------------------------------------------------------
// Pipeline errors — design spec §16 error code registry
// ---------------------------------------------------------------------------

export class PipelineNotFoundError extends AppError {
  readonly code = "PIPELINE_NOT_FOUND" as const;
  readonly statusCode = 404;
}

export class PipelineInactiveError extends AppError {
  readonly code = "PIPELINE_INACTIVE" as const;
  readonly statusCode = 409;
}

// Cannot delete a pipeline with runs currently in pending/running state.
export class PipelineRunsActiveError extends AppError {
  readonly code = "PIPELINE_RUNS_ACTIVE" as const;
  readonly statusCode = 409;
}

// Definition validation failed: bad step references, cycles, SSRF, etc.
export class PipelineValidationError extends AppError {
  readonly code = "PIPELINE_DEFINITION_INVALID" as const;
  readonly statusCode = 422;
}

// A webhook step URL was rejected by the SSRF blocklist.
export class PipelineInvalidWebhookUrlError extends AppError {
  readonly code = "PIPELINE_INVALID_WEBHOOK_URL" as const;
  readonly statusCode = 422;
}

// allowConcurrentRuns=false and a run is already active.
export class PipelineConcurrentRunError extends AppError {
  readonly code = "PIPELINE_CONCURRENT_RUN_ACTIVE" as const;
  readonly statusCode = 409;
}

export class PipelineRunNotFoundError extends AppError {
  readonly code = "PIPELINE_RUN_NOT_FOUND" as const;
  readonly statusCode = 404;
}

// Cancel was requested on a run that is already in a terminal state.
export class PipelineRunTerminalError extends AppError {
  readonly code = "PIPELINE_RUN_ALREADY_TERMINAL" as const;
  readonly statusCode = 409;
}

export class ScheduleNotFoundError extends AppError {
  readonly code = "SCHEDULE_NOT_FOUND" as const;
  readonly statusCode = 404;
}

// Invalid or sub-minute cron expression (minimum granularity is 1 minute).
export class ScheduleInvalidCronError extends AppError {
  readonly code = "PIPELINE_CRON_INVALID" as const;
  readonly statusCode = 422;
}

export class TriggerNotFoundError extends AppError {
  readonly code = "TRIGGER_NOT_FOUND" as const;
  readonly statusCode = 404;
}

// The Execution Service returned a non-zero exit code or timeout for a step.
export class StepExecutionError extends AppError {
  readonly code = "STEP_EXECUTION_FAILED" as const;
  readonly statusCode = 502;
}

// Hook dispatch to the Execution Service failed or a critical hook returned error.
export class HookExecutionError extends AppError {
  readonly code = "PIPELINE_HOOK_CRITICAL_FAILURE" as const;
  readonly statusCode = 422;
}
