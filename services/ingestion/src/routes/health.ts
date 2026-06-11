import { Hono } from "hono";
import type { Pool } from "pg";
import type { Redis } from "ioredis";
import type { ObjectStorageClient } from "../services/upload-service.js";

export interface HealthRouteDeps {
  pool: Pool;
  redis: Redis;
  serviceStartedAt: Date;
  storage: ObjectStorageClient;
  masterKey: Buffer;
}

export function createHealthRoutes(deps: HealthRouteDeps): Hono {
  const routes = new Hono();
  const { pool, redis, serviceStartedAt, storage, masterKey } = deps;

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

    // Verify MinIO connectivity. A failure here means upload workers cannot
    // store or retrieve files — the service is not ready to accept uploads.
    try {
      // putObject with an empty body to a well-known sentinel key acts as a
      // lightweight health-check without reading back a real file.
      await storage.putObject("health-check", "readyz-probe", new Uint8Array(0), "application/octet-stream");
      checks["minio"] = "ok";
    } catch {
      checks["minio"] = "fail";
    }

    // Verify the master key is present and non-empty. A zero-length or missing
    // key would cause all credential encrypt/decrypt operations to fail silently.
    checks["masterKey"] = masterKey.length >= 32 ? "ok" : "fail";

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
