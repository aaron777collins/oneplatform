import { Hono } from "hono";
import type { Pool } from "pg";
import type { Redis } from "ioredis";

export interface HealthRouteDeps {
  pool: Pool;
  redis: Redis;
  serviceStartedAt: Date;
}

export function createHealthRoutes(deps: HealthRouteDeps): Hono {
  const routes = new Hono();
  const { pool, redis, serviceStartedAt } = deps;

  routes.get("/healthz", (c) => {
    return c.json({
      status: "ok",
      uptime: Math.floor((Date.now() - serviceStartedAt.getTime()) / 1000),
    });
  });

  routes.get("/readyz", async (c) => {
    const checks: Record<string, "ok" | "fail"> = {};

    try {
      await pool.query("SELECT 1");
      checks["postgres"] = "ok";
    } catch {
      checks["postgres"] = "fail";
    }

    try {
      await redis.ping();
      checks["redis"] = "ok";
    } catch {
      checks["redis"] = "fail";
    }

    const allOk = Object.values(checks).every((v) => v === "ok");
    return c.json(
      {
        status: allOk ? "ready" : "not_ready",
        checks,
        uptime: Math.floor((Date.now() - serviceStartedAt.getTime()) / 1000),
      },
      allOk ? 200 : 503,
    );
  });

  return routes;
}
