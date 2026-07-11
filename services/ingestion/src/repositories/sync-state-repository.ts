import type pg from "pg";
import type { SyncStateRow } from "./types.js";

const SYNC_STATE_COLUMNS = `
  connector_id, last_cursor, last_sync_at, last_sync_job_id,
  sync_mode, status, last_error, last_error_code,
  rows_last_sync, rows_total, updated_at
`;

export class SyncStateRepository {
  constructor(private readonly pool: pg.Pool) {}

  // Creates or replaces the sync state row for a connector. Called once
  // when a connector is first activated. ON CONFLICT updates every mutable
  // column so this is safe to call idempotently on repeated activation.
  async upsert(data: {
    connector_id: string;
    sync_mode: "full" | "incremental";
    status?: "never_run" | "running" | "success" | "failed" | "cancelled";
    last_cursor?: string;
    last_sync_at?: Date;
    last_sync_job_id?: string;
    last_error?: string;
    last_error_code?: string;
    rows_last_sync?: number;
    rows_total?: number;
  }, client?: pg.PoolClient): Promise<SyncStateRow> {
    const queryable = client ?? this.pool;
    const result = await queryable.query<SyncStateRow>(
      `INSERT INTO ingestion.sync_state
         (connector_id, sync_mode, status, last_cursor, last_sync_at,
          last_sync_job_id, last_error, last_error_code,
          rows_last_sync, rows_total)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (connector_id) DO UPDATE
           SET sync_mode        = EXCLUDED.sync_mode,
               status           = EXCLUDED.status,
               last_cursor      = EXCLUDED.last_cursor,
               last_sync_at     = EXCLUDED.last_sync_at,
               last_sync_job_id = EXCLUDED.last_sync_job_id,
               last_error       = EXCLUDED.last_error,
               last_error_code  = EXCLUDED.last_error_code,
               rows_last_sync   = EXCLUDED.rows_last_sync,
               rows_total       = EXCLUDED.rows_total,
               updated_at       = now()
       RETURNING ${SYNC_STATE_COLUMNS}`,
      [
        data.connector_id,
        data.sync_mode,
        data.status ?? "never_run",
        data.last_cursor ?? null,
        data.last_sync_at ?? null,
        data.last_sync_job_id ?? null,
        data.last_error ?? null,
        data.last_error_code ?? null,
        data.rows_last_sync ?? 0,
        data.rows_total ?? 0,
      ]
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(
        `UPSERT INTO ingestion.sync_state returned no rows for connector ${data.connector_id}`
      );
    }
    return row;
  }

  async findByConnectorId(connectorId: string): Promise<SyncStateRow | null> {
    const result = await this.pool.query<SyncStateRow>(
      `SELECT ${SYNC_STATE_COLUMNS}
         FROM ingestion.sync_state
        WHERE connector_id = $1`,
      [connectorId]
    );
    return result.rows[0] ?? null;
  }

  async findByConnectorIds(connectorIds: string[]): Promise<Map<string, SyncStateRow>> {
    const map = new Map<string, SyncStateRow>();
    if (connectorIds.length === 0) return map;

    const placeholders = connectorIds.map((_, i) => `$${i + 1}`).join(", ");
    const result = await this.pool.query<SyncStateRow>(
      `SELECT ${SYNC_STATE_COLUMNS}
         FROM ingestion.sync_state
        WHERE connector_id IN (${placeholders})`,
      connectorIds,
    );

    for (const row of result.rows) {
      map.set(row.connector_id, row);
    }
    return map;
  }

  // Transitions the sync status. Returns null if the connector has no
  // sync_state row yet (caller should call upsert first).
  async updateStatus(
    connectorId: string,
    status: "never_run" | "running" | "success" | "failed" | "cancelled",
    extra?: {
      last_error?: string | null;
      last_error_code?: string | null;
      last_sync_at?: Date;
      last_sync_job_id?: string;
      rows_last_sync?: number;
      rows_total?: number;
    }
  ): Promise<SyncStateRow | null> {
    const sets: string[] = ["status = $1", "updated_at = now()"];
    const values: unknown[] = [status];
    let idx = 2;

    if (extra !== undefined) {
      if (extra.last_error !== undefined) {
        sets.push(`last_error = $${idx++}`);
        values.push(extra.last_error);
      }
      if (extra.last_error_code !== undefined) {
        sets.push(`last_error_code = $${idx++}`);
        values.push(extra.last_error_code);
      }
      if (extra.last_sync_at !== undefined) {
        sets.push(`last_sync_at = $${idx++}`);
        values.push(extra.last_sync_at);
      }
      if (extra.last_sync_job_id !== undefined) {
        sets.push(`last_sync_job_id = $${idx++}`);
        values.push(extra.last_sync_job_id);
      }
      if (extra.rows_last_sync !== undefined) {
        sets.push(`rows_last_sync = $${idx++}`);
        values.push(extra.rows_last_sync);
      }
      if (extra.rows_total !== undefined) {
        sets.push(`rows_total = $${idx++}`);
        values.push(extra.rows_total);
      }
    }

    values.push(connectorId);

    const result = await this.pool.query<SyncStateRow>(
      `UPDATE ingestion.sync_state
            SET ${sets.join(", ")}
          WHERE connector_id = $${idx}
      RETURNING ${SYNC_STATE_COLUMNS}`,
      values
    );
    return result.rows[0] ?? null;
  }

  // Atomically advances the cursor position. This is called within the same
  // transaction as the batch upsert for batches ≤ 5,000 records, providing
  // exactly-once cursor atomicity (design spec §6.3 cursor atomicity table).
  // For larger batches this runs in a separate transaction (at-least-once).
  async updateCursor(
    connectorId: string,
    lastCursor: string | null
  ): Promise<void> {
    await this.pool.query(
      `UPDATE ingestion.sync_state
            SET last_cursor = $1,
                updated_at  = now()
          WHERE connector_id = $2`,
      [lastCursor, connectorId]
    );
  }

  // findStaleSyncs returns sync_state rows currently in 'running' status whose
  // updated_at timestamp is older than olderThanMs milliseconds ago. The
  // watchdog uses this to log each affected connector before resetting them,
  // keeping the bulk reset in resetStaleSyncs as a single atomic UPDATE.
  async findStaleSyncs(olderThanMs: number): Promise<SyncStateRow[]> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const result = await this.pool.query<SyncStateRow>(
      `SELECT ${SYNC_STATE_COLUMNS}
         FROM ingestion.sync_state
        WHERE status     = 'running'
          AND updated_at < $1`,
      [cutoff],
    );
    return result.rows;
  }

  // resetStaleSyncs bulk-resets sync_state rows that have been stuck in
  // 'running' for longer than staleThresholdMs. Returns the count of reset rows.
  // The watchdog calls this periodically so connectors are never permanently
  // stuck after a crash or missed job pickup.
  async resetStaleSyncs(staleThresholdMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - staleThresholdMs);
    const result = await this.pool.query(
      `UPDATE ingestion.sync_state
            SET status     = 'failed',
                last_error = 'Sync timed out — reset by watchdog',
                updated_at = now()
          WHERE status     = 'running'
            AND updated_at < $1`,
      [cutoff],
    );
    return result.rowCount ?? 0;
  }

  // create — initialises the sync_state row for a new connector.
  // Delegates to upsert so the call is idempotent if the row already exists
  // (e.g. during connector re-activation after soft-restore).
  async create(
    connectorId: string,
    syncMode: "full" | "incremental"
  ): Promise<SyncStateRow> {
    return this.upsert({ connector_id: connectorId, sync_mode: syncMode });
  }

  // update — partial update of any SyncStateRow fields. Only provided fields
  // are written; omitted fields are left unchanged. This is the generic update
  // path used by the sync worker to record status, cursor, and error information
  // without having to restate every column.
  async update(
    connectorId: string,
    data: Partial<SyncStateRow>
  ): Promise<SyncStateRow | null> {
    const sets: string[] = ["updated_at = now()"];
    const values: unknown[] = [];
    let idx = 1;

    if (data.status !== undefined) {
      sets.push(`status = $${idx++}`);
      values.push(data.status);
    }
    if (data.last_cursor !== undefined) {
      sets.push(`last_cursor = $${idx++}`);
      values.push(data.last_cursor);
    }
    if (data.last_sync_at !== undefined) {
      sets.push(`last_sync_at = $${idx++}`);
      values.push(data.last_sync_at);
    }
    if (data.last_sync_job_id !== undefined) {
      sets.push(`last_sync_job_id = $${idx++}`);
      values.push(data.last_sync_job_id);
    }
    if (data.last_error !== undefined) {
      sets.push(`last_error = $${idx++}`);
      values.push(data.last_error);
    }
    if (data.last_error_code !== undefined) {
      sets.push(`last_error_code = $${idx++}`);
      values.push(data.last_error_code);
    }
    if (data.rows_last_sync !== undefined) {
      sets.push(`rows_last_sync = $${idx++}`);
      values.push(data.rows_last_sync);
    }
    if (data.rows_total !== undefined) {
      sets.push(`rows_total = $${idx++}`);
      values.push(data.rows_total);
    }

    values.push(connectorId);

    const result = await this.pool.query<SyncStateRow>(
      `UPDATE ingestion.sync_state
            SET ${sets.join(", ")}
          WHERE connector_id = $${idx}
      RETURNING ${SYNC_STATE_COLUMNS}`,
      values
    );
    return result.rows[0] ?? null;
  }
}
