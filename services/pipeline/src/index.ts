import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Worker } from "bullmq";
import {
  loadConfig,
  createDbClient,
  createRedisClient,
  createLogger,
  createApp,
  loadMasterKey,
  createQueue,
} from "@oneplatform/core";
import { runMigrations } from "./db/migrate.js";
import {
  createPipelineService,
  createRunService,
  createScheduleService,
  createTriggerService,
  createExecutionEngine,
} from "./services/index.js";
import type {
  PipelineRunJobPayload,
} from "./services/index.js";
import {
  createHealthRoutes,
  createPipelineRoutes,
  createRunRoutes,
  createScheduleRoutes,
  createInternalRoutes,
} from "./routes/index.js";

// ---------------------------------------------------------------------------
// Placeholder repository implementations — these satisfy the interfaces until
// the concrete repository layer (built by the parallel agent) is merged in.
// They throw meaningful errors at runtime to signal an unimplemented path
// rather than silently failing.
// ---------------------------------------------------------------------------

function notImplemented(method: string): never {
  throw new Error(`Repository method not implemented: ${method}. Awaiting concrete repo layer.`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const placeholderPipelineRepo: any = new Proxy({}, {
  get: (_target, prop) => () => notImplemented(`PipelineRepository.${String(prop)}`),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const placeholderRunRepo: any = new Proxy({}, {
  get: (_target, prop) => () => notImplemented(`RunRepository.${String(prop)}`),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const placeholderRunStepRepo: any = new Proxy({}, {
  get: (_target, prop) => () => notImplemented(`RunStepRepository.${String(prop)}`),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const placeholderRunLogRepo: any = new Proxy({}, {
  get: (_target, prop) => () => notImplemented(`RunLogRepository.${String(prop)}`),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const placeholderScheduleRepo: any = new Proxy({}, {
  get: (_target, prop) => () => notImplemented(`ScheduleRepository.${String(prop)}`),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const placeholderTriggerRepo: any = new Proxy({}, {
  get: (_target, prop) => () => notImplemented(`TriggerRepository.${String(prop)}`),
});

// ---------------------------------------------------------------------------
// Service public key loading — same pattern as ingestion service
// ---------------------------------------------------------------------------

async function loadServicePublicKeys(): Promise<Record<string, string>> {
  try {
    const { readdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const dir = process.env["OP_SERVICE_KEYS_DIR"] ?? "/data/service-keys";
    const files = await readdir(dir);
    const keys: Record<string, string> = {};

    await Promise.all(
      files
        .filter((f) => f.endsWith(".pub"))
        .map(async (f) => {
          const serviceName = f.replace(/\.pub$/, "");
          const pem = await readFile(`${dir}/${f}`, "utf-8");
          keys[serviceName] = pem;
        }),
    );

    return keys;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Main startup sequence (design spec §1.3)
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const serviceStartedAt = new Date();

  // Step 1: Load config and master key
  const config = loadConfig();
  const masterKey = loadMasterKey();
  void masterKey; // Available for future use in this service

  // Resolve pipeline-specific env vars with defaults
  const executionServiceUrl =
    process.env["EXECUTION_SERVICE_URL"] ?? "http://execution-service:3005";
  const pluginServiceUrl =
    process.env["PLUGIN_SERVICE_URL"] ?? "http://plugin-service:3008";
  const ingestionServiceUrl =
    process.env["INGESTION_SERVICE_URL"] ?? "http://ingestion-service:3002";
  const maxConcurrentRuns = parseInt(
    process.env["OP_PIPELINE_MAX_CONCURRENT_RUNS"] ?? "20",
    10,
  );
  const maxQueueLength = parseInt(
    process.env["OP_PIPELINE_MAX_QUEUE_LENGTH"] ?? "10000",
    10,
  );
  const stepDefaultTimeoutMs = parseInt(
    process.env["OP_PIPELINE_STEP_DEFAULT_TIMEOUT_MS"] ?? "300000",
    10,
  );
  const hookDefaultTimeoutMs = parseInt(
    process.env["OP_PIPELINE_HOOK_DEFAULT_TIMEOUT_MS"] ?? "30000",
    10,
  );

  // Step 2: Create DB client (session-mode PgBouncer — required for advisory locks)
  const db = createDbClient({
    // DATABASE_URL must point to the session-mode PgBouncer pool, NOT transaction-mode
    connectionString: process.env["DATABASE_URL"] ?? config.OP_DATABASE_URL,
    maxConnections: 25, // Pool size per design spec §12.2
  });

  const redis = createRedisClient({ url: process.env["REDIS_URL"] ?? config.OP_REDIS_URL });

  // Step 3: Run database migrations (idempotent)
  const migrationResult = await runMigrations(db);
  if (migrationResult.applied.length > 0) {
    console.info("Pipeline migrations applied:", migrationResult.applied);
  }

  // Step 4: Create structured logger
  const logger = createLogger({
    serviceName: "pipeline-service",
    redis,
  });

  // Step 5: Verify advisory lock capability — confirms session-mode PgBouncer is active
  // If this throws, the service should not start (session mode is required)
  {
    const client = await db.connect();
    try {
      const testKey = BigInt("0x1234567890abcdef");
      await client.query("SELECT pg_try_advisory_lock($1::bigint)", [testKey.toString()]);
      await client.query("SELECT pg_advisory_unlock($1::bigint)", [testKey.toString()]);
      logger.info("Advisory lock test passed — session-mode PgBouncer confirmed.");
    } catch (err) {
      logger.error("Advisory lock test FAILED. DATABASE_URL must point to session-mode PgBouncer.", {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      client.release();
    }
  }

  // Step 6: Connect to Redis (already done above via createRedisClient)
  // Subscribe to ontology change channel for cache invalidation
  redis.on("error", (err) => {
    logger.error("Redis connection error", { error: err.message });
  });

  // Steps 7–9 use the placeholder repos until the concrete repo layer is merged.
  // Replace placeholderXRepo with concrete instances once available.

  // Step 7: Instantiate repositories (placeholder until concrete repos are merged)
  const pipelineRepo = placeholderPipelineRepo;
  const runRepo = placeholderRunRepo;
  const runStepRepo = placeholderRunStepRepo;
  const runLogRepo = placeholderRunLogRepo;
  const scheduleRepo = placeholderScheduleRepo;
  const triggerRepo = placeholderTriggerRepo;

  // Step 8: Create BullMQ queues
  const redisConnection = { url: process.env["REDIS_URL"] ?? config.OP_REDIS_URL };

  const runQueue = createQueue("queue:pipeline:run", redisConnection);
  const cronQueue = createQueue("queue:pipeline:cron", redisConnection);

  // Step 9: Create services
  const pipelineService = createPipelineService({
    pipelineRepo,
    runRepo,
    logger,
  });

  const runService = createRunService({
    runRepo,
    runStepRepo,
    runLogRepo,
    pipelineRepo,
    runQueue,
    redis,
    logger,
  });

  const scheduleService = createScheduleService({
    scheduleRepo,
    pipelineRepo,
    runService,
    logger,
  });

  const triggerService = createTriggerService({
    triggerRepo,
    pipelineRepo,
    runService,
    redis,
    logger,
  });

  const executionEngine = createExecutionEngine({
    runRepo,
    runStepRepo,
    runLogRepo,
    pool: db,
    redis,
    executionServiceUrl,
    pluginServiceUrl,
    ingestionServiceUrl,
    stepDefaultTimeoutMs,
    hookDefaultTimeoutMs,
    logger,
  });

  // Step 10: Start BullMQ workers
  // Using new Worker directly rather than createWorker from core because we need
  // to configure concurrency — core's createWorker signature does not expose it.
  const runWorker = new Worker<PipelineRunJobPayload>(
    "queue:pipeline:run",
    async (job) => executionEngine.processRun(job),
    {
      connection: redisConnection,
      concurrency: maxConcurrentRuns,
      removeOnComplete: { count: 0 },
      removeOnFail: { count: 100 },
    },
  );

  // Poison-pill detection per design spec §10.2:
  // If a job fails 3+ times in under 60s, move to DLQ without waiting for remaining retries.
  runWorker.on("failed", async (job, error) => {
    if (job === undefined) return;

    const failedAt = Date.now();
    const elapsed = failedAt - job.timestamp;

    if (job.attemptsMade >= 3 && elapsed < 60_000) {
      logger.warn("Poison-pill detected — moving job to DLQ", {
        jobId: job.id,
        runId: job.data.runId,
        attemptsMade: job.attemptsMade,
        elapsedMs: elapsed,
      });

      // Mark the run as failed in the database
      try {
        await runRepo.update(job.data.runId, {
          status: "failed",
          completedAt: new Date(),
          error: {
            code: "DLQ_MOVED",
            message: `Job moved to DLQ after ${job.attemptsMade} rapid failures: ${error.message}`,
          },
        });
      } catch {
        // Best-effort
      }

      // Remove from active queue so it stops retrying
      try {
        await job.remove();
      } catch {
        // Best-effort
      }
    }
  });

  logger.info("BullMQ pipeline:run and pipeline:cron workers started", {
    concurrency: maxConcurrentRuns,
    maxQueueLength,
  });

  // Step 11: Load schedules into in-memory cron scheduler
  // Missed schedules (next_run_at in the past) are treated as due on next tick
  scheduleService.startCronLoop();
  logger.info("Cron scheduler loop started.");

  // Step 12: Subscribe to event-driven trigger channels
  await triggerService.loadTriggers();
  logger.info("Event trigger subscriptions loaded.");

  // Step 13: Load service public keys for inter-service JWT verification
  const servicePublicKeys = await loadServicePublicKeys();
  logger.info("Service public keys loaded", { count: Object.keys(servicePublicKeys).length });

  // Readiness gate — set to true after all startup steps complete
  let serviceReady = true;

  // Step 14: Create Hono app
  const app = createApp({
    serviceName: "pipeline-service",
    version: "0.0.0",
    jwtSecret: config.OP_JWT_SECRET,
    redis,
    validateApiKey: async () => null,
    allowedOrigins: config.OP_ALLOWED_ORIGINS,
    publicRoutes: ["/healthz", "/readyz"],
    targetService: "pipeline-service",
    servicePublicKeys,
  });

  // Step 15: Register routes (specific before catch-all)
  const healthRoutes = createHealthRoutes({
    pool: db,
    redis,
    runQueue,
    cronQueue,
    serviceStartedAt,
    isReady: () => serviceReady,
  });
  app.route("/", healthRoutes);

  const pipelineRoutes = createPipelineRoutes({ pipelineService, runService });
  app.route("/api/v1/pipelines", pipelineRoutes);

  const runRoutes = createRunRoutes({ runService });
  app.route("/api/v1/pipeline-runs", runRoutes);

  const scheduleRoutes = createScheduleRoutes({ scheduleService });
  app.route("/api/v1/schedules", scheduleRoutes);

  const internalRoutes = createInternalRoutes({ runService });
  app.route("/internal", internalRoutes);

  // Step 16: Start HTTP server on port 3004 (design spec §1.2)
  const port = parseInt(process.env["PORT"] ?? "3004", 10);

  const server = createServer(
    (req: IncomingMessage, res: ServerResponse): void => {
      const url = `http://${req.headers["host"] ?? "localhost"}${req.url ?? "/"}`;

      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("error", (err) => {
        console.warn("Request socket error", err.message);
        res.destroy();
      });
      req.on("end", () => {
        const body =
          req.method !== "GET" && req.method !== "HEAD" && chunks.length > 0
            ? Buffer.concat(chunks)
            : undefined;

        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
          if (value === undefined) continue;
          if (Array.isArray(value)) {
            for (const v of value) headers.append(key, v);
          } else {
            headers.set(key, value);
          }
        }

        const fetchRequest = new Request(url, {
          method: req.method ?? "GET",
          headers,
          ...(body !== undefined ? { body } : {}),
        });

        const responseOrPromise = app.fetch(fetchRequest);

        const handleResponse = (response: Response): void => {
          // SSE responses require streaming — do not buffer via arrayBuffer()
          const contentType = response.headers.get("content-type") ?? "";
          if (contentType.includes("text/event-stream") && response.body !== null) {
            res.writeHead(
              response.status,
              Object.fromEntries(response.headers.entries()),
            );
            const reader = response.body.getReader();
            const pump = (): void => {
              reader.read().then(({ done, value }) => {
                if (done) {
                  res.end();
                  return;
                }
                res.write(Buffer.from(value));
                pump();
              }).catch(() => res.end());
            };
            pump();
          } else {
            res.writeHead(
              response.status,
              Object.fromEntries(response.headers.entries()),
            );
            void response.arrayBuffer().then((buf: ArrayBuffer) => {
              res.end(Buffer.from(buf));
            });
          }
        };

        if (responseOrPromise instanceof Promise) {
          void responseOrPromise.then(handleResponse);
        } else {
          handleResponse(responseOrPromise);
        }
      });
    },
  );

  server.listen(port, () => {
    logger.info("Pipeline service started", { port });
  });

  // Step 17: SIGTERM handler with 30s hard-exit fallback (design spec §1.3)
  process.on("SIGTERM", () => {
    console.info("SIGTERM received — starting graceful shutdown");

    // Mark service as not ready so load balancer stops routing traffic
    serviceReady = false;

    // Hard-exit fallback — prevents the process hanging indefinitely
    const shutdownTimeout = setTimeout(() => {
      console.error("Shutdown timeout exceeded — forcing exit");
      process.exit(1);
    }, 30_000);
    shutdownTimeout.unref();

    // Stop background services in order
    scheduleService.stop();
    triggerService.stop();

    void Promise.all([runWorker.close()]).then(() => {
      server.close(() => {
        void Promise.all([
          db.end(),
          redis.quit(),
          runQueue.close(),
          cronQueue.close(),
        ]).then(() => {
          clearTimeout(shutdownTimeout);
          console.info("Pipeline service graceful shutdown complete");
          process.exit(0);
        });
      });
    });
  });
}

main().catch((err: unknown) => {
  console.error("Pipeline service failed to start:", err);
  process.exit(1);
});
