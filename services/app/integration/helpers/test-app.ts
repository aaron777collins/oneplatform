// Import from compiled dist/ — required for runMigrations() path resolution (B5)
import { createServiceApp } from "../../dist/index.js";

/**
 * Creates a Level 1 test instance of the app service.
 * BullMQ retention worker is disabled to avoid Redis connections and timer leaks.
 * MinIO fields are required by the config type but are not contacted by
 * routes tested at Level 1 (only the app serving bundle-proxy route hits MinIO).
 */
export async function buildTestApp() {
  const { app, cleanup } = await createServiceApp({
    databaseUrl: process.env["OP_DATABASE_URL"]!,
    redisUrl: process.env["OP_REDIS_URL"]!,
    jwtSecret: process.env["OP_JWT_SECRET"]!,
    masterKey: Buffer.from(process.env["OP_MASTER_KEY"]!, "base64"),
    allowedOrigins: ["http://localhost:3000"],
    authServiceUrl: "http://localhost:13001",
    executionServiceUrl: "http://localhost:13005",
    baseUrl: "http://localhost:3000",
    // MinIO is not contacted by CRUD routes tested at Level 1.
    // Level 2/3 tests that exercise bundle serving must bring up MinIO.
    minioEndpoint: "http://localhost:9000",
    minioAccessKey: "minioadmin",
    minioSecretKey: "minioadmin",
    minioRegion: "us-east-1",
    buildRetentionCount: 5,
    // Non-existent dir — loadServicePublicKeys() returns {} on ENOENT silently
    serviceKeysDir: "/tmp/nonexistent-service-keys",
    // Skip BullMQ retention worker to avoid Redis connections and upsertJobScheduler calls
    startWorkers: false,
  });

  return { app, cleanup };
}
