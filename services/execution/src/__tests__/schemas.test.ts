// Unit tests for schemas/index.ts
//
// Covers every exported Zod schema: valid inputs, invalid inputs, defaults,
// boundary conditions, and optional fields.

import { describe, it, expect } from "vitest";
import {
  RunRequestSchema,
  InternalRunRequestSchema,
  ConnectorRunRequestSchema,
  PluginDrainRequestSchema,
  CachePrefetchRequestSchema,
  CacheInvalidateRequestSchema,
  RunResponseSchema,
  ExecutionResponseSchema,
  ConnectorRunResponseSchema,
  PluginDrainResponseSchema,
  CachePrefetchResponseSchema,
  CacheInvalidateResponseSchema,
  ListExecutionsQuery,
} from "../schemas/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok<T>(schema: { parse(v: unknown): T }, input: unknown): T {
  return schema.parse(input);
}

function fails(
  schema: { safeParse(v: unknown): { success: boolean } },
  input: unknown,
): void {
  const result = schema.safeParse(input);
  expect(result.success).toBe(false);
}

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";
const VALID_UUID_2 = "550e8400-e29b-41d4-a716-446655440001";
const VALID_UUID_3 = "550e8400-e29b-41d4-a716-446655440002";

// ---------------------------------------------------------------------------
// RunRequestSchema
// ---------------------------------------------------------------------------

describe("RunRequestSchema — valid", () => {
  it("accepts minimal valid request with code and language js", () => {
    const r = RunRequestSchema.safeParse({ code: "return 1;", language: "js" });
    expect(r.success).toBe(true);
  });

  it("accepts language ts", () => {
    const r = RunRequestSchema.safeParse({ code: "return 1;", language: "ts" });
    expect(r.success).toBe(true);
  });

  it("defaults timeout to 30000 when omitted", () => {
    const result = ok(RunRequestSchema, { code: "x", language: "js" });
    expect(result.timeout).toBe(30_000);
  });

  it("defaults context to {} when omitted", () => {
    const result = ok(RunRequestSchema, { code: "x", language: "js" });
    expect(result.context).toEqual({});
  });

  it("accepts explicit timeout at minimum (1000ms)", () => {
    const r = RunRequestSchema.safeParse({ code: "x", language: "js", timeout: 1000 });
    expect(r.success).toBe(true);
  });

  it("accepts explicit timeout at maximum (30000ms)", () => {
    const r = RunRequestSchema.safeParse({ code: "x", language: "js", timeout: 30_000 });
    expect(r.success).toBe(true);
  });

  it("accepts optional label up to 128 chars", () => {
    const r = RunRequestSchema.safeParse({
      code: "x",
      language: "js",
      label: "a".repeat(128),
    });
    expect(r.success).toBe(true);
  });

  it("accepts code at maximum (524288 bytes / 512 KB)", () => {
    const r = RunRequestSchema.safeParse({ code: "x".repeat(524_288), language: "js" });
    expect(r.success).toBe(true);
  });

  it("accepts optional context record with values", () => {
    const r = RunRequestSchema.safeParse({
      code: "x",
      language: "js",
      context: { userId: "u-1", count: 5 },
    });
    expect(r.success).toBe(true);
  });
});

describe("RunRequestSchema — invalid", () => {
  it("rejects empty code string", () => {
    fails(RunRequestSchema, { code: "", language: "js" });
  });

  it("rejects code exceeding 524288 bytes", () => {
    fails(RunRequestSchema, { code: "x".repeat(524_289), language: "js" });
  });

  it("rejects unknown language python", () => {
    fails(RunRequestSchema, { code: "x", language: "python" });
  });

  it("rejects unknown language go", () => {
    fails(RunRequestSchema, { code: "x", language: "go" });
  });

  it("rejects timeout below 1000ms", () => {
    fails(RunRequestSchema, { code: "x", language: "js", timeout: 999 });
  });

  it("rejects timeout above 30000ms", () => {
    fails(RunRequestSchema, { code: "x", language: "js", timeout: 30_001 });
  });

  it("rejects fractional timeout", () => {
    fails(RunRequestSchema, { code: "x", language: "js", timeout: 1000.5 });
  });

  it("rejects label longer than 128 chars", () => {
    fails(RunRequestSchema, { code: "x", language: "js", label: "a".repeat(129) });
  });

  it("rejects missing code field", () => {
    fails(RunRequestSchema, { language: "js" });
  });

  it("rejects missing language field", () => {
    fails(RunRequestSchema, { code: "x" });
  });
});

// ---------------------------------------------------------------------------
// InternalRunRequestSchema
// ---------------------------------------------------------------------------

const validInternalRequest = {
  tenantId: VALID_UUID,
  type: "code" as const,
  language: "js" as const,
  code: "return 1;",
  timeout: 5000,
  context: {
    traceId: "trace-abc",
    tenantId: VALID_UUID,
  },
};

describe("InternalRunRequestSchema — valid", () => {
  it("accepts minimal valid internal request", () => {
    const r = InternalRunRequestSchema.safeParse(validInternalRequest);
    expect(r.success).toBe(true);
  });

  it("accepts all languages: js, ts, python, go", () => {
    const languages = ["js", "ts", "python", "go"] as const;
    for (const language of languages) {
      const r = InternalRunRequestSchema.safeParse({ ...validInternalRequest, language });
      expect(r.success).toBe(true);
    }
  });

  it("accepts all types: code, connector-run, app-build, expression", () => {
    const types = ["code", "connector-run", "app-build", "expression"] as const;
    for (const type of types) {
      const r = InternalRunRequestSchema.safeParse({ ...validInternalRequest, type });
      expect(r.success).toBe(true);
    }
  });

  it("accepts timeout at maximum (300000ms)", () => {
    const r = InternalRunRequestSchema.safeParse({ ...validInternalRequest, timeout: 300_000 });
    expect(r.success).toBe(true);
  });

  it("accepts timeout at minimum (1000ms)", () => {
    const r = InternalRunRequestSchema.safeParse({ ...validInternalRequest, timeout: 1000 });
    expect(r.success).toBe(true);
  });

  it("accepts optional context.pluginId as UUID", () => {
    const r = InternalRunRequestSchema.safeParse({
      ...validInternalRequest,
      context: { ...validInternalRequest.context, pluginId: VALID_UUID_2 },
    });
    expect(r.success).toBe(true);
  });

  it("accepts optional context.pipelineId as UUID", () => {
    const r = InternalRunRequestSchema.safeParse({
      ...validInternalRequest,
      context: { ...validInternalRequest.context, pipelineId: VALID_UUID_2 },
    });
    expect(r.success).toBe(true);
  });

  it("accepts optional context.hookContext boolean", () => {
    const r = InternalRunRequestSchema.safeParse({
      ...validInternalRequest,
      context: { ...validInternalRequest.context, hookContext: true },
    });
    expect(r.success).toBe(true);
  });

  it("defaults context.hookContext to false when omitted", () => {
    const result = ok(InternalRunRequestSchema, validInternalRequest);
    expect(result.context.hookContext).toBe(false);
  });

  it("accepts optional context.label up to 128 chars", () => {
    const r = InternalRunRequestSchema.safeParse({
      ...validInternalRequest,
      context: { ...validInternalRequest.context, label: "l".repeat(128) },
    });
    expect(r.success).toBe(true);
  });

  it("accepts optional files map up to 100 entries", () => {
    const files = Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [`file${i}.ts`, "export default {};`"]),
    );
    const r = InternalRunRequestSchema.safeParse({ ...validInternalRequest, files });
    expect(r.success).toBe(true);
  });

  it("accepts optional entrypoint string", () => {
    const r = InternalRunRequestSchema.safeParse({
      ...validInternalRequest,
      entrypoint: "handler.ts",
    });
    expect(r.success).toBe(true);
  });

  it("accepts code at maximum (10485760 bytes / 10 MB)", () => {
    const r = InternalRunRequestSchema.safeParse({
      ...validInternalRequest,
      code: "x".repeat(10_485_760),
    });
    expect(r.success).toBe(true);
  });
});

describe("InternalRunRequestSchema — invalid", () => {
  it("rejects non-UUID tenantId", () => {
    fails(InternalRunRequestSchema, { ...validInternalRequest, tenantId: "not-a-uuid" });
  });

  it("rejects unknown type", () => {
    fails(InternalRunRequestSchema, { ...validInternalRequest, type: "plugin-drain" });
  });

  it("rejects unknown language", () => {
    fails(InternalRunRequestSchema, { ...validInternalRequest, language: "ruby" });
  });

  it("rejects empty code", () => {
    fails(InternalRunRequestSchema, { ...validInternalRequest, code: "" });
  });

  it("rejects code exceeding 10485760 bytes", () => {
    fails(InternalRunRequestSchema, { ...validInternalRequest, code: "x".repeat(10_485_761) });
  });

  it("rejects timeout below 1000ms", () => {
    fails(InternalRunRequestSchema, { ...validInternalRequest, timeout: 999 });
  });

  it("rejects timeout above 300000ms", () => {
    fails(InternalRunRequestSchema, { ...validInternalRequest, timeout: 300_001 });
  });

  it("rejects files map exceeding 100 entries", () => {
    const files = Object.fromEntries(
      Array.from({ length: 101 }, (_, i) => [`file${i}.ts`, "x"]),
    );
    fails(InternalRunRequestSchema, { ...validInternalRequest, files });
  });

  it("rejects file content exceeding 262144 bytes per file", () => {
    const files = { "main.ts": "x".repeat(262_145) };
    fails(InternalRunRequestSchema, { ...validInternalRequest, files });
  });

  it("rejects missing traceId in context", () => {
    const { traceId: _t, ...ctx } = validInternalRequest.context;
    fails(InternalRunRequestSchema, {
      ...validInternalRequest,
      context: ctx,
    });
  });

  it("rejects non-UUID context.tenantId", () => {
    fails(InternalRunRequestSchema, {
      ...validInternalRequest,
      context: { ...validInternalRequest.context, tenantId: "not-a-uuid" },
    });
  });

  it("rejects context.label longer than 128 chars", () => {
    fails(InternalRunRequestSchema, {
      ...validInternalRequest,
      context: { ...validInternalRequest.context, label: "l".repeat(129) },
    });
  });
});

// ---------------------------------------------------------------------------
// ConnectorRunRequestSchema
// ---------------------------------------------------------------------------

const validConnectorRun = {
  tenantId: VALID_UUID,
  pluginId: VALID_UUID_2,
  method: "fetchBatch" as const,
  cursor: null,
  credentialBundleId: VALID_UUID_3,
  traceId: "trace-xyz",
};

describe("ConnectorRunRequestSchema — valid", () => {
  it("accepts minimal valid connector run request", () => {
    const r = ConnectorRunRequestSchema.safeParse(validConnectorRun);
    expect(r.success).toBe(true);
  });

  it("accepts all methods: fetchBatch, push, getSchema, testConnection", () => {
    const methods = ["fetchBatch", "push", "getSchema", "testConnection"] as const;
    for (const method of methods) {
      const r = ConnectorRunRequestSchema.safeParse({ ...validConnectorRun, method });
      expect(r.success).toBe(true);
    }
  });

  it("accepts cursor as non-null string", () => {
    const r = ConnectorRunRequestSchema.safeParse({ ...validConnectorRun, cursor: "cursor-123" });
    expect(r.success).toBe(true);
  });

  it("defaults timeout to 300000 when omitted", () => {
    const result = ok(ConnectorRunRequestSchema, validConnectorRun);
    expect(result.timeout).toBe(300_000);
  });

  it("accepts timeout at minimum (5000ms)", () => {
    const r = ConnectorRunRequestSchema.safeParse({ ...validConnectorRun, timeout: 5000 });
    expect(r.success).toBe(true);
  });

  it("accepts timeout at maximum (300000ms)", () => {
    const r = ConnectorRunRequestSchema.safeParse({ ...validConnectorRun, timeout: 300_000 });
    expect(r.success).toBe(true);
  });

  it("accepts optional pipelineRunId as UUID", () => {
    const r = ConnectorRunRequestSchema.safeParse({
      ...validConnectorRun,
      pipelineRunId: VALID_UUID_3,
    });
    expect(r.success).toBe(true);
  });
});

describe("ConnectorRunRequestSchema — invalid", () => {
  it("rejects non-UUID tenantId", () => {
    fails(ConnectorRunRequestSchema, { ...validConnectorRun, tenantId: "bad" });
  });

  it("rejects non-UUID pluginId", () => {
    fails(ConnectorRunRequestSchema, { ...validConnectorRun, pluginId: "bad" });
  });

  it("rejects unknown method", () => {
    fails(ConnectorRunRequestSchema, { ...validConnectorRun, method: "sync" });
  });

  it("rejects timeout below 5000ms", () => {
    fails(ConnectorRunRequestSchema, { ...validConnectorRun, timeout: 4999 });
  });

  it("rejects timeout above 300000ms", () => {
    fails(ConnectorRunRequestSchema, { ...validConnectorRun, timeout: 300_001 });
  });

  it("rejects non-UUID credentialBundleId", () => {
    fails(ConnectorRunRequestSchema, { ...validConnectorRun, credentialBundleId: "bad" });
  });

  it("rejects non-UUID pipelineRunId when provided", () => {
    fails(ConnectorRunRequestSchema, { ...validConnectorRun, pipelineRunId: "not-uuid" });
  });
});

// ---------------------------------------------------------------------------
// PluginDrainRequestSchema
// ---------------------------------------------------------------------------

describe("PluginDrainRequestSchema — valid", () => {
  it("accepts valid request with all required fields", () => {
    const r = PluginDrainRequestSchema.safeParse({
      pluginId: "stripe-connector",
      tenantId: VALID_UUID,
    });
    expect(r.success).toBe(true);
  });

  it("accepts tenantId as null (platform-wide drain)", () => {
    const r = PluginDrainRequestSchema.safeParse({
      pluginId: "stripe-connector",
      tenantId: null,
    });
    expect(r.success).toBe(true);
  });

  it("defaults gracePeriodMs to 60000 when omitted", () => {
    const result = ok(PluginDrainRequestSchema, {
      pluginId: "stripe-connector",
      tenantId: null,
    });
    expect(result.gracePeriodMs).toBe(60_000);
  });

  it("accepts gracePeriodMs at minimum (1000ms)", () => {
    const r = PluginDrainRequestSchema.safeParse({
      pluginId: "stripe-connector",
      tenantId: null,
      gracePeriodMs: 1000,
    });
    expect(r.success).toBe(true);
  });

  it("accepts gracePeriodMs at maximum (120000ms)", () => {
    const r = PluginDrainRequestSchema.safeParse({
      pluginId: "stripe-connector",
      tenantId: null,
      gracePeriodMs: 120_000,
    });
    expect(r.success).toBe(true);
  });

  it("accepts optional instanceId as UUID", () => {
    const r = PluginDrainRequestSchema.safeParse({
      pluginId: "stripe-connector",
      tenantId: VALID_UUID,
      instanceId: VALID_UUID_2,
    });
    expect(r.success).toBe(true);
  });

  it("pluginId is a string (manifest_id, not UUID)", () => {
    const r = PluginDrainRequestSchema.safeParse({
      pluginId: "not-a-uuid-just-a-slug",
      tenantId: null,
    });
    expect(r.success).toBe(true);
  });
});

describe("PluginDrainRequestSchema — invalid", () => {
  it("rejects missing pluginId", () => {
    fails(PluginDrainRequestSchema, { tenantId: null });
  });

  it("rejects gracePeriodMs below 1000ms", () => {
    fails(PluginDrainRequestSchema, {
      pluginId: "p",
      tenantId: null,
      gracePeriodMs: 999,
    });
  });

  it("rejects gracePeriodMs above 120000ms", () => {
    fails(PluginDrainRequestSchema, {
      pluginId: "p",
      tenantId: null,
      gracePeriodMs: 120_001,
    });
  });

  it("rejects non-integer gracePeriodMs", () => {
    fails(PluginDrainRequestSchema, {
      pluginId: "p",
      tenantId: null,
      gracePeriodMs: 5000.5,
    });
  });

  it("rejects non-UUID instanceId when provided", () => {
    fails(PluginDrainRequestSchema, {
      pluginId: "p",
      tenantId: null,
      instanceId: "not-uuid",
    });
  });

  it("rejects non-UUID non-null tenantId", () => {
    fails(PluginDrainRequestSchema, {
      pluginId: "p",
      tenantId: "not-a-uuid",
    });
  });
});

// ---------------------------------------------------------------------------
// CachePrefetchRequestSchema
// ---------------------------------------------------------------------------

describe("CachePrefetchRequestSchema — valid", () => {
  it("accepts valid request with required fields", () => {
    const r = CachePrefetchRequestSchema.safeParse({
      pluginId: VALID_UUID,
      version: "1.2.3",
    });
    expect(r.success).toBe(true);
  });

  it("accepts optional tenantId as UUID", () => {
    const r = CachePrefetchRequestSchema.safeParse({
      pluginId: VALID_UUID,
      version: "1.2.3",
      tenantId: VALID_UUID_2,
    });
    expect(r.success).toBe(true);
  });

  it("tenantId absent means platform-wide prefetch", () => {
    const result = ok(CachePrefetchRequestSchema, { pluginId: VALID_UUID, version: "1.0.0" });
    expect(result.tenantId).toBeUndefined();
  });
});

describe("CachePrefetchRequestSchema — invalid", () => {
  it("rejects non-UUID pluginId", () => {
    fails(CachePrefetchRequestSchema, { pluginId: "not-a-uuid", version: "1.0" });
  });

  it("rejects missing version", () => {
    fails(CachePrefetchRequestSchema, { pluginId: VALID_UUID });
  });

  it("rejects non-UUID tenantId when provided", () => {
    fails(CachePrefetchRequestSchema, {
      pluginId: VALID_UUID,
      version: "1.0",
      tenantId: "bad",
    });
  });
});

// ---------------------------------------------------------------------------
// CacheInvalidateRequestSchema
// ---------------------------------------------------------------------------

describe("CacheInvalidateRequestSchema — valid", () => {
  it("accepts valid request", () => {
    const r = CacheInvalidateRequestSchema.safeParse({
      pluginId: "stripe-connector",
      tenantId: VALID_UUID,
      newBundleVersion: "2.0.0",
    });
    expect(r.success).toBe(true);
  });

  it("accepts null tenantId for platform-wide invalidation", () => {
    const r = CacheInvalidateRequestSchema.safeParse({
      pluginId: "stripe-connector",
      tenantId: null,
      newBundleVersion: "2.0.0",
    });
    expect(r.success).toBe(true);
  });
});

describe("CacheInvalidateRequestSchema — invalid", () => {
  it("rejects missing pluginId", () => {
    fails(CacheInvalidateRequestSchema, { tenantId: null, newBundleVersion: "1.0" });
  });

  it("rejects missing newBundleVersion", () => {
    fails(CacheInvalidateRequestSchema, { pluginId: "p", tenantId: null });
  });

  it("rejects non-UUID non-null tenantId", () => {
    fails(CacheInvalidateRequestSchema, {
      pluginId: "p",
      tenantId: "not-uuid",
      newBundleVersion: "1.0",
    });
  });
});

// ---------------------------------------------------------------------------
// RunResponseSchema
// ---------------------------------------------------------------------------

describe("RunResponseSchema — valid", () => {
  it("accepts valid 202 async run response", () => {
    const r = RunResponseSchema.safeParse({
      data: {
        executionId: VALID_UUID,
        status: "pending",
        logsUrl: "https://api.example.com/api/v1/exec/abc/logs",
      },
    });
    expect(r.success).toBe(true);
  });
});

describe("RunResponseSchema — invalid", () => {
  it("rejects non-UUID executionId", () => {
    fails(RunResponseSchema, {
      data: {
        executionId: "bad",
        status: "pending",
        logsUrl: "https://example.com",
      },
    });
  });

  it("rejects status other than pending", () => {
    fails(RunResponseSchema, {
      data: {
        executionId: VALID_UUID,
        status: "running",
        logsUrl: "https://example.com",
      },
    });
  });

  it("rejects non-URL logsUrl", () => {
    fails(RunResponseSchema, {
      data: {
        executionId: VALID_UUID,
        status: "pending",
        logsUrl: "not-a-url",
      },
    });
  });
});

// ---------------------------------------------------------------------------
// ExecutionResponseSchema
// ---------------------------------------------------------------------------

const validExecutionResponse = {
  data: {
    id: VALID_UUID,
    tenantId: VALID_UUID_2,
    type: "code" as const,
    status: "success" as const,
    language: "js" as const,
    startedAt: "2026-06-10T00:00:00.000Z",
    completedAt: "2026-06-10T00:00:01.000Z",
    durationMs: 1000,
    memoryPeakMb: null,
    exitCode: 0,
    errorCode: null,
    errorMessage: null,
    traceId: "trace-abc",
  },
};

describe("ExecutionResponseSchema — valid", () => {
  it("accepts a complete execution response", () => {
    const r = ExecutionResponseSchema.safeParse(validExecutionResponse);
    expect(r.success).toBe(true);
  });

  it("accepts all status values", () => {
    const statuses = ["pending", "running", "success", "error", "timeout", "killed"] as const;
    for (const status of statuses) {
      const r = ExecutionResponseSchema.safeParse({
        data: { ...validExecutionResponse.data, status },
      });
      expect(r.success).toBe(true);
    }
  });

  it("accepts all type values", () => {
    const types = ["code", "connector-run", "app-build", "expression", "plugin-drain"] as const;
    for (const type of types) {
      const r = ExecutionResponseSchema.safeParse({
        data: { ...validExecutionResponse.data, type },
      });
      expect(r.success).toBe(true);
    }
  });

  it("accepts all language values", () => {
    const languages = ["js", "ts", "python", "go"] as const;
    for (const language of languages) {
      const r = ExecutionResponseSchema.safeParse({
        data: { ...validExecutionResponse.data, language },
      });
      expect(r.success).toBe(true);
    }
  });

  it("accepts null completedAt for in-flight execution", () => {
    const r = ExecutionResponseSchema.safeParse({
      data: { ...validExecutionResponse.data, completedAt: null, durationMs: null },
    });
    expect(r.success).toBe(true);
  });
});

describe("ExecutionResponseSchema — invalid", () => {
  it("rejects non-UUID id", () => {
    fails(ExecutionResponseSchema, { data: { ...validExecutionResponse.data, id: "bad" } });
  });

  it("rejects invalid startedAt format", () => {
    fails(ExecutionResponseSchema, {
      data: { ...validExecutionResponse.data, startedAt: "not-a-date" },
    });
  });

  it("rejects unknown status", () => {
    fails(ExecutionResponseSchema, {
      data: { ...validExecutionResponse.data, status: "archived" },
    });
  });
});

// ---------------------------------------------------------------------------
// ConnectorRunResponseSchema
// ---------------------------------------------------------------------------

describe("ConnectorRunResponseSchema — valid", () => {
  it("accepts success response", () => {
    const r = ConnectorRunResponseSchema.safeParse({
      data: {
        executionId: VALID_UUID,
        status: "success",
        result: { items: [] },
        errorCode: null,
        errorMessage: null,
        durationMs: 500,
        memoryPeakMb: null,
      },
    });
    expect(r.success).toBe(true);
  });

  it("accepts all status values: success, error, timeout", () => {
    const statuses = ["success", "error", "timeout"] as const;
    for (const status of statuses) {
      const r = ConnectorRunResponseSchema.safeParse({
        data: {
          executionId: VALID_UUID,
          status,
          result: null,
          errorCode: null,
          errorMessage: null,
          durationMs: 100,
          memoryPeakMb: null,
        },
      });
      expect(r.success).toBe(true);
    }
  });
});

describe("ConnectorRunResponseSchema — invalid", () => {
  it("rejects unknown status", () => {
    fails(ConnectorRunResponseSchema, {
      data: {
        executionId: VALID_UUID,
        status: "killed",
        result: null,
        errorCode: null,
        errorMessage: null,
        durationMs: 100,
        memoryPeakMb: null,
      },
    });
  });

  it("rejects non-integer durationMs", () => {
    fails(ConnectorRunResponseSchema, {
      data: {
        executionId: VALID_UUID,
        status: "success",
        result: null,
        errorCode: null,
        errorMessage: null,
        durationMs: 100.5,
        memoryPeakMb: null,
      },
    });
  });
});

// ---------------------------------------------------------------------------
// PluginDrainResponseSchema
// ---------------------------------------------------------------------------

describe("PluginDrainResponseSchema — valid", () => {
  it("accepts valid drain response", () => {
    const r = PluginDrainResponseSchema.safeParse({
      data: {
        pluginId: VALID_UUID,
        drainedAt: "2026-06-10T00:00:00.000Z",
        inflightAtDrainStart: 5,
        inflightAtCompletion: 0,
        killedExecutions: [VALID_UUID_2, VALID_UUID_3],
      },
    });
    expect(r.success).toBe(true);
  });

  it("accepts empty killedExecutions array", () => {
    const r = PluginDrainResponseSchema.safeParse({
      data: {
        pluginId: VALID_UUID,
        drainedAt: "2026-06-10T00:00:00.000Z",
        inflightAtDrainStart: 0,
        inflightAtCompletion: 0,
        killedExecutions: [],
      },
    });
    expect(r.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CachePrefetchResponseSchema
// ---------------------------------------------------------------------------

describe("CachePrefetchResponseSchema — valid", () => {
  it("accepts valid prefetch response", () => {
    const r = CachePrefetchResponseSchema.safeParse({
      data: {
        pluginId: VALID_UUID,
        version: "1.0.0",
        cached: true,
        bundleSizeBytes: 1024,
        fetchDurationMs: 200,
      },
    });
    expect(r.success).toBe(true);
  });
});

describe("CachePrefetchResponseSchema — invalid", () => {
  it("rejects non-boolean cached field", () => {
    fails(CachePrefetchResponseSchema, {
      data: {
        pluginId: VALID_UUID,
        version: "1.0.0",
        cached: "yes",
        bundleSizeBytes: 1024,
        fetchDurationMs: 200,
      },
    });
  });
});

// ---------------------------------------------------------------------------
// CacheInvalidateResponseSchema
// ---------------------------------------------------------------------------

describe("CacheInvalidateResponseSchema — valid", () => {
  it("accepts valid invalidation response", () => {
    const r = CacheInvalidateResponseSchema.safeParse({
      data: {
        evicted: true,
        pluginId: VALID_UUID,
      },
    });
    expect(r.success).toBe(true);
  });

  it("accepts evicted: false (cache miss)", () => {
    const r = CacheInvalidateResponseSchema.safeParse({
      data: { evicted: false, pluginId: VALID_UUID },
    });
    expect(r.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ListExecutionsQuery
// ---------------------------------------------------------------------------

describe("ListExecutionsQuery — valid", () => {
  it("accepts empty object with default limit 50", () => {
    const result = ok(ListExecutionsQuery, {});
    expect(result.limit).toBe(50);
  });

  it("coerces string limit to number", () => {
    const result = ok(ListExecutionsQuery, { limit: "25" });
    expect(result.limit).toBe(25);
  });

  it("accepts limit at minimum (1)", () => {
    const r = ListExecutionsQuery.safeParse({ limit: 1 });
    expect(r.success).toBe(true);
  });

  it("accepts limit at maximum (100)", () => {
    const r = ListExecutionsQuery.safeParse({ limit: 100 });
    expect(r.success).toBe(true);
  });

  it("accepts optional cursor string", () => {
    const result = ok(ListExecutionsQuery, { cursor: "cursor-123" });
    expect(result.cursor).toBe("cursor-123");
  });

  it("accepts filter[status][eq] with all valid statuses", () => {
    const statuses = ["pending", "running", "success", "error", "timeout", "killed"] as const;
    for (const status of statuses) {
      const r = ListExecutionsQuery.safeParse({ "filter[status][eq]": status });
      expect(r.success).toBe(true);
    }
  });

  it("accepts filter[type][eq] with all valid types", () => {
    const types = ["code", "connector-run", "app-build", "expression", "plugin-drain"] as const;
    for (const type of types) {
      const r = ListExecutionsQuery.safeParse({ "filter[type][eq]": type });
      expect(r.success).toBe(true);
    }
  });
});

describe("ListExecutionsQuery — invalid", () => {
  it("rejects limit = 0", () => {
    fails(ListExecutionsQuery, { limit: 0 });
  });

  it("rejects limit = 101", () => {
    fails(ListExecutionsQuery, { limit: 101 });
  });

  it("rejects fractional limit", () => {
    fails(ListExecutionsQuery, { limit: 2.5 });
  });

  it("rejects unknown status filter", () => {
    fails(ListExecutionsQuery, { "filter[status][eq]": "archived" });
  });

  it("rejects unknown type filter", () => {
    fails(ListExecutionsQuery, { "filter[type][eq]": "unknown-type" });
  });
});
