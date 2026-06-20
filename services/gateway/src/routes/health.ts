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

  // Liveness probe — returns 200 unconditionally as long as the process is
  // alive.  Dependency checks belong in /readyz so that a transient DB or
  // Redis outage does not cause the orchestrator to restart the pod.
  routes.get("/healthz", (c) => {
    return c.json({
      status: "ok",
      service: "gateway",
      uptime: Math.floor((Date.now() - serviceStartedAt.getTime()) / 1000),
    }, 200);
  });

  // Readiness probe — verifies that the service can handle traffic by
  // checking connectivity to Postgres and Redis.
  routes.get("/readyz", async (c) => {
    const checks: Record<string, "ok" | "fail"> = {};
    let ready = true;

    try {
      await pool.query("SELECT 1");
      checks["postgres"] = "ok";
    } catch {
      checks["postgres"] = "fail";
      ready = false;
    }

    try {
      await redis.ping();
      checks["redis"] = "ok";
    } catch {
      checks["redis"] = "fail";
      ready = false;
    }

    const status = ready ? "ready" : "not_ready";
    return c.json({ status, checks }, ready ? 200 : 503);
  });

  return routes;
}
