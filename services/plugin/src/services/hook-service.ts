import type { Logger } from "@oneplatform/core";
import type { HookRepository } from "../repositories/index.js";
import type { ResolvedHook } from "../repositories/types.js";
import type { PluginManifest } from "../schemas/index.js";

// ---------------------------------------------------------------------------
// HookService — hook chain query and dispatch metadata (spec §7)
//
// This service does NOT execute hook code. It provides the ordered chain
// metadata; callers are responsible for invoking the Execution Service.
// ---------------------------------------------------------------------------

export interface HookServiceDeps {
  hookRepo: HookRepository;
  logger: Logger;
}

export interface HookService {
  /** Resolve the active hook chain for a stage + tenant. */
  resolveChain(stage: string, tenantId: string): Promise<ResolvedHook[]>;
  /** Build CreateHookData entries from manifest hook declarations. */
  buildHookDataFromManifest(
    pluginId: string,
    instanceId: string,
    tenantId: string,
    manifest: PluginManifest
  ): import("../repositories/types.js").CreateHookData[];
}

export function createHookService(deps: HookServiceDeps): HookService {
  const { hookRepo } = deps;

  return {
    async resolveChain(stage: string, tenantId: string): Promise<ResolvedHook[]> {
      return hookRepo.resolveChain(stage, tenantId);
    },

    buildHookDataFromManifest(
      pluginId: string,
      instanceId: string,
      tenantId: string,
      manifest: PluginManifest
    ): import("../repositories/types.js").CreateHookData[] {
      return manifest.hooks.map((h) => ({
        plugin_id: pluginId,
        instance_id: instanceId,
        tenant_id: tenantId,
        stage: h.stage,
        criticality: h.criticality,
        priority: h.priority,
        timeout_seconds: h.timeout ?? 30,
        entrypoint: h.entrypoint,
        state: "inactive" as const,
      }));
    },
  };
}
