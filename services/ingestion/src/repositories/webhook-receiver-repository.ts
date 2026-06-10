import type pg from "pg";
import type {
  WebhookReceiverRow,
  CreateWebhookReceiverData,
  UpdateWebhookReceiverData,
} from "./types.js";

const WEBHOOK_RECEIVER_COLUMNS = `
  id, tenant_id, connector_id, name, description, path_suffix,
  secret_hash, hmac_algorithm, header_name, is_enabled, created_by,
  created_at, updated_at, deleted_at, last_received_at, events_received
`;

export class WebhookReceiverRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(data: CreateWebhookReceiverData): Promise<WebhookReceiverRow> {
    const result = await this.pool.query<WebhookReceiverRow>(
      `INSERT INTO ingestion.webhook_receivers
         (tenant_id, connector_id, name, description, path_suffix,
          secret_hash, hmac_algorithm, header_name, is_enabled, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING ${WEBHOOK_RECEIVER_COLUMNS}`,
      [
        data.tenant_id,
        data.connector_id ?? null,
        data.name,
        data.description ?? null,
        data.path_suffix,
        data.secret_hash,
        data.hmac_algorithm ?? "sha256",
        data.header_name ?? "X-Webhook-Signature",
        data.is_enabled ?? true,
        data.created_by,
      ]
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("INSERT INTO ingestion.webhook_receivers returned no rows");
    }
    return row;
  }

  async findById(id: string): Promise<WebhookReceiverRow | null> {
    const result = await this.pool.query<WebhookReceiverRow>(
      `SELECT ${WEBHOOK_RECEIVER_COLUMNS}
         FROM ingestion.webhook_receivers
        WHERE id = $1
          AND deleted_at IS NULL`,
      [id]
    );
    return result.rows[0] ?? null;
  }

  // Paginated cursor-based list for a tenant.
  async findByTenantId(
    tenantId: string,
    options?: { cursor?: string; limit?: number }
  ): Promise<WebhookReceiverRow[]> {
    const limit = options?.limit ?? 50;
    const cursor = options?.cursor;

    if (cursor !== undefined) {
      const result = await this.pool.query<WebhookReceiverRow>(
        `SELECT ${WEBHOOK_RECEIVER_COLUMNS}
           FROM ingestion.webhook_receivers
          WHERE tenant_id = $1
            AND deleted_at IS NULL
            AND id > $2
          ORDER BY created_at ASC, id ASC
          LIMIT $3`,
        [tenantId, cursor, limit]
      );
      return result.rows;
    }

    const result = await this.pool.query<WebhookReceiverRow>(
      `SELECT ${WEBHOOK_RECEIVER_COLUMNS}
         FROM ingestion.webhook_receivers
        WHERE tenant_id = $1
          AND deleted_at IS NULL
        ORDER BY created_at ASC, id ASC
        LIMIT $2`,
      [tenantId, limit]
    );
    return result.rows;
  }

  // Hot-path lookup used by the webhook receive handler on every inbound event.
  // The partial unique index on path_suffix WHERE deleted_at IS NULL makes this
  // an index scan even under high request rates.
  async findByPathSuffix(pathSuffix: string): Promise<WebhookReceiverRow | null> {
    const result = await this.pool.query<WebhookReceiverRow>(
      `SELECT ${WEBHOOK_RECEIVER_COLUMNS}
         FROM ingestion.webhook_receivers
        WHERE path_suffix = $1
          AND deleted_at IS NULL`,
      [pathSuffix]
    );
    return result.rows[0] ?? null;
  }

  async update(
    id: string,
    data: UpdateWebhookReceiverData
  ): Promise<WebhookReceiverRow | null> {
    const sets: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (data.name !== undefined) {
      sets.push(`name = $${idx++}`);
      values.push(data.name);
    }
    if (data.description !== undefined) {
      sets.push(`description = $${idx++}`);
      values.push(data.description); // null clears the column
    }
    if (data.connector_id !== undefined) {
      sets.push(`connector_id = $${idx++}`);
      values.push(data.connector_id); // null unlinks from connector
    }
    if (data.hmac_algorithm !== undefined) {
      sets.push(`hmac_algorithm = $${idx++}`);
      values.push(data.hmac_algorithm);
    }
    if (data.header_name !== undefined) {
      sets.push(`header_name = $${idx++}`);
      values.push(data.header_name);
    }
    if (data.is_enabled !== undefined) {
      sets.push(`is_enabled = $${idx++}`);
      values.push(data.is_enabled);
    }
    if (data.secret_hash !== undefined) {
      sets.push(`secret_hash = $${idx++}`);
      values.push(data.secret_hash);
    }

    if (sets.length === 0) {
      throw new Error(
        `update() called with no fields to update for webhook receiver ${id}`
      );
    }

    sets.push(`updated_at = now()`);
    values.push(id);

    const result = await this.pool.query<WebhookReceiverRow>(
      `UPDATE ingestion.webhook_receivers
            SET ${sets.join(", ")}
          WHERE id = $${idx}
            AND deleted_at IS NULL
      RETURNING ${WEBHOOK_RECEIVER_COLUMNS}`,
      values
    );
    return result.rows[0] ?? null;
  }

  async softDelete(id: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ingestion.webhook_receivers
            SET deleted_at = now(),
                updated_at = now()
          WHERE id = $1
            AND deleted_at IS NULL`,
      [id]
    );
    return result.rowCount !== null && result.rowCount > 0;
  }

  // Increments events_received and refreshes last_received_at in a single
  // round-trip. Called after successful HMAC verification and staging.
  async incrementEventsReceived(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE ingestion.webhook_receivers
            SET events_received  = events_received + 1,
                last_received_at = now(),
                updated_at       = now()
          WHERE id = $1`,
      [id]
    );
  }

  async countByTenantId(tenantId: string): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT count(*) AS count
         FROM ingestion.webhook_receivers
        WHERE tenant_id = $1
          AND deleted_at IS NULL`,
      [tenantId]
    );
    const row = result.rows[0];
    return row !== undefined ? parseInt(row["count"], 10) : 0;
  }

  // findByTenantAndId — tenant-scoped primary key lookup. Returns null for
  // cross-tenant access so callers get a consistent not-found result.
  async findByTenantAndId(tenantId: string, id: string): Promise<WebhookReceiverRow | null> {
    const result = await this.pool.query<WebhookReceiverRow>(
      `SELECT ${WEBHOOK_RECEIVER_COLUMNS}
         FROM ingestion.webhook_receivers
        WHERE id = $1
          AND tenant_id = $2
          AND deleted_at IS NULL`,
      [id, tenantId]
    );
    return result.rows[0] ?? null;
  }

  // listByTenantId — cursor-paginated list with total count.
  // Matches the service interface used by the webhook management and receive services.
  async listByTenantId(
    tenantId: string,
    options: { cursor?: string; limit: number }
  ): Promise<{ items: WebhookReceiverRow[]; nextCursor: string | null; total: number }> {
    const total = await this.countByTenantId(tenantId);
    const rows = await this.findByTenantId(tenantId, options);
    const lastRow = rows[rows.length - 1];
    const nextCursor =
      rows.length === options.limit && lastRow !== undefined ? lastRow.id : null;
    return { items: rows, nextCursor, total };
  }
}
