import type pg from "pg";
import type { AppVersionRow, CreateAppVersionData } from "./types.js";

// Columns selected on every read — version_number is an int, files_snapshot is
// parsed by the pg driver as a JS object because the column type is JSONB.
const VERSION_COLUMNS = `
  id, app_id, version_number, files_snapshot, message, created_by, created_at
`;

export interface ListVersionsOptions {
  cursor?: string;  // last seen created_at (ISO string) for keyset pagination
  limit:   number;
}

export class AppVersionRepository {
  constructor(private readonly pool: pg.Pool) {}

  // Insert a new version for the app. version_number is assigned by taking
  // MAX(version_number) + 1 inside the INSERT so there is no separate counter
  // table and the unique constraint on (app_id, version_number) prevents races.
  // When two concurrent inserts read the same MAX, one will hit the unique
  // constraint (Postgres error 23505); we retry up to 3 times so the caller
  // receives the created row rather than an unhandled 500.
  // Returns the newly created row.
  async create(data: CreateAppVersionData): Promise<AppVersionRow> {
    const MAX_RETRIES = 3;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const result = await this.pool.query<AppVersionRow>(
          `INSERT INTO app.app_versions
             (app_id, version_number, files_snapshot, message, created_by)
           VALUES (
             $1,
             COALESCE(
               (SELECT MAX(version_number) FROM app.app_versions WHERE app_id = $1),
               0
             ) + 1,
             $2::jsonb,
             $3,
             $4
           )
           RETURNING ${VERSION_COLUMNS}`,
          [
            data.app_id,
            JSON.stringify(data.files_snapshot),
            data.message ?? null,
            data.created_by,
          ]
        );

        const row = result.rows[0];
        if (row === undefined) {
          throw new Error(`Failed to insert version for app ${data.app_id}`);
        }
        return row;
      } catch (err) {
        // Postgres unique_violation — concurrent insert claimed this version_number
        const pgErr = err as { code?: string };
        if (pgErr.code === "23505" && attempt < MAX_RETRIES) {
          continue;
        }
        throw err;
      }
    }
    throw new Error(`Failed to insert version for app ${data.app_id} after ${MAX_RETRIES} attempts`);
  }

  // Keyset pagination ordered by created_at DESC (most-recent first).
  // cursor is the created_at ISO string of the last item from the previous page.
  async listByApp(appId: string, options: ListVersionsOptions): Promise<AppVersionRow[]> {
    if (options.cursor !== undefined) {
      const result = await this.pool.query<AppVersionRow>(
        `SELECT ${VERSION_COLUMNS}
           FROM app.app_versions
          WHERE app_id    = $1
            AND created_at < $2::timestamptz
          ORDER BY created_at DESC
          LIMIT $3`,
        [appId, options.cursor, options.limit]
      );
      return result.rows;
    }

    const result = await this.pool.query<AppVersionRow>(
      `SELECT ${VERSION_COLUMNS}
         FROM app.app_versions
        WHERE app_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [appId, options.limit]
    );
    return result.rows;
  }

  async countByApp(appId: string): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM app.app_versions WHERE app_id = $1",
      [appId]
    );
    return parseInt(result.rows[0]?.count ?? "0", 10);
  }

  async findByAppAndVersion(appId: string, versionNumber: number): Promise<AppVersionRow | null> {
    const result = await this.pool.query<AppVersionRow>(
      `SELECT ${VERSION_COLUMNS}
         FROM app.app_versions
        WHERE app_id         = $1
          AND version_number = $2`,
      [appId, versionNumber]
    );
    return result.rows[0] ?? null;
  }

  // Delete the oldest versions exceeding the cap. Called after each insert so
  // the table never grows beyond maxVersions rows per app.
  async pruneOldest(appId: string, maxVersions: number): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM app.app_versions
        WHERE app_id = $1
          AND id NOT IN (
            SELECT id
              FROM app.app_versions
             WHERE app_id = $1
             ORDER BY version_number DESC
             LIMIT $2
          )`,
      [appId, maxVersions]
    );
    return result.rowCount ?? 0;
  }
}
