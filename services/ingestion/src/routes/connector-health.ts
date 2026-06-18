import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import { UnauthorizedError } from "@oneplatform/core";
import type { ConnectorHealthService } from "../services/connector-health-service.js";

export interface ConnectorHealthRouteDeps {
  connectorHealthService: ConnectorHealthService;
}

/**
 * Mount health monitoring endpoints onto an existing Hono router.
 *
 * Expected mount points (registered in index.ts):
 *   GET /api/v1/connectors/health          — aggregate health summary
 *   GET /api/v1/connectors/:id/health      — per-connector health detail
 *
 * NOTE: The aggregate route must be registered BEFORE the :id parameterised
 * route so Hono does not match the literal segment "health" as a connector ID.
 * The registration order is enforced in createConnectorRoutes via mount order.
 */
export function createConnectorHealthRoutes(
  deps: ConnectorHealthRouteDeps,
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { connectorHealthService } = deps;

  // GET /health — aggregate summary for the authenticated tenant.
  routes.get("/health", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    const summary = await connectorHealthService.getHealthSummary(user.tenantId);
    return c.json({ data: summary });
  });

  // GET /:id/health — detailed health for a single connector.
  routes.get("/:id/health", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    const detail = await connectorHealthService.getConnectorHealth(
      user.tenantId,
      c.req.param("id"),
    );
    return c.json({ data: detail });
  });

  return routes;
}
