// Unit tests for schemas/index.ts
//
// Covers every exported Zod schema: valid inputs, invalid inputs, defaults,
// boundary conditions, discriminated union variants, and optional fields.

import { describe, it, expect } from "vitest";
import {
  CreatePipelineSchema,
  PatchPipelineSchema,
  TriggerPipelineSchema,
  CreateScheduleSchema,
  PatchScheduleSchema,
  ListPipelinesQuery,
  ListRunsQuery,
  ListSchedulesQuery,
  StepSchema,
  PipelineDefinitionSchema,
  InternalTriggerRequestSchema,
  RetryConfigSchema,
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

// ---------------------------------------------------------------------------
// Minimal valid pipeline definition (used repeatedly)
// ---------------------------------------------------------------------------

const minimalCodeStep = {
  id: "step-1",
  name: "My Step",
  type: "code" as const,
  language: "javascript" as const,
  code: 'return "hello";',
};

const minimalDefinition = {
  version: 1,
  entryStepId: "step-1",
  steps: [minimalCodeStep],
};

// ---------------------------------------------------------------------------
// StepSchema — code step
// ---------------------------------------------------------------------------

describe("StepSchema — code step — valid", () => {
  it("accepts minimal code step with required fields", () => {
    const r = StepSchema.safeParse(minimalCodeStep);
    expect(r.success).toBe(true);
  });

  it("accepts all four supported languages: javascript", () => {
    const r = StepSchema.safeParse({ ...minimalCodeStep, language: "javascript" });
    expect(r.success).toBe(true);
  });

  it("accepts all four supported languages: typescript", () => {
    const r = StepSchema.safeParse({ ...minimalCodeStep, language: "typescript" });
    expect(r.success).toBe(true);
  });

  it("accepts all four supported languages: python", () => {
    const r = StepSchema.safeParse({ ...minimalCodeStep, language: "python" });
    expect(r.success).toBe(true);
  });

  it("accepts all four supported languages: go", () => {
    const r = StepSchema.safeParse({ ...minimalCodeStep, language: "go" });
    expect(r.success).toBe(true);
  });

  it("accepts optional entrypoint field", () => {
    const r = StepSchema.safeParse({ ...minimalCodeStep, entrypoint: "handler" });
    expect(r.success).toBe(true);
  });

  it("accepts optional timeout in valid range (1000ms)", () => {
    const r = StepSchema.safeParse({ ...minimalCodeStep, timeout: 1000 });
    expect(r.success).toBe(true);
  });

  it("accepts optional timeout at max (3_600_000ms)", () => {
    const r = StepSchema.safeParse({ ...minimalCodeStep, timeout: 3_600_000 });
    expect(r.success).toBe(true);
  });

  it("accepts onError: skip", () => {
    const r = StepSchema.safeParse({ ...minimalCodeStep, onError: "skip" });
    expect(r.success).toBe(true);
  });

  it("accepts onError: fail", () => {
    const r = StepSchema.safeParse({ ...minimalCodeStep, onError: "fail" });
    expect(r.success).toBe(true);
  });

  it("accepts inputs with pipeline.input source", () => {
    const r = StepSchema.safeParse({
      ...minimalCodeStep,
      inputs: { data: { from: "pipeline.input", path: "$.items" } },
    });
    expect(r.success).toBe(true);
  });

  it("accepts inputs with step source", () => {
    const r = StepSchema.safeParse({
      ...minimalCodeStep,
      inputs: { prev: { from: "step", stepId: "step-0" } },
    });
    expect(r.success).toBe(true);
  });

  it("accepts inputs with literal source", () => {
    const r = StepSchema.safeParse({
      ...minimalCodeStep,
      inputs: { flag: { from: "literal", value: true } },
    });
    expect(r.success).toBe(true);
  });

  it("accepts a skipIf string (pre-execution guard expression)", () => {
    const r = StepSchema.safeParse({ ...minimalCodeStep, skipIf: "input.enabled = true" });
    expect(r.success).toBe(true);
  });

  it("accepts code up to 512000 chars", () => {
    const r = StepSchema.safeParse({ ...minimalCodeStep, code: "x".repeat(512_000) });
    expect(r.success).toBe(true);
  });
});

describe("StepSchema — code step — invalid", () => {
  it("rejects missing code field", () => {
    const { code: _code, ...rest } = minimalCodeStep;
    fails(StepSchema, rest);
  });

  it("rejects unknown language", () => {
    fails(StepSchema, { ...minimalCodeStep, language: "ruby" });
  });

  it("rejects step id with uppercase letters", () => {
    fails(StepSchema, { ...minimalCodeStep, id: "MyStep" });
  });

  it("rejects step id starting with hyphen", () => {
    fails(StepSchema, { ...minimalCodeStep, id: "-step" });
  });

  it("rejects step id ending with hyphen", () => {
    fails(StepSchema, { ...minimalCodeStep, id: "step-" });
  });

  it("rejects step id longer than 64 chars", () => {
    fails(StepSchema, { ...minimalCodeStep, id: "a".repeat(65) });
  });

  it("rejects empty step id", () => {
    fails(StepSchema, { ...minimalCodeStep, id: "" });
  });

  it("rejects step name longer than 255 chars", () => {
    fails(StepSchema, { ...minimalCodeStep, name: "a".repeat(256) });
  });

  it("rejects empty step name", () => {
    fails(StepSchema, { ...minimalCodeStep, name: "" });
  });

  it("rejects timeout below 1000ms", () => {
    fails(StepSchema, { ...minimalCodeStep, timeout: 999 });
  });

  it("rejects timeout above 3_600_000ms", () => {
    fails(StepSchema, { ...minimalCodeStep, timeout: 3_600_001 });
  });

  it("rejects fractional timeout", () => {
    fails(StepSchema, { ...minimalCodeStep, timeout: 1000.5 });
  });

  it("rejects unknown onError value", () => {
    fails(StepSchema, { ...minimalCodeStep, onError: "retry" });
  });

  it("rejects empty code string", () => {
    fails(StepSchema, { ...minimalCodeStep, code: "" });
  });

  it("rejects code exceeding 512000 chars", () => {
    fails(StepSchema, { ...minimalCodeStep, code: "x".repeat(512_001) });
  });
});

// ---------------------------------------------------------------------------
// StepSchema — connector step
// ---------------------------------------------------------------------------

const connectorStep = {
  id: "conn-1",
  name: "Connector Step",
  type: "connector" as const,
  connectorInstanceId: "550e8400-e29b-41d4-a716-446655440000",
  waitForCompletion: true,
};

describe("StepSchema — connector step — valid", () => {
  it("accepts minimal connector step", () => {
    const r = StepSchema.safeParse(connectorStep);
    expect(r.success).toBe(true);
  });

  it("accepts syncMode: full", () => {
    const r = StepSchema.safeParse({ ...connectorStep, syncMode: "full" });
    expect(r.success).toBe(true);
  });

  it("accepts syncMode: incremental", () => {
    const r = StepSchema.safeParse({ ...connectorStep, syncMode: "incremental" });
    expect(r.success).toBe(true);
  });

  it("accepts waitForCompletion: false", () => {
    const r = StepSchema.safeParse({ ...connectorStep, waitForCompletion: false });
    expect(r.success).toBe(true);
  });
});

describe("StepSchema — connector step — invalid", () => {
  it("rejects non-UUID connectorInstanceId", () => {
    fails(StepSchema, { ...connectorStep, connectorInstanceId: "not-a-uuid" });
  });

  it("rejects unknown syncMode value", () => {
    fails(StepSchema, { ...connectorStep, syncMode: "partial" });
  });

  it("rejects missing connectorInstanceId", () => {
    const { connectorInstanceId: _c, ...rest } = connectorStep;
    fails(StepSchema, rest);
  });
});

// ---------------------------------------------------------------------------
// StepSchema — transformer step
// ---------------------------------------------------------------------------

const transformerStep = {
  id: "trans-1",
  name: "Transformer Step",
  type: "transformer" as const,
  transformerId: "plugin-xyz",
};

describe("StepSchema — transformer step — valid", () => {
  it("accepts minimal transformer step", () => {
    const r = StepSchema.safeParse(transformerStep);
    expect(r.success).toBe(true);
  });

  it("accepts optional config record", () => {
    const r = StepSchema.safeParse({ ...transformerStep, config: { key: "value" } });
    expect(r.success).toBe(true);
  });

  it("accepts optional entityType string", () => {
    const r = StepSchema.safeParse({ ...transformerStep, entityType: "product" });
    expect(r.success).toBe(true);
  });
});

describe("StepSchema — transformer step — invalid", () => {
  it("rejects missing transformerId", () => {
    fails(StepSchema, { id: "trans-1", name: "T", type: "transformer" });
  });
});

// ---------------------------------------------------------------------------
// StepSchema — conditional step
// ---------------------------------------------------------------------------

const conditionalStep = {
  id: "cond-1",
  name: "Conditional Step",
  type: "conditional" as const,
  condition: {
    field: "user.status",
    operator: "eq" as const,
    value: "active",
  },
  thenStepId: "step-true",
  elseStepId: "step-false",
};

describe("StepSchema — conditional step — valid", () => {
  it("accepts valid conditional step with all operators and both branch targets", () => {
    const r = StepSchema.safeParse(conditionalStep);
    expect(r.success).toBe(true);
  });

  it("accepts conditional step without elseStepId (falls through to next sequential step)", () => {
    const { elseStepId: _e, ...withoutElse } = conditionalStep;
    const r = StepSchema.safeParse(withoutElse);
    expect(r.success).toBe(true);
  });

  it("accepts exists operator without a value", () => {
    const r = StepSchema.safeParse({
      ...conditionalStep,
      condition: { field: "user.email", operator: "exists" },
    });
    expect(r.success).toBe(true);
  });

  it("accepts every supported operator", () => {
    const operators = [
      "eq", "neq", "gt", "gte", "lt", "lte",
      "contains", "not_contains", "exists", "not_exists", "matches",
    ] as const;
    for (const operator of operators) {
      const r = StepSchema.safeParse({
        ...conditionalStep,
        condition: { field: "score", operator, value: 10 },
      });
      expect(r.success).toBe(true);
    }
  });
});

describe("StepSchema — conditional step — invalid", () => {
  it("rejects missing condition object", () => {
    const { condition: _c, ...rest } = conditionalStep;
    fails(StepSchema, rest);
  });

  it("rejects missing thenStepId", () => {
    const { thenStepId: _t, ...rest } = conditionalStep;
    fails(StepSchema, rest);
  });

  it("rejects unknown operator", () => {
    fails(StepSchema, {
      ...conditionalStep,
      condition: { ...conditionalStep.condition, operator: "fuzzy" },
    });
  });

  it("rejects empty condition field string", () => {
    fails(StepSchema, {
      ...conditionalStep,
      condition: { ...conditionalStep.condition, field: "" },
    });
  });
});

// ---------------------------------------------------------------------------
// StepSchema — parallel step
// ---------------------------------------------------------------------------

const parallelStep = {
  id: "par-1",
  name: "Parallel Step",
  type: "parallel" as const,
  branches: [
    { id: "branch-a", entryStepId: "step-a1", steps: [{ ...minimalCodeStep, id: "step-a1" }] },
    { id: "branch-b", entryStepId: "step-b1", steps: [{ ...minimalCodeStep, id: "step-b1" }] },
  ],
  waitMode: "all" as const,
};

describe("StepSchema — parallel step — valid", () => {
  it("accepts a valid parallel step with 2 branches (minimum)", () => {
    const r = StepSchema.safeParse(parallelStep);
    expect(r.success).toBe(true);
  });

  it("accepts waitMode: any", () => {
    const r = StepSchema.safeParse({ ...parallelStep, waitMode: "any" });
    expect(r.success).toBe(true);
  });

  it("accepts up to 10 branches (maximum)", () => {
    const branches = Array.from({ length: 10 }, (_, i) => ({
      id: `branch-${i}`,
      entryStepId: `step-${i}`,
      steps: [{ ...minimalCodeStep, id: `step-${i}` }],
    }));
    const r = StepSchema.safeParse({ ...parallelStep, branches });
    expect(r.success).toBe(true);
  });

  it("accepts nested steps inside branches (recursive)", () => {
    const nestedBranch = {
      id: "nested-branch",
      entryStepId: "nested-step",
      steps: [
        {
          id: "nested-step",
          name: "Nested Code Step",
          type: "code" as const,
          language: "python" as const,
          code: "pass",
        },
      ],
    };
    const r = StepSchema.safeParse({
      ...parallelStep,
      branches: [
        ...parallelStep.branches,
        nestedBranch,
      ],
    });
    expect(r.success).toBe(true);
  });
});

describe("StepSchema — parallel step — invalid", () => {
  it("rejects parallel with fewer than 2 branches", () => {
    fails(StepSchema, { ...parallelStep, branches: [parallelStep.branches[0]] });
  });

  it("rejects parallel with more than 10 branches", () => {
    const branches = Array.from({ length: 11 }, (_, i) => ({
      id: `branch-${i}`,
      entryStepId: `step-${i}`,
      steps: [{ ...minimalCodeStep, id: `step-${i}` }],
    }));
    fails(StepSchema, { ...parallelStep, branches });
  });

  it("rejects unknown waitMode", () => {
    fails(StepSchema, { ...parallelStep, waitMode: "none" });
  });

  it("rejects missing branches array", () => {
    const { branches: _b, ...rest } = parallelStep;
    fails(StepSchema, rest);
  });
});

// ---------------------------------------------------------------------------
// StepSchema — webhook step
// ---------------------------------------------------------------------------

const webhookStep = {
  id: "hook-1",
  name: "Webhook Step",
  type: "webhook" as const,
  url: "https://api.example.com/callback",
  method: "POST" as const,
};

describe("StepSchema — webhook step — valid", () => {
  it("accepts minimal webhook step", () => {
    const r = StepSchema.safeParse(webhookStep);
    expect(r.success).toBe(true);
  });

  it("accepts method GET", () => {
    const r = StepSchema.safeParse({ ...webhookStep, method: "GET" });
    expect(r.success).toBe(true);
  });

  it("accepts method PUT", () => {
    const r = StepSchema.safeParse({ ...webhookStep, method: "PUT" });
    expect(r.success).toBe(true);
  });

  it("accepts method PATCH", () => {
    const r = StepSchema.safeParse({ ...webhookStep, method: "PATCH" });
    expect(r.success).toBe(true);
  });

  it("accepts method DELETE", () => {
    const r = StepSchema.safeParse({ ...webhookStep, method: "DELETE" });
    expect(r.success).toBe(true);
  });

  it("accepts optional headers record", () => {
    const r = StepSchema.safeParse({
      ...webhookStep,
      headers: { Authorization: "Bearer token" },
    });
    expect(r.success).toBe(true);
  });

  it("accepts optional body field", () => {
    const r = StepSchema.safeParse({ ...webhookStep, body: { key: "value" } });
    expect(r.success).toBe(true);
  });

  it("accepts optional responseMapping", () => {
    const r = StepSchema.safeParse({ ...webhookStep, responseMapping: "body.result" });
    expect(r.success).toBe(true);
  });

  it("accepts webhook timeout up to 120_000ms (cap for webhooks)", () => {
    const r = StepSchema.safeParse({ ...webhookStep, timeout: 120_000 });
    expect(r.success).toBe(true);
  });

  it("accepts webhook timeout at minimum (1000ms)", () => {
    const r = StepSchema.safeParse({ ...webhookStep, timeout: 1000 });
    expect(r.success).toBe(true);
  });
});

describe("StepSchema — webhook step — invalid", () => {
  it("rejects HTTP url (must be HTTPS)", () => {
    fails(StepSchema, { ...webhookStep, url: "http://example.com/hook" });
  });

  it("rejects non-URL string for url", () => {
    fails(StepSchema, { ...webhookStep, url: "not-a-url" });
  });

  it("rejects unknown HTTP method", () => {
    fails(StepSchema, { ...webhookStep, method: "HEAD" });
  });

  it("rejects timeout above 120_000ms for webhook step", () => {
    fails(StepSchema, { ...webhookStep, timeout: 120_001 });
  });

  it("rejects missing url", () => {
    const { url: _u, ...rest } = webhookStep;
    fails(StepSchema, rest);
  });

  it("rejects missing method", () => {
    const { method: _m, ...rest } = webhookStep;
    fails(StepSchema, rest);
  });
});

// ---------------------------------------------------------------------------
// RetryConfigSchema
// ---------------------------------------------------------------------------

describe("RetryConfigSchema — valid", () => {
  it("accepts a fully specified retry config", () => {
    const r = RetryConfigSchema.safeParse({
      maxRetries: 3,
      backoffMs: 2000,
      backoffMultiplier: 2,
    });
    expect(r.success).toBe(true);
  });

  it("defaults maxRetries to 0 when omitted", () => {
    const r = RetryConfigSchema.safeParse({});
    expect(r.success && r.data.maxRetries).toBe(0);
  });

  it("defaults backoffMs to 1000 when omitted", () => {
    const r = RetryConfigSchema.safeParse({});
    expect(r.success && r.data.backoffMs).toBe(1000);
  });

  it("defaults backoffMultiplier to 2 when omitted", () => {
    const r = RetryConfigSchema.safeParse({});
    expect(r.success && r.data.backoffMultiplier).toBe(2);
  });

  it("accepts maxRetries=0 (no retries)", () => {
    const r = RetryConfigSchema.safeParse({ maxRetries: 0 });
    expect(r.success).toBe(true);
  });

  it("accepts maxRetries=10 (maximum)", () => {
    const r = RetryConfigSchema.safeParse({ maxRetries: 10 });
    expect(r.success).toBe(true);
  });

  it("accepts backoffMs=100 (minimum)", () => {
    const r = RetryConfigSchema.safeParse({ backoffMs: 100 });
    expect(r.success).toBe(true);
  });

  it("accepts backoffMs=60000 (maximum)", () => {
    const r = RetryConfigSchema.safeParse({ backoffMs: 60_000 });
    expect(r.success).toBe(true);
  });

  it("accepts backoffMultiplier=1 (no growth)", () => {
    const r = RetryConfigSchema.safeParse({ backoffMultiplier: 1 });
    expect(r.success).toBe(true);
  });

  it("accepts backoffMultiplier=5 (maximum)", () => {
    const r = RetryConfigSchema.safeParse({ backoffMultiplier: 5 });
    expect(r.success).toBe(true);
  });
});

describe("RetryConfigSchema — invalid", () => {
  it("rejects maxRetries=-1 (below minimum)", () => {
    fails(RetryConfigSchema, { maxRetries: -1 });
  });

  it("rejects maxRetries=11 (above maximum)", () => {
    fails(RetryConfigSchema, { maxRetries: 11 });
  });

  it("rejects fractional maxRetries", () => {
    fails(RetryConfigSchema, { maxRetries: 1.5 });
  });

  it("rejects backoffMs=99 (below minimum)", () => {
    fails(RetryConfigSchema, { backoffMs: 99 });
  });

  it("rejects backoffMs=60001 (above maximum)", () => {
    fails(RetryConfigSchema, { backoffMs: 60_001 });
  });

  it("rejects fractional backoffMs", () => {
    fails(RetryConfigSchema, { backoffMs: 500.5 });
  });

  it("rejects backoffMultiplier=0.9 (below minimum of 1)", () => {
    fails(RetryConfigSchema, { backoffMultiplier: 0.9 });
  });

  it("rejects backoffMultiplier=5.1 (above maximum)", () => {
    fails(RetryConfigSchema, { backoffMultiplier: 5.1 });
  });
});

// ---------------------------------------------------------------------------
// StepBaseSchema — retryConfig and fallbackStepId fields
// ---------------------------------------------------------------------------

describe("StepSchema — retryConfig field", () => {
  it("accepts a code step with a valid retryConfig", () => {
    const r = StepSchema.safeParse({
      ...minimalCodeStep,
      retryConfig: { maxRetries: 3, backoffMs: 1000, backoffMultiplier: 2 },
    });
    expect(r.success).toBe(true);
  });

  it("retryConfig is optional — absent by default", () => {
    const r = StepSchema.safeParse(minimalCodeStep);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.retryConfig).toBeUndefined();
    }
  });

  it("accepts retryConfig with only defaults applied", () => {
    const r = StepSchema.safeParse({
      ...minimalCodeStep,
      retryConfig: {},
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.retryConfig?.maxRetries).toBe(0);
      expect(r.data.retryConfig?.backoffMs).toBe(1000);
      expect(r.data.retryConfig?.backoffMultiplier).toBe(2);
    }
  });

  it("rejects retryConfig with maxRetries > 10", () => {
    fails(StepSchema, {
      ...minimalCodeStep,
      retryConfig: { maxRetries: 11, backoffMs: 1000, backoffMultiplier: 2 },
    });
  });

  it("rejects retryConfig with backoffMs < 100", () => {
    fails(StepSchema, {
      ...minimalCodeStep,
      retryConfig: { maxRetries: 1, backoffMs: 50, backoffMultiplier: 2 },
    });
  });

  it("rejects retryConfig with backoffMultiplier > 5", () => {
    fails(StepSchema, {
      ...minimalCodeStep,
      retryConfig: { maxRetries: 1, backoffMs: 1000, backoffMultiplier: 6 },
    });
  });
});

describe("StepSchema — fallbackStepId field", () => {
  it("accepts a code step with a valid fallbackStepId", () => {
    const r = StepSchema.safeParse({
      ...minimalCodeStep,
      fallbackStepId: "step-fallback",
    });
    expect(r.success).toBe(true);
  });

  it("fallbackStepId is optional — absent by default", () => {
    const r = StepSchema.safeParse(minimalCodeStep);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.fallbackStepId).toBeUndefined();
    }
  });

  it("rejects empty string fallbackStepId", () => {
    fails(StepSchema, { ...minimalCodeStep, fallbackStepId: "" });
  });

  it("rejects fallbackStepId longer than 64 chars", () => {
    fails(StepSchema, { ...minimalCodeStep, fallbackStepId: "a".repeat(65) });
  });

  it("accepts both retryConfig and fallbackStepId together", () => {
    const r = StepSchema.safeParse({
      ...minimalCodeStep,
      retryConfig: { maxRetries: 2, backoffMs: 500, backoffMultiplier: 1.5 },
      fallbackStepId: "step-fallback",
    });
    expect(r.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PipelineDefinitionSchema
// ---------------------------------------------------------------------------

describe("PipelineDefinitionSchema — valid", () => {
  it("accepts a minimal valid definition (version=1, one step)", () => {
    const r = PipelineDefinitionSchema.safeParse(minimalDefinition);
    expect(r.success).toBe(true);
  });

  it("accepts definition with optional options object", () => {
    const r = PipelineDefinitionSchema.safeParse({
      ...minimalDefinition,
      options: { maxConcurrentRuns: 5, allowConcurrentRuns: true },
    });
    expect(r.success).toBe(true);
  });

  it("accepts options.maxConcurrentRuns at min (1)", () => {
    const r = PipelineDefinitionSchema.safeParse({
      ...minimalDefinition,
      options: { maxConcurrentRuns: 1 },
    });
    expect(r.success).toBe(true);
  });

  it("accepts options.maxConcurrentRuns at max (50)", () => {
    const r = PipelineDefinitionSchema.safeParse({
      ...minimalDefinition,
      options: { maxConcurrentRuns: 50 },
    });
    expect(r.success).toBe(true);
  });

  it("accepts options.stepTimeout at min (1000)", () => {
    const r = PipelineDefinitionSchema.safeParse({
      ...minimalDefinition,
      options: { stepTimeout: 1000 },
    });
    expect(r.success).toBe(true);
  });

  it("accepts options.stepTimeout at max (3_600_000)", () => {
    const r = PipelineDefinitionSchema.safeParse({
      ...minimalDefinition,
      options: { stepTimeout: 3_600_000 },
    });
    expect(r.success).toBe(true);
  });

  it("accepts options.retainRunsCount at min (1)", () => {
    const r = PipelineDefinitionSchema.safeParse({
      ...minimalDefinition,
      options: { retainRunsCount: 1 },
    });
    expect(r.success).toBe(true);
  });

  it("accepts options.retainRunsCount at max (1000)", () => {
    const r = PipelineDefinitionSchema.safeParse({
      ...minimalDefinition,
      options: { retainRunsCount: 1000 },
    });
    expect(r.success).toBe(true);
  });

  it("accepts up to 100 steps (max)", () => {
    const steps = Array.from({ length: 100 }, (_, i) => ({
      id: `step-${String(i).padStart(3, "0")}`,
      name: `Step ${i}`,
      type: "code" as const,
      language: "javascript" as const,
      code: "return null;",
    }));
    const r = PipelineDefinitionSchema.safeParse({
      version: 1,
      entryStepId: "step-000",
      steps,
    });
    expect(r.success).toBe(true);
  });
});

describe("PipelineDefinitionSchema — invalid", () => {
  it("rejects version other than 1", () => {
    fails(PipelineDefinitionSchema, { ...minimalDefinition, version: 2 });
  });

  it("rejects missing entryStepId", () => {
    const { entryStepId: _e, ...rest } = minimalDefinition;
    fails(PipelineDefinitionSchema, rest);
  });

  it("rejects empty steps array", () => {
    fails(PipelineDefinitionSchema, { ...minimalDefinition, steps: [] });
  });

  it("rejects more than 100 steps", () => {
    const steps = Array.from({ length: 101 }, (_, i) => ({
      id: `step-${String(i).padStart(3, "0")}`,
      name: `Step ${i}`,
      type: "code" as const,
      language: "javascript" as const,
      code: "x",
    }));
    fails(PipelineDefinitionSchema, { version: 1, entryStepId: "step-000", steps });
  });

  it("rejects options.maxConcurrentRuns = 0", () => {
    fails(PipelineDefinitionSchema, {
      ...minimalDefinition,
      options: { maxConcurrentRuns: 0 },
    });
  });

  it("rejects options.maxConcurrentRuns = 51", () => {
    fails(PipelineDefinitionSchema, {
      ...minimalDefinition,
      options: { maxConcurrentRuns: 51 },
    });
  });

  it("rejects options.retainRunsCount = 0", () => {
    fails(PipelineDefinitionSchema, {
      ...minimalDefinition,
      options: { retainRunsCount: 0 },
    });
  });

  it("rejects options.retainRunsCount = 1001", () => {
    fails(PipelineDefinitionSchema, {
      ...minimalDefinition,
      options: { retainRunsCount: 1001 },
    });
  });
});

// ---------------------------------------------------------------------------
// CreatePipelineSchema
// ---------------------------------------------------------------------------

describe("CreatePipelineSchema — valid", () => {
  it("accepts a minimal valid create request", () => {
    const r = CreatePipelineSchema.safeParse({
      name: "My Pipeline",
      definition: minimalDefinition,
    });
    expect(r.success).toBe(true);
  });

  it("defaults isActive to true when omitted", () => {
    const r = CreatePipelineSchema.safeParse({
      name: "My Pipeline",
      definition: minimalDefinition,
    });
    expect(r.success && r.data.isActive).toBe(true);
  });

  it("accepts isActive: false", () => {
    const r = CreatePipelineSchema.safeParse({
      name: "My Pipeline",
      definition: minimalDefinition,
      isActive: false,
    });
    expect(r.success && r.data.isActive).toBe(false);
  });

  it("accepts optional slug matching the regex", () => {
    const r = CreatePipelineSchema.safeParse({
      name: "My Pipeline",
      definition: minimalDefinition,
      slug: "my-pipeline-v2",
    });
    expect(r.success).toBe(true);
  });

  it("accepts optional description up to 1000 chars", () => {
    const r = CreatePipelineSchema.safeParse({
      name: "My Pipeline",
      definition: minimalDefinition,
      description: "d".repeat(1000),
    });
    expect(r.success).toBe(true);
  });

  it("trims whitespace from name", () => {
    const r = CreatePipelineSchema.safeParse({
      name: "  trimmed  ",
      definition: minimalDefinition,
    });
    expect(r.success && r.data.name).toBe("trimmed");
  });

  it("accepts name with exactly 1 char", () => {
    const r = CreatePipelineSchema.safeParse({
      name: "x",
      definition: minimalDefinition,
    });
    expect(r.success).toBe(true);
  });

  it("accepts name with exactly 255 chars", () => {
    const r = CreatePipelineSchema.safeParse({
      name: "a".repeat(255),
      definition: minimalDefinition,
    });
    expect(r.success).toBe(true);
  });
});

describe("CreatePipelineSchema — invalid", () => {
  it("rejects empty name", () => {
    fails(CreatePipelineSchema, { name: "", definition: minimalDefinition });
  });

  it("rejects name longer than 255 chars", () => {
    fails(CreatePipelineSchema, { name: "a".repeat(256), definition: minimalDefinition });
  });

  it("rejects description longer than 1000 chars", () => {
    fails(CreatePipelineSchema, {
      name: "x",
      definition: minimalDefinition,
      description: "d".repeat(1001),
    });
  });

  it("rejects slug shorter than 3 chars", () => {
    fails(CreatePipelineSchema, {
      name: "x",
      definition: minimalDefinition,
      slug: "ab",
    });
  });

  it("rejects slug with uppercase letters", () => {
    fails(CreatePipelineSchema, {
      name: "x",
      definition: minimalDefinition,
      slug: "My-Pipeline",
    });
  });

  it("rejects slug longer than 64 chars", () => {
    fails(CreatePipelineSchema, {
      name: "x",
      definition: minimalDefinition,
      slug: "a".repeat(65),
    });
  });

  it("rejects missing definition", () => {
    fails(CreatePipelineSchema, { name: "x" });
  });

  it("rejects missing name", () => {
    fails(CreatePipelineSchema, { definition: minimalDefinition });
  });
});

// ---------------------------------------------------------------------------
// PatchPipelineSchema
// ---------------------------------------------------------------------------

describe("PatchPipelineSchema — valid", () => {
  it("accepts empty object (all fields optional)", () => {
    const r = PatchPipelineSchema.safeParse({});
    expect(r.success).toBe(true);
  });

  it("accepts name alone", () => {
    const r = PatchPipelineSchema.safeParse({ name: "Updated Name" });
    expect(r.success).toBe(true);
  });

  it("accepts description alone", () => {
    const r = PatchPipelineSchema.safeParse({ description: "New desc" });
    expect(r.success).toBe(true);
  });

  it("accepts isActive: false alone", () => {
    const r = PatchPipelineSchema.safeParse({ isActive: false });
    expect(r.success).toBe(true);
  });

  it("accepts definition alone", () => {
    const r = PatchPipelineSchema.safeParse({ definition: minimalDefinition });
    expect(r.success).toBe(true);
  });

  it("accepts all optional fields together", () => {
    const r = PatchPipelineSchema.safeParse({
      name: "Updated",
      description: "Updated desc",
      isActive: true,
      definition: minimalDefinition,
    });
    expect(r.success).toBe(true);
  });
});

describe("PatchPipelineSchema — invalid", () => {
  it("rejects empty name when provided", () => {
    fails(PatchPipelineSchema, { name: "" });
  });

  it("rejects name longer than 255 chars", () => {
    fails(PatchPipelineSchema, { name: "a".repeat(256) });
  });

  it("rejects description longer than 1000 chars", () => {
    fails(PatchPipelineSchema, { description: "d".repeat(1001) });
  });

  it("rejects invalid definition when provided", () => {
    fails(PatchPipelineSchema, { definition: { version: 2, entryStepId: "x", steps: [] } });
  });
});

// ---------------------------------------------------------------------------
// TriggerPipelineSchema
// ---------------------------------------------------------------------------

describe("TriggerPipelineSchema — valid", () => {
  it("accepts empty object and defaults input to {}", () => {
    const r = TriggerPipelineSchema.safeParse({});
    expect(r.success && r.data.input).toEqual({});
  });

  it("accepts input with arbitrary key-value pairs", () => {
    const r = TriggerPipelineSchema.safeParse({
      input: { userId: "u-1", count: 5, tags: ["a", "b"] },
    });
    expect(r.success).toBe(true);
  });

  it("accepts explicit empty input {}", () => {
    const r = TriggerPipelineSchema.safeParse({ input: {} });
    expect(r.success && r.data.input).toEqual({});
  });
});

describe("TriggerPipelineSchema — invalid", () => {
  it("rejects non-record input (array)", () => {
    fails(TriggerPipelineSchema, { input: [1, 2, 3] });
  });

  it("rejects non-record input (string)", () => {
    fails(TriggerPipelineSchema, { input: "string" });
  });
});

// ---------------------------------------------------------------------------
// CreateScheduleSchema
// ---------------------------------------------------------------------------

describe("CreateScheduleSchema — valid", () => {
  it("accepts a minimal valid schedule", () => {
    const r = CreateScheduleSchema.safeParse({
      pipelineId: "550e8400-e29b-41d4-a716-446655440000",
      cronExpr: "0 * * * *",
    });
    expect(r.success).toBe(true);
  });

  it("defaults timezone to UTC when omitted", () => {
    const r = CreateScheduleSchema.safeParse({
      pipelineId: "550e8400-e29b-41d4-a716-446655440000",
      cronExpr: "0 * * * *",
    });
    expect(r.success && r.data.timezone).toBe("UTC");
  });

  it("defaults enabled to true when omitted", () => {
    const r = CreateScheduleSchema.safeParse({
      pipelineId: "550e8400-e29b-41d4-a716-446655440000",
      cronExpr: "0 * * * *",
    });
    expect(r.success && r.data.enabled).toBe(true);
  });

  it("defaults inputTemplate to {} when omitted", () => {
    const r = CreateScheduleSchema.safeParse({
      pipelineId: "550e8400-e29b-41d4-a716-446655440000",
      cronExpr: "0 * * * *",
    });
    expect(r.success && r.data.inputTemplate).toEqual({});
  });

  it("accepts explicit timezone", () => {
    const r = CreateScheduleSchema.safeParse({
      pipelineId: "550e8400-e29b-41d4-a716-446655440000",
      cronExpr: "0 9 * * 1-5",
      timezone: "America/New_York",
    });
    expect(r.success).toBe(true);
  });

  it("accepts enabled: false", () => {
    const r = CreateScheduleSchema.safeParse({
      pipelineId: "550e8400-e29b-41d4-a716-446655440000",
      cronExpr: "0 * * * *",
      enabled: false,
    });
    expect(r.success && r.data.enabled).toBe(false);
  });

  it("accepts inputTemplate with values", () => {
    const r = CreateScheduleSchema.safeParse({
      pipelineId: "550e8400-e29b-41d4-a716-446655440000",
      cronExpr: "0 * * * *",
      inputTemplate: { batchSize: 100 },
    });
    expect(r.success).toBe(true);
  });

  it("accepts cronExpr up to 100 chars", () => {
    const r = CreateScheduleSchema.safeParse({
      pipelineId: "550e8400-e29b-41d4-a716-446655440000",
      cronExpr: "0 * * * *",
    });
    expect(r.success).toBe(true);
  });
});

describe("CreateScheduleSchema — invalid", () => {
  it("rejects non-UUID pipelineId", () => {
    fails(CreateScheduleSchema, { pipelineId: "not-a-uuid", cronExpr: "0 * * * *" });
  });

  it("rejects missing pipelineId", () => {
    fails(CreateScheduleSchema, { cronExpr: "0 * * * *" });
  });

  it("rejects empty cronExpr", () => {
    fails(CreateScheduleSchema, {
      pipelineId: "550e8400-e29b-41d4-a716-446655440000",
      cronExpr: "",
    });
  });

  it("rejects cronExpr longer than 100 chars", () => {
    fails(CreateScheduleSchema, {
      pipelineId: "550e8400-e29b-41d4-a716-446655440000",
      cronExpr: "0".repeat(101),
    });
  });

  it("rejects empty timezone when provided", () => {
    fails(CreateScheduleSchema, {
      pipelineId: "550e8400-e29b-41d4-a716-446655440000",
      cronExpr: "0 * * * *",
      timezone: "",
    });
  });

  it("rejects timezone longer than 64 chars", () => {
    fails(CreateScheduleSchema, {
      pipelineId: "550e8400-e29b-41d4-a716-446655440000",
      cronExpr: "0 * * * *",
      timezone: "a".repeat(65),
    });
  });
});

// ---------------------------------------------------------------------------
// PatchScheduleSchema
// ---------------------------------------------------------------------------

describe("PatchScheduleSchema — valid", () => {
  it("accepts empty object (all fields optional)", () => {
    const r = PatchScheduleSchema.safeParse({});
    expect(r.success).toBe(true);
  });

  it("accepts cronExpr alone", () => {
    const r = PatchScheduleSchema.safeParse({ cronExpr: "*/5 * * * *" });
    expect(r.success).toBe(true);
  });

  it("accepts timezone alone", () => {
    const r = PatchScheduleSchema.safeParse({ timezone: "Europe/London" });
    expect(r.success).toBe(true);
  });

  it("accepts enabled: false alone", () => {
    const r = PatchScheduleSchema.safeParse({ enabled: false });
    expect(r.success).toBe(true);
  });

  it("accepts inputTemplate alone", () => {
    const r = PatchScheduleSchema.safeParse({ inputTemplate: { key: "val" } });
    expect(r.success).toBe(true);
  });
});

describe("PatchScheduleSchema — invalid", () => {
  it("rejects empty cronExpr when provided", () => {
    fails(PatchScheduleSchema, { cronExpr: "" });
  });

  it("rejects cronExpr longer than 100 chars", () => {
    fails(PatchScheduleSchema, { cronExpr: "x".repeat(101) });
  });

  it("rejects empty timezone when provided", () => {
    fails(PatchScheduleSchema, { timezone: "" });
  });
});

// ---------------------------------------------------------------------------
// ListPipelinesQuery
// ---------------------------------------------------------------------------

describe("ListPipelinesQuery — valid", () => {
  it("accepts empty object with default limit 50", () => {
    const r = ListPipelinesQuery.safeParse({});
    expect(r.success && r.data.limit).toBe(50);
  });

  it("coerces string limit to number", () => {
    const r = ListPipelinesQuery.safeParse({ limit: "25" });
    expect(r.success && r.data.limit).toBe(25);
  });

  it("accepts limit at minimum (1)", () => {
    const r = ListPipelinesQuery.safeParse({ limit: 1 });
    expect(r.success).toBe(true);
  });

  it("accepts limit at maximum (100)", () => {
    const r = ListPipelinesQuery.safeParse({ limit: 100 });
    expect(r.success).toBe(true);
  });

  it("accepts optional cursor string", () => {
    const r = ListPipelinesQuery.safeParse({ cursor: "cursor-123" });
    expect(r.success && r.data.cursor).toBe("cursor-123");
  });

  it("transforms filter[isActive][eq]='true' to boolean true", () => {
    const r = ListPipelinesQuery.safeParse({ "filter[isActive][eq]": "true" });
    expect(r.success && r.data["filter[isActive][eq]"]).toBe(true);
  });

  it("transforms filter[isActive][eq]='false' to boolean false", () => {
    const r = ListPipelinesQuery.safeParse({ "filter[isActive][eq]": "false" });
    expect(r.success && r.data["filter[isActive][eq]"]).toBe(false);
  });

  it("accepts optional sort string", () => {
    const r = ListPipelinesQuery.safeParse({ sort: "-created_at" });
    expect(r.success).toBe(true);
  });
});

describe("ListPipelinesQuery — invalid", () => {
  it("rejects limit = 0", () => {
    fails(ListPipelinesQuery, { limit: 0 });
  });

  it("rejects limit = 101", () => {
    fails(ListPipelinesQuery, { limit: 101 });
  });

  it("rejects fractional limit", () => {
    fails(ListPipelinesQuery, { limit: 2.5 });
  });

  it("rejects filter[isActive][eq] with non-boolean string", () => {
    fails(ListPipelinesQuery, { "filter[isActive][eq]": "yes" });
  });
});

// ---------------------------------------------------------------------------
// ListRunsQuery
// ---------------------------------------------------------------------------

describe("ListRunsQuery — valid", () => {
  it("accepts empty object with default limit 50", () => {
    const r = ListRunsQuery.safeParse({});
    expect(r.success && r.data.limit).toBe(50);
  });

  it("accepts filter[status][eq]: pending", () => {
    const r = ListRunsQuery.safeParse({ "filter[status][eq]": "pending" });
    expect(r.success).toBe(true);
  });

  it("accepts filter[status][eq]: running", () => {
    const r = ListRunsQuery.safeParse({ "filter[status][eq]": "running" });
    expect(r.success).toBe(true);
  });

  it("accepts filter[status][eq]: completed", () => {
    const r = ListRunsQuery.safeParse({ "filter[status][eq]": "completed" });
    expect(r.success).toBe(true);
  });

  it("accepts filter[status][eq]: failed", () => {
    const r = ListRunsQuery.safeParse({ "filter[status][eq]": "failed" });
    expect(r.success).toBe(true);
  });

  it("accepts filter[status][eq]: cancelled", () => {
    const r = ListRunsQuery.safeParse({ "filter[status][eq]": "cancelled" });
    expect(r.success).toBe(true);
  });
});

describe("ListRunsQuery — invalid", () => {
  it("rejects limit = 0", () => {
    fails(ListRunsQuery, { limit: 0 });
  });

  it("rejects limit = 101", () => {
    fails(ListRunsQuery, { limit: 101 });
  });

  it("rejects unknown status filter", () => {
    fails(ListRunsQuery, { "filter[status][eq]": "archived" });
  });
});

// ---------------------------------------------------------------------------
// ListSchedulesQuery
// ---------------------------------------------------------------------------

describe("ListSchedulesQuery — valid", () => {
  it("accepts empty object with default limit 50", () => {
    const r = ListSchedulesQuery.safeParse({});
    expect(r.success && r.data.limit).toBe(50);
  });

  it("coerces string limit to number", () => {
    const r = ListSchedulesQuery.safeParse({ limit: "10" });
    expect(r.success && r.data.limit).toBe(10);
  });

  it("accepts cursor string", () => {
    const r = ListSchedulesQuery.safeParse({ cursor: "abc" });
    expect(r.success && r.data.cursor).toBe("abc");
  });

  it("accepts sort string", () => {
    const r = ListSchedulesQuery.safeParse({ sort: "created_at" });
    expect(r.success).toBe(true);
  });
});

describe("ListSchedulesQuery — invalid", () => {
  it("rejects limit = 0", () => {
    fails(ListSchedulesQuery, { limit: 0 });
  });

  it("rejects limit = 101", () => {
    fails(ListSchedulesQuery, { limit: 101 });
  });
});

// ---------------------------------------------------------------------------
// InternalTriggerRequestSchema
// ---------------------------------------------------------------------------

describe("InternalTriggerRequestSchema — valid", () => {
  it("accepts a minimal valid internal trigger request", () => {
    const r = InternalTriggerRequestSchema.safeParse({
      pipelineId: "550e8400-e29b-41d4-a716-446655440000",
      tenantId: "550e8400-e29b-41d4-a716-446655440001",
      triggeredBy: "service",
      callerService: "ingestion-service",
    });
    expect(r.success).toBe(true);
  });

  it("accepts optional callerRequestId", () => {
    const r = InternalTriggerRequestSchema.safeParse({
      pipelineId: "550e8400-e29b-41d4-a716-446655440000",
      tenantId: "550e8400-e29b-41d4-a716-446655440001",
      triggeredBy: "service",
      callerService: "ingestion-service",
      callerRequestId: "req-abc-123",
    });
    expect(r.success).toBe(true);
  });

  it("accepts optional input record", () => {
    const r = InternalTriggerRequestSchema.safeParse({
      pipelineId: "550e8400-e29b-41d4-a716-446655440000",
      tenantId: "550e8400-e29b-41d4-a716-446655440001",
      triggeredBy: "service",
      callerService: "ingestion-service",
      input: { batchId: "batch-1" },
    });
    expect(r.success).toBe(true);
  });
});

describe("InternalTriggerRequestSchema — invalid", () => {
  it("rejects non-UUID pipelineId", () => {
    fails(InternalTriggerRequestSchema, {
      pipelineId: "not-a-uuid",
      tenantId: "550e8400-e29b-41d4-a716-446655440001",
      triggeredBy: "service",
      callerService: "ingestion-service",
    });
  });

  it("rejects non-UUID tenantId", () => {
    fails(InternalTriggerRequestSchema, {
      pipelineId: "550e8400-e29b-41d4-a716-446655440000",
      tenantId: "not-a-uuid",
      triggeredBy: "service",
      callerService: "ingestion-service",
    });
  });

  it("rejects triggeredBy value other than 'service'", () => {
    fails(InternalTriggerRequestSchema, {
      pipelineId: "550e8400-e29b-41d4-a716-446655440000",
      tenantId: "550e8400-e29b-41d4-a716-446655440001",
      triggeredBy: "manual",
      callerService: "ingestion-service",
    });
  });

  it("rejects empty callerService", () => {
    fails(InternalTriggerRequestSchema, {
      pipelineId: "550e8400-e29b-41d4-a716-446655440000",
      tenantId: "550e8400-e29b-41d4-a716-446655440001",
      triggeredBy: "service",
      callerService: "",
    });
  });

  it("rejects missing callerService", () => {
    fails(InternalTriggerRequestSchema, {
      pipelineId: "550e8400-e29b-41d4-a716-446655440000",
      tenantId: "550e8400-e29b-41d4-a716-446655440001",
      triggeredBy: "service",
    });
  });

  it("rejects non-record input when provided", () => {
    fails(InternalTriggerRequestSchema, {
      pipelineId: "550e8400-e29b-41d4-a716-446655440000",
      tenantId: "550e8400-e29b-41d4-a716-446655440001",
      triggeredBy: "service",
      callerService: "ingestion-service",
      input: "not-an-object",
    });
  });
});
