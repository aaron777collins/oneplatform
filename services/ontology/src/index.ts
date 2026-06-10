import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  loadConfig,
  createDbClient,
  createRedisClient,
  createLogger,
  createEventPublisher,
  createApp,
  loadMasterKey,
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
import { registerRoutes } from "./routes/index.js";

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

async function main(): Promise<void> {
  const config = loadConfig();
  const masterKey = loadMasterKey();

  const db = createDbClient({
    connectionString: config.OP_DATABASE_URL,
    maxConnections: 15,
  });

  const redis = createRedisClient({
    url: config.OP_REDIS_URL,
  });

  const migrationResult = await runMigrations(db);
  if (migrationResult.applied.length > 0) {
    console.info("Ontology migrations applied:", migrationResult.applied);
  }

  const logger = createLogger({
    serviceName: "ontology-service",
    redis,
  });

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

  const executionServiceUrl = process.env["EXECUTION_SERVICE_URL"] ?? "http://execution-service:3005";
  const mappingService = createMappingService({
    db, redis, logger,
    mappingRuleRepo, mappingErrorRepo, entityRepo, fieldRepo,
    ...(executionServiceUrl ? { executionServiceUrl } : {}),
  });

  const cleanupService = createCleanupService({
    db, redis, logger, shadowRegistryRepo,
  });

  // Load service public keys for inter-service auth
  const servicePublicKeys = await loadServicePublicKeys();

  // Create Hono app
  const app = createApp({
    serviceName: "ontology-service",
    version: "0.0.0",
    jwtSecret: config.OP_JWT_SECRET,
    redis,
    validateApiKey: async () => null,
    allowedOrigins: config.OP_ALLOWED_ORIGINS,
    publicRoutes: [
      "/healthz",
      "/readyz",
    ],
    targetService: "ontology-service",
    servicePublicKeys,
  });

  // Register routes
  registerRoutes(app, {
    db,
    redis,
    serviceName: "ontology-service",
    version: "0.0.0",
    entityService,
    relationshipService,
    migrationService,
    cacheService,
    mappingService,
    inferenceService,
    migrationRepo,
    mappingRuleRepo,
    entityRepo,
    draftRepo,
    servicePublicKeys,
  });

  // Start background jobs
  cleanupService.startBackgroundJob();

  // Start HTTP server
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
    logger.info("Ontology service started", { port });
  });

  // Graceful shutdown
  process.on("SIGTERM", () => {
    cleanupService.stopBackgroundJob();
    server.close();
    void db.end();
    void redis.quit();
  });
}

main().catch((err: unknown) => {
  console.error("Ontology service failed to start:", err);
  process.exit(1);
});
