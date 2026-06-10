// delivery-repository.ts — route-layer facade over WebhookDeliveryRepository.
//
// The route handlers in routes/webhooks.ts import `DeliveryRepository` from
// this module. The interface exposes a paginated `listByWebhookId` so that
// the management API can page through large delivery histories without
// returning unbounded result sets to callers.

import type pg from "pg";
import type { WebhookDeliveryRow, CreateWebhookDeliveryData } from "./types.js";

const DELIVERY_COLUMNS = `
  id, webhook_id, tenant_id, event_id, event_type, delivery_id,
  attempt, requested_at, responded_at, status_code, response_body,
  error, duration_ms, success
`;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export interface DeliveryListOptions {
  cursor?: string;
  limit?: number;
}

export interface DeliveryRepository {
  create(data: CreateWebhookDeliveryData): Promise<WebhookDeliveryRow>;
  listByWebhookId(
    webhookId: string,
    options?: DeliveryListOptions
  ): Promise<WebhookDeliveryRow[]>;
  deleteOlderThan(days: number): Promise<number>;
  enforcePerWebhookCap(webhookId: string, maxRows: number): Promise<number>;
}

export function createDeliveryRepository(pool: pg.Pool): DeliveryRepository {
  async function create(
    data: CreateWebhookDeliveryData
  ): Promise<WebhookDeliveryRow> {
    const result = await pool.query<WebhookDeliveryRow>(
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
      throw new Error(
        "INSERT INTO gateway.webhook_deliveries returned no rows"
      );
    }
    return row;
  }

  // Returns deliveries in reverse chronological order (newest first).
  // Pagination uses the `requested_at` timestamp and `id` as the cursor
  // compound key so results are stable even for rows with identical timestamps.
  async function listByWebhookId(
    webhookId: string,
    options?: DeliveryListOptions
  ): Promise<WebhookDeliveryRow[]> {
    const pageSize = Math.min(options?.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const cursor = options?.cursor;

    if (cursor !== undefined) {
      // Cursor is base64url-encoded JSON: { requestedAt: string; id: string }
      let afterRequestedAt: string;
      let afterId: string;
      try {
        const decoded = JSON.parse(
          Buffer.from(cursor, "base64url").toString("utf8")
        ) as { requestedAt: string; id: string };
        afterRequestedAt = decoded.requestedAt;
        afterId = decoded.id;
      } catch {
        throw new Error("Invalid cursor: could not decode delivery pagination cursor");
      }

      const result = await pool.query<WebhookDeliveryRow>(
        `SELECT ${DELIVERY_COLUMNS}
           FROM gateway.webhook_deliveries
          WHERE webhook_id = $1
            AND (requested_at, id) < ($2::timestamptz, $3::uuid)
          ORDER BY requested_at DESC, id DESC
          LIMIT $4`,
        [webhookId, afterRequestedAt, afterId, pageSize]
      );
      return result.rows;
    }

    const result = await pool.query<WebhookDeliveryRow>(
      `SELECT ${DELIVERY_COLUMNS}
         FROM gateway.webhook_deliveries
        WHERE webhook_id = $1
        ORDER BY requested_at DESC, id DESC
        LIMIT $2`,
      [webhookId, pageSize]
    );
    return result.rows;
  }

  // Time-based retention cleanup. Returns the number of deleted rows.
  async function deleteOlderThan(days: number): Promise<number> {
    const result = await pool.query(
      `DELETE FROM gateway.webhook_deliveries
        WHERE requested_at < now() - ($1 || ' days')::INTERVAL`,
      [days]
    );
    return result.rowCount ?? 0;
  }

  // Per-webhook cap: deletes oldest rows beyond maxRows using a window
  // function to avoid per-row trigger overhead on every delivery insert.
  async function enforcePerWebhookCap(
    webhookId: string,
    maxRows: number
  ): Promise<number> {
    const result = await pool.query(
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

  return { create, listByWebhookId, deleteOlderThan, enforcePerWebhookCap };
}
