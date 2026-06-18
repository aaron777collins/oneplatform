import type pg from "pg";
import type {
  GdprRequestRow,
  CreateGdprRequestData,
  UpdateGdprRequestData,
} from "./types.js";

const GDPR_REQUEST_COLUMNS = `
  id, tenant_id, user_id, type, status, requester_id,
  requested_at, completed_at, result_url, error_detail
`;

export class GdprRequestRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(data: CreateGdprRequestData): Promise<GdprRequestRow> {
    const result = await this.pool.query<GdprRequestRow>(
      `INSERT INTO gateway.gdpr_requests
         (tenant_id, user_id, type, requester_id)
       VALUES ($1, $2, $3, $4)
       RETURNING ${GDPR_REQUEST_COLUMNS}`,
      [data.tenant_id, data.user_id, data.type, data.requester_id],
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("INSERT INTO gateway.gdpr_requests returned no rows");
    }
    return row;
  }

  async findById(id: string): Promise<GdprRequestRow | null> {
    const result = await this.pool.query<GdprRequestRow>(
      `SELECT ${GDPR_REQUEST_COLUMNS}
         FROM gateway.gdpr_requests
        WHERE id = $1`,
      [id],
    );
    return result.rows[0] ?? null;
  }

  // Returns all requests for a tenant, most-recent first.
  // Optional filters narrow to a specific user_id or status.
  async findByTenantId(
    tenantId: string,
    options?: {
      userId?: string;
      status?: string;
      cursor?: string;
      limit?: number;
    },
  ): Promise<GdprRequestRow[]> {
    const limit = options?.limit ?? 50;
    const conditions: string[] = ["tenant_id = $1"];
    const values: unknown[] = [tenantId];
    let idx = 2;

    if (options?.userId !== undefined) {
      conditions.push(`user_id = $${idx++}`);
      values.push(options.userId);
    }
    if (options?.status !== undefined) {
      conditions.push(`status = $${idx++}`);
      values.push(options.status);
    }
    // Cursor-based pagination: requested_at + id tuple ensures stable ordering
    // even when multiple requests share the same millisecond timestamp.
    if (options?.cursor !== undefined) {
      // Cursor encodes "<requested_at_iso>|<id>" to allow efficient keyset pagination.
      const [cursorTs, cursorId] = options.cursor.split("|");
      if (cursorTs !== undefined && cursorId !== undefined) {
        conditions.push(
          `(requested_at, id) < ($${idx++}::timestamptz, $${idx++}::uuid)`,
        );
        values.push(cursorTs, cursorId);
      }
    }

    values.push(limit);
    const result = await this.pool.query<GdprRequestRow>(
      `SELECT ${GDPR_REQUEST_COLUMNS}
         FROM gateway.gdpr_requests
        WHERE ${conditions.join(" AND ")}
        ORDER BY requested_at DESC, id DESC
        LIMIT $${idx}`,
      values,
    );
    return result.rows;
  }

  async updateStatus(id: string, data: UpdateGdprRequestData): Promise<GdprRequestRow | null> {
    const sets: string[] = ["status = $2"];
    const values: unknown[] = [id, data.status];
    let idx = 3;

    if (data.completed_at !== undefined) {
      sets.push(`completed_at = $${idx++}`);
      values.push(data.completed_at);
    }
    if (data.result_url !== undefined) {
      sets.push(`result_url = $${idx++}`);
      values.push(data.result_url);
    }
    if (data.error_detail !== undefined) {
      sets.push(`error_detail = $${idx++}`);
      values.push(data.error_detail);
    }

    const result = await this.pool.query<GdprRequestRow>(
      `UPDATE gateway.gdpr_requests
            SET ${sets.join(", ")}
          WHERE id = $1
      RETURNING ${GDPR_REQUEST_COLUMNS}`,
      values,
    );
    return result.rows[0] ?? null;
  }
}
