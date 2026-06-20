import Ajv from "ajv";
import type pg from "pg";
import type { Logger, EventPublisher } from "@oneplatform/core";
import type { PluginRepository } from "../repositories/plugin-repository.js";
import type { InstanceRepository } from "../repositories/instance-repository.js";
import type { HookRepository } from "../repositories/hook-repository.js";
import type { HookService } from "./hook-service.js";
import type { PluginRow } from "../repositories/types.js";
import {
  PluginNotFoundError,
  ConfigMigrationRequiredError,
} from "./errors.js";

const ajv = new Ajv({ allErrors: true, useDefaults: false });

function validateConfigAgainstSchema(
  config: Record<string, unknown>,
  schema: Record<string, unknown>
): { valid: boolean; errors: string[] } {
  const validate = ajv.compile(schema);
  const valid = validate(config) as boolean;
  if (valid) return { valid: true, errors: [] };
  const errors = (validate.errors ?? []).map((err) => {
    const path = err.dataPath ? `config${err.dataPath}` : "config";
    return `${path}: ${err.message ?? err.keyword}`;
  });
  return { valid: false, errors };
}

// ---------------------------------------------------------------------------
// UpgradeService — version upgrade and rollback (spec §10)
//
// The atomic swap transaction is the critical path: it updates plugin status,
// hook states, and instance plugin_id pointers in a single DB transaction.
// The unique partial index on (manifest_id) WHERE status='active' enforces
// that exactly one version is active at any moment.
//
// W5/W10 fix: drain is now asynchronous. We store a per-manifestId resolve
// function in drainResolvers. The drain-complete callback (signalDrainComplete)
// resolves it immediately; a 62s timeout fires as a fallback so upgrades
// never block the event loop indefinitely.
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

  /**
   * Called by the internal drain-complete endpoint (spec §8.5).
   * Resolves the pending drain promise for the given manifestId so the upgrade
   * swap can proceed immediately rather than waiting for the full 62s timeout.
   */
  signalDrainComplete(manifestId: string): void;
}

export function createUpgradeService(deps: UpgradeServiceDeps): UpgradeService {
  const {
    pool,
    pluginRepo,
    instanceRepo,
    hookRepo,
    hookService,
    executionServiceUrl,
    serviceToken,
    logger,
    eventPublisher,
  } = deps;

  // W5/W10 fix: map from manifestId to the resolve function of the in-flight
  // drain promise. signalDrainComplete() calls it to unblock the upgrade swap.
  const drainResolvers = new Map<string, () => void>();

  function waitForDrain(manifestId: string, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      drainResolvers.set(manifestId, resolve);

      // Fallback timeout — upgrade proceeds regardless after gracePeriod + 2s buffer.
      const timer = setTimeout(() => {
        if (drainResolvers.has(manifestId)) {
          logger.warn("Drain timeout expired — proceeding with version swap", { manifestId });
          drainResolvers.delete(manifestId);
          resolve();
        }
      }, timeoutMs);

      // Allow the process to exit even if this timer is pending.
      timer.unref?.();
    });
  }

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

    try {
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
    } catch (err) {
      // Explicit ROLLBACK on failure so the partial transaction is not left
      // open until the pool releases the client. While pg.Pool issues an
      // implicit ROLLBACK on client.release() with a pending transaction,
      // relying on that implicit behavior is fragile. An explicit ROLLBACK
      // here makes the failure mode unambiguous and matches codebase conventions.
      await client.query("ROLLBACK").catch(() => {
        // Ignore ROLLBACK errors — the client will be released anyway and the
        // pool will handle cleanup. Swallowing here prevents masking the original error.
      });
      throw err;
    }
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

      // B6 fix: pre-flight config re-validation — fetch all active instances and
      // validate their configs against the new version's configSchema. If any fail,
      // abort the upgrade so tenants are not silently broken by a schema change.
      const newConfigSchema = stagedPlugin.manifest.configSchema;
      const allInstances = await instanceRepo.findByPluginManifestId(manifestId);
      const failingInstances: string[] = [];

      for (const instance of allInstances) {
        if (instance.enabled !== "enabled") continue;

        const validation = validateConfigAgainstSchema(instance.config, newConfigSchema);
        if (!validation.valid) {
          failingInstances.push(
            `instance '${instance.id}' (tenant '${instance.tenant_id}'): ${validation.errors.join("; ")}`
          );
        }
      }

      if (failingInstances.length > 0) {
        throw new ConfigMigrationRequiredError(
          `Upgrade to '${toVersion}' blocked: ${failingInstances.length} active instance(s) have configs that ` +
            `are incompatible with the new configSchema. Migrate configs first, then retry. ` +
            `Affected: ${failingInstances.slice(0, 5).join("; ")}${failingInstances.length > 5 ? " …" : ""}`,
          { fieldErrors: { instances: failingInstances } }
        );
      }

      // Step 1: Pre-register new version hooks as 'staged' (not yet in active chain).
      for (const instance of allInstances) {
        if (instance.enabled === "enabled") {
          const hookData = hookService.buildHookDataFromManifest(
            stagedPlugin.id,
            instance.id,
            instance.tenant_id,
            stagedPlugin.manifest
          );
          await hookRepo.createMany(hookData.map((h) => ({ ...h, state: "staged" as const })));
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

      // W5/W10 fix: await the drain asynchronously. The promise resolves either
      // when the Execution Service calls /drain-complete (signalDrainComplete)
      // or after the 62s fallback timeout — whichever comes first.
      // This releases the event loop between ticks and does not block other requests.
      await waitForDrain(manifestId, 62_000);

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

      // W5/W10 fix: same async drain pattern as upgrade.
      await waitForDrain(manifestId, 62_000);

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

    signalDrainComplete(manifestId: string): void {
      const resolve = drainResolvers.get(manifestId);
      if (resolve !== undefined) {
        logger.info("Drain-complete callback received — unblocking version swap", { manifestId });
        drainResolvers.delete(manifestId);
        resolve();
      } else {
        // No upgrade in flight for this manifestId — log and ignore.
        logger.warn("drain-complete received but no pending upgrade found", { manifestId });
      }
    },
  };
}
