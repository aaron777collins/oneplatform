// Embed token persistence — G-071
//
// This repository is the source of truth for revocation status and audit listing.
// The JWT payload carries the policy; we store only what we need for revocation
// checks and management API responses.

import type pg from "pg";
import type { EmbedTokenRow, CreateEmbedTokenData } from "./types.js";

export class EmbedTokenRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(data: CreateEmbedTokenData): Promise<EmbedTokenRow> {
    const { rows } = await this.pool.query<EmbedTokenRow>(
      `INSERT INTO app.embed_tokens
         (app_id, tenant_id, allowed_origins, permissions, expires_at, created_by)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6)
       RETURNING
         id,
         app_id,
         tenant_id,
         allowed_origins,
         permissions,
         expires_at,
         revoked_at,
         created_at,
         created_by`,
      [
        data.app_id,
        data.tenant_id,
        JSON.stringify(data.allowed_origins),
        data.permissions,
        data.expires_at,
        data.created_by,
      ]
    );

    const row = rows[0];
    if (row === undefined) {
      throw new Error("embed_tokens INSERT returned no rows — this should never happen.");
    }

    return this.normalizeRow(row);
  }

  async findById(id: string): Promise<EmbedTokenRow | null> {
    const { rows } = await this.pool.query<EmbedTokenRow>(
      `SELECT
         id, app_id, tenant_id, allowed_origins, permissions,
         expires_at, revoked_at, created_at, created_by
       FROM app.embed_tokens
       WHERE id = $1`,
      [id]
    );

    const row = rows[0];
    return row !== undefined ? this.normalizeRow(row) : null;
  }

  async listActiveByApp(appId: string, tenantId: string): Promise<EmbedTokenRow[]> {
    const { rows } = await this.pool.query<EmbedTokenRow>(
      `SELECT
         id, app_id, tenant_id, allowed_origins, permissions,
         expires_at, revoked_at, created_at, created_by
       FROM app.embed_tokens
       WHERE app_id = $1
         AND tenant_id = $2
         AND revoked_at IS NULL
         AND expires_at > now()
       ORDER BY created_at DESC`,
      [appId, tenantId]
    );

    return rows.map((r) => this.normalizeRow(r));
  }

  async revoke(id: string, appId: string, tenantId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE app.embed_tokens
       SET revoked_at = now()
       WHERE id = $1
         AND app_id = $2
         AND tenant_id = $3
         AND revoked_at IS NULL`,
      [id, appId, tenantId]
    );

    return (rowCount ?? 0) > 0;
  }

  // pg returns JSONB columns as already-parsed JS objects; allowed_origins comes
  // back as string[] but TypeScript types it as the raw row shape.  We cast
  // explicitly so callers always get a clean EmbedTokenRow.
  private normalizeRow(raw: EmbedTokenRow): EmbedTokenRow {
    return {
      ...raw,
      allowed_origins: raw.allowed_origins as unknown as string[],
    };
  }
}
