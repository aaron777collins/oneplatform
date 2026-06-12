import pg from "pg";
// Import from compiled dist/ — required for runMigrations() path resolution (B5)
import { createServiceApp } from "../../dist/index.js";

/**
 * Creates a Level 1 test instance of the auth service.
 * Migrations run once on first call (idempotent via schema_migrations table).
 * Returns app + cleanup + db; callers must call cleanup() and db.end() in afterAll.
 *
 * A separate pg.Pool is returned alongside the service so tests can call
 * cleanupAuthTenant(db, tenantId) in try/finally blocks. The service owns its
 * own internal pool; this one is used only for direct cleanup queries.
 */
export async function buildTestApp() {
  // Separate pool for cleanup queries — uses SUPERUSER credentials so
  // DELETE statements bypass RLS without needing to set app.tenant_id.
  const db = new pg.Pool({
    connectionString: process.env["OP_DATABASE_URL"]!,
    max: 3,
    idleTimeoutMillis: 10_000,
  });

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

  return { app, cleanup, db };
}
