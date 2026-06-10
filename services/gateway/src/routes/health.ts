import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import type pg from "pg";
import type { Redis } from "ioredis";

export interface HealthRouteDeps {
  pool: pg.Pool;
  redis: Redis;
  serviceStartedAt: Date;
}

export function createHealthRoutes(deps: HealthRouteDeps): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { pool, redis, serviceStartedAt } = deps;

  routes.get("/healthz", async (c) => {
    const checks: Record<string, string> = {};
    let healthy = true;

    try {
      await pool.query("SELECT 1");
      checks["postgres"] = "ok";
    } catch {
      checks["postgres"] = "error";
      healthy = false;
    }

    try {
      await redis.ping();
      checks["redis"] = "ok";
    } catch {
      checks["redis"] = "error";
      healthy = false;
    }

    const status = healthy ? "healthy" : "degraded";
    return c.json({
      status,
      service: "gateway",
      uptime: Math.floor((Date.now() - serviceStartedAt.getTime()) / 1000),
      checks,
    }, healthy ? 200 : 503);
  });

  routes.get("/readyz", async (c) => {
    try {
      await pool.query("SELECT 1");
      return c.json({ status: "ready" });
    } catch {
      return c.json({ status: "not_ready" }, 503);
    }
  });

  return routes;
}
