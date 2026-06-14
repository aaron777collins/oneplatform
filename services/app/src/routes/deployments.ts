import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import { ValidationError, UnauthorizedError, NotFoundError } from "@oneplatform/core";
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
    if (user === undefined) throw new UnauthorizedError("Authentication required.");

    const appId = c.req.param("appId") ?? c.req.param("id");
    if (appId === undefined) {
      throw new NotFoundError("Missing appId in route.");
    }

    const body = await c.req.json().catch(() => ({}));
    const parsed = DeploySchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid request body.", parsed.error.issues);
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
    if (user === undefined) throw new UnauthorizedError("Authentication required.");

    const appId = c.req.param("appId") ?? c.req.param("id");
    if (appId === undefined) {
      throw new NotFoundError("Missing appId in route.");
    }

    const body = await c.req.json().catch(() => null);
    const parsed = RollbackSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid request body.", parsed.error.issues);
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
