import type pg from "pg";
import type {
  BuildRow,
  CreateBuildData,
  UpdateBuildData,
} from "./types.js";

const BUILD_COLUMNS = `
  id, app_id, version_number, status, bundle_path, error_message,
  error_detail, build_manifest, built_at, built_by, created_at
`;

export class DeploymentRepository {
  constructor(private readonly pool: pg.Pool) {}

  // Assigns the next version_number inside a transaction using MAX()+1.
  // The advisory lock on app_id (acquired by the service layer) serialises
  // concurrent build triggers for the same app.
  async create(data: CreateBuildData): Promise<BuildRow> {
    const result = await this.pool.query<BuildRow>(
      `INSERT INTO app.builds
         (app_id, version_number, status, built_by)
       VALUES ($1, $2, $3, $4)
       RETURNING ${BUILD_COLUMNS}`,
      [data.app_id, data.version_number, data.status, data.built_by]
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("INSERT INTO app.builds returned no rows");
    }
    return row;
  }

  // Returns the next version_number for an app inside the current transaction.
  async getNextVersionNumber(appId: string): Promise<number> {
    const result = await this.pool.query<{ next_version: string }>(
      `SELECT COALESCE(MAX(version_number), 0) + 1 AS next_version
         FROM app.builds
        WHERE app_id = $1`,
      [appId]
    );
    return parseInt(result.rows[0]?.next_version ?? "1", 10);
  }

  async findById(id: string): Promise<BuildRow | null> {
    const result = await this.pool.query<BuildRow>(
      `SELECT ${BUILD_COLUMNS} FROM app.builds WHERE id = $1`,
      [id]
    );
    return result.rows[0] ?? null;
  }

  async findByAppAndId(appId: string, buildId: string): Promise<BuildRow | null> {
    const result = await this.pool.query<BuildRow>(
      `SELECT ${BUILD_COLUMNS}
         FROM app.builds
        WHERE id = $1 AND app_id = $2`,
      [buildId, appId]
    );
    return result.rows[0] ?? null;
  }

  async findLatestSuccessful(appId: string): Promise<BuildRow | null> {
    const result = await this.pool.query<BuildRow>(
      `SELECT ${BUILD_COLUMNS}
         FROM app.builds
        WHERE app_id = $1 AND status = 'success'
        ORDER BY version_number DESC
        LIMIT 1`,
      [appId]
    );
    return result.rows[0] ?? null;
  }

  async countInProgress(appId: string): Promise<{ count: number; buildId: string | null }> {
    const result = await this.pool.query<{ count: string; id: string | null }>(
      `SELECT COUNT(*) AS count, MIN(id) AS id
         FROM app.builds
        WHERE app_id = $1
          AND status IN ('pending', 'building')`,
      [appId]
    );
    const row = result.rows[0];
    return {
      count: parseInt(row?.count ?? "0", 10),
      buildId: row?.id ?? null,
    };
  }

  async update(id: string, data: UpdateBuildData): Promise<BuildRow | null> {
    const sets: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (data.status !== undefined) {
      sets.push(`status = $${idx++}`);
      values.push(data.status);
    }
    if (data.bundle_path !== undefined) {
      sets.push(`bundle_path = $${idx++}`);
      values.push(data.bundle_path);
    }
    if (data.error_message !== undefined) {
      sets.push(`error_message = $${idx++}`);
      values.push(data.error_message);
    }
    if (data.error_detail !== undefined) {
      sets.push(`error_detail = $${idx++}`);
      values.push(JSON.stringify(data.error_detail));
    }
    if (data.build_manifest !== undefined) {
      sets.push(`build_manifest = $${idx++}`);
      values.push(JSON.stringify(data.build_manifest));
    }
    if (data.built_at !== undefined) {
      sets.push(`built_at = $${idx++}`);
      values.push(data.built_at);
    }

    if (sets.length === 0) {
      throw new Error(`update() called with no fields to update for build ${id}`);
    }

    // app.builds has no updated_at column (see 001_initial_schema.sql) — do not append one
    values.push(id);

    const result = await this.pool.query<BuildRow>(
      `UPDATE app.builds
            SET ${sets.join(", ")}
          WHERE id = $${idx}
      RETURNING ${BUILD_COLUMNS}`,
      values
    );
    return result.rows[0] ?? null;
  }

  async listByApp(
    appId: string,
    options?: { cursor?: string; limit?: number; filterStatus?: string }
  ): Promise<BuildRow[]> {
    const limit = options?.limit ?? 20;
    const conditions: string[] = ["app_id = $1"];
    const values: unknown[] = [appId];
    let idx = 2;

    if (options?.filterStatus !== undefined) {
      conditions.push(`status = $${idx++}`);
      values.push(options.filterStatus);
    }

    if (options?.cursor !== undefined) {
      conditions.push(`id < $${idx++}`);
      values.push(options.cursor);
    }

    values.push(limit);

    const result = await this.pool.query<BuildRow>(
      `SELECT ${BUILD_COLUMNS}
         FROM app.builds
        WHERE ${conditions.join(" AND ")}
        ORDER BY created_at DESC
        LIMIT $${idx}`,
      values
    );
    return result.rows;
  }

  async countByApp(appId: string): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM app.builds WHERE app_id = $1",
      [appId]
    );
    return parseInt(result.rows[0]?.count ?? "0", 10);
  }

  // Counts only builds matching a given status — used when the caller filters
  // listByApp with filterStatus so that pagination totals stay consistent.
  async countByAppAndStatus(appId: string, status: string): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM app.builds WHERE app_id = $1 AND status = $2",
      [appId, status]
    );
    return parseInt(result.rows[0]?.count ?? "0", 10);
  }

  // Returns builds beyond the retention window — used by the cleanup job.
  // The caller is responsible for not including current_build_id.
  async findBeyondRetentionWindow(
    appId: string,
    retainCount: number
  ): Promise<BuildRow[]> {
    const result = await this.pool.query<BuildRow>(
      `SELECT ${BUILD_COLUMNS}
         FROM app.builds
        WHERE app_id = $1
          AND status = 'success'
        ORDER BY version_number DESC
        OFFSET $2`,
      [appId, retainCount]
    );
    return result.rows;
  }

  // Returns failed builds for a specific app older than the given cutoff
  // timestamp. Scoped to appId so the retention cleanup loop does not query
  // across all apps in a single call (V6-168).
  async findFailedOlderThan(appId: string, cutoffDate: Date): Promise<BuildRow[]> {
    const result = await this.pool.query<BuildRow>(
      `SELECT ${BUILD_COLUMNS}
         FROM app.builds
        WHERE app_id = $1
          AND status = 'failed'
          AND created_at < $2`,
      [appId, cutoffDate]
    );
    return result.rows;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.pool.query(
      "DELETE FROM app.builds WHERE id = $1",
      [id]
    );
    return result.rowCount !== null && result.rowCount > 0;
  }
}
