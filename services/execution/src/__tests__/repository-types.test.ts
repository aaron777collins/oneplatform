// Unit tests for repositories/types.ts
//
// Verifies the structural contract of every interface: correct key names
// (snake_case for rows), union literal values, nullable vs non-nullable
// fields, and optional fields in write-input types.

import { describe, it, expect } from "vitest";
import type {
  ExecutionRow,
  ExecutionLogRow,
  CreateExecutionData,
  UpdateExecutionData,
  CompletionData,
  CreateExecutionLogData,
} from "../repositories/types.js";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function hasKeys(obj: object, keys: string[]): boolean {
  return keys.every((k) => k in obj);
}

// ---------------------------------------------------------------------------
// ExecutionRow
// ---------------------------------------------------------------------------

describe("ExecutionRow — shape", () => {
  const validRow: ExecutionRow = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    tenant_id: "550e8400-e29b-41d4-a716-446655440001",
    type: "code",
    status: "pending",
    language: "js",
    sandbox_type: "isolated-vm",
    plugin_id: null,
    pipeline_id: null,
    pipeline_run_id: null,
    hook_context: false,
    code_hash: null,
    started_at: new Date("2026-01-01T00:00:00Z"),
    completed_at: null,
    duration_ms: null,
    memory_peak_mb: null,
    exit_code: null,
    error_code: null,
    error_message: null,
    error_stack: null,
    trace_id: "trace-abc",
    initiated_by: "user-001",
    sandbox_vm_run: null,
  };

  it("has all required snake_case columns", () => {
    expect(
      hasKeys(validRow, [
        "id", "tenant_id", "type", "status", "language", "sandbox_type",
        "plugin_id", "pipeline_id", "pipeline_run_id", "hook_context", "code_hash",
        "started_at", "completed_at", "duration_ms", "memory_peak_mb", "exit_code",
        "error_code", "error_message", "error_stack", "trace_id", "initiated_by",
        "sandbox_vm_run",
      ]),
    ).toBe(true);
  });

  it("type union accepts all 5 values", () => {
    const types: ExecutionRow["type"][] = [
      "code", "connector-run", "app-build", "expression", "plugin-drain",
    ];
    for (const type of types) {
      const row: ExecutionRow = { ...validRow, type };
      expect(row.type).toBe(type);
    }
  });

  it("status union accepts all 6 values", () => {
    const statuses: ExecutionRow["status"][] = [
      "pending", "running", "success", "error", "timeout", "killed",
    ];
    for (const status of statuses) {
      const row: ExecutionRow = { ...validRow, status };
      expect(row.status).toBe(status);
    }
  });

  it("language union accepts all 4 values", () => {
    const languages: ExecutionRow["language"][] = ["js", "ts", "python", "go"];
    for (const language of languages) {
      const row: ExecutionRow = { ...validRow, language };
      expect(row.language).toBe(language);
    }
  });

  it("sandbox_type union accepts isolated-vm and docker", () => {
    const sandboxTypes: ExecutionRow["sandbox_type"][] = ["isolated-vm", "docker"];
    for (const sandbox_type of sandboxTypes) {
      const row: ExecutionRow = { ...validRow, sandbox_type };
      expect(row.sandbox_type).toBe(sandbox_type);
    }
  });

  it("hook_context is boolean", () => {
    expect(typeof validRow.hook_context).toBe("boolean");
  });

  it("hook_context can be true", () => {
    const row: ExecutionRow = { ...validRow, hook_context: true };
    expect(row.hook_context).toBe(true);
  });

  it("plugin_id can be null or string", () => {
    expect(validRow.plugin_id).toBeNull();
    const row: ExecutionRow = { ...validRow, plugin_id: "plugin-abc" };
    expect(row.plugin_id).toBe("plugin-abc");
  });

  it("pipeline_id can be null or string", () => {
    expect(validRow.pipeline_id).toBeNull();
    const row: ExecutionRow = { ...validRow, pipeline_id: "pipe-001" };
    expect(row.pipeline_id).toBe("pipe-001");
  });

  it("pipeline_run_id can be null or string", () => {
    expect(validRow.pipeline_run_id).toBeNull();
    const row: ExecutionRow = { ...validRow, pipeline_run_id: "run-001" };
    expect(row.pipeline_run_id).toBe("run-001");
  });

  it("code_hash can be null or string", () => {
    expect(validRow.code_hash).toBeNull();
    const row: ExecutionRow = { ...validRow, code_hash: "sha256:abc" };
    expect(row.code_hash).toBe("sha256:abc");
  });

  it("started_at is a Date", () => {
    expect(validRow.started_at).toBeInstanceOf(Date);
  });

  it("completed_at can be null or Date", () => {
    expect(validRow.completed_at).toBeNull();
    const row: ExecutionRow = { ...validRow, completed_at: new Date("2026-01-01T01:00:00Z") };
    expect(row.completed_at).toBeInstanceOf(Date);
  });

  it("duration_ms can be null or number", () => {
    expect(validRow.duration_ms).toBeNull();
    const row: ExecutionRow = { ...validRow, duration_ms: 1500 };
    expect(row.duration_ms).toBe(1500);
  });

  it("memory_peak_mb can be null or number", () => {
    expect(validRow.memory_peak_mb).toBeNull();
    const row: ExecutionRow = { ...validRow, memory_peak_mb: 64.5 };
    expect(row.memory_peak_mb).toBe(64.5);
  });

  it("exit_code can be null or number", () => {
    expect(validRow.exit_code).toBeNull();
    const row: ExecutionRow = { ...validRow, exit_code: 0 };
    expect(row.exit_code).toBe(0);
  });

  it("error_code can be null or string", () => {
    expect(validRow.error_code).toBeNull();
    const row: ExecutionRow = { ...validRow, error_code: "EXECUTION_TIMEOUT" };
    expect(row.error_code).toBe("EXECUTION_TIMEOUT");
  });

  it("error_message can be null or string", () => {
    expect(validRow.error_message).toBeNull();
    const row: ExecutionRow = { ...validRow, error_message: "Timed out after 30000ms" };
    expect(row.error_message).toBe("Timed out after 30000ms");
  });

  it("error_stack can be null or string", () => {
    expect(validRow.error_stack).toBeNull();
    const row: ExecutionRow = { ...validRow, error_stack: "Error: ...\n  at ..." };
    expect(typeof row.error_stack).toBe("string");
  });

  it("sandbox_vm_run can be null or number", () => {
    expect(validRow.sandbox_vm_run).toBeNull();
    const row: ExecutionRow = { ...validRow, sandbox_vm_run: 42 };
    expect(row.sandbox_vm_run).toBe(42);
  });

  it("has no camelCase keys", () => {
    expect("tenantId" in validRow).toBe(false);
    expect("pluginId" in validRow).toBe(false);
    expect("startedAt" in validRow).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ExecutionLogRow
// ---------------------------------------------------------------------------

describe("ExecutionLogRow — shape", () => {
  const validRow: ExecutionLogRow = {
    id: 1,
    execution_id: "exec-001",
    execution_date: new Date("2026-01-01T00:00:00Z"),
    timestamp: new Date("2026-01-01T00:00:01Z"),
    level: "info",
    message: "Hello from sandbox",
    line_number: 1,
    stream: "stdout",
    metadata: null,
  };

  it("has all required snake_case columns", () => {
    expect(
      hasKeys(validRow, [
        "id", "execution_id", "execution_date", "timestamp",
        "level", "message", "line_number", "stream", "metadata",
      ]),
    ).toBe(true);
  });

  it("id is a number (BIGSERIAL)", () => {
    expect(typeof validRow.id).toBe("number");
  });

  it("level union accepts all 4 log levels", () => {
    const levels: ExecutionLogRow["level"][] = ["debug", "info", "warn", "error"];
    for (const level of levels) {
      const row: ExecutionLogRow = { ...validRow, level };
      expect(row.level).toBe(level);
    }
  });

  it("stream union accepts stdout and stderr", () => {
    const streams: ExecutionLogRow["stream"][] = ["stdout", "stderr"];
    for (const stream of streams) {
      const row: ExecutionLogRow = { ...validRow, stream };
      expect(row.stream).toBe(stream);
    }
  });

  it("execution_date is a Date", () => {
    expect(validRow.execution_date).toBeInstanceOf(Date);
  });

  it("timestamp is a Date", () => {
    expect(validRow.timestamp).toBeInstanceOf(Date);
  });

  it("metadata can be null", () => {
    expect(validRow.metadata).toBeNull();
  });

  it("metadata can be a Record<string, unknown>", () => {
    const row: ExecutionLogRow = {
      ...validRow,
      metadata: { requestId: "req-1", latencyMs: 50 },
    };
    expect(row.metadata).not.toBeNull();
    expect(row.metadata?.["requestId"]).toBe("req-1");
  });

  it("line_number is a number", () => {
    expect(typeof validRow.line_number).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// CreateExecutionData
// ---------------------------------------------------------------------------

describe("CreateExecutionData — shape", () => {
  const validData: CreateExecutionData = {
    tenant_id: "tenant-001",
    type: "code",
    language: "js",
    sandbox_type: "isolated-vm",
    trace_id: "trace-abc",
    initiated_by: "user-001",
  };

  it("accepts minimal required fields", () => {
    expect(validData.tenant_id).toBeDefined();
    expect(validData.type).toBeDefined();
    expect(validData.language).toBeDefined();
    expect(validData.sandbox_type).toBeDefined();
    expect(validData.trace_id).toBeDefined();
    expect(validData.initiated_by).toBeDefined();
  });

  it("plugin_id is optional", () => {
    const data: CreateExecutionData = { ...validData, plugin_id: "plugin-abc" };
    expect(data.plugin_id).toBe("plugin-abc");
    const noPlugin: CreateExecutionData = { ...validData };
    expect(noPlugin.plugin_id).toBeUndefined();
  });

  it("pipeline_id is optional", () => {
    const data: CreateExecutionData = { ...validData, pipeline_id: "pipe-001" };
    expect(data.pipeline_id).toBe("pipe-001");
  });

  it("pipeline_run_id is optional", () => {
    const data: CreateExecutionData = { ...validData, pipeline_run_id: "run-001" };
    expect(data.pipeline_run_id).toBe("run-001");
  });

  it("hook_context is optional and defaults to absent", () => {
    const noHook: CreateExecutionData = { ...validData };
    expect(noHook.hook_context).toBeUndefined();
    const withHook: CreateExecutionData = { ...validData, hook_context: true };
    expect(withHook.hook_context).toBe(true);
  });

  it("code_hash is optional", () => {
    const data: CreateExecutionData = { ...validData, code_hash: "sha256:abc123" };
    expect(data.code_hash).toBe("sha256:abc123");
  });

  it("sandbox_vm_run is optional", () => {
    const data: CreateExecutionData = { ...validData, sandbox_vm_run: 7 };
    expect(data.sandbox_vm_run).toBe(7);
  });

  it("type union covers all 5 values", () => {
    const types: CreateExecutionData["type"][] = [
      "code", "connector-run", "app-build", "expression", "plugin-drain",
    ];
    for (const type of types) {
      const data: CreateExecutionData = { ...validData, type };
      expect(data.type).toBe(type);
    }
  });

  it("language union covers all 4 values", () => {
    const languages: CreateExecutionData["language"][] = ["js", "ts", "python", "go"];
    for (const language of languages) {
      const data: CreateExecutionData = { ...validData, language };
      expect(data.language).toBe(language);
    }
  });
});

// ---------------------------------------------------------------------------
// UpdateExecutionData
// ---------------------------------------------------------------------------

describe("UpdateExecutionData — shape", () => {
  it("accepts status with no completion data", () => {
    const data: UpdateExecutionData = { status: "running" };
    expect(data.status).toBe("running");
    expect(data.completion).toBeUndefined();
  });

  it("status union covers all 6 values", () => {
    const statuses: UpdateExecutionData["status"][] = [
      "pending", "running", "success", "error", "timeout", "killed",
    ];
    for (const status of statuses) {
      const data: UpdateExecutionData = { status };
      expect(data.status).toBe(status);
    }
  });

  it("accepts completion object with required fields", () => {
    const data: UpdateExecutionData = {
      status: "success",
      completion: {
        completed_at: new Date("2026-01-01T01:00:00Z"),
        duration_ms: 1000,
        exit_code: 0,
      },
    };
    expect(data.completion?.completed_at).toBeInstanceOf(Date);
    expect(data.completion?.duration_ms).toBe(1000);
    expect(data.completion?.exit_code).toBe(0);
  });

  it("completion.memory_peak_mb is optional", () => {
    const data: UpdateExecutionData = {
      status: "success",
      completion: {
        completed_at: new Date(),
        duration_ms: 500,
        exit_code: 0,
        memory_peak_mb: 128,
      },
    };
    expect(data.completion?.memory_peak_mb).toBe(128);
  });

  it("completion.error_code is optional", () => {
    const data: UpdateExecutionData = {
      status: "error",
      completion: {
        completed_at: new Date(),
        duration_ms: 500,
        exit_code: 1,
        error_code: "EXECUTION_TIMEOUT",
      },
    };
    expect(data.completion?.error_code).toBe("EXECUTION_TIMEOUT");
  });

  it("completion.error_message is optional", () => {
    const data: UpdateExecutionData = {
      status: "error",
      completion: {
        completed_at: new Date(),
        duration_ms: 500,
        exit_code: 1,
        error_message: "Timed out",
      },
    };
    expect(data.completion?.error_message).toBe("Timed out");
  });

  it("completion.error_stack is optional", () => {
    const data: UpdateExecutionData = {
      status: "error",
      completion: {
        completed_at: new Date(),
        duration_ms: 500,
        exit_code: 1,
        error_stack: "Error: ...\n  at ...",
      },
    };
    expect(data.completion?.error_stack).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// CompletionData
// ---------------------------------------------------------------------------

describe("CompletionData — shape", () => {
  const validData: CompletionData = {
    completed_at: new Date("2026-01-01T01:00:00Z"),
    duration_ms: 2000,
    exit_code: 0,
  };

  it("accepts minimal required fields", () => {
    expect(validData.completed_at).toBeInstanceOf(Date);
    expect(validData.duration_ms).toBe(2000);
    expect(validData.exit_code).toBe(0);
  });

  it("all optional fields are absent in minimal case", () => {
    expect(validData.memory_peak_mb).toBeUndefined();
    expect(validData.error_code).toBeUndefined();
    expect(validData.error_message).toBeUndefined();
    expect(validData.error_stack).toBeUndefined();
  });

  it("accepts all optional fields together", () => {
    const data: CompletionData = {
      ...validData,
      memory_peak_mb: 64,
      error_code: "EXECUTION_OOM",
      error_message: "Out of memory",
      error_stack: "Error: OOM\n  at vm.js:1",
    };
    expect(data.memory_peak_mb).toBe(64);
    expect(data.error_code).toBe("EXECUTION_OOM");
    expect(data.error_message).toBe("Out of memory");
    expect(typeof data.error_stack).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// CreateExecutionLogData
// ---------------------------------------------------------------------------

describe("CreateExecutionLogData — shape", () => {
  const validData: CreateExecutionLogData = {
    execution_id: "exec-001",
    execution_date: new Date("2026-01-01T00:00:00Z"),
    level: "info",
    message: "Sandbox log line",
    line_number: 1,
    stream: "stdout",
  };

  it("accepts minimal required fields", () => {
    expect(validData.execution_id).toBeDefined();
    expect(validData.execution_date).toBeInstanceOf(Date);
    expect(validData.level).toBeDefined();
    expect(validData.message).toBeDefined();
    expect(validData.line_number).toBeDefined();
    expect(validData.stream).toBeDefined();
  });

  it("level union covers all 4 log levels", () => {
    const levels: CreateExecutionLogData["level"][] = ["debug", "info", "warn", "error"];
    for (const level of levels) {
      const data: CreateExecutionLogData = { ...validData, level };
      expect(data.level).toBe(level);
    }
  });

  it("stream union accepts stdout and stderr", () => {
    const streams: CreateExecutionLogData["stream"][] = ["stdout", "stderr"];
    for (const stream of streams) {
      const data: CreateExecutionLogData = { ...validData, stream };
      expect(data.stream).toBe(stream);
    }
  });

  it("metadata is optional", () => {
    const noMeta: CreateExecutionLogData = { ...validData };
    expect(noMeta.metadata).toBeUndefined();
  });

  it("metadata can be a Record<string, unknown>", () => {
    const data: CreateExecutionLogData = {
      ...validData,
      metadata: { requestId: "req-1", latencyMs: 50 },
    };
    expect(data.metadata?.["requestId"]).toBe("req-1");
  });
});

// ---------------------------------------------------------------------------
// Cross-type consistency
// ---------------------------------------------------------------------------

describe("cross-type consistency", () => {
  it("ExecutionRow.status union matches UpdateExecutionData.status union", () => {
    const rowStatus: ExecutionRow["status"] = "killed";
    const updateStatus: UpdateExecutionData["status"] = rowStatus;
    expect(updateStatus).toBe("killed");
  });

  it("ExecutionRow.language union matches CreateExecutionData.language union", () => {
    const rowLang: ExecutionRow["language"] = "python";
    const createLang: CreateExecutionData["language"] = rowLang;
    expect(createLang).toBe("python");
  });

  it("ExecutionLogRow.level union matches CreateExecutionLogData.level union", () => {
    const rowLevel: ExecutionLogRow["level"] = "error";
    const createLevel: CreateExecutionLogData["level"] = rowLevel;
    expect(createLevel).toBe("error");
  });

  it("ExecutionLogRow.stream union matches CreateExecutionLogData.stream union", () => {
    const rowStream: ExecutionLogRow["stream"] = "stderr";
    const createStream: CreateExecutionLogData["stream"] = rowStream;
    expect(createStream).toBe("stderr");
  });

  it("ExecutionRow has snake_case keys (no camelCase leakage)", () => {
    const row: ExecutionRow = {
      id: "e", tenant_id: "t", type: "code", status: "pending", language: "js",
      sandbox_type: "isolated-vm", plugin_id: null, pipeline_id: null,
      pipeline_run_id: null, hook_context: false, code_hash: null,
      started_at: new Date(), completed_at: null, duration_ms: null,
      memory_peak_mb: null, exit_code: null, error_code: null, error_message: null,
      error_stack: null, trace_id: "t", initiated_by: "u", sandbox_vm_run: null,
    };
    expect("tenantId" in row).toBe(false);
    expect("pluginId" in row).toBe(false);
    expect("startedAt" in row).toBe(false);
  });
});
