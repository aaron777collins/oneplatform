// Database row shapes for the plugin schema.
// Column names mirror the SQL schema (snake_case) exactly.
// All UUID columns arrive as strings from the pg driver.
// TIMESTAMPTZ columns arrive as Date objects.

import type { PluginType, PluginStatus, InstanceStatus, HookState, PluginManifest } from "../schemas/index.js";

// ---------------------------------------------------------------------------
// plugin.plugins
// ---------------------------------------------------------------------------

export interface PluginRow {
  id: string;
  manifest_id: string;
  name: string;
  version: string;
  type: PluginType;
  status: PluginStatus;
  bundle_bucket: string;
  bundle_key: string | null;
  manifest: PluginManifest;
  is_platform_wide: boolean;
  gpg_fingerprint: string | null;
  installed_at: Date;
  installed_by: string;
  uninstalled_at: Date | null;
  bundle_delete_after: Date | null;
}

// ---------------------------------------------------------------------------
// plugin.instances
// ---------------------------------------------------------------------------

export interface InstanceRow {
  id: string;
  plugin_manifest_id: string;
  plugin_id: string;
  tenant_id: string;
  display_name: string;
  config: Record<string, unknown>;
  enabled: InstanceStatus;
  created_at: Date;
  created_by: string;
  updated_at: Date;
  updated_by: string | null;
  deleted_at: Date | null;
}

// ---------------------------------------------------------------------------
// plugin.hooks
// ---------------------------------------------------------------------------

export interface HookRow {
  id: string;
  plugin_id: string;
  instance_id: string;
  tenant_id: string;
  stage: string;
  criticality: "critical" | "advisory";
  priority: number;
  timeout_seconds: number;
  entrypoint: string;
  state: HookState;
  created_at: Date;
  updated_at: Date;
}

// ---------------------------------------------------------------------------
// plugin.approved_urls
// ---------------------------------------------------------------------------

export interface ApprovedUrlRow {
  id: string;
  plugin_id: string;
  url_pattern: string;
  approved_by: string;
  approved_at: Date;
}

// ---------------------------------------------------------------------------
// Create / Update input types
// ---------------------------------------------------------------------------

// GPG verification deferred — see G-034 in GAP-ANALYSIS.md
// gpg_fingerprint is stored in the DB column but never populated at install time;
// the column remains to avoid a migration until verification is implemented.
export interface CreatePluginData {
  manifest_id: string;
  name: string;
  version: string;
  type: PluginType;
  status: PluginStatus;
  bundle_bucket: string;
  bundle_key: string;
  manifest: PluginManifest;
  is_platform_wide: boolean;
  installed_by: string;
}

export interface UpdatePluginData {
  status?: PluginStatus;
  bundle_key?: string | null;
  bundle_delete_after?: Date | null;
  uninstalled_at?: Date | null;
}

export interface CreateInstanceData {
  plugin_manifest_id: string;
  plugin_id: string;
  tenant_id: string;
  display_name: string;
  config: Record<string, unknown>;
  enabled: InstanceStatus;
  created_by: string;
}

export interface UpdateInstanceData {
  display_name?: string;
  config?: Record<string, unknown>;
  enabled?: InstanceStatus;
  plugin_id?: string;
  updated_by?: string;
  deleted_at?: Date | null;
}

export interface CreateHookData {
  plugin_id: string;
  instance_id: string;
  tenant_id: string;
  stage: string;
  criticality: "critical" | "advisory";
  priority: number;
  timeout_seconds: number;
  entrypoint: string;
  state: HookState;
}

export interface CreateApprovedUrlData {
  plugin_id: string;
  url_pattern: string;
  approved_by: string;
}

// ---------------------------------------------------------------------------
// Resolved hook — returned by the hook chain query (spec §7.3)
// ---------------------------------------------------------------------------

export interface ResolvedHook {
  hookId: string;
  instanceId: string;
  tenantId: string;
  stage: string;
  criticality: "critical" | "advisory";
  priority: number;
  timeoutMs: number;
  entrypoint: string;
  pluginId: string;
  manifestId: string;
  bundleBucket: string;
  bundleKey: string;
  version: string;
  instanceConfig: Record<string, unknown>;
}
