// Import from compiled dist/ — required for runMigrations() path resolution (B5)
import { createServiceApp } from "../../dist/index.js";

/**
 * Creates a Level 1 test instance of the pipeline service.
 * BullMQ workers, cron loop, and event trigger subscriptions are disabled.
 * Advisory lock capability is still verified (requires real PostgreSQL).
 */
export async function buildTestApp() {
  const { app, cleanup } = await createServiceApp({
    databaseUrl: process.env["OP_DATABASE_URL"]!,
    redisUrl: process.env["OP_REDIS_URL"]!,
    jwtSecret: process.env["OP_JWT_SECRET"]!,
    masterKey: Buffer.from(process.env["OP_MASTER_KEY"]!, "base64"),
    allowedOrigins: ["http://localhost:3000"],
    executionServiceUrl: "http://localhost:13005",
    pluginServiceUrl: "http://localhost:13008",
    ingestionServiceUrl: "http://localhost:13002",
    // Skip workers to avoid BullMQ Redis connections and cron timer leaks
    startWorkers: false,
  });

  return { app, cleanup };
}
