// Unit tests for repositories/types.ts
//
// Verifies the structural contract of every interface at runtime:
// correct key names (snake_case for rows), union literal values,
// nullable vs non-nullable fields, and optional input fields.

import { describe, it, expect } from "vitest";
import type {
  AppRow,
  AppFileRow,
  BuildRow,
  EnvVarRow,
  AppRoleRow,
  TenantShareRow,
  OAuthRegistrationRow,
  UserStorageRow,
  RolePermission,
  CreateAppData,
  UpdateAppData,
  CreateFileData,
  UpdateFileData,
  CreateBuildData,
  UpdateBuildData,
  CreateEnvVarData,
  CreateAppRoleData,
  UpdateAppRoleData,
  CreateTenantShareData,
  UpsertOAuthRegistrationData,
  UpsertUserStorageData,
} from "../repositories/types.js";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function hasKeys(obj: object, keys: string[]): boolean {
  return keys.every((k) => k in obj);
}

// ---------------------------------------------------------------------------
// AppRow
// ---------------------------------------------------------------------------

describe("AppRow", () => {
  const validRow: AppRow = {
    id:               "550e8400-e29b-41d4-a716-446655440000",
    tenant_id:        "550e8400-e29b-41d4-a716-446655440001",
    name:             "My App",
    slug:             "my-app",
    description:      null,
    access_mode:      "platform-user",
    current_build_id: null,
    allowed_modules:  ["react", "react-dom"],
    created_at:       new Date("2026-01-01T00:00:00Z"),
    updated_at:       new Date("2026-01-01T00:00:00Z"),
    created_by:       "user-001",
    deleted_at:       null,
  };

  it("has all required snake_case columns", () => {
    expect(
      hasKeys(validRow, [
        "id", "tenant_id", "name", "slug", "description",
        "access_mode", "current_build_id", "allowed_modules",
        "created_at", "updated_at", "created_by", "deleted_at",
      ]),
    ).toBe(true);
  });

  it("description can be null", () => {
    expect(validRow.description).toBeNull();
  });

  it("description can be a string", () => {
    const row: AppRow = { ...validRow, description: "A great app" };
    expect(row.description).toBe("A great app");
  });

  it("access_mode union accepts platform-user", () => {
    const row: AppRow = { ...validRow, access_mode: "platform-user" };
    expect(row.access_mode).toBe("platform-user");
  });

  it("access_mode union accepts public", () => {
    const row: AppRow = { ...validRow, access_mode: "public" };
    expect(row.access_mode).toBe("public");
  });

  it("current_build_id can be null (no active build)", () => {
    expect(validRow.current_build_id).toBeNull();
  });

  it("current_build_id can be a string UUID", () => {
    const row: AppRow = { ...validRow, current_build_id: "build-uuid-001" };
    expect(row.current_build_id).toBe("build-uuid-001");
  });

  it("deleted_at can be null (not soft-deleted)", () => {
    expect(validRow.deleted_at).toBeNull();
  });

  it("deleted_at can be a Date (soft-deleted)", () => {
    const row: AppRow = { ...validRow, deleted_at: new Date("2026-06-01T00:00:00Z") };
    expect(row.deleted_at).toBeInstanceOf(Date);
  });

  it("allowed_modules is an array of strings", () => {
    expect(Array.isArray(validRow.allowed_modules)).toBe(true);
    const mod = validRow.allowed_modules[0];
    expect(typeof mod).toBe("string");
  });

  it("created_at is a Date", () => {
    expect(validRow.created_at).toBeInstanceOf(Date);
  });

  it("has no camelCase key leakage", () => {
    expect("tenantId" in validRow).toBe(false);
    expect("accessMode" in validRow).toBe(false);
    expect("currentBuildId" in validRow).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AppFileRow
// ---------------------------------------------------------------------------

describe("AppFileRow", () => {
  const validRow: AppFileRow = {
    id:           "file-001",
    app_id:       "app-001",
    path:         "/src/index.tsx",
    content:      "import React from 'react';",
    content_hash: "abc123",
    file_version: 1,
    created_at:   new Date("2026-01-01T00:00:00Z"),
    updated_at:   new Date("2026-01-01T00:00:00Z"),
    updated_by:   "user-001",
  };

  it("has all required snake_case columns", () => {
    expect(
      hasKeys(validRow, [
        "id", "app_id", "path", "content", "content_hash",
        "file_version", "created_at", "updated_at", "updated_by",
      ]),
    ).toBe(true);
  });

  it("file_version is a number", () => {
    expect(typeof validRow.file_version).toBe("number");
  });

  it("content is a string", () => {
    expect(typeof validRow.content).toBe("string");
  });

  it("content_hash is a string", () => {
    expect(typeof validRow.content_hash).toBe("string");
  });

  it("updated_at is a Date", () => {
    expect(validRow.updated_at).toBeInstanceOf(Date);
  });
});

// ---------------------------------------------------------------------------
// BuildRow
// ---------------------------------------------------------------------------

describe("BuildRow", () => {
  const validRow: BuildRow = {
    id:             "build-001",
    app_id:         "app-001",
    version_number: 1,
    status:         "pending",
    bundle_path:    null,
    error_message:  null,
    error_detail:   null,
    build_manifest: null,
    built_at:       null,
    built_by:       "user-001",
    created_at:     new Date("2026-01-01T00:00:00Z"),
  };

  it("has all required snake_case columns", () => {
    expect(
      hasKeys(validRow, [
        "id", "app_id", "version_number", "status", "bundle_path",
        "error_message", "error_detail", "build_manifest",
        "built_at", "built_by", "created_at",
      ]),
    ).toBe(true);
  });

  it("status union accepts all 4 values", () => {
    const statuses: BuildRow["status"][] = ["pending", "building", "success", "failed"];
    for (const status of statuses) {
      const row: BuildRow = { ...validRow, status };
      expect(row.status).toBe(status);
    }
  });

  it("bundle_path can be null or string", () => {
    expect(validRow.bundle_path).toBeNull();
    const row: BuildRow = { ...validRow, bundle_path: "tenant-001/app-001/builds/build-001" };
    expect(row.bundle_path).toBe("tenant-001/app-001/builds/build-001");
  });

  it("error_message can be null or string", () => {
    expect(validRow.error_message).toBeNull();
    const row: BuildRow = { ...validRow, error_message: "Compilation failed" };
    expect(row.error_message).toBe("Compilation failed");
  });

  it("error_detail can be null or an array of records", () => {
    expect(validRow.error_detail).toBeNull();
    const row: BuildRow = {
      ...validRow,
      error_detail: [{ file: "/src/App.tsx", line: 5, col: 1, text: "Type error" }],
    };
    expect(Array.isArray(row.error_detail)).toBe(true);
  });

  it("build_manifest can be null or a record", () => {
    expect(validRow.build_manifest).toBeNull();
    const row: BuildRow = { ...validRow, build_manifest: { buildId: "build-001" } };
    expect(typeof row.build_manifest).toBe("object");
  });

  it("built_at can be null or a Date", () => {
    expect(validRow.built_at).toBeNull();
    const row: BuildRow = { ...validRow, built_at: new Date("2026-01-01T01:00:00Z") };
    expect(row.built_at).toBeInstanceOf(Date);
  });

  it("version_number is a number", () => {
    expect(typeof validRow.version_number).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// EnvVarRow
// ---------------------------------------------------------------------------

describe("EnvVarRow", () => {
  const validRow: EnvVarRow = {
    id:         "env-001",
    app_id:     "app-001",
    key:        "API_KEY",
    value:      "encrypted-blob",
    is_secret:  false,
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
  };

  it("has all required snake_case columns", () => {
    expect(
      hasKeys(validRow, [
        "id", "app_id", "key", "value", "is_secret", "created_at", "updated_at",
      ]),
    ).toBe(true);
  });

  it("is_secret is a boolean", () => {
    expect(typeof validRow.is_secret).toBe("boolean");
  });

  it("is_secret can be true", () => {
    const row: EnvVarRow = { ...validRow, is_secret: true };
    expect(row.is_secret).toBe(true);
  });

  it("value is a string (AES-GCM encrypted blob)", () => {
    expect(typeof validRow.value).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// AppRoleRow + RolePermission
// ---------------------------------------------------------------------------

describe("RolePermission", () => {
  const validPerm: RolePermission = {
    entity:  "report",
    actions: ["read", "create"],
  };

  it("has entity and actions fields", () => {
    expect(hasKeys(validPerm, ["entity", "actions"])).toBe(true);
  });

  it("actions union accepts all 5 values", () => {
    const allActions: RolePermission["actions"] = ["create", "read", "update", "delete", "admin"];
    const perm: RolePermission = { entity: "*", actions: allActions };
    expect(perm.actions).toHaveLength(5);
  });
});

describe("AppRoleRow", () => {
  const validRow: AppRoleRow = {
    id:          "role-001",
    app_id:      "app-001",
    name:        "viewer",
    permissions: [{ entity: "report", actions: ["read"] }],
    created_at:  new Date("2026-01-01T00:00:00Z"),
    updated_at:  new Date("2026-01-01T00:00:00Z"),
  };

  it("has all required snake_case columns", () => {
    expect(
      hasKeys(validRow, ["id", "app_id", "name", "permissions", "created_at", "updated_at"]),
    ).toBe(true);
  });

  it("permissions is an array of RolePermission objects", () => {
    expect(Array.isArray(validRow.permissions)).toBe(true);
    const perm = validRow.permissions[0];
    expect(perm).toHaveProperty("entity");
    expect(perm).toHaveProperty("actions");
  });
});

// ---------------------------------------------------------------------------
// TenantShareRow
// ---------------------------------------------------------------------------

describe("TenantShareRow", () => {
  const validRow: TenantShareRow = {
    id:                 "share-001",
    app_id:             "app-001",
    external_tenant_id: "tenant-external",
    mapped_roles:       ["viewer"],
    created_at:         new Date("2026-01-01T00:00:00Z"),
    created_by:         "user-001",
  };

  it("has all required snake_case columns", () => {
    expect(
      hasKeys(validRow, [
        "id", "app_id", "external_tenant_id", "mapped_roles", "created_at", "created_by",
      ]),
    ).toBe(true);
  });

  it("mapped_roles is an array of strings", () => {
    expect(Array.isArray(validRow.mapped_roles)).toBe(true);
    expect(typeof validRow.mapped_roles[0]).toBe("string");
  });

  it("external_tenant_id is a string", () => {
    expect(typeof validRow.external_tenant_id).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// OAuthRegistrationRow
// ---------------------------------------------------------------------------

describe("OAuthRegistrationRow", () => {
  const validRow: OAuthRegistrationRow = {
    id:                 "oauth-001",
    app_id:             "app-001",
    client_id:          "app:app-001:tenant-001",
    client_secret_hash: null,
    access_mode:        "platform-user",
    registered_at:      new Date("2026-01-01T00:00:00Z"),
    updated_at:         new Date("2026-01-01T00:00:00Z"),
  };

  it("has all required snake_case columns", () => {
    expect(
      hasKeys(validRow, [
        "id", "app_id", "client_id", "client_secret_hash",
        "access_mode", "registered_at", "updated_at",
      ]),
    ).toBe(true);
  });

  it("client_secret_hash can be null", () => {
    expect(validRow.client_secret_hash).toBeNull();
  });

  it("client_secret_hash can be a string", () => {
    const row: OAuthRegistrationRow = { ...validRow, client_secret_hash: "bcrypt-hash" };
    expect(row.client_secret_hash).toBe("bcrypt-hash");
  });

  it("access_mode union accepts platform-user and public", () => {
    const modes: OAuthRegistrationRow["access_mode"][] = ["platform-user", "public"];
    for (const access_mode of modes) {
      const row: OAuthRegistrationRow = { ...validRow, access_mode };
      expect(row.access_mode).toBe(access_mode);
    }
  });

  it("registered_at is a Date", () => {
    expect(validRow.registered_at).toBeInstanceOf(Date);
  });
});

// ---------------------------------------------------------------------------
// UserStorageRow
// ---------------------------------------------------------------------------

describe("UserStorageRow", () => {
  const validRow: UserStorageRow = {
    id:         "stor-001",
    app_id:     "app-001",
    user_id:    "user-001",
    key:        "preferences",
    value:      { theme: "dark", language: "en" },
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
  };

  it("has all required snake_case columns", () => {
    expect(
      hasKeys(validRow, [
        "id", "app_id", "user_id", "key", "value", "created_at", "updated_at",
      ]),
    ).toBe(true);
  });

  it("value is unknown (can hold any JSON-serializable type)", () => {
    const rowStr: UserStorageRow = { ...validRow, value: "a string" };
    const rowNum: UserStorageRow = { ...validRow, value: 42 };
    const rowArr: UserStorageRow = { ...validRow, value: [1, 2, 3] };
    const rowNull: UserStorageRow = { ...validRow, value: null };
    expect(rowStr.value).toBe("a string");
    expect(rowNum.value).toBe(42);
    expect(Array.isArray(rowArr.value)).toBe(true);
    expect(rowNull.value).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CreateAppData
// ---------------------------------------------------------------------------

describe("CreateAppData", () => {
  const validData: CreateAppData = {
    tenant_id:   "tenant-001",
    name:        "My App",
    slug:        "my-app",
    access_mode: "platform-user",
    created_by:  "user-001",
  };

  it("accepts minimal required fields", () => {
    expect(validData.tenant_id).toBeDefined();
    expect(validData.name).toBeDefined();
    expect(validData.slug).toBeDefined();
    expect(validData.access_mode).toBeDefined();
    expect(validData.created_by).toBeDefined();
  });

  it("description is optional", () => {
    const withDesc: CreateAppData = { ...validData, description: "A description" };
    expect(withDesc.description).toBe("A description");
    const noDesc: CreateAppData = { ...validData };
    expect(noDesc.description).toBeUndefined();
  });

  it("allowed_modules is optional", () => {
    const withModules: CreateAppData = { ...validData, allowed_modules: ["react"] };
    expect(withModules.allowed_modules).toEqual(["react"]);
    const noModules: CreateAppData = { ...validData };
    expect(noModules.allowed_modules).toBeUndefined();
  });

  it("access_mode union accepts both values", () => {
    const data1: CreateAppData = { ...validData, access_mode: "platform-user" };
    const data2: CreateAppData = { ...validData, access_mode: "public" };
    expect(data1.access_mode).toBe("platform-user");
    expect(data2.access_mode).toBe("public");
  });
});

// ---------------------------------------------------------------------------
// UpdateAppData
// ---------------------------------------------------------------------------

describe("UpdateAppData", () => {
  it("accepts empty object (all fields optional)", () => {
    const data: UpdateAppData = {};
    expect(data.name).toBeUndefined();
    expect(data.slug).toBeUndefined();
  });

  it("description can be null to clear it", () => {
    const data: UpdateAppData = { description: null };
    expect(data.description).toBeNull();
  });

  it("description can be a string", () => {
    const data: UpdateAppData = { description: "Updated" };
    expect(data.description).toBe("Updated");
  });

  it("current_build_id can be null to clear the active build pointer", () => {
    const data: UpdateAppData = { current_build_id: null };
    expect(data.current_build_id).toBeNull();
  });

  it("current_build_id can be a string", () => {
    const data: UpdateAppData = { current_build_id: "build-xyz" };
    expect(data.current_build_id).toBe("build-xyz");
  });
});

// ---------------------------------------------------------------------------
// CreateFileData
// ---------------------------------------------------------------------------

describe("CreateFileData", () => {
  const validData: CreateFileData = {
    app_id:       "app-001",
    path:         "/src/index.tsx",
    content:      "export default function App() {}",
    content_hash: "sha256-abc",
    updated_by:   "user-001",
  };

  it("accepts all required fields", () => {
    expect(validData.app_id).toBeDefined();
    expect(validData.path).toBeDefined();
    expect(validData.content).toBeDefined();
    expect(validData.content_hash).toBeDefined();
    expect(validData.updated_by).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// UpdateFileData
// ---------------------------------------------------------------------------

describe("UpdateFileData", () => {
  const validData: UpdateFileData = {
    content:      "updated content",
    content_hash: "sha256-xyz",
    updated_by:   "user-001",
    file_version: 2,
  };

  it("accepts all required fields", () => {
    expect(validData.content).toBeDefined();
    expect(validData.content_hash).toBeDefined();
    expect(validData.updated_by).toBeDefined();
    expect(validData.file_version).toBe(2);
  });

  it("file_version is the expected version for the WHERE clause", () => {
    const data: UpdateFileData = { ...validData, file_version: 5 };
    expect(data.file_version).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// CreateBuildData
// ---------------------------------------------------------------------------

describe("CreateBuildData", () => {
  const validData: CreateBuildData = {
    app_id:         "app-001",
    version_number: 1,
    status:         "pending",
    built_by:       "user-001",
  };

  it("accepts minimal required fields", () => {
    expect(validData.app_id).toBeDefined();
    expect(validData.version_number).toBe(1);
    expect(validData.status).toBe("pending");
  });

  it("status union covers all 4 values", () => {
    const statuses: CreateBuildData["status"][] = ["pending", "building", "success", "failed"];
    for (const status of statuses) {
      const data: CreateBuildData = { ...validData, status };
      expect(data.status).toBe(status);
    }
  });
});

// ---------------------------------------------------------------------------
// UpdateBuildData
// ---------------------------------------------------------------------------

describe("UpdateBuildData", () => {
  it("accepts empty object (all fields optional)", () => {
    const data: UpdateBuildData = {};
    expect(data.status).toBeUndefined();
    expect(data.bundle_path).toBeUndefined();
  });

  it("bundle_path can be a string", () => {
    const data: UpdateBuildData = { bundle_path: "tenant-001/app-001/builds/build-001" };
    expect(data.bundle_path).toBeDefined();
  });

  it("error_detail is an array of records when set", () => {
    const data: UpdateBuildData = {
      error_detail: [{ file: "/src/App.tsx", line: 1, col: 1, text: "error" }],
    };
    expect(Array.isArray(data.error_detail)).toBe(true);
  });

  it("built_at accepts a Date", () => {
    const dt = new Date("2026-06-01T12:00:00Z");
    const data: UpdateBuildData = { built_at: dt };
    expect(data.built_at).toBe(dt);
  });
});

// ---------------------------------------------------------------------------
// CreateEnvVarData
// ---------------------------------------------------------------------------

describe("CreateEnvVarData", () => {
  const validData: CreateEnvVarData = {
    app_id:    "app-001",
    key:       "API_BASE_URL",
    value:     "encrypted-blob",
    is_secret: false,
  };

  it("accepts all required fields", () => {
    expect(validData.app_id).toBeDefined();
    expect(validData.key).toBeDefined();
    expect(validData.value).toBeDefined();
    expect(validData.is_secret).toBe(false);
  });

  it("is_secret can be true for secrets", () => {
    const data: CreateEnvVarData = { ...validData, is_secret: true };
    expect(data.is_secret).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CreateAppRoleData / UpdateAppRoleData
// ---------------------------------------------------------------------------

describe("CreateAppRoleData", () => {
  const validData: CreateAppRoleData = {
    app_id:      "app-001",
    name:        "editor",
    permissions: [{ entity: "report", actions: ["read", "update"] }],
  };

  it("accepts all required fields", () => {
    expect(validData.app_id).toBeDefined();
    expect(validData.name).toBeDefined();
    expect(validData.permissions).toBeDefined();
  });
});

describe("UpdateAppRoleData", () => {
  it("accepts empty object (all fields optional)", () => {
    const data: UpdateAppRoleData = {};
    expect(data.name).toBeUndefined();
    expect(data.permissions).toBeUndefined();
  });

  it("name can be updated alone", () => {
    const data: UpdateAppRoleData = { name: "power-editor" };
    expect(data.name).toBe("power-editor");
  });

  it("permissions can be updated alone", () => {
    const data: UpdateAppRoleData = {
      permissions: [{ entity: "*", actions: ["create", "read", "update", "delete", "admin"] }],
    };
    expect(data.permissions).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// CreateTenantShareData
// ---------------------------------------------------------------------------

describe("CreateTenantShareData", () => {
  const validData: CreateTenantShareData = {
    app_id:             "app-001",
    external_tenant_id: "tenant-external",
    mapped_roles:       ["viewer"],
    created_by:         "user-001",
  };

  it("accepts all required fields", () => {
    expect(validData.app_id).toBeDefined();
    expect(validData.external_tenant_id).toBeDefined();
    expect(Array.isArray(validData.mapped_roles)).toBe(true);
    expect(validData.created_by).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// UpsertOAuthRegistrationData
// ---------------------------------------------------------------------------

describe("UpsertOAuthRegistrationData", () => {
  const validData: UpsertOAuthRegistrationData = {
    app_id:      "app-001",
    client_id:   "app:app-001:tenant-001",
    access_mode: "platform-user",
  };

  it("accepts minimal required fields without client_secret_hash", () => {
    expect(validData.app_id).toBeDefined();
    expect(validData.client_id).toBeDefined();
    expect(validData.access_mode).toBeDefined();
    expect(validData.client_secret_hash).toBeUndefined();
  });

  it("client_secret_hash is optional", () => {
    const data: UpsertOAuthRegistrationData = { ...validData, client_secret_hash: "hash" };
    expect(data.client_secret_hash).toBe("hash");
  });

  it("access_mode union accepts both values", () => {
    const d1: UpsertOAuthRegistrationData = { ...validData, access_mode: "platform-user" };
    const d2: UpsertOAuthRegistrationData = { ...validData, access_mode: "public" };
    expect(d1.access_mode).toBe("platform-user");
    expect(d2.access_mode).toBe("public");
  });
});

// ---------------------------------------------------------------------------
// UpsertUserStorageData
// ---------------------------------------------------------------------------

describe("UpsertUserStorageData", () => {
  const validData: UpsertUserStorageData = {
    app_id:  "app-001",
    user_id: "user-001",
    key:     "preferences",
    value:   { theme: "dark" },
  };

  it("accepts all required fields", () => {
    expect(validData.app_id).toBeDefined();
    expect(validData.user_id).toBeDefined();
    expect(validData.key).toBeDefined();
    expect(validData.value).toBeDefined();
  });

  it("value is unknown — accepts any JSON type", () => {
    const withString: UpsertUserStorageData = { ...validData, value: "a string" };
    const withNumber: UpsertUserStorageData = { ...validData, value: 99 };
    const withNull: UpsertUserStorageData = { ...validData, value: null };
    expect(withString.value).toBe("a string");
    expect(withNumber.value).toBe(99);
    expect(withNull.value).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cross-type consistency checks
// ---------------------------------------------------------------------------

describe("cross-type consistency", () => {
  it("BuildRow.status union matches CreateBuildData.status union", () => {
    const rowStatus: BuildRow["status"] = "failed";
    const createStatus: CreateBuildData["status"] = rowStatus;
    expect(createStatus).toBe("failed");
  });

  it("AppRow.access_mode union matches CreateAppData.access_mode union", () => {
    const rowMode: AppRow["access_mode"] = "public";
    const createMode: CreateAppData["access_mode"] = rowMode;
    expect(createMode).toBe("public");
  });

  it("OAuthRegistrationRow.access_mode matches UpsertOAuthRegistrationData.access_mode", () => {
    const rowMode: OAuthRegistrationRow["access_mode"] = "platform-user";
    const upsertMode: UpsertOAuthRegistrationData["access_mode"] = rowMode;
    expect(upsertMode).toBe("platform-user");
  });

  it("AppRow has snake_case keys only (no camelCase leakage)", () => {
    const row: AppRow = {
      id: "a", tenant_id: "t", name: "n", slug: "s", description: null,
      access_mode: "platform-user", current_build_id: null, allowed_modules: [],
      created_at: new Date(), updated_at: new Date(), created_by: "u", deleted_at: null,
    };
    expect("tenantId" in row).toBe(false);
    expect("accessMode" in row).toBe(false);
    expect("currentBuildId" in row).toBe(false);
    expect("allowedModules" in row).toBe(false);
  });

  it("BuildRow has snake_case keys only (no camelCase leakage)", () => {
    const row: BuildRow = {
      id: "b", app_id: "a", version_number: 1, status: "pending",
      bundle_path: null, error_message: null, error_detail: null,
      build_manifest: null, built_at: null, built_by: "u", created_at: new Date(),
    };
    expect("appId" in row).toBe(false);
    expect("versionNumber" in row).toBe(false);
    expect("bundlePath" in row).toBe(false);
  });
});
