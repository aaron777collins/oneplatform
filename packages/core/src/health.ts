import type { Context } from "hono";
import type pg from "pg";
import type { Redis } from "ioredis";

export interface HealthConfig {
  service: string;
  version: string;
}

export interface ReadyzConfig extends HealthConfig {
  db: pg.Pool;
  redis: Redis;
}

type CheckResult = "ok" | "error";

export function healthz(config: HealthConfig) {
  return async (c: Context) => {
    const start = Date.now();
    const body = {
      status: "ok",
      service: config.service,
      version: config.version,
    };
    c.header("X-Response-Time", `${Date.now() - start}ms`);
    return c.json(body, 200);
  };
}

export function readyz(config: ReadyzConfig) {
  return async (c: Context) => {
    const start = Date.now();
    const checks: Record<string, CheckResult> = {};

    await Promise.all([
      (async () => {
        try {
          await config.db.query("SELECT 1");
          checks["postgres"] = "ok";
        } catch {
          checks["postgres"] = "error";
        }
      })(),
      (async () => {
        try {
          const pong = await config.redis.ping();
          checks["redis"] = pong === "PONG" ? "ok" : "error";
        } catch {
          checks["redis"] = "error";
        }
      })(),
    ]);

    const allHealthy = Object.values(checks).every((v) => v === "ok");
    // Use "not_ready" (underscore) to match the value returned by all custom
    // health routes in the other services. Monitoring tools and orchestrators
    // parse this value and must receive a consistent string across all services.
    const status = allHealthy ? "ready" : "not_ready";
    const httpStatus = allHealthy ? 200 : 503;

    const body = {
      status,
      service: config.service,
      version: config.version,
      checks,
    };

    c.header("X-Response-Time", `${Date.now() - start}ms`);
    return c.json(body, httpStatus);
  };
}
