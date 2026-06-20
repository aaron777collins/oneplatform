import { createHash, createHmac } from "node:crypto";
import type { Logger, ServiceTokenSigner } from "@oneplatform/core";
import { decrypt } from "@oneplatform/core";
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
// AWS Signature V4 helpers — same pattern as plugin/bundle-service.ts
// We sign MinIO requests directly to avoid the heavy @aws-sdk/client-s3 dep.
// ---------------------------------------------------------------------------

function toHex(buf: Buffer): string {
  return buf.toString("hex");
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function formatDate(d: Date): string {
  return d.toISOString().replace(/[:\-]|\.\d{3}/g, "").slice(0, 8);
}

function formatDatetime(d: Date): string {
  return d.toISOString().replace(/[:\-]|\.\d{3}/g, "").slice(0, 15) + "Z";
}

function getDerivedKey(secretKey: string, date: string, region: string, service: string): Buffer {
  const kDate    = hmacSha256("AWS4" + secretKey, date);
  const kRegion  = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  return hmacSha256(kService, "aws4_request");
}

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function buildSignedHeaders(params: {
  method:       string;
  url:          string;
  region:       string;
  accessKey:    string;
  secretKey:    string;
  payloadHash:  string;
  extraHeaders?: Record<string, string>;
}): Record<string, string> {
  const { method, url, region, accessKey, secretKey, payloadHash, extraHeaders = {} } = params;
  const parsed   = new URL(url);
  const now      = new Date();
  const date     = formatDate(now);
  const datetime = formatDatetime(now);

  const allHeaders: Record<string, string> = {
    host:                   parsed.host,
    "x-amz-date":           datetime,
    "x-amz-content-sha256": payloadHash,
    ...extraHeaders,
  };

  const sortedNames   = Object.keys(allHeaders).sort();
  const canonicalHdrs = sortedNames.map((k) => `${k.toLowerCase()}:${allHeaders[k]!.trim()}`).join("\n") + "\n";
  const signedHdrs    = sortedNames.map((k) => k.toLowerCase()).join(";");

  const canonicalQS = parsed.search
    ? parsed.search.slice(1).split("&").sort().join("&")
    : "";

  const canonicalRequest = [
    method.toUpperCase(), parsed.pathname, canonicalQS, canonicalHdrs, signedHdrs, payloadHash,
  ].join("\n");

  const credScope = `${date}/${region}/s3/aws4_request`;
  const strToSign = [
    "AWS4-HMAC-SHA256", datetime, credScope, sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = getDerivedKey(secretKey, date, region, "s3");
  const signature  = toHex(hmacSha256(signingKey, strToSign));

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKey}/${credScope}, ` +
    `SignedHeaders=${signedHdrs}, Signature=${signature}`;

  // Exclude 'host' — the fetch runtime sets it automatically
  const { host: _host, ...withoutHost } = allHeaders;
  return {
    ...withoutHost,
    Authorization: authorization,
  };
}

// Fetch with AWS Sig V4 signing — reused for all MinIO calls in this service.
async function minioFetch(
  method:       string,
  url:          string,
  accessKey:    string,
  secretKey:    string,
  region:       string,
  bodyBuffer?:  Buffer,
  extraHeaders?: Record<string, string>
): Promise<Response> {
  const payloadHash = bodyBuffer ? sha256Hex(bodyBuffer) : EMPTY_SHA256;
  const headers = buildSignedHeaders({
    method, url, region, accessKey, secretKey, payloadHash,
    extraHeaders: extraHeaders ?? {},
  });

  return fetch(url, {
    method,
    headers,
    ...(bodyBuffer !== undefined ? { body: bodyBuffer } : {}),
  });
}

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

  // Called once at service startup to mark builds interrupted by a prior crash.
  // Any build with status 'pending' or 'building' that has not been updated in
  // the last 5 minutes is presumed lost and marked 'failed'.
  recoverInterruptedBuilds(): Promise<void>;
}

export interface BuildServiceDeps {
  pool:                  pg.Pool;
  appRepo:               AppRepository;
  fileRepo:              VersionRepository;
  buildRepo:             DeploymentRepository;
  permRepo:              PermissionRepository;
  redis:                 Redis;
  executionServiceUrl:   string;
  masterKey:             Buffer;
  logger:                Logger;
  serviceTokenSigner:    ServiceTokenSigner;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

// Build dispatch timeout. If the Execution Service stream does not complete
// within this window, the build is marked failed. 120 s is generous enough
// for large bundles while still bounding runaway builds.
const BUILD_TIMEOUT_MS = 120_000;

// Grace period used by recoverInterruptedBuilds. Builds stuck in pending/building
// for longer than this at startup are presumed lost (process crashed mid-build).
const BUILD_INTERRUPTED_GRACE_MS = 5 * 60 * 1_000;

export function createBuildService(deps: BuildServiceDeps): BuildService {
  const {
    pool, appRepo, fileRepo, buildRepo, permRepo,
    redis, executionServiceUrl, masterKey, logger,
    serviceTokenSigner,
  } = deps;

  // MinIO credentials — read once at service creation, not on every call (W10)
  // Use OP_MINIO_USER / OP_MINIO_PASSWORD to match what Docker Compose injects.
  const minioEndpoint  = process.env["MINIO_ENDPOINT"]   ?? "http://minio:9000";
  const minioAccessKey = process.env["OP_MINIO_USER"]    ?? process.env["MINIO_ACCESS_KEY"] ?? "minioadmin";
  const minioSecretKey = process.env["OP_MINIO_PASSWORD"] ?? process.env["MINIO_SECRET_KEY"] ?? "minioadmin";
  const minioRegion    = process.env["MINIO_REGION"]     ?? "us-east-1";
  const minioBucket    = "op-app-artifacts";

  // Acquire a Postgres transaction-scoped advisory lock keyed to the app ID.
  // This serialises concurrent build triggers for the same app without
  // requiring a distributed lock — the check + insert happen within one xact.
  // All repo calls inside the lock callback receive the same `client` so they
  // participate in the same transaction and are protected by the lock (B1 fix).
  async function withAppAdvisoryLock<T>(
    client: pg.PoolClient,
    appId: string,
    fn: (client: pg.PoolClient) => Promise<T>
  ): Promise<T> {
    // pg_advisory_xact_lock is automatically released at transaction end
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      [appId]
    );
    return fn(client);
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
    let createdBuildId: string | undefined;

    try {
      await client.query("BEGIN");

      // All DB operations inside the lock use `client` so they are bound to
      // the same transaction and protected by the advisory lock (B1).
      await withAppAdvisoryLock(client, appId, async (txClient) => {
        // One build at a time per app
        const inProgress = await txClient.query<{ count: string; id: string | null }>(
          `SELECT COUNT(*) AS count, MIN(id) AS id
             FROM app.builds
            WHERE app_id = $1
              AND status IN ('pending', 'building')`,
          [appId]
        );
        const inProgressRow = inProgress.rows[0];
        const inProgressCount = parseInt(inProgressRow?.count ?? "0", 10);
        if (inProgressCount > 0) {
          throw new AppBuildInProgressError(
            `App "${appId}" already has a build in progress.`,
            { appId, ...(inProgressRow?.id !== null && inProgressRow?.id !== undefined ? { activeBuildId: inProgressRow.id } : {}) }
          );
        }

        const fileCountResult = await txClient.query<{ count: string }>(
          "SELECT COUNT(*) AS count FROM app.files WHERE app_id = $1",
          [appId]
        );
        const fileCount = parseInt(fileCountResult.rows[0]?.count ?? "0", 10);
        if (fileCount === 0) {
          throw new AppNoFilesError(
            `App "${appId}" has no files in the VFS. Add files before triggering a build.`,
            { appId }
          );
        }

        const versionResult = await txClient.query<{ next_version: string }>(
          `SELECT COALESCE(MAX(version_number), 0) + 1 AS next_version
             FROM app.builds
            WHERE app_id = $1`,
          [appId]
        );
        const versionNumber = parseInt(versionResult.rows[0]?.next_version ?? "1", 10);

        const buildResult = await txClient.query<BuildRow>(
          `INSERT INTO app.builds
             (app_id, version_number, status, built_by)
           VALUES ($1, $2, $3, $4)
           RETURNING id, app_id, version_number, status, bundle_path, error_message,
                     error_detail, build_manifest, built_at, built_by, created_at`,
          [appId, versionNumber, "pending", userId]
        );
        const buildRow = buildResult.rows[0];
        if (buildRow === undefined) {
          throw new Error("INSERT INTO app.builds returned no rows");
        }
        createdBuildId = buildRow.id;
      });

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    if (createdBuildId === undefined) {
      throw new Error("Build ID was not assigned during transaction");
    }

    const createdBuild = await buildRepo.findById(createdBuildId);
    if (createdBuild === null) {
      throw new Error(`Build "${createdBuildId}" disappeared immediately after creation`);
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

    logger.info("Build started", {
      tenantId, appId, buildId: build.id,
      versionNumber: build.version_number,
    });

    let buildTimeoutHandle: ReturnType<typeof setTimeout> | undefined;

    try {
      // Mark building
      await buildRepo.update(build.id, { status: "building" });
      logger.info("Build marked as building", { buildId: build.id });

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

      // Fetch non-secret env vars for esbuild define.
      // Values are stored encrypted at rest — decrypt before passing to the build.
      const envVarRows = await permRepo.listEnvVarsByApp(appId);
      const envVars: Record<string, string> = {};
      const decryptFailures: string[] = [];
      await Promise.all(
        envVarRows
          .filter((ev) => !ev.is_secret)
          .map(async (ev) => {
            try {
              envVars[ev.key] = await decrypt(ev.value, masterKey);
            } catch {
              logger.warn("Failed to decrypt env var for build", { appId, key: ev.key, buildId: build.id });
              decryptFailures.push(ev.key);
            }
          })
      );
      if (decryptFailures.length > 0) {
        throw new Error(`Build aborted: failed to decrypt env vars: ${decryptFailures.join(", ")}`);
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

      // W3: include service token so Execution Service can verify the caller.
      // Abort the request if the full stream is not consumed within BUILD_TIMEOUT_MS
      // to prevent builds from running forever.
      const abortController = new AbortController();
      buildTimeoutHandle = setTimeout(() => {
        abortController.abort(new Error(`Build exceeded timeout of ${BUILD_TIMEOUT_MS}ms`));
      }, BUILD_TIMEOUT_MS);

      let response: Response;
      const signedToken = await serviceTokenSigner.sign();
      response = await fetch(`${executionServiceUrl}/internal/execution/execute`, {
        method:  "POST",
        headers: {
          "Content-Type":    "application/json",
          "X-Service-Token": signedToken,
        },
        body:   JSON.stringify(payload),
        signal: abortController.signal,
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

      clearTimeout(buildTimeoutHandle);

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
      if (buildTimeoutHandle !== undefined) clearTimeout(buildTimeoutHandle);
      await buildRepo.update(build.id, {
        status:        "failed",
        error_message: err instanceof Error ? err.message : String(err),
      });
      logger.error("Build dispatch error", {
        tenantId, appId, buildId: build.id,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      // Append done event to the Redis list BEFORE publishing so late-connecting
      // SSE clients that replay the list will also see the terminal event (B6).
      const doneEvent = JSON.stringify({ type: "done", buildId: build.id });
      await redis.rpush(LOG_KEY, doneEvent);
      await redis.expire(LOG_KEY, 86_400);
      await redis.publish(LOG_CHANNEL, doneEvent);
    }
  }

  // Uploads build artifacts to MinIO using AWS Signature V4 (B2).
  // Credentials are read from env vars MINIO_ACCESS_KEY / MINIO_SECRET_KEY.
  // We use the S3-compatible PutObject API directly via fetch to avoid adding
  // the heavy @aws-sdk/client-s3 dependency.
  async function uploadArtifacts(
    tenantId: string,
    appId: string,
    buildId: string,
    files: Record<string, Buffer>
  ): Promise<void> {
    await Promise.all(
      Object.entries(files).map(async ([filename, content]) => {
        const key         = `${tenantId}/${appId}/builds/${buildId}/${filename}`;
        const url         = `${minioEndpoint}/${minioBucket}/${key}`;
        const contentType = filename.endsWith(".json") ? "application/json" : "application/javascript";

        const response = await minioFetch(
          "PUT", url, minioAccessKey, minioSecretKey, minioRegion,
          content,
          { "content-type": contentType }
        );

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

      // Purge failed builds older than 7 days, scoped to this app.
      // V6-168: pass appId so the query only returns builds for the current app
      // instead of scanning all apps and filtering in JS.
      const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const oldFailedBuilds = await buildRepo.findFailedOlderThan(appId, cutoff);
      for (const build of oldFailedBuilds) {
        await buildRepo.delete(build.id);
      }
    }

    logger.info("Build retention cleanup complete", { retentionCount });
  }

  // -------------------------------------------------------------------------
  // recoverInterruptedBuilds — called once at service startup.
  //
  // If the service crashes while dispatchBuild is running, the build row is
  // left in 'pending' or 'building' status permanently because the fire-and-
  // forget async never resumes. At startup we query for such rows and mark
  // them failed so the UI doesn't show builds stuck forever.
  //
  // We only reset builds that were last updated more than BUILD_INTERRUPTED_GRACE_MS
  // ago (default 5 min) to avoid racing with a just-started build on a hot restart.
  // -------------------------------------------------------------------------
  async function recoverInterruptedBuilds(): Promise<void> {
    const cutoff = new Date(Date.now() - BUILD_INTERRUPTED_GRACE_MS);

    const result = await pool.query<{ id: string; app_id: string; status: string }>(
      `UPDATE app.builds
          SET status        = 'failed',
              error_message = 'Interrupted by service restart',
              updated_at    = now()
        WHERE status IN ('pending', 'building')
          AND updated_at   < $1
      RETURNING id, app_id, status`,
      [cutoff]
    );

    const recovered = result.rows;
    if (recovered.length > 0) {
      logger.warn("Recovered interrupted builds on startup", {
        count: recovered.length,
        buildIds: recovered.map((r) => r.id),
      });

      // Publish a 'done' event to any SSE subscribers still waiting on these builds.
      for (const row of recovered) {
        const LOG_KEY     = `app:build-logs:${row.id}`;
        const LOG_CHANNEL = `app:build:${row.id}:log`;
        const doneEvent   = JSON.stringify({ type: "done", buildId: row.id, status: "failed" });
        await redis.rpush(LOG_KEY, doneEvent);
        await redis.expire(LOG_KEY, 86_400);
        await redis.publish(LOG_CHANNEL, doneEvent);
      }
    } else {
      logger.info("No interrupted builds found at startup");
    }
  }

  return {
    triggerBuild,
    getBuild,
    listBuilds,
    deleteBuild,
    runRetentionCleanup,
    recoverInterruptedBuilds,
  };
}
