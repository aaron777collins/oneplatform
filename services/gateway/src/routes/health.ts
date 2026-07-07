import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import type pg from "pg";
import type { Redis } from "ioredis";

export interface HealthRouteDeps {
  pool: pg.Pool;
  redis: Redis;
  serviceStartedAt: Date;
  serviceUrls: Record<string, string>;
}

interface ServiceHealthResult {
  status: "ok" | "degraded" | "down";
  latencyMs: number;
}

async function probeService(url: string): Promise<ServiceHealthResult> {
  const start = Date.now();
  try {
    const res = await fetch(`${url}/healthz`, {
      signal: AbortSignal.timeout(2000),
    });
    const latencyMs = Date.now() - start;
    return { status: res.ok ? "ok" : "degraded", latencyMs };
  } catch {
    return { status: "down", latencyMs: Date.now() - start };
  }
}

export function createHealthRoutes(deps: HealthRouteDeps): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { pool, redis, serviceStartedAt, serviceUrls } = deps;

  // Liveness probe — probes all downstream services in parallel and returns
  // per-service health. Gateway itself is always "ok" if this handler runs.
  // Dependency checks for DB/Redis belong in /readyz.
  routes.get("/healthz", async (c) => {
    const serviceEntries = Object.entries(serviceUrls);
    const results = await Promise.allSettled(
      serviceEntries.map(([, url]) => probeService(url)),
    );

    const services: Record<string, ServiceHealthResult> = {
      gateway: { status: "ok", latencyMs: 0 },
    };
    for (let i = 0; i < serviceEntries.length; i++) {
      const [name] = serviceEntries[i]!;
      const result = results[i]!;
      services[name] = result.status === "fulfilled"
        ? result.value
        : { status: "down", latencyMs: 0 };
    }

    return c.json({
      status: "ok",
      service: "gateway",
      uptime: Math.floor((Date.now() - serviceStartedAt.getTime()) / 1000),
      services,
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
