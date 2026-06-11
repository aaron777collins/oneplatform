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
} from "@oneplatform/core";
import { runMigrations } from "./db/migrate.js";
import {
  ConnectorRepository,
  CredentialRepository,
  SyncStateRepository,
  WebhookReceiverRepository,
  UploadJobRepository,
  RawTableRepository,
} from "./repositories/index.js";
import {
  createCredentialService,
  createConnectorService,
  createSyncService,
  createWebhookReceiveService,
  createUploadService,
  createRetentionService,
} from "./services/index.js";
import type { SyncJobPayload, BatchJobPayload } from "./services/index.js";
import type { FileParseJobPayload } from "./services/upload-service.js";
import { createWebhookManagementService } from "./services/webhook-management-service.js";
import {
  createHealthRoutes,
  createConnectorRoutes,
  createWebhookRoutes,
  createUploadRoutes,
  createInternalRoutes,
} from "./routes/index.js";

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

async function main(): Promise<void> {
  // Step 1: Load configuration and master key
  const config = loadConfig();
  const masterKey = loadMasterKey();
  const serviceStartedAt = new Date();

  // Step 2: Create infrastructure clients
  const db = createDbClient({
    connectionString: config.OP_DATABASE_URL,
    maxConnections: 30,
  });

  const redis = createRedisClient({ url: config.OP_REDIS_URL });

  // Step 3: Run database migrations
  const migrationResult = await runMigrations(db);
  if (migrationResult.applied.length > 0) {
    console.info("Ingestion migrations applied:", migrationResult.applied);
  }

  // Step 4: Create logger
  const logger = createLogger({
    serviceName: "ingestion-service",
    redis,
  });

  // Step 5: Instantiate repositories
  const connectorRepo = new ConnectorRepository(db);
  const credentialRepo = new CredentialRepository(db);
  const syncStateRepo = new SyncStateRepository(db);
  const webhookReceiverRepo = new WebhookReceiverRepository(db);
  const uploadJobRepo = new UploadJobRepository(db);
  const rawTableRepo = new RawTableRepository(db);

  // Step 6: Create services
  const credentialService = createCredentialService({
    credentialRepo,
    logger,
  });

  const executionServiceUrl = process.env["EXECUTION_SERVICE_URL"] ?? "http://execution-service:3005";
  const connectorService = createConnectorService({
    connectorRepo,
    credentialService,
    syncStateRepo,
    masterKey,
    executionServiceUrl,
    logger,
  });

  const syncService = createSyncService({
    connectorRepo,
    syncStateRepo,
    rawTableRepo,
    credentialService,
    redis,
    masterKey,
    logger,
    executionServiceUrl,
  });

  const webhookReceiveService = createWebhookReceiveService({
    receiverRepo: webhookReceiverRepo,
    rawTableRepo,
    credentialService,
    masterKey,
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

  const baseUrl = process.env["OP_BASE_URL"] ?? "https://api.oneplatform.dev";
  const webhookManagementService = createWebhookManagementService({
    receiverRepo: webhookReceiverRepo,
    credentialService,
    baseUrl,
    logger,
  });

  // Step 7: Start BullMQ workers
  const syncWorker = new Worker<SyncJobPayload>(
    "ingestion:sync",
    async (job) => syncService.processSyncJob(job),
    {
      connection: { url: config.OP_REDIS_URL },
      concurrency: parseInt(process.env["OP_SYNC_WORKER_CONCURRENCY"] ?? "3", 10),
      removeOnComplete: { age: 604_800 },
      removeOnFail: { age: 604_800 },
    },
  );

  const batchWorker = new Worker<BatchJobPayload>(
    "ingestion:batch",
    async (job) => syncService.processBatchJob(job),
    {
      connection: { url: config.OP_REDIS_URL },
      concurrency: parseInt(process.env["OP_BATCH_WORKER_CONCURRENCY"] ?? "10", 10),
      removeOnComplete: { age: 604_800 },
      removeOnFail: { age: 604_800 },
    },
  );

  const fileParseWorker = new Worker<FileParseJobPayload>(
    "ingestion:file-parse",
    async (job) => uploadService.processUploadJob(job),
    {
      connection: { url: config.OP_REDIS_URL },
      concurrency: parseInt(process.env["OP_FILE_PARSE_WORKER_CONCURRENCY"] ?? "5", 10),
      removeOnComplete: { age: 86_400 },
      removeOnFail: { age: 604_800 },
    },
  );

  logger.info("BullMQ sync, batch, and file-parse workers started");

  // Step 8: Start retention scheduler (daily cleanup)
  retentionService.startScheduler();

  // Step 9: Load service public keys
  const servicePublicKeys = await loadServicePublicKeys();

  // Step 10: Create Hono app
  const app = createApp({
    serviceName: "ingestion-service",
    version: "0.0.0",
    jwtSecret: config.OP_JWT_SECRET,
    redis,
    validateApiKey: async () => null,
    allowedOrigins: config.OP_ALLOWED_ORIGINS,
    publicRoutes: [
      "/healthz",
      "/readyz",
      "/api/v1/webhooks/inbound/*/receive",
    ],
    targetService: "ingestion-service",
    servicePublicKeys,
  });

  // Step 11: Register routes (order matters — specific before catch-all)
  const healthRoutes = createHealthRoutes({ pool: db, redis, serviceStartedAt, storage, masterKey });
  app.route("/", healthRoutes);

  const connectorRoutes = createConnectorRoutes({ connectorService, syncService, masterKey });
  app.route("/api/v1/connectors", connectorRoutes);

  const webhookRoutes = createWebhookRoutes({
    webhookManagementService,
    webhookReceiveService,
    masterKey,
  });
  app.route("/api/v1/webhooks", webhookRoutes);

  const maxFileSizeBytes = parseInt(process.env["OP_UPLOAD_MAX_SIZE_BYTES"] ?? String(5 * 1024 * 1024 * 1024), 10);
  const uploadRoutes = createUploadRoutes({
    uploadService,
    storage,
    ...(maxFileSizeBytes ? { maxFileSizeBytes } : {}),
  });
  app.route("/api/v1/uploads", uploadRoutes);

  const internalRoutes = createInternalRoutes({
    connectorService,
    connectorRepo,
    credentialService,
    syncService,
    masterKey,
  });
  app.route("/internal", internalRoutes);

  // Step 12: Start HTTP server
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
    logger.info("Ingestion service started", { port });
  });

  // Graceful shutdown with hard-exit fallback
  process.on("SIGTERM", () => {
    console.info("SIGTERM received — starting graceful shutdown");

    const shutdownTimeout = setTimeout(() => {
      console.error("Shutdown timeout exceeded — forcing exit");
      process.exit(1);
    }, 30_000);
    shutdownTimeout.unref();

    retentionService.stop();

    void Promise.all([
      syncWorker.close(),
      batchWorker.close(),
      fileParseWorker.close(),
    ]).then(() => {
      server.close(() => {
        void db.end().then(() => {
          void redis.quit().then(() => {
            clearTimeout(shutdownTimeout);
            console.info("Graceful shutdown complete");
            process.exit(0);
          });
        });
      });
    });
  });
}

main().catch((err: unknown) => {
  console.error("Ingestion service failed to start:", err);
  process.exit(1);
});
