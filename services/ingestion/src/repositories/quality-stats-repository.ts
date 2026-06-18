// Concrete PostgreSQL repository for connector data quality statistics.
//
// One row per connector in ingestion.connector_quality_stats. Stats are
// created on first batch write and updated on every subsequent batch.
// ON CONFLICT … DO UPDATE makes upsert idempotent across retried batch jobs.

import type pg from "pg";
import type {
  ConnectorQualityStats,
  QualityStatsRepository as IQualityStatsRepository,
} from "../services/data-quality-service.js";

// Shape that comes back from the DB query — column names are snake_case.
interface QualityStatsRow {
  connector_id: string;
  avg_batch_size: number;
  field_null_rates: Record<string, number>;
  field_types: Record<string, Record<string, number>>;
  known_fields: string[];
  batch_count: number;
  updated_at: Date;
}

function rowToStats(row: QualityStatsRow): ConnectorQualityStats {
  return {
    connectorId: row.connector_id,
    avgBatchSize: row.avg_batch_size,
    fieldNullRates: row.field_null_rates,
    fieldTypes: row.field_types,
    knownFields: row.known_fields,
    batchCount: row.batch_count,
    updatedAt: row.updated_at.toISOString(),
  };
}

export class QualityStatsRepository implements IQualityStatsRepository {
  constructor(private readonly pool: pg.Pool) {}

  async findByConnectorId(
    connectorId: string,
  ): Promise<ConnectorQualityStats | null> {
    const result = await this.pool.query<QualityStatsRow>(
      `SELECT connector_id, avg_batch_size, field_null_rates, field_types,
              known_fields, batch_count, updated_at
       FROM ingestion.connector_quality_stats
       WHERE connector_id = $1`,
      [connectorId],
    );

    const row = result.rows[0];
    return row !== undefined ? rowToStats(row) : null;
  }

  async upsert(stats: ConnectorQualityStats): Promise<void> {
    // Parameterised JSONB columns are passed as serialised strings. The pg
    // driver accepts JSON.stringify output for jsonb parameters when the column
    // type is jsonb — no explicit ::jsonb cast is needed in newer pg versions,
    // but we add it for clarity and forward compatibility.
    await this.pool.query(
      `INSERT INTO ingestion.connector_quality_stats
         (connector_id, avg_batch_size, field_null_rates, field_types,
          known_fields, batch_count, updated_at)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, now())
       ON CONFLICT (connector_id) DO UPDATE
           SET avg_batch_size   = EXCLUDED.avg_batch_size,
               field_null_rates = EXCLUDED.field_null_rates,
               field_types      = EXCLUDED.field_types,
               known_fields     = EXCLUDED.known_fields,
               batch_count      = EXCLUDED.batch_count,
               updated_at       = now()`,
      [
        stats.connectorId,
        stats.avgBatchSize,
        JSON.stringify(stats.fieldNullRates),
        JSON.stringify(stats.fieldTypes),
        stats.knownFields,
        stats.batchCount,
      ],
    );
  }
}
