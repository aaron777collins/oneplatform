import type pg from "pg";

// ---------------------------------------------------------------------------
// withTenant — executes a callback inside a transaction with the RLS
// tenant context set for the duration of that transaction only.
//
// We use SET LOCAL so the setting is automatically cleared when the
// transaction ends, preventing tenant context from leaking across
// subsequent queries on the same connection.
//
// All repository methods that read RLS-protected tables (connectors,
// webhook_receivers, upload_jobs, raw_*) must use this wrapper when
// called from a service context that has a known tenantId.
// ---------------------------------------------------------------------------

export async function withTenant<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // SET LOCAL scopes the setting to this transaction only.
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {
      // Swallow rollback errors — the original error is the meaningful one.
    });
    throw err;
  } finally {
    client.release();
  }
}
