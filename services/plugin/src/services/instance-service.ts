import { createHash } from "node:crypto";
import Ajv, { type ValidateFunction } from "ajv";
import type pg from "pg";
import type { Logger, EventPublisher } from "@oneplatform/core";
import type { InstanceRepository } from "../repositories/instance-repository.js";
import type { HookRepository } from "../repositories/hook-repository.js";
import type { PluginRepository } from "../repositories/plugin-repository.js";
import type { ConnectorRegistrationService } from "./connector-registration-service.js";
import type { HookService } from "./hook-service.js";
import type { InstanceRow } from "../repositories/types.js";
import {
  PluginNotFoundError,
  InstanceNotFoundError,
  PluginNotActiveError,
  ConnectorRegistrationFailedError,
  ConfigValidationFailedError,
} from "./errors.js";

// ---------------------------------------------------------------------------
// Shared Ajv instance (v6 Draft-07) — compiled schemas are cached internally
// so repeated calls for the same schema pay the compilation cost only once.
//
// allErrors: true — collect every violation in a single pass rather than
// stopping at the first, so the caller receives a complete error list.
//
// useDefaults: false — we intentionally do not mutate the caller's config
// object; defaults must be applied explicitly by the plugin itself.
// ---------------------------------------------------------------------------
const ajv = new Ajv({ allErrors: true, useDefaults: false });

// Bounded cache for compiled Ajv validators keyed by a hash of the schema
// JSON. This prevents unbounded memory growth from ajv.compile() creating a
// new internal cache entry for each distinct schema object.
const MAX_VALIDATOR_CACHE_SIZE = 500;
const validatorCache = new Map<string, ValidateFunction>();

function getOrCompileValidator(schema: Record<string, unknown>): ValidateFunction {
  const schemaJson = JSON.stringify(schema);
  const hash = createHash("sha256").update(schemaJson).digest("hex");
  let validator = validatorCache.get(hash);
  if (validator === undefined) {
    // Evict oldest entries if cache is full (simple FIFO eviction)
    if (validatorCache.size >= MAX_VALIDATOR_CACHE_SIZE) {
      const firstKey = validatorCache.keys().next().value as string;
      validatorCache.delete(firstKey);
    }
    validator = ajv.compile(schema);
    validatorCache.set(hash, validator);
  }
  return validator;
}

// ---------------------------------------------------------------------------
// Validate a plugin instance config object against the plugin manifest's
// configSchema (JSON Schema Draft-07).
//
// Returns a structured result rather than throwing so the caller controls how
// to surface validation failures (currently via ConfigValidationFailedError).
// ---------------------------------------------------------------------------
function validateConfigAgainstSchema(
  config: Record<string, unknown>,
  schema: Record<string, unknown>
): { valid: boolean; errors: string[] } {
  // Use a bounded cache to avoid unbounded Ajv internal cache growth.
  const validate = getOrCompileValidator(schema);
  const valid = validate(config) as boolean;

  if (valid) {
    return { valid: true, errors: [] };
  }

  // Map Ajv ErrorObjects to human-readable messages.  dataPath is empty for
  // root-level errors (e.g. required), so we prefix with "config" to give
  // users a stable anchor when reading the error alongside the request body.
  const errors = (validate.errors ?? []).map((err) => {
    const path = err.dataPath ? `config${err.dataPath}` : "config";
    return `${path}: ${err.message ?? err.keyword}`;
  });

  return { valid: false, errors };
}

// ---------------------------------------------------------------------------
// InstanceService — per-tenant plugin instance lifecycle (spec §6)
// ---------------------------------------------------------------------------

export interface InstanceServiceDeps {
  pool: pg.Pool;
  pluginRepo: PluginRepository;
  instanceRepo: InstanceRepository;
  hookRepo: HookRepository;
  connectorService: ConnectorRegistrationService;
  hookService: HookService;
  executionServiceUrl: string;
  serviceToken: string;
  drainGraceSeconds: number;
  logger: Logger;
  eventPublisher: EventPublisher;
}

export interface InstanceService {
  createInstance(params: {
    pluginIdOrManifestId: string;
    tenantId: string;
    displayName: string;
    config: Record<string, unknown>;
    createdBy: string;
  }): Promise<InstanceRow>;

  patchInstance(params: {
    instanceId: string;
    tenantId: string;
    updatedBy: string;
    displayName?: string;
    config?: Record<string, unknown>;
    enabled?: boolean;
  }): Promise<InstanceRow>;

  listInstances(params: {
    pluginIdOrManifestId: string;
    tenantId?: string;
    isPlatformAdmin: boolean;
  }): Promise<InstanceRow[]>;

  getInstance(instanceId: string, tenantId: string): Promise<InstanceRow>;
}

export function createInstanceService(deps: InstanceServiceDeps): InstanceService {
  const {
    pool,
    pluginRepo,
    instanceRepo,
    hookRepo,
    connectorService,
    hookService,
    executionServiceUrl,
    serviceToken,
    drainGraceSeconds,
    logger,
    eventPublisher,
  } = deps;

  async function enableInstance(instance: InstanceRow, pluginId: string): Promise<InstanceRow> {
    const plugin = await pluginRepo.findById(pluginId);
    if (plugin === null) {
      throw new PluginNotFoundError(`Plugin ${pluginId} not found`);
    }
    if (plugin.status !== "active") {
      throw new PluginNotActiveError(
        `Plugin '${plugin.manifest_id}' must be in active status to enable instances`
      );
    }

    // Build and insert hook rows, then activate them — all in one transaction
    // so that a connector registration failure can roll everything back (spec §6.4).
    const hookData = hookService.buildHookDataFromManifest(
      plugin.id,
      instance.id,
      instance.tenant_id,
      plugin.manifest
    );

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Create hook rows in inactive state, then immediately activate them.
      // Pass the transactional client so hooks are enrolled in the same
      // transaction and roll back with it on failure (B1 fix — prevents orphans).
      if (hookData.length > 0) {
        await hookRepo.createMany(hookData, client);
        await hookRepo.updateStateByInstance(client, instance.id, "active");
      }

      // Mark instance enabled.
      const updated = await client.query<InstanceRow>(
        `UPDATE plugin.instances
            SET enabled = 'enabled', updated_at = now()
          WHERE id = $1
        RETURNING id, plugin_manifest_id, plugin_id, tenant_id, display_name, config,
                  enabled, created_at, created_by, updated_at, updated_by, deleted_at`,
        [instance.id]
      );

      const updatedInstance = updated.rows[0];
      if (updatedInstance === undefined) {
        throw new Error(`Failed to update instance ${instance.id} to enabled`);
      }

      // Attempt connector registration outside the transaction.
      // On failure: roll back the transaction so instance stays disabled.
      if (plugin.type === "connector") {
        try {
          await connectorService.register({
            pluginId: plugin.manifest_id,
            instanceId: instance.id,
            tenantId: instance.tenant_id,
            displayName: instance.display_name,
            version: plugin.version,
            metadata:
              (
                (plugin.manifest as Record<string, unknown>)[
                  "connectorMetadata"
                ] as Record<string, unknown>
              ) ?? {},
          });
        } catch (err) {
          await client.query("ROLLBACK");
          if (err instanceof ConnectorRegistrationFailedError) throw err;
          throw new ConnectorRegistrationFailedError(
            `Connector registration failed: ${String(err)}`
          );
        }
      }

      await client.query("COMMIT");
      return updatedInstance;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async function disableInstance(
    instance: InstanceRow,
    updatedBy: string
  ): Promise<InstanceRow> {
    // Step 1: Mark as disabling.
    await instanceRepo.update(instance.id, { enabled: "disabling", updated_by: updatedBy });

    // Step 2: Signal drain to Execution Service (fire-and-forget with 60s grace).
    try {
      await fetch(`${executionServiceUrl}/internal/execution/plugin-drain`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Service-Token": serviceToken,
        },
        body: JSON.stringify({
          pluginId: instance.plugin_manifest_id,
          tenantId: instance.tenant_id,
          instanceId: instance.id,
          gracePeriodMs: drainGraceSeconds * 1000,
        }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch (err) {
      logger.warn("Drain signal to Execution Service failed (proceeding)", {
        instanceId: instance.id,
        error: String(err),
      });
    }

    // Step 3: Disable all hooks for this instance.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await hookRepo.updateStateByInstance(client, instance.id, "disabled");
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }

    // Fetch the plugin to check type for connector deregistration.
    const plugin = await pluginRepo.findById(instance.plugin_id);

    // Step 4: Deregister connector (best-effort, spec §9.2).
    if (plugin !== null && plugin.type === "connector") {
      await connectorService.deregisterInstance(instance.id);
    }

    // Step 5: Cache invalidation signal.
    const currentVersion = plugin?.version ?? "";
    try {
      await fetch(`${executionServiceUrl}/internal/execution/plugin-cache-invalidate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Service-Token": serviceToken,
        },
        body: JSON.stringify({
          pluginId: instance.plugin_manifest_id,
          tenantId: instance.tenant_id,
          newBundleVersion: currentVersion,
        }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch (err) {
      logger.warn("Cache invalidation signal failed (non-fatal)", {
        instanceId: instance.id,
        error: String(err),
      });
    }

    // Step 6: Mark disabled.
    const disabled = await instanceRepo.update(instance.id, {
      enabled: "disabled",
      updated_by: updatedBy,
    });

    if (disabled === null) {
      throw new InstanceNotFoundError(
        `Instance ${instance.id} disappeared during disable transition`
      );
    }

    return disabled;
  }

  return {
    async createInstance({ pluginIdOrManifestId, tenantId, displayName, config, createdBy }) {
      // Resolve plugin — must be active.
      // First try by ID, then fall back to manifest ID. Only catch errors
      // that indicate the input is not a UUID (findById may throw a
      // pg invalid_text_representation error for non-UUID strings).
      // Re-throw actual infrastructure failures (connection errors, etc.).
      let plugin: Awaited<ReturnType<typeof pluginRepo.findById>> | null = null;
      try {
        plugin = await pluginRepo.findById(pluginIdOrManifestId);
      } catch (err: unknown) {
        // PostgreSQL error code 22P02 = invalid_text_representation (not a valid UUID)
        const pgCode = (err as { code?: string }).code;
        if (pgCode !== "22P02") throw err;
      }
      if (plugin === null) {
        plugin = await pluginRepo.findActiveByManifestId(pluginIdOrManifestId);
      }
      if (plugin === null) {
        throw new PluginNotFoundError(`Plugin '${pluginIdOrManifestId}' not found`);
      }
      if (plugin.status !== "active") {
        throw new PluginNotActiveError(
          `Plugin '${plugin.manifest_id}' must be in active status to create instances`
        );
      }

      // Validate config against the manifest's configSchema before persisting (B5 fix).
      const configSchema = plugin.manifest.configSchema;
      const validation = validateConfigAgainstSchema(config, configSchema);
      if (!validation.valid) {
        throw new ConfigValidationFailedError(
          `Instance config does not match plugin configSchema: ${validation.errors.join("; ")}`,
          { fieldErrors: { config: validation.errors } }
        );
      }

      // Insert instance row in disabled state first (atomicity guard, spec §6.4).
      const instance = await instanceRepo.create({
        plugin_manifest_id: plugin.manifest_id,
        plugin_id: plugin.id,
        tenant_id: tenantId,
        display_name: displayName,
        config,
        enabled: "disabled",
        created_by: createdBy,
      });

      // Enable the instance (inserts hooks, registers connector).
      const enabled = await enableInstance(instance, plugin.id);

      await eventPublisher.publish({
        eventType: "plugin.enabled",
        eventVersion: "1.0.0",
        tenantId,
        actor: { type: "user", id: createdBy },
        data: {
          pluginId: plugin.manifest_id,
          pluginName: plugin.name,
          tenantId,
          instanceId: instance.id,
          enabledBy: createdBy,
        },
      });

      return enabled;
    },

    async patchInstance({ instanceId, tenantId, updatedBy, displayName, config, enabled }) {
      const instance = await instanceRepo.findByIdAndTenant(instanceId, tenantId);
      if (instance === null) {
        throw new InstanceNotFoundError(`Instance '${instanceId}' not found`);
      }

      // Validate new config against the plugin's configSchema before persisting (B5 fix).
      if (config !== undefined) {
        const plugin = await pluginRepo.findById(instance.plugin_id);
        if (plugin !== null) {
          const configSchema = plugin.manifest.configSchema;
          const validation = validateConfigAgainstSchema(config, configSchema);
          if (!validation.valid) {
            throw new ConfigValidationFailedError(
              `Instance config does not match plugin configSchema: ${validation.errors.join("; ")}`,
              { fieldErrors: { config: validation.errors } }
            );
          }
        }
        await instanceRepo.update(instanceId, { config, updated_by: updatedBy });
      }
      if (displayName !== undefined) {
        await instanceRepo.update(instanceId, {
          display_name: displayName,
          updated_by: updatedBy,
        });
      }

      if (enabled === false) {
        const result = await disableInstance(instance, updatedBy);
        await eventPublisher.publish({
          eventType: "plugin.disabled",
          eventVersion: "1.0.0",
          tenantId,
          actor: { type: "user", id: updatedBy },
          data: {
            pluginId: instance.plugin_manifest_id,
            tenantId,
            instanceId,
            disabledBy: updatedBy,
          },
        });
        return result;
      }

      if (enabled === true && instance.enabled !== "enabled") {
        const plugin = await pluginRepo.findById(instance.plugin_id);
        if (plugin === null) {
          throw new PluginNotFoundError(`Plugin ${instance.plugin_id} not found`);
        }
        const freshInstance = await instanceRepo.findByIdAndTenant(instanceId, tenantId);
        if (freshInstance === null) {
          throw new InstanceNotFoundError(`Instance '${instanceId}' not found`);
        }
        const result = await enableInstance(freshInstance, plugin.id);
        await eventPublisher.publish({
          eventType: "plugin.enabled",
          eventVersion: "1.0.0",
          tenantId,
          actor: { type: "user", id: updatedBy },
          data: {
            pluginId: instance.plugin_manifest_id,
            tenantId,
            instanceId,
            enabledBy: updatedBy,
          },
        });
        return result;
      }

      const refreshed = await instanceRepo.findByIdAndTenant(instanceId, tenantId);
      if (refreshed === null) {
        throw new InstanceNotFoundError(`Instance '${instanceId}' not found after update`);
      }
      return refreshed;
    },

    async listInstances({ pluginIdOrManifestId, tenantId, isPlatformAdmin }) {
      // Resolve manifest_id from UUID or manifest_id string.
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        pluginIdOrManifestId
      );

      let manifestId = pluginIdOrManifestId;
      if (isUuid) {
        const plugin = await pluginRepo.findById(pluginIdOrManifestId);
        if (plugin === null) {
          throw new PluginNotFoundError(`Plugin '${pluginIdOrManifestId}' not found`);
        }
        manifestId = plugin.manifest_id;
      }

      return instanceRepo.findByPluginManifestId(
        manifestId,
        ...(isPlatformAdmin
          ? [{}]
          : [{ tenantId }]) as [{ tenantId?: string; includeDeleted?: boolean }]
      );
    },

    async getInstance(instanceId: string, tenantId: string): Promise<InstanceRow> {
      const instance = await instanceRepo.findByIdAndTenant(instanceId, tenantId);
      if (instance === null) {
        throw new InstanceNotFoundError(`Instance '${instanceId}' not found`);
      }
      return instance;
    },
  };
}
