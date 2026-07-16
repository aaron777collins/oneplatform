import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";

export function createConfigRoutes(): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();

  // GET /api/v1/config/public
  // Returns public platform configuration consumed by the app editor's PreviewPane
  // to determine sandbox mode (wildcard domain vs same-origin).
  // This endpoint is intentionally unauthenticated — it exposes only non-sensitive
  // deployment topology hints, not secrets or tenant data.
  routes.get("/public", (c) => {
    const wildcardDomain = process.env["OP_WILDCARD_DOMAIN"] ?? "";
    return c.json({
      data: {
        ...(wildcardDomain.length > 0 ? { wildcardDomain } : {}),
      },
    });
  });

  return routes;
}
