import type pg from "pg";
import type { Session, CreateSessionData } from "./types.js";

const SESSION_COLUMNS = `
  id, user_id, tenant_id, refresh_token_jti, family_id,
  created_at, last_used_at, expires_at, revoked_at, revoked_reason,
  user_agent, ip_address
`;

export class SessionRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(data: CreateSessionData): Promise<Session> {
    const result = await this.pool.query<Session>(
      `INSERT INTO auth.sessions
              (user_id, tenant_id, refresh_token_jti, family_id,
               expires_at, user_agent, ip_address)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING ${SESSION_COLUMNS}`,
      [
        data.user_id,
        data.tenant_id,
        data.refresh_token_jti,
        data.family_id,
        data.expires_at,
        data.user_agent ?? null,
        data.ip_address ?? null,
      ]
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("INSERT INTO auth.sessions returned no rows");
    }
    return row;
  }

  async findByRefreshTokenJti(jti: string): Promise<Session | null> {
    const result = await this.pool.query<Session>(
      `SELECT ${SESSION_COLUMNS}
         FROM auth.sessions
        WHERE refresh_token_jti = $1`,
      [jti]
    );
    return result.rows[0] ?? null;
  }

  async findByFamilyId(familyId: string): Promise<Session[]> {
    const result = await this.pool.query<Session>(
      `SELECT ${SESSION_COLUMNS}
         FROM auth.sessions
        WHERE family_id = $1
        ORDER BY created_at ASC`,
      [familyId]
    );
    return result.rows;
  }

  // Updates the current refresh token JTI for a session during rotation.
  // Also bumps last_used_at so we have an accurate activity timestamp.
  async updateRefreshToken(sessionId: string, newJti: string): Promise<void> {
    const result = await this.pool.query(
      `UPDATE auth.sessions
            SET refresh_token_jti = $1,
                last_used_at      = now()
          WHERE id = $2
            AND revoked_at IS NULL`,
      [newJti, sessionId]
    );

    if (result.rowCount === 0) {
      throw new Error(
        `updateRefreshToken: session ${sessionId} not found or already revoked`
      );
    }
  }

  async revokeSession(sessionId: string, reason: string): Promise<void> {
    await this.pool.query(
      `UPDATE auth.sessions
            SET revoked_at     = now(),
                revoked_reason = $1
          WHERE id = $2
            AND revoked_at IS NULL`,
      [reason, sessionId]
    );
  }

  async revokeAllForUser(userId: string, reason: string): Promise<void> {
    await this.pool.query(
      `UPDATE auth.sessions
            SET revoked_at     = now(),
                revoked_reason = $1
          WHERE user_id    = $2
            AND revoked_at IS NULL`,
      [reason, userId]
    );
  }

  async revokeByFamilyId(familyId: string, reason: string): Promise<void> {
    await this.pool.query(
      `UPDATE auth.sessions
            SET revoked_at     = now(),
                revoked_reason = $1
          WHERE family_id  = $2
            AND revoked_at IS NULL`,
      [reason, familyId]
    );
  }
}
