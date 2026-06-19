/**
 * Auth Service entry point.
 *
 * Startup sequence (L2 design §4.1, auth-service.md §2):
 *  1. Load config (validates all required env vars via Zod)
 *  2. Load master key from OP_MASTER_KEY env var
 *  3. Read bootstrap token from /data/init/bootstrap.token into memory
 *  4. Create Postgres pool and Redis client
 *  5. Run migrations (idempotent — safe to run on every startup)
 *  6. Instantiate all repositories
 *  7. Instantiate all services (inject repos, db, redis, logger)
 *  8. Create the Hono app via createApp() with the full middleware stack
 *  9. Register all route groups
 * 10. Start the HTTP server on the configured port
 *
 * The bootstrap token file is read into memory here and zeroed after a
 * successful bootstrap call. The service layer only receives closures —
 * it never holds a reference to the raw file path, keeping the erase
 * responsibility with this module.
 */

import { readFile, unlink } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  loadConfig,
  authConfigSchema,
  createDbClient,
  createRedisClient,
  createLogger,
  createEventPublisher,
  createApp,
  loadMasterKey,
  readPackageVersion,
} from "@oneplatform/core";
import { runMigrations } from "./db/migrate.js";
import {
  TenantRepository,
  UserRepository,
  RoleRepository,
  OAuthClientRepository,
  EntityPermissionRepository,
} from "./repositories/index.js";
import {
  createPasswordService,
  createTokenService,
  createAuthService,
  createBootstrapService,
  createApiKeyService,
  createOAuthService,
  createRbacService,
  createGuestSessionService,
  createBrandingService,
} from "./services/index.js";
import { registerRoutes } from "./routes/index.js";

// ---------------------------------------------------------------------------
// Bootstrap token — loaded once at startup, zeroed after use
// ---------------------------------------------------------------------------

const BOOTSTRAP_TOKEN_PATH = "/data/init/bootstrap.token";

async function readBootstrapToken(): Promise<string | null> {
  try {
    const raw = await readFile(BOOTSTRAP_TOKEN_PATH, "utf-8");
    return raw.trim();
  } catch {
    // File may be absent if bootstrap has already completed on a previous run.
    // The service continues; the bootstrap service will surface a 503 if
    // bootstrap is attempted without the token.
    return null;
  }
}

async function eraseBootstrapTokenFile(): Promise<void> {
  try {
    await unlink(BOOTSTRAP_TOKEN_PATH);
  } catch (err) {
    // Best-effort — if the erase fails (e.g. read-only mount after rotation)
    // the security invariant is still maintained by the in-memory zeroing.
    console.warn("Warning: could not erase bootstrap token file:", err);
  }
}

// ---------------------------------------------------------------------------
// Service keys for service-to-service auth
// ---------------------------------------------------------------------------

async function loadServicePublicKeys(dir: string): Promise<Record<string, string>> {
  // In production, peer public keys are written to /data/service-keys/ by the
  // init container. In development they may be absent; we return an empty map
  // so the service starts without crashing — service calls will simply fail auth.
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

export interface AuthConfig {
  databaseUrl: string;
  redisUrl: string;
  jwtSecret: string;
  masterKey: Buffer;
  allowedOrigins: string[];
  /** Bootstrap token read from disk before calling createServiceApp(). Null if bootstrap already completed. */
  bootstrapToken?: string | null;
  /** Directory containing peer service public key files. Defaults to /data/service-keys. */
  serviceKeysDir?: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export async function createServiceApp(config: AuthConfig): Promise<ServiceApp> {
  const serviceKeysDir = config.serviceKeysDir ?? "/data/service-keys";
  const version = readPackageVersion(import.meta.url);

  // Capture token in closure so the in-memory reference can be zeroed without
  // the service layer needing to know about the source file.
  let inMemoryBootstrapToken: string | null = config.bootstrapToken ?? null;
  const getInMemoryToken = (): string | null => inMemoryBootstrapToken;
  const clearInMemoryToken = (): void => {
    inMemoryBootstrapToken = null;
    // Best-effort file erase — do not await; must not block the response.
    void eraseBootstrapTokenFile();
  };

  // Step 1: Create infrastructure clients using config fields, not loadConfig().
  const db = createDbClient({
    connectionString: config.databaseUrl,
    maxConnections: 20,
  });

  const redis = createRedisClient({
    url: config.redisUrl,
  });

  // Step 2: Run database migrations (idempotent).
  const migrationResult = await runMigrations(db);
  if (migrationResult.applied.length > 0) {
    console.info("Migrations applied:", migrationResult.applied);
  }

  // Step 3: Create logger and event publisher.
  const logger = createLogger({
    serviceName: "auth-service",
    redis,
  });

  const events = createEventPublisher({ redis });

  // Step 4: Instantiate repositories.
  const tenantRepository = new TenantRepository(db);
  const userRepository = new UserRepository(db);
  const roleRepository = new RoleRepository(db);
  const oauthClientRepository = new OAuthClientRepository(db);
  const entityPermissionRepository = new EntityPermissionRepository(db);

  // Step 5: Instantiate services (dependency order matters — token and password
  // services have no deps; other services depend on them).
  const passwordService = createPasswordService();

  const tokenService = createTokenService({ redis, db });

  const authService = createAuthService({
    db,
    redis,
    passwordService,
    tokenService,
    logger,
    events,
  });

  const bootstrapService = createBootstrapService({
    db,
    passwordService,
    tokenService,
    logger,
    events,
    getInMemoryToken,
    clearInMemoryToken,
  });

  const apiKeyService = createApiKeyService({ db, redis, logger, events });

  const oauthService = createOAuthService({
    redis,
    db,
    tokenService,
    logger,
    events,
    masterKey: config.masterKey,
    // OAuth provider implementations are registered here when their env vars are present.
    // GitHub and Google providers are wired in a follow-up task; the empty map means
    // OAuth authorize/callback routes return 400 until providers are configured.
    providers: new Map(),
  });

  // RbacService is available for future use by admin routes; it's not injected
  // into routes directly yet since permission checks in auth routes use scopes.
  createRbacService({ db });

  const guestSessionService = createGuestSessionService({ redis });

  const brandingService = createBrandingService({ db });

  // Step 6: Load peer service public keys for service-to-service auth.
  const servicePublicKeys = await loadServicePublicKeys(serviceKeysDir);

  // Step 7: Create the Hono app with the standard middleware stack.
  const app = createApp({
    serviceName: "auth-service",
    version,
    jwtSecret: config.jwtSecret,
    redis,
    validateApiKey: (key) => apiKeyService.validate(key),
    allowedOrigins: config.allowedOrigins,
    // Public routes bypass JWT validation. These must exactly match the route
    // paths registered below (no trailing slashes, no wildcards).
    publicRoutes: [
      "/healthz",
      "/readyz",
      "/api/v1/bootstrap/status",
      "/api/v1/bootstrap/master-key",
      "/api/v1/bootstrap",
      "/api/v1/auth/register",
      "/api/v1/auth/login",
      "/api/v1/auth/forgot-password",
      "/api/v1/auth/refresh",
    ],
    targetService: "auth-service",
    servicePublicKeys,
  });

  // Step 8: Register all route groups.
  registerRoutes(app, {
    // Infrastructure
    db,
    redis,
    serviceName: "auth-service",
    version,
    // Services
    bootstrapService,
    authService,
    tokenService,
    apiKeyService,
    oauthService,
    guestSessionService,
    brandingService,
    // Repositories (used directly by routes that don't need a full service)
    tenantRepository,
    roleRepository,
    userRepository,
    oauthClientRepository,
    entityPermissionRepository,
    // Service-to-service auth keys for /internal/* routes
    servicePublicKeys,
  });

  const cleanup = async (): Promise<void> => {
    await db.end();
    await redis.quit();
  };

  return { app, cleanup };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Step 1: Validate configuration — throws loudly if any required env var is missing.
  const config = loadConfig(authConfigSchema);

  // Step 2: Load master key for AES-256-GCM credential encryption.
  const masterKey = loadMasterKey();

  // Step 3: Read bootstrap token into memory (null if already completed).
  const bootstrapToken = await readBootstrapToken();

  const { app, cleanup } = await createServiceApp({
    databaseUrl: config.OP_DATABASE_URL,
    redisUrl: config.OP_REDIS_URL,
    jwtSecret: config.OP_JWT_SECRET,
    masterKey,
    allowedOrigins: config.OP_ALLOWED_ORIGINS,
    ...(bootstrapToken !== null ? { bootstrapToken } : {}),
  });

  // Step 4: Start the server.
  const port = parseInt(process.env["PORT"] ?? "3001", 10);

  // Wrap the Hono app in a Node.js HTTP server using the Fetch-compatible adapter.
  // Hono's `app.fetch` accepts a Request and returns a Response, so we bridge
  // it to Node's IncomingMessage/ServerResponse manually.
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
    console.info(`Auth service started on port ${port}`);
  });

  process.on("SIGTERM", () => {
    server.close(() => {
      void cleanup().then(() => process.exit(0));
    });
  });
}

main().catch((err: unknown) => {
  console.error("Auth service failed to start:", err);
  process.exit(1);
});
