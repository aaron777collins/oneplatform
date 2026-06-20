import type pg from "pg";
import type {
  WebhookRow,
  CreateWebhookData,
  UpdateWebhookData,
} from "./types.js";

const WEBHOOK_COLUMNS = `
  id, tenant_id, url, events, secret_hash, secret_encrypted,
  description, enabled, custom_headers,
  consecutive_failures, throttled_until,
  total_deliveries, successful_deliveries, failed_deliveries,
  last_delivery_at, last_delivery_status,
  created_at, updated_at
`;

export class WebhookRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(data: CreateWebhookData): Promise<WebhookRow> {
    const result = await this.pool.query<WebhookRow>(
      `INSERT INTO gateway.webhooks
         (tenant_id, url, events, secret_hash, secret_encrypted,
          description, enabled, custom_headers)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${WEBHOOK_COLUMNS}`,
      [
        data.tenant_id,
        data.url,
        data.events,
        data.secret_hash,
        data.secret_encrypted,
        data.description ?? null,
        data.enabled ?? true,
        data.custom_headers !== undefined
          ? JSON.stringify(data.custom_headers)
          : null,
      ]
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("INSERT INTO gateway.webhooks returned no rows");
    }
    return row;
  }

  // Returns all webhooks for the management API (enabled and disabled).
  // Cursor encodes "<created_at_iso>|<id>" for stable compound keyset pagination
  // that correctly orders by (created_at, id) regardless of UUID ordering.
  async findByTenantId(
    tenantId: string,
    options?: { cursor?: string; limit?: number }
  ): Promise<WebhookRow[]> {
    const limit = options?.limit ?? 50;
    const cursor = options?.cursor;

    if (cursor !== undefined) {
      const [cursorTs, cursorId] = cursor.split("|");
      if (cursorTs === undefined || cursorId === undefined) {
        throw new Error("Invalid webhook cursor format: expected '<created_at_iso>|<id>'");
      }
      const result = await this.pool.query<WebhookRow>(
        `SELECT ${WEBHOOK_COLUMNS}
           FROM gateway.webhooks
          WHERE tenant_id = $1
            AND (created_at, id) > ($2::timestamptz, $3::uuid)
          ORDER BY created_at ASC, id ASC
          LIMIT $4`,
        [tenantId, cursorTs, cursorId, limit]
      );
      return result.rows;
    }

    const result = await this.pool.query<WebhookRow>(
      `SELECT ${WEBHOOK_COLUMNS}
         FROM gateway.webhooks
        WHERE tenant_id = $1
        ORDER BY created_at ASC, id ASC
        LIMIT $2`,
      [tenantId, limit]
    );
    return result.rows;
  }

  async findById(id: string): Promise<WebhookRow | null> {
    const result = await this.pool.query<WebhookRow>(
      `SELECT ${WEBHOOK_COLUMNS}
         FROM gateway.webhooks
        WHERE id = $1`,
      [id]
    );
    return result.rows[0] ?? null;
  }

  async update(id: string, data: UpdateWebhookData): Promise<WebhookRow | null> {
    const sets: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (data.url !== undefined) {
      sets.push(`url = $${idx++}`);
      values.push(data.url);
    }
    if (data.events !== undefined) {
      sets.push(`events = $${idx++}`);
      values.push(data.events);
    }
    if (data.secret_hash !== undefined) {
      sets.push(`secret_hash = $${idx++}`);
      values.push(data.secret_hash);
    }
    if (data.secret_encrypted !== undefined) {
      sets.push(`secret_encrypted = $${idx++}`);
      values.push(data.secret_encrypted);
    }
    if (data.description !== undefined) {
      sets.push(`description = $${idx++}`);
      values.push(data.description);
    }
    if (data.enabled !== undefined) {
      sets.push(`enabled = $${idx++}`);
      values.push(data.enabled);
    }
    if (data.custom_headers !== undefined) {
      sets.push(`custom_headers = $${idx++}`);
      // null clears the column; non-null is serialized as JSONB
      values.push(
        data.custom_headers !== null
          ? JSON.stringify(data.custom_headers)
          : null
      );
    }

    if (sets.length === 0) {
      throw new Error(`update() called with no fields to update for webhook ${id}`);
    }

    sets.push(`updated_at = now()`);
    values.push(id);

    const result = await this.pool.query<WebhookRow>(
      `UPDATE gateway.webhooks
            SET ${sets.join(", ")}
          WHERE id = $${idx}
      RETURNING ${WEBHOOK_COLUMNS}`,
      values
    );
    return result.rows[0] ?? null;
  }

  // Internal helper: fetches ALL enabled webhooks for a tenant without
  // pagination, used exclusively by findMatchingWebhooks for event fan-out.
  private async findAllEnabledByTenantId(tenantId: string): Promise<WebhookRow[]> {
    const result = await this.pool.query<WebhookRow>(
      `SELECT ${WEBHOOK_COLUMNS}
         FROM gateway.webhooks
        WHERE tenant_id = $1
          AND enabled = true
        ORDER BY created_at ASC`,
      [tenantId]
    );
    return result.rows;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM gateway.webhooks WHERE id = $1`,
      [id]
    );
    return result.rowCount !== null && result.rowCount > 0;
  }

  // Fetches all enabled webhooks for the tenant, then filters in application
  // code using glob-style matching. This avoids a complex SQL pattern expression
  // and gives us the same micromatch semantics used everywhere else in the
  // webhook fan-out path (L2 §11.1 — pattern matching happens in app code).
  async findMatchingWebhooks(
    tenantId: string,
    eventType: string
  ): Promise<WebhookRow[]> {
    // Fetch all enabled webhooks then filter in-process using glob matching.
    // This avoids complex SQL pattern expressions and uses the same matching
    // semantics as the delivery worker.
    const all = await this.findAllEnabledByTenantId(tenantId);
    return all.filter((webhook) =>
      webhook.events.some((pattern) =>
        matchesGlobPattern(pattern, eventType)
      )
    );
  }

  async incrementConsecutiveFailures(id: string): Promise<number> {
    const result = await this.pool.query<{ consecutive_failures: number }>(
      `UPDATE gateway.webhooks
            SET consecutive_failures = consecutive_failures + 1,
                updated_at = now()
          WHERE id = $1
      RETURNING consecutive_failures`,
      [id]
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(`Webhook ${id} not found when incrementing failures`);
    }
    return row.consecutive_failures;
  }

  async resetConsecutiveFailures(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE gateway.webhooks
            SET consecutive_failures = 0,
                throttled_until = NULL,
                updated_at = now()
          WHERE id = $1`,
      [id]
    );
  }

  async setThrottledUntil(id: string, until: Date): Promise<void> {
    await this.pool.query(
      `UPDATE gateway.webhooks
            SET throttled_until = $1,
                updated_at = now()
          WHERE id = $2`,
      [until, id]
    );
  }

  // Increments delivery counters and records the last delivery outcome.
  // Called after each delivery attempt regardless of success so the dashboard
  // always shows accurate totals.
  async updateStats(id: string, success: boolean): Promise<void> {
    const successIncrement = success ? 1 : 0;
    const failedIncrement = success ? 0 : 1;
    const lastStatus = success ? "success" : "failed";

    await this.pool.query(
      `UPDATE gateway.webhooks
            SET total_deliveries = total_deliveries + 1,
                successful_deliveries = successful_deliveries + $1,
                failed_deliveries = failed_deliveries + $2,
                last_delivery_at = now(),
                last_delivery_status = $3,
                updated_at = now()
          WHERE id = $4`,
      [successIncrement, failedIncrement, lastStatus, id]
    );
  }
}

// ---------------------------------------------------------------------------
// Glob-style pattern matcher for event type filtering.
// Supports only '*' as a wildcard — matches any sequence of characters within
// a single segment or across segments (e.g. "pipeline.*" matches
// "pipeline.completed", "pipeline.failed", etc.).
// Dot-separated segments are NOT treated specially; '*' is greedy.
// ---------------------------------------------------------------------------

function matchesGlobPattern(pattern: string, eventType: string): boolean {
  // Exact match fast path
  if (pattern === eventType) return true;
  // Wildcard match: "*" matches any single event type
  if (pattern === "*") return true;

  // Convert glob pattern to a regular expression.
  // Escape all regex metacharacters except '*', then replace '*' with '.*'.
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regexStr = `^${escaped.replace(/\*/g, ".*")}$`;
  return new RegExp(regexStr).test(eventType);
}
