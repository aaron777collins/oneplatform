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

  // Repositories
  const connectorRepo = new ConnectorRepository(db);
  const credentialRepo = new CredentialRepository(db);
  const syncStateRepo = new SyncStateRepository(db);
  const webhookReceiverRepo = new WebhookReceiverRepository(db);
  const uploadJobRepo = new UploadJobRepository(db);
  const rawTableRepo = new RawTableRepository(db);

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

  const webhookReceiveService = createWebhookReceiveService({
    receiverRepo: webhookReceiverRepo,
    rawTableRepo,
    credentialService,
    masterKey: config.masterKey,
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

  const webhookManagementService = createWebhookManagementService({
    receiverRepo: webhookReceiverRepo,
    credentialService,
    baseUrl: config.baseUrl,
    logger,
  });

  // Workers are optional so tests can wire the app without consuming Redis connections
  let syncWorker: Worker<SyncJobPayload> | undefined;
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

    logger.info("BullMQ sync, batch, and file-parse workers started");

    retentionService.startScheduler();
  }

  const servicePublicKeys = await loadServicePublicKeys();

  const app = createApp({
    serviceName: "ingestion-service",
    version: "0.0.0",
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

  const webhookRoutes = createWebhookRoutes({
    webhookManagementService,
    webhookReceiveService,
    masterKey: config.masterKey,
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
    masterKey: config.masterKey,
  });
  app.route("/internal", internalRoutes);

  const cleanup = async (): Promise<void> => {
    if (startWorkers) {
      retentionService.stop();
      await Promise.all([
        syncWorker?.close(),
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
  const config = loadConfig();
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
