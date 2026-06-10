import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import { updateRateLimitConfigRequest } from "../schemas/index.js";
import type { RateLimitConfigRepository } from "../repositories/rate-limit-config-repository.js";

export interface AdminRouteDeps {
  rateLimitConfigRepo: RateLimitConfigRepository;
}

export function createAdminRoutes(deps: AdminRouteDeps): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { rateLimitConfigRepo } = deps;

  routes.get("/rate-limits", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "Authentication required." } }, 401);
    }

    if (!user.roles?.includes("admin")) {
      return c.json({ error: { code: "FORBIDDEN", message: "Admin role required." } }, 403);
    }

    const config = await rateLimitConfigRepo.findByTenantId(user.tenantId);
    return c.json({ data: config });
  });

  routes.put("/rate-limits", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "Authentication required." } }, 401);
    }

    if (!user.roles?.includes("admin")) {
      return c.json({ error: { code: "FORBIDDEN", message: "Admin role required." } }, 403);
    }

    const body = await c.req.json();
    const parsed = updateRateLimitConfigRequest.safeParse(body);
    if (!parsed.success) {
      return c.json({
        error: { code: "VALIDATION_ERROR", message: "Invalid request body.", details: parsed.error.flatten() },
      }, 400);
    }

    const config = await rateLimitConfigRepo.upsert(user.tenantId, {
      tier_name: parsed.data.tierName,
      ...(parsed.data.reqPerMinTenant !== undefined ? { req_per_min_tenant: parsed.data.reqPerMinTenant } : {}),
      ...(parsed.data.reqPerMinApiKey !== undefined ? { req_per_min_api_key: parsed.data.reqPerMinApiKey } : {}),
      ...(parsed.data.burstMultiplier !== undefined ? { burst_multiplier: parsed.data.burstMultiplier } : {}),
      ...(parsed.data.burstDurationSec !== undefined ? { burst_duration_sec: parsed.data.burstDurationSec } : {}),
      ...(parsed.data.apiKeyOverrides !== undefined ? { api_key_overrides: parsed.data.apiKeyOverrides } : {}),
    });

    return c.json({ data: config });
  });

  return routes;
}
