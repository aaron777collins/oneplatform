import type pg from "pg";

// ---------------------------------------------------------------------------
// Row shape — mirrors ingestion.webhook_delivery_log exactly.
// All timestamptz columns come back as Date from the pg driver.
// ---------------------------------------------------------------------------

export interface WebhookDeliveryLogRow {
  id: string;
  webhook_id: string;
  received_at: Date;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
  body_raw: string | null;
  body_truncated: boolean;
  signature_valid: boolean | null;
  status_code: number;
  processing_time_ms: number | null;
}

export interface CreateWebhookDeliveryLogData {
  webhook_id: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
  body_raw: string | null;
  body_truncated: boolean;
  signature_valid: boolean | null;
  status_code: number;
  processing_time_ms: number | null;
}

// ---------------------------------------------------------------------------
// Pagination options for listByWebhookId
// ---------------------------------------------------------------------------

export interface ListDeliveryLogsOptions {
  cursor?: string; // delivery id — page starts AFTER this row
  limit: number;
}

export interface ListDeliveryLogsResult {
  items: WebhookDeliveryLogRow[];
  nextCursor: string | null;
  total: number;
}

// ---------------------------------------------------------------------------
// Interface — exposed to service layer so tests can supply a stub.
// ---------------------------------------------------------------------------

export interface WebhookDeliveryLogRepository {
  insert(data: CreateWebhookDeliveryLogData): Promise<WebhookDeliveryLogRow>;
  findById(id: string): Promise<WebhookDeliveryLogRow | null>;
  listByWebhookId(
    webhookId: string,
    options: ListDeliveryLogsOptions,
  ): Promise<ListDeliveryLogsResult>;
  // Deletes excess rows so each webhook retains at most maxRows deliveries.
  // Returns the number of rows deleted.
  pruneExcess(webhookId: string, maxRows: number): Promise<number>;
}

// ---------------------------------------------------------------------------
// Concrete implementation
// ---------------------------------------------------------------------------

const LOG_COLUMNS = `
  id, webhook_id, received_at, headers, body, body_raw,
  body_truncated, signature_valid, status_code, processing_time_ms
`;

export class WebhookDeliveryLogRepositoryImpl implements WebhookDeliveryLogRepository {
  constructor(private readonly pool: pg.Pool) {}

  async insert(data: CreateWebhookDeliveryLogData): Promise<WebhookDeliveryLogRow> {
    const result = await this.pool.query<WebhookDeliveryLogRow>(
      `INSERT INTO ingestion.webhook_delivery_log
         (webhook_id, headers, body, body_raw, body_truncated,
          signature_valid, status_code, processing_time_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${LOG_COLUMNS}`,
      [
        data.webhook_id,
        JSON.stringify(data.headers),
        data.body !== null ? JSON.stringify(data.body) : null,
        data.body_raw,
        data.body_truncated,
        data.signature_valid,
        data.status_code,
        data.processing_time_ms,
      ],
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(
        "INSERT INTO ingestion.webhook_delivery_log returned no rows",
      );
    }
    return row;
  }

  async findById(id: string): Promise<WebhookDeliveryLogRow | null> {
    const result = await this.pool.query<WebhookDeliveryLogRow>(
      `SELECT ${LOG_COLUMNS}
         FROM ingestion.webhook_delivery_log
        WHERE id = $1`,
      [id],
    );
    return result.rows[0] ?? null;
  }

  async listByWebhookId(
    webhookId: string,
    options: ListDeliveryLogsOptions,
  ): Promise<ListDeliveryLogsResult> {
    // Count query runs concurrently with the data fetch.
    const [countResult, dataResult] = await Promise.all([
      this.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM ingestion.webhook_delivery_log
          WHERE webhook_id = $1`,
        [webhookId],
      ),
      options.cursor !== undefined
        ? this.pool.query<WebhookDeliveryLogRow>(
            `SELECT ${LOG_COLUMNS}
               FROM ingestion.webhook_delivery_log
              WHERE webhook_id = $1
                AND received_at < (
                      SELECT received_at
                        FROM ingestion.webhook_delivery_log
                       WHERE id = $2
                    )
              ORDER BY received_at DESC
              LIMIT $3`,
            [webhookId, options.cursor, options.limit],
          )
        : this.pool.query<WebhookDeliveryLogRow>(
            `SELECT ${LOG_COLUMNS}
               FROM ingestion.webhook_delivery_log
              WHERE webhook_id = $1
              ORDER BY received_at DESC
              LIMIT $2`,
            [webhookId, options.limit],
          ),
    ]);

    const items = dataResult.rows;
    const total = parseInt(countResult.rows[0]?.["count"] ?? "0", 10);
    const lastItem = items[items.length - 1];
    const nextCursor =
      items.length === options.limit && lastItem !== undefined
        ? lastItem.id
        : null;

    return { items, nextCursor, total };
  }

  async pruneExcess(webhookId: string, maxRows: number): Promise<number> {
    // Delete all rows older than the Nth most-recent for this webhook.
    // The subquery selects the received_at of the oldest row that should
    // survive; everything strictly before that threshold is removed.
    const result = await this.pool.query(
      `DELETE FROM ingestion.webhook_delivery_log
        WHERE webhook_id = $1
          AND received_at < (
                SELECT received_at
                  FROM ingestion.webhook_delivery_log
                 WHERE webhook_id = $1
                 ORDER BY received_at DESC
                 LIMIT 1
                 OFFSET $2
              )`,
      [webhookId, maxRows - 1],
    );
    return result.rowCount ?? 0;
  }
}
