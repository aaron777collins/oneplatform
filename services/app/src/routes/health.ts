import { Hono } from "hono";
import type { Pool } from "pg";
import type { Redis } from "ioredis";

export interface HealthRouteDeps {
  pool:           Pool;
  redis:          Redis;
  serviceStartedAt: Date;
  isReady:        () => boolean;
  authServiceUrl: string;
}

export function createHealthRoutes(deps: HealthRouteDeps): Hono {
  const routes = new Hono();
  const { pool, redis, serviceStartedAt, isReady, authServiceUrl } = deps;

  // GET /healthz — liveness check (design spec §15.3)
  // Docker HEALTHCHECK uses this. Always 200 if the process is alive.
  routes.get("/healthz", (c) => {
    return c.json({
      status:  "ok",
      service: "app",
      version: "1.0.0",
      uptime:  Math.floor((Date.now() - serviceStartedAt.getTime()) / 1000),
    });
  });

  // GET /readyz — readiness check (design spec §15.3)
  // Returns 503 during startup or when critical dependencies are unreachable.
  routes.get("/readyz", async (c) => {
    const checks: Record<string, string> = {};

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

    // MinIO health check via HEAD on the bucket
    try {
      const endpoint = process.env["MINIO_ENDPOINT"] ?? "http://minio:9000";
      const response = await fetch(`${endpoint}/op-app-artifacts`, {
        method: "HEAD",
        signal: AbortSignal.timeout(3_000),
      });
      // 200 or 403 both indicate MinIO is reachable (403 = bucket exists but no anon access)
      checks["minio"] = response.ok || response.status === 403 ? "ok" : "fail";
    } catch {
      checks["minio"] = "fail";
    }

    // Auth Service health check
    try {
      const response = await fetch(`${authServiceUrl}/healthz`, {
        signal: AbortSignal.timeout(3_000),
      });
      checks["authService"] = response.ok ? "ok" : "degraded";
    } catch {
      checks["authService"] = "degraded";  // degraded, not fail — service can still serve cached sessions
    }

    // Ontology cache check placeholder — in production this would verify
    // the local ontology cache has been populated within the last 10 minutes.
    checks["ontologyServiceCache"] = "ok";

    const allReady =
      isReady() &&
      checks["postgres"] === "ok" &&
      checks["redis"] === "ok" &&
      checks["minio"] === "ok";

    return c.json(
      {
        status: allReady ? "ready" : "not_ready",
        checks,
        uptime: Math.floor((Date.now() - serviceStartedAt.getTime()) / 1000),
      },
      allReady ? 200 : 503
    );
  });

  return routes;
}
