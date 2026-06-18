import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Worker } from "bullmq";
import {
  loadConfig,
  pipelineConfigSchema,
  createDbClient,
  createRedisClient,
  createLogger,
  createApp,
  loadMasterKey,
  createQueue,
  createServiceTokenSigner,
  loadServicePrivateKey,
  readPackageVersion,
} from "@oneplatform/core";
import { runMigrations } from "./db/migrate.js";
import {
  createPipelineService,
  createRunService,
  createScheduleService,
  createTriggerService,
  createExecutionEngine,
  createExecutionTracker,
  createApprovalService,
} from "./services/index.js";
import type {
  PipelineRunJobPayload,
} from "./services/index.js";
import {
  PipelineRepository,
  PipelineVersionRepository,
  RunRepository,
  RunStepRepository,
  RunLogRepository,
  ScheduleRepository,
  TriggerRepository,
} from "./repositories/index.js";
import {
  createHealthRoutes,
  createPipelineRoutes,
  createRunRoutes,
  createScheduleRoutes,
  createInternalRoutes,
  createExecutionRoutes,
} from "./routes/index.js";

export interface ServiceApp {
  app: ReturnType<typeof createApp>;
  cleanup: () => Promise<void>;
}

export interface PipelineConfig {
  databaseUrl: string;
  redisUrl: string;
  jwtSecret: string;
  /** Raw key bytes returned by loadMasterKey() */
  masterKey: Buffer;
  allowedOrigins: string[];
  executionServiceUrl: string;
  pluginServiceUrl: string;
  ingestionServiceUrl: string;
  /** When false, BullMQ workers and cron scheduler are not started. Defaults to true. */
  startWorkers?: boolean;
}

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
// Factory — wires the full service graph (design spec §1.3)
// ---------------------------------------------------------------------------

export async function createServiceApp(config: PipelineConfig): Promise<ServiceApp> {
  const startWorkers = config.startWorkers ?? true;
  const serviceStartedAt = new Date();
  const version = readPackageVersion(import.meta.url);

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

  // Create DB client (session-mode PgBouncer — required for advisory locks)
  // DATABASE_URL must point to the session-mode pool, NOT transaction-mode
  const db = createDbClient({
    connectionString: config.databaseUrl,
    maxConnections: 25, // Pool size per design spec §12.2
  });

  const redis = createRedisClient({ url: config.redisUrl });

  // Run database migrations (idempotent)
  const migrationResult = await runMigrations(db);
  if (migrationResult.applied.length > 0) {
    console.info("Pipeline migrations applied:", migrationResult.applied);
  }

  const logger = createLogger({
    serviceName: "pipeline-service",
    redis,
  });

  // Verify advisory lock capability — confirms session-mode PgBouncer is active.
  // If this throws, the service must not start (session mode is required for
  // advisory locks used by the execution engine to prevent duplicate runs).
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

  // Subscribe to ontology change channel for cache invalidation
  redis.on("error", (err) => {
    logger.error("Redis connection error", { error: err.message });
  });

  // Repositories
  const pipelineRepo = new PipelineRepository(db);
  const pipelineVersionRepo = new PipelineVersionRepository(db);
  const runRepo = new RunRepository(db);
  const runStepRepo = new RunStepRepository(db);
  const runLogRepo = new RunLogRepository(db);
  const scheduleRepo = new ScheduleRepository(db);
  const triggerRepo = new TriggerRepository(db);

  // BullMQ queues
  const redisConnection = { url: config.redisUrl };

  const runQueue = createQueue("queue:pipeline:run", redisConnection);
  const cronQueue = createQueue("queue:pipeline:cron", redisConnection);

  // Services
  const pipelineService = createPipelineService({
    pipelineRepo,
    versionRepo: pipelineVersionRepo,
    scheduleRepo,
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
    redisUrl: config.redisUrl,
    logger,
  });

  const serviceKeysDir = process.env["OP_SERVICE_KEYS_DIR"] ?? "/data/service-keys";
  const privateKeyPem = await loadServicePrivateKey("pipeline-service", serviceKeysDir);
  const serviceTokenSigner = await createServiceTokenSigner("pipeline-service", privateKeyPem);

  // Execution tracker is created before the engine so it can be passed into
  // the engine for real-time step-event emission. It is also passed to the
  // execution routes for the SSE and REST status endpoints.
  const executionTracker = createExecutionTracker();

  const executionEngine = createExecutionEngine({
    runRepo,
    runStepRepo,
    runLogRepo,
    pool: db,
    redis,
    executionServiceUrl: config.executionServiceUrl,
    pluginServiceUrl: config.pluginServiceUrl,
    ingestionServiceUrl: config.ingestionServiceUrl,
    stepDefaultTimeoutMs,
    hookDefaultTimeoutMs,
    logger,
    serviceTokenSigner,
    executionTracker,
  });

  // Workers are optional so tests can wire the app without consuming Redis connections
  let runWorker: Worker<PipelineRunJobPayload> | undefined;

  if (startWorkers) {
    // Using new Worker directly rather than createWorker from core because we need
    // to configure concurrency — core's createWorker signature does not expose it.
    runWorker = new Worker<PipelineRunJobPayload>(
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
          await runRepo.updateStatus(job.data.runId, {
            status: "failed",
            completed_at: new Date(),
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

    // Load schedules into in-memory cron scheduler.
    // Missed schedules (next_run_at in the past) are treated as due on next tick.
    scheduleService.startCronLoop();
    logger.info("Cron scheduler loop started.");

    // Subscribe to event-driven trigger channels
    await triggerService.loadTriggers();
    logger.info("Event trigger subscriptions loaded.");
  }

  const servicePublicKeys = await loadServicePublicKeys();
  logger.info("Service public keys loaded", { count: Object.keys(servicePublicKeys).length });

  // Readiness gate — set to true after all startup steps complete
  let serviceReady = true;

  const app = createApp({
    serviceName: "pipeline-service",
    version,
    jwtSecret: config.jwtSecret,
    redis,
    validateApiKey: async () => null,
    allowedOrigins: config.allowedOrigins,
    publicRoutes: ["/healthz", "/readyz"],
    targetService: "pipeline-service",
    servicePublicKeys,
  });

  // Route registration — specific before catch-all
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

  // Execution status routes are mounted under the pipelines prefix so the
  // pipelineId path param is available at /api/v1/pipelines/:pipelineId/executions.
  const executionRoutes = createExecutionRoutes({ executionTracker, pipelineService });
  app.route("/api/v1/pipelines/:pipelineId/executions", executionRoutes);

  const runRoutes = createRunRoutes({ runService });
  app.route("/api/v1/pipeline-runs", runRoutes);

  const scheduleRoutes = createScheduleRoutes({ scheduleService });
  app.route("/api/v1/schedules", scheduleRoutes);

  const internalRoutes = createInternalRoutes({ runService, triggerRepo });
  app.route("/internal", internalRoutes);

  const cleanup = async (): Promise<void> => {
    serviceReady = false;
    if (startWorkers) {
      scheduleService.stop();
      triggerService.stop();
      await runWorker?.close();
    }
    await Promise.all([
      db.end(),
      redis.quit(),
      runQueue.close(),
      cronQueue.close(),
    ]);
  };

  return { app, cleanup };
}

// ---------------------------------------------------------------------------
// Main startup sequence (design spec §1.3)
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const config = loadConfig(pipelineConfigSchema);
  const masterKey = loadMasterKey();
  void masterKey; // Available for future use in this service

  const { app, cleanup } = await createServiceApp({
    // DATABASE_URL overrides OP_DATABASE_URL to allow pointing at the
    // session-mode PgBouncer pool specifically required for advisory locks
    databaseUrl: process.env["DATABASE_URL"] ?? config.OP_DATABASE_URL,
    redisUrl: process.env["REDIS_URL"] ?? config.OP_REDIS_URL,
    jwtSecret: config.OP_JWT_SECRET,
    masterKey,
    allowedOrigins: config.OP_ALLOWED_ORIGINS,
    executionServiceUrl: process.env["EXECUTION_SERVICE_URL"] ?? "http://execution-service:3005",
    pluginServiceUrl: process.env["PLUGIN_SERVICE_URL"] ?? "http://plugin-service:3008",
    ingestionServiceUrl: process.env["INGESTION_SERVICE_URL"] ?? "http://ingestion-service:3002",
  });

  // Start HTTP server on port 3004 (design spec §1.2)
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
    console.info(`Pipeline service started on port ${port}`);
  });

  // SIGTERM handler with 30s hard-exit fallback (design spec §1.3)
  process.on("SIGTERM", () => {
    console.info("SIGTERM received — starting graceful shutdown");

    // Hard-exit fallback — prevents the process hanging indefinitely
    const shutdownTimeout = setTimeout(() => {
      console.error("Shutdown timeout exceeded — forcing exit");
      process.exit(1);
    }, 30_000);
    shutdownTimeout.unref();

    server.close(() => {
      void cleanup().then(() => {
        clearTimeout(shutdownTimeout);
        console.info("Pipeline service graceful shutdown complete");
        process.exit(0);
      });
    });
  });
}

main().catch((err: unknown) => {
  console.error("Pipeline service failed to start:", err);
  process.exit(1);
});
