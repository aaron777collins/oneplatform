// packages/core/src/__tests__/rate-limit-headers.test.ts
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { rateLimitHeadersMiddleware } from "../middleware/rate-limit-headers.js";

interface RateLimitInfo {
  limit: number;
  remaining: number;
  reset: number; // Unix epoch seconds
  policy: "global" | "per-tenant" | "per-api-key" | "webhook";
}

function buildApp(rateLimitInfo?: RateLimitInfo) {
  const app = new Hono<{ Variables: { rateLimitInfo?: RateLimitInfo; requestId: string } }>();
  if (rateLimitInfo) {
    app.use("*", (c, next) => { c.set("rateLimitInfo", rateLimitInfo); return next(); });
  }
  app.use("*", rateLimitHeadersMiddleware());
  app.get("/items", (c) => c.json({ ok: true }));
  return app;
}

describe("rateLimitHeadersMiddleware", () => {
  it("sets X-RateLimit-Limit, Remaining, Reset, and Policy headers when rateLimitInfo is present", async () => {
    const info: RateLimitInfo = { limit: 1000, remaining: 987, reset: 1735689600, policy: "per-tenant" };
    const res = await buildApp(info).request("/items");
    expect(res.headers.get("X-RateLimit-Limit")).toBe("1000");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("987");
    expect(res.headers.get("X-RateLimit-Reset")).toBe("1735689600");
    expect(res.headers.get("X-RateLimit-Policy")).toBe("per-tenant");
  });

  it("does not set rate limit headers when rateLimitInfo is absent", async () => {
    const res = await buildApp().request("/items");
    expect(res.headers.get("X-RateLimit-Limit")).toBeNull();
    expect(res.headers.get("X-RateLimit-Remaining")).toBeNull();
  });

  it("sets Retry-After header when remaining is 0", async () => {
    const now = Math.floor(Date.now() / 1000);
    const info: RateLimitInfo = { limit: 100, remaining: 0, reset: now + 30, policy: "per-api-key" };
    const res = await buildApp(info).request("/items");
    expect(res.headers.get("Retry-After")).toBe("30");
  });
});
