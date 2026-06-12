import pg from "pg";
// Import from compiled dist/ — required for runMigrations() path resolution (B5)
import { createServiceApp } from "../../dist/index.js";

/**
 * Creates a Level 1 test instance of the logging service.
 * Background jobs (pub/sub listener, audit BullMQ worker, retention scheduler,
 * partition scheduler) are disabled to avoid timer leaks and Redis-subscriber
 * connection exhaustion during tests.
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
    // Absent serviceKeysDir — loadServicePublicKeys() returns {} on ENOENT
    // startBackgroundJobs defaults to true so must be explicitly set false
    startBackgroundJobs: false,
  });

  return { app, cleanup, db };
}
