import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import type { PipelineService } from "../services/pipeline-service.js";
import type { RunService } from "../services/run-service.js";
import {
  CreatePipelineSchema,
  PatchPipelineSchema,
  TriggerPipelineSchema,
  ListPipelinesQuery,
  ListRunsQuery,
} from "../schemas/index.js";

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

    const parsed = ListPipelinesQuery.safeParse(c.req.query());
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
      // Zod validates the definition shape; the service accepts Record<string,unknown>
      // at the boundary to avoid exactOptionalPropertyTypes mismatches.
      definition: d.definition as Record<string, unknown>,
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
    // Zod validates the definition shape; the service accepts Record<string,unknown>.
    if (d.definition !== undefined) updates.definition = d.definition as Record<string, unknown>;
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

    const parsed = ListRunsQuery.safeParse(c.req.query());
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
