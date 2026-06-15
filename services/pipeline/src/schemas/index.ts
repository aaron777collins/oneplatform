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

const StepBaseSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9\-]*[a-z0-9]$/),
  name: z.string().min(1).max(255),
  type: z.enum([
    "code",
    "connector",
    "transformer",
    "conditional",
    "parallel",
    "webhook",
  ]),
  inputs: z.record(InputSourceSchema).optional(),
  onError: z.enum(["fail", "skip"]).default("fail"),
  condition: z.string().max(5000).optional(),
  // timeout override per step (ms). Max 1 hour.
  timeout: z.number().int().min(1000).max(3_600_000).optional(),
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

  // conditional — JSONata branch; evaluated inside the Pipeline Service (no sandbox).
  StepBaseSchema.extend({
    type: z.literal("conditional"),
    expression: z.string().max(5000),
    trueBranchStepId: z.string(),
    falseBranchStepId: z.string(),
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
});

export const PatchScheduleSchema = z.object({
  cronExpr: cronExpressionSchema.optional(),
  timezone: z.string().min(1).max(64).optional(),
  enabled: z.boolean().optional(),
  inputTemplate: z.record(z.unknown()).optional(),
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
