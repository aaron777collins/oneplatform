import { readFile, readdir } from "node:fs/promises";
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
  AppRepository,
  VersionRepository,
  DeploymentRepository,
  PermissionRepository,
} from "./repositories/index.js";
import {
  createAppService,
  createBuildService,
  createDeployService,
  createPermissionService,
  createWidgetService,
} from "./services/index.js";
import {
  createHealthRoutes,
  createAppRoutes,
  createVersionRoutes,
  createDeploymentRoutes,
  createInternalRoutes,
} from "./routes/index.js";

// ---------------------------------------------------------------------------
// Service public key loader — same pattern as pipeline service
// ---------------------------------------------------------------------------

async function loadServicePublicKeys(): Promise<Record<string, string>> {
  try {
    const dir = process.env["SERVICE_KEYS_DIR"] ?? "/data/service-keys";
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
// Main startup sequence — design spec §1.3
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const serviceStartedAt = new Date();

  // Step 1: Load config and master key
  const config = loadConfig();
  const masterKey = loadMasterKey();
  void masterKey;  // available for encryption calls in services

  const databaseUrl = process.env["DATABASE_URL"] ?? config.OP_DATABASE_URL;
  const redisUrl    = process.env["REDIS_URL"]    ?? config.OP_REDIS_URL;

  const authServiceUrl      = process.env["AUTH_SERVICE_URL"]      ?? "http://auth-service:3001";
  const executionServiceUrl = process.env["EXECUTION_SERVICE_URL"] ?? "http://execution-service:3005";
  const baseUrl             = process.env["OP_BASE_URL"]           ?? "http://localhost:3000";

  const buildRetentionCount = parseInt(
    process.env["APP_BUILD_RETENTION_COUNT"] ?? "20", 10
  );

  // Step 2: Create DB and Redis clients
  const db = createDbClient({
    connectionString: databaseUrl,
    maxConnections: 15,  // transaction-mode PgBouncer, pool 15 per design spec
  });

  const redis = createRedisClient({ url: redisUrl });

  // Step 3: Run DB migrations
  const migrationResult = await runMigrations(db);
  if (migrationResult.applied.length > 0) {
    console.info("App service migrations applied:", migrationResult.applied);
  }

  // Step 4: Create logger
  const logger = createLogger({ serviceName: "app-service", redis });

  // Redis error handling — degraded mode, not fatal
  redis.on("error", (err: Error) => {
    logger.error("Redis connection error", { error: err.message });
  });

  // Step 5: Instantiate repositories
  const appRepo   = new AppRepository(db);
  const fileRepo  = new VersionRepository(db);
  const buildRepo = new DeploymentRepository(db);
  const permRepo  = new PermissionRepository(db);

  // Step 6: Create services
  const appService = createAppService({ appRepo, fileRepo, logger });

  const buildService = createBuildService({
    pool: db,
    appRepo,
    fileRepo,
    buildRepo,
    permRepo,
    redis,
    executionServiceUrl,
    logger,
  });

  const deployService = createDeployService({
    appRepo,
    buildRepo,
    permRepo,
    redis,
    authServiceUrl,
    baseUrl,
    logger,
  });

  const permService = createPermissionService({ appRepo, permRepo, logger });

  // Widget service — in-memory registry for plugin widget registration
  createWidgetService({ logger });

  // Step 7: Start BullMQ retention worker (runs daily cleanup per design spec §5.7)
  const retentionWorker = new Worker(
    "queue:app:retention",
    async () => {
      await buildService.runRetentionCleanup(buildRetentionCount);
    },
    {
      connection:       { url: redisUrl },
      concurrency:      1,
      removeOnComplete: { count: 10 },
      removeOnFail:     { count: 100 },
    }
  );

  logger.info("App retention worker started", { buildRetentionCount });

  // Step 8: Load service public keys for inter-service JWT verification
  const servicePublicKeys = await loadServicePublicKeys();
  logger.info("Service public keys loaded", { count: Object.keys(servicePublicKeys).length });

  // Readiness gate — set true after all startup steps complete
  let serviceReady = true;

  // Step 9: Create Hono app via core factory (attaches full middleware stack)
  const honoApp = createApp({
    serviceName:    "app-service",
    version:        "1.0.0",
    jwtSecret:      config.OP_JWT_SECRET,
    redis,
    validateApiKey: async () => null,
    allowedOrigins: config.OP_ALLOWED_ORIGINS,
    publicRoutes:   ["/healthz", "/readyz"],
    targetService:  "app-service",
    servicePublicKeys,
  });

  // Step 10: Register routes (specific before catch-all)

  const healthRoutes = createHealthRoutes({
    pool: db,
    redis,
    serviceStartedAt,
    isReady: () => serviceReady,
    authServiceUrl,
  });
  honoApp.route("/", healthRoutes);

  const appRoutes = createAppRoutes({ appService, permService, fileRepo });
  honoApp.route("/api/v1/apps", appRoutes);

  // Build/version and deployment routes are nested under /api/v1/apps/:appId
  const versionRoutes = createVersionRoutes({ appService, buildService, redis });
  honoApp.route("/api/v1/apps/:appId", versionRoutes);

  const deploymentRoutes = createDeploymentRoutes({ deployService });
  honoApp.route("/api/v1/apps/:appId", deploymentRoutes);

  // Internal service-to-service routes (protected by service token middleware)
  const internalRoutes = createInternalRoutes({ appService, permRepo });
  honoApp.route("/internal", internalRoutes);

  // ---------------------------------------------------------------------------
  // App serving routes — HTML shell + bundle proxy
  // Design spec §7
  // ---------------------------------------------------------------------------

  honoApp.get("/apps/:slug/*", async (c) => {
    const slug  = c.req.param("slug");
    const rawPath = c.req.url.split(`/apps/${slug}/`)[1] ?? "";

    // Resolve app by slug — public apps first, then tenant-scoped
    const tenantApp = await appRepo.findPublicBySlug(slug);

    if (tenantApp === null) {
      return c.json(
        { error: { code: "APP_NOT_FOUND", message: `App "${slug}" not found.` } },
        404
      );
    }

    if (tenantApp.current_build_id === null) {
      return c.json(
        { error: { code: "APP_NO_ACTIVE_BUILD", message: `App "${slug}" has no active build deployed.` } },
        503
      );
    }

    const buildId = tenantApp.current_build_id;

    // HTML shell for index request (design spec §7.2)
    if (rawPath === "" || rawPath === "/") {
      const configJson = JSON.stringify({
        appId:     tenantApp.id,
        tenantId:  tenantApp.tenant_id,
        bffOrigin: "",
      });

      const html = [
        `<!DOCTYPE html>`,
        `<html lang="en">`,
        `<head>`,
        `  <meta charset="UTF-8">`,
        `  <meta name="viewport" content="width=device-width, initial-scale=1.0">`,
        `  <title>${tenantApp.name}</title>`,
        `</head>`,
        `<body>`,
        `  <div id="app"></div>`,
        `  <script>`,
        `    window.__OP_APP_CONFIG__ = ${configJson};`,
        `  </script>`,
        `  <script type="module" src="/apps/${slug}/bundle.js?v=${buildId}"></script>`,
        `</body>`,
        `</html>`,
      ].join("\n");

      return c.html(html, 200, {
        "Cache-Control":           "no-cache, must-revalidate",
        "X-Content-Type-Options":  "nosniff",
        "Content-Security-Policy": "default-src 'self'; script-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'",
      });
    }

    // ETag conditional GET support
    const ifNoneMatch = c.req.header("If-None-Match");
    if (ifNoneMatch === `"${buildId}"`) {
      return new Response(null, { status: 304 });
    }

    // Proxy bundle from MinIO (presigned URL never exposed to browser)
    const endpoint = process.env["MINIO_ENDPOINT"] ?? "http://minio:9000";
    const bucket   = "op-app-artifacts";
    const key      = `${tenantApp.tenant_id}/${tenantApp.id}/builds/${buildId}/${rawPath}`;
    const minioUrl = `${endpoint}/${bucket}/${key}`;

    const minioResp = await fetch(minioUrl).catch(() => null);
    if (minioResp === null || !minioResp.ok) {
      return c.json(
        { error: { code: "APP_NO_ACTIVE_BUILD", message: "Build artifact not available." } },
        503
      );
    }

    const contentType = rawPath.endsWith(".json")
      ? "application/json"
      : "application/javascript";

    return new Response(minioResp.body, {
      status: 200,
      headers: {
        "Content-Type":            contentType,
        "Cache-Control":           "public, max-age=31536000, immutable",
        "ETag":                    `"${buildId}"`,
        "X-Content-Type-Options":  "nosniff",
        "Content-Security-Policy": "default-src 'self'; script-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'",
      },
    });
  });

  // Preview hot-reload SSE stream (design spec §11.4)
  honoApp.get("/apps/:slug/preview/reload-stream", async (c) => {
    const slug   = c.req.param("slug");
    const appRow = await appRepo.findPublicBySlug(slug);

    if (appRow === null) {
      return c.json({ error: { code: "APP_NOT_FOUND", message: `App "${slug}" not found.` } }, 404);
    }

    const channel = `app:preview-reload:${appRow.id}`;
    const sub = redis.duplicate();
    await sub.subscribe(channel);

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer  = writable.getWriter();
    const encoder = new TextEncoder();

    sub.on("message", (_ch: string, message: string) => {
      void writer.write(encoder.encode(`event: reload\ndata: ${message}\n\n`));
    });

    sub.on("error", () => {
      void writer.close();
      void sub.quit();
    });

    const keepAlive = setInterval(() => {
      void writer.write(encoder.encode(": keepalive\n\n"));
    }, 30_000);

    c.req.raw.signal.addEventListener("abort", () => {
      clearInterval(keepAlive);
      void sub.quit();
      void writer.close();
    });

    return new Response(readable, {
      headers: {
        "Content-Type":   "text/event-stream",
        "Cache-Control":  "no-cache",
        "Connection":     "keep-alive",
        "X-Build-Status": "preview",
      },
    });
  });

  // Step 11: Start HTTP server on port 3006 (design spec §1.2)
  const port = parseInt(process.env["PORT"] ?? "3006", 10);

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
          method:  req.method ?? "GET",
          headers,
          ...(body !== undefined ? { body } : {}),
        });

        const responseOrPromise = honoApp.fetch(fetchRequest);

        const handleResponse = (response: Response): void => {
          const contentType = response.headers.get("content-type") ?? "";
          if (contentType.includes("text/event-stream") && response.body !== null) {
            res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
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
            res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
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
    }
  );

  server.listen(port, () => {
    logger.info("App service started", { port, buildRetentionCount });
  });

  // Step 12: SIGTERM handler with 30s hard-exit fallback
  process.on("SIGTERM", () => {
    console.info("SIGTERM received — starting graceful shutdown");

    serviceReady = false;

    const shutdownTimeout = setTimeout(() => {
      console.error("Shutdown timeout exceeded — forcing exit");
      process.exit(1);
    }, 30_000);
    shutdownTimeout.unref();

    void retentionWorker.close().then(() => {
      server.close(() => {
        void Promise.all([
          db.end(),
          redis.quit(),
        ]).then(() => {
          clearTimeout(shutdownTimeout);
          console.info("App service graceful shutdown complete");
          process.exit(0);
        });
      });
    });
  });
}

main().catch((err: unknown) => {
  console.error("App service failed to start:", err);
  process.exit(1);
});
