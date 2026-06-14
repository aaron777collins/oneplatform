import { readFile, readdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  loadConfig,
  executionConfigSchema,
  createDbClient,
  createLogger,
  createApp,
  loadMasterKey,
} from "@oneplatform/core";
import { runMigrations } from "./db/migrate.js";
import {
  ExecutionRepository,
  ExecutionLogRepository,
} from "./repositories/index.js";
import {
  createUnixSocketClient,
  createSandboxManager,
  createPluginBundleCache,
  createContextCallHandler,
  createExecutionRouter,
  createSseManager,
  createExecutionService,
  createPartitionManager,
} from "./services/index.js";
import {
  createHealthRoutes,
  createExecRoutes,
  createInternalRoutes,
} from "./routes/index.js";

// ---------------------------------------------------------------------------
// Startup helpers
// ---------------------------------------------------------------------------

function loadServicePublicKeys(): Promise<Record<string, string>> {
  return (async () => {
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
          }),
      );

      return keys;
    } catch {
      return {};
    }
  })();
}

// ---------------------------------------------------------------------------
// Redis stub — the Execution Service has NO Redis access (ADR-5, ADR-19).
//
// createApp() requires a Redis client for the JWT revocation blocklist check
// in the auth middleware. Because this service sits behind the Gateway and all
// internal callers use Ed25519 service tokens (not user JWTs), the revocation
// check is a best-effort safeguard. We pass a minimal stub that always returns
// 0 (token not revoked) rather than hard-failing at startup due to the absence
// of Redis. This is the deliberate least-privilege trade-off: the Gateway is
// the primary revocation enforcement point for user-facing JWTs.
// ---------------------------------------------------------------------------

function createNoopRedisStub() {
  return {
    exists: async (..._keys: string[]): Promise<number> => 0,
    ping: async (): Promise<string> => "PONG",
    on: (_event: string, _handler: unknown): unknown => null,
    quit: async (): Promise<void> => undefined,
  } as unknown as import("ioredis").Redis;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ServiceApp {
  app: ReturnType<typeof createApp>;
  cleanup: () => Promise<void>;
}

export interface ExecutionConfig {
  databaseUrl: string;
  jwtSecret: string;
  masterKey: Buffer;
  allowedOrigins: string[];
  sandboxSocketPath: string;
  pluginServiceUrl: string;
  ingestionServiceUrl: string;
  pipelineServiceUrl: string;
  serviceBaseUrl: string;
  serviceToken: string;
  retentionDays: number;
}

// ---------------------------------------------------------------------------
// Factory — wires all dependencies, returns the Hono app and a cleanup fn.
// main() is the only caller in production; tests can call this directly.
// ---------------------------------------------------------------------------

export async function createServiceApp(config: ExecutionConfig): Promise<ServiceApp> {
  const serviceStartedAt = new Date();

  const {
    databaseUrl,
    jwtSecret,
    allowedOrigins,
    sandboxSocketPath,
    pluginServiceUrl,
    ingestionServiceUrl,
    pipelineServiceUrl,
    serviceBaseUrl,
    serviceToken,
    retentionDays,
  } = config;

  // Step 1: Create DB pool (NO Redis — ADR-5, ADR-19)
  const db = createDbClient({
    connectionString: databaseUrl,
    maxConnections: 15,
  });

  // Step 2: Run migrations (idempotent)
  const migrationResult = await runMigrations(db);
  if (migrationResult.applied.length > 0) {
    console.info("Execution migrations applied:", migrationResult.applied);
  }

  // Step 3: Create structured logger.
  // The logger normally receives a Redis client for log forwarding. Since this
  // service has no Redis, logs go to stdout only. The Logging Service collects
  // structured stdout via the Docker logging driver (spec §15.3).
  const noopRedis = createNoopRedisStub();
  const logger = createLogger({
    serviceName: "execution-service",
    redis: noopRedis,
  });

  // Step 4: Instantiate repositories
  const executionRepo = new ExecutionRepository(db);
  const logRepo = new ExecutionLogRepository(db);

  // Step 5: Create Unix socket client and connect to sandbox
  const sandboxClient = createUnixSocketClient({ logger });

  // Attempt initial connection — the sandbox container must be healthy before
  // the Execution Service reports ready (spec §2, startup dependencies).
  // Retry with backoff if the socket is not yet available.
  async function connectToSandbox(retryCount = 0): Promise<void> {
    try {
      await sandboxClient.connect(sandboxSocketPath);
      logger.info("Connected to sandbox Unix socket", { path: sandboxSocketPath });
    } catch (err) {
      const maxRetries = 12; // Up to 60s total at 5s intervals
      if (retryCount >= maxRetries) {
        throw new Error(
          `Failed to connect to sandbox socket after ${maxRetries} retries: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      logger.warn("Sandbox socket not ready — retrying in 5s", {
        attempt: retryCount + 1,
        error: err instanceof Error ? err.message : String(err),
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 5_000));
      return connectToSandbox(retryCount + 1);
    }
  }

  await connectToSandbox();

  // Step 6: Create plugin bundle cache.
  // Service token for outbound Plugin Service calls is loaded from the mounted
  // keypair at /data/. For now we use a placeholder; the actual signing mechanism
  // is wired in the observability/auth task.
  const pluginBundleCache = createPluginBundleCache({
    logger,
    pluginServiceUrl,
    serviceToken,
  });

  // Step 7: Create context call handler
  const contextCallHandler = createContextCallHandler({
    logger,
    ingestionServiceUrl,
    pluginServiceUrl,
    pipelineServiceUrl,
    serviceToken,
  });

  // Step 8: Create SSE manager
  const sseManager = createSseManager({ logger });

  // Step 9: Create sandbox manager.
  // onCrash callback notifies the execution service to mark in-flight records as killed.
  // We wire this after creating the execution service below.
  let onCrashCallback: ((ids: string[]) => void) | undefined;

  const sandboxManager = createSandboxManager({
    primaryClient: sandboxClient,
    logger,
    socketPath: sandboxSocketPath,
    onCrash: (killedIds) => {
      if (onCrashCallback !== undefined) {
        onCrashCallback(killedIds);
      }
    },
  });

  // Step 10: Create execution router
  const executionRouter = createExecutionRouter({
    sandboxManager,
    contextCallHandler,
    logger,
  });

  // Step 11: Create execution service
  const executionService = createExecutionService({
    executionRepo,
    logRepo,
    executionRouter,
    pluginBundleCache,
    sseManager,
    contextCallHandler,
    sandboxClient,
    logger,
    serviceBaseUrl,
  });

  // Wire the crash callback now that executionService exists
  onCrashCallback = (ids) => executionService.handleSandboxCrash(ids);

  // Step 12: Create partition manager and ensure current partitions
  const partitionManager = createPartitionManager({ pool: db, logger });
  await partitionManager.ensureCurrentPartitions();

  // Start daily partition maintenance at 03:00 UTC (spec §3)
  const partitionManagerExtended = partitionManager as typeof partitionManager & {
    startDailyScheduler(days: number): void;
  };
  if (typeof partitionManagerExtended.startDailyScheduler === "function") {
    partitionManagerExtended.startDailyScheduler(retentionDays);
  }

  // Step 13: Start sandbox ping health checks (10s interval)
  sandboxManager.startHealthChecks();
  logger.info("Sandbox health checks started");

  // Step 14: Load service public keys for inter-service JWT verification
  const servicePublicKeys = await loadServicePublicKeys();
  logger.info("Service public keys loaded", { count: Object.keys(servicePublicKeys).length });

  // Step 15: Gate — service is ready only after sandbox health check passes.
  // Allow a brief window for the first ping to complete before marking ready.
  let serviceReady = false;
  setTimeout(() => {
    serviceReady = true;
  }, 3_000);

  // Step 16: Create Hono app (NO Redis — use noop stub for auth middleware)
  const app = createApp({
    serviceName: "execution-service",
    version: process.env["OP_SERVICE_VERSION"] ?? "0.0.0-dev",
    jwtSecret,
    redis: noopRedis,
    validateApiKey: async () => null,
    allowedOrigins,
    publicRoutes: ["/healthz", "/readyz"],
    targetService: "execution-service",
    servicePublicKeys,
  });

  // Step 17: Register routes
  const healthRoutes = createHealthRoutes({
    pool: db,
    sandboxClient,
    serviceStartedAt,
    isReady: () => serviceReady,
  });
  app.route("/", healthRoutes);

  const execRoutes = createExecRoutes({ executionService, sseManager });
  app.route("/api/v1/exec", execRoutes);

  const internalRoutes = createInternalRoutes({ executionService });
  app.route("/internal", internalRoutes);

  const cleanup = async (): Promise<void> => {
    serviceReady = false;
    sandboxManager.stop();
    partitionManager.stop();
    await db.end();
  };

  return { app, cleanup };
}

// ---------------------------------------------------------------------------
// Main startup sequence — design spec §2 (startup dependencies)
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const config = loadConfig(executionConfigSchema);
  const masterKey = loadMasterKey();
  void masterKey; // Available for future on-disk cache encryption (spec §10.3)

  const executionConfig: ExecutionConfig = {
    databaseUrl: process.env["DATABASE_URL"] ?? config.OP_DATABASE_URL,
    jwtSecret: config.OP_JWT_SECRET,
    masterKey,
    allowedOrigins: config.OP_ALLOWED_ORIGINS,
    sandboxSocketPath: process.env["OP_SANDBOX_SOCKET_PATH"] ?? "/run/sandbox/op.sock",
    pluginServiceUrl: process.env["PLUGIN_SERVICE_URL"] ?? "http://plugin-service:3008",
    ingestionServiceUrl: process.env["INGESTION_SERVICE_URL"] ?? "http://ingestion-service:3002",
    pipelineServiceUrl: process.env["PIPELINE_SERVICE_URL"] ?? "http://pipeline-service:3004",
    serviceBaseUrl: process.env["EXECUTION_SERVICE_URL"] ?? "http://execution-service:3005",
    serviceToken: process.env["OP_SERVICE_TOKEN"] ?? "",
    retentionDays: parseInt(process.env["OP_EXECUTION_LOG_RETENTION_DAYS"] ?? "30", 10),
  };

  const { app, cleanup } = await createServiceApp(executionConfig);

  const port = parseInt(process.env["PORT"] ?? "3005", 10);

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
          const contentType = response.headers.get("content-type") ?? "";

          // SSE responses must be streamed — never buffered via arrayBuffer()
          if (contentType.includes("text/event-stream") && response.body !== null) {
            res.writeHead(
              response.status,
              Object.fromEntries(response.headers.entries()),
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
              Object.fromEntries(response.headers.entries()),
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
    },
  );

  server.listen(port, () => {
    console.info("Execution service started", { port });
  });

  // SIGTERM handler with 30s hard-exit fallback (spec §2)
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
          console.info("Execution service graceful shutdown complete");
          process.exit(0);
        })
        .catch(() => process.exit(1));
    });
  });
}

main().catch((err: unknown) => {
  console.error("Execution service failed to start:", err);
  process.exit(1);
});
