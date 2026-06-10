import { createMiddleware } from "hono/factory";
import type { RateLimitInfo } from "../types.js";

export type { RateLimitInfo };

export function rateLimitHeadersMiddleware() {
  return createMiddleware(async (c, next) => {
    await next();

    const info = c.var["rateLimitInfo"] as RateLimitInfo | undefined;
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
