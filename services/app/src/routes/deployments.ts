import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import type { DeployService } from "../services/deploy-service.js";
import { DeploySchema, RollbackSchema } from "../schemas/index.js";

// ---------------------------------------------------------------------------
// Route dependencies
// ---------------------------------------------------------------------------

export interface DeploymentRouteDeps {
  deployService: DeployService;
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function createDeploymentRoutes(deps: DeploymentRouteDeps): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { deployService } = deps;

  // POST /deploy
  routes.post("/deploy", async (c) => {
    const user = c.var.user;
    if (user === undefined) return c.json({ error: { code: "UNAUTHORIZED", message: "Authentication required." } }, 401);

    const appId = c.req.param("appId") ?? c.req.param("id");
    if (appId === undefined) {
      return c.json({ error: { code: "VALIDATION_ERROR", message: "Missing appId in route." } }, 400);
    }

    const body = await c.req.json().catch(() => ({}));
    const parsed = DeploySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: "VALIDATION_ERROR", message: "Invalid request body.", details: parsed.error.flatten() } }, 400);
    }

    const result = await deployService.deployApp(
      user.tenantId,
      appId,
      user.userId,
      parsed.data.buildId
    );

    return c.json({ data: result });
  });

  // POST /rollback
  routes.post("/rollback", async (c) => {
    const user = c.var.user;
    if (user === undefined) return c.json({ error: { code: "UNAUTHORIZED", message: "Authentication required." } }, 401);

    const appId = c.req.param("appId") ?? c.req.param("id");
    if (appId === undefined) {
      return c.json({ error: { code: "VALIDATION_ERROR", message: "Missing appId in route." } }, 400);
    }

    const body = await c.req.json().catch(() => null);
    const parsed = RollbackSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: "VALIDATION_ERROR", message: "Invalid request body.", details: parsed.error.flatten() } }, 400);
    }

    const result = await deployService.rollbackApp(
      user.tenantId,
      appId,
      user.userId,
      parsed.data.buildId
    );

    return c.json({ data: result });
  });

  return routes;
}
