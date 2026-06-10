import { createMiddleware } from "hono/factory";

export interface RateLimitInfo {
  limit: number;
  remaining: number;
  // Unix epoch seconds at which the window resets
  reset: number;
  policy: "global" | "per-tenant" | "per-api-key" | "webhook";
}

// rateLimitHeadersMiddleware appends X-RateLimit-* headers to every response.
// The Gateway sets c.var.rateLimitInfo after running its sliding-window check.
// Other services that don't rate-limit leave it unset, and no headers are added.
// Retry-After is set when remaining=0 so clients know when to retry (spec §6).
export function rateLimitHeadersMiddleware() {
  return createMiddleware(async (c, next) => {
    await next();

    const info = (c.var as { rateLimitInfo?: RateLimitInfo }).rateLimitInfo;
    if (!info) return;

    c.header("X-RateLimit-Limit", String(info.limit));
    c.header("X-RateLimit-Remaining", String(info.remaining));
    c.header("X-RateLimit-Reset", String(info.reset));
    c.header("X-RateLimit-Policy", info.policy);

    if (info.remaining === 0) {
      const secondsUntilReset = Math.max(0, info.reset - Math.floor(Date.now() / 1000));
      c.header("Retry-After", String(secondsUntilReset));
    }
  });
}
