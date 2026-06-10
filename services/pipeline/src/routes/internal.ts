import { Hono } from "hono";
import { z } from "zod";
import type { AppVariables } from "@oneplatform/core";
import type { RunService } from "../services/run-service.js";

// ---------------------------------------------------------------------------
// Internal trigger request schema (design spec §6.1)
// ---------------------------------------------------------------------------

const InternalTriggerSchema = z.object({
  pipelineId: z.string().uuid(),
  tenantId: z.string().uuid(),
  triggeredBy: z.literal("service"),
  callerService: z.string().min(1).max(128),
  callerRequestId: z.string().optional(),
  input: z.record(z.unknown()).optional(),
});

// ---------------------------------------------------------------------------
// Route dependencies
// ---------------------------------------------------------------------------

export interface InternalRouteDeps {
  runService: RunService;
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function createInternalRoutes(deps: InternalRouteDeps): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { runService } = deps;

  // POST /internal/pipeline/trigger
  // Used by: Ingestion Service, App Service (design spec §6.1)
  routes.post("/pipeline/trigger", async (c) => {
    const user = c.var.user;
    if (!user?.isService) {
      return c.json({ error: { code: "FORBIDDEN", message: "Service token required." } }, 403);
    }

    const body = await c.req.json().catch(() => null);
    const parsed = InternalTriggerSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid request body.",
            details: parsed.error.flatten(),
          },
        },
        400,
      );
    }

    const d = parsed.data;
    const result = await runService.triggerRun(
      d.pipelineId,
      d.tenantId,
      "service",
      d.input ?? {},
      {
        callerService: d.callerService,
        ...(d.callerRequestId !== undefined ? { callerRequestId: d.callerRequestId } : {}),
      },
    );

    return c.json({ data: result }, 202);
  });

  return routes;
}
