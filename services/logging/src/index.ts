/**
 * Logging Service entry point.
 *
 * Startup sequence (L2 design §1.4):
 *  1. Load and validate all OP_* environment variables
 *  2. Create Postgres pool and Redis clients (main + subscriber)
 *  3. Run Postgres migrations (idempotent)
 *  4. Ensure partitions exist for current and next month
 *  5. Create logger and event publisher
 *  6. Instantiate repositories
 *  7. Start pub/sub listener (PSUBSCRIBE logs:*)
 *  8. Start BullMQ audit worker
 *  9. Start retention scheduler (daily 02:00 UTC)
 * 10. Start partition scheduler (monthly 1st 00:05 UTC)
 * 11. Load peer service public keys for service-to-service auth
 * 12. Create Hono app with standard middleware stack
 * 13. Register all route groups
 * 14. Start HTTP server on port 3007 (Node.js adapter wrapping Hono app.fetch)
 *
 * Graceful shutdown (SIGTERM):
 *  - Stop workers, stop schedulers
 *  - Flush in-flight batch
 *  - Close HTTP server, DB pool, and Redis connections
 */

import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  loadConfig,
  loggingConfigSchema,
  createDbClient,
  createRedisClient,
  createLogger,
  createEventPublisher,
  createApp,
  loadMasterKey,
  readPackageVersion,
} from "@oneplatform/core";
import { runMigrations } from "./db/migrate.js";
import {
  LogEventRepository,
  AuditEventRepository,
  FieldAuditRepository,
} from "./repositories/index.js";
import {
  BatchAccumulator,
  IngestionService,
  AuditService,
  RetentionService,
  FieldAuditService,
} from "./services/index.js";
import { registerRoutes } from "./routes/index.js";

// ---------------------------------------------------------------------------
// Load peer service public keys for service-to-service auth
// ---------------------------------------------------------------------------

async function loadServicePublicKeys(dir: string): Promise<Record<string, string>> {
  try {
    const { readdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const files = await readdir(dir);
    const keys: Record<string, string> = {};

    await Promise.all(
      files
        .filter((f) => f.endsWith(".pub"))
        .map(async (f) => {
          const serviceName = f.replace(/\.pub$/, "");
          const pem = await readFile(join(dir, f), "utf-8");
          keys[serviceName] = pem;
        })
    );

    return keys;
  } catch {
    // Keys may be absent in development; the service starts but service calls
    // will fail auth until keys are provisioned.
    return {};
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ServiceApp {
  app: ReturnType<typeof createApp>;
  cleanup: () => Promise<void>;
}

export interface LoggingConfig {
  databaseUrl: string;
  redisUrl: string;
  jwtSecret: string;
  masterKey: Buffer;
  allowedOrigins: string[];
  /** Directory containing peer service public key files. Defaults to /data/service-keys. */
  serviceKeysDir?: string;
  /**
   * Whether to start background jobs (retention scheduler, partition scheduler,
   * pub/sub listener, audit worker). Defaults to true.
   * Set to false in tests to avoid background timers interfering with cleanup.
   */
  startBackgroundJobs?: boolean;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export async function createServiceApp(config: LoggingConfig): Promise<ServiceApp> {
  const serviceKeysDir = config.serviceKeysDir ?? "/data/service-keys";
  const version = readPackageVersion(import.meta.url);
  // startBackgroundJobs defaults to true so production behaviour is unchanged
  // when callers omit the flag.
  const startBackgroundJobs = config.startBackgroundJobs !== false;

  // masterKey is loaded to satisfy the platform startup contract even though
  // the Logging Service does not encrypt data at rest.
  void config.masterKey;

  // Step 1: Create infrastructure clients.
  // Two Redis connections: one for general use (BullMQ, health checks),
  // one dedicated to pub/sub (ioredis cannot issue regular commands once
  // PSUBSCRIBE is issued on a connection).
  const db = createDbClient({
    connectionString: config.databaseUrl,
    maxConnections: 30,
  });

  const redis = createRedisClient({ url: config.redisUrl });
  const redisSubscriber = createRedisClient({ url: config.redisUrl });

  // Step 2: Run database migrations.
  const migrationResult = await runMigrations(db);
  if (migrationResult.applied.length > 0) {
    console.info("Logging migrations applied:", migrationResult.applied);
  }

  // Step 3: Ensure partitions for current and next month exist.
  // This runs synchronously so the first batch insert always has a partition.
  const retentionService = new RetentionService(db);
  await retentionService.ensurePartitions();

  // Step 4: Create logger and event publisher.
  const logger = createLogger({
    serviceName: "logging-service",
    redis,
  });

  const events = createEventPublisher({ redis });
  void events; // Logging Service is a pure consumer; events are unused here

  // Step 5: Instantiate repositories.
  const logEventRepository = new LogEventRepository(db);
  const auditEventRepository = new AuditEventRepository(db);
  const fieldAuditRepository = new FieldAuditRepository(db);
  const fieldAuditService = new FieldAuditService(fieldAuditRepository);

  // Step 6: Start pub/sub listener — PSUBSCRIBE logs:* on the dedicated
  // subscriber connection so the main Redis connection remains usable.
  const accumulator = new BatchAccumulator(logEventRepository);
  const ingestionService = new IngestionService(accumulator);

  let auditWorker: Awaited<ReturnType<AuditService["startAuditWorker"]>> | null = null;
  const auditService = new AuditService(auditEventRepository);

  if (startBackgroundJobs) {
    ingestionService.startPubSubListener(redisSubscriber);
    logger.info("Pub/sub listener started");

    // Pass the Redis URL string rather than the ioredis instance to avoid the
    // ioredis version mismatch between logging@5.11.1 and bullmq@5.x's ioredis.
    auditWorker = auditService.startAuditWorker(config.redisUrl);
    logger.info("Audit worker started");

    retentionService.startRetentionScheduler();
    retentionService.startPartitionScheduler();
  }

  // Step 7: Load peer service public keys.
  const servicePublicKeys = await loadServicePublicKeys(serviceKeysDir);

  // Step 8: Create the Hono app with the standard middleware stack.
  const app = createApp({
    serviceName: "logging-service",
    version,
    jwtSecret: config.jwtSecret,
    redis,
    // The Logging Service validates user JWTs for /api/v1/* routes but does
    // not issue its own API keys — pass a no-op validator here.
    validateApiKey: async () => null,
    allowedOrigins: config.allowedOrigins,
    publicRoutes: ["/healthz", "/readyz"],
    targetService: "logging-service",
    servicePublicKeys,
  });

  // Step 9: Register all route groups.
  registerRoutes(app, {
    db,
    redis,
    serviceName: "logging-service",
    version,
    logEventRepository,
    auditEventRepository,
    fieldAuditService,
    batchAccumulator: accumulator,
    servicePublicKeys,
  });

  const cleanup = async (): Promise<void> => {
    // Stop schedulers first so no new jobs are triggered during shutdown
    retentionService.stop();

    if (auditWorker !== null) {
      await auditWorker.close();
    }

    // Stop the pub/sub listener and flush any remaining batch to Postgres
    ingestionService.stopPubSubListener();
    await ingestionService.flushBatch();

    await db.end();
    await redis.quit();
    await redisSubscriber.quit();
  };

  return { app, cleanup };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Step 1: Validate configuration — throws loudly on missing required vars.
  const config = loadConfig(loggingConfigSchema);
  const masterKey = loadMasterKey();

  const { app, cleanup } = await createServiceApp({
    databaseUrl: config.OP_DATABASE_URL,
    redisUrl: config.OP_REDIS_URL,
    jwtSecret: config.OP_JWT_SECRET,
    masterKey,
    allowedOrigins: config.OP_ALLOWED_ORIGINS,
  });

  // Step 2: Start HTTP server — Node.js HTTP adapter wrapping Hono app.fetch.
  // Hono's `app.fetch` accepts a web-standard Request and returns a Response;
  // this bridge converts Node's IncomingMessage/ServerResponse to/from that API.
  const port = parseInt(process.env["PORT"] ?? "3007", 10);

  const server = createServer(
    (req: IncomingMessage, res: ServerResponse): void => {
      const url = `http://${req.headers["host"] ?? "localhost"}${req.url ?? "/"}`;

      const chunks: Buffer[] = [];

      // Guard against aborted/malformed connections; without this handler Node
      // would emit an unhandled 'error' event and crash the process.
      req.on("error", (err: Error) => {
        console.error("HTTP request stream error", { error: err.message });
        res.destroy();
      });

      req.on("data", (chunk: Buffer) => chunks.push(chunk));
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
          res.writeHead(
            response.status,
            Object.fromEntries(response.headers.entries())
          );
          void response.arrayBuffer().then((buf: ArrayBuffer) => {
            res.end(Buffer.from(buf));
          });
        };

        if (responseOrPromise instanceof Promise) {
          void responseOrPromise.then(handleResponse);
        } else {
          handleResponse(responseOrPromise);
        }
      });
    }
  );

  server.listen(port, () => {
    console.info(`Logging service started on port ${port}`);
  });

  // ---------------------------------------------------------------------------
  // Graceful shutdown — stop workers, flush batch, close connections
  // ---------------------------------------------------------------------------
  process.on("SIGTERM", () => {
    console.info("SIGTERM received — starting graceful shutdown");

    // Hard kill after 30 s so the container orchestrator does not have to wait
    // for its own SIGKILL timeout. The timer is unreffed so it does not keep
    // the event loop alive if everything shuts down before the deadline.
    setTimeout(() => {
      console.error("Graceful shutdown timed out — forcing exit");
      process.exit(1);
    }, 30_000).unref();

    server.close(() => {
      void cleanup().then(() => {
        console.info("Graceful shutdown complete");
        process.exit(0);
      });
    });
  });
}

main().catch((err: unknown) => {
  console.error("Logging service failed to start:", err);
  process.exit(1);
});
