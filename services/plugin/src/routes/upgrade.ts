import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import type { UpgradeService } from "../services/upgrade-service.js";
import { UpgradeSchema } from "../schemas/index.js";

// ---------------------------------------------------------------------------
// Upgrade and rollback routes (B2 fix — spec §10)
//
// POST /api/v1/plugins/:manifestId/upgrade
// POST /api/v1/plugins/:manifestId/rollback
//
// Both operations are platform-admin only. The upgrade route accepts an
// optional scheduledAt timestamp (reserved for future use — not yet actioned).
// ---------------------------------------------------------------------------

export interface UpgradeRouteDeps {
  upgradeService: UpgradeService;
}

export function createUpgradeRoutes(
  deps: UpgradeRouteDeps
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { upgradeService } = deps;

  // POST /api/v1/plugins/:manifestId/upgrade — initiate version upgrade
  routes.post("/:manifestId/upgrade", async (c) => {
    const user = c.var.user;
    if (!user?.roles.includes("platform-admin")) {
      return c.json(
        {
          error: {
            code: "FORBIDDEN",
            message: "Platform admin role required to upgrade plugins.",
            requestId: c.var.requestId,
          },
        },
        403
      );
    }

    const manifestId = c.req.param("manifestId");

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Request body must be JSON",
            requestId: c.var.requestId,
          },
        },
        400
      );
    }

    const parsed = UpgradeSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid request body",
            requestId: c.var.requestId,
            details: parsed.error.flatten(),
          },
        },
        400
      );
    }

    const { toVersion } = parsed.data;
    const result = await upgradeService.upgrade({
      manifestId,
      toVersion,
      upgradedBy: user.userId,
    });

    return c.json(result, 200);
  });

  // POST /api/v1/plugins/:manifestId/rollback — roll back to previous version
  routes.post("/:manifestId/rollback", async (c) => {
    const user = c.var.user;
    if (!user?.roles.includes("platform-admin")) {
      return c.json(
        {
          error: {
            code: "FORBIDDEN",
            message: "Platform admin role required to roll back plugins.",
            requestId: c.var.requestId,
          },
        },
        403
      );
    }

    const manifestId = c.req.param("manifestId");

    const result = await upgradeService.rollback({
      manifestId,
      rolledBackBy: user.userId,
    });

    return c.json(result, 200);
  });

  return routes;
}
