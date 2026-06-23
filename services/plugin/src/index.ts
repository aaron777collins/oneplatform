import { readFile, readdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Redis } from "ioredis";
import {
  loadConfig,
  pluginConfigSchema,
  createDbClient,
  createLogger,
  createApp,
  loadMasterKey,
  createEventPublisher,
  readPackageVersion,
  setupProcessErrorHandlers,
  createServiceTokenSigner,
  loadServicePrivateKey,
} from "@oneplatform/core";
import { runMigrations } from "./db/migrate.js";
import {
  PluginRepository,
  InstanceRepository,
  HookRepository,
  CacheRepository,
  MarketplaceRepository,
} from "./repositories/index.js";
import {
  createBundleService,
  createConnectorRegistrationService,
  createHookService,
  createPluginService,
  createInstanceService,
  createUpgradeService,
  createMarketplaceService,
} from "./services/index.js";
import {
  createHealthRoutes,
  createPluginRoutes,
  createInstanceRoutes,
  createHookRoutes,
  createInternalRoutes,
  createUpgradeRoutes,
  createMarketplaceRoutes,
} from "./routes/index.js";

// ---------------------------------------------------------------------------
// Load service public keys for inter-service JWT verification
// ---------------------------------------------------------------------------

async function loadServicePublicKeys(dir: string): Promise<Record<string, string>> {
  try {
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
// Public types
// ---------------------------------------------------------------------------

export interface ServiceApp {
  app: ReturnType<typeof createApp>;
  cleanup: () => Promise<void>;
}

export interface PluginConfig {
  databaseUrl: string;
  redisUrl: string;
  jwtSecret: string;
  masterKey: Buffer;
  allowedOrigins: string[];
  s3Endpoint: string;
  s3AccessKey: string;
  s3SecretKey: string;
  s3Region: string;
  bundleBucket: string;
  executionServiceUrl: string;
  ingestionServiceUrl: string;
  retentionDays: number;
  drainGraceSeconds: number;
  serviceKeysDir: string;
  /** When true, the MinIO ping check is skipped (useful in test environments). Defaults to false. */
  skipMinioVerification?: boolean;
  /** When false, BullMQ workers are not started (useful in test environments). Defaults to true. */
  startWorkers?: boolean;
}

// ---------------------------------------------------------------------------
// Factory — wires all dependencies, returns the Hono app and a cleanup fn.
// main() is the only caller in production; tests can call this directly.
// ---------------------------------------------------------------------------

export async function createServiceApp(config: PluginConfig): Promise<ServiceApp> {
  const serviceStartedAt = new Date();
  const version = readPackageVersion(import.meta.url);

  const {
    databaseUrl,
    redisUrl,
    jwtSecret,
    allowedOrigins,
    s3Endpoint,
    s3AccessKey,
    s3SecretKey,
    s3Region,
    bundleBucket,
    executionServiceUrl,
    ingestionServiceUrl,
    retentionDays,
    drainGraceSeconds,
    serviceKeysDir,
    skipMinioVerification = false,
    startWorkers = true,
  } = config;

  // Step 1: Create DB pool (transaction-mode PgBouncer — spec §2).
  const db = createDbClient({
    connectionString: databaseUrl,
    maxConnections: 10,
  });

  // Step 2: Wait for PostgreSQL.
  await retryWithBackoff(
    () => db.query("SELECT 1"),
    "PostgreSQL",
    60_000
  );
  console.info("PostgreSQL connection verified.");

  // Step 3: Run database migrations — fatal on failure (spec §1.3).
  const migrationResult = await runMigrations(db);
  if (migrationResult.applied.length > 0) {
    console.info("Plugin migrations applied:", migrationResult.applied);
  }

  // Step 4: Create Redis client.
  const redis = new Redis(redisUrl, {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
  });

  await retryWithBackoff(
    async () => {
      if (redis.status === "wait") await redis.connect();
      await redis.ping();
    },
    "Redis",
    30_000
  );
  console.info("Redis connection verified.");

  redis.on("error", (err) => {
    console.error("Redis connection error:", err.message);
  });

  // Step 5: Create structured logger.
  const logger = createLogger({
    serviceName: "plugin-service",
    redis,
  });
  setupProcessErrorHandlers(logger);

  // Step 6: Create bundle service and (optionally) verify MinIO.
  const bundleService = createBundleService({
    endpoint: s3Endpoint,
    accessKey: s3AccessKey,
    secretKey: s3SecretKey,
    region: s3Region,
    bucket: bundleBucket,
    logger,
  });

  if (!skipMinioVerification) {
    await retryWithBackoff(
      () => bundleService.ping().then((ok) => {
        if (!ok) throw new Error("MinIO ping returned false");
      }),
      "MinIO",
      60_000
    );
    console.info("MinIO connection verified.");
  }

  // Ensure bucket exists and lifecycle policy is applied (idempotent).
  await bundleService.ensureBucket();
  logger.info("plugin-bundles bucket ready.");

  // Step 7: Create repositories.
  const pluginRepo = new PluginRepository(db);
  const instanceRepo = new InstanceRepository(db);
  const hookRepo = new HookRepository(db);
  const cacheRepo = new CacheRepository(redis);
  const marketplaceRepo = new MarketplaceRepository(db);

  // Step 8: Create event publisher.
  const eventPublisher = createEventPublisher({ redis });

  // Step 8a: Create service token signer (Ed25519-signed JWT).
  const privateKeyPem = await loadServicePrivateKey("plugin-service", serviceKeysDir);
  const serviceTokenSigner = await createServiceTokenSigner("plugin-service", privateKeyPem);

  // Step 9: Create connector registration service.
  const connectorService = createConnectorRegistrationService({
    ingestionServiceUrl,
    serviceTokenSigner,
    logger,
  });

  // Step 10: Create hook service.
  const hookService = createHookService({ hookRepo, logger });

  // Step 11: Create plugin service.
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
    serviceTokenSigner,
    logger,
    eventPublisher,
    bundleBucket,
    retentionDays,
  });

  // Step 12: Create instance service.
  const instanceService = createInstanceService({
    pool: db,
    pluginRepo,
    instanceRepo,
    hookRepo,
    connectorService,
    hookService,
    executionServiceUrl,
    serviceTokenSigner,
    drainGraceSeconds,
    logger,
    eventPublisher,
  });

  // Step 12a: Create marketplace service.
  const marketplaceService = createMarketplaceService({
    pool: db,
    marketplaceRepo,
    logger,
    eventPublisher,
  });

  // Step 13: Create upgrade service.
  const upgradeService = createUpgradeService({
    pool: db,
    pluginRepo,
    instanceRepo,
    hookRepo,
    hookService,
    executionServiceUrl,
    serviceTokenSigner,
    logger,
    eventPublisher,
  });

  // Step 14: Start bundle cleanup worker (runs every hour, spec §10.4).
  // Only started when startWorkers is true, consistent with the worker opt-out pattern.
  let cleanupInterval: ReturnType<typeof setInterval> | undefined;
  if (startWorkers) {
    cleanupInterval = setInterval(
      () => void pluginService.cleanupExpiredBundles(),
      60 * 60 * 1000
    );
    cleanupInterval.unref();
  }

  // Step 15: Load service public keys.
  const servicePublicKeys = await loadServicePublicKeys(serviceKeysDir);
  logger.info("Service public keys loaded", {
    count: Object.keys(servicePublicKeys).length,
  });

  // Readiness gate — set true after all startup steps complete.
  let serviceReady = true;

  // Step 16: Create Hono app.
  const app = createApp({
    serviceName: "plugin-service",
    version,
    jwtSecret,
    redis,
    validateApiKey: async () => null,
    allowedOrigins,
    publicRoutes: ["/healthz", "/readyz"],
    targetService: "plugin-service",
    servicePublicKeys,
    maxBodySize: 50 * 1024 * 1024,
  });

  // Step 17: Register routes — specific before catch-all.
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

  // B2 fix: register upgrade and rollback endpoints.
  const upgradeRoutes = createUpgradeRoutes({ upgradeService });
  app.route("/api/v1/plugins", upgradeRoutes);

  const marketplaceRoutes = createMarketplaceRoutes({
    marketplaceService,
    onInstallPlugin: async ({ manifest, tenantId, installedBy }) => {
      // Marketplace installs must go through the regular bundle upload flow
      // (POST /api/v1/plugins with a real .tgz bundle) so that the Execution
      // Service can fetch the bundle from MinIO when the plugin is activated.
      // Previously this callback created a fabricated bundle_key that pointed
      // to a non-existent MinIO object, causing a 404 at activation time.
      //
      // The manifest from the marketplace listing is recorded purely for
      // telemetry (via marketplaceService.installPlugin above). Admins must
      // separately upload the plugin bundle via the regular install endpoint.
      const manifestData = manifest as unknown as import("./schemas/index.js").PluginManifest;

      const existing = await pluginRepo.findByManifestIdAndVersion(
        manifestData.id,
        manifestData.version,
      );
      if (existing !== null) {
        // Already installed via the bundle upload flow — idempotent, no error.
        logger.info("Marketplace install: plugin already installed via bundle upload", {
          manifestId: manifestData.id,
          version: manifestData.version,
          tenantId,
        });
        return;
      }

      // Block the install with a clear message rather than creating a broken record.
      // The caller (marketplace route) will surface this as a 400/500 to the admin.
      throw new Error(
        `Marketplace plugin '${manifestData.id}' v${manifestData.version} cannot be activated ` +
        `without an uploaded bundle. Download the plugin package and install it via ` +
        `POST /api/v1/plugins with the actual .tgz bundle file.`,
      );
    },
  });
  app.route("/api/v1/marketplace", marketplaceRoutes);

  const internalRoutes = createInternalRoutes({
    bundleService,
    hookService,
    cacheRepo,
    instanceRepo,
    pluginRepo,
    upgradeService,
  });
  app.route("/internal", internalRoutes);

  const cleanup = async (): Promise<void> => {
    serviceReady = false;
    if (cleanupInterval !== undefined) {
      clearInterval(cleanupInterval);
    }
    await Promise.all([db.end(), redis.quit()]);
  };

  return { app, cleanup };
}

// ---------------------------------------------------------------------------
// Main startup sequence — design spec §1.3
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const config = loadConfig(pluginConfigSchema);
  const masterKey = loadMasterKey();
  void masterKey; // Reserved for future field-level config encryption (spec §15.4)

  const pluginConfig: PluginConfig = {
    databaseUrl:        process.env["DATABASE_URL"]          ?? config.OP_DATABASE_URL,
    redisUrl:           process.env["REDIS_URL"]             ?? config.OP_REDIS_URL,
    jwtSecret:          config.OP_JWT_SECRET,
    masterKey,
    allowedOrigins:     config.OP_ALLOWED_ORIGINS,
    s3Endpoint:         process.env["OP_S3_ENDPOINT"]        ?? "http://minio:9000",
    s3AccessKey:        process.env["OP_S3_ACCESS_KEY"]      ?? "",
    s3SecretKey:        process.env["OP_S3_SECRET_KEY"]      ?? "",
    s3Region:           process.env["OP_S3_REGION"]          ?? "us-east-1",
    bundleBucket:       process.env["OP_PLUGIN_BUNDLE_BUCKET"] ?? "plugin-bundles",
    executionServiceUrl: process.env["EXECUTION_SERVICE_URL"] ?? "http://execution-service:3000",
    ingestionServiceUrl: process.env["INGESTION_SERVICE_URL"] ?? "http://ingestion-service:3000",
    retentionDays:      parseInt(process.env["OP_PLUGIN_BUNDLE_RETENTION_DAYS"] ?? "7", 10),
    drainGraceSeconds:  parseInt(process.env["OP_PLUGIN_DRAIN_GRACE_SECONDS"] ?? "60", 10),
    serviceKeysDir:     process.env["OP_SERVICE_KEYS_DIR"]   ?? "/data/service-keys",
    skipMinioVerification: false,
    startWorkers:       true,
  };

  const { app, cleanup } = await createServiceApp(pluginConfig);

  const port = parseInt(process.env["PORT"] ?? "3000", 10);

  const server = createServer(
    (req: IncomingMessage, res: ServerResponse): void => {
      const url = `http://${req.headers["host"] ?? "localhost"}${req.url ?? "/"}`;

      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("error", (err) => {
        console.error("Request socket error:", err.message);
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
    console.info("Plugin service started", { port });
  });

  // SIGTERM handler with 30s hard-exit fallback.
  process.on("SIGTERM", () => {
    console.info("SIGTERM received — starting graceful shutdown");

    const shutdownTimeout = setTimeout(() => {
      console.error("Shutdown timeout exceeded — forcing exit");
      process.exit(1);
    }, 30_000);
    shutdownTimeout.unref();

    server.close(() => {
      cleanup()
        .then(() => {
          clearTimeout(shutdownTimeout);
          console.info("Plugin service graceful shutdown complete");
          process.exit(0);
        })
        .catch(() => process.exit(1));
    });
  });
}

main().catch((err: unknown) => {
  console.error("Plugin service failed to start:", err);
  process.exit(1);
});
