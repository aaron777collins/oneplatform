import type { Logger } from "@oneplatform/core";
import type { Redis } from "ioredis";
import type pg from "pg";
import type { AppRepository } from "../repositories/app-repository.js";
import type { VersionRepository } from "../repositories/version-repository.js";
import type { DeploymentRepository } from "../repositories/deployment-repository.js";
import type { PermissionRepository } from "../repositories/permission-repository.js";
import type { BuildRow } from "../repositories/types.js";
import {
  AppNotFoundError,
  AppBuildInProgressError,
  AppNoFilesError,
  AppCannotDeleteActiveBuildError,
} from "./errors.js";

// ---------------------------------------------------------------------------
// Build manifest shape (matches Execution Service response + MinIO artifact)
// Design spec §5.3
// ---------------------------------------------------------------------------

export interface BuildManifest {
  buildId:                string;
  appId:                  string;
  tenantId:               string;
  entrypoint:             string;
  bundleSizeBytes:        number;
  mapSizeBytes:           number;
  buildDurationMs:        number;
  externalDependencies:   string[];
  fileSnapshot:           Record<string, string>;  // { path: contentHash }
  builtAt:                string;
}

export interface EsbuildError {
  file:       string;
  line:       number;
  col:        number;
  text:       string;
  suggestion: string;
}

// Lines streamed back from the Execution Service
type ExecutionLogLine = {
  type: "log";
  level: "info" | "warn" | "error";
  message: string;
  ts: string;
};

type ExecutionResultLine =
  | {
      type: "result";
      status: "success";
      files: Record<string, string>;  // base64-encoded file content
    }
  | {
      type: "result";
      status: "failed";
      error: { message: string; errors: EsbuildError[] };
    };

type ExecutionLine = ExecutionLogLine | ExecutionResultLine;

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface BuildService {
  triggerBuild(
    tenantId: string,
    appId: string,
    userId: string,
    options: { preview: boolean }
  ): Promise<{ buildId: string; versionNumber: number; status: "pending"; logsStreamUrl: string }>;

  getBuild(tenantId: string, appId: string, buildId: string): Promise<BuildRow>;

  listBuilds(
    tenantId: string,
    appId: string,
    options?: { cursor?: string; limit?: number; filterStatus?: string }
  ): Promise<{ builds: BuildRow[]; nextCursor: string | null; total: number }>;

  deleteBuild(tenantId: string, appId: string, buildId: string): Promise<void>;

  // Called by the cleanup job — not a public API route
  runRetentionCleanup(retentionCount: number): Promise<void>;
}

export interface BuildServiceDeps {
  pool:                  pg.Pool;
  appRepo:               AppRepository;
  fileRepo:              VersionRepository;
  buildRepo:             DeploymentRepository;
  permRepo:              PermissionRepository;
  redis:                 Redis;
  executionServiceUrl:   string;
  logger:                Logger;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createBuildService(deps: BuildServiceDeps): BuildService {
  const {
    pool, appRepo, fileRepo, buildRepo, permRepo,
    redis, executionServiceUrl, logger,
  } = deps;

  // Acquire a Postgres transaction-scoped advisory lock keyed to the app ID.
  // This serialises concurrent build triggers for the same app without
  // requiring a distributed lock — the check + insert happen within one xact.
  async function withAppAdvisoryLock<T>(
    client: pg.PoolClient,
    appId: string,
    fn: () => Promise<T>
  ): Promise<T> {
    // pg_advisory_xact_lock is automatically released at transaction end
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      [appId]
    );
    return fn();
  }

  async function triggerBuild(
    tenantId: string,
    appId: string,
    userId: string,
    options: { preview: boolean }
  ): Promise<{ buildId: string; versionNumber: number; status: "pending"; logsStreamUrl: string }> {
    const app = await appRepo.findByTenantAndId(tenantId, appId);
    if (app === null) {
      throw new AppNotFoundError(`App "${appId}" not found.`, { appId, tenantId });
    }

    const client = await pool.connect();
    let build: BuildRow;
    try {
      await client.query("BEGIN");

      await withAppAdvisoryLock(client, appId, async () => {
        // One build at a time per app
        const inProgress = await buildRepo.countInProgress(appId);
        if (inProgress.count > 0) {
          throw new AppBuildInProgressError(
            `App "${appId}" already has a build in progress.`,
            { appId, activeBuildId: inProgress.buildId ?? undefined }
          );
        }

        const fileCount = await fileRepo.countByApp(appId);
        if (fileCount === 0) {
          throw new AppNoFilesError(
            `App "${appId}" has no files in the VFS. Add files before triggering a build.`,
            { appId }
          );
        }

        const versionNumber = await buildRepo.getNextVersionNumber(appId);

        build = await buildRepo.create({
          app_id:         appId,
          version_number: versionNumber,
          status:         "pending",
          built_by:       userId,
        });
      });

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    // build is set inside the lock callback; the TS compiler cannot prove it
    // so we re-fetch to satisfy the strict checker
    const createdBuild = await buildRepo.findById(build!.id);
    if (createdBuild === null) {
      throw new Error(`Build "${build!.id}" disappeared immediately after creation`);
    }

    // Dispatch the build job asynchronously so the HTTP response returns 202
    void dispatchBuild(app.tenant_id, appId, createdBuild, options.preview);

    return {
      buildId:        createdBuild.id,
      versionNumber:  createdBuild.version_number,
      status:         "pending",
      logsStreamUrl:  `/api/v1/apps/${appId}/builds/${createdBuild.id}/logs/stream`,
    };
  }

  // Dispatches the actual build job — fetches VFS files, calls Execution Service,
  // uploads artifacts, and updates the build record.
  async function dispatchBuild(
    tenantId: string,
    appId: string,
    build: BuildRow,
    preview: boolean
  ): Promise<void> {
    const LOG_KEY = `app:build-logs:${build.id}`;
    const LOG_CHANNEL = `app:build:${build.id}:log`;
    const startMs = Date.now();

    try {
      // Mark building
      await buildRepo.update(build.id, { status: "building" });

      // Assemble VFS file map
      const files = await fileRepo.getAllFilesForBuild(appId);
      const fileMap: Record<string, string> = {};
      const fileSnapshot: Record<string, string> = {};
      for (const f of files) {
        fileMap[f.path] = f.content;
      }

      // Also fetch content hashes for the build manifest snapshot
      const fileMeta = await fileRepo.listByApp(appId);
      for (const f of fileMeta) {
        fileSnapshot[f.path] = f.content_hash;
      }

      // Fetch non-secret env vars for esbuild define
      const envVarRows = await permRepo.listEnvVarsByApp(appId);
      const envVars: Record<string, string> = {};
      for (const ev of envVarRows) {
        if (!ev.is_secret) {
          envVars[ev.key] = ev.value;
        }
      }

      // Refresh app to get allowed_modules
      const app = await appRepo.findById(appId);
      if (app === null) {
        throw new Error(`App "${appId}" not found during build dispatch`);
      }

      const buildRequest = {
        executionType:  "app-build",
        appId,
        buildId:        build.id,
        files:          fileMap,
        entrypoint:     "/src/index.tsx",
        target:         "es2020",
        format:         "esm",
        allowedModules: app.allowed_modules,
        envVars,
        preview,
      };

      const payload = {
        executionType: "app-build",
        payload:       buildRequest,
        timeout:       30_000,
        streaming:     true,
      };

      const response = await fetch(`${executionServiceUrl}/internal/execution/execute`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(payload),
      });

      if (!response.ok || response.body === null) {
        throw new Error(`Execution Service returned ${response.status}`);
      }

      // Parse JSON-lines streaming response
      const logLines: string[] = [];
      let resultLine: ExecutionResultLine | undefined;

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.trim() === "") continue;
          let parsed: ExecutionLine;
          try {
            parsed = JSON.parse(line) as ExecutionLine;
          } catch {
            continue;
          }

          if (parsed.type === "log") {
            const logJson = JSON.stringify({
              level:   parsed.level,
              message: parsed.message,
              ts:      parsed.ts,
            });
            logLines.push(logJson);
            await redis.rpush(LOG_KEY, logJson);
            await redis.expire(LOG_KEY, 86_400);  // 24h TTL
            await redis.publish(LOG_CHANNEL, logJson);
          } else if (parsed.type === "result") {
            resultLine = parsed;
          }
        }
      }

      if (resultLine === undefined) {
        throw new Error("Execution Service stream ended without a result line");
      }

      if (resultLine.status === "success") {
        // Upload artifacts to MinIO
        const bundleKey = `${tenantId}/${appId}/builds/${build.id}`;
        const builtAt = new Date();
        const buildDurationMs = Date.now() - startMs;

        // Decode base64 artifacts and upload
        const bundleJs = Buffer.from(resultLine.files["bundle.js"] ?? "", "base64");
        const bundleMap = Buffer.from(resultLine.files["bundle.js.map"] ?? "", "base64");

        const manifest: BuildManifest = {
          buildId:              build.id,
          appId,
          tenantId,
          entrypoint:           "/src/index.tsx",
          bundleSizeBytes:      bundleJs.length,
          mapSizeBytes:         bundleMap.length,
          buildDurationMs,
          externalDependencies: [],
          fileSnapshot,
          builtAt:              builtAt.toISOString(),
        };

        // Upload is fire-and-forget within this function; errors mark the build failed
        await uploadArtifacts(tenantId, appId, build.id, {
          "bundle.js":          bundleJs,
          "bundle.js.map":      bundleMap,
          "build-manifest.json": Buffer.from(JSON.stringify(manifest, null, 2)),
        });

        await buildRepo.update(build.id, {
          status:         "success",
          bundle_path:    bundleKey,
          build_manifest: manifest as unknown as Record<string, unknown>,
          built_at:       builtAt,
        });

        // Notify preview SSE subscribers if this was a preview build
        if (preview) {
          await redis.publish(
            `app:preview-reload:${appId}`,
            JSON.stringify({ buildId: build.id, versionNumber: build.version_number })
          );
        }

        logger.info("Build succeeded", {
          tenantId, appId, buildId: build.id,
          versionNumber: build.version_number, buildDurationMs,
        });
      } else {
        await buildRepo.update(build.id, {
          status:        "failed",
          error_message: resultLine.error.message,
          error_detail:  resultLine.error.errors as unknown as Record<string, unknown>[],
        });

        logger.warn("Build failed", {
          tenantId, appId, buildId: build.id,
          errorMessage: resultLine.error.message,
        });
      }
    } catch (err) {
      await buildRepo.update(build.id, {
        status:        "failed",
        error_message: err instanceof Error ? err.message : String(err),
      });
      logger.error("Build dispatch error", {
        tenantId, appId, buildId: build.id,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      // Always send a done event so SSE subscribers can close
      const doneEvent = JSON.stringify({ type: "done", buildId: build.id });
      await redis.publish(LOG_CHANNEL, doneEvent);
    }
  }

  // Uploads build artifacts to MinIO. MinIO endpoint is configured via
  // MINIO_ENDPOINT env var. We use the S3-compatible PutObject API directly
  // via fetch to avoid adding an AWS SDK dependency.
  async function uploadArtifacts(
    tenantId: string,
    appId: string,
    buildId: string,
    files: Record<string, Buffer>
  ): Promise<void> {
    const endpoint = process.env["MINIO_ENDPOINT"] ?? "http://minio:9000";
    const bucket = "op-app-artifacts";

    await Promise.all(
      Object.entries(files).map(async ([filename, content]) => {
        const key = `${tenantId}/${appId}/builds/${buildId}/${filename}`;
        const url = `${endpoint}/${bucket}/${key}`;

        const response = await fetch(url, {
          method:  "PUT",
          headers: {
            "Content-Type":   filename.endsWith(".json") ? "application/json" : "application/javascript",
            "Content-Length": String(content.length),
          },
          body: content,
        });

        if (!response.ok) {
          throw new Error(
            `MinIO upload failed for ${filename}: ${response.status} ${response.statusText}`
          );
        }
      })
    );
  }

  async function getBuild(
    tenantId: string,
    appId: string,
    buildId: string
  ): Promise<BuildRow> {
    // Verify app ownership
    const app = await appRepo.findByTenantAndId(tenantId, appId);
    if (app === null) {
      throw new AppNotFoundError(`App "${appId}" not found.`, { appId, tenantId });
    }

    const build = await buildRepo.findByAppAndId(appId, buildId);
    if (build === null) {
      throw new AppNotFoundError(`Build "${buildId}" not found for app "${appId}".`);
    }
    return build;
  }

  async function listBuilds(
    tenantId: string,
    appId: string,
    options?: { cursor?: string; limit?: number; filterStatus?: string }
  ): Promise<{ builds: BuildRow[]; nextCursor: string | null; total: number }> {
    const app = await appRepo.findByTenantAndId(tenantId, appId);
    if (app === null) {
      throw new AppNotFoundError(`App "${appId}" not found.`, { appId, tenantId });
    }

    const limit = options?.limit ?? 20;
    const [builds, total] = await Promise.all([
      buildRepo.listByApp(appId, options),
      buildRepo.countByApp(appId),
    ]);

    const nextCursor = builds.length === limit ? (builds[builds.length - 1]?.id ?? null) : null;

    return { builds, nextCursor, total };
  }

  async function deleteBuild(
    tenantId: string,
    appId: string,
    buildId: string
  ): Promise<void> {
    const app = await appRepo.findByTenantAndId(tenantId, appId);
    if (app === null) {
      throw new AppNotFoundError(`App "${appId}" not found.`, { appId, tenantId });
    }

    if (app.current_build_id === buildId) {
      throw new AppCannotDeleteActiveBuildError(
        `Cannot delete build "${buildId}" because it is currently deployed.`,
        { buildId, appId }
      );
    }

    await buildRepo.delete(buildId);
    logger.info("Build deleted", { tenantId, appId, buildId });
  }

  // Retention cleanup job — runs every 24 hours via BullMQ worker.
  // Keeps the last N successful builds (default 20) and purges failed builds
  // older than 7 days.
  async function runRetentionCleanup(retentionCount: number): Promise<void> {
    // Get all non-deleted apps
    // We iterate through all tenants using a simple full-table scan since this
    // is a background job with no SLA requirement.
    const appsResult = await pool.query<{ id: string; current_build_id: string | null }>(
      "SELECT id, current_build_id FROM app.apps WHERE deleted_at IS NULL"
    );

    for (const appRow of appsResult.rows) {
      const appId = appRow.id;
      const currentBuildId = appRow.current_build_id;

      // Purge successful builds beyond retention window
      const oldSuccessBuilds = await buildRepo.findBeyondRetentionWindow(appId, retentionCount);
      for (const build of oldSuccessBuilds) {
        if (build.id === currentBuildId) continue;  // never delete active build
        await buildRepo.delete(build.id);
      }

      // Purge failed builds older than 7 days
      const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const oldFailedBuilds = await buildRepo.findFailedOlderThan(cutoff);
      for (const build of oldFailedBuilds) {
        if (build.app_id === appId) {
          await buildRepo.delete(build.id);
        }
      }
    }

    logger.info("Build retention cleanup complete", { retentionCount });
  }

  return {
    triggerBuild,
    getBuild,
    listBuilds,
    deleteBuild,
    runRetentionCleanup,
  };
}
