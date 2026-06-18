// Reconciliation report repository — persists ReconciliationReport objects in
// the ingestion.reconciliation_reports table and provides query methods used
// by the ReconciliationService. All queries are parameterized; no raw table
// names or user input appear in SQL string construction.

import type pg from "pg";
import type { ReconciliationReport, ReconciliationReportRepository } from "../services/reconciliation-service.js";

export class ReconciliationReportRepositoryImpl implements ReconciliationReportRepository {
  constructor(private readonly pool: pg.Pool) {}

  async save(report: ReconciliationReport): Promise<void> {
    await this.pool.query(
      `INSERT INTO ingestion.reconciliation_reports
         (job_id, connector_id, timestamp, source_count, platform_count,
          missing_in_platform, extra_in_platform, field_mismatches,
          match_rate, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (job_id) DO UPDATE
           SET timestamp          = EXCLUDED.timestamp,
               source_count       = EXCLUDED.source_count,
               platform_count     = EXCLUDED.platform_count,
               missing_in_platform = EXCLUDED.missing_in_platform,
               extra_in_platform  = EXCLUDED.extra_in_platform,
               field_mismatches   = EXCLUDED.field_mismatches,
               match_rate         = EXCLUDED.match_rate,
               status             = EXCLUDED.status`,
      [
        report.jobId,
        report.connectorId,
        report.timestamp,
        report.sourceCount,
        report.platformCount,
        JSON.stringify(report.missingInPlatform),
        JSON.stringify(report.extraInPlatform),
        JSON.stringify(report.fieldMismatches),
        report.matchRate,
        report.status,
      ],
    );
  }

  async findByJobId(jobId: string): Promise<ReconciliationReport | null> {
    const result = await this.pool.query<ReconciliationReportRow>(
      `SELECT job_id, connector_id, timestamp, source_count, platform_count,
              missing_in_platform, extra_in_platform, field_mismatches,
              match_rate, status
         FROM ingestion.reconciliation_reports
        WHERE job_id = $1`,
      [jobId],
    );
    const row = result.rows[0];
    return row !== undefined ? rowToReport(row) : null;
  }

  async findByConnectorId(
    connectorId: string,
    options: { limit: number; cursor?: string },
  ): Promise<{ items: ReconciliationReport[]; total: number }> {
    const countResult = await this.pool.query<{ count: string }>(
      `SELECT count(*) AS count
         FROM ingestion.reconciliation_reports
        WHERE connector_id = $1`,
      [connectorId],
    );
    const total = parseInt(countResult.rows[0]?.["count"] ?? "0", 10);

    // Cursor-based pagination: the cursor is the job_id of the last seen row.
    // Rows are ordered newest-first by timestamp so pages are predictable even
    // as new reports are inserted between page fetches.
    let rows: pg.QueryResult<ReconciliationReportRow>;
    if (options.cursor !== undefined) {
      // Resolve the timestamp of the cursor row to support keyset pagination.
      const cursorResult = await this.pool.query<{ timestamp: string }>(
        `SELECT timestamp FROM ingestion.reconciliation_reports WHERE job_id = $1`,
        [options.cursor],
      );
      const cursorTimestamp = cursorResult.rows[0]?.["timestamp"];

      if (cursorTimestamp !== undefined) {
        rows = await this.pool.query<ReconciliationReportRow>(
          `SELECT job_id, connector_id, timestamp, source_count, platform_count,
                  missing_in_platform, extra_in_platform, field_mismatches,
                  match_rate, status
             FROM ingestion.reconciliation_reports
            WHERE connector_id = $1
              AND (timestamp, job_id) < ($2::timestamptz, $3)
            ORDER BY timestamp DESC, job_id DESC
            LIMIT $4`,
          [connectorId, cursorTimestamp, options.cursor, options.limit],
        );
      } else {
        rows = await this.pool.query<ReconciliationReportRow>(
          `SELECT job_id, connector_id, timestamp, source_count, platform_count,
                  missing_in_platform, extra_in_platform, field_mismatches,
                  match_rate, status
             FROM ingestion.reconciliation_reports
            WHERE connector_id = $1
            ORDER BY timestamp DESC, job_id DESC
            LIMIT $2`,
          [connectorId, options.limit],
        );
      }
    } else {
      rows = await this.pool.query<ReconciliationReportRow>(
        `SELECT job_id, connector_id, timestamp, source_count, platform_count,
                missing_in_platform, extra_in_platform, field_mismatches,
                match_rate, status
           FROM ingestion.reconciliation_reports
          WHERE connector_id = $1
          ORDER BY timestamp DESC, job_id DESC
          LIMIT $2`,
        [connectorId, options.limit],
      );
    }

    return { items: rows.rows.map(rowToReport), total };
  }
}

// ---------------------------------------------------------------------------
// Internal types and mappers
// ---------------------------------------------------------------------------

interface ReconciliationReportRow {
  job_id: string;
  connector_id: string;
  timestamp: string;
  source_count: number;
  platform_count: number;
  // pg driver returns JSONB columns as parsed JS objects/arrays
  missing_in_platform: string[];
  extra_in_platform: string[];
  field_mismatches: Array<{
    recordId: string;
    field: string;
    sourceValue: unknown;
    platformValue: unknown;
  }>;
  match_rate: string; // pg returns NUMERIC as string
  status: "match" | "partial_match" | "mismatch";
}

function rowToReport(row: ReconciliationReportRow): ReconciliationReport {
  return {
    jobId: row["job_id"],
    connectorId: row["connector_id"],
    timestamp: row["timestamp"],
    sourceCount: row["source_count"],
    platformCount: row["platform_count"],
    missingInPlatform: row["missing_in_platform"],
    extraInPlatform: row["extra_in_platform"],
    fieldMismatches: row["field_mismatches"],
    matchRate: parseFloat(row["match_rate"]),
    status: row["status"],
  };
}
