import type pg from "pg";
import type {
  AppFileRow,
  CreateFileData,
  UpdateFileData,
} from "./types.js";

const FILE_COLUMNS = `
  id, app_id, path, content, content_hash, file_version, created_at, updated_at, updated_by
`;

// Exposes only the metadata columns — avoids fetching content on list calls.
const FILE_META_COLUMNS = `
  id, app_id, path, content_hash, file_version, created_at, updated_at, updated_by,
  octet_length(content) AS size_bytes
`;

export interface AppFileMetaRow extends Omit<AppFileRow, "content"> {
  size_bytes: number;
}

export class VersionRepository {
  constructor(private readonly pool: pg.Pool) {}

  // Inserts a new file. Returns null if a file with this path already exists
  // for the app (ON CONFLICT DO NOTHING semantics to support optimistic create).
  async create(data: CreateFileData): Promise<AppFileRow | null> {
    const result = await this.pool.query<AppFileRow>(
      `INSERT INTO app.files
         (app_id, path, content, content_hash, updated_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (app_id, path) DO NOTHING
       RETURNING ${FILE_COLUMNS}`,
      [data.app_id, data.path, data.content, data.content_hash, data.updated_by]
    );
    return result.rows[0] ?? null;
  }

  // Optimistic lock update: only succeeds if file_version matches.
  // Returns null when the version check fails (caller should return 409).
  async updateWithVersionCheck(
    appId: string,
    path: string,
    data: UpdateFileData
  ): Promise<AppFileRow | null> {
    const result = await this.pool.query<AppFileRow>(
      `UPDATE app.files
            SET content      = $1,
                content_hash = $2,
                file_version = file_version + 1,
                updated_at   = now(),
                updated_by   = $3
          WHERE app_id       = $4
            AND path         = $5
            AND file_version = $6
      RETURNING ${FILE_COLUMNS}`,
      [data.content, data.content_hash, data.updated_by, appId, path, data.file_version]
    );
    return result.rows[0] ?? null;
  }

  async findByAppAndPath(appId: string, path: string): Promise<AppFileRow | null> {
    const result = await this.pool.query<AppFileRow>(
      `SELECT ${FILE_COLUMNS} FROM app.files WHERE app_id = $1 AND path = $2`,
      [appId, path]
    );
    return result.rows[0] ?? null;
  }

  async listByApp(appId: string): Promise<AppFileMetaRow[]> {
    const result = await this.pool.query<AppFileMetaRow>(
      `SELECT ${FILE_META_COLUMNS} FROM app.files WHERE app_id = $1 ORDER BY path`,
      [appId]
    );
    return result.rows;
  }

  // Returns all file paths and contents for build assembly.
  async getAllFilesForBuild(appId: string): Promise<Pick<AppFileRow, "path" | "content">[]> {
    const result = await this.pool.query<Pick<AppFileRow, "path" | "content">>(
      `SELECT path, content FROM app.files WHERE app_id = $1 ORDER BY path`,
      [appId]
    );
    return result.rows;
  }

  async countByApp(appId: string): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM app.files WHERE app_id = $1",
      [appId]
    );
    return parseInt(result.rows[0]?.count ?? "0", 10);
  }

  async delete(appId: string, path: string): Promise<boolean> {
    const result = await this.pool.query(
      "DELETE FROM app.files WHERE app_id = $1 AND path = $2",
      [appId, path]
    );
    return result.rowCount !== null && result.rowCount > 0;
  }

  // Renames a file within a transaction — atomically updates the path while
  // preserving all other fields. Returns the updated row or null if not found.
  async rename(
    appId: string,
    fromPath: string,
    toPath: string,
    fileVersion: number,
    updatedBy: string
  ): Promise<AppFileRow | null> {
    const result = await this.pool.query<AppFileRow>(
      `UPDATE app.files
            SET path         = $1,
                file_version = file_version + 1,
                updated_at   = now(),
                updated_by   = $2
          WHERE app_id       = $3
            AND path         = $4
            AND file_version = $5
      RETURNING ${FILE_COLUMNS}`,
      [toPath, updatedBy, appId, fromPath, fileVersion]
    );
    return result.rows[0] ?? null;
  }
}
