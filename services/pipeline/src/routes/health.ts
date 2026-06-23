import { Hono } from "hono";
import type { Pool } from "pg";
import type { Redis } from "ioredis";
import type { Queue } from "bullmq";

// ---------------------------------------------------------------------------
// Health route dependencies
// ---------------------------------------------------------------------------

export interface HealthRouteDeps {
  pool: Pool;
  redis: Redis;
  runQueue: Queue;
  serviceStartedAt: Date;
  isReady: () => boolean;
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function createHealthRoutes(deps: HealthRouteDeps): Hono {
  const routes = new Hono();
  const { pool, redis, runQueue, serviceStartedAt, isReady } = deps;

  // GET /healthz — liveness check (design spec §17.5)
  // Always returns 200 if the process is alive — Docker health check uses this.
  routes.get("/healthz", (c) => {
    return c.json({
      status: "ok",
      uptime: Math.floor((Date.now() - serviceStartedAt.getTime()) / 1000),
    });
  });

  // GET /readyz — readiness check with queue depth metrics (design spec §10.5, §17.5)
  // Returns 503 during startup or when critical dependencies are unreachable.
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

    // Queue depth metrics (design spec §10.5)
    // Note: pipeline:cron queue was removed (P19-101) — cron is driven by an
    // in-process setInterval loop, not a BullMQ worker, so the queue was
    // unused and reporting misleading metrics.
    let queueMetrics: {
      "pipeline.run": { active: number; waiting: number; failed: number; dlq: number };
    } = {
      "pipeline.run": { active: 0, waiting: 0, failed: 0, dlq: 0 },
    };

    try {
      const [runActive, runWaiting, runFailed] = await Promise.all([
        runQueue.getActiveCount(),
        runQueue.getWaitingCount(),
        runQueue.getFailedCount(),
      ]);
      queueMetrics["pipeline.run"] = { active: runActive, waiting: runWaiting, failed: runFailed, dlq: 0 };
    } catch {
      // Queue metrics are informational — do not fail readyz for this
    }

    const allOk = isReady() && Object.values(checks).every((v) => v === "ok");

    return c.json(
      {
        status: allOk ? "ready" : "not_ready",
        checks,
        queues: queueMetrics,
        uptime: Math.floor((Date.now() - serviceStartedAt.getTime()) / 1000),
      },
      allOk ? 200 : 503,
    );
  });

  return routes;
}
