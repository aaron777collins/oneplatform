import type pg from "pg";
import type {
  MarketplacePluginRow,
  PluginRatingRow,
  CreateMarketplacePluginData,
  UpsertRatingData,
  MarketplaceListQuery,
} from "./marketplace-types.js";

// Columns selected for marketplace plugin list/detail queries.
// search_vector is excluded — it is a large generated column only used in WHERE.
const MARKETPLACE_COLUMNS = `
  id, name, display_name, description, version, type,
  author_name, author_email, category, tags, manifest,
  downloads, rating_average, rating_count, verified,
  published_by, published_at, updated_at
`;

const RATING_COLUMNS = `
  id, marketplace_plugin_id, user_id, rating, review, created_at, updated_at
`;

export class MarketplaceRepository {
  constructor(private readonly pool: pg.Pool) {}

  // ---------------------------------------------------------------------------
  // Marketplace plugin CRUD
  // ---------------------------------------------------------------------------

  async create(data: CreateMarketplacePluginData): Promise<MarketplacePluginRow> {
    const result = await this.pool.query<MarketplacePluginRow>(
      `INSERT INTO plugin.marketplace_plugins
         (name, display_name, description, version, type,
          author_name, author_email, category, tags, manifest, published_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING ${MARKETPLACE_COLUMNS}`,
      [
        data.name,
        data.display_name,
        data.description,
        data.version,
        data.type,
        data.author_name,
        data.author_email ?? null,
        data.category,
        JSON.stringify(data.tags),
        JSON.stringify(data.manifest),
        data.published_by,
      ]
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("INSERT INTO plugin.marketplace_plugins returned no rows");
    }
    return row;
  }

  async findById(id: string): Promise<MarketplacePluginRow | null> {
    const result = await this.pool.query<MarketplacePluginRow>(
      `SELECT ${MARKETPLACE_COLUMNS}
         FROM plugin.marketplace_plugins
        WHERE id = $1`,
      [id]
    );
    return result.rows[0] ?? null;
  }

  async findByName(name: string): Promise<MarketplacePluginRow | null> {
    const result = await this.pool.query<MarketplacePluginRow>(
      `SELECT ${MARKETPLACE_COLUMNS}
         FROM plugin.marketplace_plugins
        WHERE name = $1`,
      [name]
    );
    return result.rows[0] ?? null;
  }

  // Cursor-based paginated list with optional full-text search, type/category
  // filters, and multiple sort orders.
  async list(
    options: MarketplaceListQuery
  ): Promise<{ rows: MarketplacePluginRow[]; total: number }> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (options.search !== undefined && options.search.length > 0) {
      // plainto_tsquery handles multi-word phrases without requiring the caller
      // to construct tsquery syntax, making it safe against injection.
      conditions.push(`search_vector @@ plainto_tsquery('english', $${idx++})`);
      values.push(options.search);
    }

    if (options.type !== undefined && options.type.length > 0) {
      conditions.push(`type = $${idx++}`);
      values.push(options.type);
    }

    if (options.category !== undefined && options.category.length > 0) {
      conditions.push(`category = $${idx++}`);
      values.push(options.category);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Total count without cursor so callers can render pagination UI correctly.
    const countResult = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) FROM plugin.marketplace_plugins ${whereClause}`,
      values
    );
    const total = parseInt(countResult.rows[0]?.["count"] ?? "0", 10);

    // Cursor pagination: encode (sort_value, id) in the cursor to ensure stable
    // ordering even when multiple rows share the same sort column value.
    const paginatedConditions = [...conditions];
    const paginatedValues = [...values];

    const sortBy = options.sortBy ?? "popular";

    // Add cursor predicate after count — cursor must not affect total.
    if (options.cursor !== undefined) {
      // Cursor is base64-encoded JSON: { id: string, sortVal: string }
      let cursorId: string | undefined;
      let cursorSortVal: string | undefined;
      try {
        const decoded = JSON.parse(
          Buffer.from(options.cursor, "base64").toString("utf-8")
        ) as { id?: unknown; sortVal?: unknown };
        cursorId = typeof decoded.id === "string" ? decoded.id : undefined;
        cursorSortVal = typeof decoded.sortVal === "string" ? decoded.sortVal : undefined;
      } catch {
        // Invalid cursor treated as no cursor — return from beginning.
        cursorId = undefined;
      }

      if (cursorId !== undefined) {
        // Use a compound cursor (sort_col, id) to handle ties in sort_col.
        // The expression varies per sort mode but the pattern is always:
        //   (sort_col, id) < (cursor_sort_val, cursor_id)  [for DESC columns]
        //   (sort_col, id) > (cursor_sort_val, cursor_id)  [for ASC columns]
        if (sortBy === "popular") {
          paginatedConditions.push(
            `(downloads, id) < ($${idx++}, $${idx++}::uuid)`
          );
        } else if (sortBy === "rating") {
          paginatedConditions.push(
            `(rating_average, id) < ($${idx++}::numeric, $${idx++}::uuid)`
          );
        } else if (sortBy === "recent") {
          paginatedConditions.push(
            `(published_at, id) < ($${idx++}::timestamptz, $${idx++}::uuid)`
          );
        } else {
          // name ASC — uses >
          paginatedConditions.push(
            `(name, id) > ($${idx++}, $${idx++}::uuid)`
          );
        }
        paginatedValues.push(cursorSortVal ?? "", cursorId);
      }
    }

    paginatedValues.push(options.limit);

    const paginatedWhere =
      paginatedConditions.length > 0
        ? `WHERE ${paginatedConditions.join(" AND ")}`
        : "";

    // Each sort mode uses a different ORDER BY to support efficient index scans.
    const orderBy: Record<string, string> = {
      popular: "ORDER BY downloads DESC, id DESC",
      rating: "ORDER BY rating_average DESC, id DESC",
      recent: "ORDER BY published_at DESC, id DESC",
      name: "ORDER BY name ASC, id ASC",
    };

    const result = await this.pool.query<MarketplacePluginRow>(
      `SELECT ${MARKETPLACE_COLUMNS}
         FROM plugin.marketplace_plugins
         ${paginatedWhere}
         ${orderBy[sortBy] ?? orderBy["popular"]}
         LIMIT $${idx}`,
      paginatedValues
    );

    return { rows: result.rows, total };
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM plugin.marketplace_plugins WHERE id = $1`,
      [id]
    );
    return (result.rowCount ?? 0) > 0;
  }

  // Atomically increment the download counter for a single plugin.
  // Called each time a tenant installs a marketplace plugin.
  async incrementDownloads(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE plugin.marketplace_plugins
          SET downloads = downloads + 1,
              updated_at = now()
        WHERE id = $1`,
      [id]
    );
  }

  // Recalculate the denormalised average + count from the ratings table.
  // Called transactionally after every upsert/delete of a rating row so the
  // values on marketplace_plugins stay consistent with plugin_ratings.
  async refreshRatingStats(pluginId: string, client: pg.PoolClient): Promise<void> {
    await client.query(
      `UPDATE plugin.marketplace_plugins mp
          SET rating_average = COALESCE(sub.avg, 0),
              rating_count   = COALESCE(sub.cnt, 0),
              updated_at     = now()
         FROM (
           SELECT AVG(rating)::numeric(3,2) AS avg,
                  COUNT(*)::int             AS cnt
             FROM plugin.plugin_ratings
            WHERE marketplace_plugin_id = $1
         ) sub
        WHERE mp.id = $1`,
      [pluginId]
    );
  }

  // Grant or revoke the verified badge. Only platform admins may call this.
  async setVerified(id: string, verified: boolean): Promise<MarketplacePluginRow | null> {
    const result = await this.pool.query<MarketplacePluginRow>(
      `UPDATE plugin.marketplace_plugins
          SET verified   = $2,
              updated_at = now()
        WHERE id = $1
        RETURNING ${MARKETPLACE_COLUMNS}`,
      [id, verified]
    );
    return result.rows[0] ?? null;
  }

  // ---------------------------------------------------------------------------
  // Ratings
  // ---------------------------------------------------------------------------

  // Upsert a rating — one row per (user, plugin). Returns the row and whether
  // this was an insert (true) or an update (false) so the caller can log it.
  async upsertRating(
    data: UpsertRatingData,
    client: pg.PoolClient
  ): Promise<{ row: PluginRatingRow; inserted: boolean }> {
    // ON CONFLICT … DO UPDATE lets PostgreSQL handle the race-free upsert.
    const result = await client.query<PluginRatingRow & { xmax: string }>(
      `INSERT INTO plugin.plugin_ratings
         (marketplace_plugin_id, user_id, rating, review)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (marketplace_plugin_id, user_id)
       DO UPDATE SET
         rating     = EXCLUDED.rating,
         review     = EXCLUDED.review,
         updated_at = now()
       RETURNING ${RATING_COLUMNS}, xmax`,
      [
        data.marketplace_plugin_id,
        data.user_id,
        data.rating,
        data.review ?? null,
      ]
    );

    const raw = result.rows[0];
    if (raw === undefined) {
      throw new Error("INSERT INTO plugin.plugin_ratings returned no rows");
    }

    // xmax = 0 means the row was freshly inserted; any other value is an update.
    const inserted = raw.xmax === "0";
    const { xmax: _xmax, ...row } = raw;
    return { row, inserted };
  }

  async findRatingsByPlugin(
    pluginId: string,
    limit: number,
    cursor?: string
  ): Promise<PluginRatingRow[]> {
    if (cursor !== undefined) {
      const result = await this.pool.query<PluginRatingRow>(
        `SELECT ${RATING_COLUMNS}
           FROM plugin.plugin_ratings
          WHERE marketplace_plugin_id = $1
            AND id > $2
          ORDER BY created_at DESC, id DESC
          LIMIT $3`,
        [pluginId, cursor, limit]
      );
      return result.rows;
    }

    const result = await this.pool.query<PluginRatingRow>(
      `SELECT ${RATING_COLUMNS}
         FROM plugin.plugin_ratings
        WHERE marketplace_plugin_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT $2`,
      [pluginId, limit]
    );
    return result.rows;
  }

  async findRatingByUser(
    pluginId: string,
    userId: string
  ): Promise<PluginRatingRow | null> {
    const result = await this.pool.query<PluginRatingRow>(
      `SELECT ${RATING_COLUMNS}
         FROM plugin.plugin_ratings
        WHERE marketplace_plugin_id = $1
          AND user_id = $2`,
      [pluginId, userId]
    );
    return result.rows[0] ?? null;
  }
}
