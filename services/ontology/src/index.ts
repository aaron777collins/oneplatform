import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  loadConfig,
  ontologyConfigSchema,
  createDbClient,
  createRedisClient,
  createLogger,
  createEventPublisher,
  createApp,
  loadMasterKey,
  createServiceTokenSigner,
  loadServicePrivateKey,
  readPackageVersion,
  setupProcessErrorHandlers,
} from "@oneplatform/core";
import { runMigrations } from "./db/migrate.js";
import {
  createEntityRepository,
  createFieldRepository,
  createRelationshipRepository,
  createMappingRuleRepository,
  createMigrationRepository,
  createShadowRegistryRepository,
  createMappingErrorRepository,
  createDraftRepository,
} from "./repositories/index.js";
import { createEntityService } from "./services/entity-service.js";
import { createRelationshipService } from "./services/relationship-service.js";
import { createMappingService } from "./services/mapping-service.js";
import { createMigrationService } from "./services/migration-service.js";
import { createCacheService } from "./services/cache-service.js";
import { createInferenceService } from "./services/inference-service.js";
import { createCleanupService } from "./services/cleanup-service.js";
import { createQueryService } from "./services/query-service.js";
import { registerRoutes } from "./routes/index.js";

export interface ServiceApp {
  app: ReturnType<typeof createApp>;
  cleanup: () => Promise<void>;
}

export interface OntologyConfig {
  databaseUrl: string;
  redisUrl: string;
  jwtSecret: string;
  /** Raw key bytes returned by loadMasterKey() */
  masterKey: Buffer;
  allowedOrigins: string[];
  executionServiceUrl: string;
  /** When false, the cleanup background job is not started. Defaults to true. */
  startBackgroundJobs?: boolean;
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

async function healStuckMigrations(
  db: ReturnType<typeof createDbClient>,
  logger: ReturnType<typeof createLogger>,
): Promise<void> {
  const result = await db.query(
    `UPDATE ontology.migrations
     SET status = 'failed',
         error_details = '{"reason": "service_restart"}'::jsonb,
         completed_at = now()
     WHERE status = 'running'
     RETURNING id, entity_id`,
  );
  if (result.rowCount && result.rowCount > 0) {
    logger.warn(`Healed ${result.rowCount} stuck migration(s) on startup`, {
      migrationIds: result.rows.map((r: { id: string }) => r.id),
    });
  }
}

export async function createServiceApp(config: OntologyConfig): Promise<ServiceApp> {
  const startBackgroundJobs = config.startBackgroundJobs ?? true;
  const version = readPackageVersion(import.meta.url);

  // Create infrastructure clients using config values — never reads env directly
  const db = createDbClient({
    connectionString: config.databaseUrl,
    maxConnections: 15,
  });

  const redis = createRedisClient({
    url: config.redisUrl,
  });

  const migrationResult = await runMigrations(db);
  if (migrationResult.applied.length > 0) {
    console.info("Ontology migrations applied:", migrationResult.applied);
  }

  const logger = createLogger({
    serviceName: "ontology-service",
    redis,
  });
  setupProcessErrorHandlers(logger);

  const events = createEventPublisher({ redis });

  // Heal any migrations stuck in 'running' from a previous crash
  await healStuckMigrations(db, logger);

  // Repositories
  const entityRepo = createEntityRepository(db);
  const fieldRepo = createFieldRepository(db);
  const relationshipRepo = createRelationshipRepository(db);
  const mappingRuleRepo = createMappingRuleRepository(db);
  const migrationRepo = createMigrationRepository(db);
  const shadowRegistryRepo = createShadowRegistryRepository(db);
  const mappingErrorRepo = createMappingErrorRepository(db);
  const draftRepo = createDraftRepository(db);

  // Services
  const entityService = createEntityService({
    db, redis, logger,
    entityRepo, fieldRepo, relationshipRepo, migrationRepo,
  });

  const relationshipService = createRelationshipService({
    db, logger,
    entityRepo, fieldRepo, relationshipRepo,
  });

  const migrationService = createMigrationService({
    db, redis, logger,
    migrationRepo, shadowRegistryRepo, entityRepo,
  });

  const cacheService = createCacheService({
    redis, logger,
    entityRepo, fieldRepo, relationshipRepo, migrationRepo,
  });

  const inferenceService = createInferenceService({
    logger, draftRepo,
  });

  // Load the ontology service's own private key to sign outbound calls to the
  // execution service.  Key absence is non-fatal in development (expression
  // transforms will warn but fall back to the source value), so we swallow
  // the error rather than crashing the whole service.
  const serviceKeysDir = process.env["OP_SERVICE_KEYS_DIR"] ?? "/data/service-keys";
  let serviceTokenSigner: Awaited<ReturnType<typeof createServiceTokenSigner>> | undefined;
  try {
    const privateKeyPem = await loadServicePrivateKey("ontology-service", serviceKeysDir);
    serviceTokenSigner = await createServiceTokenSigner("ontology-service", privateKeyPem);
  } catch {
    console.warn("Ontology service: service private key not found — expression transform calls to the execution service will not carry X-Service-Token");
  }

  const mappingService = createMappingService({
    db, redis, logger,
    mappingRuleRepo, mappingErrorRepo, entityRepo, fieldRepo,
    ...(config.executionServiceUrl ? { executionServiceUrl: config.executionServiceUrl } : {}),
    ...(serviceTokenSigner !== undefined ? { serviceTokenSigner } : {}),
  });

  const queryService = createQueryService({
    db, entityRepo, fieldRepo,
  });

  const cleanupService = createCleanupService({
    db, redis, logger, shadowRegistryRepo,
  });

  // Background jobs are optional so tests can wire the app without side-effects
  if (startBackgroundJobs) {
    cleanupService.startBackgroundJob();
  }

  const servicePublicKeys = await loadServicePublicKeys();

  const app = createApp({
    serviceName: "ontology-service",
    version,
    jwtSecret: config.jwtSecret,
    redis,
    validateApiKey: async () => null,
    allowedOrigins: config.allowedOrigins,
    publicRoutes: [
      "/healthz",
      "/readyz",
    ],
    targetService: "ontology-service",
    servicePublicKeys,
  });

  registerRoutes(app, {
    db,
    redis,
    serviceName: "ontology-service",
    version,
    entityService,
    relationshipService,
    migrationService,
    cacheService,
    mappingService,
    inferenceService,
    queryService,
    migrationRepo,
    mappingRuleRepo,
    mappingErrorRepo,
    entityRepo,
    draftRepo,
    servicePublicKeys,
  });

  // Suppress unused-variable warning — events publisher is retained for
  // future route handlers that emit domain events.
  void events;

  const cleanup = async (): Promise<void> => {
    if (startBackgroundJobs) {
      cleanupService.stopBackgroundJob();
    }
    await db.end();
    await redis.quit();
  };

  return { app, cleanup };
}

async function main(): Promise<void> {
  const config = loadConfig(ontologyConfigSchema);
  const masterKey = loadMasterKey();

  const { app, cleanup } = await createServiceApp({
    databaseUrl: config.OP_DATABASE_URL,
    redisUrl: config.OP_REDIS_URL,
    jwtSecret: config.OP_JWT_SECRET,
    masterKey,
    allowedOrigins: config.OP_ALLOWED_ORIGINS,
    executionServiceUrl: process.env["EXECUTION_SERVICE_URL"] ?? "http://execution-service:3005",
  });

  const port = parseInt(process.env["PORT"] ?? "3003", 10);

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
    console.info(`Ontology service started on port ${port}`);
  });

  // Graceful shutdown — close the HTTP server first so no new requests arrive,
  // then run cleanup (close DB pool, quit Redis). A hard-exit timeout ensures
  // the process never hangs indefinitely if cleanup stalls.
  process.on("SIGTERM", () => {
    // Hard-exit after 30 s regardless of cleanup state. The timer is unref'd
    // so it doesn't prevent the event loop from draining if cleanup finishes
    // sooner — the process.exit(0) in the cleanup callback fires first.
    const hardExit = setTimeout(() => {
      console.error("Ontology service: graceful shutdown timed out, forcing exit");
      process.exit(1);
    }, 30_000);
    hardExit.unref();

    server.close(() => {
      void cleanup().then(() => {
        clearTimeout(hardExit);
        process.exit(0);
      }).catch((err: unknown) => {
        console.error("Ontology service: cleanup error during shutdown", err);
        clearTimeout(hardExit);
        process.exit(1);
      });
    });
  });
}

main().catch((err: unknown) => {
  console.error("Ontology service failed to start:", err);
  process.exit(1);
});
