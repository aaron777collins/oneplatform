// Import from compiled dist/ — required for runMigrations() path resolution (B5)
import { createServiceApp } from "../../dist/index.js";

/**
 * Creates a Level 1 test instance of the plugin service.
 * MinIO verification is skipped — routes that exercise bundle storage
 * (upload/download) will fail at the route level when hit, which is
 * correct behavior for Level 1 tests focused on plugin CRUD and hooks.
 * Workers (the hourly bundle cleanup interval) are disabled.
 */
export async function buildTestApp() {
  const { app, cleanup } = await createServiceApp({
    databaseUrl: process.env["OP_DATABASE_URL"]!,
    redisUrl: process.env["OP_REDIS_URL"]!,
    jwtSecret: process.env["OP_JWT_SECRET"]!,
    masterKey: Buffer.from(process.env["OP_MASTER_KEY"]!, "base64"),
    allowedOrigins: ["http://localhost:3000"],
    s3Endpoint: "http://localhost:9000",
    s3AccessKey: "minioadmin",
    s3SecretKey: "minioadmin",
    s3Region: "us-east-1",
    bundleBucket: "plugin-bundles",
    executionServiceUrl: "http://localhost:13005",
    ingestionServiceUrl: "http://localhost:13002",
    serviceToken: process.env["OP_SERVICE_TOKEN_SECRET"] ?? "test-service-token",
    retentionDays: 7,
    drainGraceSeconds: 5,
    // Non-existent dir — loadServicePublicKeys() returns {} on ENOENT silently
    serviceKeysDir: "/tmp/nonexistent-service-keys",
    // Skip MinIO ping — bundle-storage routes fail gracefully when exercised
    skipMinioVerification: true,
    // Skip hourly cleanup interval to avoid timer leaks
    startWorkers: false,
  });

  return { app, cleanup };
}
