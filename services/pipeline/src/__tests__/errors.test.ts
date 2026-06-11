// Unit tests for services/errors.ts
//
// Verifies all 13 pipeline error classes have the correct code, statusCode,
// message propagation, details payload propagation, AppError/Error inheritance,
// and correct name property.

import { describe, it, expect } from "vitest";
import { AppError } from "@oneplatform/core";
import {
  PipelineNotFoundError,
  PipelineInactiveError,
  PipelineRunsActiveError,
  PipelineValidationError,
  PipelineInvalidWebhookUrlError,
  PipelineConcurrentRunError,
  PipelineRunNotFoundError,
  PipelineRunTerminalError,
  ScheduleNotFoundError,
  ScheduleInvalidCronError,
  TriggerNotFoundError,
  StepExecutionError,
  HookExecutionError,
} from "../services/errors.js";

// ---------------------------------------------------------------------------
// Helper — generates standard contract tests for each error class
// ---------------------------------------------------------------------------

function assertErrorContract(
  ErrorClass: new (message: string) => AppError,
  expectedCode: string,
  expectedStatusCode: number,
): void {
  const message = `Test message for ${expectedCode}`;
  const err = new ErrorClass(message);

  it(`${ErrorClass.name} — code is '${expectedCode}'`, () => {
    expect(err.code).toBe(expectedCode);
  });

  it(`${ErrorClass.name} — statusCode is ${expectedStatusCode}`, () => {
    expect(err.statusCode).toBe(expectedStatusCode);
  });

  it(`${ErrorClass.name} — message is propagated`, () => {
    expect(err.message).toBe(message);
  });

  it(`${ErrorClass.name} — instanceof AppError`, () => {
    expect(err).toBeInstanceOf(AppError);
  });

  it(`${ErrorClass.name} — instanceof Error`, () => {
    expect(err).toBeInstanceOf(Error);
  });

  it(`${ErrorClass.name} — name matches constructor`, () => {
    expect(err.name).toBe(ErrorClass.name);
  });

  it(`${ErrorClass.name} — toApiError returns spec-compliant envelope`, () => {
    const envelope = err.toApiError("req-pipeline-test");
    expect(envelope).toMatchObject({
      error: {
        code: expectedCode,
        message,
        requestId: "req-pipeline-test",
      },
    });
  });
}

// ---------------------------------------------------------------------------
// 404 errors
// ---------------------------------------------------------------------------

describe("PipelineNotFoundError", () => {
  assertErrorContract(PipelineNotFoundError, "PIPELINE_NOT_FOUND", 404);
});

describe("PipelineRunNotFoundError", () => {
  assertErrorContract(PipelineRunNotFoundError, "PIPELINE_RUN_NOT_FOUND", 404);
});

describe("ScheduleNotFoundError", () => {
  assertErrorContract(ScheduleNotFoundError, "SCHEDULE_NOT_FOUND", 404);
});

describe("TriggerNotFoundError", () => {
  assertErrorContract(TriggerNotFoundError, "TRIGGER_NOT_FOUND", 404);
});

// ---------------------------------------------------------------------------
// 409 conflict errors
// ---------------------------------------------------------------------------

describe("PipelineInactiveError", () => {
  assertErrorContract(PipelineInactiveError, "PIPELINE_INACTIVE", 409);
});

describe("PipelineRunsActiveError", () => {
  assertErrorContract(PipelineRunsActiveError, "PIPELINE_RUNS_ACTIVE", 409);
});

describe("PipelineConcurrentRunError", () => {
  assertErrorContract(PipelineConcurrentRunError, "PIPELINE_CONCURRENT_RUN_ACTIVE", 409);
});

describe("PipelineRunTerminalError", () => {
  assertErrorContract(PipelineRunTerminalError, "PIPELINE_RUN_ALREADY_TERMINAL", 409);
});

// ---------------------------------------------------------------------------
// 422 validation errors
// ---------------------------------------------------------------------------

describe("PipelineValidationError", () => {
  assertErrorContract(PipelineValidationError, "PIPELINE_DEFINITION_INVALID", 422);
});

describe("PipelineInvalidWebhookUrlError", () => {
  assertErrorContract(PipelineInvalidWebhookUrlError, "PIPELINE_INVALID_WEBHOOK_URL", 422);
});

describe("ScheduleInvalidCronError", () => {
  assertErrorContract(ScheduleInvalidCronError, "PIPELINE_CRON_INVALID", 422);
});

describe("HookExecutionError", () => {
  assertErrorContract(HookExecutionError, "PIPELINE_HOOK_CRITICAL_FAILURE", 422);
});

// ---------------------------------------------------------------------------
// 502 execution error
// ---------------------------------------------------------------------------

describe("StepExecutionError", () => {
  assertErrorContract(StepExecutionError, "STEP_EXECUTION_FAILED", 500);
});

// ---------------------------------------------------------------------------
// Details payload propagation
// ---------------------------------------------------------------------------

describe("error details propagation", () => {
  it("PipelineNotFoundError carries details payload", () => {
    const details = { pipelineId: "pipe-abc", tenantId: "tenant-1" };
    const err = new PipelineNotFoundError("not found", details);
    expect(err.details).toEqual(details);
  });

  it("PipelineValidationError carries errors array in details", () => {
    const details = { errors: ["entryStepId not found", "cycle detected"] };
    const err = new PipelineValidationError("Invalid definition", details);
    expect(err.details).toEqual(details);
    const envelope = err.toApiError("req-x");
    expect(envelope.error.details).toEqual(details);
  });

  it("PipelineInvalidWebhookUrlError carries stepId and url in details", () => {
    const details = { stepId: "hook-1", url: "https://10.0.0.1/callback" };
    const err = new PipelineInvalidWebhookUrlError("SSRF blocked", details);
    expect(err.details).toEqual(details);
  });

  it("PipelineRunsActiveError carries activeRunCount in details", () => {
    const details = { pipelineId: "p-1", activeRunCount: 3 };
    const err = new PipelineRunsActiveError("Active runs exist", details);
    expect(err.details).toEqual(details);
  });

  it("PipelineConcurrentRunError carries pipelineId and activeRunCount", () => {
    const details = { pipelineId: "p-2", activeRunCount: 1 };
    const err = new PipelineConcurrentRunError("Concurrent run active", details);
    expect(err.details).toEqual(details);
  });

  it("ScheduleInvalidCronError carries cronExpr in details", () => {
    const details = { cronExpr: "0 0 0 * * *" };
    const err = new ScheduleInvalidCronError("Invalid cron", details);
    expect(err.details).toEqual(details);
  });

  it("StepExecutionError carries statusCode in details", () => {
    const details = { statusCode: 500, stepId: "code-step-1" };
    const err = new StepExecutionError("Execution failed", details);
    expect(err.details).toEqual(details);
  });

  it("PipelineRunTerminalError carries status in details", () => {
    const details = { runId: "run-1", status: "completed" as const };
    const err = new PipelineRunTerminalError("Already terminal", details);
    expect(err.details).toEqual(details);
  });

  it("HookExecutionError details appear in toApiError envelope", () => {
    const details = { hookId: "h-1", pluginId: "plugin-x" };
    const err = new HookExecutionError("Critical hook failed", details);
    const envelope = err.toApiError("req-hook-1");
    expect(envelope.error.details).toEqual(details);
  });

  it("error without details has no details key in envelope", () => {
    const err = new PipelineNotFoundError("Not found");
    const envelope = err.toApiError("req-y");
    expect(envelope.error).not.toHaveProperty("details");
  });
});

// ---------------------------------------------------------------------------
// Prototype chain integrity
// ---------------------------------------------------------------------------

describe("prototype chain integrity", () => {
  it("all 13 error classes pass instanceof AppError at runtime", () => {
    const instances: AppError[] = [
      new PipelineNotFoundError("e"),
      new PipelineInactiveError("e"),
      new PipelineRunsActiveError("e"),
      new PipelineValidationError("e"),
      new PipelineInvalidWebhookUrlError("e"),
      new PipelineConcurrentRunError("e"),
      new PipelineRunNotFoundError("e"),
      new PipelineRunTerminalError("e"),
      new ScheduleNotFoundError("e"),
      new ScheduleInvalidCronError("e"),
      new TriggerNotFoundError("e"),
      new StepExecutionError("e"),
      new HookExecutionError("e"),
    ];
    for (const instance of instances) {
      expect(instance).toBeInstanceOf(AppError);
      expect(instance).toBeInstanceOf(Error);
    }
  });

  it("instanceof check works correctly — PipelineNotFoundError is not PipelineRunNotFoundError", () => {
    const e = new PipelineNotFoundError("e");
    expect(e).toBeInstanceOf(PipelineNotFoundError);
    expect(e).not.toBeInstanceOf(PipelineRunNotFoundError);
    expect(e).not.toBeInstanceOf(ScheduleNotFoundError);
  });

  it("instanceof check works correctly — StepExecutionError is not HookExecutionError", () => {
    const e = new StepExecutionError("e");
    expect(e).toBeInstanceOf(StepExecutionError);
    expect(e).not.toBeInstanceOf(HookExecutionError);
  });
});

// ---------------------------------------------------------------------------
// Stack trace presence
// ---------------------------------------------------------------------------

describe("stack trace", () => {
  it("PipelineNotFoundError has a non-empty stack trace", () => {
    const err = new PipelineNotFoundError("test");
    expect(err.stack).toBeTruthy();
  });

  it("StepExecutionError stack trace contains the error class name", () => {
    const err = new StepExecutionError("test");
    expect(err.stack).toContain("StepExecutionError");
  });

  it("ScheduleInvalidCronError stack trace is defined", () => {
    const err = new ScheduleInvalidCronError("test");
    expect(typeof err.stack).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Code property is readonly (same value regardless of subclass instantiation)
// ---------------------------------------------------------------------------

describe("code property stability", () => {
  it("PipelineValidationError code is always PIPELINE_DEFINITION_INVALID", () => {
    const a = new PipelineValidationError("first");
    const b = new PipelineValidationError("second");
    expect(a.code).toBe("PIPELINE_DEFINITION_INVALID");
    expect(b.code).toBe("PIPELINE_DEFINITION_INVALID");
  });

  it("ScheduleNotFoundError code is always SCHEDULE_NOT_FOUND", () => {
    const err = new ScheduleNotFoundError("msg");
    expect(err.code).toBe("SCHEDULE_NOT_FOUND");
  });
});
