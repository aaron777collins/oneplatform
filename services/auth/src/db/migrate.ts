/**
 * Migration runner for the Auth Service.
 *
 * Reads .sql files from the migrations/ directory, checks which have already
 * been applied in auth.schema_migrations, and runs unapplied ones in
 * lexicographic order. Idempotent: safe to call on every service startup.
 *
 * WHY a custom runner instead of a third-party tool:
 *   - We need to reuse the pg.Pool already constructed by @oneplatform/core so
 *     connection config doesn't diverge between the migration path and the
 *     runtime path.
 *   - Auth Service migrations are deliberately simple (one initial schema plus
 *     incremental add-column files). A lightweight runner keeps the dependency
 *     surface minimal.
 */

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

/**
 * Run all unapplied migrations in the migrations/ directory.
 *
 * Each migration is wrapped in a transaction so partial failures leave the
 * database clean and the runner can retry on next startup.
 */
export async function runMigrations(pool: pg.Pool): Promise<MigrationResult> {
  // Ensure the tracking table exists before we try to query it.
  // This is safe because the migrator role has CREATE privileges.
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS auth;

    CREATE TABLE IF NOT EXISTS auth.schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const appliedResult = await pool.query<{ version: string }>(
    "SELECT version FROM auth.schema_migrations ORDER BY version"
  );
  const appliedVersions = new Set(appliedResult.rows.map((r) => r["version"]));

  // List and sort migration files so they execute in lexicographic order.
  // File naming convention: {NNN}_{description}.sql — lexicographic order
  // matches chronological order when the numeric prefix is zero-padded.
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

    // Each migration runs in its own transaction. If it fails the entire
    // service startup fails (non-zero exit) — dependent services won't start.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        "INSERT INTO auth.schema_migrations (version) VALUES ($1)",
        [version]
      );
      await client.query("COMMIT");
      applied.push(version);
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(
        `Migration "${version}" failed — rolling back. Original error: ${String(err)}`
      );
    } finally {
      client.release();
    }
  }

  return { applied, skipped };
}
