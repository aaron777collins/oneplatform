// Unit tests for schemas/index.ts
//
// Covers every exported Zod schema: valid inputs, invalid inputs, defaults,
// boundary conditions, union variants, and optional fields.

import { describe, it, expect } from "vitest";
import {
  CreateAppSchema,
  PatchAppSchema,
  WriteFileSchema,
  RenameFileSchema,
  TriggerBuildSchema,
  DeploySchema,
  RollbackSchema,
  CreateRoleSchema,
  PatchRoleSchema,
  ShareAppSchema,
  EnvVarSchema,
  PatchOAuthSchema,
  GenerateAppSchema,
  StoragePutSchema,
  PaginationSchema,
} from "../schemas/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok<T>(schema: { parse(v: unknown): T }, input: unknown): T {
  return schema.parse(input);
}

function fails(
  schema: { safeParse(v: unknown): { success: boolean } },
  input: unknown,
): void {
  const result = schema.safeParse(input);
  expect(result.success).toBe(false);
}

// ---------------------------------------------------------------------------
// CreateAppSchema
// ---------------------------------------------------------------------------

describe("CreateAppSchema — valid", () => {
  it("accepts a minimal valid create request", () => {
    const r = CreateAppSchema.safeParse({ name: "My App", slug: "my-app" });
    expect(r.success).toBe(true);
  });

  it("defaults accessMode to platform-user when omitted", () => {
    const data = ok(CreateAppSchema, { name: "My App", slug: "my-app" });
    expect(data.accessMode).toBe("platform-user");
  });

  it("accepts accessMode: public", () => {
    const r = CreateAppSchema.safeParse({ name: "My App", slug: "my-app", accessMode: "public" });
    expect(r.success).toBe(true);
  });

  it("accepts accessMode: platform-user explicitly", () => {
    const r = CreateAppSchema.safeParse({ name: "My App", slug: "my-app", accessMode: "platform-user" });
    expect(r.success).toBe(true);
  });

  it("accepts name with exactly 1 character", () => {
    const r = CreateAppSchema.safeParse({ name: "A", slug: "my-app" });
    expect(r.success).toBe(true);
  });

  it("accepts name with exactly 128 characters", () => {
    const r = CreateAppSchema.safeParse({ name: "a".repeat(128), slug: "my-app" });
    expect(r.success).toBe(true);
  });

  it("accepts slug with exactly 1 character", () => {
    const r = CreateAppSchema.safeParse({ name: "My App", slug: "a" });
    expect(r.success).toBe(true);
  });

  it("accepts slug with exactly 64 characters", () => {
    const r = CreateAppSchema.safeParse({ name: "My App", slug: "a".repeat(64) });
    expect(r.success).toBe(true);
  });

  it("accepts slug with hyphens and numbers", () => {
    const r = CreateAppSchema.safeParse({ name: "My App", slug: "my-app-v2-123" });
    expect(r.success).toBe(true);
  });

  it("accepts optional description up to 512 chars", () => {
    const r = CreateAppSchema.safeParse({
      name: "My App",
      slug: "my-app",
      description: "d".repeat(512),
    });
    expect(r.success).toBe(true);
  });

  it("accepts empty description (absent means optional)", () => {
    const r = CreateAppSchema.safeParse({ name: "My App", slug: "my-app" });
    expect(r.success).toBe(true);
  });
});

describe("CreateAppSchema — invalid", () => {
  it("rejects empty name", () => {
    fails(CreateAppSchema, { name: "", slug: "my-app" });
  });

  it("rejects name longer than 128 chars", () => {
    fails(CreateAppSchema, { name: "a".repeat(129), slug: "my-app" });
  });

  it("rejects empty slug", () => {
    fails(CreateAppSchema, { name: "My App", slug: "" });
  });

  it("rejects slug longer than 64 chars", () => {
    fails(CreateAppSchema, { name: "My App", slug: "a".repeat(65) });
  });

  it("rejects slug with uppercase letters", () => {
    fails(CreateAppSchema, { name: "My App", slug: "My-App" });
  });

  it("rejects slug with underscores", () => {
    fails(CreateAppSchema, { name: "My App", slug: "my_app" });
  });

  it("rejects slug with spaces", () => {
    fails(CreateAppSchema, { name: "My App", slug: "my app" });
  });

  it("rejects description longer than 512 chars", () => {
    fails(CreateAppSchema, {
      name: "My App",
      slug: "my-app",
      description: "d".repeat(513),
    });
  });

  it("rejects unknown accessMode value", () => {
    fails(CreateAppSchema, { name: "My App", slug: "my-app", accessMode: "private" });
  });

  it("rejects missing name", () => {
    fails(CreateAppSchema, { slug: "my-app" });
  });

  it("rejects missing slug", () => {
    fails(CreateAppSchema, { name: "My App" });
  });
});

// ---------------------------------------------------------------------------
// PatchAppSchema
// ---------------------------------------------------------------------------

describe("PatchAppSchema — valid", () => {
  it("accepts empty object (all fields optional)", () => {
    const r = PatchAppSchema.safeParse({});
    expect(r.success).toBe(true);
  });

  it("accepts name alone", () => {
    const r = PatchAppSchema.safeParse({ name: "Updated Name" });
    expect(r.success).toBe(true);
  });

  it("accepts slug alone", () => {
    const r = PatchAppSchema.safeParse({ slug: "updated-slug" });
    expect(r.success).toBe(true);
  });

  it("accepts description: null to clear it", () => {
    const r = PatchAppSchema.safeParse({ description: null });
    expect(r.success).toBe(true);
  });

  it("accepts description: string", () => {
    const r = PatchAppSchema.safeParse({ description: "new desc" });
    expect(r.success).toBe(true);
  });

  it("accepts accessMode alone", () => {
    const r = PatchAppSchema.safeParse({ accessMode: "public" });
    expect(r.success).toBe(true);
  });

  it("accepts allowedModules array with up to 20 entries", () => {
    const r = PatchAppSchema.safeParse({
      allowedModules: Array.from({ length: 20 }, (_, i) => `module-${i}`),
    });
    expect(r.success).toBe(true);
  });

  it("accepts all optional fields together", () => {
    const r = PatchAppSchema.safeParse({
      name: "Updated",
      slug: "updated",
      description: "new",
      accessMode: "public",
      allowedModules: ["react"],
    });
    expect(r.success).toBe(true);
  });
});

describe("PatchAppSchema — invalid", () => {
  it("rejects empty name when provided", () => {
    fails(PatchAppSchema, { name: "" });
  });

  it("rejects name longer than 128 chars", () => {
    fails(PatchAppSchema, { name: "a".repeat(129) });
  });

  it("rejects slug with uppercase when provided", () => {
    fails(PatchAppSchema, { slug: "MyApp" });
  });

  it("rejects description longer than 512 chars", () => {
    fails(PatchAppSchema, { description: "d".repeat(513) });
  });

  it("rejects allowedModules array with more than 20 entries", () => {
    fails(PatchAppSchema, {
      allowedModules: Array.from({ length: 21 }, (_, i) => `module-${i}`),
    });
  });

  it("rejects unknown fields (.strict())", () => {
    fails(PatchAppSchema, { unknownField: "value" });
  });
});

// ---------------------------------------------------------------------------
// WriteFileSchema
// ---------------------------------------------------------------------------

describe("WriteFileSchema — valid", () => {
  it("accepts minimal valid write request with fileVersion 0 (create)", () => {
    const r = WriteFileSchema.safeParse({ content: "hello world", fileVersion: 0 });
    expect(r.success).toBe(true);
  });

  it("accepts fileVersion 1 (update)", () => {
    const r = WriteFileSchema.safeParse({ content: "updated content", fileVersion: 1 });
    expect(r.success).toBe(true);
  });

  it("accepts content at exactly 1MB (1,048,576 chars)", () => {
    const r = WriteFileSchema.safeParse({ content: "x".repeat(1_048_576), fileVersion: 0 });
    expect(r.success).toBe(true);
  });

  it("accepts empty content string", () => {
    const r = WriteFileSchema.safeParse({ content: "", fileVersion: 0 });
    expect(r.success).toBe(true);
  });
});

describe("WriteFileSchema — invalid", () => {
  it("rejects content exceeding 1MB", () => {
    fails(WriteFileSchema, { content: "x".repeat(1_048_577), fileVersion: 0 });
  });

  it("rejects fileVersion = -1 (below minimum)", () => {
    fails(WriteFileSchema, { content: "hello", fileVersion: -1 });
  });

  it("rejects fractional fileVersion", () => {
    fails(WriteFileSchema, { content: "hello", fileVersion: 1.5 });
  });

  it("rejects missing content", () => {
    fails(WriteFileSchema, { fileVersion: 0 });
  });

  it("rejects missing fileVersion", () => {
    fails(WriteFileSchema, { content: "hello" });
  });
});

// ---------------------------------------------------------------------------
// RenameFileSchema
// ---------------------------------------------------------------------------

describe("RenameFileSchema — valid", () => {
  it("accepts a valid rename request", () => {
    const r = RenameFileSchema.safeParse({
      fromPath: "/src/old.tsx",
      toPath: "/src/new.tsx",
      fileVersion: 1,
    });
    expect(r.success).toBe(true);
  });

  it("accepts fileVersion of 1 (minimum)", () => {
    const r = RenameFileSchema.safeParse({
      fromPath: "/a.ts",
      toPath: "/b.ts",
      fileVersion: 1,
    });
    expect(r.success).toBe(true);
  });

  it("accepts high fileVersion integers", () => {
    const r = RenameFileSchema.safeParse({
      fromPath: "/a.ts",
      toPath: "/b.ts",
      fileVersion: 999999,
    });
    expect(r.success).toBe(true);
  });
});

describe("RenameFileSchema — invalid", () => {
  it("rejects fileVersion = 0 (must be at least 1 for rename)", () => {
    fails(RenameFileSchema, { fromPath: "/a.ts", toPath: "/b.ts", fileVersion: 0 });
  });

  it("rejects missing fromPath", () => {
    fails(RenameFileSchema, { toPath: "/b.ts", fileVersion: 1 });
  });

  it("rejects missing toPath", () => {
    fails(RenameFileSchema, { fromPath: "/a.ts", fileVersion: 1 });
  });

  it("rejects fractional fileVersion", () => {
    fails(RenameFileSchema, { fromPath: "/a.ts", toPath: "/b.ts", fileVersion: 1.1 });
  });
});

// ---------------------------------------------------------------------------
// TriggerBuildSchema
// ---------------------------------------------------------------------------

describe("TriggerBuildSchema — valid", () => {
  it("accepts undefined body — TriggerBuildSchema is optional", () => {
    const r = TriggerBuildSchema.safeParse(undefined);
    expect(r.success).toBe(true);
  });

  it("defaults preview to false when object is empty", () => {
    const data = ok(TriggerBuildSchema, {});
    expect(data?.preview).toBe(false);
  });

  it("accepts preview: true", () => {
    const data = ok(TriggerBuildSchema, { preview: true });
    expect(data?.preview).toBe(true);
  });

  it("accepts preview: false explicitly", () => {
    const data = ok(TriggerBuildSchema, { preview: false });
    expect(data?.preview).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DeploySchema
// ---------------------------------------------------------------------------

describe("DeploySchema — valid", () => {
  it("accepts empty object (buildId is optional)", () => {
    const r = DeploySchema.safeParse({});
    expect(r.success).toBe(true);
  });

  it("accepts a valid UUID buildId", () => {
    const r = DeploySchema.safeParse({ buildId: "550e8400-e29b-41d4-a716-446655440000" });
    expect(r.success).toBe(true);
  });
});

describe("DeploySchema — invalid", () => {
  it("rejects non-UUID buildId", () => {
    fails(DeploySchema, { buildId: "not-a-uuid" });
  });

  it("rejects integer buildId", () => {
    fails(DeploySchema, { buildId: 12345 });
  });
});

// ---------------------------------------------------------------------------
// RollbackSchema
// ---------------------------------------------------------------------------

describe("RollbackSchema — valid", () => {
  it("accepts a valid UUID buildId", () => {
    const r = RollbackSchema.safeParse({ buildId: "550e8400-e29b-41d4-a716-446655440000" });
    expect(r.success).toBe(true);
  });
});

describe("RollbackSchema — invalid", () => {
  it("rejects missing buildId", () => {
    fails(RollbackSchema, {});
  });

  it("rejects non-UUID buildId", () => {
    fails(RollbackSchema, { buildId: "build-001" });
  });

  it("rejects empty string buildId", () => {
    fails(RollbackSchema, { buildId: "" });
  });
});

// ---------------------------------------------------------------------------
// CreateRoleSchema
// ---------------------------------------------------------------------------

describe("CreateRoleSchema — valid", () => {
  it("accepts a minimal valid role", () => {
    const r = CreateRoleSchema.safeParse({
      name: "viewer",
      permissions: [{ entity: "report", actions: ["read"] }],
    });
    expect(r.success).toBe(true);
  });

  it("accepts all action values: create, read, update, delete, admin", () => {
    const r = CreateRoleSchema.safeParse({
      name: "admin",
      permissions: [{ entity: "*", actions: ["create", "read", "update", "delete", "admin"] }],
    });
    expect(r.success).toBe(true);
  });

  it("accepts empty permissions array", () => {
    const r = CreateRoleSchema.safeParse({ name: "empty-role", permissions: [] });
    expect(r.success).toBe(true);
  });

  it("accepts up to 50 permissions (maximum)", () => {
    const permissions = Array.from({ length: 50 }, (_, i) => ({
      entity: `entity-${i}`,
      actions: ["read"] as const,
    }));
    const r = CreateRoleSchema.safeParse({ name: "big-role", permissions });
    expect(r.success).toBe(true);
  });

  it("accepts role name with exactly 64 chars", () => {
    const r = CreateRoleSchema.safeParse({
      name: "a".repeat(64),
      permissions: [],
    });
    expect(r.success).toBe(true);
  });
});

describe("CreateRoleSchema — invalid", () => {
  it("rejects empty name", () => {
    fails(CreateRoleSchema, { name: "", permissions: [] });
  });

  it("rejects name longer than 64 chars", () => {
    fails(CreateRoleSchema, { name: "a".repeat(65), permissions: [] });
  });

  it("rejects more than 50 permissions", () => {
    const permissions = Array.from({ length: 51 }, (_, i) => ({
      entity: `entity-${i}`,
      actions: ["read"] as const,
    }));
    fails(CreateRoleSchema, { name: "role", permissions });
  });

  it("rejects invalid action value in permissions", () => {
    fails(CreateRoleSchema, {
      name: "role",
      permissions: [{ entity: "report", actions: ["execute"] }],
    });
  });

  it("rejects missing permissions", () => {
    fails(CreateRoleSchema, { name: "role" });
  });
});

// ---------------------------------------------------------------------------
// PatchRoleSchema
// ---------------------------------------------------------------------------

describe("PatchRoleSchema — valid", () => {
  it("accepts empty object (all fields optional)", () => {
    const r = PatchRoleSchema.safeParse({});
    expect(r.success).toBe(true);
  });

  it("accepts name alone", () => {
    const r = PatchRoleSchema.safeParse({ name: "editor" });
    expect(r.success).toBe(true);
  });

  it("accepts permissions alone", () => {
    const r = PatchRoleSchema.safeParse({
      permissions: [{ entity: "report", actions: ["read", "update"] }],
    });
    expect(r.success).toBe(true);
  });
});

describe("PatchRoleSchema — invalid", () => {
  it("rejects empty name when provided", () => {
    fails(PatchRoleSchema, { name: "" });
  });

  it("rejects name longer than 64 chars", () => {
    fails(PatchRoleSchema, { name: "a".repeat(65) });
  });

  it("rejects unknown fields (.strict())", () => {
    fails(PatchRoleSchema, { unknownField: "value" });
  });
});

// ---------------------------------------------------------------------------
// ShareAppSchema
// ---------------------------------------------------------------------------

describe("ShareAppSchema — valid", () => {
  it("accepts a valid share request", () => {
    const r = ShareAppSchema.safeParse({
      tenantId: "550e8400-e29b-41d4-a716-446655440000",
      mappedRoles: ["viewer"],
    });
    expect(r.success).toBe(true);
  });

  it("accepts multiple mapped roles", () => {
    const r = ShareAppSchema.safeParse({
      tenantId: "550e8400-e29b-41d4-a716-446655440000",
      mappedRoles: ["viewer", "editor", "admin"],
    });
    expect(r.success).toBe(true);
  });
});

describe("ShareAppSchema — invalid", () => {
  it("rejects non-UUID tenantId", () => {
    fails(ShareAppSchema, { tenantId: "not-a-uuid", mappedRoles: ["viewer"] });
  });

  it("rejects empty mappedRoles array (minimum 1)", () => {
    fails(ShareAppSchema, {
      tenantId: "550e8400-e29b-41d4-a716-446655440000",
      mappedRoles: [],
    });
  });

  it("rejects missing tenantId", () => {
    fails(ShareAppSchema, { mappedRoles: ["viewer"] });
  });

  it("rejects missing mappedRoles", () => {
    fails(ShareAppSchema, { tenantId: "550e8400-e29b-41d4-a716-446655440000" });
  });
});

// ---------------------------------------------------------------------------
// EnvVarSchema
// ---------------------------------------------------------------------------

describe("EnvVarSchema — valid", () => {
  it("accepts a non-secret env var", () => {
    const r = EnvVarSchema.safeParse({ value: "production", isSecret: false });
    expect(r.success).toBe(true);
  });

  it("accepts a secret env var", () => {
    const r = EnvVarSchema.safeParse({ value: "super-secret-key", isSecret: true });
    expect(r.success).toBe(true);
  });

  it("defaults isSecret to false when omitted", () => {
    const data = ok(EnvVarSchema, { value: "hello" });
    expect(data.isSecret).toBe(false);
  });

  it("accepts value up to 4096 chars", () => {
    const r = EnvVarSchema.safeParse({ value: "x".repeat(4096), isSecret: false });
    expect(r.success).toBe(true);
  });

  it("accepts empty value string", () => {
    const r = EnvVarSchema.safeParse({ value: "", isSecret: false });
    expect(r.success).toBe(true);
  });
});

describe("EnvVarSchema — invalid", () => {
  it("rejects value longer than 4096 chars", () => {
    fails(EnvVarSchema, { value: "x".repeat(4097), isSecret: false });
  });

  it("rejects missing value", () => {
    fails(EnvVarSchema, { isSecret: false });
  });
});

// ---------------------------------------------------------------------------
// PatchOAuthSchema
// ---------------------------------------------------------------------------

describe("PatchOAuthSchema — valid", () => {
  it("accepts a single redirect URI", () => {
    const r = PatchOAuthSchema.safeParse({
      additionalRedirectUris: ["https://example.com/callback"],
    });
    expect(r.success).toBe(true);
  });

  it("accepts an empty array", () => {
    const r = PatchOAuthSchema.safeParse({ additionalRedirectUris: [] });
    expect(r.success).toBe(true);
  });

  it("accepts up to 10 URIs (maximum)", () => {
    const uris = Array.from({ length: 10 }, (_, i) => `https://example-${i}.com/cb`);
    const r = PatchOAuthSchema.safeParse({ additionalRedirectUris: uris });
    expect(r.success).toBe(true);
  });
});

describe("PatchOAuthSchema — invalid", () => {
  it("rejects more than 10 redirect URIs", () => {
    const uris = Array.from({ length: 11 }, (_, i) => `https://example-${i}.com/cb`);
    fails(PatchOAuthSchema, { additionalRedirectUris: uris });
  });

  it("rejects non-URL string in array", () => {
    fails(PatchOAuthSchema, { additionalRedirectUris: ["not-a-url"] });
  });

  it("accepts HTTP URI (Zod url() does not restrict to HTTPS)", () => {
    // The schema uses z.string().url() which accepts any valid URL including http.
    // HTTPS enforcement is a runtime/policy check, not enforced in this Zod schema.
    const r = PatchOAuthSchema.safeParse({ additionalRedirectUris: ["http://example.com/callback"] });
    expect(r.success).toBe(true);
  });

  it("rejects missing additionalRedirectUris", () => {
    fails(PatchOAuthSchema, {});
  });
});

// ---------------------------------------------------------------------------
// GenerateAppSchema
// ---------------------------------------------------------------------------

describe("GenerateAppSchema — valid", () => {
  it("accepts a minimal valid generate request", () => {
    const r = GenerateAppSchema.safeParse({
      appName: "CRM App",
      slug: "crm-app",
      entityTypes: ["customer"],
    });
    expect(r.success).toBe(true);
  });

  it("accepts up to 10 entity types (maximum)", () => {
    const entityTypes = Array.from({ length: 10 }, (_, i) => `entity-${i}`);
    const r = GenerateAppSchema.safeParse({
      appName: "Big App",
      slug: "big-app",
      entityTypes,
    });
    expect(r.success).toBe(true);
  });

  it("accepts slug with hyphens and numbers", () => {
    const r = GenerateAppSchema.safeParse({
      appName: "My App",
      slug: "my-app-v2",
      entityTypes: ["order"],
    });
    expect(r.success).toBe(true);
  });
});

describe("GenerateAppSchema — invalid", () => {
  it("rejects empty appName", () => {
    fails(GenerateAppSchema, { appName: "", slug: "my-app", entityTypes: ["customer"] });
  });

  it("rejects appName longer than 128 chars", () => {
    fails(GenerateAppSchema, {
      appName: "a".repeat(129),
      slug: "my-app",
      entityTypes: ["customer"],
    });
  });

  it("rejects slug with uppercase letters", () => {
    fails(GenerateAppSchema, { appName: "App", slug: "My-App", entityTypes: ["customer"] });
  });

  it("rejects empty entityTypes array (minimum 1)", () => {
    fails(GenerateAppSchema, { appName: "App", slug: "app", entityTypes: [] });
  });

  it("rejects more than 10 entity types", () => {
    const entityTypes = Array.from({ length: 11 }, (_, i) => `entity-${i}`);
    fails(GenerateAppSchema, { appName: "App", slug: "app", entityTypes });
  });
});

// ---------------------------------------------------------------------------
// StoragePutSchema
// ---------------------------------------------------------------------------

describe("StoragePutSchema — valid", () => {
  it("accepts a string value", () => {
    const r = StoragePutSchema.safeParse({ value: "hello" });
    expect(r.success).toBe(true);
  });

  it("accepts a number value", () => {
    const r = StoragePutSchema.safeParse({ value: 42 });
    expect(r.success).toBe(true);
  });

  it("accepts a null value", () => {
    const r = StoragePutSchema.safeParse({ value: null });
    expect(r.success).toBe(true);
  });

  it("accepts an object value", () => {
    const r = StoragePutSchema.safeParse({ value: { key: "data", count: 5 } });
    expect(r.success).toBe(true);
  });

  it("accepts an array value", () => {
    const r = StoragePutSchema.safeParse({ value: [1, 2, 3] });
    expect(r.success).toBe(true);
  });

  it("accepts a boolean value", () => {
    const r = StoragePutSchema.safeParse({ value: true });
    expect(r.success).toBe(true);
  });
});

describe("StoragePutSchema — edge cases", () => {
  it("accepts empty object {} — value field is present as undefined (z.unknown() accepts undefined)", () => {
    // z.unknown() accepts any value including undefined from a missing key.
    // The schema does not use .required() — an absent key still satisfies unknown.
    const r = StoragePutSchema.safeParse({});
    // This documents the actual behavior: {} parses successfully with value=undefined
    expect(r.success).toBe(true);
  });

  it("accepts null value explicitly", () => {
    const r = StoragePutSchema.safeParse({ value: null });
    expect(r.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PaginationSchema
// ---------------------------------------------------------------------------

describe("PaginationSchema — valid", () => {
  it("accepts empty object with default limit 50", () => {
    const data = ok(PaginationSchema, {});
    expect(data.limit).toBe(50);
  });

  it("coerces string limit to number", () => {
    const data = ok(PaginationSchema, { limit: "25" });
    expect(data.limit).toBe(25);
  });

  it("accepts limit at minimum (1)", () => {
    const r = PaginationSchema.safeParse({ limit: 1 });
    expect(r.success).toBe(true);
  });

  it("accepts limit at maximum (200)", () => {
    const r = PaginationSchema.safeParse({ limit: 200 });
    expect(r.success).toBe(true);
  });

  it("accepts optional cursor string", () => {
    const data = ok(PaginationSchema, { cursor: "cursor-abc" });
    expect(data.cursor).toBe("cursor-abc");
  });

  it("cursor is undefined when absent", () => {
    const data = ok(PaginationSchema, {});
    expect(data.cursor).toBeUndefined();
  });
});

describe("PaginationSchema — invalid", () => {
  it("rejects limit = 0", () => {
    fails(PaginationSchema, { limit: 0 });
  });

  it("rejects limit = 201", () => {
    fails(PaginationSchema, { limit: 201 });
  });

  it("rejects fractional limit", () => {
    fails(PaginationSchema, { limit: 10.5 });
  });
});
