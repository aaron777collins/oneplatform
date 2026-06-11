import type pg from "pg";
import type { Logger, EventPublisher } from "@oneplatform/core";
import type { PluginRepository } from "../repositories/plugin-repository.js";
import type { InstanceRepository } from "../repositories/instance-repository.js";
import type { HookRepository } from "../repositories/hook-repository.js";
import type { HookService } from "./hook-service.js";
import type { PluginRow } from "../repositories/types.js";
import { PluginNotFoundError } from "./errors.js";

// ---------------------------------------------------------------------------
// UpgradeService — version upgrade and rollback (spec §10)
//
// The atomic swap transaction is the critical path: it updates plugin status,
// hook states, and instance plugin_id pointers in a single DB transaction.
// The unique partial index on (manifest_id) WHERE status='active' enforces
// that exactly one version is active at any moment.
// ---------------------------------------------------------------------------

export interface UpgradeServiceDeps {
  pool: pg.Pool;
  pluginRepo: PluginRepository;
  instanceRepo: InstanceRepository;
  hookRepo: HookRepository;
  hookService: HookService;
  executionServiceUrl: string;
  serviceToken: string;
  logger: Logger;
  eventPublisher: EventPublisher;
}

export interface UpgradeService {
  upgrade(params: {
    manifestId: string;
    toVersion: string;
    upgradedBy: string;
  }): Promise<{ fromVersion: string; toVersion: string }>;

  rollback(params: {
    manifestId: string;
    rolledBackBy: string;
  }): Promise<{ fromVersion: string; toVersion: string }>;
}

export function createUpgradeService(deps: UpgradeServiceDeps): UpgradeService {
  const {
    pool,
    pluginRepo,
    instanceRepo,
    hookRepo,
    hookService: _hookService,
    executionServiceUrl,
    serviceToken,
    logger,
    eventPublisher,
  } = deps;

  async function sendDrainSignal(manifestId: string, gracePeriodMs: number): Promise<void> {
    try {
      await fetch(`${executionServiceUrl}/internal/execution/plugin-drain`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Service-Token": serviceToken,
        },
        body: JSON.stringify({
          pluginId: manifestId,
          tenantId: null,
          gracePeriodMs,
        }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch (err) {
      logger.warn("Drain signal failed (proceeding after grace period)", {
        manifestId,
        error: String(err),
      });
    }
  }

  async function invalidateExecutionCache(
    manifestId: string,
    newVersion: string
  ): Promise<void> {
    try {
      await fetch(`${executionServiceUrl}/internal/execution/plugin-cache-invalidate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Service-Token": serviceToken,
        },
        body: JSON.stringify({
          pluginId: manifestId,
          tenantId: null,
          newBundleVersion: newVersion,
        }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch (err) {
      logger.warn("Cache invalidation signal failed (non-fatal)", {
        manifestId,
        error: String(err),
      });
    }
  }

  async function executeAtomicSwap(
    client: pg.PoolClient,
    manifestId: string,
    oldPlugin: PluginRow,
    newPlugin: PluginRow
  ): Promise<void> {
    // This transaction is the exclusive point where version activeness changes.
    // The unique partial index ensures only one version can be active per manifest_id.
    await client.query("BEGIN");

    // Activate new version.
    await client.query(
      `UPDATE plugin.plugins SET status = 'active' WHERE id = $1`,
      [newPlugin.id]
    );

    // Deactivate old version.
    await client.query(
      `UPDATE plugin.plugins SET status = 'disabled' WHERE id = $1`,
      [oldPlugin.id]
    );

    // Activate new hooks (staged → active).
    await hookRepo.updateStateByPluginAndCurrentState(
      client,
      newPlugin.id,
      "staged",
      "active"
    );

    // Deactivate old hooks (active → disabled).
    await hookRepo.updateStateByPluginAndCurrentState(
      client,
      oldPlugin.id,
      "active",
      "disabled"
    );

    // Update all instances to reference new plugin version.
    await instanceRepo.updatePluginIdForManifest(client, manifestId, newPlugin.id);

    await client.query("COMMIT");
  }

  return {
    async upgrade({ manifestId, toVersion, upgradedBy }) {
      logger.info("Version upgrade started", { manifestId, toVersion });

      const activePlugin = await pluginRepo.findActiveByManifestId(manifestId);
      if (activePlugin === null) {
        throw new PluginNotFoundError(
          `No active version of plugin '${manifestId}' found`
        );
      }

      const stagedPlugin = await pluginRepo.findByManifestIdAndVersion(
        manifestId,
        toVersion
      );
      if (stagedPlugin === null || stagedPlugin.status !== "staged") {
        throw new PluginNotFoundError(
          `No staged version '${toVersion}' found for plugin '${manifestId}'`
        );
      }

      // Step 1: Pre-register new version hooks as 'staged' (not yet in active chain).
      const instances = await instanceRepo.findByPluginManifestId(manifestId);
      for (const instance of instances) {
        if (instance.enabled === "enabled") {
          const hookData = (await import("./hook-service.js")).createHookService({
            hookRepo,
            logger,
          }).buildHookDataFromManifest(
            stagedPlugin.id,
            instance.id,
            instance.tenant_id,
            stagedPlugin.manifest
          );
          await hookRepo.createMany(
            hookData.map((h) => ({ ...h, state: "staged" as const }))
          );
        }
      }

      // Step 2: Warm Execution Service cache (non-blocking, 30s timeout).
      try {
        await fetch(`${executionServiceUrl}/internal/execution/plugin-cache-prefetch`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Service-Token": serviceToken,
          },
          body: JSON.stringify({
            pluginId: manifestId,
            version: toVersion,
          }),
          signal: AbortSignal.timeout(30_000),
        });
      } catch {
        logger.warn("Cache prefetch timed out (upgrade proceeding)", { manifestId });
      }

      // Step 3: Mark old version draining and send drain signal.
      await pluginRepo.update(activePlugin.id, { status: "draining" });
      await sendDrainSignal(manifestId, 60_000);

      // Wait up to 60s for drain (the Execution Service will call /drain-complete,
      // but we proceed after the grace period regardless — spec §10.2).
      await new Promise<void>((resolve) => setTimeout(resolve, 62_000));

      // Step 4: Atomic swap.
      const client = await pool.connect();
      try {
        await executeAtomicSwap(client, manifestId, activePlugin, stagedPlugin);
      } finally {
        client.release();
      }

      logger.info("Atomic swap committed", {
        manifestId,
        fromVersion: activePlugin.version,
        toVersion,
      });

      // Step 5: Invalidate Execution Service cache for old version.
      await invalidateExecutionCache(manifestId, toVersion);

      // Step 6: Schedule old bundle cleanup (24h rollback window).
      const rollbackWindowMs = 24 * 60 * 60 * 1000;
      await pluginRepo.update(activePlugin.id, {
        bundle_delete_after: new Date(Date.now() + rollbackWindowMs),
      });

      // Step 7: Emit upgrade event.
      await eventPublisher.publish({
        eventType: "plugin.upgraded",
        eventVersion: "1.0.0",
        tenantId: "00000000-0000-0000-0000-000000000000",
        actor: { type: "user", id: upgradedBy },
        data: {
          pluginId: manifestId,
          fromVersion: activePlugin.version,
          toVersion,
          upgradedBy,
        },
      });

      return { fromVersion: activePlugin.version, toVersion };
    },

    async rollback({ manifestId, rolledBackBy }) {
      logger.warn("Rollback initiated", { manifestId });

      const currentActive = await pluginRepo.findActiveByManifestId(manifestId);
      if (currentActive === null) {
        throw new PluginNotFoundError(
          `No active version of plugin '${manifestId}' found`
        );
      }

      // Find the most recent disabled version that is within the rollback window.
      const { rows } = await pool.query<PluginRow>(
        `SELECT id, manifest_id, name, version, type, status, bundle_bucket, bundle_key,
                manifest, is_platform_wide, gpg_fingerprint,
                installed_at, installed_by, uninstalled_at, bundle_delete_after
           FROM plugin.plugins
          WHERE manifest_id = $1
            AND status = 'disabled'
            AND bundle_delete_after > now()
          ORDER BY installed_at DESC
          LIMIT 1`,
        [manifestId]
      );

      const previousPlugin = rows[0];
      if (previousPlugin === undefined) {
        throw new PluginNotFoundError(
          `No disabled version of plugin '${manifestId}' found within the 24h rollback window`
        );
      }

      // Drain the current active version.
      await pluginRepo.update(currentActive.id, { status: "draining" });
      await sendDrainSignal(manifestId, 60_000);
      await new Promise<void>((resolve) => setTimeout(resolve, 62_000));

      // Atomic swap — re-activate the previous version.
      const client = await pool.connect();
      try {
        await executeAtomicSwap(client, manifestId, currentActive, previousPlugin);
      } finally {
        client.release();
      }

      // Set the rolled-back version's bundle_delete_after to 24h from now.
      await pluginRepo.update(currentActive.id, {
        bundle_delete_after: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });

      await invalidateExecutionCache(manifestId, previousPlugin.version);

      await eventPublisher.publish({
        eventType: "plugin.rolled_back",
        eventVersion: "1.0.0",
        tenantId: "00000000-0000-0000-0000-000000000000",
        actor: { type: "user", id: rolledBackBy },
        data: {
          pluginId: manifestId,
          fromVersion: currentActive.version,
          toVersion: previousPlugin.version,
          rolledBackBy,
        },
      });

      logger.warn("Rollback complete", {
        manifestId,
        fromVersion: currentActive.version,
        toVersion: previousPlugin.version,
      });

      return {
        fromVersion: currentActive.version,
        toVersion: previousPlugin.version,
      };
    },
  };
}
