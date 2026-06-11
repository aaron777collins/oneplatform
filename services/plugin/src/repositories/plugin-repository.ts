import type pg from "pg";
import type {
  PluginRow,
  CreatePluginData,
  UpdatePluginData,
  ApprovedUrlRow,
  CreateApprovedUrlData,
} from "./types.js";

const PLUGIN_COLUMNS = `
  id, manifest_id, name, version, type, status, bundle_bucket, bundle_key,
  manifest, is_platform_wide, gpg_fingerprint,
  installed_at, installed_by, uninstalled_at, bundle_delete_after
`;

export class PluginRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(data: CreatePluginData): Promise<PluginRow> {
    const result = await this.pool.query<PluginRow>(
      `INSERT INTO plugin.plugins
         (manifest_id, name, version, type, status, bundle_bucket, bundle_key,
          manifest, is_platform_wide, installed_by, gpg_fingerprint)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING ${PLUGIN_COLUMNS}`,
      [
        data.manifest_id,
        data.name,
        data.version,
        data.type,
        data.status,
        data.bundle_bucket,
        data.bundle_key,
        JSON.stringify(data.manifest),
        data.is_platform_wide,
        data.installed_by,
        data.gpg_fingerprint ?? null,
      ]
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("INSERT INTO plugin.plugins returned no rows");
    }
    return row;
  }

  async findById(id: string): Promise<PluginRow | null> {
    const result = await this.pool.query<PluginRow>(
      `SELECT ${PLUGIN_COLUMNS} FROM plugin.plugins WHERE id = $1`,
      [id]
    );
    return result.rows[0] ?? null;
  }

  // Resolve a manifest_id to its currently active version row.
  async findActiveByManifestId(manifestId: string): Promise<PluginRow | null> {
    const result = await this.pool.query<PluginRow>(
      `SELECT ${PLUGIN_COLUMNS}
         FROM plugin.plugins
        WHERE manifest_id = $1
          AND status = 'active'`,
      [manifestId]
    );
    return result.rows[0] ?? null;
  }

  // Find by manifest_id + specific version (any status).
  async findByManifestIdAndVersion(
    manifestId: string,
    version: string
  ): Promise<PluginRow | null> {
    const result = await this.pool.query<PluginRow>(
      `SELECT ${PLUGIN_COLUMNS}
         FROM plugin.plugins
        WHERE manifest_id = $1
          AND version = $2`,
      [manifestId, version]
    );
    return result.rows[0] ?? null;
  }

  // Find staged version for a manifest_id (at most one per manifest).
  async findStagedByManifestId(manifestId: string): Promise<PluginRow | null> {
    const result = await this.pool.query<PluginRow>(
      `SELECT ${PLUGIN_COLUMNS}
         FROM plugin.plugins
        WHERE manifest_id = $1
          AND status = 'staged'`,
      [manifestId]
    );
    return result.rows[0] ?? null;
  }

  // List plugins with optional filters and cursor-based pagination.
  async list(options: {
    type?: string;
    status?: string;
    q?: string;
    cursor?: string;
    limit: number;
  }): Promise<{ rows: PluginRow[]; total: number }> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (options.type !== undefined) {
      conditions.push(`type = $${idx++}`);
      values.push(options.type);
    }
    if (options.status !== undefined) {
      conditions.push(`status = $${idx++}`);
      values.push(options.status);
    }
    if (options.q !== undefined && options.q.length > 0) {
      conditions.push(
        `to_tsvector('english', name || ' ' || manifest_id) @@ plainto_tsquery('english', $${idx++})`
      );
      values.push(options.q);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const countResult = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) FROM plugin.plugins ${whereClause}`,
      values
    );
    const total = parseInt(countResult.rows[0]?.["count"] ?? "0", 10);

    // Add cursor condition after the total count to avoid skewing it
    const paginatedConditions = [...conditions];
    const paginatedValues = [...values];
    if (options.cursor !== undefined) {
      paginatedConditions.push(`id > $${idx++}`);
      paginatedValues.push(options.cursor);
    }
    paginatedValues.push(options.limit);

    const paginatedWhere =
      paginatedConditions.length > 0
        ? `WHERE ${paginatedConditions.join(" AND ")}`
        : "";

    const result = await this.pool.query<PluginRow>(
      `SELECT ${PLUGIN_COLUMNS}
         FROM plugin.plugins
         ${paginatedWhere}
         ORDER BY installed_at DESC, id DESC
         LIMIT $${idx}`,
      paginatedValues
    );

    return { rows: result.rows, total };
  }

  async update(id: string, data: UpdatePluginData): Promise<PluginRow | null> {
    const sets: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (data.status !== undefined) {
      sets.push(`status = $${idx++}`);
      values.push(data.status);
    }
    if ("bundle_key" in data) {
      sets.push(`bundle_key = $${idx++}`);
      values.push(data.bundle_key ?? null);
    }
    if ("bundle_delete_after" in data) {
      sets.push(`bundle_delete_after = $${idx++}`);
      values.push(data.bundle_delete_after ?? null);
    }
    if ("uninstalled_at" in data) {
      sets.push(`uninstalled_at = $${idx++}`);
      values.push(data.uninstalled_at ?? null);
    }

    if (sets.length === 0) {
      throw new Error(`update() called with no fields for plugin ${id}`);
    }

    values.push(id);
    const result = await this.pool.query<PluginRow>(
      `UPDATE plugin.plugins
            SET ${sets.join(", ")}
          WHERE id = $${idx}
      RETURNING ${PLUGIN_COLUMNS}`,
      values
    );
    return result.rows[0] ?? null;
  }

  // Find all plugins whose bundles are past their delete-after date.
  async findExpiredBundles(): Promise<PluginRow[]> {
    const result = await this.pool.query<PluginRow>(
      `SELECT ${PLUGIN_COLUMNS}
         FROM plugin.plugins
        WHERE bundle_delete_after <= now()
          AND status IN ('uninstalled', 'disabled')
          AND bundle_key IS NOT NULL`
    );
    return result.rows;
  }

  // ---------------------------------------------------------------------------
  // Approved URL helpers
  // ---------------------------------------------------------------------------

  async createApprovedUrl(data: CreateApprovedUrlData): Promise<ApprovedUrlRow> {
    const result = await this.pool.query<ApprovedUrlRow>(
      `INSERT INTO plugin.approved_urls (plugin_id, url_pattern, approved_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (plugin_id, url_pattern) DO NOTHING
       RETURNING id, plugin_id, url_pattern, approved_by, approved_at`,
      [data.plugin_id, data.url_pattern, data.approved_by]
    );
    // ON CONFLICT DO NOTHING returns empty rows — fetch the existing row
    if (result.rows.length === 0) {
      const existing = await this.pool.query<ApprovedUrlRow>(
        `SELECT id, plugin_id, url_pattern, approved_by, approved_at
           FROM plugin.approved_urls
          WHERE plugin_id = $1
            AND url_pattern = $2`,
        [data.plugin_id, data.url_pattern]
      );
      const row = existing.rows[0];
      if (row === undefined) {
        throw new Error("Failed to fetch approved_url after upsert");
      }
      return row;
    }
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("INSERT INTO plugin.approved_urls returned no rows");
    }
    return row;
  }

  async findApprovedUrlsByPlugin(pluginId: string): Promise<ApprovedUrlRow[]> {
    const result = await this.pool.query<ApprovedUrlRow>(
      `SELECT id, plugin_id, url_pattern, approved_by, approved_at
         FROM plugin.approved_urls
        WHERE plugin_id = $1`,
      [pluginId]
    );
    return result.rows;
  }
}
