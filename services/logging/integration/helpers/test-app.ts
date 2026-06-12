// Import from compiled dist/ — required for runMigrations() path resolution (B5)
import { createServiceApp } from "../../dist/index.js";

/**
 * Creates a Level 1 test instance of the logging service.
 * Background jobs (pub/sub listener, audit BullMQ worker, retention scheduler,
 * partition scheduler) are disabled to avoid timer leaks and Redis-subscriber
 * connection exhaustion during tests.
 */
export async function buildTestApp() {
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

  return { app, cleanup };
}
