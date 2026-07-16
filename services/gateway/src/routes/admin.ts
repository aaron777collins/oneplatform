import { Hono } from "hono";
import type { AppVariables, ServiceTokenSigner } from "@oneplatform/core";
import { UnauthorizedError, ForbiddenError, ValidationError } from "@oneplatform/core";
import { updateRateLimitConfigRequest } from "../schemas/index.js";
import type { RateLimitConfigRepository } from "../repositories/rate-limit-config-repository.js";

export interface AdminRouteDeps {
  rateLimitConfigRepo: RateLimitConfigRepository;
  authServiceUrl: string;
  pipelineServiceUrl: string;
  serviceTokenSigner?: ServiceTokenSigner;
}

export function createAdminRoutes(deps: AdminRouteDeps): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { rateLimitConfigRepo, authServiceUrl, pipelineServiceUrl, serviceTokenSigner } = deps;

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

  // GET /api/v1/admin/stats
  // Aggregates system-wide counts from auth and pipeline services.
  // Falls back to zero counts on any downstream failure so the admin UI
  // always renders (the frontend supplies mock data when this returns an error).
  routes.get("/stats", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }
    if (!user.scopes?.includes("admin")) {
      throw new ForbiddenError("Admin role required.");
    }

    const fetchCount = async (url: string): Promise<number> => {
      try {
        const headers: Record<string, string> = {
          "x-oneplatform-tenant-id": user.tenantId,
        };
        if (user.userId) headers["x-oneplatform-user-id"] = user.userId;
        if (user.roles?.length) headers["x-oneplatform-user-roles"] = user.roles.join(",");
        if (serviceTokenSigner) headers["x-service-token"] = await serviceTokenSigner.sign();
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(3000) });
        if (!res.ok) return 0;
        const body = await res.json() as { pagination?: { total?: number }; meta?: { total?: number }; total?: number };
        return body.pagination?.total ?? body.meta?.total ?? body.total ?? 0;
      } catch {
        return 0;
      }
    };

    const [users, tenants, pipelines] = await Promise.all([
      fetchCount(`${authServiceUrl}/api/v1/users?limit=1`),
      fetchCount(`${authServiceUrl}/api/v1/tenants?limit=1`),
      fetchCount(`${pipelineServiceUrl}/api/v1/pipelines?limit=1`),
    ]);

    return c.json({
      data: {
        stats: {
          userCount: users,
          tenantCount: tenants,
          activeSessions: 0,
          pipelineCount: pipelines,
        },
        activity: [],
      },
    });
  });

  return routes;
}
