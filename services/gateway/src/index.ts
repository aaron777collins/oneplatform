import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  loadConfig,
  createDbClient,
  createRedisClient,
  createLogger,
  createApp,
  loadMasterKey,
} from "@oneplatform/core";
import { runMigrations } from "./db/migrate.js";
import { WebhookRepository } from "./repositories/webhook-repository.js";
import { WebhookDeliveryRepository } from "./repositories/webhook-delivery-repository.js";
import { RateLimitConfigRepository } from "./repositories/rate-limit-config-repository.js";
import { createWebhookService } from "./services/webhook-service.js";
import { createOntologyCache } from "./services/ontology-cache.js";
import { createSseService } from "./services/sse-service.js";
import { createCircuitBreaker } from "./utils/circuit-breaker.js";
import { createSlidingWindowLimiter } from "./utils/sliding-window-rate-limiter.js";
import { createProxyService } from "./services/proxy-service.js";
import { createProxyRoutes } from "./routes/proxy.js";
import { createWebhookRoutes } from "./routes/webhooks.js";
import { createSseRoutes } from "./routes/sse.js";
import { createDataRoutes } from "./routes/data.js";
import { createAdminRoutes } from "./routes/admin.js";
import { createHealthRoutes } from "./routes/health.js";

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
  const config = loadConfig();
  const masterKey = loadMasterKey();
  const serviceStartedAt = new Date();

  // Step 1: Database
  const db = createDbClient({
    connectionString: config.OP_DATABASE_URL,
    maxConnections: 20,
  });

  // Step 2: Redis (primary + separate for pub/sub)
  const redis = createRedisClient({
    url: config.OP_REDIS_URL,
  });

  // Step 3: Run migrations
  const migrationResult = await runMigrations(db);
  if (migrationResult.applied.length > 0) {
    console.info("Gateway migrations applied:", migrationResult.applied);
  }

  // Step 4: Logger
  const logger = createLogger({
    serviceName: "gateway-service",
    redis,
  });

  // Step 5: Repositories
  const webhookRepo = new WebhookRepository(db);
  const deliveryRepo = new WebhookDeliveryRepository(db);
  const rateLimitConfigRepo = new RateLimitConfigRepository(db);

  // Step 6: Services
  const webhookService = createWebhookService({
    webhookRepo,
    deliveryRepo,
    masterKey,
    logger,
  });

  const ontologyServiceUrl = process.env["ONTOLOGY_SERVICE_URL"] ?? "http://ontology-service:3003";
  const ontologyCache = createOntologyCache({
    logger,
    ontologyServiceUrl,
  });

  const proxyService = createProxyService();
  const sseService = createSseService({ logger });

  // Step 7: Rate limiter
  const rateLimiter = createSlidingWindowLimiter({
    redis,
    windowMs: 60_000,
    fallbackReplicaCount: parseInt(process.env["OP_GATEWAY_REPLICAS"] ?? "1", 10),
  });

  // Step 8: Circuit breakers (one per upstream service)
  const failureThreshold = parseInt(process.env["OP_CIRCUIT_BREAKER_THRESHOLD"] ?? "5", 10);
  const resetTimeoutMs = parseInt(process.env["OP_CIRCUIT_BREAKER_RESET_MS"] ?? "10000", 10);
  const serviceNames = ["auth", "ingestion", "ontology", "pipeline", "execution", "app", "logging", "plugin"];
  const circuitBreakers = new Map(
    serviceNames.map((name) => [
      name,
      createCircuitBreaker({ failureThreshold, resetTimeoutMs }),
    ]),
  );

  // Step 9: Load service public keys
  const servicePublicKeys = await loadServicePublicKeys();

  // Step 10: Create Hono app
  const serviceToken = process.env["OP_SERVICE_TOKEN"];

  const app = createApp({
    serviceName: "gateway-service",
    version: "0.0.0",
    jwtSecret: config.OP_JWT_SECRET,
    redis,
    validateApiKey: async () => null,
    allowedOrigins: config.OP_ALLOWED_ORIGINS,
    publicRoutes: [
      "/healthz",
      "/readyz",
    ],
    targetService: "gateway-service",
    servicePublicKeys,
  });

  // Step 11: Register routes
  const healthRoutes = createHealthRoutes({ pool: db, redis, serviceStartedAt });
  app.route("/", healthRoutes);

  const webhookRoutes = createWebhookRoutes({ webhookService, deliveryRepo });
  app.route("/api/v1/webhooks", webhookRoutes);

  const sseRoutes = createSseRoutes({
    sseService,
    maxConnectionsPerKey: parseInt(process.env["OP_SSE_MAX_CONNECTIONS_PER_KEY"] ?? "10", 10),
  });
  app.route("/api/v1/events", sseRoutes);

  const ingestionBreaker = circuitBreakers.get("ingestion");
  const dataRoutes = createDataRoutes({
    ontologyCache,
    proxyService,
    ingestionServiceUrl: process.env["INGESTION_SERVICE_URL"] ?? "http://ingestion-service:3002",
    ...(ingestionBreaker ? { circuitBreaker: ingestionBreaker } : {}),
    ...(serviceToken ? { serviceToken } : {}),
  });
  app.route("/api/v1/data", dataRoutes);

  const adminRoutes = createAdminRoutes({ rateLimitConfigRepo });
  app.route("/api/v1/admin", adminRoutes);

  const proxyRoutes = createProxyRoutes({
    proxyService,
    circuitBreakers,
    ...(serviceToken ? { serviceToken } : {}),
  });
  app.route("/", proxyRoutes);

  // Step 12: Start pub/sub listeners
  ontologyCache.startSafetyPoll();
  ontologyCache.startPubSubListener(redis);
  sseService.startPubSubListener(redis);

  // Start HTTP server
  const port = parseInt(process.env["PORT"] ?? "3000", 10);

  const server = createServer(
    (req: IncomingMessage, res: ServerResponse): void => {
      const url = `http://${req.headers["host"] ?? "localhost"}${req.url ?? "/"}`;

      const chunks: Buffer[] = [];
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
    logger.info("Gateway service started", { port });
  });

  // Graceful shutdown
  process.on("SIGTERM", () => {
    ontologyCache.stopSafetyPoll();
    ontologyCache.stopPubSubListener();
    sseService.stopPubSubListener();
    server.close();
    void db.end();
    void redis.quit();
  });
}

main().catch((err: unknown) => {
  console.error("Gateway service failed to start:", err);
  process.exit(1);
});
