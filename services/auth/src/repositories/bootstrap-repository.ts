import type pg from "pg";
import type { BootstrapState } from "./types.js";

export class BootstrapRepository {
  constructor(private readonly pool: pg.Pool) {}

  // Reads the single bootstrap_state row. The migration always seeds this row
  // (id=1, bootstrap_completed=false), so the null path should only occur if
  // the migration has not run yet — treated as a hard error by callers.
  async getState(): Promise<BootstrapState> {
    const result = await this.pool.query<BootstrapState>(
      `SELECT id, bootstrap_completed, completed_at, admin_user_id, first_tenant_id
         FROM auth.bootstrap_state
        WHERE id = 1`
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(
        "auth.bootstrap_state is empty — database migrations may not have run"
      );
    }
    return row;
  }

  // Marks bootstrap as completed inside the same transaction that creates the
  // first tenant and admin user, ensuring there is no window where a user
  // exists while bootstrap_completed is still false.
  async markCompleted(adminUserId: string, tenantId: string): Promise<void> {
    const result = await this.pool.query(
      `UPDATE auth.bootstrap_state
            SET bootstrap_completed = true,
                completed_at        = now(),
                admin_user_id       = $1,
                first_tenant_id     = $2
          WHERE id                  = 1
            AND bootstrap_completed = false`,
      [adminUserId, tenantId]
    );

    if (result.rowCount === 0) {
      throw new Error(
        "markCompleted: bootstrap_state row not found or already marked completed"
      );
    }
  }
}
