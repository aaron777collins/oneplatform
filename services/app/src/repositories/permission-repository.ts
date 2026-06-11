import type pg from "pg";
import type {
  AppRoleRow,
  TenantShareRow,
  EnvVarRow,
  OAuthRegistrationRow,
  UserStorageRow,
  CreateAppRoleData,
  UpdateAppRoleData,
  CreateTenantShareData,
  CreateEnvVarData,
  UpsertOAuthRegistrationData,
  UpsertUserStorageData,
  RolePermission,
} from "./types.js";

const ROLE_COLUMNS = `id, app_id, name, permissions, created_at, updated_at`;
const SHARE_COLUMNS = `id, app_id, external_tenant_id, mapped_roles, created_at, created_by`;
const ENV_VAR_COLUMNS = `id, app_id, key, value, is_secret, created_at, updated_at`;
const OAUTH_COLUMNS = `id, app_id, client_id, client_secret_hash, access_mode, registered_at, updated_at`;
const STORAGE_COLUMNS = `id, app_id, user_id, key, value, created_at, updated_at`;

export class PermissionRepository {
  constructor(private readonly pool: pg.Pool) {}

  // ---------------------------------------------------------------------------
  // App roles
  // ---------------------------------------------------------------------------

  async createRole(data: CreateAppRoleData): Promise<AppRoleRow> {
    const result = await this.pool.query<AppRoleRow>(
      `INSERT INTO app.roles (app_id, name, permissions)
       VALUES ($1, $2, $3)
       RETURNING ${ROLE_COLUMNS}`,
      [data.app_id, data.name, JSON.stringify(data.permissions)]
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("INSERT INTO app.roles returned no rows");
    }
    return row;
  }

  async findRoleById(id: string): Promise<AppRoleRow | null> {
    const result = await this.pool.query<AppRoleRow>(
      `SELECT ${ROLE_COLUMNS} FROM app.roles WHERE id = $1`,
      [id]
    );
    return result.rows[0] ?? null;
  }

  async findRoleByAppAndId(appId: string, id: string): Promise<AppRoleRow | null> {
    const result = await this.pool.query<AppRoleRow>(
      `SELECT ${ROLE_COLUMNS} FROM app.roles WHERE id = $1 AND app_id = $2`,
      [id, appId]
    );
    return result.rows[0] ?? null;
  }

  async listRolesByApp(appId: string): Promise<AppRoleRow[]> {
    const result = await this.pool.query<AppRoleRow>(
      `SELECT ${ROLE_COLUMNS} FROM app.roles WHERE app_id = $1 ORDER BY name`,
      [appId]
    );
    return result.rows;
  }

  async updateRole(id: string, data: UpdateAppRoleData): Promise<AppRoleRow | null> {
    const sets: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (data.name !== undefined) {
      sets.push(`name = $${idx++}`);
      values.push(data.name);
    }
    if (data.permissions !== undefined) {
      sets.push(`permissions = $${idx++}`);
      values.push(JSON.stringify(data.permissions as RolePermission[]));
    }

    if (sets.length === 0) {
      throw new Error(`updateRole() called with no fields to update for role ${id}`);
    }

    sets.push("updated_at = now()");
    values.push(id);

    const result = await this.pool.query<AppRoleRow>(
      `UPDATE app.roles
            SET ${sets.join(", ")}
          WHERE id = $${idx}
      RETURNING ${ROLE_COLUMNS}`,
      values
    );
    return result.rows[0] ?? null;
  }

  async deleteRole(id: string): Promise<boolean> {
    const result = await this.pool.query(
      "DELETE FROM app.roles WHERE id = $1",
      [id]
    );
    return result.rowCount !== null && result.rowCount > 0;
  }

  // ---------------------------------------------------------------------------
  // Tenant shares
  // ---------------------------------------------------------------------------

  async createShare(data: CreateTenantShareData): Promise<TenantShareRow> {
    const result = await this.pool.query<TenantShareRow>(
      `INSERT INTO app.tenant_shares
         (app_id, external_tenant_id, mapped_roles, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING ${SHARE_COLUMNS}`,
      [data.app_id, data.external_tenant_id, data.mapped_roles, data.created_by]
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("INSERT INTO app.tenant_shares returned no rows");
    }
    return row;
  }

  async listSharesByApp(appId: string): Promise<TenantShareRow[]> {
    const result = await this.pool.query<TenantShareRow>(
      `SELECT ${SHARE_COLUMNS} FROM app.tenant_shares WHERE app_id = $1`,
      [appId]
    );
    return result.rows;
  }

  // Checks whether externalTenantId has a share entry for the given app.
  async hasShareForTenant(appId: string, externalTenantId: string): Promise<boolean> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count
         FROM app.tenant_shares
        WHERE app_id = $1 AND external_tenant_id = $2`,
      [appId, externalTenantId]
    );
    return parseInt(result.rows[0]?.count ?? "0", 10) > 0;
  }

  async deleteShare(appId: string, externalTenantId: string): Promise<boolean> {
    const result = await this.pool.query(
      "DELETE FROM app.tenant_shares WHERE app_id = $1 AND external_tenant_id = $2",
      [appId, externalTenantId]
    );
    return result.rowCount !== null && result.rowCount > 0;
  }

  // ---------------------------------------------------------------------------
  // Environment variables
  // ---------------------------------------------------------------------------

  async upsertEnvVar(data: CreateEnvVarData): Promise<EnvVarRow> {
    const result = await this.pool.query<EnvVarRow>(
      `INSERT INTO app.env_vars (app_id, key, value, is_secret)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (app_id, key)
       DO UPDATE SET value = EXCLUDED.value, is_secret = EXCLUDED.is_secret, updated_at = now()
       RETURNING ${ENV_VAR_COLUMNS}`,
      [data.app_id, data.key, data.value, data.is_secret]
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("UPSERT INTO app.env_vars returned no rows");
    }
    return row;
  }

  async listEnvVarsByApp(appId: string): Promise<EnvVarRow[]> {
    const result = await this.pool.query<EnvVarRow>(
      `SELECT ${ENV_VAR_COLUMNS} FROM app.env_vars WHERE app_id = $1 ORDER BY key`,
      [appId]
    );
    return result.rows;
  }

  async deleteEnvVar(appId: string, key: string): Promise<boolean> {
    const result = await this.pool.query(
      "DELETE FROM app.env_vars WHERE app_id = $1 AND key = $2",
      [appId, key]
    );
    return result.rowCount !== null && result.rowCount > 0;
  }

  // ---------------------------------------------------------------------------
  // OAuth registrations
  // ---------------------------------------------------------------------------

  async upsertOAuthRegistration(data: UpsertOAuthRegistrationData): Promise<OAuthRegistrationRow> {
    const result = await this.pool.query<OAuthRegistrationRow>(
      `INSERT INTO app.oauth_registrations
         (app_id, client_id, access_mode, client_secret_hash)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (app_id)
       DO UPDATE SET
         client_id          = EXCLUDED.client_id,
         access_mode        = EXCLUDED.access_mode,
         client_secret_hash = EXCLUDED.client_secret_hash,
         updated_at         = now()
       RETURNING ${OAUTH_COLUMNS}`,
      [
        data.app_id,
        data.client_id,
        data.access_mode,
        data.client_secret_hash ?? null,
      ]
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("UPSERT INTO app.oauth_registrations returned no rows");
    }
    return row;
  }

  async findOAuthByApp(appId: string): Promise<OAuthRegistrationRow | null> {
    const result = await this.pool.query<OAuthRegistrationRow>(
      `SELECT ${OAUTH_COLUMNS} FROM app.oauth_registrations WHERE app_id = $1`,
      [appId]
    );
    return result.rows[0] ?? null;
  }

  async deleteOAuthRegistration(appId: string): Promise<boolean> {
    const result = await this.pool.query(
      "DELETE FROM app.oauth_registrations WHERE app_id = $1",
      [appId]
    );
    return result.rowCount !== null && result.rowCount > 0;
  }

  // ---------------------------------------------------------------------------
  // User storage
  // ---------------------------------------------------------------------------

  async upsertUserStorage(data: UpsertUserStorageData): Promise<UserStorageRow> {
    const result = await this.pool.query<UserStorageRow>(
      `INSERT INTO app.user_storage (app_id, user_id, key, value)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (app_id, user_id, key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = now()
       RETURNING ${STORAGE_COLUMNS}`,
      [data.app_id, data.user_id, data.key, JSON.stringify(data.value)]
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("UPSERT INTO app.user_storage returned no rows");
    }
    return row;
  }

  async findUserStorage(
    appId: string,
    userId: string,
    key: string
  ): Promise<UserStorageRow | null> {
    const result = await this.pool.query<UserStorageRow>(
      `SELECT ${STORAGE_COLUMNS}
         FROM app.user_storage
        WHERE app_id = $1 AND user_id = $2 AND key = $3`,
      [appId, userId, key]
    );
    return result.rows[0] ?? null;
  }

  async deleteUserStorage(appId: string, userId: string, key: string): Promise<boolean> {
    const result = await this.pool.query(
      "DELETE FROM app.user_storage WHERE app_id = $1 AND user_id = $2 AND key = $3",
      [appId, userId, key]
    );
    return result.rowCount !== null && result.rowCount > 0;
  }
}
