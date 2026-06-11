import { Hono } from "hono";
import type { Pool } from "pg";
import type { UnixSocketClient } from "../services/unix-socket-client.js";

// ---------------------------------------------------------------------------
// Health routes — design spec §15.4
//
// GET /healthz — liveness: returns 200 if the process is alive
// GET /readyz  — readiness: returns 200 only if Unix socket to sandbox is healthy
//
// The readiness probe returns 503 if the sandbox is unreachable or in the
// middle of a recycle with no replacement ready.
// ---------------------------------------------------------------------------

export interface HealthRouteDeps {
  pool: Pool;
  sandboxClient: UnixSocketClient;
  serviceStartedAt: Date;
  isReady: () => boolean;
}

export function createHealthRoutes(deps: HealthRouteDeps): Hono {
  const routes = new Hono();
  const { pool, sandboxClient, serviceStartedAt, isReady } = deps;

  // GET /healthz — liveness check
  // Always returns 200 if the process is alive — Docker HEALTHCHECK uses this.
  routes.get("/healthz", (c) => {
    return c.json({
      status: "ok",
      uptime: Math.floor((Date.now() - serviceStartedAt.getTime()) / 1000),
    });
  });

  // GET /readyz — readiness check
  // Fails if Postgres is unreachable OR the sandbox Unix socket handshake fails.
  routes.get("/readyz", async (c) => {
    const checks: Record<string, "ok" | "fail"> = {};

    // Postgres check
    try {
      await pool.query("SELECT 1");
      checks["postgres"] = "ok";
    } catch {
      checks["postgres"] = "fail";
    }

    // Sandbox Unix socket check — ping must succeed (spec §15.4)
    try {
      const pong = await sandboxClient.ping();
      checks["sandbox"] = pong.pong ? "ok" : "fail";
    } catch {
      checks["sandbox"] = "fail";
    }

    const allOk = isReady() && Object.values(checks).every((v) => v === "ok");

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
