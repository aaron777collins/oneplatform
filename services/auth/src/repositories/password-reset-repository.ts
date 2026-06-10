import type pg from "pg";
import type { CreatePasswordResetData } from "./types.js";

export class PasswordResetRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(data: CreatePasswordResetData): Promise<void> {
    await this.pool.query(
      `INSERT INTO auth.password_reset_tokens
              (jti, user_id, expires_at, ip_address)
            VALUES ($1, $2, $3, $4)`,
      [data.jti, data.user_id, data.expires_at, data.ip_address ?? null]
    );
  }

  // Records the token as consumed. The Redis key is the fast-path single-use
  // gate; this Postgres update provides the audit trail and prevents reuse
  // even if the Redis key is somehow lost.
  async markUsed(jti: string): Promise<void> {
    await this.pool.query(
      `UPDATE auth.password_reset_tokens
            SET used_at = now()
          WHERE jti     = $1
            AND used_at IS NULL`,
      [jti]
    );
  }
}
