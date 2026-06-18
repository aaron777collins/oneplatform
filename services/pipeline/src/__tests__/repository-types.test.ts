// Unit tests for repositories/types.ts
//
// Verifies the structural contract of every interface at runtime:
// correct key names (snake_case for rows, optional vs required fields),
// union literal values, nullable vs non-nullable fields, and camelCase
// write-input types.

import { describe, it, expect } from "vitest";
import type {
  PipelineRow,
  RunRow,
  RunStepRow,
  ScheduleRow,
  TriggerRow,
  RunLogRow,
  CreatePipelineData,
  UpdatePipelineData,
  CreateRunData,
  UpdateRunData,
  CreateRunStepData,
  UpdateRunStepData,
  CreateScheduleData,
  UpdateScheduleData,
  CreateTriggerData,
  CreateRunLogData,
} from "../repositories/types.js";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function hasKeys(obj: object, keys: string[]): boolean {
  return keys.every((k) => k in obj);
}

// ---------------------------------------------------------------------------
// PipelineRow
// ---------------------------------------------------------------------------

describe("PipelineRow", () => {
  const validRow: PipelineRow = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    tenant_id: "550e8400-e29b-41d4-a716-446655440001",
    name: "Test Pipeline",
    slug: "test-pipeline",
    description: null,
    definition: { version: 1, steps: [] },
    is_active: true,
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
    created_by: "user-001",
    current_version: 0,
  };

  it("has all required snake_case columns", () => {
    expect(
      hasKeys(validRow, [
        "id", "tenant_id", "name", "slug", "description",
        "definition", "is_active", "created_at", "updated_at", "created_by",
        "current_version",
      ]),
    ).toBe(true);
  });

  it("description can be null (no description set)", () => {
    const row: PipelineRow = { ...validRow, description: null };
    expect(row.description).toBeNull();
  });

  it("description can be a string", () => {
    const row: PipelineRow = { ...validRow, description: "A pipeline" };
    expect(row.description).toBe("A pipeline");
  });

  it("is_active is boolean", () => {
    expect(typeof validRow.is_active).toBe("boolean");
  });

  it("created_at is a Date", () => {
    expect(validRow.created_at).toBeInstanceOf(Date);
  });

  it("updated_at is a Date", () => {
    expect(validRow.updated_at).toBeInstanceOf(Date);
  });

  it("definition is a Record<string, unknown>", () => {
    const row: PipelineRow = { ...validRow, definition: { version: 1, steps: [{ id: "s1" }] } };
    expect(typeof row.definition).toBe("object");
  });
});

// ---------------------------------------------------------------------------
// RunRow
// ---------------------------------------------------------------------------

describe("RunRow", () => {
  const validRow: RunRow = {
    id: "run-001",
    pipeline_id: "pipe-001",
    tenant_id: "tenant-001",
    status: "pending",
    triggered_by: "manual",
    trigger_actor_id: null,
    trigger_meta: {},
    input: {},
    started_at: null,
    completed_at: null,
    error: null,
    bully_job_id: null,
    definition_snapshot: {},
    created_at: new Date("2026-01-01T00:00:00Z"),
  };

  it("has all required snake_case columns", () => {
    expect(
      hasKeys(validRow, [
        "id", "pipeline_id", "tenant_id", "status", "triggered_by",
        "trigger_actor_id", "trigger_meta", "input", "started_at",
        "completed_at", "error", "bully_job_id", "definition_snapshot", "created_at",
      ]),
    ).toBe(true);
  });

  it("status union accepts all 5 values", () => {
    const statuses: RunRow["status"][] = ["pending", "running", "completed", "failed", "cancelled"];
    for (const status of statuses) {
      const row: RunRow = { ...validRow, status };
      expect(row.status).toBe(status);
    }
  });

  it("triggered_by union accepts all 5 values", () => {
    const triggers: RunRow["triggered_by"][] = ["manual", "schedule", "event", "webhook", "service"];
    for (const triggered_by of triggers) {
      const row: RunRow = { ...validRow, triggered_by };
      expect(row.triggered_by).toBe(triggered_by);
    }
  });

  it("trigger_actor_id can be null or string", () => {
    const rowNull: RunRow = { ...validRow, trigger_actor_id: null };
    const rowStr: RunRow = { ...validRow, trigger_actor_id: "user-abc" };
    expect(rowNull.trigger_actor_id).toBeNull();
    expect(rowStr.trigger_actor_id).toBe("user-abc");
  });

  it("started_at can be null or Date", () => {
    const rowNull: RunRow = { ...validRow, started_at: null };
    const rowDate: RunRow = { ...validRow, started_at: new Date("2026-01-01T01:00:00Z") };
    expect(rowNull.started_at).toBeNull();
    expect(rowDate.started_at).toBeInstanceOf(Date);
  });

  it("completed_at can be null or Date", () => {
    const rowDate: RunRow = { ...validRow, completed_at: new Date("2026-01-01T02:00:00Z") };
    expect(rowDate.completed_at).toBeInstanceOf(Date);
  });

  it("error can be null or an object", () => {
    const rowErr: RunRow = {
      ...validRow,
      error: { code: "STEP_EXECUTION_FAILED", message: "step failed" },
    };
    expect(rowErr.error).not.toBeNull();
  });

  it("bully_job_id can be null or string", () => {
    const rowJob: RunRow = { ...validRow, bully_job_id: "bullmq-123" };
    expect(rowJob.bully_job_id).toBe("bullmq-123");
  });
});

// ---------------------------------------------------------------------------
// RunStepRow
// ---------------------------------------------------------------------------

describe("RunStepRow", () => {
  const validRow: RunStepRow = {
    id: "run-step-001",
    run_id: "run-001",
    tenant_id: "tenant-001",
    step_id: "step-1",
    step_name: "Code Step",
    step_type: "code",
    status: "pending",
    attempt_count: 0,
    started_at: null,
    completed_at: null,
    input: {},
    output: null,
    error: null,
    execution_id: null,
    created_at: new Date("2026-01-01T00:00:00Z"),
  };

  it("has all required snake_case columns", () => {
    expect(
      hasKeys(validRow, [
        "id", "run_id", "tenant_id", "step_id", "step_name", "step_type",
        "status", "attempt_count", "started_at", "completed_at",
        "input", "output", "error", "execution_id", "created_at",
      ]),
    ).toBe(true);
  });

  it("step_type union accepts all 6 values", () => {
    const types: RunStepRow["step_type"][] = [
      "code", "connector", "transformer", "conditional", "parallel", "webhook",
    ];
    for (const step_type of types) {
      const row: RunStepRow = { ...validRow, step_type };
      expect(row.step_type).toBe(step_type);
    }
  });

  it("status union accepts all 6 values (including skipped and cancelled)", () => {
    const statuses: RunStepRow["status"][] = [
      "pending", "running", "completed", "failed", "skipped", "cancelled",
    ];
    for (const status of statuses) {
      const row: RunStepRow = { ...validRow, status };
      expect(row.status).toBe(status);
    }
  });

  it("attempt_count is a number", () => {
    expect(typeof validRow.attempt_count).toBe("number");
  });

  it("execution_id can be null or string", () => {
    const rowExec: RunStepRow = { ...validRow, execution_id: "exec-abc" };
    expect(rowExec.execution_id).toBe("exec-abc");
    expect(validRow.execution_id).toBeNull();
  });

  it("output can be null or a record", () => {
    const rowOut: RunStepRow = { ...validRow, output: { result: "ok" } };
    expect(rowOut.output).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ScheduleRow
// ---------------------------------------------------------------------------

describe("ScheduleRow", () => {
  const validRow: ScheduleRow = {
    id: "sched-001",
    pipeline_id: "pipe-001",
    tenant_id: "tenant-001",
    cron_expr: "0 * * * *",
    timezone: "UTC",
    enabled: true,
    input_template: {},
    last_run_at: null,
    next_run_at: new Date("2026-01-01T01:00:00Z"),
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
  };

  it("has all required snake_case columns", () => {
    expect(
      hasKeys(validRow, [
        "id", "pipeline_id", "tenant_id", "cron_expr", "timezone",
        "enabled", "input_template", "last_run_at", "next_run_at",
        "created_at", "updated_at",
      ]),
    ).toBe(true);
  });

  it("enabled is a boolean", () => {
    expect(typeof validRow.enabled).toBe("boolean");
  });

  it("last_run_at can be null", () => {
    expect(validRow.last_run_at).toBeNull();
  });

  it("last_run_at can be a Date when set", () => {
    const row: ScheduleRow = { ...validRow, last_run_at: new Date("2026-01-01T00:30:00Z") };
    expect(row.last_run_at).toBeInstanceOf(Date);
  });

  it("next_run_at can be null", () => {
    const row: ScheduleRow = { ...validRow, next_run_at: null };
    expect(row.next_run_at).toBeNull();
  });

  it("next_run_at can be a Date", () => {
    expect(validRow.next_run_at).toBeInstanceOf(Date);
  });

  it("input_template is a Record<string, unknown>", () => {
    const row: ScheduleRow = { ...validRow, input_template: { batchSize: 100 } };
    expect(row.input_template["batchSize"]).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// TriggerRow
// ---------------------------------------------------------------------------

describe("TriggerRow", () => {
  const validRow: TriggerRow = {
    id: "trigger-001",
    pipeline_id: "pipe-001",
    tenant_id: "tenant-001",
    trigger_type: "event",
    config: { eventType: "entity.created" },
    enabled: true,
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
  };

  it("has all required snake_case columns", () => {
    expect(
      hasKeys(validRow, [
        "id", "pipeline_id", "tenant_id", "trigger_type", "config",
        "enabled", "created_at", "updated_at",
      ]),
    ).toBe(true);
  });

  it("trigger_type union accepts 'event'", () => {
    const row: TriggerRow = { ...validRow, trigger_type: "event" };
    expect(row.trigger_type).toBe("event");
  });

  it("trigger_type union accepts 'webhook'", () => {
    const row: TriggerRow = { ...validRow, trigger_type: "webhook" };
    expect(row.trigger_type).toBe("webhook");
  });

  it("config is a Record<string, unknown>", () => {
    const row: TriggerRow = { ...validRow, config: { url: "https://example.com", secret: "abc" } };
    expect(row.config["url"]).toBe("https://example.com");
  });
});

// ---------------------------------------------------------------------------
// RunLogRow
// ---------------------------------------------------------------------------

describe("RunLogRow", () => {
  const validRow: RunLogRow = {
    id: 1,
    run_id: "run-001",
    tenant_id: "tenant-001",
    step_id: null,
    level: "info",
    message: "Pipeline run started",
    details: null,
    created_at: new Date("2026-01-01T00:00:00Z"),
  };

  it("has all required snake_case columns", () => {
    expect(
      hasKeys(validRow, [
        "id", "run_id", "tenant_id", "step_id", "level",
        "message", "details", "created_at",
      ]),
    ).toBe(true);
  });

  it("id is a number (BIGSERIAL)", () => {
    expect(typeof validRow.id).toBe("number");
  });

  it("level union accepts all 4 log levels", () => {
    const levels: RunLogRow["level"][] = ["debug", "info", "warn", "error"];
    for (const level of levels) {
      const row: RunLogRow = { ...validRow, level };
      expect(row.level).toBe(level);
    }
  });

  it("step_id can be null (pipeline-level log, not step-specific)", () => {
    expect(validRow.step_id).toBeNull();
  });

  it("step_id can be a string", () => {
    const row: RunLogRow = { ...validRow, step_id: "step-1" };
    expect(row.step_id).toBe("step-1");
  });

  it("details can be null", () => {
    expect(validRow.details).toBeNull();
  });

  it("details can be a Record<string, unknown>", () => {
    const row: RunLogRow = { ...validRow, details: { latencyMs: 120, stepId: "step-1" } };
    expect(row.details).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CreatePipelineData
// ---------------------------------------------------------------------------

describe("CreatePipelineData", () => {
  const validData: CreatePipelineData = {
    tenant_id: "tenant-001",
    name: "My Pipeline",
    slug: "my-pipeline",
    definition: { version: 1 },
    created_by: "user-001",
  };

  it("accepts minimal required fields", () => {
    expect(validData.tenant_id).toBeDefined();
    expect(validData.name).toBeDefined();
    expect(validData.slug).toBeDefined();
  });

  it("description is optional", () => {
    const withDesc: CreatePipelineData = { ...validData, description: "A desc" };
    expect(withDesc.description).toBe("A desc");
    // without description — no property set
    const noDesc: CreatePipelineData = { ...validData };
    expect(noDesc.description).toBeUndefined();
  });

  it("is_active is optional", () => {
    const withActive: CreatePipelineData = { ...validData, is_active: false };
    expect(withActive.is_active).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// UpdatePipelineData
// ---------------------------------------------------------------------------

describe("UpdatePipelineData", () => {
  it("accepts empty object (all fields optional)", () => {
    const data: UpdatePipelineData = {};
    expect(data.name).toBeUndefined();
    expect(data.is_active).toBeUndefined();
  });

  it("description can be null to clear it", () => {
    const data: UpdatePipelineData = { description: null };
    expect(data.description).toBeNull();
  });

  it("description can be a string", () => {
    const data: UpdatePipelineData = { description: "Updated" };
    expect(data.description).toBe("Updated");
  });
});

// ---------------------------------------------------------------------------
// CreateRunData
// ---------------------------------------------------------------------------

describe("CreateRunData", () => {
  const validData: CreateRunData = {
    pipeline_id: "pipe-001",
    tenant_id: "tenant-001",
    triggered_by: "manual",
    definition_snapshot: {},
  };

  it("accepts minimal required fields", () => {
    expect(validData.pipeline_id).toBeDefined();
    expect(validData.triggered_by).toBe("manual");
  });

  it("triggered_by union covers all 5 values", () => {
    const triggers: CreateRunData["triggered_by"][] = ["manual", "schedule", "event", "webhook", "service"];
    for (const triggered_by of triggers) {
      const data: CreateRunData = { ...validData, triggered_by };
      expect(data.triggered_by).toBe(triggered_by);
    }
  });

  it("trigger_actor_id is optional", () => {
    const data: CreateRunData = { ...validData, trigger_actor_id: "user-123" };
    expect(data.trigger_actor_id).toBe("user-123");
  });

  it("bully_job_id is optional", () => {
    const data: CreateRunData = { ...validData, bully_job_id: "job-abc" };
    expect(data.bully_job_id).toBe("job-abc");
  });
});

// ---------------------------------------------------------------------------
// UpdateRunData
// ---------------------------------------------------------------------------

describe("UpdateRunData", () => {
  it("accepts empty object (all fields optional)", () => {
    const data: UpdateRunData = {};
    expect(data.status).toBeUndefined();
  });

  it("status union covers all 5 values", () => {
    const statuses = ["pending", "running", "completed", "failed", "cancelled"] as const;
    for (const status of statuses) {
      const data: UpdateRunData = { status };
      expect(data.status).toBe(status);
    }
  });

  it("error can be null to clear error field", () => {
    const data: UpdateRunData = { error: null };
    expect(data.error).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CreateRunStepData
// ---------------------------------------------------------------------------

describe("CreateRunStepData", () => {
  const validData: CreateRunStepData = {
    run_id: "run-001",
    tenant_id: "tenant-001",
    step_id: "step-1",
    step_name: "Code Step",
    step_type: "code",
  };

  it("accepts minimal required fields", () => {
    expect(validData.step_type).toBe("code");
  });

  it("step_type union covers all 6 values", () => {
    const types: CreateRunStepData["step_type"][] = [
      "code", "connector", "transformer", "conditional", "parallel", "webhook",
    ];
    for (const step_type of types) {
      const data: CreateRunStepData = { ...validData, step_type };
      expect(data.step_type).toBe(step_type);
    }
  });

  it("input is optional", () => {
    const data: CreateRunStepData = { ...validData, input: { key: "val" } };
    expect(data.input).toEqual({ key: "val" });
  });
});

// ---------------------------------------------------------------------------
// CreateScheduleData
// ---------------------------------------------------------------------------

describe("CreateScheduleData", () => {
  const validData: CreateScheduleData = {
    pipeline_id: "pipe-001",
    tenant_id: "tenant-001",
    cron_expr: "0 * * * *",
  };

  it("accepts minimal required fields", () => {
    expect(validData.cron_expr).toBe("0 * * * *");
  });

  it("timezone is optional", () => {
    const data: CreateScheduleData = { ...validData, timezone: "America/Chicago" };
    expect(data.timezone).toBe("America/Chicago");
  });

  it("enabled is optional", () => {
    const data: CreateScheduleData = { ...validData, enabled: false };
    expect(data.enabled).toBe(false);
  });

  it("next_run_at is optional and accepts a Date", () => {
    const dt = new Date("2026-02-01T00:00:00Z");
    const data: CreateScheduleData = { ...validData, next_run_at: dt };
    expect(data.next_run_at).toBe(dt);
  });
});

// ---------------------------------------------------------------------------
// UpdateScheduleData
// ---------------------------------------------------------------------------

describe("UpdateScheduleData", () => {
  it("accepts empty object (all fields optional)", () => {
    const data: UpdateScheduleData = {};
    expect(data.cron_expr).toBeUndefined();
  });

  it("last_run_at accepts a Date", () => {
    const dt = new Date("2026-01-15T12:00:00Z");
    const data: UpdateScheduleData = { last_run_at: dt };
    expect(data.last_run_at).toBe(dt);
  });
});

// ---------------------------------------------------------------------------
// CreateTriggerData
// ---------------------------------------------------------------------------

describe("CreateTriggerData", () => {
  const validData: CreateTriggerData = {
    pipeline_id: "pipe-001",
    tenant_id: "tenant-001",
    trigger_type: "event",
    config: { eventType: "entity.created" },
  };

  it("accepts minimal required fields", () => {
    expect(validData.trigger_type).toBe("event");
  });

  it("trigger_type union accepts 'event' and 'webhook'", () => {
    const types: CreateTriggerData["trigger_type"][] = ["event", "webhook"];
    for (const trigger_type of types) {
      const data: CreateTriggerData = { ...validData, trigger_type };
      expect(data.trigger_type).toBe(trigger_type);
    }
  });

  it("enabled is optional", () => {
    const data: CreateTriggerData = { ...validData, enabled: false };
    expect(data.enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CreateRunLogData
// ---------------------------------------------------------------------------

describe("CreateRunLogData", () => {
  const validData: CreateRunLogData = {
    run_id: "run-001",
    tenant_id: "tenant-001",
    level: "info",
    message: "Pipeline started",
  };

  it("accepts minimal required fields", () => {
    expect(validData.level).toBe("info");
    expect(validData.message).toBeDefined();
  });

  it("level union covers all 4 log levels", () => {
    const levels: CreateRunLogData["level"][] = ["debug", "info", "warn", "error"];
    for (const level of levels) {
      const data: CreateRunLogData = { ...validData, level };
      expect(data.level).toBe(level);
    }
  });

  it("step_id is optional", () => {
    const data: CreateRunLogData = { ...validData, step_id: "step-1" };
    expect(data.step_id).toBe("step-1");
  });

  it("details is optional and accepts a Record", () => {
    const data: CreateRunLogData = { ...validData, details: { latencyMs: 50 } };
    expect(data.details?.["latencyMs"]).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// Cross-type consistency checks
// ---------------------------------------------------------------------------

describe("cross-type consistency", () => {
  it("RunRow.status union matches UpdateRunData.status union", () => {
    const runStatus: RunRow["status"] = "cancelled";
    const updateStatus: UpdateRunData["status"] = runStatus;
    expect(updateStatus).toBe("cancelled");
  });

  it("RunStepRow.step_type union matches CreateRunStepData.step_type union", () => {
    const rowType: RunStepRow["step_type"] = "webhook";
    const createType: CreateRunStepData["step_type"] = rowType;
    expect(createType).toBe("webhook");
  });

  it("RunLogRow.level union matches CreateRunLogData.level union", () => {
    const rowLevel: RunLogRow["level"] = "error";
    const createLevel: CreateRunLogData["level"] = rowLevel;
    expect(createLevel).toBe("error");
  });

  it("TriggerRow.trigger_type union matches CreateTriggerData.trigger_type union", () => {
    const rowType: TriggerRow["trigger_type"] = "webhook";
    const createType: CreateTriggerData["trigger_type"] = rowType;
    expect(createType).toBe("webhook");
  });

  it("RunRow has snake_case keys (no camelCase leakage)", () => {
    const row: RunRow = {
      id: "r", pipeline_id: "p", tenant_id: "t", status: "pending",
      triggered_by: "manual", trigger_actor_id: null, trigger_meta: {},
      input: {}, started_at: null, completed_at: null, error: null,
      bully_job_id: null, definition_snapshot: {}, created_at: new Date(),
    };
    expect("pipelineId" in row).toBe(false);
    expect("tenantId" in row).toBe(false);
    expect("triggeredBy" in row).toBe(false);
  });
});
