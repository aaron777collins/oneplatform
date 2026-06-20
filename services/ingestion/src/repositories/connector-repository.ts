import type pg from "pg";
import type {
  ConnectorRow,
  SyncStateRow,
  CreateConnectorData,
  UpdateConnectorData,
} from "./types.js";
import type {
  ListConnectorsOptions,
  ConnectorListResult,
} from "../services/connector-service.js";

const CONNECTOR_COLUMNS = `
  id, tenant_id, plugin_id, instance_id, name, description,
  config, sync_mode, schedule_cron, is_enabled, created_by,
  created_at, updated_at, deleted_at
`;

export class ConnectorRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(data: CreateConnectorData): Promise<ConnectorRow> {
    const result = await this.pool.query<ConnectorRow>(
      `INSERT INTO ingestion.connectors
         (tenant_id, plugin_id, instance_id, name, description,
          config, sync_mode, schedule_cron, is_enabled, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING ${CONNECTOR_COLUMNS}`,
      [
        data.tenant_id,
        data.plugin_id,
        data.instance_id,
        data.name,
        data.description ?? null,
        JSON.stringify(data.config),
        data.sync_mode ?? "incremental",
        data.schedule_cron ?? null,
        data.is_enabled ?? true,
        data.created_by,
      ]
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("INSERT INTO ingestion.connectors returned no rows");
    }
    return row;
  }

  async findById(id: string): Promise<ConnectorRow | null> {
    const result = await this.pool.query<ConnectorRow>(
      `SELECT ${CONNECTOR_COLUMNS}
         FROM ingestion.connectors
        WHERE id = $1
          AND deleted_at IS NULL`,
      [id]
    );
    return result.rows[0] ?? null;
  }

  // Paginated cursor-based list for a tenant. Cursor is the `id` of the last
  // seen row; ordering by (created_at ASC, id ASC) gives stable pages.
  async findByTenantId(
    tenantId: string,
    options?: { cursor?: string; limit?: number }
  ): Promise<ConnectorRow[]> {
    const limit = options?.limit ?? 50;
    const cursor = options?.cursor;

    if (cursor !== undefined) {
      const result = await this.pool.query<ConnectorRow>(
        `SELECT ${CONNECTOR_COLUMNS}
           FROM ingestion.connectors
          WHERE tenant_id = $1
            AND deleted_at IS NULL
            AND id > $2
          ORDER BY created_at ASC, id ASC
          LIMIT $3`,
        [tenantId, cursor, limit]
      );
      return result.rows;
    }

    const result = await this.pool.query<ConnectorRow>(
      `SELECT ${CONNECTOR_COLUMNS}
         FROM ingestion.connectors
        WHERE tenant_id = $1
          AND deleted_at IS NULL
        ORDER BY created_at ASC, id ASC
        LIMIT $2`,
      [tenantId, limit]
    );
    return result.rows;
  }

  async update(id: string, data: UpdateConnectorData): Promise<ConnectorRow | null> {
    const sets: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (data.name !== undefined) {
      sets.push(`name = $${idx++}`);
      values.push(data.name);
    }
    if (data.description !== undefined) {
      sets.push(`description = $${idx++}`);
      values.push(data.description); // null clears the column
    }
    if (data.config !== undefined) {
      sets.push(`config = $${idx++}`);
      values.push(JSON.stringify(data.config));
    }
    if (data.sync_mode !== undefined) {
      sets.push(`sync_mode = $${idx++}`);
      values.push(data.sync_mode);
    }
    if (data.schedule_cron !== undefined) {
      sets.push(`schedule_cron = $${idx++}`);
      values.push(data.schedule_cron); // null clears the column
    }
    if (data.is_enabled !== undefined) {
      sets.push(`is_enabled = $${idx++}`);
      values.push(data.is_enabled);
    }

    if (sets.length === 0) {
      throw new Error(`update() called with no fields to update for connector ${id}`);
    }

    sets.push(`updated_at = now()`);
    values.push(id);

    const result = await this.pool.query<ConnectorRow>(
      `UPDATE ingestion.connectors
            SET ${sets.join(", ")}
          WHERE id = $${idx}
            AND deleted_at IS NULL
      RETURNING ${CONNECTOR_COLUMNS}`,
      values
    );
    return result.rows[0] ?? null;
  }

  // Soft-delete: sets deleted_at to the current timestamp. The connector
  // remains in the table so FK references from sync_state and credentials
  // are preserved until background cleanup completes (credentials deleted
  // immediately; raw table dropped after 7 days per the design spec §3.4).
  async softDelete(id: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ingestion.connectors
            SET deleted_at = now(),
                updated_at = now()
          WHERE id = $1
            AND deleted_at IS NULL`,
      [id]
    );
    return result.rowCount !== null && result.rowCount > 0;
  }

  // Used by the Plugin Service unregister flow (DELETE /internal/ingestion/connectors/plugin/:pluginId)
  // to disable all connectors belonging to an uninstalled plugin across all tenants.
  // Returns the number of connectors updated.
  async findByPluginId(pluginId: string): Promise<ConnectorRow[]> {
    const result = await this.pool.query<ConnectorRow>(
      `SELECT ${CONNECTOR_COLUMNS}
         FROM ingestion.connectors
        WHERE plugin_id = $1
          AND deleted_at IS NULL
        ORDER BY created_at ASC, id ASC`,
      [pluginId]
    );
    return result.rows;
  }

  // Disables (not soft-deletes) all connectors for a given plugin. Called
  // when a plugin is uninstalled platform-wide so existing connector rows
  // remain visible in the UI with is_enabled=false rather than disappearing.
  async disableByPluginId(pluginId: string): Promise<number> {
    const result = await this.pool.query(
      `UPDATE ingestion.connectors
            SET is_enabled = false,
                updated_at = now()
          WHERE plugin_id = $1
            AND deleted_at IS NULL
            AND is_enabled = true`,
      [pluginId]
    );
    return result.rowCount ?? 0;
  }

  // Counts non-deleted connectors for a tenant — used to build the
  // pagination total in list responses without a second round-trip.
  async countByTenantId(tenantId: string): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT count(*) AS count
         FROM ingestion.connectors
        WHERE tenant_id = $1
          AND deleted_at IS NULL`,
      [tenantId]
    );
    const row = result.rows[0];
    return row !== undefined ? parseInt(row["count"], 10) : 0;
  }

  // Tenant-scoped lookup by primary key. Returns null for cross-tenant access
  // so callers get a consistent not-found result rather than a data leak.
  async findByTenantAndId(tenantId: string, id: string): Promise<ConnectorRow | null> {
    // Empty tenantId is the internal "*" wildcard used by retention and plugin
    // uninstall paths — those callers receive the full row without tenant filtering.
    if (tenantId === "" || tenantId === "*") {
      return this.findById(id);
    }
    const result = await this.pool.query<ConnectorRow>(
      `SELECT ${CONNECTOR_COLUMNS}
         FROM ingestion.connectors
        WHERE id = $1
          AND tenant_id = $2
          AND deleted_at IS NULL`,
      [id, tenantId]
    );
    return result.rows[0] ?? null;
  }

  // Paginated list with LEFT JOIN on sync_state so each item includes current
  // sync status. Supports cursor-based pagination, filtering by status / plugin,
  // and sorting. When tenantId is "*" or empty, lists across all tenants
  // (internal maintenance operations only).
  async list(tenantId: string, options: ListConnectorsOptions): Promise<ConnectorListResult> {
    const conditions: string[] = ["c.deleted_at IS NULL"];
    const values: unknown[] = [];
    let idx = 1;

    // Tenant scoping — skip when the caller is an internal maintenance path.
    if (tenantId !== "" && tenantId !== "*") {
      conditions.push(`c.tenant_id = $${idx++}`);
      values.push(tenantId);
    }

    if (options.filterPluginId !== undefined) {
      conditions.push(`c.plugin_id = $${idx++}`);
      values.push(options.filterPluginId);
    }

    if (options.filterStatus === "enabled") {
      conditions.push("c.is_enabled = TRUE");
    } else if (options.filterStatus === "disabled") {
      conditions.push("c.is_enabled = FALSE");
    }

    const countWhereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const countValues = [...values];

    if (options.cursor !== undefined) {
      conditions.push(`c.id > $${idx++}`);
      values.push(options.cursor);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Determine ORDER BY direction from the sort string (e.g. "createdAt" or "-createdAt").
    const sortDesc = options.sort.startsWith("-");
    const orderDir = sortDesc ? "DESC" : "ASC";

    // Count total matching rows for pagination metadata.
    // Uses the conditions WITHOUT the cursor clause so total reflects the full result set.
    const countResult = await this.pool.query<{ count: string }>(
      `SELECT count(*) AS count
         FROM ingestion.connectors c
         ${countWhereClause}`,
      countValues
    );
    const total = countResult.rows[0] !== undefined
      ? parseInt(countResult.rows[0]["count"], 10)
      : 0;

    // Shape of a single row returned by the connector + sync_state JOIN.
    // Column aliases (ss_*) prevent clashes with connector columns of the
    // same name (e.g. sync_mode, updated_at).
    interface JoinRow {
      // Connector columns
      id: string;
      tenant_id: string;
      plugin_id: string;
      instance_id: string;
      name: string;
      description: string | null;
      config: Record<string, unknown>;
      sync_mode: "full" | "incremental";
      schedule_cron: string | null;
      is_enabled: boolean;
      created_by: string;
      created_at: Date;
      updated_at: Date;
      deleted_at: Date | null;
      // sync_state columns (aliased to avoid name clashes)
      last_cursor: string | null;
      last_sync_at: Date | null;
      last_sync_job_id: string | null;
      ss_sync_mode: "full" | "incremental" | null;
      ss_status: "never_run" | "running" | "success" | "failed" | "cancelled" | null;
      last_error: string | null;
      last_error_code: string | null;
      rows_last_sync: string | null;
      rows_total: string | null;
      ss_updated_at: Date | null;
    }

    // Fetch the page with sync_state joined.
    values.push(options.limit);
    const rows = await this.pool.query<JoinRow>(
      `SELECT ${CONNECTOR_COLUMNS.trim()
          .split(",")
          .map((c) => `c.${c.trim()}`)
          .join(", ")},
              ss.last_cursor,
              ss.last_sync_at,
              ss.last_sync_job_id,
              ss.sync_mode       AS ss_sync_mode,
              ss.status          AS ss_status,
              ss.last_error,
              ss.last_error_code,
              ss.rows_last_sync,
              ss.rows_total,
              ss.updated_at      AS ss_updated_at
         FROM ingestion.connectors c
         LEFT JOIN ingestion.sync_state ss ON ss.connector_id = c.id
         ${whereClause}
         ORDER BY c.created_at ${orderDir}, c.id ${orderDir}
         LIMIT $${idx}`,
      values
    );

    const items = rows.rows.map((row): { connector: ConnectorRow; syncState: SyncStateRow } => {
      const r = row;
      const connector: ConnectorRow = {
        id: r.id,
        tenant_id: r.tenant_id,
        plugin_id: r.plugin_id,
        instance_id: r.instance_id,
        name: r.name,
        description: r.description,
        config: r.config,
        sync_mode: r.sync_mode,
        schedule_cron: r.schedule_cron,
        is_enabled: r.is_enabled,
        created_by: r.created_by,
        created_at: r.created_at,
        updated_at: r.updated_at,
        deleted_at: r.deleted_at,
      };
      // Synthesise a safe default sync state for connectors that predate the
      // sync_state row — this should not happen in production but provides
      // resilience during migrations and test scenarios.
      const syncState: SyncStateRow = {
        connector_id: r.id,
        last_cursor: r.last_cursor ?? null,
        last_sync_at: r.last_sync_at ?? null,
        last_sync_job_id: r.last_sync_job_id ?? null,
        sync_mode: r.ss_sync_mode ?? r.sync_mode,
        status: r.ss_status ?? "never_run",
        last_error: r.last_error ?? null,
        last_error_code: r.last_error_code ?? null,
        rows_last_sync: r.rows_last_sync ?? "0",
        rows_total: r.rows_total ?? "0",
        updated_at: r.ss_updated_at ?? r.updated_at,
      };
      return { connector, syncState };
    });

    const lastItem = items[items.length - 1];
    const nextCursor = items.length === options.limit && lastItem !== undefined
      ? lastItem.connector.id
      : null;

    return { items, data: items, nextCursor, total };
  }

  // Disables all non-deleted connectors matching the given instance_id.
  // Called when a specific connector instance is deregistered by the Plugin Service.
  async disableByInstanceId(instanceId: string): Promise<number> {
    const result = await this.pool.query(
      `UPDATE ingestion.connectors
            SET is_enabled = false,
                updated_at = now()
          WHERE instance_id = $1
            AND deleted_at IS NULL
            AND is_enabled = true`,
      [instanceId]
    );
    return result.rowCount ?? 0;
  }

  // findDeletedBefore returns connectors that were soft-deleted before cutoffDate.
  // Used by the retention job to identify rows whose grace period has elapsed
  // and whose raw tables are safe to drop.
  async findDeletedBefore(cutoffDate: Date): Promise<ConnectorRow[]> {
    const result = await this.pool.query<ConnectorRow>(
      `SELECT ${CONNECTOR_COLUMNS}
         FROM ingestion.connectors
        WHERE deleted_at IS NOT NULL
          AND deleted_at < $1
        ORDER BY deleted_at ASC`,
      [cutoffDate]
    );
    return result.rows;
  }

  // hardDelete permanently removes a connector row. Only safe to call after
  // the raw table has been dropped and FK-referencing rows have been removed.
  // Using a direct DELETE rather than updating deleted_at so the row is gone
  // from all future queries without any ambiguity.
  async hardDelete(id: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM ingestion.connectors WHERE id = $1`,
      [id]
    );
  }
}
