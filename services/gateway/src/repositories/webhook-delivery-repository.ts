import type pg from "pg";
import type { WebhookDeliveryRow, CreateWebhookDeliveryData } from "./types.js";

const DELIVERY_COLUMNS = `
  id, webhook_id, tenant_id, event_id, event_type, delivery_id,
  attempt, requested_at, responded_at, status_code, response_body,
  error, duration_ms, success
`;

export class WebhookDeliveryRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(data: CreateWebhookDeliveryData): Promise<WebhookDeliveryRow> {
    const result = await this.pool.query<WebhookDeliveryRow>(
      `INSERT INTO gateway.webhook_deliveries
         (webhook_id, tenant_id, event_id, event_type, delivery_id,
          attempt, responded_at, status_code, response_body, error, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING ${DELIVERY_COLUMNS}`,
      [
        data.webhook_id,
        data.tenant_id,
        data.event_id,
        data.event_type,
        data.delivery_id,
        data.attempt,
        data.responded_at ?? null,
        data.status_code ?? null,
        data.response_body ?? null,
        data.error ?? null,
        data.duration_ms ?? null,
      ]
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("INSERT INTO gateway.webhook_deliveries returned no rows");
    }
    return row;
  }

  // Returns deliveries in reverse chronological order (newest first) so the
  // API can surface the most recent attempts at the top of the list.
  async findByWebhookId(
    webhookId: string,
    limit = 50
  ): Promise<WebhookDeliveryRow[]> {
    const result = await this.pool.query<WebhookDeliveryRow>(
      `SELECT ${DELIVERY_COLUMNS}
         FROM gateway.webhook_deliveries
        WHERE webhook_id = $1
        ORDER BY requested_at DESC
        LIMIT $2`,
      [webhookId, limit]
    );
    return result.rows;
  }

  // Time-based retention cleanup. Returns the number of deleted rows.
  // Runs hourly via the background job described in L2 §4.2.
  async deleteOlderThan(days: number): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM gateway.webhook_deliveries
        WHERE requested_at < now() - ($1 || ' days')::INTERVAL`,
      [days]
    );
    return result.rowCount ?? 0;
  }

  // Per-webhook cap: deletes rows beyond maxRows (oldest first) to prevent
  // unbounded growth when a webhook is very active. Uses a window function to
  // identify the excess rows in a single pass rather than per-row triggers,
  // which would add write overhead to every delivery insert.
  async enforcePerWebhookCap(
    webhookId: string,
    maxRows: number
  ): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM gateway.webhook_deliveries
        WHERE id IN (
          SELECT id
            FROM (
              SELECT id,
                     ROW_NUMBER() OVER (
                       PARTITION BY webhook_id
                       ORDER BY requested_at DESC
                     ) AS rn
                FROM gateway.webhook_deliveries
               WHERE webhook_id = $1
            ) ranked
           WHERE rn > $2
        )`,
      [webhookId, maxRows]
    );
    return result.rowCount ?? 0;
  }
}
