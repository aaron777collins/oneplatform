import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import type { HookService } from "../services/hook-service.js";

export interface HookRouteDeps {
  hookService: HookService;
}

export function createHookRoutes(
  deps: HookRouteDeps
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { hookService } = deps;

  // GET /api/v1/plugins/:id/hooks — public hook query for a plugin
  // Note: the primary hook chain query endpoint is internal (spec §8.3).
  // This public route lists hooks registered for a specific plugin.
  routes.get("/:id/hooks", async (c) => {
    const pluginId = c.req.param("id");
    const stage = new URL(c.req.url).searchParams.get("stage");
    const tenantId = c.var.user?.tenantId;

    if (!stage || !tenantId) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "stage and authenticated tenantId are required",
            requestId: c.var.requestId,
          },
        },
        400
      );
    }

    const allHooks = await hookService.resolveChain(stage, tenantId);
    // Filter by the plugin ID from the path parameter to scope results
    // to the requested plugin, matching the API contract.
    const hooks = allHooks.filter((h) => h.pluginId === pluginId);
    return c.json({ hooks });
  });

  return routes;
}
