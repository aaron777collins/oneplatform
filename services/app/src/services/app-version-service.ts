import { createHash } from "node:crypto";
import type { Logger } from "@oneplatform/core";
import type { AppVersionRepository } from "../repositories/app-version-repository.js";
import type { VersionRepository } from "../repositories/version-repository.js";
import type { AppRepository } from "../repositories/app-repository.js";
import type { AppVersionRow } from "../repositories/types.js";
import { AppNotFoundError, AppVersionNotFoundError } from "./errors.js";
import { computeDiff } from "./diff-service.js";
import type { SnapshotDiff } from "./diff-service.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Hard limit per app to prevent unbounded storage growth.
// The oldest versions are pruned after each create.
export const MAX_VERSIONS_PER_APP = 100;

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface AppVersionService {
  createVersion(appId: string, userId: string, message?: string, tenantId?: string): Promise<AppVersionRow>;
  listVersions(appId: string, options: ListVersionsInput, tenantId?: string): Promise<ListVersionsResult>;
  getVersion(appId: string, versionNumber: number, tenantId?: string): Promise<AppVersionRow>;
  restoreVersion(appId: string, versionNumber: number, userId: string, tenantId?: string): Promise<RestoreResult>;
  diffVersions(appId: string, fromVersion: number, toVersion: number, tenantId?: string): Promise<SnapshotDiff>;
}

export interface ListVersionsInput {
  cursor?: string;
  limit:   number;
}

export interface ListVersionsResult {
  versions:   AppVersionRow[];
  nextCursor: string | null;
  total:      number;
}

export interface RestoreResult {
  // Versions created for the restore point (so history shows a "restored from vN" entry)
  newVersionNumber: number;
  restoredFromVersionNumber: number;
  fileCount: number;
}

export interface AppVersionServiceDeps {
  appVersionRepo: AppVersionRepository;
  fileRepo:       VersionRepository;
  appRepo:        AppRepository;
  logger:         Logger;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAppVersionService(deps: AppVersionServiceDeps): AppVersionService {
  const { appVersionRepo, fileRepo, appRepo, logger } = deps;

  async function assertAppExists(appId: string, tenantId?: string): Promise<void> {
    const app = tenantId
      ? await appRepo.findByTenantAndId(tenantId, appId)
      : await appRepo.findById(appId);
    if (app === null) {
      throw new AppNotFoundError(`App "${appId}" not found.`, { appId });
    }
  }

  // Builds a snapshot of the current VFS state for the app.
  async function snapshotCurrentFiles(appId: string): Promise<Record<string, string>> {
    const files = await fileRepo.getAllFilesForBuild(appId);
    const snapshot: Record<string, string> = {};
    for (const file of files) {
      snapshot[file.path] = file.content;
    }
    return snapshot;
  }

  async function createVersion(
    appId: string,
    userId: string,
    message?: string,
    tenantId?: string
  ): Promise<AppVersionRow> {
    await assertAppExists(appId, tenantId);

    const snapshot = await snapshotCurrentFiles(appId);

    const version = await appVersionRepo.create({
      app_id:         appId,
      files_snapshot: snapshot,
      created_by:     userId,
      ...(message !== undefined ? { message } : {}),
    });

    // Prune versions that exceed the cap — oldest first.
    // Pruning happens after the insert so the newly created version is never pruned.
    const pruned = await appVersionRepo.pruneOldest(appId, MAX_VERSIONS_PER_APP);
    if (pruned > 0) {
      logger.info("Pruned old app versions", { appId, pruned });
    }

    logger.info("App version created", {
      appId,
      versionNumber: version.version_number,
      fileCount: Object.keys(snapshot).length,
    });

    return version;
  }

  async function listVersions(
    appId: string,
    options: ListVersionsInput,
    tenantId?: string
  ): Promise<ListVersionsResult> {
    await assertAppExists(appId, tenantId);

    const [versions, total] = await Promise.all([
      appVersionRepo.listByApp(appId, {
        ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
        limit: options.limit,
      }),
      appVersionRepo.countByApp(appId),
    ]);

    // Use created_at as the keyset cursor — ISO string is unambiguous and sortable
    const nextCursor =
      versions.length === options.limit
        ? (versions[versions.length - 1]?.created_at.toISOString() ?? null)
        : null;

    return { versions, nextCursor, total };
  }

  async function getVersion(appId: string, versionNumber: number, tenantId?: string): Promise<AppVersionRow> {
    await assertAppExists(appId, tenantId);

    const version = await appVersionRepo.findByAppAndVersion(appId, versionNumber);
    if (version === null) {
      throw new AppVersionNotFoundError(
        `Version ${versionNumber} of app "${appId}" not found.`,
        { appId, versionNumber }
      );
    }
    return version;
  }

  async function restoreVersion(
    appId: string,
    versionNumber: number,
    userId: string,
    tenantId?: string
  ): Promise<RestoreResult> {
    await assertAppExists(appId, tenantId);

    const targetVersion = await appVersionRepo.findByAppAndVersion(appId, versionNumber);
    if (targetVersion === null) {
      throw new AppVersionNotFoundError(
        `Version ${versionNumber} of app "${appId}" not found.`,
        { appId, versionNumber }
      );
    }

    const snapshot = targetVersion.files_snapshot;

    // Delete all current files so we start fresh (avoids stale paths that no
    // longer exist in the restored version)
    const currentFiles = await fileRepo.getAllFilesForBuild(appId);
    for (const file of currentFiles) {
      await fileRepo.delete(appId, file.path);
    }

    // Write the restored files back. Use create() which handles the ON CONFLICT
    // DO NOTHING semantics — since we deleted everything above, conflicts are
    // impossible here but this is the correct insert method for new rows.
    for (const [path, content] of Object.entries(snapshot)) {
      const contentHash = createHash("sha256").update(content, "utf8").digest("hex");
      await fileRepo.create({
        app_id:       appId,
        path,
        content,
        content_hash: contentHash,
        updated_by:   userId,
      });
    }

    // Record the restore as a new version so history shows when the restore happened
    const restoreVersion = await createVersion(
      appId,
      userId,
      `Restored from version ${versionNumber}`
    );

    logger.info("App version restored", {
      appId,
      restoredFromVersion: versionNumber,
      newVersion:          restoreVersion.version_number,
      fileCount:           Object.keys(snapshot).length,
    });

    return {
      newVersionNumber:          restoreVersion.version_number,
      restoredFromVersionNumber: versionNumber,
      fileCount:                 Object.keys(snapshot).length,
    };
  }

  async function diffVersions(
    appId: string,
    fromVersion: number,
    toVersion: number,
    tenantId?: string
  ): Promise<SnapshotDiff> {
    await assertAppExists(appId, tenantId);

    const [from, to] = await Promise.all([
      appVersionRepo.findByAppAndVersion(appId, fromVersion),
      appVersionRepo.findByAppAndVersion(appId, toVersion),
    ]);

    if (from === null) {
      throw new AppVersionNotFoundError(
        `Version ${fromVersion} of app "${appId}" not found.`,
        { appId, versionNumber: fromVersion }
      );
    }
    if (to === null) {
      throw new AppVersionNotFoundError(
        `Version ${toVersion} of app "${appId}" not found.`,
        { appId, versionNumber: toVersion }
      );
    }

    return computeDiff(from.files_snapshot, to.files_snapshot);
  }

  return { createVersion, listVersions, getVersion, restoreVersion, diffVersions };
}
