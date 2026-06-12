// Import from compiled dist/ — required for runMigrations() path resolution (B5)
import { createServiceApp } from "../../dist/index.js";

/**
 * Creates a Level 1 test instance of the gateway service.
 * The gateway does not have background workers; pub/sub listeners are started
 * inside createServiceApp() and are cleaned up via the returned cleanup function.
 */
export async function buildTestApp() {
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

  return { app, cleanup };
}
