import { z } from "zod";
import { cronExpressionSchema } from "@oneplatform/core";

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

const UUIDSchema = z.string().uuid();

// ---------------------------------------------------------------------------
// Input mapping — defines how a step receives its inputs from prior context.
// Source may be the pipeline's top-level input, a prior step's output, or a
// literal value hardcoded in the definition.
// ---------------------------------------------------------------------------

const InputSourceSchema = z.discriminatedUnion("from", [
  z.object({
    from: z.literal("pipeline.input"),
    path: z.string().optional(),
  }),
  z.object({
    from: z.literal("step"),
    stepId: z.string(),
    path: z.string().optional(),
  }),
  z.object({
    from: z.literal("literal"),
    value: z.unknown(),
  }),
]);

// ---------------------------------------------------------------------------
// Step base — fields common to every step type.
// ---------------------------------------------------------------------------

// RetryConfig controls per-step automatic retry with exponential backoff.
// Delay before attempt N = backoffMs * (backoffMultiplier ^ (N - 1)).
// Example: backoffMs=1000, multiplier=2 → 1s, 2s, 4s, 8s, …
export const RetryConfigSchema = z.object({
  maxRetries: z.number().int().min(0).max(10).default(0),
  backoffMs: z.number().int().min(100).max(60_000).default(1000),
  backoffMultiplier: z.number().min(1).max(5).default(2),
});

const StepBaseSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9\-]*[a-z0-9]$/),
  name: z.string().min(1).max(255),
  type: z.enum([
    "code",
    "connector",
    "transformer",
    "transform",
    "conditional",
    "parallel",
    "webhook",
    "wait",
    "approval",
    "sub_workflow",
  ]),
  inputs: z.record(InputSourceSchema).optional(),
  onError: z.enum(["fail", "skip"]).default("fail"),
  // skipIf is a JSONata expression evaluated before running this step.
  // When the expression evaluates to a truthy value the step is skipped.
  // Named skipIf (not condition) to avoid a name collision with the
  // structured condition object on the conditional step type.
  skipIf: z.string().max(5000).optional(),
  // timeout override per step (ms). Max 1 hour.
  timeout: z.number().int().min(1000).max(3_600_000).optional(),
  // Per-step retry with exponential backoff. Applied before onError semantics.
  retryConfig: RetryConfigSchema.optional(),
  // If the step fails after all retries, execute this step id instead of
  // applying onError. The fallback step must exist in the same pipeline definition.
  fallbackStepId: z.string().min(1).max(64).optional(),
});

// ---------------------------------------------------------------------------
// Transform step schema — pre-built declarative data transformations (G-051).
//
// Each operation variant is a discriminated union member on the `operation`
// field.  The engine resolves the correct handler at runtime without a
// secondary dispatch table.
// ---------------------------------------------------------------------------

export const TransformOperationSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("dedup"),
    keyFields: z.array(z.string().min(1)).min(1),
    strategy: z.enum(["first", "last"]),
  }),
  z.object({
    operation: z.literal("filter"),
    // expression evaluated by the safe expression evaluator (no eval)
    condition: z.string().min(1).max(2000),
  }),
  z.object({
    operation: z.literal("map"),
    // outputField → expression mapping
    mappings: z.record(z.string().min(1)),
  }),
  z.object({
    operation: z.literal("aggregate"),
    groupBy: z.array(z.string().min(1)),
    aggregations: z
      .array(
        z.object({
          field: z.string().min(1),
          function: z.enum(["sum", "avg", "min", "max", "count"]),
          alias: z.string().min(1),
        }),
      )
      .min(1),
  }),
  z.object({
    operation: z.literal("pivot"),
    groupField: z.string().min(1),
    pivotField: z.string().min(1),
    valueField: z.string().min(1),
    aggregation: z.enum(["sum", "avg", "min", "max", "count"]),
  }),
  z.object({
    operation: z.literal("unpivot"),
    keyField: z.string().min(1),
    valueFields: z.array(z.string().min(1)).min(1),
    nameColumn: z.string().min(1),
    valueColumn: z.string().min(1),
  }),
  z.object({
    operation: z.literal("join"),
    // rightDataSource references a prior step id whose output is used as the
    // right-hand record set.  Resolved by the execution engine at runtime.
    rightDataSource: z.string().min(1),
    joinType: z.enum(["inner", "left", "right", "full"]),
    leftKey: z.string().min(1),
    rightKey: z.string().min(1),
  }),
  z.object({
    operation: z.literal("sort"),
    fields: z
      .array(
        z.object({
          field: z.string().min(1),
          direction: z.enum(["asc", "desc"]),
        }),
      )
      .min(1),
  }),
  z.object({
    operation: z.literal("limit"),
    count: z.number().int().positive(),
  }),
  z.object({
    operation: z.literal("rename"),
    fieldMap: z.record(z.string().min(1)),
  }),
]);

export const TransformStepSchema = StepBaseSchema.extend({
  type: z.literal("transform"),
  // dataSource is the step id whose output provides the input records.
  // When absent the step's resolved inputs are used directly.
  dataSource: z.string().min(1).optional(),
  transform: TransformOperationSchema,
});

// ---------------------------------------------------------------------------
// Sub-workflow step schema — exported so callers can reference it directly.
//
// inputMapping maps child pipeline input field names to dot-notation path
// strings resolved against the parent's { input, steps } context at runtime.
// This is intentionally simpler than InputSourceSchema: sub-workflow inputs
// are always derived from parent context, never from literals (which can be
// hardcoded in the child pipeline's definition instead).
// ---------------------------------------------------------------------------

export const SubWorkflowStepSchema = StepBaseSchema.extend({
  type: z.literal("sub_workflow"),
  pipelineId: z.string().uuid(),
  // Each key is a child input field name; each value is a dot-path resolved
  // against the parent's accumulated { input, steps } context.
  inputMapping: z.record(z.string()).optional(),
  // When true the parent step blocks until the child run reaches a terminal
  // state and merges the child's output. When false the child is dispatched
  // asynchronously and only the child runId is returned as output.
  waitForCompletion: z.boolean().default(true),
  // Wall-clock timeout for waiting on the child (ms). Distinct from the base
  // step timeout; both caps apply and the tighter one wins.
  timeoutMs: z.number().positive().optional(),
});

// ---------------------------------------------------------------------------
// Step discriminated union.
//
// The parallel step contains nested steps in its branches. z.lazy() breaks the
// circular reference: StepSchema references itself through ParallelStep.branches.
// The explicit ZodType annotation is required by TypeScript because z.lazy()
// produces an unknown type without it.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const StepSchema: z.ZodType<any> = z.discriminatedUnion("type", [
  // code — inline source executed in the Execution Service sandbox.
  StepBaseSchema.extend({
    type: z.literal("code"),
    language: z.enum(["javascript", "typescript", "python", "go"]),
    code: z.string().min(1).max(512_000),
    entrypoint: z.string().optional(),
  }),

  // wait — pauses execution for a fixed duration (max 24 hours).
  StepBaseSchema.extend({
    type: z.literal("wait"),
    durationMs: z.number().positive().max(86_400_000),
  }),

  // approval — pauses execution until a listed approver accepts or rejects.
  // timeoutMs defaults to 24 hours; when the deadline passes the step is
  // marked failed so the pipeline does not block indefinitely.
  StepBaseSchema.extend({
    type: z.literal("approval"),
    approvers: z.array(z.string().min(1)).min(1),
    message: z.string().max(2000).optional(),
    timeoutMs: z.number().positive().max(86_400_000).default(86_400_000),
  }),

  // connector — triggers an Ingestion Service connector sync.
  StepBaseSchema.extend({
    type: z.literal("connector"),
    connectorInstanceId: UUIDSchema,
    syncMode: z.enum(["full", "incremental"]).optional(),
    waitForCompletion: z.boolean().default(true),
  }),

  // transformer — applies a registered transformer plugin.
  StepBaseSchema.extend({
    type: z.literal("transformer"),
    transformerId: z.string(),
    config: z.record(z.unknown()).optional(),
    entityType: z.string().optional(),
  }),

  // conditional — structured field/operator/value branch evaluated synchronously
  // inside the Pipeline Service (no sandbox, no JSONata).  elseStepId is
  // optional; when omitted and the condition is false the pipeline continues
  // to the next sequential step.
  StepBaseSchema.extend({
    type: z.literal("conditional"),
    condition: z.object({
      field: z.string().min(1),
      operator: z.enum([
        "eq",
        "neq",
        "gt",
        "gte",
        "lt",
        "lte",
        "contains",
        "not_contains",
        "exists",
        "not_exists",
        "matches",
      ]),
      value: z.unknown().optional(),
    }),
    thenStepId: z.string().min(1),
    elseStepId: z.string().min(1).optional(),
  }),

  // parallel — concurrent branches; z.lazy() allows branches to contain steps.
  StepBaseSchema.extend({
    type: z.literal("parallel"),
    branches: z
      .array(
        z.object({
          id: z.string(),
          entryStepId: z.string(),
          // Recursive: branches may contain any valid step type.
          steps: z.array(z.lazy(() => StepSchema)),
        })
      )
      .min(2)
      .max(10),
    waitMode: z.enum(["all", "any"]),
  }),

  // transform — pre-built declarative data transformations (G-051).
  TransformStepSchema,

  // webhook — outbound HTTP call; URL validated for SSRF before save and at execution.
  StepBaseSchema.extend({
    type: z.literal("webhook"),
    url: z.string().url().startsWith("https://"),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    headers: z.record(z.string()).optional(),
    body: z.unknown().optional(),
    responseMapping: z.string().optional(),
    // webhook step has its own tighter timeout cap (max 2 minutes).
    timeout: z.number().int().min(1000).max(120_000).optional(),
  }),

  // sub_workflow — invoke another pipeline as a child execution.
  // The SubWorkflowStepSchema constant above captures the same shape but
  // is defined before the union so it can be exported independently.
  SubWorkflowStepSchema,
]);

// ---------------------------------------------------------------------------
// Pipeline definition — the root JSONB structure stored in pipelines.definition.
// ---------------------------------------------------------------------------

export const PipelineDefinitionSchema = z.object({
  version: z.literal(1),
  entryStepId: z.string(),
  // OP_PIPELINE_MAX_STEPS default is 100.
  steps: z.array(StepSchema).min(1).max(100),
  options: z
    .object({
      maxConcurrentRuns: z.number().int().min(1).max(50).optional(),
      allowConcurrentRuns: z.boolean().optional(),
      stepTimeout: z.number().int().min(1000).max(3_600_000).optional(),
      retainRunsCount: z.number().int().min(1).max(1000).optional(),
    })
    .optional(),
});

// ---------------------------------------------------------------------------
// Public API request schemas
// ---------------------------------------------------------------------------

export const CreatePipelineSchema = z.object({
  name: z.string().min(1).max(255).trim(),
  // slug is optional — derived from name if omitted.
  slug: z
    .string()
    .min(3)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9\-]{1,62}[a-z0-9]$/)
    .optional(),
  description: z.string().max(1000).optional(),
  definition: PipelineDefinitionSchema,
  isActive: z.boolean().default(true),
});

export const PatchPipelineSchema = z.object({
  name: z.string().min(1).max(255).trim().optional(),
  description: z.string().max(1000).optional(),
  definition: PipelineDefinitionSchema.optional(),
  isActive: z.boolean().optional(),
});

export const TriggerPipelineSchema = z.object({
  input: z.record(z.unknown()).default({}),
});

export const CreateScheduleSchema = z.object({
  pipelineId: UUIDSchema,
  cronExpr: cronExpressionSchema,
  timezone: z.string().min(1).max(64).default("UTC"),
  enabled: z.boolean().default(true),
  inputTemplate: z.record(z.unknown()).default({}),
  /** Pipeline IDs whose latest run must be 'completed' before this schedule fires. */
  dependsOn: z.array(UUIDSchema).default([]),
});

export const PatchScheduleSchema = z.object({
  cronExpr: cronExpressionSchema.optional(),
  timezone: z.string().min(1).max(64).optional(),
  enabled: z.boolean().optional(),
  inputTemplate: z.record(z.unknown()).optional(),
  /** Replace the dependency list. Pass [] to clear all dependencies. */
  dependsOn: z.array(UUIDSchema).optional(),
});

// ---------------------------------------------------------------------------
// Query parameter schemas — list endpoints
// ---------------------------------------------------------------------------

export const ListPipelinesQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  "filter[isActive][eq]": z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  sort: z.string().optional(),
});

export const ListRunsQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  "filter[status][eq]": z
    .enum(["pending", "running", "completed", "failed", "cancelled"])
    .optional(),
  sort: z.string().optional(),
});

export const ListSchedulesQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  sort: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Versioning schemas
// ---------------------------------------------------------------------------

export const ListVersionsQuery = z.object({
  // Cursor is the version_number of the last item returned (descending order).
  cursor: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const RollbackPipelineSchema = z.object({
  version: z.number().int().positive(),
});

// ---------------------------------------------------------------------------
// Internal trigger request — used by Ingestion Service / App Service.
// ---------------------------------------------------------------------------

export const InternalTriggerRequestSchema = z.object({
  pipelineId: UUIDSchema,
  tenantId: UUIDSchema,
  triggeredBy: z.literal("service"),
  callerService: z.string().min(1),
  callerRequestId: z.string().optional(),
  input: z.record(z.unknown()).optional(),
});

// Inferred TypeScript types for use in service and handler code.
export type InternalTriggerRequest = z.infer<typeof InternalTriggerRequestSchema>;
export type CreatePipelineInput = z.infer<typeof CreatePipelineSchema>;
export type PatchPipelineInput = z.infer<typeof PatchPipelineSchema>;
export type TriggerPipelineInput = z.infer<typeof TriggerPipelineSchema>;
export type CreateScheduleInput = z.infer<typeof CreateScheduleSchema>;
export type PatchScheduleInput = z.infer<typeof PatchScheduleSchema>;
export type PipelineDefinition = z.infer<typeof PipelineDefinitionSchema>;
export type ListPipelinesQueryInput = z.infer<typeof ListPipelinesQuery>;
export type ListRunsQueryInput = z.infer<typeof ListRunsQuery>;
export type ListSchedulesQueryInput = z.infer<typeof ListSchedulesQuery>;
export type RetryConfig = z.infer<typeof RetryConfigSchema>;
export type ListVersionsQueryInput = z.infer<typeof ListVersionsQuery>;
export type RollbackPipelineInput = z.infer<typeof RollbackPipelineSchema>;
export type TransformOperation = z.infer<typeof TransformOperationSchema>;
export type TransformStepInput = z.infer<typeof TransformStepSchema>;
