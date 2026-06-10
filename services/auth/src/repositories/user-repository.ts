import type pg from "pg";
import type { User, CreateUserData, UpdateUserData } from "./types.js";

const USER_COLUMNS = `
  id, tenant_id, email, password_hash, email_verified, is_active,
  display_name, roles, created_at, updated_at, last_login_at,
  failed_login_count, locked_until, metadata
`;

// Default page size when the caller does not supply a limit.
const DEFAULT_LIMIT = 50;
// Hard cap to prevent runaway queries from callers passing huge limits.
const MAX_LIMIT = 200;

export class UserRepository {
  constructor(private readonly pool: pg.Pool) {}

  async findById(id: string): Promise<User | null> {
    const result = await this.pool.query<User>(
      `SELECT ${USER_COLUMNS}
         FROM auth.users
        WHERE id = $1`,
      [id]
    );
    return result.rows[0] ?? null;
  }

  async findByEmail(tenantId: string, email: string): Promise<User | null> {
    // The schema uses a partial index on lower(email) so we normalise here.
    const result = await this.pool.query<User>(
      `SELECT ${USER_COLUMNS}
         FROM auth.users
        WHERE tenant_id = $1
          AND lower(email) = lower($2)`,
      [tenantId, email]
    );
    return result.rows[0] ?? null;
  }

  async create(data: CreateUserData): Promise<User> {
    const result = await this.pool.query<User>(
      `INSERT INTO auth.users
              (tenant_id, email, password_hash, display_name, roles,
               email_verified, metadata)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING ${USER_COLUMNS}`,
      [
        data.tenant_id,
        data.email,
        data.password_hash ?? null,
        data.display_name ?? null,
        data.roles ?? [],
        data.email_verified ?? false,
        JSON.stringify(data.metadata ?? {}),
      ]
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("INSERT INTO auth.users returned no rows");
    }
    return row;
  }

  async update(id: string, data: UpdateUserData): Promise<User> {
    // Build a SET clause dynamically from the provided fields.
    // Only columns explicitly present in data are written, avoiding
    // accidental overwrites of fields the caller did not intend to touch.
    const sets: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (data.display_name !== undefined) {
      sets.push(`display_name = $${idx++}`);
      values.push(data.display_name);
    }
    if (data.roles !== undefined) {
      sets.push(`roles = $${idx++}`);
      values.push(data.roles);
    }
    if (data.metadata !== undefined) {
      sets.push(`metadata = $${idx++}`);
      values.push(JSON.stringify(data.metadata));
    }
    if (data.last_login_at !== undefined) {
      sets.push(`last_login_at = $${idx++}`);
      values.push(data.last_login_at);
    }
    if (data.password_hash !== undefined) {
      sets.push(`password_hash = $${idx++}`);
      values.push(data.password_hash);
    }

    if (sets.length === 0) {
      throw new Error("update() called with no fields to update for user " + id);
    }

    sets.push(`updated_at = now()`);
    values.push(id);

    const result = await this.pool.query<User>(
      `UPDATE auth.users
            SET ${sets.join(", ")}
          WHERE id = $${idx}
      RETURNING ${USER_COLUMNS}`,
      values
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(`UPDATE auth.users found no row with id=${id}`);
    }
    return row;
  }

  // Atomically increments the failed login counter and, when the threshold is
  // reached, sets locked_until to 15 minutes from now in a single statement.
  async incrementFailedLogin(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE auth.users
            SET failed_login_count = failed_login_count + 1,
                locked_until = CASE
                  WHEN failed_login_count + 1 >= 10
                    THEN now() + INTERVAL '15 minutes'
                  ELSE locked_until
                END,
                updated_at = now()
          WHERE id = $1`,
      [id]
    );
  }

  async resetFailedLogin(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE auth.users
            SET failed_login_count = 0,
                locked_until       = NULL,
                updated_at         = now()
          WHERE id = $1`,
      [id]
    );
  }

  async setEmailVerified(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE auth.users
            SET email_verified = true,
                updated_at     = now()
          WHERE id = $1`,
      [id]
    );
  }

  async deactivate(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE auth.users
            SET is_active  = false,
                updated_at = now()
          WHERE id = $1`,
      [id]
    );
  }

  // Keyset pagination keyed on (created_at, id) to guarantee a stable,
  // index-friendly sort even for rows inserted within the same millisecond.
  async listByTenant(
    tenantId: string,
    cursor?: string,
    limit?: number
  ): Promise<{ users: User[]; nextCursor: string | null }> {
    const pageSize = Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT);

    // Decode a previously-issued cursor, which is base64url-encoded JSON.
    // We store the raw values so the repository is not coupled to a signing
    // secret — the caller is responsible for issuing signed cursors if needed.
    let afterCreatedAt: string | null = null;
    let afterId: string | null = null;

    if (cursor !== undefined) {
      let decoded: { createdAt: string; id: string };
      try {
        decoded = JSON.parse(
          Buffer.from(cursor, "base64url").toString("utf8")
        ) as { createdAt: string; id: string };
      } catch {
        throw new Error("Invalid cursor: could not decode pagination cursor");
      }
      afterCreatedAt = decoded.createdAt;
      afterId = decoded.id;
    }

    const result = await this.pool.query<User>(
      `SELECT ${USER_COLUMNS}
         FROM auth.users
        WHERE tenant_id = $1
          AND (
            $2::timestamptz IS NULL
            OR (created_at, id) > ($2::timestamptz, $3::uuid)
          )
        ORDER BY created_at ASC, id ASC
        LIMIT $4`,
      [tenantId, afterCreatedAt, afterId, pageSize + 1]
    );

    // Fetching one extra row lets us detect whether another page exists
    // without a separate COUNT query.
    const hasMore = result.rows.length > pageSize;
    const users = result.rows.slice(0, pageSize);

    let nextCursor: string | null = null;
    if (hasMore) {
      const last = users[users.length - 1];
      if (last !== undefined) {
        nextCursor = Buffer.from(
          JSON.stringify({ createdAt: last.created_at.toISOString(), id: last.id })
        ).toString("base64url");
      }
    }

    return { users, nextCursor };
  }
}
