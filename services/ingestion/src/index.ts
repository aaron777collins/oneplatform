import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Worker } from "bullmq";
import {
  loadConfig,
  ingestionConfigSchema,
  createDbClient,
  createRedisClient,
  createLogger,
  createApp,
  loadMasterKey,
  readPackageVersion,
  setupProcessErrorHandlers,
} from "@oneplatform/core";
import { runMigrations } from "./db/migrate.js";
import {
  ConnectorRepository,
  CredentialRepository,
  SyncStateRepository,
  WebhookReceiverRepository,
  WebhookDeliveryLogRepositoryImpl,
  UploadJobRepository,
  RawTableRepository,
  ReconciliationReportRepositoryImpl,
} from "./repositories/index.js";
import {
  createCredentialService,
  createConnectorService,
  createSyncService,
  createWebhookReceiveService,
  createUploadService,
  createRetentionService,
  createWebhookDeliveryService,
  createWebhookDeliveryLogger,
  createSyncAnalyticsService,
  createConnectorHealthService,
  createCdcIngestionService,
  createReconciliationService,
  createConnectorRegistryService,
  registerBuiltinConnectors,
} from "./services/index.js";
import type { SyncJobPayload, BatchJobPayload, ReconcileJobPayload } from "./services/index.js";
import type { FileParseJobPayload } from "./services/upload-service.js";
import { createWebhookManagementService } from "./services/webhook-management-service.js";
import {
  createHealthRoutes,
  createConnectorRoutes,
  createWebhookRoutes,
  createUploadRoutes,
  createInternalRoutes,
  createAnalyticsRoutes,
  createConnectorHealthRoutes,
  createCdcRoutes,
  createReconciliationRoutes,
  createConnectorRegistryRoutes,
} from "./routes/index.js";

// TTL for reconciliation report data stored in BullMQ job results (7 days).
const REPORT_REDIS_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface ServiceApp {
  app: ReturnType<typeof createApp>;
  cleanup: () => Promise<void>;
}

export interface IngestionConfig {
  databaseUrl: string;
  redisUrl: string;
  jwtSecret: string;
  /** Raw key bytes returned by loadMasterKey() */
  masterKey: Buffer;
  allowedOrigins: string[];
  executionServiceUrl: string;
  baseUrl: string;
  /** When false, BullMQ workers and retention scheduler are not started. Defaults to true. */
  startWorkers?: boolean;
}

async function loadServicePublicKeys(): Promise<Record<string, string>> {
  try {
    const { readdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const dir = "/data/service-keys";
    const files = await readdir(dir);
    const keys: Record<string, string> = {};

    await Promise.all(
      files
        .filter((f) => f.endsWith(".pub"))
        .map(async (f) => {
          const serviceName = f.replace(/\.pub$/, "");
          const pem = await readFile(join(dir, f), "utf-8");
          keys[serviceName] = pem;
        }),
    );

    return keys;
  } catch {
    return {};
  }
}

export async function createServiceApp(config: IngestionConfig): Promise<ServiceApp> {
  const startWorkers = config.startWorkers ?? true;
  const serviceStartedAt = new Date();
  const version = readPackageVersion(import.meta.url);

  // Create infrastructure clients using config values — never reads env directly
  const db = createDbClient({
    connectionString: config.databaseUrl,
    maxConnections: 30,
  });

  const redis = createRedisClient({ url: config.redisUrl });

  const migrationResult = await runMigrations(db);
  if (migrationResult.applied.length > 0) {
    console.info("Ingestion migrations applied:", migrationResult.applied);
  }

  const logger = createLogger({
    serviceName: "ingestion-service",
    redis,
  });
  setupProcessErrorHandlers(logger);

  // Repositories
  const connectorRepo = new ConnectorRepository(db);
  const credentialRepo = new CredentialRepository(db);
  const syncStateRepo = new SyncStateRepository(db);
  const webhookReceiverRepo = new WebhookReceiverRepository(db);
  const webhookDeliveryLogRepo = new WebhookDeliveryLogRepositoryImpl(db);
  const uploadJobRepo = new UploadJobRepository(db);
  const rawTableRepo = new RawTableRepository(db);
  const reconciliationReportRepo = new ReconciliationReportRepositoryImpl(db);

  // Services
  const credentialService = createCredentialService({
    credentialRepo,
    logger,
  });

  const connectorService = createConnectorService({
    connectorRepo,
    credentialService,
    syncStateRepo,
    masterKey: config.masterKey,
    executionServiceUrl: config.executionServiceUrl,
    logger,
  });

  const syncService = createSyncService({
    connectorRepo,
    syncStateRepo,
    rawTableRepo,
    credentialService,
    redis,
    masterKey: config.masterKey,
    logger,
    executionServiceUrl: config.executionServiceUrl,
  });

  const coreWebhookReceiveService = createWebhookReceiveService({
    receiverRepo: webhookReceiverRepo,
    rawTableRepo,
    credentialService,
    masterKey: config.masterKey,
    logger,
  });

  // Wrap the core receive service with the delivery logger so every inbound
  // event is recorded in webhook_delivery_log without touching the HMAC path.
  const webhookReceiveService = createWebhookDeliveryLogger(
    coreWebhookReceiveService,
    { deliveryLogRepo: webhookDeliveryLogRepo, logger },
  );

  const webhookDeliveryService = createWebhookDeliveryService({
    deliveryLogRepo: webhookDeliveryLogRepo,
    receiverRepo: webhookReceiverRepo,
    logger,
  });

  // MinIO/S3 client stub — the real ObjectStorageClient is injected based on
  // environment. In production this wraps the AWS SDK v3 S3 client pointed at
  // MinIO. For now we create a no-op stub so the service compiles; the actual
  // implementation is wired when the infrastructure layer is deployed.
  const storage = {
    async putObject() { /* MinIO put stub */ },
    async getObject(_bucket: string, _key: string): Promise<ReadableStream<Uint8Array>> {
      return new ReadableStream<Uint8Array>();
    },
    async deleteObject(_bucket: string, _key: string): Promise<void> { /* MinIO delete stub */ },
  };

  const uploadService = createUploadService({
    uploadJobRepo,
    rawTableRepo,
    storage,
    logger,
  });

  const retentionService = createRetentionService({
    connectorRepo,
    rawTableRepo,
    logger,
  });

  const syncAnalyticsService = createSyncAnalyticsService({
    syncService,
    connectorRepo,
  });

  const connectorHealthService = createConnectorHealthService({
    syncService,
    connectorRepo,
    syncStateRepo,
    logger,
  });

  const cdcIngestionService = createCdcIngestionService({
    connectorRepo,
    syncStateRepo,
    rawTableRepo,
    redis,
    logger,
  });

  const reconciliationService = createReconciliationService({
    connectorRepo,
    credentialService,
    rawRecordReader: rawTableRepo,
    reportRepo: reconciliationReportRepo,
    redis,
    masterKey: config.masterKey,
    logger,
    executionServiceUrl: config.executionServiceUrl,
  });

  // Connector registry — in-process catalog of available connector types.
  // Built-ins are registered immediately so the catalog is always populated,
  // even in test environments that skip the workers block.
  const connectorRegistryService = createConnectorRegistryService();
  await registerBuiltinConnectors(connectorRegistryService);

  const webhookManagementService = createWebhookManagementService({
    receiverRepo: webhookReceiverRepo,
    connectorRepo,
    credentialService,
    baseUrl: config.baseUrl,
    logger,
  });

  // On startup, any sync_state row still in 'running' belongs to a job that was
  // interrupted by the previous process crash. Reset them to 'failed' immediately
  // so connectors are not permanently blocked from triggering new syncs.
  // We pass staleThresholdMs=0 so all running rows are eligible regardless of age.
  await syncService.runWatchdog(0);

  // Cleanup hooks registered by optional startup code (e.g. watchdog timer).
  const extraCleanupFns: Array<() => void> = [];

  // Workers are optional so tests can wire the app without consuming Redis connections
  let syncWorker: Worker<SyncJobPayload> | undefined;
  let reconcileWorker: Worker<ReconcileJobPayload> | undefined;
  let batchWorker: Worker<BatchJobPayload> | undefined;
  let fileParseWorker: Worker<FileParseJobPayload> | undefined;

  if (startWorkers) {
    syncWorker = new Worker<SyncJobPayload>(
      "ingestion:sync",
      async (job) => syncService.processSyncJob(job),
      {
        connection: { url: config.redisUrl },
        concurrency: parseInt(process.env["OP_SYNC_WORKER_CONCURRENCY"] ?? "3", 10),
        removeOnComplete: { age: 604_800 },
        removeOnFail: { age: 604_800 },
      },
    );

    batchWorker = new Worker<BatchJobPayload>(
      "ingestion:batch",
      async (job) => syncService.processBatchJob(job),
      {
        connection: { url: config.redisUrl },
        concurrency: parseInt(process.env["OP_BATCH_WORKER_CONCURRENCY"] ?? "10", 10),
        removeOnComplete: { age: 604_800 },
        removeOnFail: { age: 604_800 },
      },
    );

    fileParseWorker = new Worker<FileParseJobPayload>(
      "ingestion:file-parse",
      async (job) => uploadService.processUploadJob(job),
      {
        connection: { url: config.redisUrl },
        concurrency: parseInt(process.env["OP_FILE_PARSE_WORKER_CONCURRENCY"] ?? "5", 10),
        removeOnComplete: { age: 86_400 },
        removeOnFail: { age: 604_800 },
      },
    );

    reconcileWorker = new Worker<ReconcileJobPayload>(
      "ingestion:reconcile",
      async (job) => reconciliationService.processReconcileJob(job),
      {
        connection: { url: config.redisUrl },
        concurrency: parseInt(process.env["OP_RECONCILE_WORKER_CONCURRENCY"] ?? "2", 10),
        removeOnComplete: { age: REPORT_REDIS_TTL_SECONDS },
        removeOnFail: { age: REPORT_REDIS_TTL_SECONDS },
      },
    );

    logger.info("BullMQ sync, batch, and file-parse workers started");

    retentionService.startScheduler();

    // Watchdog: scan for sync_state rows stuck in 'running' every 5 minutes.
    // The threshold defaults to 15 minutes (configured via OP_SYNC_STALE_THRESHOLD_MS).
    // Uses self-scheduling setTimeout (not setInterval) to prevent overlapping runs.
    const staleThresholdMs = parseInt(
      process.env["OP_SYNC_STALE_THRESHOLD_MS"] ?? String(15 * 60 * 1_000),
      10,
    );
    const watchdogIntervalMs = 5 * 60 * 1_000;
    let watchdogHandle: ReturnType<typeof setTimeout> | null = null;
    let watchdogStopped = false;

    async function watchdogTick(): Promise<void> {
      if (watchdogStopped) return;
      await syncService.runWatchdog(staleThresholdMs);
      if (!watchdogStopped) {
        watchdogHandle = setTimeout(() => void watchdogTick(), watchdogIntervalMs);
      }
    }
    watchdogHandle = setTimeout(() => void watchdogTick(), watchdogIntervalMs);

    // Store cleanup refs on the outer scope so the cleanup fn can cancel them.
    const stopWatchdog = (): void => {
      watchdogStopped = true;
      if (watchdogHandle !== null) {
        clearTimeout(watchdogHandle);
        watchdogHandle = null;
      }
    };

    // Attach stopWatchdog to cleanup via a module-scoped capture.
    // We store it so the cleanup closure can call it without a closure cycle.
    extraCleanupFns.push(stopWatchdog);
  }

  const servicePublicKeys = await loadServicePublicKeys();

  const app = createApp({
    serviceName: "ingestion-service",
    version,
    jwtSecret: config.jwtSecret,
    redis,
    validateApiKey: async () => null,
    allowedOrigins: config.allowedOrigins,
    publicRoutes: [
      "/healthz",
      "/readyz",
      "/api/v1/webhooks/inbound/*/receive",
    ],
    targetService: "ingestion-service",
    servicePublicKeys,
  });

  // Route registration — specific before catch-all
  const healthRoutes = createHealthRoutes({ pool: db, redis, serviceStartedAt, storage, masterKey: config.masterKey });
  app.route("/", healthRoutes);

  const connectorRoutes = createConnectorRoutes({ connectorService, syncService, masterKey: config.masterKey });
  app.route("/api/v1/connectors", connectorRoutes);

  const connectorHealthRoutes = createConnectorHealthRoutes({ connectorHealthService });
  app.route("/api/v1/connectors", connectorHealthRoutes);

  const analyticsRoutes = createAnalyticsRoutes({ analyticsService: syncAnalyticsService, connectorService });
  app.route("/api/v1/connectors", analyticsRoutes);
  app.route("/api/v1/analytics", analyticsRoutes);

  const webhookRoutes = createWebhookRoutes({
    webhookManagementService,
    webhookReceiveService,
    webhookDeliveryService,
    masterKey: config.masterKey,
  });
  app.route("/api/v1/webhooks", webhookRoutes);

  const maxFileSizeBytes = parseInt(process.env["OP_UPLOAD_MAX_SIZE_BYTES"] ?? String(5 * 1024 * 1024 * 1024), 10);
  const uploadRoutes = createUploadRoutes({
    uploadService,
    storage,
    redisUrl: config.redisUrl,
    ...(maxFileSizeBytes ? { maxFileSizeBytes } : {}),
  });
  app.route("/api/v1/uploads", uploadRoutes);

  const reconciliationRoutes = createReconciliationRoutes({
    connectorService,
    reconciliationService,
  });
  app.route("/api/v1/connectors", reconciliationRoutes);

  const internalRoutes = createInternalRoutes({
    connectorService,
    connectorRepo,
    credentialService,
    syncService,
    masterKey: config.masterKey,
  });
  app.route("/internal", internalRoutes);

  const cdcRoutes = createCdcRoutes({ connectorService, cdcIngestionService });
  app.route("/api/v1/connectors", cdcRoutes);

  const connectorRegistryRoutes = createConnectorRegistryRoutes({ connectorRegistryService });
  app.route("/api/v1/connector-registry", connectorRegistryRoutes);

  const cleanup = async (): Promise<void> => {
    // Cancel any background timers registered during startup (e.g. watchdog).
    for (const fn of extraCleanupFns) fn();

    if (startWorkers) {
      retentionService.stop();
      await Promise.all([
        syncWorker?.close(),
        reconcileWorker?.close(),
        batchWorker?.close(),
        fileParseWorker?.close(),
      ]);
    }
    await db.end();
    await redis.quit();
  };

  return { app, cleanup };
}

async function main(): Promise<void> {
  const config = loadConfig(ingestionConfigSchema);
  const masterKey = loadMasterKey();

  const { app, cleanup } = await createServiceApp({
    databaseUrl: config.OP_DATABASE_URL,
    redisUrl: config.OP_REDIS_URL,
    jwtSecret: config.OP_JWT_SECRET,
    masterKey,
    allowedOrigins: config.OP_ALLOWED_ORIGINS,
    executionServiceUrl: process.env["EXECUTION_SERVICE_URL"] ?? "http://execution-service:3005",
    baseUrl: process.env["OP_BASE_URL"] ?? "https://api.oneplatform.dev",
  });

  const port = parseInt(process.env["PORT"] ?? "3002", 10);

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
          res.writeHead(
            response.status,
            Object.fromEntries(response.headers.entries()),
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
    },
  );

  server.listen(port, () => {
    console.info(`Ingestion service started on port ${port}`);
  });

  // Graceful shutdown with hard-exit fallback
  process.on("SIGTERM", () => {
    console.info("SIGTERM received — starting graceful shutdown");

    const shutdownTimeout = setTimeout(() => {
      console.error("Shutdown timeout exceeded — forcing exit");
      process.exit(1);
    }, 30_000);
    shutdownTimeout.unref();

    server.close(() => {
      void cleanup().then(() => {
        clearTimeout(shutdownTimeout);
        console.info("Graceful shutdown complete");
        process.exit(0);
      });
    });
  });
}

main().catch((err: unknown) => {
  console.error("Ingestion service failed to start:", err);
  process.exit(1);
});
