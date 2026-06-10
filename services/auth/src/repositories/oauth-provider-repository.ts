import type pg from "pg";
import type { OAuthProvider, UpsertOAuthProviderData } from "./types.js";

const OAUTH_PROVIDER_COLUMNS = `
  id, user_id, tenant_id, provider, provider_user_id, provider_email,
  access_token_encrypted, refresh_token_encrypted, token_expires_at,
  token_key_version, created_at, updated_at
`;

export class OAuthProviderRepository {
  constructor(private readonly pool: pg.Pool) {}

  // Looks up a provider link by the external provider's user identifier.
  // Used during the OAuth callback to decide whether to log in an existing
  // user or create a new one.
  async findByProviderUser(
    provider: string,
    providerUserId: string,
    tenantId: string
  ): Promise<OAuthProvider | null> {
    const result = await this.pool.query<OAuthProvider>(
      `SELECT ${OAUTH_PROVIDER_COLUMNS}
         FROM auth.oauth_providers
        WHERE provider         = $1
          AND provider_user_id = $2
          AND tenant_id        = $3`,
      [provider, providerUserId, tenantId]
    );
    return result.rows[0] ?? null;
  }

  async findByUserId(userId: string): Promise<OAuthProvider[]> {
    const result = await this.pool.query<OAuthProvider>(
      `SELECT ${OAUTH_PROVIDER_COLUMNS}
         FROM auth.oauth_providers
        WHERE user_id = $1
        ORDER BY provider ASC`,
      [userId]
    );
    return result.rows;
  }

  // Creates or updates the provider link atomically.
  // On conflict (same user + provider), all token fields are refreshed.
  async upsert(data: UpsertOAuthProviderData): Promise<OAuthProvider> {
    const result = await this.pool.query<OAuthProvider>(
      `INSERT INTO auth.oauth_providers
              (user_id, tenant_id, provider, provider_user_id, provider_email,
               access_token_encrypted, refresh_token_encrypted, token_expires_at,
               token_key_version)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (user_id, provider) DO UPDATE
               SET provider_email          = EXCLUDED.provider_email,
                   access_token_encrypted  = EXCLUDED.access_token_encrypted,
                   refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
                   token_expires_at        = EXCLUDED.token_expires_at,
                   token_key_version       = EXCLUDED.token_key_version,
                   updated_at              = now()
         RETURNING ${OAUTH_PROVIDER_COLUMNS}`,
      [
        data.user_id,
        data.tenant_id,
        data.provider,
        data.provider_user_id,
        data.provider_email ?? null,
        data.access_token_encrypted ?? null,
        data.refresh_token_encrypted ?? null,
        data.token_expires_at ?? null,
        data.token_key_version ?? 1,
      ]
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("UPSERT into auth.oauth_providers returned no rows");
    }
    return row;
  }
}
