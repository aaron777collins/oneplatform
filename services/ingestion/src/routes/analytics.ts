import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import { UnauthorizedError, ValidationError } from "@oneplatform/core";
import type { SyncAnalyticsService } from "../services/sync-analytics-service.js";
import type { ConnectorService } from "../services/index.js";
import {
  connectorAnalyticsQuery,
  tenantOverviewQuery,
} from "../schemas/index.js";

export interface AnalyticsRouteDeps {
  analyticsService: SyncAnalyticsService;
  connectorService: ConnectorService;
}

export function createAnalyticsRoutes(
  deps: AnalyticsRouteDeps,
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { analyticsService, connectorService } = deps;

  // GET /api/v1/connectors/:id/analytics?period=daily&from=...&to=...
  //
  // Returns trend data for a single connector. Scoped to the requesting tenant
  // so cross-tenant leakage is impossible — getConnector throws NotFoundError
  // for connectors the caller doesn't own.
  routes.get("/:id/analytics", async (c) => {
    const user = c.var.user;
    if (user?.tenantId === undefined) {
      throw new UnauthorizedError("Authentication required.");
    }

    // Ownership check — throws ConnectorNotFoundError for cross-tenant access.
    await connectorService.getConnector(user.tenantId, c.req.param("id"));

    const raw = c.req.query();
    const parsed = connectorAnalyticsQuery.safeParse(raw);
    if (!parsed.success) {
      throw new ValidationError("Invalid query parameters.", parsed.error.issues);
    }

    const q = parsed.data;
    const period = q.period ?? "daily";

    const [history, trends] = await Promise.all([
      analyticsService.getSyncHistory(c.req.param("id"), {
        ...(q.from !== undefined ? { from: new Date(q.from) } : {}),
        ...(q.to !== undefined ? { to: new Date(q.to) } : {}),
        limit: q.limit,
        ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
      }),
      analyticsService.getSyncTrends(c.req.param("id"), period),
    ]);

    return c.json({ data: { history, trends } });
  });

  // GET /api/v1/analytics/overview
  //
  // Tenant-wide analytics overview — aggregates across all connectors owned by
  // the calling tenant.
  routes.get("/overview", async (c) => {
    const user = c.var.user;
    if (user?.tenantId === undefined) {
      throw new UnauthorizedError("Authentication required.");
    }

    const raw = c.req.query();
    const parsed = tenantOverviewQuery.safeParse(raw);
    if (!parsed.success) {
      throw new ValidationError("Invalid query parameters.", parsed.error.issues);
    }

    const overview = await analyticsService.getTenantOverview(user.tenantId);
    return c.json({ data: overview });
  });

  return routes;
}
