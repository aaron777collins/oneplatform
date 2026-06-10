import type pg from "pg";
import type { OAuthClient, UpsertOAuthClientData } from "./types.js";

const OAUTH_CLIENT_COLUMNS = `
  client_id, client_secret_hash, client_type, redirect_uris,
  allowed_scopes, tenant_id, app_id, access_mode,
  created_at, updated_at, created_by_service
`;

export class OAuthClientRepository {
  constructor(private readonly pool: pg.Pool) {}

  async findByClientId(clientId: string): Promise<OAuthClient | null> {
    const result = await this.pool.query<OAuthClient>(
      `SELECT ${OAUTH_CLIENT_COLUMNS}
         FROM auth.oauth_clients
        WHERE client_id = $1`,
      [clientId]
    );
    return result.rows[0] ?? null;
  }

  // Called by the App Service (via internal endpoint) when an app is registered.
  // The client_id is deterministic ("app:{appId}:{tenantId}") so repeated calls
  // are idempotent — they update the mutable fields without changing the primary key.
  async upsert(data: UpsertOAuthClientData): Promise<OAuthClient> {
    const result = await this.pool.query<OAuthClient>(
      `INSERT INTO auth.oauth_clients
              (client_id, client_secret_hash, client_type, redirect_uris,
               allowed_scopes, tenant_id, app_id, access_mode, created_by_service)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (client_id) DO UPDATE
               SET client_secret_hash = COALESCE(EXCLUDED.client_secret_hash, auth.oauth_clients.client_secret_hash),
                   redirect_uris      = EXCLUDED.redirect_uris,
                   allowed_scopes     = EXCLUDED.allowed_scopes,
                   access_mode        = EXCLUDED.access_mode,
                   updated_at         = now()
         RETURNING ${OAUTH_CLIENT_COLUMNS}`,
      [
        data.client_id,
        data.client_secret_hash ?? null,
        data.client_type ?? "public",
        data.redirect_uris ?? [],
        data.allowed_scopes ?? [],
        data.tenant_id ?? null,
        data.app_id ?? null,
        data.access_mode ?? "platform-user",
        data.created_by_service ?? null,
      ]
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("UPSERT into auth.oauth_clients returned no rows");
    }
    return row;
  }
}
