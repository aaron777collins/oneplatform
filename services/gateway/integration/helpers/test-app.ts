import pg from "pg";
// Import from compiled dist/ — required for runMigrations() path resolution (B5)
import { createServiceApp } from "../../dist/index.js";

/**
 * Creates a Level 1 test instance of the gateway service.
 * The gateway does not have background workers; pub/sub listeners are started
 * inside createServiceApp() and are cleaned up via the returned cleanup function.
 *
 * Returns app + cleanup + db; callers must call cleanup() and db.end() in afterAll.
 * The db pool is for direct cleanup queries only — the service owns its own pool.
 */
export async function buildTestApp() {
  // Separate pool for cleanup queries — superuser credentials bypass RLS.
  const db = new pg.Pool({
    connectionString: process.env["OP_DATABASE_URL"]!,
    max: 3,
    idleTimeoutMillis: 10_000,
  });

  const { app, cleanup } = await createServiceApp({
    databaseUrl: process.env["OP_DATABASE_URL"]!,
    redisUrl: process.env["OP_REDIS_URL"]!,
    jwtSecret: process.env["OP_JWT_SECRET"]!,
    masterKey: Buffer.from(process.env["OP_MASTER_KEY"]!, "base64"),
    allowedOrigins: ["http://localhost:3000"],
    ontologyServiceUrl: "http://localhost:13003",
    ingestionServiceUrl: "http://localhost:13002",
    // Generous limits for tests — avoids rate-limit interference
    rateLimitPerMinute: 10000,
    replicaCount: 1,
    circuitBreakerThreshold: 50,
    circuitBreakerResetMs: 1000,
    sseMaxConnectionsPerKey: 10,
  });

  return { app, cleanup, db };
}
