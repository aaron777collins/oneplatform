// Unit tests for repositories/types.ts
//
// Verifies the structural contract of every interface at runtime:
// correct key names (snake_case for rows, optional vs required fields),
// union literal values, nullable vs non-nullable fields, and input types.

import { describe, it, expect } from "vitest";
import type {
  PluginRow,
  InstanceRow,
  HookRow,
  ApprovedUrlRow,
  CreatePluginData,
  UpdatePluginData,
  CreateInstanceData,
  UpdateInstanceData,
  CreateHookData,
  CreateApprovedUrlData,
  ResolvedHook,
} from "../repositories/types.js";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function hasKeys(obj: object, keys: string[]): boolean {
  return keys.every((k) => k in obj);
}

// ---------------------------------------------------------------------------
// PluginRow
// ---------------------------------------------------------------------------

describe("PluginRow", () => {
  const validRow: PluginRow = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    manifest_id: "com.example.my-plugin",
    name: "My Plugin",
    version: "1.0.0",
    type: "connector",
    status: "active",
    bundle_bucket: "plugin-bundles",
    bundle_key: "com.example.my-plugin/1.0.0/bundle.js",
    manifest: {
      manifestVersion: "1",
      id: "com.example.my-plugin",
      name: "My Plugin",
      version: "1.0.0",
      type: "connector",
      description: "Test",
      author: "Author",
      minPlatformVersion: "1.0.0",
      entrypoint: "dist/bundle.js",
      configSchema: {},
      hooks: [],
      requiredExternalUrls: [],
      requiredApis: [],
      requiredCredentials: [],
      bundleChecksum: "a".repeat(64),
      license: "MIT",
    },
    is_platform_wide: false,
    gpg_fingerprint: null,
    installed_at: new Date("2026-01-01T00:00:00Z"),
    installed_by: "user-001",
    uninstalled_at: null,
    bundle_delete_after: null,
  };

  it("has all required snake_case columns", () => {
    expect(
      hasKeys(validRow, [
        "id", "manifest_id", "name", "version", "type", "status",
        "bundle_bucket", "bundle_key", "manifest", "is_platform_wide",
        "gpg_fingerprint", "installed_at", "installed_by",
        "uninstalled_at", "bundle_delete_after",
      ]),
    ).toBe(true);
  });

  it("type union accepts all 5 plugin types", () => {
    const types: PluginRow["type"][] = [
      "connector", "transformer", "destination", "auth-provider", "widget",
    ];
    for (const type of types) {
      const row: PluginRow = { ...validRow, type };
      expect(row.type).toBe(type);
    }
  });

  it("status union accepts all 6 plugin statuses", () => {
    const statuses: PluginRow["status"][] = [
      "installed", "active", "staged", "draining", "disabled", "uninstalled",
    ];
    for (const status of statuses) {
      const row: PluginRow = { ...validRow, status };
      expect(row.status).toBe(status);
    }
  });

  it("bundle_key can be null (bundle deleted)", () => {
    const row: PluginRow = { ...validRow, bundle_key: null };
    expect(row.bundle_key).toBeNull();
  });

  it("bundle_key can be a string", () => {
    expect(validRow.bundle_key).toBe("com.example.my-plugin/1.0.0/bundle.js");
  });

  it("gpg_fingerprint can be null", () => {
    expect(validRow.gpg_fingerprint).toBeNull();
  });

  it("gpg_fingerprint can be a string", () => {
    const row: PluginRow = { ...validRow, gpg_fingerprint: "ABCDEF1234" };
    expect(row.gpg_fingerprint).toBe("ABCDEF1234");
  });

  it("installed_at is a Date", () => {
    expect(validRow.installed_at).toBeInstanceOf(Date);
  });

  it("uninstalled_at can be null", () => {
    expect(validRow.uninstalled_at).toBeNull();
  });

  it("uninstalled_at can be a Date", () => {
    const row: PluginRow = { ...validRow, uninstalled_at: new Date("2026-06-01T00:00:00Z") };
    expect(row.uninstalled_at).toBeInstanceOf(Date);
  });

  it("bundle_delete_after can be null", () => {
    expect(validRow.bundle_delete_after).toBeNull();
  });

  it("bundle_delete_after can be a Date", () => {
    const row: PluginRow = {
      ...validRow,
      bundle_delete_after: new Date("2026-06-25T00:00:00Z"),
    };
    expect(row.bundle_delete_after).toBeInstanceOf(Date);
  });

  it("is_platform_wide is a boolean", () => {
    expect(typeof validRow.is_platform_wide).toBe("boolean");
  });

  it("manifest is a PluginManifest object", () => {
    expect(typeof validRow.manifest).toBe("object");
    expect(validRow.manifest.id).toBe("com.example.my-plugin");
  });

  it("has no camelCase leakage", () => {
    expect("manifestId" in validRow).toBe(false);
    expect("bundleBucket" in validRow).toBe(false);
    expect("installedAt" in validRow).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// InstanceRow
// ---------------------------------------------------------------------------

describe("InstanceRow", () => {
  const validRow: InstanceRow = {
    id: "inst-001",
    plugin_manifest_id: "com.example.my-plugin",
    plugin_id: "550e8400-e29b-41d4-a716-446655440000",
    tenant_id: "tenant-001",
    display_name: "My Instance",
    config: { apiKey: "secret" },
    enabled: "enabled",
    created_at: new Date("2026-01-01T00:00:00Z"),
    created_by: "user-001",
    updated_at: new Date("2026-01-01T00:00:00Z"),
    updated_by: null,
    deleted_at: null,
  };

  it("has all required snake_case columns", () => {
    expect(
      hasKeys(validRow, [
        "id", "plugin_manifest_id", "plugin_id", "tenant_id", "display_name",
        "config", "enabled", "created_at", "created_by", "updated_at",
        "updated_by", "deleted_at",
      ]),
    ).toBe(true);
  });

  it("enabled union accepts all 3 instance statuses", () => {
    const statuses: InstanceRow["enabled"][] = ["enabled", "disabling", "disabled"];
    for (const enabled of statuses) {
      const row: InstanceRow = { ...validRow, enabled };
      expect(row.enabled).toBe(enabled);
    }
  });

  it("config is a Record<string, unknown>", () => {
    expect(typeof validRow.config).toBe("object");
    expect(validRow.config["apiKey"]).toBe("secret");
  });

  it("updated_by can be null", () => {
    expect(validRow.updated_by).toBeNull();
  });

  it("updated_by can be a string", () => {
    const row: InstanceRow = { ...validRow, updated_by: "user-002" };
    expect(row.updated_by).toBe("user-002");
  });

  it("deleted_at can be null (active record)", () => {
    expect(validRow.deleted_at).toBeNull();
  });

  it("deleted_at can be a Date (soft-deleted)", () => {
    const row: InstanceRow = { ...validRow, deleted_at: new Date("2026-06-01T00:00:00Z") };
    expect(row.deleted_at).toBeInstanceOf(Date);
  });

  it("created_at and updated_at are Date objects", () => {
    expect(validRow.created_at).toBeInstanceOf(Date);
    expect(validRow.updated_at).toBeInstanceOf(Date);
  });
});

// ---------------------------------------------------------------------------
// HookRow
// ---------------------------------------------------------------------------

describe("HookRow", () => {
  const validRow: HookRow = {
    id: "hook-001",
    plugin_id: "550e8400-e29b-41d4-a716-446655440000",
    instance_id: "inst-001",
    tenant_id: "tenant-001",
    stage: "before:ingest",
    criticality: "critical",
    priority: 100,
    timeout_seconds: 30,
    entrypoint: "hooks/before-ingest",
    state: "active",
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
  };

  it("has all required snake_case columns", () => {
    expect(
      hasKeys(validRow, [
        "id", "plugin_id", "instance_id", "tenant_id", "stage",
        "criticality", "priority", "timeout_seconds", "entrypoint",
        "state", "created_at", "updated_at",
      ]),
    ).toBe(true);
  });

  it("criticality union accepts 'critical' and 'advisory'", () => {
    const crits: HookRow["criticality"][] = ["critical", "advisory"];
    for (const criticality of crits) {
      const row: HookRow = { ...validRow, criticality };
      expect(row.criticality).toBe(criticality);
    }
  });

  it("state union accepts all 4 hook states", () => {
    const states: HookRow["state"][] = ["inactive", "active", "staged", "disabled"];
    for (const state of states) {
      const row: HookRow = { ...validRow, state };
      expect(row.state).toBe(state);
    }
  });

  it("priority is a number", () => {
    expect(typeof validRow.priority).toBe("number");
  });

  it("timeout_seconds is a number", () => {
    expect(typeof validRow.timeout_seconds).toBe("number");
  });

  it("created_at and updated_at are Date objects", () => {
    expect(validRow.created_at).toBeInstanceOf(Date);
    expect(validRow.updated_at).toBeInstanceOf(Date);
  });
});

// ---------------------------------------------------------------------------
// ApprovedUrlRow
// ---------------------------------------------------------------------------

describe("ApprovedUrlRow", () => {
  const validRow: ApprovedUrlRow = {
    id: "url-001",
    plugin_id: "550e8400-e29b-41d4-a716-446655440000",
    url_pattern: "https://api.example.com/*",
    approved_by: "user-001",
    approved_at: new Date("2026-01-01T00:00:00Z"),
  };

  it("has all required snake_case columns", () => {
    expect(
      hasKeys(validRow, ["id", "plugin_id", "url_pattern", "approved_by", "approved_at"]),
    ).toBe(true);
  });

  it("url_pattern is a string", () => {
    expect(typeof validRow.url_pattern).toBe("string");
  });

  it("approved_at is a Date", () => {
    expect(validRow.approved_at).toBeInstanceOf(Date);
  });
});

// ---------------------------------------------------------------------------
// CreatePluginData
// ---------------------------------------------------------------------------

describe("CreatePluginData", () => {
  const minimalManifest = {
    manifestVersion: "1" as const,
    id: "com.example.my-plugin",
    name: "My Plugin",
    version: "1.0.0",
    type: "connector" as const,
    description: "Test",
    author: "Author",
    minPlatformVersion: "1.0.0",
    entrypoint: "dist/bundle.js",
    configSchema: {},
    hooks: [],
    requiredExternalUrls: [],
    requiredApis: [] as ("credentials" | "fetch" | "cache" | "ontology" | "tracing")[],
    requiredCredentials: [],
    bundleChecksum: "a".repeat(64),
    license: "MIT",
  };

  const validData: CreatePluginData = {
    manifest_id: "com.example.my-plugin",
    name: "My Plugin",
    version: "1.0.0",
    type: "connector",
    status: "installed",
    bundle_bucket: "plugin-bundles",
    bundle_key: "com.example.my-plugin/1.0.0/bundle.js",
    manifest: minimalManifest,
    is_platform_wide: false,
    installed_by: "user-001",
  };

  it("accepts minimal required fields", () => {
    expect(validData.manifest_id).toBeDefined();
    expect(validData.name).toBeDefined();
    expect(validData.bundle_key).toBeDefined();
  });

  it("gpg_fingerprint is optional", () => {
    const data: CreatePluginData = { ...validData, gpg_fingerprint: "ABCDEF" };
    expect(data.gpg_fingerprint).toBe("ABCDEF");
    const noGpg: CreatePluginData = { ...validData };
    expect(noGpg.gpg_fingerprint).toBeUndefined();
  });

  it("status accepts all 6 plugin statuses", () => {
    const statuses: CreatePluginData["status"][] = [
      "installed", "active", "staged", "draining", "disabled", "uninstalled",
    ];
    for (const status of statuses) {
      const data: CreatePluginData = { ...validData, status };
      expect(data.status).toBe(status);
    }
  });
});

// ---------------------------------------------------------------------------
// UpdatePluginData
// ---------------------------------------------------------------------------

describe("UpdatePluginData", () => {
  it("accepts empty object (all fields optional)", () => {
    const data: UpdatePluginData = {};
    expect(data.status).toBeUndefined();
    expect(data.bundle_key).toBeUndefined();
  });

  it("status is optional", () => {
    const data: UpdatePluginData = { status: "uninstalled" };
    expect(data.status).toBe("uninstalled");
  });

  it("bundle_key can be null to clear it", () => {
    const data: UpdatePluginData = { bundle_key: null };
    expect(data.bundle_key).toBeNull();
  });

  it("bundle_key can be a string", () => {
    const data: UpdatePluginData = { bundle_key: "new/path/bundle.js" };
    expect(data.bundle_key).toBe("new/path/bundle.js");
  });

  it("bundle_delete_after can be null", () => {
    const data: UpdatePluginData = { bundle_delete_after: null };
    expect(data.bundle_delete_after).toBeNull();
  });

  it("bundle_delete_after can be a Date", () => {
    const dt = new Date("2026-07-01T00:00:00Z");
    const data: UpdatePluginData = { bundle_delete_after: dt };
    expect(data.bundle_delete_after).toBe(dt);
  });

  it("uninstalled_at can be null", () => {
    const data: UpdatePluginData = { uninstalled_at: null };
    expect(data.uninstalled_at).toBeNull();
  });

  it("uninstalled_at can be a Date", () => {
    const dt = new Date("2026-06-10T00:00:00Z");
    const data: UpdatePluginData = { uninstalled_at: dt };
    expect(data.uninstalled_at).toBe(dt);
  });
});

// ---------------------------------------------------------------------------
// CreateInstanceData
// ---------------------------------------------------------------------------

describe("CreateInstanceData", () => {
  const validData: CreateInstanceData = {
    plugin_manifest_id: "com.example.my-plugin",
    plugin_id: "550e8400-e29b-41d4-a716-446655440000",
    tenant_id: "tenant-001",
    display_name: "My Instance",
    config: {},
    enabled: "disabled",
    created_by: "user-001",
  };

  it("accepts all required fields", () => {
    expect(validData.plugin_manifest_id).toBeDefined();
    expect(validData.tenant_id).toBeDefined();
    expect(validData.created_by).toBeDefined();
  });

  it("enabled accepts all 3 instance statuses", () => {
    const statuses: CreateInstanceData["enabled"][] = ["enabled", "disabling", "disabled"];
    for (const enabled of statuses) {
      const data: CreateInstanceData = { ...validData, enabled };
      expect(data.enabled).toBe(enabled);
    }
  });

  it("config is a Record<string, unknown>", () => {
    const data: CreateInstanceData = { ...validData, config: { apiKey: "secret" } };
    expect(data.config["apiKey"]).toBe("secret");
  });
});

// ---------------------------------------------------------------------------
// UpdateInstanceData
// ---------------------------------------------------------------------------

describe("UpdateInstanceData", () => {
  it("accepts empty object (all fields optional)", () => {
    const data: UpdateInstanceData = {};
    expect(data.display_name).toBeUndefined();
    expect(data.enabled).toBeUndefined();
  });

  it("enabled can be updated to any valid status", () => {
    const data: UpdateInstanceData = { enabled: "disabling" };
    expect(data.enabled).toBe("disabling");
  });

  it("config can be updated", () => {
    const data: UpdateInstanceData = { config: { retries: 5 } };
    expect(data.config?.["retries"]).toBe(5);
  });

  it("deleted_at can be set to a Date for soft-delete", () => {
    const dt = new Date("2026-06-10T00:00:00Z");
    const data: UpdateInstanceData = { deleted_at: dt };
    expect(data.deleted_at).toBe(dt);
  });

  it("deleted_at can be null to restore (un-delete)", () => {
    const data: UpdateInstanceData = { deleted_at: null };
    expect(data.deleted_at).toBeNull();
  });

  it("updated_by is optional", () => {
    const data: UpdateInstanceData = { updated_by: "user-002" };
    expect(data.updated_by).toBe("user-002");
  });

  it("plugin_id can be updated (version swap)", () => {
    const data: UpdateInstanceData = { plugin_id: "new-plugin-id" };
    expect(data.plugin_id).toBe("new-plugin-id");
  });
});

// ---------------------------------------------------------------------------
// CreateHookData
// ---------------------------------------------------------------------------

describe("CreateHookData", () => {
  const validData: CreateHookData = {
    plugin_id: "550e8400-e29b-41d4-a716-446655440000",
    instance_id: "inst-001",
    tenant_id: "tenant-001",
    stage: "before:ingest",
    criticality: "critical",
    priority: 100,
    timeout_seconds: 30,
    entrypoint: "hooks/before-ingest",
    state: "inactive",
  };

  it("accepts all required fields", () => {
    expect(validData.plugin_id).toBeDefined();
    expect(validData.stage).toBe("before:ingest");
    expect(validData.entrypoint).toBeDefined();
  });

  it("criticality accepts 'critical' and 'advisory'", () => {
    const crits: CreateHookData["criticality"][] = ["critical", "advisory"];
    for (const criticality of crits) {
      const data: CreateHookData = { ...validData, criticality };
      expect(data.criticality).toBe(criticality);
    }
  });

  it("state accepts all 4 hook states", () => {
    const states: CreateHookData["state"][] = ["inactive", "active", "staged", "disabled"];
    for (const state of states) {
      const data: CreateHookData = { ...validData, state };
      expect(data.state).toBe(state);
    }
  });
});

// ---------------------------------------------------------------------------
// CreateApprovedUrlData
// ---------------------------------------------------------------------------

describe("CreateApprovedUrlData", () => {
  const validData: CreateApprovedUrlData = {
    plugin_id: "550e8400-e29b-41d4-a716-446655440000",
    url_pattern: "https://api.example.com/*",
    approved_by: "user-001",
  };

  it("accepts all required fields", () => {
    expect(validData.plugin_id).toBeDefined();
    expect(validData.url_pattern).toBeDefined();
    expect(validData.approved_by).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// ResolvedHook
// ---------------------------------------------------------------------------

describe("ResolvedHook", () => {
  const validHook: ResolvedHook = {
    hookId: "hook-001",
    instanceId: "inst-001",
    tenantId: "tenant-001",
    stage: "before:ingest",
    criticality: "critical",
    priority: 100,
    timeoutMs: 30000,
    entrypoint: "hooks/before-ingest",
    pluginId: "550e8400-e29b-41d4-a716-446655440000",
    manifestId: "com.example.my-plugin",
    bundleBucket: "plugin-bundles",
    bundleKey: "com.example.my-plugin/1.0.0/bundle.js",
    version: "1.0.0",
    instanceConfig: { apiKey: "secret" },
  };

  it("has all required camelCase fields", () => {
    expect(
      hasKeys(validHook, [
        "hookId", "instanceId", "tenantId", "stage", "criticality",
        "priority", "timeoutMs", "entrypoint", "pluginId", "manifestId",
        "bundleBucket", "bundleKey", "version", "instanceConfig",
      ]),
    ).toBe(true);
  });

  it("timeoutMs is a number (milliseconds)", () => {
    expect(typeof validHook.timeoutMs).toBe("number");
    expect(validHook.timeoutMs).toBe(30000);
  });

  it("instanceConfig is a Record<string, unknown>", () => {
    expect(validHook.instanceConfig["apiKey"]).toBe("secret");
  });

  it("criticality union accepts 'critical' and 'advisory'", () => {
    const hook: ResolvedHook = { ...validHook, criticality: "advisory" };
    expect(hook.criticality).toBe("advisory");
  });

  it("uses camelCase keys (no snake_case leakage)", () => {
    expect("hook_id" in validHook).toBe(false);
    expect("instance_id" in validHook).toBe(false);
    expect("tenant_id" in validHook).toBe(false);
    expect("manifest_id" in validHook).toBe(false);
    expect("bundle_key" in validHook).toBe(false);
    expect("timeout_seconds" in validHook).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cross-type consistency
// ---------------------------------------------------------------------------

describe("cross-type consistency", () => {
  it("PluginRow.status and CreatePluginData.status share the same union", () => {
    const rowStatus: PluginRow["status"] = "staged";
    const createStatus: CreatePluginData["status"] = rowStatus;
    expect(createStatus).toBe("staged");
  });

  it("InstanceRow.enabled and CreateInstanceData.enabled share the same union", () => {
    const rowEnabled: InstanceRow["enabled"] = "disabling";
    const createEnabled: CreateInstanceData["enabled"] = rowEnabled;
    expect(createEnabled).toBe("disabling");
  });

  it("HookRow.criticality and CreateHookData.criticality share the same union", () => {
    const rowCrit: HookRow["criticality"] = "advisory";
    const createCrit: CreateHookData["criticality"] = rowCrit;
    expect(createCrit).toBe("advisory");
  });

  it("HookRow.state and CreateHookData.state share the same union", () => {
    const rowState: HookRow["state"] = "staged";
    const createState: CreateHookData["state"] = rowState;
    expect(createState).toBe("staged");
  });

  it("PluginRow has snake_case keys (no camelCase leakage)", () => {
    const row: PluginRow = {
      id: "x", manifest_id: "m", name: "n", version: "1.0.0", type: "connector",
      status: "active", bundle_bucket: "b", bundle_key: "k",
      manifest: {} as PluginRow["manifest"],
      is_platform_wide: false, gpg_fingerprint: null,
      installed_at: new Date(), installed_by: "u",
      uninstalled_at: null, bundle_delete_after: null,
    };
    expect("manifestId" in row).toBe(false);
    expect("bundleBucket" in row).toBe(false);
    expect("installedBy" in row).toBe(false);
  });
});
