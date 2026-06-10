import type pg from "pg";
import type { ApiKey, CreateApiKeyData } from "./types.js";

const API_KEY_COLUMNS = `
  id, user_id, tenant_id, name, key_hash, key_prefix,
  scopes, expires_at, last_used_at, created_at, revoked_at, revoked_by
`;

export class ApiKeyRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(data: CreateApiKeyData): Promise<ApiKey> {
    const result = await this.pool.query<ApiKey>(
      `INSERT INTO auth.api_keys
              (user_id, tenant_id, name, key_hash, key_prefix, scopes, expires_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING ${API_KEY_COLUMNS}`,
      [
        data.user_id,
        data.tenant_id,
        data.name,
        data.key_hash,
        data.key_prefix,
        data.scopes ?? [],
        data.expires_at ?? null,
      ]
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("INSERT INTO auth.api_keys returned no rows");
    }
    return row;
  }

  // Returns all non-revoked keys sharing the given 8-character prefix.
  // The caller must still bcrypt-compare each candidate to find the exact match.
  async findByPrefix(prefix: string): Promise<ApiKey[]> {
    if (prefix.length !== 8) {
      throw new Error(
        `findByPrefix requires an 8-character prefix; received ${prefix.length} characters`
      );
    }

    const result = await this.pool.query<ApiKey>(
      `SELECT ${API_KEY_COLUMNS}
         FROM auth.api_keys
        WHERE key_prefix = $1
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > now())`,
      [prefix]
    );
    return result.rows;
  }

  async findByUserId(userId: string): Promise<ApiKey[]> {
    const result = await this.pool.query<ApiKey>(
      `SELECT ${API_KEY_COLUMNS}
         FROM auth.api_keys
        WHERE user_id = $1
        ORDER BY created_at DESC`,
      [userId]
    );
    return result.rows;
  }

  async revoke(keyId: string, revokedBy: string): Promise<void> {
    await this.pool.query(
      `UPDATE auth.api_keys
            SET revoked_at = now(),
                revoked_by = $1
          WHERE id         = $2
            AND revoked_at IS NULL`,
      [revokedBy, keyId]
    );
  }

  // Called on every successful API key authentication to maintain
  // last_used_at without blocking the request path — a fire-and-forget update.
  async updateLastUsed(keyId: string): Promise<void> {
    await this.pool.query(
      `UPDATE auth.api_keys
            SET last_used_at = now()
          WHERE id = $1`,
      [keyId]
    );
  }
}
