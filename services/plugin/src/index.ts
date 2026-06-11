import { readFile, readdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Redis } from "ioredis";
import {
  loadConfig,
  createDbClient,
  createLogger,
  createApp,
  loadMasterKey,
  createEventPublisher,
} from "@oneplatform/core";
import { runMigrations } from "./db/migrate.js";
import {
  PluginRepository,
  InstanceRepository,
  HookRepository,
  CacheRepository,
} from "./repositories/index.js";
import {
  createBundleService,
  createConnectorRegistrationService,
  createHookService,
  createPluginService,
  createInstanceService,
  createUpgradeService,
} from "./services/index.js";
import {
  createHealthRoutes,
  createPluginRoutes,
  createInstanceRoutes,
  createHookRoutes,
  createInternalRoutes,
} from "./routes/index.js";

// ---------------------------------------------------------------------------
// Load service public keys for inter-service JWT verification
// ---------------------------------------------------------------------------

async function loadServicePublicKeys(): Promise<Record<string, string>> {
  try {
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
        })
    );

    return keys;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Startup retry helper — exponential backoff, max attempts
// ---------------------------------------------------------------------------

async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  label: string,
  maxMs: number
): Promise<T> {
  const startAt = Date.now();
  let attempt = 0;

  while (true) {
    try {
      return await fn();
    } catch (err) {
      const elapsed = Date.now() - startAt;
      if (elapsed >= maxMs) {
        throw new Error(
          `${label} startup check failed after ${elapsed}ms: ${String(err)}`
        );
      }
      const delay = Math.min(1000 * Math.pow(2, attempt), 10_000);
      console.warn(`${label} not ready (attempt ${attempt + 1}), retrying in ${delay}ms...`);
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
      attempt++;
    }
  }
}

// ---------------------------------------------------------------------------
// Main startup sequence — design spec §1.3
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const serviceStartedAt = new Date();

  // Step 1: Load config and master key.
  const config = loadConfig();
  const masterKey = loadMasterKey();
  void masterKey; // Reserved for future field-level config encryption (spec §15.4)

  const databaseUrl = process.env["DATABASE_URL"] ?? config.OP_DATABASE_URL;
  const redisUrl = process.env["REDIS_URL"] ?? config.OP_REDIS_URL;
  const s3Endpoint = process.env["OP_S3_ENDPOINT"] ?? "http://minio:9000";
  const s3AccessKey = process.env["OP_S3_ACCESS_KEY"] ?? "";
  const s3SecretKey = process.env["OP_S3_SECRET_KEY"] ?? "";
  const s3Region = process.env["OP_S3_REGION"] ?? "us-east-1";
  const bundleBucket = process.env["OP_PLUGIN_BUNDLE_BUCKET"] ?? "plugin-bundles";
  const executionServiceUrl =
    process.env["EXECUTION_SERVICE_URL"] ?? "http://execution-service:3005";
  const ingestionServiceUrl =
    process.env["INGESTION_SERVICE_URL"] ?? "http://ingestion-service:3002";
  const serviceToken = process.env["OP_SERVICE_TOKEN"] ?? "";
  const retentionDays = parseInt(
    process.env["OP_PLUGIN_BUNDLE_RETENTION_DAYS"] ?? "7",
    10
  );
  const drainGraceSeconds = parseInt(
    process.env["OP_PLUGIN_DRAIN_GRACE_SECONDS"] ?? "60",
    10
  );

  // Step 2: Create DB pool (transaction-mode PgBouncer — spec §2).
  const db = createDbClient({
    connectionString: databaseUrl,
    maxConnections: 10,
  });

  // Step 3: Wait for PostgreSQL.
  await retryWithBackoff(
    () => db.query("SELECT 1"),
    "PostgreSQL",
    60_000
  );
  console.info("PostgreSQL connection verified.");

  // Step 4: Run database migrations — fatal on failure (spec §1.3).
  const migrationResult = await runMigrations(db);
  if (migrationResult.applied.length > 0) {
    console.info("Plugin migrations applied:", migrationResult.applied);
  }

  // Step 5: Create Redis client.
  const redis = new Redis(redisUrl, {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
  });

  await retryWithBackoff(
    async () => {
      await redis.connect();
      await redis.ping();
    },
    "Redis",
    30_000
  );
  console.info("Redis connection verified.");

  redis.on("error", (err) => {
    console.error("Redis connection error:", err.message);
  });

  // Step 6: Create structured logger.
  const logger = createLogger({
    serviceName: "plugin-service",
    redis,
  });

  // Step 7: Create bundle service and verify MinIO.
  const bundleService = createBundleService({
    endpoint: s3Endpoint,
    accessKey: s3AccessKey,
    secretKey: s3SecretKey,
    region: s3Region,
    bucket: bundleBucket,
    logger,
  });

  await retryWithBackoff(
    () => bundleService.ping().then((ok) => {
      if (!ok) throw new Error("MinIO ping returned false");
    }),
    "MinIO",
    60_000
  );
  console.info("MinIO connection verified.");

  // Ensure bucket exists and lifecycle policy is applied (idempotent).
  await bundleService.ensureBucket();
  logger.info("plugin-bundles bucket ready.");

  // Step 8: Create repositories.
  const pluginRepo = new PluginRepository(db);
  const instanceRepo = new InstanceRepository(db);
  const hookRepo = new HookRepository(db);
  const cacheRepo = new CacheRepository(redis);

  // Step 9: Create event publisher.
  const eventPublisher = createEventPublisher({ redis });

  // Step 10: Create connector registration service.
  const connectorService = createConnectorRegistrationService({
    ingestionServiceUrl,
    serviceToken,
    logger,
  });

  // Step 11: Create hook service.
  const hookService = createHookService({ hookRepo, logger });

  // Step 12: Create plugin service.
  const pluginService = createPluginService({
    pool: db,
    pluginRepo,
    instanceRepo,
    hookRepo,
    bundleService,
    connectorService,
    hookService,
    redis,
    executionServiceUrl,
    serviceToken,
    logger,
    eventPublisher,
    bundleBucket,
    retentionDays,
  });

  // Step 13: Create instance service.
  const instanceService = createInstanceService({
    pool: db,
    pluginRepo,
    instanceRepo,
    hookRepo,
    connectorService,
    hookService,
    executionServiceUrl,
    serviceToken,
    drainGraceSeconds,
    logger,
    eventPublisher,
  });

  // Step 14: Create upgrade service.
  const upgradeService = createUpgradeService({
    pool: db,
    pluginRepo,
    instanceRepo,
    hookRepo,
    hookService,
    executionServiceUrl,
    serviceToken,
    logger,
    eventPublisher,
  });

  // Step 15: Start bundle cleanup worker (runs every hour, spec §10.4).
  const cleanupInterval = setInterval(
    () => void pluginService.cleanupExpiredBundles(),
    60 * 60 * 1000
  );
  cleanupInterval.unref();

  // Step 16: Load service public keys.
  const servicePublicKeys = await loadServicePublicKeys();
  logger.info("Service public keys loaded", {
    count: Object.keys(servicePublicKeys).length,
  });

  // Readiness gate — set true after all startup steps complete.
  let serviceReady = true;

  // Step 17: Create Hono app.
  const app = createApp({
    serviceName: "plugin-service",
    version: "0.0.0",
    jwtSecret: config.OP_JWT_SECRET,
    redis,
    validateApiKey: async () => null,
    allowedOrigins: config.OP_ALLOWED_ORIGINS,
    publicRoutes: ["/health/live", "/health/ready"],
    targetService: "plugin-service",
    servicePublicKeys,
  });

  // Step 18: Register routes — specific before catch-all.
  const healthRoutes = createHealthRoutes({
    pool: db,
    redis,
    bundleService,
    serviceStartedAt,
    isReady: () => serviceReady,
  });
  app.route("/", healthRoutes);

  const pluginRoutes = createPluginRoutes({ pluginService });
  app.route("/api/v1/plugins", pluginRoutes);

  const instanceRoutes = createInstanceRoutes({ instanceService });
  app.route("/api/v1/plugins", instanceRoutes);

  const hookRoutes = createHookRoutes({ hookService });
  app.route("/api/v1/plugins", hookRoutes);

  const internalRoutes = createInternalRoutes({
    bundleService,
    hookService,
    cacheRepo,
    instanceRepo,
    pluginRepo,
    upgradeService,
  });
  app.route("/internal", internalRoutes);

  // Step 19: Start HTTP server on port 3008 (spec §1.1).
  const port = parseInt(process.env["PORT"] ?? "3008", 10);

  const server = createServer(
    (req: IncomingMessage, res: ServerResponse): void => {
      const url = `http://${req.headers["host"] ?? "localhost"}${req.url ?? "/"}`;

      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("error", (err) => {
        logger.warn("Request socket error", { error: err.message });
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
          const contentType = response.headers.get("content-type") ?? "";

          // Streaming responses (bundle delivery) must not be buffered.
          if (
            contentType.includes("application/octet-stream") &&
            response.body !== null
          ) {
            res.writeHead(
              response.status,
              Object.fromEntries(response.headers.entries())
            );
            const reader = response.body.getReader();
            const pump = (): void => {
              reader
                .read()
                .then(({ done, value }) => {
                  if (done) {
                    res.end();
                    return;
                  }
                  res.write(Buffer.from(value));
                  pump();
                })
                .catch(() => res.end());
            };
            pump();
          } else {
            res.writeHead(
              response.status,
              Object.fromEntries(response.headers.entries())
            );
            void response.arrayBuffer().then((buf) => {
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
    }
  );

  server.listen(port, () => {
    logger.info("Plugin service started", { port });
  });

  // Step 20: SIGTERM handler with 30s hard-exit fallback.
  process.on("SIGTERM", () => {
    console.info("SIGTERM received — starting graceful shutdown");
    serviceReady = false;

    const shutdownTimeout = setTimeout(() => {
      console.error("Shutdown timeout exceeded — forcing exit");
      process.exit(1);
    }, 30_000);
    shutdownTimeout.unref();

    clearInterval(cleanupInterval);

    server.close(() => {
      void Promise.all([db.end(), redis.quit()]).then(() => {
        clearTimeout(shutdownTimeout);
        console.info("Plugin service graceful shutdown complete");
        process.exit(0);
      });
    });
  });
}

main().catch((err: unknown) => {
  console.error("Plugin service failed to start:", err);
  process.exit(1);
});
