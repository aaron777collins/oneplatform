import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";

async function buildTestApp(
  dbHealthy: boolean,
  redisHealthy: boolean
) {
  const { healthz, readyz } = await import("../health.js");

  const mockPool = {
    query: vi.fn().mockImplementation(() => {
      if (!dbHealthy) throw new Error("Connection refused");
      return Promise.resolve({ rows: [{ ok: 1 }] });
    }),
  };
  const mockRedis = {
    ping: vi.fn().mockImplementation(() => {
      if (!redisHealthy) throw new Error("Connection refused");
      return Promise.resolve("PONG");
    }),
  };

  const app = new Hono();
  // @ts-expect-error — passing mock objects as dependency types
  app.get("/healthz", healthz({ service: "test-service", version: "0.1.0" }));
  app.get(
    "/readyz",
    // @ts-expect-error
    readyz({ service: "test-service", version: "0.1.0", db: mockPool, redis: mockRedis })
  );
  return app;
}

describe("healthz", () => {
  it("returns 200 with status:ok regardless of dependency state", async () => {
    const app = await buildTestApp(false, false);
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.service).toBe("test-service");
  });

  it("includes X-Response-Time header", async () => {
    const app = await buildTestApp(true, true);
    const res = await app.request("/healthz");
    expect(res.headers.get("X-Response-Time")).toMatch(/^\d+ms$/);
  });
});

describe("readyz", () => {
  it("returns 200 with status:ready when all dependencies are healthy", async () => {
    const app = await buildTestApp(true, true);
    const res = await app.request("/readyz");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ready");
    expect(body.checks.postgres).toBe("ok");
    expect(body.checks.redis).toBe("ok");
  });

  it("returns 503 with status:not_ready when postgres is down", async () => {
    const app = await buildTestApp(false, true);
    const res = await app.request("/readyz");
    expect(res.status).toBe(503);
    const body = await res.json();
    // "not_ready" uses underscore to match all other services' health routes
    expect(body.status).toBe("not_ready");
    expect(body.checks.postgres).toBe("error");
    expect(body.checks.redis).toBe("ok");
  });

  it("returns 503 when redis is down", async () => {
    const app = await buildTestApp(true, false);
    const res = await app.request("/readyz");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.checks.redis).toBe("error");
  });

  it("includes X-Response-Time header", async () => {
    const app = await buildTestApp(true, true);
    const res = await app.request("/readyz");
    expect(res.headers.get("X-Response-Time")).toMatch(/^\d+ms$/);
  });
});
