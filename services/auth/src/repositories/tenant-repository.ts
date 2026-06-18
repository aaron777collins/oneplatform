import type pg from "pg";
import type {
  Tenant,
  CreateTenantData,
  UpdateTenantData,
  ListTenantsOptions,
} from "./types.js";

// Column list shared by all SELECT queries — keeps the list in one place so
// adding new columns doesn't require updating every query individually.
const TENANT_COLUMNS =
  "id, name, slug, created_at, updated_at, deleted_at, settings";

export class TenantRepository {
  constructor(private readonly pool: pg.Pool) {}

  async findById(id: string): Promise<Tenant | null> {
    const result = await this.pool.query<Tenant>(
      `SELECT ${TENANT_COLUMNS}
         FROM auth.tenants
        WHERE id = $1
          AND deleted_at IS NULL`,
      [id]
    );
    return result.rows[0] ?? null;
  }

  async findBySlug(slug: string): Promise<Tenant | null> {
    const result = await this.pool.query<Tenant>(
      `SELECT ${TENANT_COLUMNS}
         FROM auth.tenants
        WHERE slug = $1
          AND deleted_at IS NULL`,
      [slug]
    );
    return result.rows[0] ?? null;
  }

  async create(data: CreateTenantData): Promise<Tenant> {
    const result = await this.pool.query<Tenant>(
      `INSERT INTO auth.tenants (name, slug, settings)
            VALUES ($1, $2, $3)
         RETURNING ${TENANT_COLUMNS}`,
      [data.name, data.slug, JSON.stringify(data.settings ?? {})]
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("INSERT INTO auth.tenants returned no rows");
    }
    return row;
  }

  /**
   * List non-deleted tenants with offset-based pagination.
   *
   * Also returns the total count of non-deleted tenants so callers can
   * compute page metadata without a separate COUNT query.
   */
  async list(opts: ListTenantsOptions): Promise<{ tenants: Tenant[]; total: number }> {
    const countResult = await this.pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM auth.tenants WHERE deleted_at IS NULL`
    );
    const total = parseInt(countResult.rows[0]?.count ?? "0", 10);

    const rowsResult = await this.pool.query<Tenant>(
      `SELECT ${TENANT_COLUMNS}
         FROM auth.tenants
        WHERE deleted_at IS NULL
        ORDER BY created_at ASC
        LIMIT $1 OFFSET $2`,
      [opts.limit, opts.offset]
    );

    return { tenants: rowsResult.rows, total };
  }

  /**
   * Update mutable tenant fields (name and/or settings).
   * Returns null when the tenant does not exist or has been soft-deleted.
   */
  async update(id: string, data: UpdateTenantData): Promise<Tenant | null> {
    // Build the SET clause dynamically — only include columns that were
    // explicitly provided so callers can perform partial updates without
    // clobbering untouched fields.
    const setClauses: string[] = ["updated_at = now()"];
    const params: unknown[] = [id];

    if (data.name !== undefined) {
      params.push(data.name);
      setClauses.push(`name = $${params.length}`);
    }

    if (data.settings !== undefined) {
      params.push(JSON.stringify(data.settings));
      setClauses.push(`settings = $${params.length}`);
    }

    const result = await this.pool.query<Tenant>(
      `UPDATE auth.tenants
          SET ${setClauses.join(", ")}
        WHERE id = $1
          AND deleted_at IS NULL
        RETURNING ${TENANT_COLUMNS}`,
      params
    );

    return result.rows[0] ?? null;
  }

  /**
   * Soft-delete a tenant by setting deleted_at.
   *
   * Returns false when the tenant does not exist or was already deleted so
   * the route layer can distinguish "not found" from "already gone".
   */
  async delete(id: string): Promise<boolean> {
    const result = await this.pool.query<{ id: string }>(
      `UPDATE auth.tenants
          SET deleted_at = now(), updated_at = now()
        WHERE id = $1
          AND deleted_at IS NULL
        RETURNING id`,
      [id]
    );
    return (result.rowCount ?? 0) > 0;
  }
}
