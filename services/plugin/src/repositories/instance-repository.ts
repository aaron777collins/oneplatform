import type pg from "pg";
import type { InstanceRow, CreateInstanceData, UpdateInstanceData } from "./types.js";

const INSTANCE_COLUMNS = `
  id, plugin_manifest_id, plugin_id, tenant_id, display_name, config,
  enabled, created_at, created_by, updated_at, updated_by, deleted_at
`;

export class InstanceRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(data: CreateInstanceData): Promise<InstanceRow> {
    const result = await this.pool.query<InstanceRow>(
      `INSERT INTO plugin.instances
         (plugin_manifest_id, plugin_id, tenant_id, display_name, config, enabled, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${INSTANCE_COLUMNS}`,
      [
        data.plugin_manifest_id,
        data.plugin_id,
        data.tenant_id,
        data.display_name,
        JSON.stringify(data.config),
        data.enabled,
        data.created_by,
      ]
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("INSERT INTO plugin.instances returned no rows");
    }
    return row;
  }

  async findById(id: string): Promise<InstanceRow | null> {
    const result = await this.pool.query<InstanceRow>(
      `SELECT ${INSTANCE_COLUMNS}
         FROM plugin.instances
        WHERE id = $1
          AND deleted_at IS NULL`,
      [id]
    );
    return result.rows[0] ?? null;
  }

  async findByIdAndTenant(id: string, tenantId: string): Promise<InstanceRow | null> {
    const result = await this.pool.query<InstanceRow>(
      `SELECT ${INSTANCE_COLUMNS}
         FROM plugin.instances
        WHERE id = $1
          AND tenant_id = $2
          AND deleted_at IS NULL`,
      [id, tenantId]
    );
    return result.rows[0] ?? null;
  }

  async findByPluginManifestId(
    pluginManifestId: string,
    options?: { tenantId?: string; includeDeleted?: boolean }
  ): Promise<InstanceRow[]> {
    const conditions: string[] = ["plugin_manifest_id = $1"];
    const values: unknown[] = [pluginManifestId];
    let idx = 2;

    if (options?.tenantId !== undefined) {
      conditions.push(`tenant_id = $${idx++}`);
      values.push(options.tenantId);
    }
    if (options?.includeDeleted !== true) {
      conditions.push("deleted_at IS NULL");
    }

    const result = await this.pool.query<InstanceRow>(
      `SELECT ${INSTANCE_COLUMNS}
         FROM plugin.instances
        WHERE ${conditions.join(" AND ")}
        ORDER BY created_at ASC`,
      values
    );
    return result.rows;
  }

  // Count enabled/disabling instances — used in uninstall guards (spec §11.1).
  async countActiveByManifestId(manifestId: string): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) FROM plugin.instances
        WHERE plugin_manifest_id = $1
          AND enabled IN ('enabled','disabling')
          AND deleted_at IS NULL`,
      [manifestId]
    );
    return parseInt(result.rows[0]?.["count"] ?? "0", 10);
  }

  async update(id: string, data: UpdateInstanceData): Promise<InstanceRow | null> {
    const sets: string[] = ["updated_at = now()"];
    const values: unknown[] = [];
    let idx = 1;

    if (data.display_name !== undefined) {
      sets.push(`display_name = $${idx++}`);
      values.push(data.display_name);
    }
    if (data.config !== undefined) {
      sets.push(`config = $${idx++}`);
      values.push(JSON.stringify(data.config));
    }
    if (data.enabled !== undefined) {
      sets.push(`enabled = $${idx++}`);
      values.push(data.enabled);
    }
    if (data.plugin_id !== undefined) {
      sets.push(`plugin_id = $${idx++}`);
      values.push(data.plugin_id);
    }
    if (data.updated_by !== undefined) {
      sets.push(`updated_by = $${idx++}`);
      values.push(data.updated_by);
    }
    if ("deleted_at" in data) {
      sets.push(`deleted_at = $${idx++}`);
      values.push(data.deleted_at ?? null);
    }

    values.push(id);
    const result = await this.pool.query<InstanceRow>(
      `UPDATE plugin.instances
            SET ${sets.join(", ")}
          WHERE id = $${idx}
      RETURNING ${INSTANCE_COLUMNS}`,
      values
    );
    return result.rows[0] ?? null;
  }

  // Update all instances pointing to a plugin to a new plugin_id version.
  // Used during the atomic version swap (spec §10.2).
  async updatePluginIdForManifest(
    client: pg.PoolClient,
    manifestId: string,
    newPluginId: string
  ): Promise<number> {
    const result = await client.query(
      `UPDATE plugin.instances
          SET plugin_id = $1, updated_at = now()
        WHERE plugin_manifest_id = $2`,
      [newPluginId, manifestId]
    );
    return result.rowCount ?? 0;
  }

  // Soft-delete all instances for a manifest — used during uninstall (spec §11.4).
  async softDeleteAllByManifestId(manifestId: string): Promise<number> {
    const result = await this.pool.query(
      `UPDATE plugin.instances
          SET deleted_at = now()
        WHERE plugin_manifest_id = $1
          AND deleted_at IS NULL`,
      [manifestId]
    );
    return result.rowCount ?? 0;
  }

  // Find all enabled connector instances for a tenant.
  async findEnabledConnectorsByTenant(
    tenantId: string,
    pluginType: string
  ): Promise<InstanceRow[]> {
    const result = await this.pool.query<InstanceRow>(
      `SELECT i.${INSTANCE_COLUMNS.split(",").map(c => c.trim()).join(", i.")}
         FROM plugin.instances i
         JOIN plugin.plugins p ON i.plugin_id = p.id
        WHERE i.tenant_id = $1
          AND i.enabled = 'enabled'
          AND i.deleted_at IS NULL
          AND p.type = $2`,
      [tenantId, pluginType]
    );
    return result.rows;
  }
}
