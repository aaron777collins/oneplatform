import type pg from "pg";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single field as observed in the source data at a point in time. */
export interface FieldSchema {
  /** Name of the field as it appears in the source record. */
  name: string;
  /** Inferred data type (e.g. "string", "number", "boolean", "object", "array", "null"). */
  type: string;
  /** True when the field was absent from at least one record in the sample batch. */
  nullable: boolean;
}

export interface SchemaSnapshotRow {
  id: string;
  connector_id: string;
  captured_at: Date;
  fields: FieldSchema[];
}

// ---------------------------------------------------------------------------
// SchemaSnapshotRepository
// ---------------------------------------------------------------------------

// Maximum number of snapshots retained per connector. Older rows beyond this
// limit are pruned after each insert to prevent unbounded table growth.
const MAX_SNAPSHOTS_PER_CONNECTOR = 10;

export class SchemaSnapshotRepository {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Persist a new schema snapshot for the connector, then prune snapshots
   * beyond the retention window in the same transaction.
   *
   * Pruning happens inside the same client transaction so an observer reading
   * the table between the INSERT and the DELETE never sees more than
   * MAX_SNAPSHOTS_PER_CONNECTOR + 1 rows.
   */
  async save(connectorId: string, fields: FieldSchema[]): Promise<SchemaSnapshotRow> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const insertResult = await client.query<SchemaSnapshotRow>(
        `INSERT INTO ingestion.schema_snapshots (connector_id, fields)
         VALUES ($1, $2)
         RETURNING id, connector_id, captured_at, fields`,
        [connectorId, JSON.stringify(fields)],
      );

      const saved = insertResult.rows[0];
      if (saved === undefined) {
        throw new Error(
          `INSERT INTO ingestion.schema_snapshots returned no rows for connector ${connectorId}`,
        );
      }

      // Delete snapshots beyond the retention window, keeping the newest N rows.
      // The CTE identifies rows to evict by rank so a single DELETE statement
      // handles arbitrarily large over-runs without application-level pagination.
      await client.query(
        `DELETE FROM ingestion.schema_snapshots
          WHERE connector_id = $1
            AND id IN (
              SELECT id FROM ingestion.schema_snapshots
               WHERE connector_id = $1
               ORDER BY captured_at DESC
               OFFSET $2
            )`,
        [connectorId, MAX_SNAPSHOTS_PER_CONNECTOR],
      );

      await client.query("COMMIT");
      return saved;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Return the most recent snapshot for a connector, or null if none exists.
   * This is the baseline used to detect drift on the next sync run.
   */
  async findLatest(connectorId: string): Promise<SchemaSnapshotRow | null> {
    const result = await this.pool.query<SchemaSnapshotRow>(
      `SELECT id, connector_id, captured_at, fields
         FROM ingestion.schema_snapshots
        WHERE connector_id = $1
        ORDER BY captured_at DESC
        LIMIT 1`,
      [connectorId],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Return the last N snapshots for a connector, newest first.
   * Used by the API endpoint to show drift history.
   */
  async findRecent(connectorId: string, limit = MAX_SNAPSHOTS_PER_CONNECTOR): Promise<SchemaSnapshotRow[]> {
    const result = await this.pool.query<SchemaSnapshotRow>(
      `SELECT id, connector_id, captured_at, fields
         FROM ingestion.schema_snapshots
        WHERE connector_id = $1
        ORDER BY captured_at DESC
        LIMIT $2`,
      [connectorId, limit],
    );
    return result.rows;
  }
}
