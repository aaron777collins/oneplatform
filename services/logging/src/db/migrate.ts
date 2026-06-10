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

export async function runMigrations(pool: pg.Pool): Promise<MigrationResult> {
  // Bootstrap the migration tracking table under the logging schema.
  // The logging schema itself is created by the first migration SQL file,
  // but we need a place to record which migrations have run — create it here
  // before executing any SQL files.
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS logging;

    CREATE TABLE IF NOT EXISTS logging.schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const appliedResult = await pool.query<{ version: string }>(
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

    const client = await pool.connect();
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
    } finally {
      client.release();
    }
  }

  return { applied, skipped };
}
