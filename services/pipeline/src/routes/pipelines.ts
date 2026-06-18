import { Hono } from "hono";
import { z } from "zod";
import type { AppVariables } from "@oneplatform/core";
import { UnauthorizedError } from "@oneplatform/core";
import type { PipelineService } from "../services/pipeline-service.js";
import type { RunService } from "../services/run-service.js";
import {
  CreatePipelineSchema,
  PatchPipelineSchema,
  TriggerPipelineSchema,
  ListPipelinesQuery,
  ListRunsQuery,
  ListVersionsQuery,
  RollbackPipelineSchema,
} from "../schemas/index.js";
import { listTemplates, buildFromTemplate } from "../templates/index.js";

// ---------------------------------------------------------------------------
// Route dependencies
// ---------------------------------------------------------------------------

export interface PipelineRouteDeps {
  pipelineService: PipelineService;
  runService: RunService;
}

// ---------------------------------------------------------------------------
// Inline schema for POST /from-template
//
// The `params` field is deliberately untyped (record) here because each
// template has its own param shape; buildFromTemplate() applies per-template
// Zod validation before calling the factory function.
// ---------------------------------------------------------------------------

const FromTemplateBodySchema = z.object({
  templateId: z.string().min(1).max(64),
  name: z.string().min(1).max(255).trim(),
  slug: z
    .string()
    .min(3)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9\-]{1,62}[a-z0-9]$/)
    .optional(),
  description: z.string().max(1000).optional(),
  isActive: z.boolean().default(true),
  params: z.record(z.unknown()),
});

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
      throw new UnauthorizedError("Authentication required.");
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
      throw new UnauthorizedError("Authentication required.");
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

  // ---------------------------------------------------------------------------
  // Template routes — registered before /:id so Hono does not treat the
  // literal segment "templates" as a pipeline ID parameter.
  // ---------------------------------------------------------------------------

  // GET /api/v1/pipelines/templates
  routes.get("/templates", (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    return c.json({ data: listTemplates() });
  });

  // POST /api/v1/pipelines/from-template
  routes.post("/from-template", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    const body = await c.req.json().catch(() => null);
    const parsed = FromTemplateBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "Invalid request body.", details: parsed.error.flatten() } },
        400,
      );
    }

    const { templateId, name, slug, description, isActive, params } = parsed.data;

    const outcome = buildFromTemplate(templateId, params);
    if (!outcome.ok) {
      if (outcome.error.code === "TEMPLATE_NOT_FOUND") {
        return c.json(
          { error: { code: "NOT_FOUND", message: outcome.error.message } },
          404,
        );
      }
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: outcome.error.message,
            details: outcome.error.details?.flatten(),
          },
        },
        400,
      );
    }

    const pipeline = await pipelineService.createPipeline(user.tenantId, user.userId, {
      name,
      ...(slug !== undefined ? { slug } : {}),
      ...(description !== undefined ? { description } : {}),
      definition: outcome.value.definition as Record<string, unknown>,
      isActive,
    });

    return c.json({ data: pipeline }, 201);
  });

  // ---------------------------------------------------------------------------
  // Single-pipeline routes — parameterised; must come after static routes above.
  // ---------------------------------------------------------------------------

  // GET /api/v1/pipelines/:id
  routes.get("/:id", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    const pipeline = await pipelineService.getPipeline(user.tenantId, c.req.param("id"));
    return c.json({ data: pipeline });
  });

  // PATCH /api/v1/pipelines/:id
  routes.patch("/:id", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
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
      user.userId,
    );

    return c.json({ data: pipeline });
  });

  // DELETE /api/v1/pipelines/:id
  routes.delete("/:id", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    await pipelineService.deletePipeline(user.tenantId, c.req.param("id"));
    return c.body(null, 204);
  });

  // POST /api/v1/pipelines/:id/trigger
  routes.post("/:id/trigger", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
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
      throw new UnauthorizedError("Authentication required.");
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

  // GET /api/v1/pipelines/:id/versions
  routes.get("/:id/versions", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    const parsed = ListVersionsQuery.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "Invalid query parameters.", details: parsed.error.flatten() } },
        400,
      );
    }

    const q = parsed.data;
    const result = await pipelineService.listVersions(
      user.tenantId,
      c.req.param("id"),
      {
        ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
        limit: q.limit,
      },
    );

    return c.json(result);
  });

  // GET /api/v1/pipelines/:id/versions/:version
  routes.get("/:id/versions/:version", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    const versionParam = parseInt(c.req.param("version"), 10);
    if (!Number.isInteger(versionParam) || versionParam < 1) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "version must be a positive integer." } },
        400,
      );
    }

    const version = await pipelineService.getVersion(
      user.tenantId,
      c.req.param("id"),
      versionParam,
    );

    return c.json({ data: version });
  });

  // POST /api/v1/pipelines/:id/executions/:executionId/replay
  //
  // One-click replay: retrieves the original run's input from the database and
  // starts a new run with the same inputs. The response includes the new run ID
  // and a replayOf field linking it back to the original execution.
  routes.post("/:id/executions/:executionId/replay", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    const pipelineId = c.req.param("id");
    const executionId = c.req.param("executionId");

    // Verify the pipeline exists and belongs to this tenant before attempting replay.
    // getPipeline throws PipelineNotFoundError (→ 404) if not found.
    await pipelineService.getPipeline(user.tenantId, pipelineId);

    const result = await runService.replayRun(
      pipelineId,
      user.tenantId,
      executionId,
      user.userId,
    );

    return c.json({ data: result }, 202);
  });

  // POST /api/v1/pipelines/:id/rollback
  routes.post("/:id/rollback", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    const body = await c.req.json().catch(() => null);
    const parsed = RollbackPipelineSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "Invalid request body.", details: parsed.error.flatten() } },
        400,
      );
    }

    const pipeline = await pipelineService.rollbackToVersion(
      user.tenantId,
      c.req.param("id"),
      parsed.data.version,
      user.userId,
    );

    return c.json({ data: pipeline });
  });

  return routes;
}
