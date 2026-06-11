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

// The Execution Service returned a non-zero exit code for a step.
// 500 because the fault originates inside our own execution infrastructure,
// not from a downstream service the client controls.
export class StepExecutionError extends AppError {
  readonly code = "STEP_EXECUTION_FAILED" as const;
  readonly statusCode = 500;
}

// A step exceeded its configured execution timeout.
export class StepExecutionTimeoutError extends AppError {
  readonly code = "STEP_EXECUTION_TIMEOUT" as const;
  readonly statusCode = 500;
}

// Hook dispatch to the Execution Service failed or a critical hook returned error.
export class HookExecutionError extends AppError {
  readonly code = "PIPELINE_HOOK_CRITICAL_FAILURE" as const;
  readonly statusCode = 422;
}

// A hook attempted to trigger a pipeline run that would cause unbounded recursion.
export class HookRecursionError extends AppError {
  readonly code = "HOOK_RECURSION_ERROR" as const;
  readonly statusCode = 422;
}

// Webhook inbound trigger HMAC signature verification failed.
export class TriggerSignatureInvalidError extends AppError {
  readonly code = "TRIGGER_SIGNATURE_INVALID" as const;
  readonly statusCode = 401;
}
