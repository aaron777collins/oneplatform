import { createMiddleware } from "hono/factory";
import type { AppVariables } from "../types.js";

// ---------------------------------------------------------------------------
// MeteringRecorder — minimal interface that the middleware depends on.
//
// The full MeteringService (in gateway service) implements this interface.
// Keeping the middleware's dependency on a narrow interface means any service
// can inject a lightweight recorder without pulling in the entire gateway
// metering stack.
// ---------------------------------------------------------------------------

export interface MeteringRecorder {
  recordApiCall(tenantId: string, endpoint: string, method: string): void;
}

export interface MeteringMiddlewareConfig {
  recorder: MeteringRecorder;
  /**
   * Paths to skip metering for entirely (e.g. health probes, OpenAPI spec).
   * Matched by exact prefix. Defaults to ["/healthz", "/readyz"].
   */
  skipPaths?: string[];
}

// Default paths that should never be counted toward API call quotas.
// Health probes from Kubernetes/Docker would inflate tenant counters and skew
// billing data significantly — they must always be excluded.
const DEFAULT_SKIP_PATHS = new Set(["/healthz", "/readyz"]);

/**
 * Zero-latency API metering middleware for Hono.
 *
 * Records one API call per authenticated request by delegating to a
 * {@link MeteringRecorder} whose `recordApiCall` implementation is
 * fire-and-forget (increments a Redis counter, never awaited).
 *
 * The middleware:
 *  - Skips health-check endpoints unconditionally.
 *  - Skips requests with no resolved tenant (unauthenticated / public routes).
 *  - Always calls `next()` before recording so the response status is
 *    available, but the recording itself is non-blocking — it does not
 *    delay the response to the client.
 *
 * Usage:
 * ```ts
 * app.use("*", meteringMiddleware({ recorder: meteringService }));
 * ```
 */
export function meteringMiddleware(config: MeteringMiddlewareConfig) {
  const skipPaths: Set<string> = new Set([
    ...DEFAULT_SKIP_PATHS,
    ...(config.skipPaths ?? []),
  ]);

  return createMiddleware<{ Variables: AppVariables }>(async (c, next) => {
    // Complete the request first — metering is observational and must not
    // delay the response or add latency to the hot path.
    await next();

    const path = new URL(c.req.url).pathname;

    // Health probes and explicitly skipped paths must never be metered.
    if (skipPaths.has(path)) return;

    // Only meter authenticated requests so we always have a tenant to bill.
    const user = c.var.user;
    if (!user?.tenantId) return;

    // Fire-and-forget — the recorder's implementation is non-blocking.
    config.recorder.recordApiCall(user.tenantId, path, c.req.method);
  });
}
