// Import from compiled dist/ — required for runMigrations() path resolution (B5)
import { createServiceApp } from "../../dist/index.js";

/**
 * Creates a Level 1 test instance of the auth service.
 * Migrations run once on first call (idempotent via schema_migrations table).
 * Returns app + cleanup; callers must call cleanup() in afterAll.
 */
export async function buildTestApp() {
  const { app, cleanup } = await createServiceApp({
    databaseUrl: process.env["OP_DATABASE_URL"]!,
    redisUrl: process.env["OP_REDIS_URL"]!,
    jwtSecret: process.env["OP_JWT_SECRET"]!,
    // OP_MASTER_KEY is base64-encoded 32 bytes — decode to Buffer before passing
    masterKey: Buffer.from(process.env["OP_MASTER_KEY"]!, "base64"),
    allowedOrigins: ["http://localhost:3000"],
    // Null bypasses filesystem read — no bootstrap.token file needed in tests
    bootstrapToken: null,
    // Absent serviceKeysDir causes loadServicePublicKeys() to return {} silently
  });

  return { app, cleanup };
}
