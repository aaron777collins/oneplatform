import pg from "pg";

const { Pool } = pg;

export interface DbClientConfig {
  connectionString: string;
  maxConnections: number;
  statementTimeoutMs?: number;
}

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

// Sets a session-local GUC that RLS policies read via current_setting('app.tenant_id').
// Must be called within a transaction so the setting is scoped to that transaction only.
export async function setTenantContext(
  client: pg.PoolClient,
  tenantId: string
): Promise<void> {
  await client.query("SET LOCAL app.tenant_id = $1", [tenantId]);
}
