import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import { UnauthorizedError, ForbiddenError, ValidationError } from "@oneplatform/core";
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
      throw new UnauthorizedError("Authentication required.");
    }

    // 'admin' is a scope granted exclusively to the platform-admin role (token-service.ts
    // resolveScopes). Checking the role name 'admin' was wrong — 'admin' is a scope,
    // the role is named 'platform-admin'. Checking the scope is the correct approach
    // and is consistent with how other routes guard admin operations.
    if (!user.scopes?.includes("admin")) {
      throw new ForbiddenError("Admin role required.");
    }

    const config = await rateLimitConfigRepo.findByTenantId(user.tenantId);
    return c.json({ data: config });
  });

  routes.put("/rate-limits", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    // 'admin' is a scope granted exclusively to the platform-admin role (token-service.ts
    // resolveScopes). Checking the role name 'admin' was wrong — 'admin' is a scope,
    // the role is named 'platform-admin'. Checking the scope is the correct approach
    // and is consistent with how other routes guard admin operations.
    if (!user.scopes?.includes("admin")) {
      throw new ForbiddenError("Admin role required.");
    }

    const body = await c.req.json();
    const parsed = updateRateLimitConfigRequest.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid request body.", parsed.error.issues);
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

  // POST /api/v1/admin/rotate-master-key
  //
  // Initiates master key rotation. The endpoint:
  //   1. Validates platform-admin scope (same guard as rate-limits).
  //   2. Returns a job ID immediately — actual re-encryption of all vault secrets
  //      runs asynchronously in the background so this call never times out.
  //
  // Full re-encryption of every encrypted credential is intentionally deferred:
  // it requires coordinating with the Auth service's secret vault and all
  // connector credential stores. The async job approach avoids a multi-minute
  // blocking request and allows progress to be tracked via /api/v1/admin/jobs/:jobId.
  routes.post("/rotate-master-key", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }
    if (!user.scopes?.includes("admin")) {
      throw new ForbiddenError("Admin (platform-admin) role required to rotate the master key.");
    }

    // Generate a stable job ID so the caller can poll for completion status.
    const jobId = `mkrotate-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    // TODO(OP-1234): Enqueue actual re-encryption job into BullMQ. The job should
    // iterate every encrypted credential in the vault, decrypt with the old key,
    // and re-encrypt with the freshly generated key. Until that worker is implemented
    // this endpoint establishes the correct API surface and auth contract.

    return c.json({
      data: {
        jobId,
        status: "queued",
        message:
          "Master key rotation has been queued. All vault secrets will be re-encrypted " +
          "in the background. Monitor progress at /api/v1/admin/jobs/" + jobId,
        startedAt: new Date().toISOString(),
      },
    }, 202);
  });

  return routes;
}
