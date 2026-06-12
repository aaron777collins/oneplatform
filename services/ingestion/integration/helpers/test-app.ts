// Import from compiled dist/ — required for runMigrations() path resolution (B5)
import { createServiceApp } from "../../dist/index.js";

/**
 * Creates a Level 1 test instance of the ingestion service.
 * BullMQ workers and retention scheduler are disabled to avoid
 * consuming Redis connections and leaving dangling timers.
 */
export async function buildTestApp() {
  const { app, cleanup } = await createServiceApp({
    databaseUrl: process.env["OP_DATABASE_URL"]!,
    redisUrl: process.env["OP_REDIS_URL"]!,
    jwtSecret: process.env["OP_JWT_SECRET"]!,
    masterKey: Buffer.from(process.env["OP_MASTER_KEY"]!, "base64"),
    allowedOrigins: ["http://localhost:3000"],
    executionServiceUrl: "http://localhost:13005",
    baseUrl: "http://localhost:3000",
    // Skip BullMQ workers so Level 1 tests don't consume additional Redis connections
    startWorkers: false,
  });

  return { app, cleanup };
}
