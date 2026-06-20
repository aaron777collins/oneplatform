import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Queue, Worker } from "bullmq";
import {
  loadConfig,
  appConfigSchema,
  createDbClient,
  createRedisClient,
  createLogger,
  createApp,
  loadMasterKey,
  createServiceTokenSigner,
  loadServicePrivateKey,
  readPackageVersion,
  setupProcessErrorHandlers,
} from "@oneplatform/core";
import { runMigrations } from "./db/migrate.js";
import {
  AppRepository,
  VersionRepository,
  AppVersionRepository,
  DeploymentRepository,
  PermissionRepository,
  WidgetRepository,
  EmbedTokenRepository,
} from "./repositories/index.js";
import {
  createAppService,
  createBuildService,
  createDeployService,
  createPermissionService,
  createWidgetService,
  createEmbedService,
  createAppVersionService,
} from "./services/index.js";
import {
  createHealthRoutes,
  createAppRoutes,
  createVersionRoutes,
  createAppVersionRoutes,
  createDeploymentRoutes,
  createInternalRoutes,
  createEmbedManagementRoutes,
  createEmbedServeRoutes,
} from "./routes/index.js";
import { createBffRoutes } from "./routes/bff.js";
import type { AppRepository as AppRepositoryType } from "./repositories/app-repository.js";

// ---------------------------------------------------------------------------
// HTML escape — prevents XSS when app name is interpolated into <title> (W11)
// ---------------------------------------------------------------------------

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------------
// AWS Signature V4 helpers for MinIO — same pattern as plugin/bundle-service
// Avoids the heavy @aws-sdk/client-s3 dependency.
// ---------------------------------------------------------------------------

function toHex(buf: Buffer): string {
  return buf.toString("hex");
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function formatDate(d: Date): string {
  return d.toISOString().replace(/[:\-]|\.\d{3}/g, "").slice(0, 8);
}

function formatDatetime(d: Date): string {
  return d.toISOString().replace(/[:\-]|\.\d{3}/g, "").slice(0, 15) + "Z";
}

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function buildMinioGetHeaders(params: {
  url:       string;
  accessKey: string;
  secretKey: string;
  region:    string;
}): Record<string, string> {
  const { url, accessKey, secretKey, region } = params;
  const parsed   = new URL(url);
  const now      = new Date();
  const date     = formatDate(now);
  const datetime = formatDatetime(now);

  const allHeaders: Record<string, string> = {
    host:                   parsed.host,
    "x-amz-date":           datetime,
    "x-amz-content-sha256": EMPTY_SHA256,
  };

  const sortedNames   = Object.keys(allHeaders).sort();
  const canonicalHdrs = sortedNames.map((k) => `${k.toLowerCase()}:${allHeaders[k]!.trim()}`).join("\n") + "\n";
  const signedHdrs    = sortedNames.map((k) => k.toLowerCase()).join(";");

  const canonicalQS = parsed.search
    ? parsed.search.slice(1).split("&").sort().join("&")
    : "";

  const canonicalRequest = [
    "GET", parsed.pathname, canonicalQS, canonicalHdrs, signedHdrs, EMPTY_SHA256,
  ].join("\n");

  const credScope = `${date}/${region}/s3/aws4_request`;
  const strToSign = [
    "AWS4-HMAC-SHA256", datetime, credScope, sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate     = hmacSha256("AWS4" + secretKey, date);
  const kRegion   = hmacSha256(kDate, region);
  const kService  = hmacSha256(kRegion, "s3");
  const signingKey = hmacSha256(kService, "aws4_request");
  const signature = toHex(hmacSha256(signingKey, strToSign));

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKey}/${credScope}, ` +
    `SignedHeaders=${signedHdrs}, Signature=${signature}`;

  // Omit 'host' — the fetch runtime sets it automatically
  return {
    "x-amz-date":           datetime,
    "x-amz-content-sha256": EMPTY_SHA256,
    Authorization:          authorization,
  };
}

// ---------------------------------------------------------------------------
// Service public key loader — same pattern as pipeline service
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
// Guest session rate limiting — 20 requests per IP per minute via Redis (B5)
// ---------------------------------------------------------------------------

async function checkGuestRateLimit(
  redis: ReturnType<typeof createRedisClient>,
  ip: string
): Promise<boolean> {
  const key    = `rate:guest-session:${ip}`;
  // Use a pipeline to make INCR + EXPIRE atomic, preventing the case where
  // EXPIRE fails after INCR and the key persists forever without a TTL.
  const pipeline = redis.pipeline();
  pipeline.incr(key);
  pipeline.expire(key, 60);
  const results = await pipeline.exec();
  // results[0] is the INCR result: [error, value]
  const count = (results?.[0]?.[1] as number) ?? 1;
  return count <= 20;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ServiceApp {
  app: ReturnType<typeof createApp>;
  cleanup: () => Promise<void>;
}

export interface AppConfig {
  databaseUrl: string;
  redisUrl: string;
  jwtSecret: string;
  masterKey: Buffer;
  allowedOrigins: string[];
  authServiceUrl: string;
  executionServiceUrl: string;
  baseUrl: string;
  minioEndpoint: string;
  minioAccessKey: string;
  minioSecretKey: string;
  minioRegion: string;
  buildRetentionCount: number;
  serviceKeysDir: string;
  /** When false, BullMQ workers are not started (useful in test environments). Defaults to true. */
  startWorkers?: boolean;
}

// ---------------------------------------------------------------------------
// Factory — wires all dependencies, returns the Hono app and a cleanup fn.
// main() is the only caller in production; tests can call this directly.
// ---------------------------------------------------------------------------

export async function createServiceApp(config: AppConfig): Promise<ServiceApp> {
  const serviceStartedAt = new Date();
  const version = readPackageVersion(import.meta.url);

  const {
    databaseUrl,
    redisUrl,
    jwtSecret,
    masterKey,
    allowedOrigins,
    authServiceUrl,
    executionServiceUrl,
    baseUrl,
    minioEndpoint,
    minioAccessKey,
    minioSecretKey,
    minioRegion,
    buildRetentionCount,
    serviceKeysDir,
    startWorkers = true,
  } = config;

  const minioBucket = "op-app-artifacts";

  // Step 1: Create DB and Redis clients
  const db = createDbClient({
    connectionString: databaseUrl,
    maxConnections: 15,  // transaction-mode PgBouncer, pool 15 per design spec
  });

  const redis = createRedisClient({ url: redisUrl });

  // Step 2: Run DB migrations
  const migrationResult = await runMigrations(db);
  if (migrationResult.applied.length > 0) {
    console.info("App service migrations applied:", migrationResult.applied);
  }

  // Step 3: Create logger
  const logger = createLogger({ serviceName: "app-service", redis });
  setupProcessErrorHandlers(logger);

  // Redis error handling — degraded mode, not fatal
  redis.on("error", (err: Error) => {
    logger.error("Redis connection error", { error: err.message });
  });

  // Step 4: Instantiate repositories
  const appRepo          = new AppRepository(db);
  const fileRepo         = new VersionRepository(db);
  const appVersionRepo   = new AppVersionRepository(db);
  const buildRepo        = new DeploymentRepository(db);
  const permRepo         = new PermissionRepository(db);
  const widgetRepo       = new WidgetRepository(db);
  const embedTokenRepo   = new EmbedTokenRepository(db);

  // Step 5: Create services
  const appService = createAppService({ appRepo, fileRepo, logger });

  const privateKeyPem = await loadServicePrivateKey("app-service", serviceKeysDir);
  const serviceTokenSigner = await createServiceTokenSigner("app-service", privateKeyPem);

  const buildService = createBuildService({
    pool: db,
    appRepo,
    fileRepo,
    buildRepo,
    permRepo,
    redis,
    executionServiceUrl,
    masterKey,
    logger,
    serviceTokenSigner,
  });

  const deployService = createDeployService({
    appRepo,
    buildRepo,
    permRepo,
    redis,
    authServiceUrl,
    baseUrl,
    logger,
    serviceTokenSigner,
  });

  const permService = createPermissionService({ appRepo, permRepo, logger, masterKey });

  // Widget service — persisted to Postgres, in-memory Map used as a read cache (M-15)
  const widgetService = createWidgetService({ widgetRepo, logger });

  // App version service — G-072
  const appVersionService = createAppVersionService({
    appVersionRepo,
    fileRepo,
    appRepo,
    logger,
  });

  // Embed token service — G-071.
  // Derive a dedicated signing secret from the master key with a distinct context
  // label.  This ensures the embed JWT secret is cryptographically separate from
  // the user auth JWT secret even though both originate from the same master key.
  const embedSecret = new Uint8Array(
    createHash("sha256")
      .update(masterKey)
      .update("embed-token-v1")
      .digest()
  );

  const embedService = createEmbedService({
    embedTokenRepo,
    appRepo,
    embedSecret,
    baseUrl,
    logger,
  });

  // Step 5b: Run startup tasks before the HTTP server accepts traffic.
  // recoverInterruptedBuilds cleans up stale build records; initialize seeds the
  // widget cache so list() is correct from the first request after restart.
  await Promise.all([
    buildService.recoverInterruptedBuilds(),
    widgetService.initialize(),
  ]);

  // Step 6: Start BullMQ retention worker AND enqueue repeating job (W1).
  // The worker exists to consume jobs; we must also enqueue a repeating job
  // otherwise the worker sits idle and retention never runs.
  const retentionQueueName = "queue:app:retention";
  let retentionWorker: Worker | undefined;
  let retentionQueue: Queue | undefined;

  if (startWorkers) {
    retentionQueue = new Queue(retentionQueueName, {
      connection:        { url: redisUrl },
      defaultJobOptions: { attempts: 3, backoff: { type: "exponential", delay: 5_000 } },
    });

    // Upsert the repeating job so restarts are idempotent (repeat key is stable)
    await retentionQueue.upsertJobScheduler(
      "daily-retention-cleanup",
      { every: 24 * 60 * 60 * 1_000 },
      {
        name: "retention-cleanup",
        data: { retentionCount: buildRetentionCount },
        opts: { removeOnComplete: { count: 10 }, removeOnFail: { count: 100 } },
      }
    );

    retentionWorker = new Worker(
      retentionQueueName,
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
  }

  // Step 7: Load service public keys for inter-service JWT verification
  const servicePublicKeys = await loadServicePublicKeys(serviceKeysDir);
  logger.info("Service public keys loaded", { count: Object.keys(servicePublicKeys).length });

  // Readiness gate — set true after all startup steps complete
  let serviceReady = true;

  // Step 8: Create Hono app via core factory (attaches full middleware stack)
  const honoApp = createApp({
    serviceName:    "app-service",
    version,
    jwtSecret,
    redis,
    validateApiKey: async () => null,
    allowedOrigins,
    publicRoutes:   [
      "/healthz",
      "/readyz",
      // Embed serve route — auth is enforced by the embed token itself, not the
      // user session middleware.  The token IS the credential for this route.
      "/api/v1/embed/:token",
    ],
    targetService:  "app-service",
    servicePublicKeys,
  });

  // Step 9: Register routes (specific before catch-all)

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

  // App version control routes — G-072
  const appVersionRoutes = createAppVersionRoutes({ appVersionService, appService });
  honoApp.route("/api/v1/apps/:appId", appVersionRoutes);

  const deploymentRoutes = createDeploymentRoutes({ deployService });
  honoApp.route("/api/v1/apps/:appId", deploymentRoutes);

  // Internal service-to-service routes (protected by service token middleware)
  const internalRoutes = createInternalRoutes({ appService, appRepo, permRepo });
  honoApp.route("/internal", internalRoutes);

  // BFF routes — expose composite data endpoints for the in-app SDK (B3)
  // Design spec §§3.9, 8
  const bffRoutes = createBffRoutes({
    appRepo,
    permRepo,
    permService,
    authServiceUrl,
    masterKey,
    redis,
    logger,
    serviceTokenSigner,
  });
  honoApp.route("/bff", bffRoutes);

  // Embed routes — G-071
  // Management routes require user auth (handled by global auth middleware).
  // The serve route is intentionally public — the token is the credential.
  const embedManagementRoutes = createEmbedManagementRoutes({
    embedService,
    appService,
    baseUrl,
  });
  honoApp.route("/api/v1/apps/:appId/embed", embedManagementRoutes);

  const embedServeRoutes = createEmbedServeRoutes({
    embedService,
    appService,
    baseUrl,
  });
  // Register serve route as a public route so the auth middleware skips it.
  // The token-based auth is enforced inside the handler itself.
  honoApp.route("/api/v1/embed", embedServeRoutes);

  // ---------------------------------------------------------------------------
  // App serving routes — HTML shell + bundle proxy
  // Design spec §7
  // ---------------------------------------------------------------------------

  honoApp.get("/apps/:slug/*", async (c) => {
    const slug    = c.req.param("slug");
    const rawPath = c.req.url.split(`/apps/${slug}/`)[1] ?? "";

    // Prevent path traversal attacks. Reject any rawPath containing '..'
    // segments that could escape the app's directory in MinIO.
    const decodedPath = decodeURIComponent(rawPath);
    if (decodedPath.split("/").some((seg) => seg === ".." || seg === ".")) {
      return c.json(
        { error: { code: "INVALID_PATH", message: "Path traversal is not allowed." } },
        400
      );
    }

    // Resolve app by slug — check public first, then require a validated
    // session for platform-user apps (B4).
    let tenantApp = await appRepo.findPublicBySlug(slug);

    if (tenantApp === null) {
      // Attempt to find a platform-user app with this slug.
      // A session is required; resolve the tenant from the validated JWT user.
      const user = c.var.user;
      if (user === undefined) {
        // No authenticated session — redirect to login with return_to parameter
        const loginUrl = `${authServiceUrl}/login?return_to=${encodeURIComponent(c.req.url)}`;
        return c.redirect(loginUrl, 302);
      }
      tenantApp = await (appRepo as AppRepositoryType).findByTenantAndSlug(user.tenantId, slug);
    }

    if (tenantApp === null) {
      return c.json(
        { error: { code: "APP_NOT_FOUND", message: `App "${slug}" not found.` } },
        404
      );
    }

    // For public apps, issue or validate a guest session cookie (B5)
    if (tenantApp.access_mode === "public") {
      const existingGuestSession = c.req.header("cookie")
        ?.split(";")
        .find((part) => part.trim().startsWith("op_guest_session="));

      if (existingGuestSession === undefined) {
        // Rate-limit guest session issuance per IP to prevent abuse
        const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
        const allowed = await checkGuestRateLimit(redis, ip);
        if (!allowed) {
          return c.json(
            { error: { code: "GUEST_SESSION_RATE_LIMITED", message: "Too many guest session requests. Try again in a minute." } },
            429
          );
        }

        const guestServiceToken = await serviceTokenSigner.sign();
        const guestResponse = await fetch(`${authServiceUrl}/internal/auth/guest-sessions`, {
          method:  "POST",
          headers: {
            "Content-Type":    "application/json",
            "X-Service-Token": guestServiceToken,
          },
          body: JSON.stringify({
            appId:    tenantApp.id,
            tenantId: tenantApp.tenant_id,
          }),
        });

        if (guestResponse.ok) {
          const guestData = await guestResponse.json() as { token?: string };
          if (guestData.token !== undefined) {
            // Set the guest session cookie; HttpOnly + SameSite=Lax
            // Sanitize slug in Path to prevent cookie attribute injection via semicolons.
            const safeCookieSlug = encodeURIComponent(slug);
            c.header(
              "Set-Cookie",
              `op_guest_session=${guestData.token}; Path=/apps/${safeCookieSlug}; HttpOnly; SameSite=Lax; Max-Age=86400`
            );
          }
        }
        // Non-fatal: serve the public app even if guest session issuance fails
      }
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
      const configJsonRaw = JSON.stringify({
        appId:     tenantApp.id,
        tenantId:  tenantApp.tenant_id,
        appSlug:   slug,
        bffOrigin: "",
      });
      // Defense-in-depth: escape "</script>" sequences in the JSON blob to prevent
      // XSS injection when the config is interpolated inside a <script> tag.
      const configJson = configJsonRaw.replace(/</g, '\\u003c');

      // Generate a per-request nonce for the inline config script so the CSP
      // script-src directive can whitelist exactly this script without 'unsafe-inline'.
      const nonce = randomBytes(16).toString("base64");

      // W11: escape the app name to prevent XSS via injected HTML in the title tag
      const html = [
        `<!DOCTYPE html>`,
        `<html lang="en">`,
        `<head>`,
        `  <meta charset="UTF-8">`,
        `  <meta name="viewport" content="width=device-width, initial-scale=1.0">`,
        `  <title>${escapeHtml(tenantApp.name)}</title>`,
        `</head>`,
        `<body>`,
        `  <div id="app"></div>`,
        `  <script nonce="${nonce}">`,
        `    window.__OP_APP_CONFIG__ = ${configJson};`,
        `  </script>`,
        `  <script type="module" src="/apps/${slug}/bundle.js?v=${buildId}"></script>`,
        `</body>`,
        `</html>`,
      ].join("\n");

      return c.html(html, 200, {
        "Cache-Control":           "no-cache, must-revalidate",
        "X-Content-Type-Options":  "nosniff",
        "Content-Security-Policy": `default-src 'self'; script-src 'self' 'nonce-${nonce}'; connect-src 'self'; style-src 'self' 'unsafe-inline'`,
      });
    }

    // ETag conditional GET support
    const ifNoneMatch = c.req.header("If-None-Match");
    if (ifNoneMatch === `"${buildId}"`) {
      return new Response(null, { status: 304 });
    }

    // Proxy bundle from MinIO with AWS Sig V4 authentication (B2).
    // Presigned URLs are never exposed to the browser.
    const key      = `${tenantApp.tenant_id}/${tenantApp.id}/builds/${buildId}/${rawPath}`;
    const minioUrl = `${minioEndpoint}/${minioBucket}/${key}`;

    const signedHeaders = buildMinioGetHeaders({
      url:       minioUrl,
      accessKey: minioAccessKey,
      secretKey: minioSecretKey,
      region:    minioRegion,
    });

    const minioResp = await fetch(minioUrl, { headers: signedHeaders }).catch(() => null);
    if (minioResp === null || !minioResp.ok) {
      return c.json(
        { error: { code: "APP_NO_ACTIVE_BUILD", message: "Build artifact not available." } },
        503
      );
    }

    // Map file extensions to proper MIME types so browsers handle CSS, fonts,
    // images, etc. correctly instead of treating everything as JS or JSON.
    const MIME_TYPES: Record<string, string> = {
      '.js':    'application/javascript',
      '.mjs':   'application/javascript',
      '.json':  'application/json',
      '.css':   'text/css',
      '.html':  'text/html',
      '.svg':   'image/svg+xml',
      '.png':   'image/png',
      '.jpg':   'image/jpeg',
      '.jpeg':  'image/jpeg',
      '.gif':   'image/gif',
      '.woff':  'font/woff',
      '.woff2': 'font/woff2',
      '.ttf':   'font/ttf',
      '.map':   'application/json',
    };
    const ext = rawPath.substring(rawPath.lastIndexOf('.'));
    const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';

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

    // Check public apps first; platform-user apps require an authenticated session.
    let appRow = await appRepo.findPublicBySlug(slug);

    if (appRow === null) {
      const user = c.var.user;
      if (user === undefined) {
        return c.json({ error: { code: "UNAUTHORIZED", message: "Authentication required." } }, 401);
      }
      appRow = await (appRepo as AppRepositoryType).findByTenantAndSlug(user.tenantId, slug);
    }

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
      clearInterval(keepAlive);
      void writer.close();
      void sub.unsubscribe(channel).catch(() => {});
      void sub.quit();
    });

    const keepAlive = setInterval(() => {
      void writer.write(encoder.encode(": keepalive\n\n")).catch(() => {
        clearInterval(keepAlive);
        void sub.unsubscribe(channel).catch(() => {});
        void sub.quit();
      });
    }, 30_000);

    c.req.raw.signal.addEventListener("abort", () => {
      clearInterval(keepAlive);
      void sub.unsubscribe(channel).catch(() => {});
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

  const cleanup = async (): Promise<void> => {
    serviceReady = false;
    if (retentionWorker !== undefined) {
      await retentionWorker.close();
    }
    if (retentionQueue !== undefined) {
      await retentionQueue.close();
    }
    await Promise.all([db.end(), redis.quit()]);
  };

  return { app: honoApp, cleanup };
}

// ---------------------------------------------------------------------------
// Main startup sequence — design spec §1.3
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Step 1: Load config and master key once at startup (W10 — never call
  // loadMasterKey() per-request; it reads a file on each invocation).
  const config    = loadConfig(appConfigSchema);
  const masterKey = loadMasterKey();

  const appConfig: AppConfig = {
    databaseUrl:        process.env["DATABASE_URL"]       ?? config.OP_DATABASE_URL,
    redisUrl:           process.env["REDIS_URL"]          ?? config.OP_REDIS_URL,
    jwtSecret:          config.OP_JWT_SECRET,
    masterKey,
    allowedOrigins:     config.OP_ALLOWED_ORIGINS,
    authServiceUrl:     process.env["AUTH_SERVICE_URL"]      ?? "http://auth-service:3001",
    executionServiceUrl: process.env["EXECUTION_SERVICE_URL"] ?? "http://execution-service:3005",
    baseUrl:            process.env["OP_BASE_URL"]           ?? "http://localhost:3000",
    minioEndpoint:      process.env["OP_MINIO_ENDPOINT"]    ?? process.env["MINIO_ENDPOINT"]   ?? "http://minio:9000",
    minioAccessKey:     process.env["OP_MINIO_ACCESS_KEY"]  ?? process.env["MINIO_ACCESS_KEY"] ?? "minioadmin",
    minioSecretKey:     process.env["OP_MINIO_SECRET_KEY"]  ?? process.env["MINIO_SECRET_KEY"] ?? "minioadmin",
    minioRegion:        process.env["OP_MINIO_REGION"]      ?? process.env["MINIO_REGION"]     ?? "us-east-1",
    buildRetentionCount: parseInt(process.env["APP_BUILD_RETENTION_COUNT"] ?? "20", 10),
    serviceKeysDir:     process.env["OP_SERVICE_KEYS_DIR"] ?? "/data/service-keys",
    startWorkers:       true,
  };

  const { app, cleanup } = await createServiceApp(appConfig);

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

        const responseOrPromise = app.fetch(fetchRequest);

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
            }).catch((err: unknown) => {
              console.error("Unhandled error reading response body:", err);
              if (!res.headersSent) {
                res.writeHead(500, { "Content-Type": "text/plain" });
              }
              res.end("Internal Server Error");
            });
          }
        };

        if (responseOrPromise instanceof Promise) {
          void responseOrPromise.then(handleResponse).catch((err: unknown) => {
            console.error("Unhandled error in app.fetch:", err);
            if (!res.headersSent) {
              res.writeHead(500, { "Content-Type": "text/plain" });
            }
            res.end("Internal Server Error");
          });
        } else {
          handleResponse(responseOrPromise);
        }
      });
    }
  );

  server.listen(port, () => {
    console.info("App service started", { port, buildRetentionCount: appConfig.buildRetentionCount });
  });

  // SIGTERM handler with 30s hard-exit fallback
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
          console.info("App service graceful shutdown complete");
          process.exit(0);
        })
        .catch(() => process.exit(1));
    });
  });
}

main().catch((err: unknown) => {
  console.error("App service failed to start:", err);
  process.exit(1);
});
