import type pg from "pg";
import {
  connectorIdToTableName,
  validateRawTableName,
  type DataEnvelope,
} from "../utils/data-envelope.js";

// DataEnvelope is re-imported explicitly above so the upsertBatch signature
// can reference it as a concrete type rather than the opaque ReturnType<...>
// used in the service interface definition.

// ---------------------------------------------------------------------------
// SQL injection safety
//
// connector IDs are UUID v4 values enforced at creation time
// (ingestion.connectors.id DEFAULT gen_random_uuid()).
// connectorIdToTableName() replaces hyphens with underscores, producing a
// 36-char hex-and-underscore string.  validateRawTableName() then checks
// that the result matches /^raw_[0-9a-f]{8}_...$/ before any DDL is issued.
// No user-supplied strings ever appear in DDL statements.
// ---------------------------------------------------------------------------

function qualifiedTableName(connectorId: string): string {
  const tableName = connectorIdToTableName(connectorId);
  if (!validateRawTableName(tableName)) {
    throw new Error(
      `Invalid connector ID "${connectorId}": cannot derive a safe raw table name`
    );
  }
  // Schema-qualified so every dynamic DDL and DML statement is unambiguous.
  return `ingestion.${tableName}`;
}

export class RawTableRepository {
  constructor(private readonly pool: pg.Pool) {}

  // Creates the raw staging table for a connector if it does not already
  // exist, together with all four indexes and RLS.  This is called at the
  // start of every sync job; the IF NOT EXISTS guards make it idempotent
  // so the cost on subsequent calls is just a catalog lookup.
  //
  // All DDL uses the validated qualified table name — never raw user input.
  async createRawTable(connectorId: string): Promise<void> {
    const qtName = qualifiedTableName(connectorId);
    // Individual index names are derived from the same validated table name.
    const baseName = connectorIdToTableName(connectorId);

    // The grant to ontology_service_role is defense-in-depth:
    // ALTER DEFAULT PRIVILEGES in the schema already handles this, but
    // an explicit per-table grant ensures the ontology service can always
    // read raw rows for mapping jobs (design spec §3.1).
    const ddl = `
      CREATE TABLE IF NOT EXISTS ${qtName} (
        _id             UUID        PRIMARY KEY,
        _source         TEXT        NOT NULL,
        _ingested_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        _connector_id   UUID        NOT NULL,
        _tenant_id      UUID        NOT NULL,
        _batch_id       UUID        NOT NULL,
        _sync_mode      TEXT        NOT NULL CHECK (_sync_mode IN ('full', 'incremental')),
        _cursor         TEXT,
        _source_id      TEXT        NOT NULL,
        deleted_at      TIMESTAMPTZ,
        data            JSONB       NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_${baseName}_data
        ON ${qtName} USING GIN (data);

      CREATE INDEX IF NOT EXISTS idx_${baseName}_batch_id
        ON ${qtName} (_batch_id);

      CREATE INDEX IF NOT EXISTS idx_${baseName}_ingested_at
        ON ${qtName} (_ingested_at DESC);

      CREATE INDEX IF NOT EXISTS idx_${baseName}_not_deleted
        ON ${qtName} (deleted_at)
        WHERE deleted_at IS NULL;

      ALTER TABLE ${qtName} ENABLE ROW LEVEL SECURITY;

      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_policies
          WHERE schemaname = 'ingestion'
            AND tablename  = '${baseName}'
            AND policyname = 'raw_tenant_isolation'
        ) THEN
          CREATE POLICY raw_tenant_isolation ON ${qtName}
            USING (_tenant_id = current_setting('app.tenant_id', true)::uuid);
        END IF;
      END;
      $$;

      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ontology_service_role') THEN
          EXECUTE 'GRANT SELECT ON ${qtName} TO ontology_service_role';
        END IF;
      END;
      $$;
    `;

    await this.pool.query(ddl);
  }

  // Bulk-upserts a batch of DataEnvelope records using unnest().  For batches
  // ≤ 5,000 records the caller wraps this in a transaction that also calls
  // SyncStateRepository.updateCursor() to achieve atomic cursor advancement
  // (design spec §6.3 cursor atomicity table).
  //
  // ON CONFLICT (_id) DO UPDATE ensures at-least-once delivery is safe:
  // the same source record always produces the same deterministic _id via
  // uuid v5(connectorId, sourceId), so re-ingesting a batch is idempotent.
  async insertBatch(
    connectorId: string,
    envelopes: DataEnvelope[],
    client?: pg.PoolClient
  ): Promise<void> {
    if (envelopes.length === 0) return;

    const qtName = qualifiedTableName(connectorId);
    const executor = client ?? this.pool;

    // Unnest parallel arrays: each column gets one $N parameter that is
    // the full array for that column. PostgreSQL broadcasts the unnest
    // call across all arrays simultaneously, inserting one row per index.
    await executor.query(
      `INSERT INTO ${qtName}
         (_id, _source, _ingested_at, _connector_id, _tenant_id,
          _batch_id, _sync_mode, _cursor, _source_id, data)
       SELECT
         unnest($1::uuid[]),
         unnest($2::text[]),
         unnest($3::timestamptz[]),
         unnest($4::uuid[]),
         unnest($5::uuid[]),
         unnest($6::uuid[]),
         unnest($7::text[]),
         unnest($8::text[]),
         unnest($9::text[]),
         unnest($10::jsonb[])
       ON CONFLICT (_id) DO UPDATE
           SET _source       = EXCLUDED._source,
               _batch_id     = EXCLUDED._batch_id,
               _sync_mode    = EXCLUDED._sync_mode,
               _cursor       = EXCLUDED._cursor,
               deleted_at    = NULL,
               data          = EXCLUDED.data`,
      [
        envelopes.map((e) => e._id),
        envelopes.map((e) => e._source),
        envelopes.map((e) => e._ingested_at),
        envelopes.map((e) => e._connector_id),
        envelopes.map((e) => e._tenant_id),
        envelopes.map((e) => e._batch_id),
        envelopes.map((e) => e._sync_mode),
        envelopes.map((e) => e._cursor),
        envelopes.map((e) => e._source_id),
        envelopes.map((e) => JSON.stringify(e.data)),
      ]
    );
  }

  // Marks all rows for this connector that were NOT part of the current
  // full-sync batch as soft-deleted.  This implements deletion detection for
  // full syncs (design spec §6.2 step 4): records that disappeared from the
  // source system between the previous sync and this one have a _batch_id
  // different from the current batchId and are considered deleted.
  //
  // Incremental syncs NEVER call this method: they only detect deletes if
  // the connector explicitly returns DataRecord.metadata.deletedAt.
  async softDeleteNotInBatch(
    connectorId: string,
    currentBatchId: string
  ): Promise<number> {
    const qtName = qualifiedTableName(connectorId);

    const result = await this.pool.query(
      `UPDATE ${qtName}
            SET deleted_at = now()
          WHERE _connector_id = $1
            AND _batch_id    != $2
            AND deleted_at   IS NULL`,
      [connectorId, currentBatchId]
    );
    return result.rowCount ?? 0;
  }

  // Hard-deletes rows older than the cutoff. Accepts either a connector ID or a
  // validated raw table name, and either a Date or a number of days.
  //
  // Callers inside this service typically pass a connector ID + Date (the
  // original signature). The retention service passes a table name + number of
  // days, which avoids redundant re-derivation of the table name.
  async deleteOlderThan(
    tableNameOrConnectorId: string,
    olderThanOrDays: Date | number
  ): Promise<number> {
    const isTableName = tableNameOrConnectorId.startsWith("raw_");
    let qtName: string;
    if (isTableName) {
      if (!validateRawTableName(tableNameOrConnectorId)) {
        throw new Error(
          `deleteOlderThan: invalid raw table name "${tableNameOrConnectorId}"`
        );
      }
      qtName = `ingestion.${tableNameOrConnectorId}`;
    } else {
      qtName = qualifiedTableName(tableNameOrConnectorId);
    }

    const cutoffDate: Date =
      typeof olderThanOrDays === "number"
        ? new Date(Date.now() - olderThanOrDays * 24 * 60 * 60 * 1_000)
        : olderThanOrDays;

    const result = await this.pool.query(
      `DELETE FROM ${qtName}
        WHERE _ingested_at < $1`,
      [cutoffDate]
    );
    return result.rowCount ?? 0;
  }

  // Drops the raw table entirely. Accepts either a connector ID or a validated
  // raw table name. The IF EXISTS guard makes this idempotent.
  async dropTable(tableNameOrConnectorId: string): Promise<void> {
    const isTableName = tableNameOrConnectorId.startsWith("raw_");
    let qtName: string;
    if (isTableName) {
      if (!validateRawTableName(tableNameOrConnectorId)) {
        throw new Error(
          `dropTable: invalid raw table name "${tableNameOrConnectorId}"`
        );
      }
      qtName = `ingestion.${tableNameOrConnectorId}`;
    } else {
      qtName = qualifiedTableName(tableNameOrConnectorId);
    }
    await this.pool.query(`DROP TABLE IF EXISTS ${qtName}`);
  }

  // Counts rows in the raw table — used for progress reporting.
  async count(connectorId: string): Promise<number> {
    const qtName = qualifiedTableName(connectorId);
    const result = await this.pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM ${qtName}`
    );
    const row = result.rows[0];
    return row !== undefined ? parseInt(row["count"], 10) : 0;
  }

  // Returns all _source_id values for non-deleted rows.  Used by the
  // reconciliation service to build the platform-side ID set for comparison
  // against the source system (reconciliation-service.ts § ID set comparison).
  async listSourceIds(connectorId: string): Promise<string[]> {
    const qtName = qualifiedTableName(connectorId);
    const result = await this.pool.query<{ _source_id: string }>(
      `SELECT _source_id FROM ${qtName} WHERE deleted_at IS NULL ORDER BY _source_id`,
    );
    return result.rows.map((r) => r["_source_id"]);
  }

  // Returns a deterministic sample of at most `limit` records for the
  // reconciliation service's field-value comparison pass.  When sourceIds is
  // provided only those IDs are returned, keeping the result bounded even when
  // the table is large.
  async sampleRecords(
    connectorId: string,
    limit: number,
    sourceIds?: string[],
  ): Promise<Array<{ sourceId: string; data: Record<string, unknown> }>> {
    const qtName = qualifiedTableName(connectorId);

    let result: pg.QueryResult<{ _source_id: string; data: unknown }>;
    if (sourceIds !== undefined && sourceIds.length > 0) {
      result = await this.pool.query<{ _source_id: string; data: unknown }>(
        `SELECT _source_id, data FROM ${qtName}
          WHERE deleted_at IS NULL
            AND _source_id = ANY($1::text[])
          ORDER BY _source_id
          LIMIT $2`,
        [sourceIds, limit],
      );
    } else {
      result = await this.pool.query<{ _source_id: string; data: unknown }>(
        `SELECT _source_id, data FROM ${qtName}
          WHERE deleted_at IS NULL
          ORDER BY _source_id
          LIMIT $1`,
        [limit],
      );
    }

    return result.rows.map((r) => ({
      sourceId: r["_source_id"],
      data: r.data as Record<string, unknown>,
    }));
  }

  // ensureTable — alias for createRawTable that matches the service interface name.
  // Idempotent: the underlying DDL uses IF NOT EXISTS so repeated calls are safe.
  async ensureTable(connectorId: string): Promise<void> {
    return this.createRawTable(connectorId);
  }

  // upsertBatch — accepts a validated table name (returned by connectorIdToTableName)
  // and a list of DataEnvelope objects. Delegates to insertBatch after deriving the
  // connectorId from the table name (the connector_id is embedded in every envelope).
  //
  // The table name is validated via validateRawTableName before any SQL is issued
  // so no user-supplied string ever reaches a DDL or DML statement directly.
  async upsertBatch(tableName: string, envelopes: DataEnvelope[]): Promise<void> {
    if (envelopes.length === 0) return;

    if (!validateRawTableName(tableName)) {
      throw new Error(
        `upsertBatch: invalid raw table name "${tableName}" — must match raw_<uuid> pattern`
      );
    }

    // All envelopes in a batch share the same connector_id — use the first
    // envelope to derive the connectorId for qualified table name resolution.
    const firstEnvelope = envelopes[0];
    if (firstEnvelope === undefined) return;
    const connectorId = firstEnvelope._connector_id;

    await this.insertBatch(connectorId, envelopes);
  }

  // tableExists — checks the pg_tables catalog for the given table name within
  // the ingestion schema. Used by the retention service before attempting DDL.
  async tableExists(tableName: string): Promise<boolean> {
    if (!validateRawTableName(tableName)) {
      throw new Error(
        `tableExists: invalid raw table name "${tableName}" — must match raw_<uuid> pattern`
      );
    }
    const result = await this.pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM pg_tables
          WHERE schemaname = 'ingestion'
            AND tablename  = $1
       ) AS exists`,
      [tableName]
    );
    return result.rows[0]?.exists ?? false;
  }

}
