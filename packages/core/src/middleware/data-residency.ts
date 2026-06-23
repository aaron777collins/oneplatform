// Data residency enforcement middleware for Hono.
//
// Intercepts authenticated requests to validate that the tenant's data
// operations comply with their configured residency policy. The middleware
// is designed to be non-blocking for tenants without a residency policy
// (opt-in model) while strictly enforcing region constraints for those
// that have one configured.
//
// The middleware depends on a narrow ResidencyEnforcer interface rather
// than the full DataResidencyService so that any service can inject a
// lightweight enforcer without pulling in the entire gateway stack.

import { createMiddleware } from "hono/factory";
import type { AppVariables } from "../types.js";

// ---------------------------------------------------------------------------
// ResidencyEnforcer — narrow dependency interface
//
// The full DataResidencyService (in gateway service) implements this.
// Keeping the middleware's dependency narrow follows the Interface Segregation
// Principle and makes it easy to mock in tests.
// ---------------------------------------------------------------------------

export interface ResidencyEnforcer {
  /**
   * Get the assigned region for a tenant. Returns null if no policy exists.
   */
  getPolicy(tenantId: string): Promise<{ region: string } | null>;

  /**
   * Evaluate whether a cross-region transfer is permitted.
   */
  evaluateTransfer(
    sourceRegion: string,
    targetRegion: string,
  ): Promise<{ allowed: boolean; policy: string; justificationRequired: boolean }>;

  /**
   * Log a data location event for audit purposes.
   */
  logDataLocation(
    recordId: string,
    tenantId: string,
    region: string,
    service: string,
    options?: {
      operation?: string;
      actorId?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<unknown>;
}

export interface DataResidencyMiddlewareConfig {
  enforcer: ResidencyEnforcer;
  /**
   * The region this service instance is deployed in.
   * Used to determine if a request is cross-region.
   */
  serviceRegion: string;
  /**
   * Name of this service (for audit logging).
   */
  serviceName: string;
  /**
   * Paths to skip residency checks for (e.g. health probes, public routes).
   * Matched by exact prefix. Defaults to ["/healthz", "/readyz"].
   */
  skipPaths?: string[];
  /**
   * Whether to block unauthorized cross-region transfers (true) or just
   * log them (false). Defaults to true (enforce mode).
   */
  enforce?: boolean;
}

const DEFAULT_SKIP_PATHS = new Set(["/healthz", "/readyz"]);

/**
 * Data residency enforcement middleware for Hono.
 *
 * Checks the tenant's configured data region against the service's region.
 * When a mismatch is detected:
 *   - In enforce mode (default): blocks the request with 403 if no transfer
 *     rule allows the cross-region access.
 *   - In audit-only mode: logs the cross-region access but allows the request
 *     to proceed.
 *
 * The middleware:
 *   - Skips health-check endpoints unconditionally.
 *   - Skips requests with no resolved tenant (unauthenticated / public routes).
 *   - Tenants without a residency policy are not restricted (opt-in model).
 *   - Always logs cross-region access attempts for compliance auditing.
 *
 * Usage:
 * ```ts
 * app.use("*", dataResidencyMiddleware({
 *   enforcer: dataResidencyService,
 *   serviceRegion: "US_EAST",
 *   serviceName: "gateway-service",
 * }));
 * ```
 */
export function dataResidencyMiddleware(config: DataResidencyMiddlewareConfig) {
  const skipPaths: Set<string> = new Set([
    ...DEFAULT_SKIP_PATHS,
    ...(config.skipPaths ?? []),
  ]);

  const enforce = config.enforce ?? true;

  return createMiddleware<{ Variables: AppVariables }>(async (c, next) => {
    const path = new URL(c.req.url).pathname;

    // Health probes and explicitly skipped paths must never be checked
    if (skipPaths.has(path)) {
      await next();
      return;
    }

    // Only check authenticated requests with a tenant context
    const user = c.var.user;
    if (!user?.tenantId) {
      await next();
      return;
    }

    // Look up the tenant's residency policy
    let policy: { region: string } | null;
    try {
      policy = await config.enforcer.getPolicy(user.tenantId);
    } catch {
      // If policy lookup fails, allow the request to proceed
      // to avoid a residency service outage blocking all requests.
      await next();
      return;
    }

    // No policy = no restrictions (opt-in model)
    if (policy === null) {
      await next();
      return;
    }

    const tenantRegion = policy.region;
    const serviceRegion = config.serviceRegion;

    // Same-region: proceed without additional checks
    if (tenantRegion === serviceRegion) {
      await next();
      return;
    }

    // Cross-region access detected — evaluate transfer rules
    let evaluation: { allowed: boolean; policy: string; justificationRequired: boolean };
    try {
      evaluation = await config.enforcer.evaluateTransfer(tenantRegion, serviceRegion);
    } catch {
      // If evaluation fails, fail-closed in enforce mode
      if (enforce) {
        return c.json(
          {
            error: {
              code: "FORBIDDEN",
              message: "Data residency check failed. Unable to evaluate cross-region transfer rules.",
              requestId: c.var.requestId ?? "",
            },
          },
          403,
        );
      }
      await next();
      return;
    }

    // Log the cross-region access attempt (fire-and-forget)
    config.enforcer.logDataLocation(
      "middleware-check",
      user.tenantId,
      serviceRegion,
      config.serviceName,
      {
        operation: "cross_region_access_attempt",
        actorId: user.userId,
        metadata: {
          tenantRegion,
          serviceRegion,
          transferPolicy: evaluation.policy,
          allowed: evaluation.allowed,
          path,
          method: c.req.method,
        },
      },
    ).catch(() => {
      // Audit logging failure must not block the request
    });

    if (!evaluation.allowed && enforce) {
      // Log the region details internally — never expose topology in the response body
      console.warn(
        `[data-residency] request blocked: tenantRegion=${tenantRegion} serviceRegion=${serviceRegion} requestId=${c.var.requestId ?? ""}`,
      );
      return c.json(
        {
          error: {
            code: "FORBIDDEN",
            message: "Access denied: data residency policy does not permit this request.",
            requestId: c.var.requestId ?? "",
          },
        },
        403,
      );
    }

    await next();
  });
}
