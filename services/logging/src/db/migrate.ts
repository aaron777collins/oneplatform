import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "migrations"
);

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

// Advisory lock key — must be a stable integer shared by all instances of this
// service. Chosen to be memorable and unlikely to collide with other services.
const MIGRATION_ADVISORY_LOCK_KEY = 7_001_001;

export async function runMigrations(pool: pg.Pool): Promise<MigrationResult> {
  // Acquire a session-level advisory lock so that concurrent pod startups
  // (e.g. a rolling deploy) do not race on the version-check/apply loop.
  // pg_advisory_lock blocks until the lock is available; it is released
  // automatically when the client connection is returned to the pool.
  const client = await pool.connect();
  try {
    // Inline the (compile-time constant) lock key rather than binding it as a
    // parameter: a parameterized query uses the extended-query protocol, which
    // PgBouncer in transaction pooling mode breaks with "prepared statement
    // requires 0 parameters". The key is a trusted literal, so there is no
    // injection risk.
    await client.query(`SELECT pg_advisory_lock(${MIGRATION_ADVISORY_LOCK_KEY})`);

    // Bootstrap the migration tracking table under the logging schema.
    // The logging schema itself is created by the first migration SQL file,
    // but we need a place to record which migrations have run — create it here
    // before executing any SQL files.
    await client.query(`
      CREATE SCHEMA IF NOT EXISTS logging;

      CREATE TABLE IF NOT EXISTS logging.schema_migrations (
        version    TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    const appliedResult = await client.query<{ version: string }>(
      "SELECT version FROM logging.schema_migrations ORDER BY version"
    );
    const appliedVersions = new Set(appliedResult.rows.map((r) => r["version"]));

    const allFiles = await readdir(MIGRATIONS_DIR);
    const migrationFiles = allFiles
      .filter((f) => f.endsWith(".sql"))
      .sort();

    const applied: string[] = [];
    const skipped: string[] = [];

    for (const filename of migrationFiles) {
      const version = filename.replace(/\.sql$/, "");

      if (appliedVersions.has(version)) {
        skipped.push(version);
        continue;
      }

      const sql = await readFile(join(MIGRATIONS_DIR, filename), "utf-8");

      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(
          "INSERT INTO logging.schema_migrations (version) VALUES ($1)",
          [version]
        );
        await client.query("COMMIT");
        applied.push(version);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(
          `Migration "${version}" failed — rolling back. Original error: ${String(err)}`
        );
      }
    }

    return { applied, skipped };
  } finally {
    // pg_advisory_unlock is implicit on connection release, but calling it
    // explicitly is clearer and ensures the lock is freed even if the connection
    // is reused rather than closed.
    await client.query(`SELECT pg_advisory_unlock(${MIGRATION_ADVISORY_LOCK_KEY})`).catch(() => {});
    client.release();
  }
}
