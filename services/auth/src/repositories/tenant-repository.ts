import type pg from "pg";
import type { Tenant, CreateTenantData } from "./types.js";

export class TenantRepository {
  constructor(private readonly pool: pg.Pool) {}

  async findById(id: string): Promise<Tenant | null> {
    const result = await this.pool.query<Tenant>(
      `SELECT id, name, slug, created_at, updated_at, settings
         FROM auth.tenants
        WHERE id = $1`,
      [id]
    );
    return result.rows[0] ?? null;
  }

  async findBySlug(slug: string): Promise<Tenant | null> {
    const result = await this.pool.query<Tenant>(
      `SELECT id, name, slug, created_at, updated_at, settings
         FROM auth.tenants
        WHERE slug = $1`,
      [slug]
    );
    return result.rows[0] ?? null;
  }

  async create(data: CreateTenantData): Promise<Tenant> {
    const result = await this.pool.query<Tenant>(
      `INSERT INTO auth.tenants (name, slug, settings)
            VALUES ($1, $2, $3)
         RETURNING id, name, slug, created_at, updated_at, settings`,
      [data.name, data.slug, JSON.stringify(data.settings ?? {})]
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("INSERT INTO auth.tenants returned no rows");
    }
    return row;
  }
}
