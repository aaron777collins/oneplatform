import type pg from "pg";
import type {
  UploadJobRow,
  CreateUploadJobData,
  UpdateUploadJobData,
} from "./types.js";

const UPLOAD_JOB_COLUMNS = `
  id, tenant_id, connector_id, filename, content_type,
  file_size_bytes, minio_key, status,
  rows_parsed, rows_staged, rows_failed,
  error, inferred_schema, created_by,
  created_at, updated_at, completed_at
`;

export class UploadJobRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(data: CreateUploadJobData): Promise<UploadJobRow> {
    const result = await this.pool.query<UploadJobRow>(
      `INSERT INTO ingestion.upload_jobs
         (tenant_id, connector_id, filename, content_type,
          file_size_bytes, minio_key, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${UPLOAD_JOB_COLUMNS}`,
      [
        data.tenant_id,
        data.connector_id ?? null,
        data.filename,
        data.content_type,
        data.file_size_bytes ?? null,
        data.minio_key ?? null,
        data.status ?? "pending",
        data.created_by,
      ]
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("INSERT INTO ingestion.upload_jobs returned no rows");
    }
    return row;
  }

  async findById(id: string): Promise<UploadJobRow | null> {
    const result = await this.pool.query<UploadJobRow>(
      `SELECT ${UPLOAD_JOB_COLUMNS}
         FROM ingestion.upload_jobs
        WHERE id = $1`,
      [id]
    );
    return result.rows[0] ?? null;
  }

  // Paginated cursor-based list ordered by newest first (created_at DESC)
  // matching the composite index on (tenant_id, created_at DESC).
  async findByTenantId(
    tenantId: string,
    options?: { cursor?: string; limit?: number }
  ): Promise<UploadJobRow[]> {
    const limit = options?.limit ?? 50;
    const cursor = options?.cursor;

    if (cursor !== undefined) {
      // Cursor encodes the created_at + id of the last seen row so the
      // caller keeps stable page position even if new uploads arrive.
      // For simplicity the cursor here is the row id; callers that need
      // created_at-based cursors should use the service layer.
      const result = await this.pool.query<UploadJobRow>(
        `SELECT ${UPLOAD_JOB_COLUMNS}
           FROM ingestion.upload_jobs
          WHERE tenant_id = $1
            AND id < $2
          ORDER BY created_at DESC, id DESC
          LIMIT $3`,
        [tenantId, cursor, limit]
      );
      return result.rows;
    }

    const result = await this.pool.query<UploadJobRow>(
      `SELECT ${UPLOAD_JOB_COLUMNS}
         FROM ingestion.upload_jobs
        WHERE tenant_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT $2`,
      [tenantId, limit]
    );
    return result.rows;
  }

  async updateStatus(
    id: string,
    status: UploadJobRow["status"],
    extra?: {
      error?: string | null;
      completed_at?: Date;
    }
  ): Promise<UploadJobRow | null> {
    const sets: string[] = ["status = $1", "updated_at = now()"];
    const values: unknown[] = [status];
    let idx = 2;

    if (extra !== undefined) {
      if (extra.error !== undefined) {
        sets.push(`error = $${idx++}`);
        values.push(extra.error);
      }
      if (extra.completed_at !== undefined) {
        sets.push(`completed_at = $${idx++}`);
        values.push(extra.completed_at);
      }
    }

    values.push(id);

    const result = await this.pool.query<UploadJobRow>(
      `UPDATE ingestion.upload_jobs
            SET ${sets.join(", ")}
          WHERE id = $${idx}
      RETURNING ${UPLOAD_JOB_COLUMNS}`,
      values
    );
    return result.rows[0] ?? null;
  }

  // findByTenantAndId — tenant-scoped primary key lookup.
  // Returns null for cross-tenant access so callers get a consistent not-found result.
  async findByTenantAndId(tenantId: string, id: string): Promise<UploadJobRow | null> {
    const result = await this.pool.query<UploadJobRow>(
      `SELECT ${UPLOAD_JOB_COLUMNS}
         FROM ingestion.upload_jobs
        WHERE id = $1
          AND tenant_id = $2`,
      [id, tenantId]
    );
    return result.rows[0] ?? null;
  }

  // update — general-purpose update matching the service interface.
  // Delegates to updateProgress which already handles the full UpdateUploadJobData shape.
  async update(id: string, data: UpdateUploadJobData): Promise<UploadJobRow | null> {
    return this.updateProgress(id, data);
  }

  // Increments progress counters and optionally sets inferred_schema.
  // Called after each staging batch so the status endpoint always reflects
  // real-time progress without the parse worker holding a transaction open.
  async updateProgress(id: string, data: UpdateUploadJobData): Promise<UploadJobRow | null> {
    const sets: string[] = ["updated_at = now()"];
    const values: unknown[] = [];
    let idx = 1;

    if (data.status !== undefined) {
      sets.push(`status = $${idx++}`);
      values.push(data.status);
    }
    if (data.file_size_bytes !== undefined) {
      sets.push(`file_size_bytes = $${idx++}`);
      values.push(data.file_size_bytes);
    }
    if (data.minio_key !== undefined) {
      sets.push(`minio_key = $${idx++}`);
      values.push(data.minio_key);
    }
    if (data.rows_parsed !== undefined) {
      sets.push(`rows_parsed = $${idx++}`);
      values.push(data.rows_parsed);
    }
    if (data.rows_staged !== undefined) {
      sets.push(`rows_staged = $${idx++}`);
      values.push(data.rows_staged);
    }
    if (data.rows_failed !== undefined) {
      sets.push(`rows_failed = $${idx++}`);
      values.push(data.rows_failed);
    }
    if (data.error !== undefined) {
      sets.push(`error = $${idx++}`);
      values.push(data.error);
    }
    if (data.inferred_schema !== undefined) {
      sets.push(`inferred_schema = $${idx++}`);
      values.push(JSON.stringify(data.inferred_schema));
    }
    if (data.completed_at !== undefined) {
      sets.push(`completed_at = $${idx++}`);
      values.push(data.completed_at);
    }

    if (sets.length === 1) {
      // Only updated_at — nothing meaningful to update.
      throw new Error(`updateProgress() called with no fields to update for upload job ${id}`);
    }

    values.push(id);

    const result = await this.pool.query<UploadJobRow>(
      `UPDATE ingestion.upload_jobs
            SET ${sets.join(", ")}
          WHERE id = $${idx}
      RETURNING ${UPLOAD_JOB_COLUMNS}`,
      values
    );
    return result.rows[0] ?? null;
  }
}
