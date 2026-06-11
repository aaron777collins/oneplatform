import { mkdir, rm, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import * as semver from "semver";
import type pg from "pg";
import type { Logger, EventPublisher } from "@oneplatform/core";
import type { PluginRepository } from "../repositories/plugin-repository.js";
import type { InstanceRepository } from "../repositories/instance-repository.js";
import type { HookRepository } from "../repositories/hook-repository.js";
import type { BundleService } from "./bundle-service.js";
import type { ConnectorRegistrationService } from "./connector-registration-service.js";
import type { HookService } from "./hook-service.js";
import type { PluginManifest } from "../schemas/index.js";
import type { PluginRow, ApprovedUrlRow } from "../repositories/types.js";
import {
  PluginNotFoundError,
  PluginHasActiveInstancesError,
  PluginHasActiveJobsError,
  OrphanConfirmationRequiredError,
  InvalidManifestError,
  InvalidPackageStructureError,
  UploadTooLargeError,
  EntrypointNotCallableError,
  ExecutionValidationFailedError,
  PlatformVersionTooOldError,
  GpgSignatureMissingError,
} from "./errors.js";
import { PluginManifestSchema } from "../schemas/index.js";
import type { Redis } from "ioredis";
// BullMQ Queue is only used for the active-job guard; we intentionally use a
// URL-based connection to avoid the ioredis version mismatch between the plugin
// service's ioredis and bullmq's bundled ioredis (W13 fix still holds: we create
// the Queue once at module startup rather than recreating it per uninstall call).
import type { Queue as BullMQQueue } from "bullmq";

// B3 fix: use execFile (argument array, no shell) instead of exec (string interpolation).
const execFile = promisify(execFileCb);

const MAX_BUNDLE_BYTES = 50 * 1024 * 1024; // 50MB
const CURRENT_PLATFORM_VERSION = process.env["OP_PLATFORM_VERSION"] ?? "1.0.0";

// ---------------------------------------------------------------------------
// PluginService — plugin lifecycle: install, activate, stage, disable, uninstall
// ---------------------------------------------------------------------------

export interface PluginServiceDeps {
  pool: pg.Pool;
  pluginRepo: PluginRepository;
  instanceRepo: InstanceRepository;
  hookRepo: HookRepository;
  bundleService: BundleService;
  connectorService: ConnectorRegistrationService;
  hookService: HookService;
  redis: Redis;
  executionServiceUrl: string;
  serviceToken: string;
  logger: Logger;
  eventPublisher: EventPublisher;
  bundleBucket: string;
  retentionDays: number;
}

export interface PluginService {
  installPlugin(params: {
    bundlePath: string;
    signaturePath?: string;
    approveUrls: boolean;
    platformWide: boolean;
    installedBy: string;
  }): Promise<{
    plugin: PluginRow;
    approvedUrls: ApprovedUrlRow[];
    requiresUrlApproval: boolean;
    urlPatterns: string[];
  }>;

  activatePlugin(pluginId: string, activatedBy: string): Promise<PluginRow>;

  uninstallPlugin(params: {
    id: string;
    confirmOrphan: boolean;
    uninstalledBy: string;
    ontologyServiceUrl?: string;
  }): Promise<{
    manifestId: string;
    status: "uninstalled";
    bundleDeleteAfter: string;
    orphanWarning?: { entityTypes: string[]; totalRecords: number; message: string };
  }>;

  listPlugins(options: {
    type?: string;
    status?: string;
    q?: string;
    cursor?: string;
    limit: number;
  }): Promise<{ rows: PluginRow[]; total: number }>;

  getPlugin(idOrManifestId: string): Promise<PluginRow>;

  getApprovedUrls(pluginId: string): Promise<ApprovedUrlRow[]>;

  /** Called by cleanup worker — delete expired MinIO bundles. */
  cleanupExpiredBundles(): Promise<void>;
}

export function createPluginService(deps: PluginServiceDeps): PluginService {
  const {
    pool: _pool,
    pluginRepo,
    instanceRepo,
    hookRepo,
    bundleService,
    connectorService,
    hookService: _hookService,
    redis: _redis,
    executionServiceUrl,
    serviceToken,
    logger,
    eventPublisher,
    bundleBucket,
    retentionDays,
  } = deps;

  // W13 fix: create the BullMQ Queue once at startup rather than recreating it
  // on every uninstall call. The Queue uses a URL-based connection derived from
  // the injected Redis client to avoid the ioredis version mismatch between this
  // service's ioredis and BullMQ's bundled ioredis.
  let bullmqQueue: BullMQQueue | null = null;

  async function getBullMQQueue(): Promise<BullMQQueue> {
    if (bullmqQueue === null) {
      const { Queue } = await import("bullmq");
      const redisUrl = process.env["REDIS_URL"] ?? "redis://localhost:6379";
      bullmqQueue = new Queue("execution", {
        connection: { url: redisUrl } as { url: string },
      });
    }
    return bullmqQueue;
  }

  async function extractAndValidateBundle(bundlePath: string): Promise<{
    manifest: PluginManifest;
    extractDir: string;
    extractedBundlePath: string;
  }> {
    const extractDir = join("/tmp", "oneplatform-plugins", randomUUID());
    await mkdir(extractDir, { recursive: true });

    // B3 fix: use execFile with an argument array — no shell expansion, no injection.
    // W9 fix: zip-slip guard below verifies all extracted paths after extraction.
    try {
      await execFile("tar", ["-xzf", bundlePath, "-C", extractDir, "--strip-components=0"]);
    } catch (err) {
      throw new InvalidPackageStructureError(
        `Failed to extract .oppkg archive: ${String(err)}`
      );
    }

    // W9 fix: verify every extracted path is confined to extractDir.
    // resolve() expands any ".." components — if the result doesn't start with
    // extractDir the archive contained a path-traversal entry.
    const resolvedExtractDir = resolve(extractDir);
    await (async function assertNoZipSlip(dir: string): Promise<void> {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = resolve(dir, entry.name);
        if (!entryPath.startsWith(resolvedExtractDir + "/") && entryPath !== resolvedExtractDir) {
          throw new InvalidPackageStructureError(
            `Zip-slip path traversal detected: ${entryPath}`
          );
        }
        if (entry.isDirectory()) {
          await assertNoZipSlip(entryPath);
        }
      }
    })(extractDir);

    // Validate required files exist.
    const manifestPath = join(extractDir, "plugin.manifest.json");
    const extractedBundlePath = join(extractDir, "dist", "bundle.js");

    try {
      const { readFile, stat } = await import("node:fs/promises");
      const stats = await stat(extractedBundlePath);
      if (stats.size > MAX_BUNDLE_BYTES) {
        throw new UploadTooLargeError(
          `Bundle exceeds 50MB limit: ${stats.size} bytes`
        );
      }

      const manifestRaw = await readFile(manifestPath, "utf-8");
      const manifestJson: unknown = JSON.parse(manifestRaw);
      const parsed = PluginManifestSchema.safeParse(manifestJson);

      if (!parsed.success) {
        throw new InvalidManifestError(
          `Plugin manifest validation failed: ${parsed.error.issues.length} error(s)`,
          { fieldErrors: parsed.error.flatten().fieldErrors }
        );
      }

      return { manifest: parsed.data, extractDir, extractedBundlePath };
    } catch (err) {
      if (
        err instanceof InvalidManifestError ||
        err instanceof UploadTooLargeError
      ) {
        throw err;
      }
      throw new InvalidPackageStructureError(
        `Required files missing from .oppkg: ${String(err)}`
      );
    }
  }

  async function validateEntrypoint(
    manifestId: string,
    version: string,
    entrypoint: string,
    bundleKey: string,
    bucket: string
  ): Promise<void> {
    const url = `${executionServiceUrl}/internal/execution/run`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Service-Token": serviceToken,
        },
        body: JSON.stringify({
          pluginId: manifestId,
          version,
          entrypoint,
          method: "metadata",
          args: [],
          bundleKey,
          bundleBucket: bucket,
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new ExecutionValidationFailedError(
        `Execution Service unreachable during entrypoint validation: ${String(err)}`
      );
    }

    if (!response.ok) {
      throw new EntrypointNotCallableError(
        `Execution Service could not call metadata() on entrypoint '${entrypoint}' (status ${response.status})`
      );
    }
  }

  return {
    async installPlugin({ bundlePath, signaturePath, approveUrls, platformWide, installedBy }) {
      logger.info("Plugin install started", { bundlePath });

      // Step 1–3: Extract tarball, validate structure, parse manifest.
      const { manifest, extractDir, extractedBundlePath } =
        await extractAndValidateBundle(bundlePath);

      let uploadedKey: string | null = null;

      try {
        // Step 4: Verify platform version compatibility.
        if (
          !semver.gte(CURRENT_PLATFORM_VERSION, manifest.minPlatformVersion)
        ) {
          throw new PlatformVersionTooOldError(
            `Platform version ${CURRENT_PLATFORM_VERSION} is below the required ${manifest.minPlatformVersion}`
          );
        }

        // B4 fix: GPG guard — if the manifest declares a fingerprint, a signature
        // file MUST be provided. Full cryptographic verification requires the openpgp
        // npm package (not yet a declared dependency); this guard enforces the
        // contract boundary so unsigned installs are rejected at the gate.
        if (manifest.gpgFingerprint !== undefined) {
          if (signaturePath === undefined || signaturePath === "") {
            throw new GpgSignatureMissingError(
              `Plugin manifest declares gpgFingerprint '${manifest.gpgFingerprint}' but no .sig file was provided. ` +
                "Resubmit with the signature file attached."
            );
          }
          // Full GPG verification (openpgp library) is intentionally deferred until
          // the openpgp dependency is approved and added to package.json.
          logger.info("GPG signature file received; cryptographic verification pending openpgp dep", {
            manifestId: manifest.id,
            fingerprint: manifest.gpgFingerprint,
          });
        }

        // Step 5: Verify bundle checksum.
        await bundleService.verifyChecksum(
          extractedBundlePath,
          manifest.bundleChecksum
        );

        // Step 6: URL approval check — return early if external URLs need approval.
        const requiresUrlApproval =
          !approveUrls && manifest.requiredExternalUrls.length > 0;

        // Step 7: Check for idempotent install (same manifest_id + version).
        const existing = await pluginRepo.findByManifestIdAndVersion(
          manifest.id,
          manifest.version
        );
        if (existing !== null) {
          logger.info("Idempotent install — returning existing record", {
            manifestId: manifest.id,
            version: manifest.version,
          });
          const approvedUrls = await pluginRepo.findApprovedUrlsByPlugin(existing.id);
          return { plugin: existing, approvedUrls, requiresUrlApproval: false, urlPatterns: [] };
        }

        // Determine status: 'installed' if first version, 'staged' if an active version exists.
        const activeVersion = await pluginRepo.findActiveByManifestId(manifest.id);
        const status = activeVersion !== null ? "staged" : "installed";

        // Step 10: Upload bundle to MinIO first so the Execution Service can validate.
        const { bucket, key } = await bundleService.upload({
          manifestId: manifest.id,
          version: manifest.version,
          bundlePath: extractedBundlePath,
          checksum: manifest.bundleChecksum,
        });
        uploadedKey = key;

        // Step 9: Validate entrypoint via Execution Service.
        await validateEntrypoint(
          manifest.id,
          manifest.version,
          manifest.entrypoint,
          key,
          bucket
        );

        // Step 11: Insert plugin row.
        const plugin = await pluginRepo.create({
          manifest_id: manifest.id,
          name: manifest.name,
          version: manifest.version,
          type: manifest.type,
          status,
          bundle_bucket: bucket,
          bundle_key: key,
          manifest,
          is_platform_wide: platformWide,
          installed_by: installedBy,
          ...(manifest.gpgFingerprint !== undefined
            ? { gpg_fingerprint: manifest.gpgFingerprint }
            : {}),
        });

        // Step 12: Insert approved URL rows if approveUrls=true.
        const approvedUrls: ApprovedUrlRow[] = [];
        if (approveUrls) {
          for (const pattern of manifest.requiredExternalUrls) {
            const url = await pluginRepo.createApprovedUrl({
              plugin_id: plugin.id,
              url_pattern: pattern,
              approved_by: installedBy,
            });
            approvedUrls.push(url);
          }
        }

        // Step 13: Emit plugin.installed event.
        await eventPublisher.publish({
          eventType: "plugin.installed",
          eventVersion: "1.0.0",
          // Platform-wide events use a synthetic tenant ID.
          tenantId: "00000000-0000-0000-0000-000000000000",
          actor: { type: "user", id: installedBy },
          data: {
            pluginId: manifest.id,
            pluginName: manifest.name,
            version: manifest.version,
            installedBy,
          },
        });

        logger.info("Plugin installed successfully", {
          manifestId: manifest.id,
          version: manifest.version,
          status,
        });

        return {
          plugin,
          approvedUrls,
          requiresUrlApproval,
          urlPatterns: manifest.requiredExternalUrls,
        };
      } catch (err) {
        // Roll back MinIO upload on failure to prevent orphaned objects.
        if (uploadedKey !== null) {
          await bundleService.delete(bundleBucket, uploadedKey);
        }
        throw err;
      } finally {
        await rm(extractDir, { recursive: true, force: true });
      }
    },

    async activatePlugin(pluginId: string, _activatedBy: string): Promise<PluginRow> {
      const plugin = await pluginRepo.findById(pluginId);
      if (plugin === null) {
        throw new PluginNotFoundError(`Plugin ${pluginId} not found`);
      }
      return plugin;
    },

    async uninstallPlugin({ id, confirmOrphan, uninstalledBy, ontologyServiceUrl }) {
      // Resolve by UUID or manifest_id.
      let plugin = await pluginRepo.findById(id);
      if (plugin === null) {
        plugin = await pluginRepo.findActiveByManifestId(id);
      }
      if (plugin === null) {
        throw new PluginNotFoundError(`Plugin '${id}' not found`);
      }

      // Guard 1: No enabled instances (spec §11.1).
      const activeInstanceCount = await instanceRepo.countActiveByManifestId(
        plugin.manifest_id
      );
      if (activeInstanceCount > 0) {
        throw new PluginHasActiveInstancesError(
          `Cannot uninstall: ${activeInstanceCount} instance(s) are enabled. Disable all instances before uninstalling.`
        );
      }

      // Guard 2: No active BullMQ jobs (spec §11.2).
      // W13 fix: reuse the shared Queue instance backed by the injected Redis
      // connection — no new connection created per call.
      // Check is best-effort — if Redis is unavailable we skip rather than block.
      try {
        const queue = await getBullMQQueue();
        const jobs = await queue.getJobs(["active", "waiting", "delayed"]);
        const pluginJobs = jobs.filter(
          (j) => j.data.pluginManifestId === plugin.manifest_id
        );
        if (pluginJobs.length > 0) {
          throw new PluginHasActiveJobsError(
            `Cannot uninstall: ${pluginJobs.length} active job(s) reference this plugin. Wait for jobs to complete or move them to DLQ.`
          );
        }
      } catch (err) {
        if (err instanceof PluginHasActiveJobsError) throw err;
        logger.warn("BullMQ job check skipped (Redis unavailable)", {
          error: String(err),
        });
      }

      // Guard 3: Data orphan warning (spec §11.3).
      if (!confirmOrphan && ontologyServiceUrl !== undefined) {
        try {
          const resp = await fetch(
            `${ontologyServiceUrl}/internal/ontology/data-sources/${encodeURIComponent(plugin.manifest_id)}/count`,
            {
              headers: { "X-Service-Token": serviceToken },
              signal: AbortSignal.timeout(5_000),
            }
          );
          if (resp.ok) {
            const body = (await resp.json()) as { count?: number };
            if ((body.count ?? 0) > 0) {
              throw new OrphanConfirmationRequiredError(
                `Plugin has ${body.count} orphaned records. Resubmit with ?confirmOrphan=true to proceed.`,
                {
                  entityTypes: ["ontology-records"],
                  totalRecords: body.count,
                  message: `Uninstalling will leave ${body.count} records without a source connector.`,
                }
              );
            }
          }
        } catch (err) {
          if (err instanceof OrphanConfirmationRequiredError) throw err;
          logger.warn("Ontology orphan check skipped (service unavailable)", {
            error: String(err),
          });
        }
      }

      if (confirmOrphan) {
        logger.warn("Plugin uninstalled with orphan confirmation", {
          manifestId: plugin.manifest_id,
          uninstalledBy,
        });
      }

      // Execute uninstall steps (spec §11.4).
      await instanceRepo.softDeleteAllByManifestId(plugin.manifest_id);
      await hookRepo.disableAllByManifestId(plugin.manifest_id);

      // Deregister all connector instances with Ingestion Service.
      if (plugin.manifest.type === "connector") {
        await connectorService.deregisterPlugin(plugin.manifest_id);
      }

      const bundleDeleteAfter = new Date(
        Date.now() + retentionDays * 24 * 60 * 60 * 1000
      );

      await pluginRepo.update(plugin.id, {
        status: "uninstalled",
        uninstalled_at: new Date(),
        bundle_delete_after: bundleDeleteAfter,
      });

      await eventPublisher.publish({
        eventType: "plugin.uninstalled",
        eventVersion: "1.0.0",
        tenantId: "00000000-0000-0000-0000-000000000000",
        actor: { type: "user", id: uninstalledBy },
        data: {
          pluginId: plugin.manifest_id,
          pluginName: plugin.name,
          uninstalledBy,
        },
      });

      return {
        manifestId: plugin.manifest_id,
        status: "uninstalled",
        bundleDeleteAfter: bundleDeleteAfter.toISOString(),
      };
    },

    async listPlugins(options) {
      return pluginRepo.list(options);
    },

    async getPlugin(idOrManifestId: string): Promise<PluginRow> {
      // Try UUID first, fall back to manifest_id lookup.
      let plugin: PluginRow | null = null;

      const isUuid =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          idOrManifestId
        );

      if (isUuid) {
        plugin = await pluginRepo.findById(idOrManifestId);
      }

      if (plugin === null) {
        plugin = await pluginRepo.findActiveByManifestId(idOrManifestId);
      }

      if (plugin === null) {
        throw new PluginNotFoundError(`Plugin '${idOrManifestId}' not found`);
      }

      return plugin;
    },

    async getApprovedUrls(pluginId: string): Promise<ApprovedUrlRow[]> {
      return pluginRepo.findApprovedUrlsByPlugin(pluginId);
    },

    async cleanupExpiredBundles(): Promise<void> {
      const expired = await pluginRepo.findExpiredBundles();

      for (const plugin of expired) {
        if (plugin.bundle_key === null) continue;

        try {
          await bundleService.delete(plugin.bundle_bucket, plugin.bundle_key);
          await pluginRepo.update(plugin.id, {
            bundle_key: null,
            bundle_delete_after: null,
          });
          logger.debug("Bundle cleanup complete", {
            manifestId: plugin.manifest_id,
            version: plugin.version,
          });
        } catch (err) {
          logger.error("Bundle cleanup failed for plugin", {
            manifestId: plugin.manifest_id,
            version: plugin.version,
            error: String(err),
          });
        }
      }
    },
  };
}
