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
        }),
    );

    return keys;
  } catch {
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

export interface GatewayConfig {
  databaseUrl: string;
  redisUrl: string;
  jwtSecret: string;
  masterKey: Buffer;
  allowedOrigins: string[];
  /** URL of the upstream ontology service. */
  ontologyServiceUrl: string;
  /** URL of the upstream ingestion service. */
  ingestionServiceUrl: string;
  /** Bearer token for outbound service-to-service requests. */
  serviceToken?: string;
  /** Directory containing peer service public key files. Defaults to /data/service-keys. */
  serviceKeysDir?: string;
  /** Requests per minute before rate limiting kicks in. Defaults to 1000. */
  rateLimitPerMinute?: number;
  /** Number of gateway replicas used by the sliding-window limiter. Defaults to 1. */
  replicaCount?: number;
  /** Number of failures before a circuit breaker opens. Defaults to 5. */
  circuitBreakerThreshold?: number;
  /** Milliseconds before an open circuit breaker resets. Defaults to 10000. */
  circuitBreakerResetMs?: number;
  /** Max SSE connections per key. Defaults to 10. */
  sseMaxConnectionsPerKey?: number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export async function createServiceApp(config: GatewayConfig): Promise<ServiceApp> {
  const serviceKeysDir = config.serviceKeysDir ?? "/data/service-keys";
  const serviceStartedAt = new Date();

  // Step 1: Database
  const db = createDbClient({
    connectionString: config.databaseUrl,
    maxConnections: 20,
  });

  // Step 2: Redis (primary + separate for pub/sub)
  const redis = createRedisClient({
    url: config.redisUrl,
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
    masterKey: config.masterKey,
    logger,
  });

  const ontologyCache = createOntologyCache({
    logger,
    ontologyServiceUrl: config.ontologyServiceUrl,
    ...(config.serviceToken !== undefined ? { serviceToken: config.serviceToken } : {}),
  });

  const proxyService = createProxyService();
  const sseService = createSseService({ logger });

  // Step 7: Rate limiter
  const rateLimiter = createSlidingWindowLimiter({
    redis,
    windowMs: 60_000,
    fallbackReplicaCount: config.replicaCount ?? 1,
  });

  // Step 8: Circuit breakers (one per upstream service)
  const failureThreshold = config.circuitBreakerThreshold ?? 5;
  const resetTimeoutMs = config.circuitBreakerResetMs ?? 10_000;
  // Names must match SERVICE_MAP keys in proxy-service.ts exactly so that
  // circuitBreakers.get(resolved.serviceName) finds the correct breaker.
  const serviceNames = [
    "auth",
    "connectors",
    "webhooks/inbound",
    "uploads",
    "ontology",
    "pipelines",
    "pipeline-runs",
    "schedules",
    "exec",
    "apps",
    "logs",
    "audit-events",
    "plugins",
    "roles",
  ];
  const circuitBreakers = new Map(
    serviceNames.map((name) => [
      name,
      createCircuitBreaker({ failureThreshold, resetTimeoutMs }),
    ]),
  );

  // Step 9: Load service public keys
  const servicePublicKeys = await loadServicePublicKeys(serviceKeysDir);

  // Step 10: Create Hono app
  const app = createApp({
    serviceName: "gateway-service",
    version: process.env["OP_SERVICE_VERSION"] ?? "0.0.0-dev",
    jwtSecret: config.jwtSecret,
    redis,
    validateApiKey: async () => null,
    allowedOrigins: config.allowedOrigins,
    publicRoutes: [
      "/healthz",
      "/readyz",
    ],
    targetService: "gateway-service",
    servicePublicKeys,
  });

  // Step 10.5: Wire rate limiter as middleware on all routes.
  // Health check endpoints are excluded so liveness probes never get throttled.
  const rateLimitPerMinute = config.rateLimitPerMinute ?? 1000;
  app.use("*", async (c, next) => {
    const path = new URL(c.req.url).pathname;
    // Skip rate limiting for health probes to prevent probe self-throttling
    if (path === "/healthz" || path === "/readyz") {
      await next();
      return;
    }

    // Key per tenant; falls back to actual TCP source IP so unauthenticated
    // paths (e.g. auth login) still receive basic protection.
    // X-Forwarded-For is intentionally NOT used as a fallback — it is a
    // client-controlled header that can be spoofed to bypass rate limiting.
    const user = c.var.user;
    const sourceIp = c.req.raw.socket?.remoteAddress ?? "unknown";
    const key = user?.tenantId ?? sourceIp;
    const result = await rateLimiter.check(`gateway:${key}`, rateLimitPerMinute);

    if (!result.allowed) {
      return c.json(
        { error: { code: "RATE_LIMIT_EXCEEDED", message: "Rate limit exceeded. Please slow down and retry." } },
        429,
        {
          "Retry-After": String(result.resetAt - Math.floor(Date.now() / 1000)),
          "X-RateLimit-Limit": String(rateLimitPerMinute),
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": String(result.resetAt),
        },
      );
    }

    c.header("X-RateLimit-Limit", String(rateLimitPerMinute));
    c.header("X-RateLimit-Remaining", String(result.remaining));
    c.header("X-RateLimit-Reset", String(result.resetAt));
    await next();
  });

  // Step 11: Register routes
  const healthRoutes = createHealthRoutes({ pool: db, redis, serviceStartedAt });
  app.route("/", healthRoutes);

  const webhookRoutes = createWebhookRoutes({ webhookService, deliveryRepo });
  app.route("/api/v1/webhooks", webhookRoutes);

  const sseRoutes = createSseRoutes({
    sseService,
    maxConnectionsPerKey: config.sseMaxConnectionsPerKey ?? 10,
  });
  app.route("/api/v1/events", sseRoutes);

  // "connectors" is the SERVICE_MAP key for the ingestion service
  const ingestionBreaker = circuitBreakers.get("connectors");
  const dataRoutes = createDataRoutes({
    ontologyCache,
    proxyService,
    ingestionServiceUrl: config.ingestionServiceUrl,
    ...(ingestionBreaker !== undefined ? { circuitBreaker: ingestionBreaker } : {}),
    ...(config.serviceToken !== undefined ? { serviceToken: config.serviceToken } : {}),
  });
  app.route("/api/v1/data", dataRoutes);

  const adminRoutes = createAdminRoutes({ rateLimitConfigRepo });
  app.route("/api/v1/admin", adminRoutes);

  const proxyRoutes = createProxyRoutes({
    proxyService,
    circuitBreakers,
    ...(config.serviceToken !== undefined ? { serviceToken: config.serviceToken } : {}),
  });
  app.route("/", proxyRoutes);

  // Step 12: Start pub/sub listeners
  ontologyCache.startSafetyPoll();
  ontologyCache.startPubSubListener(redis);
  sseService.startPubSubListener(redis);

  const cleanup = async (): Promise<void> => {
    ontologyCache.stopSafetyPoll();
    ontologyCache.stopPubSubListener();
    sseService.stopPubSubListener();
    await db.end();
    await redis.quit();
  };

  return { app, cleanup };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const config = loadConfig();
  const masterKey = loadMasterKey();

  const serviceToken = process.env["OP_SERVICE_TOKEN"];

  const { app, cleanup } = await createServiceApp({
    databaseUrl: config.OP_DATABASE_URL,
    redisUrl: config.OP_REDIS_URL,
    jwtSecret: config.OP_JWT_SECRET,
    masterKey,
    allowedOrigins: config.OP_ALLOWED_ORIGINS,
    ontologyServiceUrl: process.env["ONTOLOGY_SERVICE_URL"] ?? "http://ontology-service:3003",
    ingestionServiceUrl: process.env["INGESTION_SERVICE_URL"] ?? "http://ingestion-service:3002",
    ...(serviceToken !== undefined ? { serviceToken } : {}),
    rateLimitPerMinute: parseInt(process.env["OP_RATE_LIMIT_PER_MIN"] ?? "1000", 10),
    replicaCount: parseInt(process.env["OP_GATEWAY_REPLICAS"] ?? "1", 10),
    circuitBreakerThreshold: parseInt(process.env["OP_CIRCUIT_BREAKER_THRESHOLD"] ?? "5", 10),
    circuitBreakerResetMs: parseInt(process.env["OP_CIRCUIT_BREAKER_RESET_MS"] ?? "10000", 10),
    sseMaxConnectionsPerKey: parseInt(process.env["OP_SSE_MAX_CONNECTIONS_PER_KEY"] ?? "10", 10),
  });

  // Start HTTP server
  const port = parseInt(process.env["PORT"] ?? "3000", 10);

  const server = createServer(
    (req: IncomingMessage, res: ServerResponse): void => {
      const url = `http://${req.headers["host"] ?? "localhost"}${req.url ?? "/"}`;

      // Surface request-level errors (e.g. client abort, socket reset) so
      // they appear in logs rather than crashing the process with an uncaught
      // exception that Node emits when an 'error' event has no listener.
      req.on("error", (err) => {
        console.warn("Inbound request error", { error: err.message });
        if (!res.headersSent) {
          res.writeHead(400);
        }
        res.end();
      });

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

          // SSE and other streaming responses have a ReadableStream body.
          // Buffering the entire stream via arrayBuffer() would block until
          // the stream closes (never, for SSE) so we pipe chunk-by-chunk.
          if (response.body instanceof ReadableStream) {
            const reader = response.body.getReader();
            const pump = (): void => {
              reader.read().then(({ done, value }) => {
                if (done) {
                  res.end();
                  return;
                }
                res.write(value, () => pump());
              }).catch(() => {
                res.end();
              });
            };
            pump();
          } else {
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
    console.info(`Gateway service started on port ${port}`);
  });

  // Surface server-level socket / bind errors so they appear in logs
  // rather than causing an unhandled 'error' event crash.
  server.on("error", (err) => {
    console.error("HTTP server error", { error: err.message });
  });

  // Graceful shutdown: stop accepting new connections, wait up to 10 s for
  // in-flight requests to complete before force-closing, then tear down
  // backing resources (pub/sub, DB pool, Redis).
  process.on("SIGTERM", () => {
    console.info("SIGTERM received — starting graceful shutdown");

    const DRAIN_TIMEOUT_MS = parseInt(
      process.env["OP_SHUTDOWN_DRAIN_MS"] ?? "10000",
      10,
    );

    const drainTimeout = setTimeout(() => {
      console.warn("Drain timeout reached — forcing shutdown");
      void cleanup().then(() => process.exit(1));
    }, DRAIN_TIMEOUT_MS);

    server.close(() => {
      clearTimeout(drainTimeout);
      void cleanup().then(() => process.exit(0));
    });
  });
}

main().catch((err: unknown) => {
  console.error("Gateway service failed to start:", err);
  process.exit(1);
});
