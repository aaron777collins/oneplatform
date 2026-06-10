import { Hono } from "hono";
import { z } from "zod";
import type { AppVariables } from "@oneplatform/core";
import type { PipelineService } from "../services/pipeline-service.js";
import type { RunService } from "../services/run-service.js";

// ---------------------------------------------------------------------------
// Zod schemas (design spec §5.1)
// ---------------------------------------------------------------------------

const UUIDSchema = z.string().uuid();

const StepBaseSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/),
  name: z.string().min(1).max(255),
  type: z.enum(["code", "connector", "transformer", "conditional", "parallel", "webhook"]),
  inputs: z
    .record(
      z.discriminatedUnion("from", [
        z.object({ from: z.literal("pipeline.input"), path: z.string().optional() }),
        z.object({ from: z.literal("step"), stepId: z.string(), path: z.string().optional() }),
        z.object({ from: z.literal("literal"), value: z.unknown() }),
      ]),
    )
    .optional(),
  onError: z.enum(["fail", "skip"]).default("fail"),
  condition: z.string().max(5000).optional(),
  timeout: z.number().int().min(1000).max(3_600_000).optional(),
});

// Lazy reference used for parallel step's nested branches
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const StepSchema: z.ZodType<any> = z.lazy(() =>
  z.discriminatedUnion("type", [
    StepBaseSchema.extend({
      type: z.literal("code"),
      language: z.enum(["javascript", "typescript", "python", "go"]),
      code: z.string().min(1).max(512_000),
      entrypoint: z.string().optional(),
    }),
    StepBaseSchema.extend({
      type: z.literal("connector"),
      connectorInstanceId: UUIDSchema,
      syncMode: z.enum(["full", "incremental"]).optional(),
      waitForCompletion: z.boolean().default(true),
    }),
    StepBaseSchema.extend({
      type: z.literal("transformer"),
      transformerId: z.string(),
      config: z.record(z.unknown()).optional(),
      entityType: z.string().optional(),
    }),
    StepBaseSchema.extend({
      type: z.literal("conditional"),
      expression: z.string().max(5000),
      trueBranchStepId: z.string(),
      falseBranchStepId: z.string(),
    }),
    StepBaseSchema.extend({
      type: z.literal("parallel"),
      branches: z
        .array(
          z.object({
            id: z.string(),
            entryStepId: z.string(),
            steps: z.array(z.lazy(() => StepSchema)),
          }),
        )
        .min(2)
        .max(10),
      waitMode: z.enum(["all", "any"]),
    }),
    StepBaseSchema.extend({
      type: z.literal("webhook"),
      url: z.string().url().startsWith("https://"),
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
      headers: z.record(z.string()).optional(),
      body: z.unknown().optional(),
      responseMapping: z.string().optional(),
      timeout: z.number().int().min(1000).max(120_000).optional(),
    }),
  ]),
);

const PipelineDefinitionSchema = z.object({
  version: z.literal(1),
  entryStepId: z.string(),
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

const CreatePipelineSchema = z.object({
  name: z.string().min(1).max(255).trim(),
  slug: z
    .string()
    .min(3)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/)
    .optional(),
  description: z.string().max(1000).optional(),
  definition: PipelineDefinitionSchema,
  isActive: z.boolean().default(true),
});

const PatchPipelineSchema = z.object({
  name: z.string().min(1).max(255).trim().optional(),
  description: z.string().max(1000).optional(),
  definition: PipelineDefinitionSchema.optional(),
  isActive: z.boolean().optional(),
});

const TriggerPipelineSchema = z.object({
  input: z.record(z.unknown()).default({}),
});

const ListPipelinesQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  "filter[isActive][eq]": z
    .string()
    .transform((v) => v === "true")
    .optional(),
  sort: z.string().default("-createdAt"),
});

const ListRunsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// ---------------------------------------------------------------------------
// Route dependencies
// ---------------------------------------------------------------------------

export interface PipelineRouteDeps {
  pipelineService: PipelineService;
  runService: RunService;
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function createPipelineRoutes(
  deps: PipelineRouteDeps,
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { pipelineService, runService } = deps;

  // GET /api/v1/pipelines
  routes.get("/", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "Authentication required." } }, 401);
    }

    const parsed = ListPipelinesQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "Invalid query parameters.", details: parsed.error.flatten() } },
        400,
      );
    }

    const q = parsed.data;
    const result = await pipelineService.listPipelines(user.tenantId, {
      ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
      limit: q.limit,
      ...(q["filter[isActive][eq]"] !== undefined
        ? { filterIsActive: q["filter[isActive][eq]"] }
        : {}),
      sort: q.sort,
    });

    return c.json(result);
  });

  // POST /api/v1/pipelines
  routes.post("/", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "Authentication required." } }, 401);
    }

    const body = await c.req.json().catch(() => null);
    const parsed = CreatePipelineSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "Invalid request body.", details: parsed.error.flatten() } },
        400,
      );
    }

    const d = parsed.data;
    const pipeline = await pipelineService.createPipeline(user.tenantId, user.userId, {
      name: d.name,
      ...(d.slug !== undefined ? { slug: d.slug } : {}),
      ...(d.description !== undefined ? { description: d.description } : {}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      definition: d.definition as any,
      isActive: d.isActive,
    });

    return c.json({ data: pipeline }, 201);
  });

  // GET /api/v1/pipelines/:id
  routes.get("/:id", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "Authentication required." } }, 401);
    }

    const pipeline = await pipelineService.getPipeline(user.tenantId, c.req.param("id"));
    return c.json({ data: pipeline });
  });

  // PATCH /api/v1/pipelines/:id
  routes.patch("/:id", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "Authentication required." } }, 401);
    }

    const body = await c.req.json().catch(() => null);
    const parsed = PatchPipelineSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "Invalid request body.", details: parsed.error.flatten() } },
        400,
      );
    }

    const d = parsed.data;
    const updates: Parameters<PipelineService["updatePipeline"]>[2] = {};
    if (d.name !== undefined) updates.name = d.name;
    if (d.description !== undefined) updates.description = d.description;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (d.definition !== undefined) updates.definition = d.definition as any;
    if (d.isActive !== undefined) updates.isActive = d.isActive;

    const pipeline = await pipelineService.updatePipeline(
      user.tenantId,
      c.req.param("id"),
      updates,
    );

    return c.json({ data: pipeline });
  });

  // DELETE /api/v1/pipelines/:id
  routes.delete("/:id", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "Authentication required." } }, 401);
    }

    await pipelineService.deletePipeline(user.tenantId, c.req.param("id"));
    return c.body(null, 204);
  });

  // POST /api/v1/pipelines/:id/trigger
  routes.post("/:id/trigger", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "Authentication required." } }, 401);
    }

    const body = await c.req.json().catch(() => ({}));
    const parsed = TriggerPipelineSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "Invalid request body.", details: parsed.error.flatten() } },
        400,
      );
    }

    const pipelineId = c.req.param("id");

    // Verify the pipeline exists and is active before triggering
    await pipelineService.getPipeline(user.tenantId, pipelineId);

    const result = await runService.triggerRun(
      pipelineId,
      user.tenantId,
      "manual",
      parsed.data.input,
      { userId: user.userId },
      user.userId,
    );

    return c.json({ data: result }, 202);
  });

  // GET /api/v1/pipelines/:id/runs
  routes.get("/:id/runs", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "Authentication required." } }, 401);
    }

    // Verify pipeline ownership
    await pipelineService.getPipeline(user.tenantId, c.req.param("id"));

    const parsed = ListRunsQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "Invalid query parameters.", details: parsed.error.flatten() } },
        400,
      );
    }

    const q = parsed.data;
    const result = await runService.listRuns(user.tenantId, {
      ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
      limit: q.limit,
      pipelineId: c.req.param("id"),
    });

    return c.json(result);
  });

  return routes;
}
