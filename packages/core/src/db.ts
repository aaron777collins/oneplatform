import pg from "pg";

const { Pool } = pg;

/** Configuration for {@link createDbClient}. */
export interface DbClientConfig {
  /** PostgreSQL connection string (e.g. `postgres://user:pass@host:5432/db`). */
  connectionString: string;
  /** Maximum number of pooled connections. */
  maxConnections: number;
  /**
   * Statement timeout in milliseconds. Defaults to 30 000 ms.
   *
   * Prevents runaway queries from holding connections and exhausting the pool.
   */
  statementTimeoutMs?: number;
}

/**
 * Creates a `pg.Pool` with sensible defaults for OnePlatform services.
 *
 * @param config - Connection string, pool size, and optional statement timeout.
 */
export function createDbClient(config: DbClientConfig): pg.Pool {
  return new Pool({
    connectionString: config.connectionString,
    max: config.maxConnections,
    // Prevent runaway queries from holding connections and exhausting the pool
    statement_timeout: config.statementTimeoutMs ?? 30_000,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
}

/**
 * Sets the session-local `app.tenant_id` GUC that Row-Level Security policies
 * read via `current_setting('app.tenant_id')`.
 *
 * Must be called within a transaction so the setting is scoped to that
 * transaction only and does not leak across pool connections.
 *
 * @param client   - An active pool client obtained via `pool.connect()`.
 * @param tenantId - The tenant ID to scope queries to.
 */
export async function setTenantContext(
  client: pg.PoolClient,
  tenantId: string
): Promise<void> {
  await client.query("SET LOCAL app.tenant_id = $1", [tenantId]);
}
