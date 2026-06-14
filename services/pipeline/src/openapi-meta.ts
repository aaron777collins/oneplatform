/**
 * Pipeline service OpenAPI 3.0.3 route metadata.
 *
 * The Pipeline service orchestrates multi-step workflows. It manages:
 *   - Pipeline definitions (steps, branching, scheduling options)
 *   - Pipeline runs (trigger, cancel, SSE log streaming)
 *   - Cron schedules for automatic pipeline triggering
 *
 * Routes excluded:
 *   All routes in internal.ts (/internal/*) are service-to-service routes
 *   protected by X-Service-Token and are not part of the public API.
 *   /health.ts routes (/healthz, /readyz) are infrastructure probes.
 *
 * z.lazy() note on StepSchema:
 *   The StepSchema uses z.lazy() for recursive parallel branch steps. The
 *   OpenAPI generator does not support recursive Zod schemas. We use bounded-
 *   depth inline schemas here for the request body. The runtime schema
 *   (StepSchema) is still used for actual request validation.
 */

import type { ServiceOpenApiMeta } from "@oneplatform/openapi-gen";
import { z } from "zod";
import {
  CreatePipelineSchema,
  PatchPipelineSchema,
  TriggerPipelineSchema,
  CreateScheduleSchema,
  PatchScheduleSchema,
  ListPipelinesQuery,
  ListRunsQuery,
  ListSchedulesQuery,
} from "./schemas/index.js";

// ---------------------------------------------------------------------------
// Bounded-depth step schema for documentation.
//
// StepSchema uses z.lazy() for parallel branch recursion which the OpenAPI
// generator cannot unroll. We define a two-level-deep variant here that is
// accurate for the vast majority of real pipelines. The "at most 1 nested
// parallel level" limitation is a documentation artifact only — the runtime
// validates the full recursive definition.
// ---------------------------------------------------------------------------

const StepLeafSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("code"),
    id: z.string(),
    name: z.string(),
    language: z.enum(["javascript", "typescript", "python", "go"]),
    code: z.string().max(512_000),
    entrypoint: z.string().optional(),
    onError: z.enum(["fail", "skip"]).optional(),
    timeout: z.number().int().optional(),
  }),
  z.object({
    type: z.literal("connector"),
    id: z.string(),
    name: z.string(),
    connectorInstanceId: z.string().uuid(),
    syncMode: z.enum(["full", "incremental"]).optional(),
    waitForCompletion: z.boolean().optional(),
    onError: z.enum(["fail", "skip"]).optional(),
  }),
  z.object({
    type: z.literal("transformer"),
    id: z.string(),
    name: z.string(),
    transformerId: z.string(),
    config: z.record(z.unknown()).optional(),
    entityType: z.string().optional(),
    onError: z.enum(["fail", "skip"]).optional(),
  }),
  z.object({
    type: z.literal("conditional"),
    id: z.string(),
    name: z.string(),
    expression: z.string().max(5000),
    trueBranchStepId: z.string(),
    falseBranchStepId: z.string(),
    onError: z.enum(["fail", "skip"]).optional(),
  }),
  z.object({
    type: z.literal("webhook"),
    id: z.string(),
    name: z.string(),
    url: z.string().url().startsWith("https://"),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    headers: z.record(z.string()).optional(),
    body: z.unknown().optional(),
    responseMapping: z.string().optional(),
    onError: z.enum(["fail", "skip"]).optional(),
    timeout: z.number().int().optional(),
  }),
]);

// Parallel step with one level of nesting (branches contain leaf steps only)
const StepDocSchema = z.discriminatedUnion("type", [
  ...StepLeafSchema.options,
  z.object({
    type: z.literal("parallel"),
    id: z.string(),
    name: z.string(),
    branches: z.array(
      z.object({
        id: z.string(),
        entryStepId: z.string(),
        steps: z.array(StepLeafSchema),
      })
    ).min(2).max(10),
    waitMode: z.enum(["all", "any"]),
    onError: z.enum(["fail", "skip"]).optional(),
  }),
]);

// Pipeline definition schema for documentation — mirrors PipelineDefinitionSchema
// but uses StepDocSchema instead of the recursive StepSchema
const PipelineDefinitionDocSchema = z.object({
  version: z.literal(1),
  entryStepId: z.string(),
  steps: z.array(StepDocSchema).min(1).max(100),
  options: z
    .object({
      maxConcurrentRuns: z.number().int().min(1).max(50).optional(),
      allowConcurrentRuns: z.boolean().optional(),
      stepTimeout: z.number().int().min(1000).max(3_600_000).optional(),
      retainRunsCount: z.number().int().min(1).max(1000).optional(),
    })
    .optional(),
}).describe("PipelineDefinition");

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

const noContentResponse = z.object({}).describe("NoContentResponse");

const pipelineResponse = z
  .object({
    data: z.object({
      id: z.string().uuid(),
      tenantId: z.string().uuid(),
      name: z.string(),
      slug: z.string(),
      description: z.string().nullable(),
      definition: z.record(z.unknown()),
      isActive: z.boolean(),
      createdBy: z.string().uuid(),
      createdAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
    }),
  })
  .describe("PipelineResponse");

const pipelineListResponse = z
  .object({
    data: z.array(
      z.object({
        id: z.string().uuid(),
        name: z.string(),
        slug: z.string(),
        description: z.string().nullable(),
        isActive: z.boolean(),
        createdAt: z.string().datetime(),
        updatedAt: z.string().datetime(),
      })
    ),
    pagination: z.object({ nextCursor: z.string().nullable() }),
  })
  .describe("PipelineListResponse");

const triggerRunResponse = z
  .object({
    data: z.object({
      runId: z.string().uuid(),
      pipelineId: z.string().uuid(),
      status: z.enum(["pending", "running"]),
      triggeredAt: z.string().datetime(),
    }),
  })
  .describe("TriggerRunResponse");

const runResponse = z
  .object({
    data: z.object({
      id: z.string().uuid(),
      pipelineId: z.string().uuid(),
      tenantId: z.string().uuid(),
      status: z.enum(["pending", "running", "completed", "failed", "cancelled"]),
      triggeredBy: z.enum(["manual", "schedule", "service"]),
      input: z.record(z.unknown()),
      startedAt: z.string().datetime().nullable(),
      completedAt: z.string().datetime().nullable(),
      durationMs: z.number().int().nullable(),
      createdAt: z.string().datetime(),
    }),
  })
  .describe("RunResponse");

const runListResponse = z
  .object({
    data: z.array(
      z.object({
        id: z.string().uuid(),
        pipelineId: z.string().uuid(),
        status: z.enum(["pending", "running", "completed", "failed", "cancelled"]),
        triggeredBy: z.enum(["manual", "schedule", "service"]),
        startedAt: z.string().datetime().nullable(),
        completedAt: z.string().datetime().nullable(),
        durationMs: z.number().int().nullable(),
        createdAt: z.string().datetime(),
      })
    ),
    pagination: z.object({ nextCursor: z.string().nullable() }),
  })
  .describe("RunListResponse");

const cancelRunResponse = z
  .object({
    data: z.object({
      runId: z.string().uuid(),
      status: z.literal("cancellation_requested"),
    }),
  })
  .describe("CancelRunResponse");

// SSE stream for run logs — not JSON
const runLogStreamResponse = z
  .object({
    message: z.string().describe("Server-Sent Events text/event-stream — not a JSON body"),
  })
  .describe("RunLogStreamResponse");

const scheduleResponse = z
  .object({
    data: z.object({
      id: z.string().uuid(),
      pipelineId: z.string().uuid(),
      tenantId: z.string().uuid(),
      cronExpr: z.string(),
      timezone: z.string(),
      enabled: z.boolean(),
      inputTemplate: z.record(z.unknown()),
      nextRunAt: z.string().datetime().nullable(),
      createdAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
    }),
  })
  .describe("ScheduleResponse");

const scheduleListResponse = z
  .object({
    data: z.array(
      z.object({
        id: z.string().uuid(),
        pipelineId: z.string().uuid(),
        cronExpr: z.string(),
        timezone: z.string(),
        enabled: z.boolean(),
        nextRunAt: z.string().datetime().nullable(),
        createdAt: z.string().datetime(),
      })
    ),
    pagination: z.object({ nextCursor: z.string().nullable() }),
  })
  .describe("ScheduleListResponse");

// ---------------------------------------------------------------------------
// Meta export
// ---------------------------------------------------------------------------

export const meta: ServiceOpenApiMeta = {
  info: {
    title: "Pipeline Service",
    description:
      "Orchestrates multi-step workflows on OnePlatform. Provides pipeline definition " +
      "management, on-demand and scheduled execution, real-time run log streaming via SSE, " +
      "and step-level error handling (fail/skip).",
    version: "1.0.0",
  },
  servers: [{ url: "http://localhost:3000", description: "Local (via Gateway)" }],
  tags: [
    {
      name: "Pipelines",
      description:
        "Pipeline definitions. A pipeline is a versioned DAG of steps (code, connector, " +
        "transformer, conditional, parallel, webhook) with optional concurrency options.",
    },
    {
      name: "Pipeline Runs",
      description:
        "Pipeline run management. Runs can be triggered manually, by schedule, or by " +
        "internal service events. Logs are streamed in real time via SSE.",
    },
    {
      name: "Schedules",
      description:
        "Cron-based schedules that automatically trigger pipeline runs. Supports IANA " +
        "timezone names and optional input templates.",
    },
  ],
  routes: [
    // -----------------------------------------------------------------------
    // Pipelines
    // -----------------------------------------------------------------------
    {
      method: "GET",
      path: "/api/v1/pipelines",
      summary: "List pipelines",
      description: "Lists pipeline definitions for the authenticated tenant.",
      tags: ["Pipelines"],
      query: { schema: ListPipelinesQuery },
      response: {
        200: pipelineListResponse,
      },
    },
    {
      method: "POST",
      path: "/api/v1/pipelines",
      summary: "Create pipeline",
      description:
        "Creates a new pipeline definition. The definition.steps array supports " +
        "code, connector, transformer, conditional, parallel, and webhook step types. " +
        "Parallel steps may contain nested steps (up to the platform recursion limit).",
      tags: ["Pipelines"],
      body: {
        schema: CreatePipelineSchema.describe("CreatePipelineRequest"),
        contentType: "application/json",
      },
      response: {
        201: pipelineResponse,
      },
    },
    {
      method: "GET",
      path: "/api/v1/pipelines/{id}",
      summary: "Get pipeline",
      tags: ["Pipelines"],
      params: { id: z.string().uuid().describe("PipelineId") },
      response: {
        200: pipelineResponse,
      },
    },
    {
      method: "PATCH",
      path: "/api/v1/pipelines/{id}",
      summary: "Update pipeline",
      description: "Partially updates a pipeline definition.",
      tags: ["Pipelines"],
      params: { id: z.string().uuid().describe("PatchPipelineId") },
      body: {
        schema: PatchPipelineSchema.describe("PatchPipelineRequest"),
        contentType: "application/json",
      },
      response: {
        200: pipelineResponse,
      },
    },
    {
      method: "DELETE",
      path: "/api/v1/pipelines/{id}",
      summary: "Delete pipeline",
      description:
        "Deletes a pipeline definition. Running runs are not affected by deletion.",
      tags: ["Pipelines"],
      params: { id: z.string().uuid().describe("DeletePipelineId") },
      response: {
        204: noContentResponse,
      },
    },
    {
      method: "POST",
      path: "/api/v1/pipelines/{id}/trigger",
      summary: "Trigger pipeline run",
      description:
        "Triggers an immediate run of the pipeline with optional input data.",
      tags: ["Pipelines"],
      params: { id: z.string().uuid().describe("TriggerPipelineId") },
      body: {
        schema: TriggerPipelineSchema.describe("TriggerPipelineRequest"),
        contentType: "application/json",
      },
      response: {
        202: triggerRunResponse,
      },
    },
    {
      method: "GET",
      path: "/api/v1/pipelines/{id}/runs",
      summary: "List pipeline runs",
      description: "Lists runs for a specific pipeline, newest first.",
      tags: ["Pipelines"],
      params: { id: z.string().uuid().describe("PipelineRunsId") },
      query: { schema: ListRunsQuery },
      response: {
        200: runListResponse,
      },
    },

    // -----------------------------------------------------------------------
    // Pipeline Runs
    // -----------------------------------------------------------------------
    {
      method: "GET",
      path: "/api/v1/pipeline-runs/{runId}",
      summary: "Get pipeline run",
      tags: ["Pipeline Runs"],
      params: { runId: z.string().uuid().describe("RunId") },
      response: {
        200: runResponse,
      },
    },
    {
      method: "POST",
      path: "/api/v1/pipeline-runs/{runId}/cancel",
      summary: "Cancel pipeline run",
      description:
        "Requests cancellation of a running pipeline. Cancellation is best-effort — " +
        "steps already in flight may complete before the run is fully cancelled.",
      tags: ["Pipeline Runs"],
      params: { runId: z.string().uuid().describe("CancelRunId") },
      response: {
        200: cancelRunResponse,
      },
    },
    {
      method: "GET",
      path: "/api/v1/pipeline-runs/{runId}/logs",
      summary: "Stream run logs (SSE)",
      description:
        "Opens a Server-Sent Events stream for real-time log output from a pipeline run. " +
        "Supports Last-Event-ID for reconnection. Emits 'log', and 'done' event types. " +
        "Returns text/event-stream, not JSON.",
      tags: ["Pipeline Runs"],
      params: { runId: z.string().uuid().describe("LogStreamRunId") },
      response: {
        200: runLogStreamResponse,
      },
    },

    // -----------------------------------------------------------------------
    // Schedules
    // -----------------------------------------------------------------------
    {
      method: "GET",
      path: "/api/v1/schedules",
      summary: "List schedules",
      tags: ["Schedules"],
      query: { schema: ListSchedulesQuery },
      response: {
        200: scheduleListResponse,
      },
    },
    {
      method: "POST",
      path: "/api/v1/schedules",
      summary: "Create schedule",
      description:
        "Creates a cron schedule for a pipeline. The cronExpr must be a 5-field " +
        "standard cron expression. The timezone must be a valid IANA timezone name.",
      tags: ["Schedules"],
      body: {
        schema: CreateScheduleSchema.describe("CreateScheduleRequest"),
        contentType: "application/json",
      },
      response: {
        201: scheduleResponse,
      },
    },
    {
      method: "GET",
      path: "/api/v1/schedules/{id}",
      summary: "Get schedule",
      tags: ["Schedules"],
      params: { id: z.string().uuid().describe("ScheduleId") },
      response: {
        200: scheduleResponse,
      },
    },
    {
      method: "PATCH",
      path: "/api/v1/schedules/{id}",
      summary: "Update schedule",
      tags: ["Schedules"],
      params: { id: z.string().uuid().describe("PatchScheduleId") },
      body: {
        schema: PatchScheduleSchema.describe("PatchScheduleRequest"),
        contentType: "application/json",
      },
      response: {
        200: scheduleResponse,
      },
    },
    {
      method: "DELETE",
      path: "/api/v1/schedules/{id}",
      summary: "Delete schedule",
      tags: ["Schedules"],
      params: { id: z.string().uuid().describe("DeleteScheduleId") },
      response: {
        204: noContentResponse,
      },
    },
  ],
};
