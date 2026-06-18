import type pg from "pg";
import type {
  UsageEventRow,
  UsageSummaryRow,
  CreateUsageEventData,
  UsageEventType,
  UsagePeriodType,
  BillingWebhookConfigRow,
  UpsertBillingWebhookConfigData,
} from "./types.js";

// ---------------------------------------------------------------------------
// UsageEventRepository
//
// Owns all reads and writes to gateway.usage_events and
// gateway.usage_summaries. The MeteringService calls this repository
// during its periodic Redis-to-DB flush and when reading usage history
// for the API endpoints.
// ---------------------------------------------------------------------------

export class UsageEventRepository {
  constructor(private readonly pool: pg.Pool) {}

  async insertBatch(events: CreateUsageEventData[]): Promise<void> {
    if (events.length === 0) return;

    // Build a multi-row INSERT with parameterized values to prevent injection.
    // Each row occupies 4 parameters: tenant_id, type, value, metadata, timestamp.
    const valuePlaceholders: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    for (const ev of events) {
      valuePlaceholders.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`);
      params.push(
        ev.tenant_id,
        ev.type,
        ev.value,
        ev.metadata !== undefined ? JSON.stringify(ev.metadata) : null,
        ev.timestamp ?? new Date(),
      );
    }

    await this.pool.query(
      `INSERT INTO gateway.usage_events (tenant_id, type, value, metadata, timestamp)
       VALUES ${valuePlaceholders.join(", ")}`,
      params,
    );
  }

  async findByTenantIdAndPeriod(
    tenantId: string,
    from: Date,
    to: Date,
    type?: UsageEventType,
  ): Promise<UsageEventRow[]> {
    if (type !== undefined) {
      const result = await this.pool.query<UsageEventRow>(
        `SELECT id, tenant_id, type, value, metadata, timestamp
           FROM gateway.usage_events
          WHERE tenant_id = $1
            AND type = $2
            AND timestamp >= $3
            AND timestamp < $4
          ORDER BY timestamp DESC`,
        [tenantId, type, from, to],
      );
      return result.rows;
    }

    const result = await this.pool.query<UsageEventRow>(
      `SELECT id, tenant_id, type, value, metadata, timestamp
         FROM gateway.usage_events
        WHERE tenant_id = $1
          AND timestamp >= $2
          AND timestamp < $3
        ORDER BY timestamp DESC`,
      [tenantId, from, to],
    );
    return result.rows;
  }

  // Sums usage_events directly for on-demand aggregation when a summary
  // bucket may not yet have been flushed (e.g. the current partial period).
  async aggregateByTenantAndPeriod(
    tenantId: string,
    from: Date,
    to: Date,
  ): Promise<Array<{ type: UsageEventType; total: bigint }>> {
    const result = await this.pool.query<{ type: UsageEventType; total: string }>(
      `SELECT type, SUM(value)::BIGINT AS total
         FROM gateway.usage_events
        WHERE tenant_id = $1
          AND timestamp >= $2
          AND timestamp < $3
        GROUP BY type`,
      [tenantId, from, to],
    );
    return result.rows.map((row) => ({
      type: row.type,
      total: BigInt(row.total),
    }));
  }
}

// ---------------------------------------------------------------------------
// UsageSummaryRepository
//
// Owns reads and upserts for gateway.usage_summaries.
// The flush job calls upsertBucket once per (tenant, period, type) tuple
// accumulated during the flush window.
// ---------------------------------------------------------------------------

export class UsageSummaryRepository {
  constructor(private readonly pool: pg.Pool) {}

  async upsertBucket(
    tenantId: string,
    periodType: UsagePeriodType,
    periodStart: Date,
    eventType: UsageEventType,
    additionalValue: bigint,
    additionalCount: bigint,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO gateway.usage_summaries
         (tenant_id, period_type, period_start, event_type, total_value, event_count)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, period_type, period_start, event_type) DO UPDATE
         SET total_value = gateway.usage_summaries.total_value + EXCLUDED.total_value,
             event_count = gateway.usage_summaries.event_count + EXCLUDED.event_count,
             updated_at  = now()`,
      [tenantId, periodType, periodStart, eventType, additionalValue, additionalCount],
    );
  }

  async findByTenantAndPeriodType(
    tenantId: string,
    periodType: UsagePeriodType,
    from: Date,
    to: Date,
  ): Promise<UsageSummaryRow[]> {
    const result = await this.pool.query<UsageSummaryRow>(
      `SELECT id, tenant_id, period_type, period_start, event_type,
              total_value, event_count, updated_at
         FROM gateway.usage_summaries
        WHERE tenant_id = $1
          AND period_type = $2
          AND period_start >= $3
          AND period_start < $4
        ORDER BY period_start DESC, event_type ASC`,
      [tenantId, periodType, from, to],
    );
    return result.rows;
  }
}

// ---------------------------------------------------------------------------
// BillingWebhookConfigRepository
//
// One row per tenant (UNIQUE constraint). Upsert replaces existing config.
// ---------------------------------------------------------------------------

export class BillingWebhookConfigRepository {
  constructor(private readonly pool: pg.Pool) {}

  async upsert(data: UpsertBillingWebhookConfigData): Promise<BillingWebhookConfigRow> {
    const result = await this.pool.query<BillingWebhookConfigRow>(
      `INSERT INTO gateway.billing_webhook_configs
         (tenant_id, url, provider, api_call_threshold, rows_ingested_threshold,
          storage_bytes_threshold, secret_encrypted, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (tenant_id) DO UPDATE
         SET url                    = EXCLUDED.url,
             provider               = EXCLUDED.provider,
             api_call_threshold     = EXCLUDED.api_call_threshold,
             rows_ingested_threshold = EXCLUDED.rows_ingested_threshold,
             storage_bytes_threshold = EXCLUDED.storage_bytes_threshold,
             secret_encrypted       = EXCLUDED.secret_encrypted,
             enabled                = EXCLUDED.enabled,
             updated_at             = now()
       RETURNING *`,
      [
        data.tenant_id,
        data.url,
        data.provider ?? "custom",
        data.api_call_threshold ?? null,
        data.rows_ingested_threshold ?? null,
        data.storage_bytes_threshold ?? null,
        data.secret_encrypted ?? null,
        data.enabled ?? true,
      ],
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("Upsert into gateway.billing_webhook_configs returned no rows");
    }
    return row;
  }

  async findByTenantId(tenantId: string): Promise<BillingWebhookConfigRow | null> {
    const result = await this.pool.query<BillingWebhookConfigRow>(
      `SELECT id, tenant_id, url, provider, api_call_threshold,
              rows_ingested_threshold, storage_bytes_threshold,
              secret_encrypted, enabled, created_at, updated_at
         FROM gateway.billing_webhook_configs
        WHERE tenant_id = $1`,
      [tenantId],
    );
    return result.rows[0] ?? null;
  }

  async delete(tenantId: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM gateway.billing_webhook_configs WHERE tenant_id = $1`,
      [tenantId],
    );
    return result.rowCount !== null && result.rowCount > 0;
  }
}
