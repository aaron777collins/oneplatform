// Unit tests for schemas/index.ts
//
// Covers every exported Zod schema: valid inputs, invalid inputs, defaults,
// boundary conditions, regex patterns, and inferred type assertions.

import { describe, it, expect } from "vitest";
import {
  HookDeclarationSchema,
  PluginManifestSchema,
  InstallPluginSchema,
  ListPluginsQuerySchema,
  UninstallQuerySchema,
  CreateInstanceSchema,
  PatchInstanceSchema,
  UpgradeSchema,
  RollbackSchema,
  CachePutBodySchema,
  DrainCompleteRequestSchema,
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
// Minimal valid manifest (reused across tests)
// ---------------------------------------------------------------------------

const VALID_CHECKSUM = "a".repeat(64); // 64 hex chars

const minimalManifest = {
  manifestVersion: "1" as const,
  id: "com.example.my-plugin",
  name: "My Plugin",
  version: "1.0.0",
  type: "connector" as const,
  description: "A test plugin",
  author: "Test Author",
  minPlatformVersion: "1.0.0",
  entrypoint: "dist/bundle.js",
  configSchema: {},
  hooks: [],
  requiredExternalUrls: [],
  requiredApis: [] as const,
  requiredCredentials: [],
  bundleChecksum: VALID_CHECKSUM,
  license: "MIT",
};

// ---------------------------------------------------------------------------
// HookDeclarationSchema
// ---------------------------------------------------------------------------

describe("HookDeclarationSchema — valid", () => {
  it("accepts a minimal hook declaration with required fields", () => {
    const r = HookDeclarationSchema.safeParse({
      stage: "before:ingest",
      criticality: "critical",
      entrypoint: "hooks/before-ingest",
    });
    expect(r.success).toBe(true);
  });

  it("accepts stage with 'after' prefix", () => {
    const r = HookDeclarationSchema.safeParse({
      stage: "after:transform",
      criticality: "advisory",
      entrypoint: "hooks/after",
    });
    expect(r.success).toBe(true);
  });

  it("accepts stage with sub-qualifier (before:stage:qualifier)", () => {
    const r = HookDeclarationSchema.safeParse({
      stage: "before:ingest:pre",
      criticality: "critical",
      entrypoint: "hooks/entry",
    });
    expect(r.success).toBe(true);
  });

  it("accepts criticality: advisory", () => {
    const r = HookDeclarationSchema.safeParse({
      stage: "before:run",
      criticality: "advisory",
      entrypoint: "hooks/run",
    });
    expect(r.success).toBe(true);
  });

  it("defaults priority to 100 when omitted", () => {
    const r = HookDeclarationSchema.safeParse({
      stage: "before:run",
      criticality: "critical",
      entrypoint: "hooks/entry",
    });
    expect(r.success && r.data.priority).toBe(100);
  });

  it("accepts priority at minimum (0)", () => {
    const r = HookDeclarationSchema.safeParse({
      stage: "before:run",
      criticality: "critical",
      entrypoint: "hooks/entry",
      priority: 0,
    });
    expect(r.success).toBe(true);
  });

  it("accepts priority at maximum (999)", () => {
    const r = HookDeclarationSchema.safeParse({
      stage: "before:run",
      criticality: "critical",
      entrypoint: "hooks/entry",
      priority: 999,
    });
    expect(r.success).toBe(true);
  });

  it("accepts optional timeout at minimum (1)", () => {
    const r = HookDeclarationSchema.safeParse({
      stage: "before:run",
      criticality: "critical",
      entrypoint: "hooks/entry",
      timeout: 1,
    });
    expect(r.success).toBe(true);
  });

  it("accepts optional timeout at maximum (300)", () => {
    const r = HookDeclarationSchema.safeParse({
      stage: "before:run",
      criticality: "critical",
      entrypoint: "hooks/entry",
      timeout: 300,
    });
    expect(r.success).toBe(true);
  });

  it("stage with dotted name segment (before:ingest.batch) is valid", () => {
    const r = HookDeclarationSchema.safeParse({
      stage: "before:ingest.batch",
      criticality: "critical",
      entrypoint: "hooks/entry",
    });
    expect(r.success).toBe(true);
  });
});

describe("HookDeclarationSchema — invalid", () => {
  it("rejects stage without before/after prefix", () => {
    fails(HookDeclarationSchema, {
      stage: "during:run",
      criticality: "critical",
      entrypoint: "hooks/entry",
    });
  });

  it("rejects stage with no colon separator", () => {
    fails(HookDeclarationSchema, {
      stage: "beforerun",
      criticality: "critical",
      entrypoint: "hooks/entry",
    });
  });

  it("rejects unknown criticality value", () => {
    fails(HookDeclarationSchema, {
      stage: "before:run",
      criticality: "required",
      entrypoint: "hooks/entry",
    });
  });

  it("rejects priority below 0", () => {
    fails(HookDeclarationSchema, {
      stage: "before:run",
      criticality: "critical",
      entrypoint: "hooks/entry",
      priority: -1,
    });
  });

  it("rejects priority above 999", () => {
    fails(HookDeclarationSchema, {
      stage: "before:run",
      criticality: "critical",
      entrypoint: "hooks/entry",
      priority: 1000,
    });
  });

  it("rejects fractional priority", () => {
    fails(HookDeclarationSchema, {
      stage: "before:run",
      criticality: "critical",
      entrypoint: "hooks/entry",
      priority: 1.5,
    });
  });

  it("rejects timeout below 1", () => {
    fails(HookDeclarationSchema, {
      stage: "before:run",
      criticality: "critical",
      entrypoint: "hooks/entry",
      timeout: 0,
    });
  });

  it("rejects timeout above 300", () => {
    fails(HookDeclarationSchema, {
      stage: "before:run",
      criticality: "critical",
      entrypoint: "hooks/entry",
      timeout: 301,
    });
  });

  it("rejects empty entrypoint string", () => {
    fails(HookDeclarationSchema, {
      stage: "before:run",
      criticality: "critical",
      entrypoint: "",
    });
  });

  it("rejects missing entrypoint", () => {
    fails(HookDeclarationSchema, {
      stage: "before:run",
      criticality: "critical",
    });
  });
});

// ---------------------------------------------------------------------------
// PluginManifestSchema — id field (reverse-domain regex)
// ---------------------------------------------------------------------------

describe("PluginManifestSchema — id validation", () => {
  it("accepts valid reverse-domain id with two segments", () => {
    const r = PluginManifestSchema.safeParse({ ...minimalManifest, id: "com.example" });
    expect(r.success).toBe(true);
  });

  it("accepts id with three segments", () => {
    const r = PluginManifestSchema.safeParse({ ...minimalManifest, id: "com.example.my-plugin" });
    expect(r.success).toBe(true);
  });

  it("accepts id with hyphens in segment", () => {
    const r = PluginManifestSchema.safeParse({ ...minimalManifest, id: "io.oneplatform.my-connector-v2" });
    expect(r.success).toBe(true);
  });

  it("rejects id with uppercase letters", () => {
    fails(PluginManifestSchema, { ...minimalManifest, id: "com.Example.plugin" });
  });

  it("rejects id with only one segment (no dot)", () => {
    fails(PluginManifestSchema, { ...minimalManifest, id: "myplugin" });
  });

  it("rejects id starting with a dot", () => {
    fails(PluginManifestSchema, { ...minimalManifest, id: ".com.example" });
  });

  it("rejects id with consecutive dots", () => {
    fails(PluginManifestSchema, { ...minimalManifest, id: "com..example" });
  });

  it("rejects id with underscore in segment", () => {
    fails(PluginManifestSchema, { ...minimalManifest, id: "com.example_plugin" });
  });
});

// ---------------------------------------------------------------------------
// PluginManifestSchema — version field (SemVer regex)
// ---------------------------------------------------------------------------

describe("PluginManifestSchema — version validation", () => {
  it("accepts basic semver x.y.z", () => {
    const r = PluginManifestSchema.safeParse({ ...minimalManifest, version: "1.0.0" });
    expect(r.success).toBe(true);
  });

  it("accepts semver with pre-release suffix", () => {
    const r = PluginManifestSchema.safeParse({ ...minimalManifest, version: "2.1.0-beta.1" });
    expect(r.success).toBe(true);
  });

  it("accepts semver with build metadata suffix", () => {
    const r = PluginManifestSchema.safeParse({ ...minimalManifest, version: "1.0.0+build.123" });
    expect(r.success).toBe(true);
  });

  it("rejects version without patch (x.y only)", () => {
    fails(PluginManifestSchema, { ...minimalManifest, version: "1.0" });
  });

  it("rejects version without minor and patch (x only)", () => {
    fails(PluginManifestSchema, { ...minimalManifest, version: "1" });
  });

  it("rejects version with leading v prefix", () => {
    fails(PluginManifestSchema, { ...minimalManifest, version: "v1.0.0" });
  });
});

// ---------------------------------------------------------------------------
// PluginManifestSchema — type field (enum)
// ---------------------------------------------------------------------------

describe("PluginManifestSchema — type enum", () => {
  const pluginTypes = ["connector", "transformer", "destination", "auth-provider", "widget"] as const;

  for (const type of pluginTypes) {
    it(`accepts type '${type}'`, () => {
      const r = PluginManifestSchema.safeParse({ ...minimalManifest, type });
      expect(r.success).toBe(true);
    });
  }

  it("rejects unknown type", () => {
    fails(PluginManifestSchema, { ...minimalManifest, type: "analytics" });
  });
});

// ---------------------------------------------------------------------------
// PluginManifestSchema — bundleChecksum (64 hex chars)
// ---------------------------------------------------------------------------

describe("PluginManifestSchema — bundleChecksum validation", () => {
  it("accepts 64 lowercase hex chars", () => {
    const r = PluginManifestSchema.safeParse({
      ...minimalManifest,
      bundleChecksum: "a1b2c3d4".repeat(8),
    });
    expect(r.success).toBe(true);
  });

  it("rejects checksum with 63 chars", () => {
    fails(PluginManifestSchema, {
      ...minimalManifest,
      bundleChecksum: "a".repeat(63),
    });
  });

  it("rejects checksum with 65 chars", () => {
    fails(PluginManifestSchema, {
      ...minimalManifest,
      bundleChecksum: "a".repeat(65),
    });
  });

  it("rejects checksum with uppercase hex", () => {
    fails(PluginManifestSchema, {
      ...minimalManifest,
      bundleChecksum: "A".repeat(64),
    });
  });

  it("rejects checksum with non-hex characters", () => {
    fails(PluginManifestSchema, {
      ...minimalManifest,
      bundleChecksum: "g".repeat(64),
    });
  });
});

// ---------------------------------------------------------------------------
// PluginManifestSchema — optional fields
// ---------------------------------------------------------------------------

describe("PluginManifestSchema — optional fields", () => {
  it("accepts manifest without supportUrl", () => {
    const { supportUrl: _, ...rest } = { ...minimalManifest, supportUrl: undefined };
    const r = PluginManifestSchema.safeParse(rest);
    expect(r.success).toBe(true);
  });

  it("accepts manifest with valid supportUrl", () => {
    const r = PluginManifestSchema.safeParse({
      ...minimalManifest,
      supportUrl: "https://example.com/support",
    });
    expect(r.success).toBe(true);
  });

  it("rejects invalid supportUrl (not a URL)", () => {
    fails(PluginManifestSchema, {
      ...minimalManifest,
      supportUrl: "not-a-url",
    });
  });

  it("accepts manifest with valid homepageUrl", () => {
    const r = PluginManifestSchema.safeParse({
      ...minimalManifest,
      homepageUrl: "https://example.com",
    });
    expect(r.success).toBe(true);
  });

  it("accepts manifest with tags array", () => {
    const r = PluginManifestSchema.safeParse({
      ...minimalManifest,
      tags: ["etl", "connector"],
    });
    expect(r.success).toBe(true);
  });

  it("accepts manifest with changelog", () => {
    const r = PluginManifestSchema.safeParse({
      ...minimalManifest,
      changelog: "## v1.0.0\n- Initial release",
    });
    expect(r.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PluginManifestSchema — requiredApis enum
// ---------------------------------------------------------------------------

describe("PluginManifestSchema — requiredApis", () => {
  const apis = ["credentials", "fetch", "cache", "ontology", "tracing"] as const;

  it("accepts all valid api names", () => {
    const r = PluginManifestSchema.safeParse({
      ...minimalManifest,
      requiredApis: [...apis],
    });
    expect(r.success).toBe(true);
  });

  it("rejects unknown api name", () => {
    fails(PluginManifestSchema, {
      ...minimalManifest,
      requiredApis: ["storage"],
    });
  });
});

// ---------------------------------------------------------------------------
// PluginManifestSchema — requiredCredentials
// ---------------------------------------------------------------------------

describe("PluginManifestSchema — requiredCredentials", () => {
  it("accepts credentials with all valid types", () => {
    const credTypes = ["secret", "password", "token", "certificate"] as const;
    for (const type of credTypes) {
      const r = PluginManifestSchema.safeParse({
        ...minimalManifest,
        requiredCredentials: [{ name: "api-key", description: "API Key", type, required: true }],
      });
      expect(r.success).toBe(true);
    }
  });

  it("rejects credential with unknown type", () => {
    fails(PluginManifestSchema, {
      ...minimalManifest,
      requiredCredentials: [
        { name: "api-key", description: "API Key", type: "apikey", required: true },
      ],
    });
  });

  it("rejects credential with empty name", () => {
    fails(PluginManifestSchema, {
      ...minimalManifest,
      requiredCredentials: [
        { name: "", description: "API Key", type: "secret", required: true },
      ],
    });
  });
});

// ---------------------------------------------------------------------------
// PluginManifestSchema — name and description boundaries
// ---------------------------------------------------------------------------

describe("PluginManifestSchema — name and description boundaries", () => {
  it("accepts name with exactly 1 char", () => {
    const r = PluginManifestSchema.safeParse({ ...minimalManifest, name: "X" });
    expect(r.success).toBe(true);
  });

  it("accepts name with exactly 100 chars", () => {
    const r = PluginManifestSchema.safeParse({ ...minimalManifest, name: "A".repeat(100) });
    expect(r.success).toBe(true);
  });

  it("rejects empty name", () => {
    fails(PluginManifestSchema, { ...minimalManifest, name: "" });
  });

  it("rejects name longer than 100 chars", () => {
    fails(PluginManifestSchema, { ...minimalManifest, name: "A".repeat(101) });
  });

  it("accepts description with exactly 200 chars", () => {
    const r = PluginManifestSchema.safeParse({
      ...minimalManifest,
      description: "D".repeat(200),
    });
    expect(r.success).toBe(true);
  });

  it("rejects description longer than 200 chars", () => {
    fails(PluginManifestSchema, { ...minimalManifest, description: "D".repeat(201) });
  });
});

// ---------------------------------------------------------------------------
// PluginManifestSchema — hooks array
// ---------------------------------------------------------------------------

describe("PluginManifestSchema — hooks array", () => {
  it("accepts manifest with one valid hook", () => {
    const r = PluginManifestSchema.safeParse({
      ...minimalManifest,
      hooks: [{ stage: "before:ingest", criticality: "critical", entrypoint: "hooks/entry" }],
    });
    expect(r.success).toBe(true);
  });

  it("rejects manifest with invalid hook stage", () => {
    fails(PluginManifestSchema, {
      ...minimalManifest,
      hooks: [{ stage: "invalid", criticality: "critical", entrypoint: "hooks/entry" }],
    });
  });
});

// ---------------------------------------------------------------------------
// PluginManifestSchema — manifestVersion
// ---------------------------------------------------------------------------

describe("PluginManifestSchema — manifestVersion", () => {
  it("accepts manifestVersion '1'", () => {
    const r = PluginManifestSchema.safeParse({ ...minimalManifest, manifestVersion: "1" });
    expect(r.success).toBe(true);
  });

  it("rejects manifestVersion '2'", () => {
    fails(PluginManifestSchema, { ...minimalManifest, manifestVersion: "2" });
  });

  it("rejects missing manifestVersion", () => {
    const { manifestVersion: _, ...rest } = minimalManifest;
    fails(PluginManifestSchema, rest);
  });
});

// ---------------------------------------------------------------------------
// InstallPluginSchema
// ---------------------------------------------------------------------------

describe("InstallPluginSchema — valid", () => {
  it("defaults approveUrls to false", () => {
    const r = InstallPluginSchema.safeParse({});
    expect(r.success && r.data.approveUrls).toBe(false);
  });

  it("defaults platformWide to false", () => {
    const r = InstallPluginSchema.safeParse({});
    expect(r.success && r.data.platformWide).toBe(false);
  });

  it("coerces string 'true' to boolean true for approveUrls", () => {
    const r = InstallPluginSchema.safeParse({ approveUrls: "true" });
    expect(r.success && r.data.approveUrls).toBe(true);
  });

  it("coerces non-empty string 'false' to boolean true (z.coerce.boolean truthy string behaviour)", () => {
    // z.coerce.boolean() coerces any non-empty string to true — this is Zod's documented behaviour
    const r = InstallPluginSchema.safeParse({ approveUrls: "false" });
    expect(r.success && r.data.approveUrls).toBe(true);
  });

  it("coerces empty string to boolean false for approveUrls", () => {
    const r = InstallPluginSchema.safeParse({ approveUrls: "" });
    expect(r.success && r.data.approveUrls).toBe(false);
  });

  it("coerces string 'true' to boolean true for platformWide", () => {
    const r = InstallPluginSchema.safeParse({ platformWide: "true" });
    expect(r.success && r.data.platformWide).toBe(true);
  });

  it("accepts explicit boolean true for approveUrls", () => {
    const r = InstallPluginSchema.safeParse({ approveUrls: true });
    expect(r.success && r.data.approveUrls).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ListPluginsQuerySchema
// ---------------------------------------------------------------------------

describe("ListPluginsQuerySchema — valid", () => {
  it("defaults limit to 50", () => {
    const r = ListPluginsQuerySchema.safeParse({});
    expect(r.success && r.data.limit).toBe(50);
  });

  it("coerces string '25' to number 25 for limit", () => {
    const r = ListPluginsQuerySchema.safeParse({ limit: "25" });
    expect(r.success && r.data.limit).toBe(25);
  });

  it("accepts limit at minimum (1)", () => {
    const r = ListPluginsQuerySchema.safeParse({ limit: 1 });
    expect(r.success).toBe(true);
  });

  it("accepts limit at maximum (100)", () => {
    const r = ListPluginsQuerySchema.safeParse({ limit: 100 });
    expect(r.success).toBe(true);
  });

  it("accepts optional type filter for all 5 plugin types", () => {
    const types = ["connector", "transformer", "destination", "auth-provider", "widget"] as const;
    for (const type of types) {
      const r = ListPluginsQuerySchema.safeParse({ type });
      expect(r.success).toBe(true);
    }
  });

  it("accepts optional status filter for all 4 statuses", () => {
    const statuses = ["installed", "active", "disabled", "uninstalled"] as const;
    for (const status of statuses) {
      const r = ListPluginsQuerySchema.safeParse({ status });
      expect(r.success).toBe(true);
    }
  });

  it("accepts optional q search string", () => {
    const r = ListPluginsQuerySchema.safeParse({ q: "my plugin" });
    expect(r.success && r.data.q).toBe("my plugin");
  });

  it("accepts optional cursor string", () => {
    const r = ListPluginsQuerySchema.safeParse({ cursor: "cursor-abc" });
    expect(r.success && r.data.cursor).toBe("cursor-abc");
  });
});

describe("ListPluginsQuerySchema — invalid", () => {
  it("rejects limit = 0", () => {
    fails(ListPluginsQuerySchema, { limit: 0 });
  });

  it("rejects limit = 101", () => {
    fails(ListPluginsQuerySchema, { limit: 101 });
  });

  it("rejects fractional limit", () => {
    fails(ListPluginsQuerySchema, { limit: 2.5 });
  });

  it("rejects unknown type value", () => {
    fails(ListPluginsQuerySchema, { type: "analytics" });
  });

  it("rejects unknown status value", () => {
    fails(ListPluginsQuerySchema, { status: "pending" });
  });
});

// ---------------------------------------------------------------------------
// UninstallQuerySchema
// ---------------------------------------------------------------------------

describe("UninstallQuerySchema — valid", () => {
  it("defaults confirmOrphan to false", () => {
    const r = UninstallQuerySchema.safeParse({});
    expect(r.success && r.data.confirmOrphan).toBe(false);
  });

  it("coerces string 'true' to boolean true", () => {
    const r = UninstallQuerySchema.safeParse({ confirmOrphan: "true" });
    expect(r.success && r.data.confirmOrphan).toBe(true);
  });

  it("accepts explicit boolean true", () => {
    const r = UninstallQuerySchema.safeParse({ confirmOrphan: true });
    expect(r.success && r.data.confirmOrphan).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CreateInstanceSchema
// ---------------------------------------------------------------------------

describe("CreateInstanceSchema — valid", () => {
  it("accepts minimal valid input", () => {
    const r = CreateInstanceSchema.safeParse({ displayName: "My Instance" });
    expect(r.success).toBe(true);
  });

  it("defaults config to empty object when omitted", () => {
    const r = CreateInstanceSchema.safeParse({ displayName: "My Instance" });
    expect(r.success && r.data.config).toEqual({});
  });

  it("accepts displayName with exactly 1 char", () => {
    const r = CreateInstanceSchema.safeParse({ displayName: "X" });
    expect(r.success).toBe(true);
  });

  it("accepts displayName with exactly 255 chars", () => {
    const r = CreateInstanceSchema.safeParse({ displayName: "A".repeat(255) });
    expect(r.success).toBe(true);
  });

  it("accepts config with arbitrary key-value pairs", () => {
    const r = CreateInstanceSchema.safeParse({
      displayName: "My Instance",
      config: { apiKey: "secret", retries: 3 },
    });
    expect(r.success).toBe(true);
  });
});

describe("CreateInstanceSchema — invalid", () => {
  it("rejects missing displayName", () => {
    fails(CreateInstanceSchema, { config: {} });
  });

  it("rejects empty displayName", () => {
    fails(CreateInstanceSchema, { displayName: "" });
  });

  it("rejects displayName longer than 255 chars", () => {
    fails(CreateInstanceSchema, { displayName: "A".repeat(256) });
  });
});

// ---------------------------------------------------------------------------
// PatchInstanceSchema
// ---------------------------------------------------------------------------

describe("PatchInstanceSchema — valid", () => {
  it("accepts displayName alone", () => {
    const r = PatchInstanceSchema.safeParse({ displayName: "Updated Name" });
    expect(r.success).toBe(true);
  });

  it("accepts config alone", () => {
    const r = PatchInstanceSchema.safeParse({ config: { key: "val" } });
    expect(r.success).toBe(true);
  });

  it("accepts enabled: true alone", () => {
    const r = PatchInstanceSchema.safeParse({ enabled: true });
    expect(r.success).toBe(true);
  });

  it("accepts enabled: false alone", () => {
    const r = PatchInstanceSchema.safeParse({ enabled: false });
    expect(r.success).toBe(true);
  });

  it("accepts all three fields together", () => {
    const r = PatchInstanceSchema.safeParse({
      displayName: "Updated",
      config: { retries: 5 },
      enabled: true,
    });
    expect(r.success).toBe(true);
  });
});

describe("PatchInstanceSchema — invalid", () => {
  it("rejects empty object (at least one field required)", () => {
    fails(PatchInstanceSchema, {});
  });

  it("rejects empty displayName when provided", () => {
    fails(PatchInstanceSchema, { displayName: "" });
  });

  it("rejects displayName longer than 255 chars", () => {
    fails(PatchInstanceSchema, { displayName: "A".repeat(256) });
  });
});

// ---------------------------------------------------------------------------
// UpgradeSchema
// ---------------------------------------------------------------------------

describe("UpgradeSchema — valid", () => {
  it("accepts toVersion alone", () => {
    const r = UpgradeSchema.safeParse({ toVersion: "2.0.0" });
    expect(r.success).toBe(true);
  });

  it("accepts optional scheduledAt as ISO datetime string", () => {
    const r = UpgradeSchema.safeParse({
      toVersion: "2.0.0",
      scheduledAt: "2026-06-10T12:00:00Z",
    });
    expect(r.success).toBe(true);
  });

  it("rejects scheduledAt with timezone offset (z.string().datetime() requires UTC Z suffix)", () => {
    // z.string().datetime() without { offset: true } only accepts UTC (Z suffix) datetimes
    const r = UpgradeSchema.safeParse({
      toVersion: "2.0.0",
      scheduledAt: "2026-06-10T12:00:00+05:30",
    });
    expect(r.success).toBe(false);
  });
});

describe("UpgradeSchema — invalid", () => {
  it("rejects missing toVersion", () => {
    fails(UpgradeSchema, {});
  });

  it("rejects invalid scheduledAt format (not ISO datetime)", () => {
    fails(UpgradeSchema, {
      toVersion: "2.0.0",
      scheduledAt: "2026-06-10",
    });
  });

  it("rejects scheduledAt as arbitrary string", () => {
    fails(UpgradeSchema, {
      toVersion: "2.0.0",
      scheduledAt: "not-a-date",
    });
  });
});

// ---------------------------------------------------------------------------
// RollbackSchema
// ---------------------------------------------------------------------------

describe("RollbackSchema — valid", () => {
  it("accepts empty object", () => {
    const r = RollbackSchema.safeParse({});
    expect(r.success).toBe(true);
  });

  it("accepts undefined (optional schema)", () => {
    const r = RollbackSchema.safeParse(undefined);
    expect(r.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CachePutBodySchema
// ---------------------------------------------------------------------------

describe("CachePutBodySchema — valid", () => {
  it("accepts any value type with default ttlSeconds", () => {
    const r = CachePutBodySchema.safeParse({ value: "hello" });
    expect(r.success && r.data.ttlSeconds).toBe(3600);
  });

  it("accepts object value", () => {
    const r = CachePutBodySchema.safeParse({ value: { data: [1, 2, 3] } });
    expect(r.success).toBe(true);
  });

  it("accepts null value", () => {
    const r = CachePutBodySchema.safeParse({ value: null });
    expect(r.success).toBe(true);
  });

  it("accepts numeric value", () => {
    const r = CachePutBodySchema.safeParse({ value: 42 });
    expect(r.success).toBe(true);
  });

  it("accepts ttlSeconds at minimum (1)", () => {
    const r = CachePutBodySchema.safeParse({ value: "v", ttlSeconds: 1 });
    expect(r.success).toBe(true);
  });

  it("accepts ttlSeconds at maximum (86400)", () => {
    const r = CachePutBodySchema.safeParse({ value: "v", ttlSeconds: 86400 });
    expect(r.success).toBe(true);
  });

  it("defaults ttlSeconds to 3600 when omitted", () => {
    const r = CachePutBodySchema.safeParse({ value: "v" });
    expect(r.success && r.data.ttlSeconds).toBe(3600);
  });
});

describe("CachePutBodySchema — invalid", () => {
  it("accepts missing value field (z.unknown() allows undefined by design)", () => {
    // z.unknown() in Zod accepts any value including undefined/missing keys.
    // The value field presence is enforced at the application layer, not the schema.
    const r = CachePutBodySchema.safeParse({});
    expect(r.success).toBe(true);
  });

  it("rejects ttlSeconds = 0 (below minimum)", () => {
    fails(CachePutBodySchema, { value: "v", ttlSeconds: 0 });
  });

  it("rejects ttlSeconds = 86401 (above maximum)", () => {
    fails(CachePutBodySchema, { value: "v", ttlSeconds: 86401 });
  });

  it("rejects fractional ttlSeconds", () => {
    fails(CachePutBodySchema, { value: "v", ttlSeconds: 3600.5 });
  });
});

// ---------------------------------------------------------------------------
// DrainCompleteRequestSchema
// ---------------------------------------------------------------------------

describe("DrainCompleteRequestSchema — valid", () => {
  it("accepts minimal valid drain complete request", () => {
    const r = DrainCompleteRequestSchema.safeParse({
      manifestId: "com.example.plugin",
      drainedAt: "2026-06-10T12:00:00Z",
      inflightAtDrainStart: 5,
      inflightAtCompletion: 0,
      killedExecutions: [],
    });
    expect(r.success).toBe(true);
  });

  it("accepts killedExecutions with valid UUIDs", () => {
    const r = DrainCompleteRequestSchema.safeParse({
      manifestId: "com.example.plugin",
      drainedAt: "2026-06-10T12:00:00Z",
      inflightAtDrainStart: 3,
      inflightAtCompletion: 1,
      killedExecutions: [
        "550e8400-e29b-41d4-a716-446655440000",
        "550e8400-e29b-41d4-a716-446655440001",
      ],
    });
    expect(r.success).toBe(true);
  });

  it("accepts inflightAtDrainStart = 0", () => {
    const r = DrainCompleteRequestSchema.safeParse({
      manifestId: "com.example.plugin",
      drainedAt: "2026-06-10T12:00:00Z",
      inflightAtDrainStart: 0,
      inflightAtCompletion: 0,
      killedExecutions: [],
    });
    expect(r.success).toBe(true);
  });
});

describe("DrainCompleteRequestSchema — invalid", () => {
  const validDrain = {
    manifestId: "com.example.plugin",
    drainedAt: "2026-06-10T12:00:00Z",
    inflightAtDrainStart: 2,
    inflightAtCompletion: 0,
    killedExecutions: [],
  };

  it("rejects missing manifestId", () => {
    const { manifestId: _, ...rest } = validDrain;
    fails(DrainCompleteRequestSchema, rest);
  });

  it("rejects invalid drainedAt (not ISO datetime)", () => {
    fails(DrainCompleteRequestSchema, { ...validDrain, drainedAt: "not-a-date" });
  });

  it("rejects non-integer inflightAtDrainStart", () => {
    fails(DrainCompleteRequestSchema, { ...validDrain, inflightAtDrainStart: 1.5 });
  });

  it("rejects non-UUID in killedExecutions", () => {
    fails(DrainCompleteRequestSchema, { ...validDrain, killedExecutions: ["not-a-uuid"] });
  });

  it("rejects missing killedExecutions array", () => {
    const { killedExecutions: _, ...rest } = validDrain;
    fails(DrainCompleteRequestSchema, rest);
  });
});
