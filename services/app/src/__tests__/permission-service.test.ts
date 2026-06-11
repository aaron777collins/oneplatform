// Unit tests for services/permission-service.ts
//
// Covers listRoles, createRole, updateRole, deleteRole, shareApp,
// listShares, listEnvVars, upsertEnvVar, deleteEnvVar, canTenantAccessApp.
// Encryption calls are mocked via vi.mock on @oneplatform/core.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  AppNotFoundError,
  AppCrossTenantSharingDisabledError,
} from "../services/errors.js";
import type { AppRepository } from "../repositories/app-repository.js";
import type { PermissionRepository } from "../repositories/permission-repository.js";
import type { Logger } from "@oneplatform/core";
import type {
  AppRow,
  AppRoleRow,
  TenantShareRow,
  EnvVarRow,
} from "../repositories/types.js";

// ---------------------------------------------------------------------------
// Mock @oneplatform/core encryption functions
// ---------------------------------------------------------------------------

vi.mock("@oneplatform/core", async (importOriginal) => {
  const original = await importOriginal<typeof import("@oneplatform/core")>();
  return {
    ...original,
    encrypt:       vi.fn().mockResolvedValue("encrypted-value"),
    decrypt:       vi.fn().mockResolvedValue("decrypted-plaintext"),
    loadMasterKey: vi.fn().mockReturnValue(Buffer.from("test-master-key-32-bytes-padding!")),
  };
});

// Import after mocking
const { createPermissionService } = await import("../services/permission-service.js");
type PermissionService = Awaited<ReturnType<typeof createPermissionService>>;
type PermissionServiceDeps = Parameters<typeof createPermissionService>[0];

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makeAppRow(overrides?: Partial<AppRow>): AppRow {
  return {
    id:               "app-001",
    tenant_id:        "tenant-001",
    name:             "My App",
    slug:             "my-app",
    description:      null,
    access_mode:      "platform-user",
    current_build_id: null,
    allowed_modules:  ["react"],
    created_at:       new Date("2026-01-01T00:00:00Z"),
    updated_at:       new Date("2026-01-01T00:00:00Z"),
    created_by:       "user-001",
    deleted_at:       null,
    ...overrides,
  };
}

function makeRoleRow(overrides?: Partial<AppRoleRow>): AppRoleRow {
  return {
    id:          "role-001",
    app_id:      "app-001",
    name:        "viewer",
    permissions: [{ entity: "report", actions: ["read"] }],
    created_at:  new Date("2026-01-01T00:00:00Z"),
    updated_at:  new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function makeShareRow(overrides?: Partial<TenantShareRow>): TenantShareRow {
  return {
    id:                 "share-001",
    app_id:             "app-001",
    external_tenant_id: "tenant-external",
    mapped_roles:       ["viewer"],
    created_at:         new Date("2026-01-01T00:00:00Z"),
    created_by:         "user-001",
    ...overrides,
  };
}

function makeEnvVarRow(overrides?: Partial<EnvVarRow>): EnvVarRow {
  return {
    id:         "env-001",
    app_id:     "app-001",
    key:        "API_KEY",
    value:      "encrypted-blob",
    is_secret:  false,
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info:  vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

type MockAppRepo = {
  findByTenantAndId: ReturnType<typeof vi.fn>;
  findById:          ReturnType<typeof vi.fn>;
};

type MockPermRepo = {
  createRole:              ReturnType<typeof vi.fn>;
  findRoleById:            ReturnType<typeof vi.fn>;
  findRoleByAppAndId:      ReturnType<typeof vi.fn>;
  listRolesByApp:          ReturnType<typeof vi.fn>;
  updateRole:              ReturnType<typeof vi.fn>;
  deleteRole:              ReturnType<typeof vi.fn>;
  createShare:             ReturnType<typeof vi.fn>;
  listSharesByApp:         ReturnType<typeof vi.fn>;
  hasShareForTenant:       ReturnType<typeof vi.fn>;
  deleteShare:             ReturnType<typeof vi.fn>;
  upsertEnvVar:            ReturnType<typeof vi.fn>;
  listEnvVarsByApp:        ReturnType<typeof vi.fn>;
  deleteEnvVar:            ReturnType<typeof vi.fn>;
  upsertOAuthRegistration: ReturnType<typeof vi.fn>;
  findOAuthByApp:          ReturnType<typeof vi.fn>;
  deleteOAuthRegistration: ReturnType<typeof vi.fn>;
  upsertUserStorage:       ReturnType<typeof vi.fn>;
  findUserStorage:         ReturnType<typeof vi.fn>;
  deleteUserStorage:       ReturnType<typeof vi.fn>;
};

function makeAppRepo(): MockAppRepo {
  return {
    findByTenantAndId: vi.fn(),
    findById:          vi.fn(),
  };
}

function makePermRepo(): MockPermRepo {
  return {
    createRole:              vi.fn(),
    findRoleById:            vi.fn(),
    findRoleByAppAndId:      vi.fn(),
    listRolesByApp:          vi.fn(),
    updateRole:              vi.fn(),
    deleteRole:              vi.fn(),
    createShare:             vi.fn(),
    listSharesByApp:         vi.fn(),
    hasShareForTenant:       vi.fn(),
    deleteShare:             vi.fn(),
    upsertEnvVar:            vi.fn(),
    listEnvVarsByApp:        vi.fn(),
    deleteEnvVar:            vi.fn(),
    upsertOAuthRegistration: vi.fn(),
    findOAuthByApp:          vi.fn(),
    deleteOAuthRegistration: vi.fn(),
    upsertUserStorage:       vi.fn(),
    findUserStorage:         vi.fn(),
    deleteUserStorage:       vi.fn(),
  };
}

function makeDeps(
  overrides?: Partial<{
    appRepo:  MockAppRepo;
    permRepo: MockPermRepo;
    logger:   Logger;
  }>,
): PermissionServiceDeps {
  return {
    appRepo:  (overrides?.appRepo  ?? makeAppRepo())  as unknown as AppRepository,
    permRepo: (overrides?.permRepo ?? makePermRepo()) as unknown as PermissionRepository,
    logger:   overrides?.logger ?? makeLogger(),
  };
}

// ---------------------------------------------------------------------------
// listRoles
// ---------------------------------------------------------------------------

describe("listRoles", () => {
  let appRepo:  MockAppRepo;
  let permRepo: MockPermRepo;
  let service:  PermissionService;

  beforeEach(() => {
    appRepo  = makeAppRepo();
    permRepo = makePermRepo();
    service  = createPermissionService(makeDeps({ appRepo, permRepo }));
  });

  it("throws AppNotFoundError when app does not exist", async () => {
    appRepo.findByTenantAndId.mockResolvedValue(null);

    await expect(service.listRoles("tenant-001", "app-999")).rejects.toThrow(AppNotFoundError);
  });

  it("returns roles from permRepo when app exists", async () => {
    const roles = [makeRoleRow()];
    appRepo.findByTenantAndId.mockResolvedValue(makeAppRow());
    permRepo.listRolesByApp.mockResolvedValue(roles);

    const result = await service.listRoles("tenant-001", "app-001");

    expect(result).toBe(roles);
    expect(permRepo.listRolesByApp).toHaveBeenCalledWith("app-001");
  });
});

// ---------------------------------------------------------------------------
// createRole
// ---------------------------------------------------------------------------

describe("createRole", () => {
  let appRepo:  MockAppRepo;
  let permRepo: MockPermRepo;
  let logger:   Logger;
  let service:  PermissionService;

  beforeEach(() => {
    appRepo  = makeAppRepo();
    permRepo = makePermRepo();
    logger   = makeLogger();
    service  = createPermissionService(makeDeps({ appRepo, permRepo, logger }));
  });

  it("throws AppNotFoundError when app does not exist", async () => {
    appRepo.findByTenantAndId.mockResolvedValue(null);

    await expect(
      service.createRole("tenant-001", "app-999", {
        name:        "editor",
        permissions: [{ entity: "report", actions: ["read"] }],
      }),
    ).rejects.toThrow(AppNotFoundError);
  });

  it("creates a role and returns the created row", async () => {
    const role = makeRoleRow();
    appRepo.findByTenantAndId.mockResolvedValue(makeAppRow());
    permRepo.createRole.mockResolvedValue(role);

    const result = await service.createRole("tenant-001", "app-001", {
      name:        "viewer",
      permissions: [{ entity: "report", actions: ["read"] }],
    });

    expect(result).toBe(role);
  });

  it("passes appId to permRepo.createRole", async () => {
    appRepo.findByTenantAndId.mockResolvedValue(makeAppRow());
    permRepo.createRole.mockResolvedValue(makeRoleRow());

    await service.createRole("tenant-001", "app-001", {
      name:        "viewer",
      permissions: [],
    });

    const arg = (permRepo.createRole.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(arg["app_id"]).toBe("app-001");
  });

  it("logs info after successful creation", async () => {
    appRepo.findByTenantAndId.mockResolvedValue(makeAppRow());
    permRepo.createRole.mockResolvedValue(makeRoleRow());

    await service.createRole("tenant-001", "app-001", {
      name:        "viewer",
      permissions: [],
    });

    const logInfo = logger.info as ReturnType<typeof vi.fn>;
    expect(logInfo).toHaveBeenCalledWith(
      "App role created",
      expect.objectContaining({ tenantId: "tenant-001", appId: "app-001" }),
    );
  });
});

// ---------------------------------------------------------------------------
// updateRole
// ---------------------------------------------------------------------------

describe("updateRole", () => {
  let appRepo:  MockAppRepo;
  let permRepo: MockPermRepo;
  let service:  PermissionService;

  beforeEach(() => {
    appRepo  = makeAppRepo();
    permRepo = makePermRepo();
    service  = createPermissionService(makeDeps({ appRepo, permRepo }));
  });

  it("throws AppNotFoundError when app does not exist", async () => {
    appRepo.findByTenantAndId.mockResolvedValue(null);

    await expect(
      service.updateRole("tenant-001", "app-999", "role-001", { name: "admin" }),
    ).rejects.toThrow(AppNotFoundError);
  });

  it("throws AppNotFoundError when role is not found", async () => {
    appRepo.findByTenantAndId.mockResolvedValue(makeAppRow());
    permRepo.updateRole.mockResolvedValue(null);

    await expect(
      service.updateRole("tenant-001", "app-001", "role-missing", { name: "admin" }),
    ).rejects.toThrow(AppNotFoundError);
  });

  it("returns updated role on success", async () => {
    const updatedRole = makeRoleRow({ name: "admin" });
    appRepo.findByTenantAndId.mockResolvedValue(makeAppRow());
    permRepo.updateRole.mockResolvedValue(updatedRole);

    const result = await service.updateRole("tenant-001", "app-001", "role-001", { name: "admin" });
    expect(result.name).toBe("admin");
  });
});

// ---------------------------------------------------------------------------
// deleteRole
// ---------------------------------------------------------------------------

describe("deleteRole", () => {
  let appRepo:  MockAppRepo;
  let permRepo: MockPermRepo;
  let logger:   Logger;
  let service:  PermissionService;

  beforeEach(() => {
    appRepo  = makeAppRepo();
    permRepo = makePermRepo();
    logger   = makeLogger();
    service  = createPermissionService(makeDeps({ appRepo, permRepo, logger }));
  });

  it("throws AppNotFoundError when app does not exist", async () => {
    appRepo.findByTenantAndId.mockResolvedValue(null);

    await expect(
      service.deleteRole("tenant-001", "app-999", "role-001"),
    ).rejects.toThrow(AppNotFoundError);
  });

  it("deletes the role when app exists", async () => {
    appRepo.findByTenantAndId.mockResolvedValue(makeAppRow());
    permRepo.deleteRole.mockResolvedValue(true);

    await service.deleteRole("tenant-001", "app-001", "role-001");

    expect(permRepo.deleteRole).toHaveBeenCalledWith("role-001");
  });

  it("logs info after deletion", async () => {
    appRepo.findByTenantAndId.mockResolvedValue(makeAppRow());
    permRepo.deleteRole.mockResolvedValue(true);

    await service.deleteRole("tenant-001", "app-001", "role-001");

    const logInfo = logger.info as ReturnType<typeof vi.fn>;
    expect(logInfo).toHaveBeenCalledWith(
      "App role deleted",
      expect.objectContaining({ tenantId: "tenant-001", appId: "app-001", roleId: "role-001" }),
    );
  });
});

// ---------------------------------------------------------------------------
// shareApp
// ---------------------------------------------------------------------------

describe("shareApp", () => {
  let appRepo:  MockAppRepo;
  let permRepo: MockPermRepo;
  let logger:   Logger;
  let service:  PermissionService;

  beforeEach(() => {
    appRepo  = makeAppRepo();
    permRepo = makePermRepo();
    logger   = makeLogger();
    service  = createPermissionService(makeDeps({ appRepo, permRepo, logger }));
    // Reset env var
    delete process.env["OP_ENABLE_CROSS_TENANT_SHARING"];
  });

  it("throws AppCrossTenantSharingDisabledError when feature flag is false (default)", async () => {
    process.env["OP_ENABLE_CROSS_TENANT_SHARING"] = "false";

    await expect(
      service.shareApp("tenant-001", "app-001", {
        tenantId:    "tenant-external",
        mappedRoles: ["viewer"],
      }, "user-001"),
    ).rejects.toThrow(AppCrossTenantSharingDisabledError);
  });

  it("throws AppCrossTenantSharingDisabledError when env var is absent", async () => {
    delete process.env["OP_ENABLE_CROSS_TENANT_SHARING"];

    await expect(
      service.shareApp("tenant-001", "app-001", {
        tenantId:    "tenant-external",
        mappedRoles: ["viewer"],
      }, "user-001"),
    ).rejects.toThrow(AppCrossTenantSharingDisabledError);
  });

  it("throws AppNotFoundError when cross-tenant sharing is enabled but app not found", async () => {
    process.env["OP_ENABLE_CROSS_TENANT_SHARING"] = "true";
    appRepo.findByTenantAndId.mockResolvedValue(null);

    await expect(
      service.shareApp("tenant-001", "app-999", {
        tenantId:    "tenant-external",
        mappedRoles: ["viewer"],
      }, "user-001"),
    ).rejects.toThrow(AppNotFoundError);
  });

  it("creates a share when feature flag is enabled and app exists", async () => {
    process.env["OP_ENABLE_CROSS_TENANT_SHARING"] = "true";
    const share = makeShareRow();
    appRepo.findByTenantAndId.mockResolvedValue(makeAppRow());
    permRepo.createShare.mockResolvedValue(share);

    const result = await service.shareApp("tenant-001", "app-001", {
      tenantId:    "tenant-external",
      mappedRoles: ["viewer"],
    }, "user-001");

    expect(result).toBe(share);
  });

  it("logs info after successful share", async () => {
    process.env["OP_ENABLE_CROSS_TENANT_SHARING"] = "true";
    appRepo.findByTenantAndId.mockResolvedValue(makeAppRow());
    permRepo.createShare.mockResolvedValue(makeShareRow());

    await service.shareApp("tenant-001", "app-001", {
      tenantId:    "tenant-external",
      mappedRoles: ["viewer"],
    }, "user-001");

    const logInfo = logger.info as ReturnType<typeof vi.fn>;
    expect(logInfo).toHaveBeenCalledWith(
      "App shared with tenant",
      expect.objectContaining({ tenantId: "tenant-001", appId: "app-001" }),
    );
  });

  it("feature flag is case-insensitive (TRUE is accepted)", async () => {
    process.env["OP_ENABLE_CROSS_TENANT_SHARING"] = "TRUE";
    appRepo.findByTenantAndId.mockResolvedValue(makeAppRow());
    permRepo.createShare.mockResolvedValue(makeShareRow());

    await expect(
      service.shareApp("tenant-001", "app-001", {
        tenantId:    "tenant-ext",
        mappedRoles: ["viewer"],
      }, "user-001"),
    ).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// listShares
// ---------------------------------------------------------------------------

describe("listShares", () => {
  let appRepo:  MockAppRepo;
  let permRepo: MockPermRepo;
  let service:  PermissionService;

  beforeEach(() => {
    appRepo  = makeAppRepo();
    permRepo = makePermRepo();
    service  = createPermissionService(makeDeps({ appRepo, permRepo }));
  });

  it("throws AppNotFoundError when app does not exist", async () => {
    appRepo.findByTenantAndId.mockResolvedValue(null);

    await expect(service.listShares("tenant-001", "app-999")).rejects.toThrow(AppNotFoundError);
  });

  it("returns shares from permRepo when app exists", async () => {
    const shares = [makeShareRow()];
    appRepo.findByTenantAndId.mockResolvedValue(makeAppRow());
    permRepo.listSharesByApp.mockResolvedValue(shares);

    const result = await service.listShares("tenant-001", "app-001");
    expect(result).toBe(shares);
  });
});

// ---------------------------------------------------------------------------
// listEnvVars
// ---------------------------------------------------------------------------

describe("listEnvVars", () => {
  let appRepo:  MockAppRepo;
  let permRepo: MockPermRepo;
  let service:  PermissionService;

  beforeEach(() => {
    appRepo  = makeAppRepo();
    permRepo = makePermRepo();
    service  = createPermissionService(makeDeps({ appRepo, permRepo }));
  });

  it("throws AppNotFoundError when app does not exist", async () => {
    appRepo.findByTenantAndId.mockResolvedValue(null);

    await expect(service.listEnvVars("tenant-001", "app-999")).rejects.toThrow(AppNotFoundError);
  });

  it("returns *** for secret env vars (never decrypts secrets)", async () => {
    appRepo.findByTenantAndId.mockResolvedValue(makeAppRow());
    permRepo.listEnvVarsByApp.mockResolvedValue([
      makeEnvVarRow({ key: "SECRET_KEY", is_secret: true }),
    ]);

    const result = await service.listEnvVars("tenant-001", "app-001");

    expect(result[0]?.value).toBe("***");
    expect(result[0]?.isSecret).toBe(true);
  });

  it("decrypts and returns plaintext for non-secret env vars", async () => {
    appRepo.findByTenantAndId.mockResolvedValue(makeAppRow());
    permRepo.listEnvVarsByApp.mockResolvedValue([
      makeEnvVarRow({ key: "API_URL", is_secret: false }),
    ]);

    const result = await service.listEnvVars("tenant-001", "app-001");

    expect(result[0]?.value).toBe("decrypted-plaintext");
    expect(result[0]?.isSecret).toBe(false);
  });

  it("returns correct shape with id, key, isSecret, updatedAt", async () => {
    const row = makeEnvVarRow({ key: "APP_ENV", is_secret: false });
    appRepo.findByTenantAndId.mockResolvedValue(makeAppRow());
    permRepo.listEnvVarsByApp.mockResolvedValue([row]);

    const result = await service.listEnvVars("tenant-001", "app-001");

    const item = result[0];
    expect(item).toHaveProperty("id");
    expect(item).toHaveProperty("key", "APP_ENV");
    expect(item).toHaveProperty("isSecret", false);
    expect(item).toHaveProperty("updatedAt");
  });
});

// ---------------------------------------------------------------------------
// upsertEnvVar
// ---------------------------------------------------------------------------

describe("upsertEnvVar", () => {
  let appRepo:  MockAppRepo;
  let permRepo: MockPermRepo;
  let logger:   Logger;
  let service:  PermissionService;

  beforeEach(() => {
    appRepo  = makeAppRepo();
    permRepo = makePermRepo();
    logger   = makeLogger();
    service  = createPermissionService(makeDeps({ appRepo, permRepo, logger }));
  });

  it("throws AppNotFoundError when app does not exist", async () => {
    appRepo.findByTenantAndId.mockResolvedValue(null);

    await expect(
      service.upsertEnvVar("tenant-001", "app-999", "KEY", { value: "val", isSecret: false }),
    ).rejects.toThrow(AppNotFoundError);
  });

  it("returns *** as value for secret env vars (never reveals plaintext)", async () => {
    appRepo.findByTenantAndId.mockResolvedValue(makeAppRow());
    permRepo.upsertEnvVar.mockResolvedValue(makeEnvVarRow({ key: "SECRET", is_secret: true }));

    const result = await service.upsertEnvVar("tenant-001", "app-001", "SECRET", {
      value:    "my-super-secret",
      isSecret: true,
    });

    expect(result.value).toBe("***");
  });

  it("returns plaintext value for non-secret env vars", async () => {
    appRepo.findByTenantAndId.mockResolvedValue(makeAppRow());
    permRepo.upsertEnvVar.mockResolvedValue(makeEnvVarRow({ key: "API_URL", is_secret: false }));

    const result = await service.upsertEnvVar("tenant-001", "app-001", "API_URL", {
      value:    "https://api.example.com",
      isSecret: false,
    });

    expect(result.value).toBe("https://api.example.com");
  });

  it("passes encrypted value (not plaintext) to permRepo.upsertEnvVar", async () => {
    appRepo.findByTenantAndId.mockResolvedValue(makeAppRow());
    permRepo.upsertEnvVar.mockResolvedValue(makeEnvVarRow());

    await service.upsertEnvVar("tenant-001", "app-001", "KEY", {
      value:    "plaintext",
      isSecret: false,
    });

    const arg = (permRepo.upsertEnvVar.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    // The value stored should be the encrypted blob, not the plaintext
    expect(arg["value"]).toBe("encrypted-value");
    expect(arg["value"]).not.toBe("plaintext");
  });

  it("logs key and isSecret but never the plaintext value", async () => {
    appRepo.findByTenantAndId.mockResolvedValue(makeAppRow());
    permRepo.upsertEnvVar.mockResolvedValue(makeEnvVarRow());

    await service.upsertEnvVar("tenant-001", "app-001", "MY_KEY", {
      value:    "secret-value",
      isSecret: false,
    });

    const logInfo = logger.info as ReturnType<typeof vi.fn>;
    const calls = logInfo.mock.calls as unknown[];
    const logCall = calls.find(
      (c) => (c as unknown[])[0] === "Env var upserted",
    ) as unknown[] | undefined;
    expect(logCall).toBeDefined();
    // Verify the log context includes key but not the actual value
    const context = logCall?.[1] as Record<string, unknown>;
    expect(context?.["key"]).toBe("MY_KEY");
    const contextStr = JSON.stringify(context);
    expect(contextStr).not.toContain("secret-value");
  });
});

// ---------------------------------------------------------------------------
// deleteEnvVar
// ---------------------------------------------------------------------------

describe("deleteEnvVar", () => {
  let appRepo:  MockAppRepo;
  let permRepo: MockPermRepo;
  let service:  PermissionService;

  beforeEach(() => {
    appRepo  = makeAppRepo();
    permRepo = makePermRepo();
    service  = createPermissionService(makeDeps({ appRepo, permRepo }));
  });

  it("throws AppNotFoundError when app does not exist", async () => {
    appRepo.findByTenantAndId.mockResolvedValue(null);

    await expect(
      service.deleteEnvVar("tenant-001", "app-999", "KEY"),
    ).rejects.toThrow(AppNotFoundError);
  });

  it("deletes the env var when app exists", async () => {
    appRepo.findByTenantAndId.mockResolvedValue(makeAppRow());
    permRepo.deleteEnvVar.mockResolvedValue(true);

    await service.deleteEnvVar("tenant-001", "app-001", "API_KEY");

    expect(permRepo.deleteEnvVar).toHaveBeenCalledWith("app-001", "API_KEY");
  });
});

// ---------------------------------------------------------------------------
// canTenantAccessApp
// ---------------------------------------------------------------------------

describe("canTenantAccessApp", () => {
  let appRepo:  MockAppRepo;
  let permRepo: MockPermRepo;
  let service:  PermissionService;

  beforeEach(() => {
    appRepo  = makeAppRepo();
    permRepo = makePermRepo();
    service  = createPermissionService(makeDeps({ appRepo, permRepo }));
  });

  it("returns false when app does not exist", async () => {
    appRepo.findById.mockResolvedValue(null);

    const result = await service.canTenantAccessApp("app-999", "tenant-001");
    expect(result).toBe(false);
  });

  it("returns true when requesting tenant is the owning tenant", async () => {
    appRepo.findById.mockResolvedValue(makeAppRow({ tenant_id: "tenant-001" }));

    const result = await service.canTenantAccessApp("app-001", "tenant-001");
    expect(result).toBe(true);
  });

  it("returns true when requesting tenant has a share record", async () => {
    appRepo.findById.mockResolvedValue(makeAppRow({ tenant_id: "tenant-owner" }));
    permRepo.hasShareForTenant.mockResolvedValue(true);

    const result = await service.canTenantAccessApp("app-001", "tenant-external");
    expect(result).toBe(true);
  });

  it("returns false when requesting tenant has no share and is not the owner", async () => {
    appRepo.findById.mockResolvedValue(makeAppRow({ tenant_id: "tenant-owner" }));
    permRepo.hasShareForTenant.mockResolvedValue(false);

    const result = await service.canTenantAccessApp("app-001", "tenant-other");
    expect(result).toBe(false);
  });

  it("does not check share table for the owning tenant", async () => {
    appRepo.findById.mockResolvedValue(makeAppRow({ tenant_id: "tenant-001" }));

    await service.canTenantAccessApp("app-001", "tenant-001");

    expect(permRepo.hasShareForTenant).not.toHaveBeenCalled();
  });
});
