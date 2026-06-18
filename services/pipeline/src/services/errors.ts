import { AppError } from "@oneplatform/core";

// ---------------------------------------------------------------------------
// Pipeline errors — design spec §16 error code registry
// ---------------------------------------------------------------------------

export class PipelineNotFoundError extends AppError {
  readonly code = "PIPELINE_NOT_FOUND" as const;
  readonly statusCode = 404;
}

export class PipelineVersionNotFoundError extends AppError {
  readonly code = "PIPELINE_VERSION_NOT_FOUND" as const;
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

// Approval API errors — used in approval routes when re-raising errors from ApprovalService.

export class ApprovalNotFoundError extends AppError {
  readonly code = "APPROVAL_NOT_FOUND" as const;
  readonly statusCode = 404;
}

export class ApprovalUnauthorizedError extends AppError {
  readonly code = "APPROVAL_UNAUTHORIZED" as const;
  readonly statusCode = 403;
}

export class ApprovalAlreadyDecidedError extends AppError {
  readonly code = "APPROVAL_ALREADY_DECIDED" as const;
  readonly statusCode = 409;
}

// Wait step exceeded the 24-hour maximum or timeout cap.
export class WaitStepDurationError extends AppError {
  readonly code = "WAIT_STEP_DURATION_INVALID" as const;
  readonly statusCode = 422;
}

// ---------------------------------------------------------------------------
// Sub-workflow errors
// ---------------------------------------------------------------------------

// A sub-workflow step would exceed the maximum nesting depth of 5.
// Prevents runaway recursive pipeline invocations.
export class SubWorkflowDepthExceededError extends AppError {
  readonly code = "SUB_WORKFLOW_DEPTH_EXCEEDED" as const;
  readonly statusCode = 422;
}

// A sub-workflow step would create a circular call chain (A → … → A).
export class SubWorkflowCircularDependencyError extends AppError {
  readonly code = "SUB_WORKFLOW_CIRCULAR_DEPENDENCY" as const;
  readonly statusCode = 422;
}

// A sub-workflow step's referenced pipeline was not found or is inactive.
export class SubWorkflowPipelineNotFoundError extends AppError {
  readonly code = "SUB_WORKFLOW_PIPELINE_NOT_FOUND" as const;
  readonly statusCode = 404;
}

// A sub-workflow step waited beyond its timeout without the child completing.
export class SubWorkflowTimeoutError extends AppError {
  readonly code = "SUB_WORKFLOW_TIMEOUT" as const;
  readonly statusCode = 500;
}

// A sub-workflow child pipeline run completed in a failed or cancelled state.
export class SubWorkflowChildFailedError extends AppError {
  readonly code = "SUB_WORKFLOW_CHILD_FAILED" as const;
  readonly statusCode = 500;
}
