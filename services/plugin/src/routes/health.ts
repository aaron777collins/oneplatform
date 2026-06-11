import { Hono } from "hono";
import type { Pool } from "pg";
import type { Redis } from "ioredis";
import type { BundleService } from "../services/bundle-service.js";

export interface HealthRouteDeps {
  pool: Pool;
  redis: Redis;
  bundleService: BundleService;
  serviceStartedAt: Date;
  isReady: () => boolean;
}

export function createHealthRoutes(deps: HealthRouteDeps): Hono {
  const routes = new Hono();
  const { pool, redis, bundleService, serviceStartedAt, isReady } = deps;

  // GET /health/live — liveness (always 200 if the process is alive).
  routes.get("/health/live", (c) => {
    return c.json({
      status: "ok",
      uptime: Math.floor((Date.now() - serviceStartedAt.getTime()) / 1000),
    });
  });

  // GET /health/ready — readiness (checks DB, MinIO, Redis).
  // Returns 503 when any critical dependency is unreachable.
  routes.get("/health/ready", async (c) => {
    const checks: Record<string, "ok" | "fail"> = {};

    try {
      await pool.query("SELECT 1");
      checks["database"] = "ok";
    } catch {
      checks["database"] = "fail";
    }

    try {
      const alive = await bundleService.ping();
      checks["minio"] = alive ? "ok" : "fail";
    } catch {
      checks["minio"] = "fail";
    }

    try {
      await redis.ping();
      checks["redis"] = "ok";
    } catch {
      checks["redis"] = "fail";
    }

    const allOk = isReady() && Object.values(checks).every((v) => v === "ok");

    return c.json(
      {
        status: allOk ? "ready" : "not_ready",
        checks,
        uptime: Math.floor((Date.now() - serviceStartedAt.getTime()) / 1000),
      },
      allOk ? 200 : 503
    );
  });

  return routes;
}
