import type { Logger } from "@oneplatform/core";
import type { PermissionRepository } from "../repositories/permission-repository.js";
import type { AppRepository } from "../repositories/app-repository.js";
import type {
  AppRoleRow,
  TenantShareRow,
  EnvVarRow,
  RolePermission,
} from "../repositories/types.js";
import {
  AppNotFoundError,
  AppCrossTenantSharingDisabledError,
} from "./errors.js";
import { encrypt, decrypt } from "@oneplatform/core";

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface PermissionService {
  // Roles
  listRoles(tenantId: string, appId: string): Promise<AppRoleRow[]>;
  createRole(tenantId: string, appId: string, input: CreateRoleInput): Promise<AppRoleRow>;
  updateRole(tenantId: string, appId: string, roleId: string, input: UpdateRoleInput): Promise<AppRoleRow>;
  deleteRole(tenantId: string, appId: string, roleId: string): Promise<void>;

  // Tenant sharing
  shareApp(tenantId: string, appId: string, input: ShareInput, userId: string): Promise<TenantShareRow>;
  listShares(tenantId: string, appId: string): Promise<TenantShareRow[]>;

  // Env vars
  listEnvVars(tenantId: string, appId: string): Promise<EnvVarResponse[]>;
  upsertEnvVar(tenantId: string, appId: string, key: string, input: EnvVarInput): Promise<EnvVarResponse>;
  deleteEnvVar(tenantId: string, appId: string, key: string): Promise<void>;

  // Check tenant access (for BFF and serving)
  canTenantAccessApp(appId: string, requestingTenantId: string): Promise<boolean>;
}

export interface CreateRoleInput {
  name:        string;
  permissions: RolePermission[];
}

export interface UpdateRoleInput {
  name?:        string;
  permissions?: RolePermission[];
}

export interface ShareInput {
  tenantId:    string;
  mappedRoles: string[];
}

export interface EnvVarInput {
  value:    string;
  isSecret: boolean;
}

export interface EnvVarResponse {
  id:        string;
  key:       string;
  value:     string;  // plaintext for non-secret, "***" for secret
  isSecret:  boolean;
  updatedAt: string;
}

export interface PermissionServiceDeps {
  appRepo:    AppRepository;
  permRepo:   PermissionRepository;
  logger:     Logger;
  masterKey:  Buffer;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createPermissionService(deps: PermissionServiceDeps): PermissionService {
  const { appRepo, permRepo, logger, masterKey } = deps;

  async function assertAppAccess(tenantId: string, appId: string): Promise<void> {
    const app = await appRepo.findByTenantAndId(tenantId, appId);
    if (app === null) {
      throw new AppNotFoundError(`App "${appId}" not found.`, { appId, tenantId });
    }
  }

  // -------------------------------------------------------------------------
  // Roles
  // -------------------------------------------------------------------------

  async function listRoles(tenantId: string, appId: string): Promise<AppRoleRow[]> {
    await assertAppAccess(tenantId, appId);
    return permRepo.listRolesByApp(appId);
  }

  async function createRole(
    tenantId: string,
    appId: string,
    input: CreateRoleInput
  ): Promise<AppRoleRow> {
    await assertAppAccess(tenantId, appId);
    const role = await permRepo.createRole({
      app_id:      appId,
      name:        input.name,
      permissions: input.permissions,
    });
    logger.info("App role created", { tenantId, appId, roleId: role.id, name: role.name });
    return role;
  }

  async function updateRole(
    tenantId: string,
    appId: string,
    roleId: string,
    input: UpdateRoleInput
  ): Promise<AppRoleRow> {
    await assertAppAccess(tenantId, appId);

    // Verify the role belongs to this app before modifying it — prevents
    // cross-app role modification when a caller supplies a foreign roleId.
    const existing = await permRepo.findRoleByAppAndId(appId, roleId);
    if (existing === null) {
      throw new AppNotFoundError(`Role "${roleId}" not found.`, { roleId, appId });
    }

    const updated = await permRepo.updateRole(roleId, input);
    if (updated === null) {
      throw new AppNotFoundError(`Role "${roleId}" not found.`, { roleId, appId });
    }
    return updated;
  }

  async function deleteRole(tenantId: string, appId: string, roleId: string): Promise<void> {
    await assertAppAccess(tenantId, appId);

    // Verify the role belongs to this app before deleting — prevents cross-app
    // role deletion when a caller supplies a foreign roleId.
    const existing = await permRepo.findRoleByAppAndId(appId, roleId);
    if (existing === null) {
      throw new AppNotFoundError(`Role "${roleId}" not found.`, { roleId, appId });
    }

    await permRepo.deleteRole(roleId, appId);
    logger.info("App role deleted", { tenantId, appId, roleId });
  }

  // -------------------------------------------------------------------------
  // Tenant sharing
  // -------------------------------------------------------------------------

  async function shareApp(
    tenantId: string,
    appId: string,
    input: ShareInput,
    userId: string
  ): Promise<TenantShareRow> {
    const crossTenantEnabled =
      (process.env["OP_ENABLE_CROSS_TENANT_SHARING"] ?? "false").toLowerCase() === "true";

    if (!crossTenantEnabled) {
      throw new AppCrossTenantSharingDisabledError(
        "Cross-tenant app sharing is disabled on this platform.",
        { appId }
      );
    }

    await assertAppAccess(tenantId, appId);

    const share = await permRepo.createShare({
      app_id:             appId,
      external_tenant_id: input.tenantId,
      mapped_roles:       input.mappedRoles,
      created_by:         userId,
    });

    logger.info("App shared with tenant", {
      tenantId, appId, externalTenantId: input.tenantId,
    });

    return share;
  }

  async function listShares(tenantId: string, appId: string): Promise<TenantShareRow[]> {
    await assertAppAccess(tenantId, appId);
    return permRepo.listSharesByApp(appId);
  }

  // -------------------------------------------------------------------------
  // Env vars — values are encrypted at rest via AES-256-GCM + HKDF-SHA256
  // (same pattern as ingestion.credentials per ADR-11)
  // -------------------------------------------------------------------------

  async function listEnvVars(tenantId: string, appId: string): Promise<EnvVarResponse[]> {
    await assertAppAccess(tenantId, appId);

    const rows = await permRepo.listEnvVarsByApp(appId);

    return Promise.all(
      rows.map(async (row): Promise<EnvVarResponse> => {
        if (row.is_secret) {
          return {
            id:        row.id,
            key:       row.key,
            value:     "***",
            isSecret:  true,
            updatedAt: row.updated_at.toISOString(),
          };
        }
        const plaintext = await decrypt(row.value, masterKey);
        return {
          id:        row.id,
          key:       row.key,
          value:     plaintext,
          isSecret:  false,
          updatedAt: row.updated_at.toISOString(),
        };
      })
    );
  }

  async function upsertEnvVar(
    tenantId: string,
    appId: string,
    key: string,
    input: EnvVarInput
  ): Promise<EnvVarResponse> {
    await assertAppAccess(tenantId, appId);

    const encryptedValue = await encrypt(input.value, masterKey);

    const row: EnvVarRow = await permRepo.upsertEnvVar({
      app_id:    appId,
      key,
      value:     encryptedValue,
      is_secret: input.isSecret,
    });

    // Audit log — log the key only, never the value
    logger.info("Env var upserted", { tenantId, appId, key, isSecret: input.isSecret });

    return {
      id:        row.id,
      key:       row.key,
      value:     input.isSecret ? "***" : input.value,
      isSecret:  row.is_secret,
      updatedAt: row.updated_at.toISOString(),
    };
  }

  async function deleteEnvVar(tenantId: string, appId: string, key: string): Promise<void> {
    await assertAppAccess(tenantId, appId);
    await permRepo.deleteEnvVar(appId, key);
    logger.info("Env var deleted", { tenantId, appId, key });
  }

  // -------------------------------------------------------------------------
  // Tenant access check (BFF + serving)
  // -------------------------------------------------------------------------

  async function canTenantAccessApp(
    appId: string,
    requestingTenantId: string
  ): Promise<boolean> {
    const app = await appRepo.findById(appId);
    if (app === null) return false;

    // Same tenant — always allowed
    if (app.tenant_id === requestingTenantId) return true;

    // Check tenant_shares
    return permRepo.hasShareForTenant(appId, requestingTenantId);
  }

  return {
    listRoles,
    createRole,
    updateRole,
    deleteRole,
    shareApp,
    listShares,
    listEnvVars,
    upsertEnvVar,
    deleteEnvVar,
    canTenantAccessApp,
  };
}
