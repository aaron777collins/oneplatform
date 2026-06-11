import type pg from "pg";
import type {
  AppRow,
  CreateAppData,
  UpdateAppData,
} from "./types.js";

const APP_COLUMNS = `
  id, tenant_id, name, slug, description, access_mode,
  current_build_id, allowed_modules, created_at, updated_at, created_by, deleted_at
`;

export class AppRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(data: CreateAppData): Promise<AppRow> {
    const result = await this.pool.query<AppRow>(
      `INSERT INTO app.apps
         (tenant_id, name, slug, description, access_mode, allowed_modules, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${APP_COLUMNS}`,
      [
        data.tenant_id,
        data.name,
        data.slug,
        data.description ?? null,
        data.access_mode,
        data.allowed_modules ?? [
          "react", "react-dom",
          "@oneplatform/app-sdk", "@oneplatform/core", "recharts",
        ],
        data.created_by,
      ]
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("INSERT INTO app.apps returned no rows");
    }
    return row;
  }

  async findById(id: string): Promise<AppRow | null> {
    const result = await this.pool.query<AppRow>(
      `SELECT ${APP_COLUMNS} FROM app.apps WHERE id = $1 AND deleted_at IS NULL`,
      [id]
    );
    return result.rows[0] ?? null;
  }

  async findByTenantAndId(tenantId: string, id: string): Promise<AppRow | null> {
    const result = await this.pool.query<AppRow>(
      `SELECT ${APP_COLUMNS}
         FROM app.apps
        WHERE id = $1
          AND tenant_id = $2
          AND deleted_at IS NULL`,
      [id, tenantId]
    );
    return result.rows[0] ?? null;
  }

  // Finds a public app by slug regardless of tenant — used for public app serving
  // where we must resolve the slug without a session.
  async findPublicBySlug(slug: string): Promise<AppRow | null> {
    const result = await this.pool.query<AppRow>(
      `SELECT ${APP_COLUMNS}
         FROM app.apps
        WHERE slug = $1
          AND access_mode = 'public'
          AND deleted_at IS NULL`,
      [slug]
    );
    return result.rows[0] ?? null;
  }

  async findByTenantAndSlug(tenantId: string, slug: string): Promise<AppRow | null> {
    const result = await this.pool.query<AppRow>(
      `SELECT ${APP_COLUMNS}
         FROM app.apps
        WHERE tenant_id = $1
          AND slug = $2
          AND deleted_at IS NULL`,
      [tenantId, slug]
    );
    return result.rows[0] ?? null;
  }

  async findByTenantId(
    tenantId: string,
    options?: { cursor?: string; limit?: number }
  ): Promise<AppRow[]> {
    const limit = options?.limit ?? 50;
    const conditions: string[] = ["tenant_id = $1", "deleted_at IS NULL"];
    const values: unknown[] = [tenantId];
    let idx = 2;

    if (options?.cursor !== undefined) {
      conditions.push(`id > $${idx++}`);
      values.push(options.cursor);
    }

    values.push(limit);

    const result = await this.pool.query<AppRow>(
      `SELECT ${APP_COLUMNS}
         FROM app.apps
        WHERE ${conditions.join(" AND ")}
        ORDER BY created_at ASC, id ASC
        LIMIT $${idx}`,
      values
    );
    return result.rows;
  }

  async countByTenantId(tenantId: string): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM app.apps WHERE tenant_id = $1 AND deleted_at IS NULL",
      [tenantId]
    );
    return parseInt(result.rows[0]?.count ?? "0", 10);
  }

  async update(id: string, data: UpdateAppData): Promise<AppRow | null> {
    const sets: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (data.name !== undefined) {
      sets.push(`name = $${idx++}`);
      values.push(data.name);
    }
    if (data.slug !== undefined) {
      sets.push(`slug = $${idx++}`);
      values.push(data.slug);
    }
    if (data.description !== undefined) {
      sets.push(`description = $${idx++}`);
      values.push(data.description);  // null clears the column
    }
    if (data.access_mode !== undefined) {
      sets.push(`access_mode = $${idx++}`);
      values.push(data.access_mode);
    }
    if (data.allowed_modules !== undefined) {
      sets.push(`allowed_modules = $${idx++}`);
      values.push(data.allowed_modules);
    }
    // current_build_id accepts null explicitly (deploy/rollback)
    if ("current_build_id" in data) {
      sets.push(`current_build_id = $${idx++}`);
      values.push(data.current_build_id ?? null);
    }

    if (sets.length === 0) {
      throw new Error(`update() called with no fields to update for app ${id}`);
    }

    sets.push("updated_at = now()");
    values.push(id);

    const result = await this.pool.query<AppRow>(
      `UPDATE app.apps
            SET ${sets.join(", ")}
          WHERE id = $${idx}
            AND deleted_at IS NULL
      RETURNING ${APP_COLUMNS}`,
      values
    );
    return result.rows[0] ?? null;
  }

  // Soft-deletes the app by setting deleted_at. The slug indexes use WHERE
  // deleted_at IS NULL so soft-deleted slugs are immediately reusable.
  async softDelete(id: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE app.apps SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`,
      [id]
    );
    return result.rowCount !== null && result.rowCount > 0;
  }
}
