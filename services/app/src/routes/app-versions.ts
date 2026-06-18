import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import { ValidationError, UnauthorizedError } from "@oneplatform/core";
import type { AppVersionService } from "../services/app-version-service.js";
import type { AppService } from "../services/app-service.js";
import { CreateVersionSchema, PaginationSchema } from "../schemas/index.js";
import type { AppVersionRow } from "../repositories/types.js";
import type { SnapshotDiff } from "../services/diff-service.js";

// ---------------------------------------------------------------------------
// Route dependencies
// ---------------------------------------------------------------------------

export interface AppVersionRouteDeps {
  appVersionService: AppVersionService;
  appService:        AppService;
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function createAppVersionRoutes(
  deps: AppVersionRouteDeps
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { appVersionService, appService } = deps;

  // POST /versions — create a version snapshot
  routes.post("/versions", async (c) => {
    const user = c.var.user;
    if (user === undefined) throw new UnauthorizedError("Authentication required.");

    const appId = resolveAppId(c);

    // Verify app ownership before creating a version
    await appService.getApp(user.tenantId, appId);

    const body = await c.req.json().catch(() => ({}));
    const parsed = CreateVersionSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid request body.", parsed.error.issues);
    }

    const version = await appVersionService.createVersion(
      appId,
      user.userId,
      parsed.data.message
    );

    return c.json({ data: formatVersion(version) }, 201);
  });

  // GET /versions — list version history
  routes.get("/versions", async (c) => {
    const user = c.var.user;
    if (user === undefined) throw new UnauthorizedError("Authentication required.");

    const appId = resolveAppId(c);

    // Verify app ownership
    await appService.getApp(user.tenantId, appId);

    const query = PaginationSchema.safeParse({
      cursor: c.req.query("cursor"),
      limit:  c.req.query("limit"),
    });
    const { cursor, limit } = query.success ? query.data : { cursor: undefined, limit: 20 };

    const result = await appVersionService.listVersions(appId, {
      ...(cursor !== undefined ? { cursor } : {}),
      limit,
    });

    return c.json({
      data: result.versions.map(formatVersionSummary),
      pagination: {
        nextCursor: result.nextCursor,
        total:      result.total,
      },
    });
  });

  // GET /versions/:version — get version detail (includes files snapshot)
  routes.get("/versions/:version", async (c) => {
    const user = c.var.user;
    if (user === undefined) throw new UnauthorizedError("Authentication required.");

    const appId         = resolveAppId(c);
    const versionNumber = parseVersionParam(c.req.param("version"));

    // Verify app ownership
    await appService.getApp(user.tenantId, appId);

    const version = await appVersionService.getVersion(appId, versionNumber);

    return c.json({ data: formatVersionDetail(version) });
  });

  // POST /versions/:version/restore — restore app to a previous version
  routes.post("/versions/:version/restore", async (c) => {
    const user = c.var.user;
    if (user === undefined) throw new UnauthorizedError("Authentication required.");

    const appId         = resolveAppId(c);
    const versionNumber = parseVersionParam(c.req.param("version"));

    // Verify app ownership
    await appService.getApp(user.tenantId, appId);

    const result = await appVersionService.restoreVersion(appId, versionNumber, user.userId);

    return c.json({ data: result });
  });

  // GET /versions/:from/diff/:to — compute diff between two versions
  routes.get("/versions/:from/diff/:to", async (c) => {
    const user = c.var.user;
    if (user === undefined) throw new UnauthorizedError("Authentication required.");

    const appId       = resolveAppId(c);
    const fromVersion = parseVersionParam(c.req.param("from"));
    const toVersion   = parseVersionParam(c.req.param("to"));

    // Verify app ownership
    await appService.getApp(user.tenantId, appId);

    const diff = await appVersionService.diffVersions(appId, fromVersion, toVersion);

    return c.json({ data: formatDiff(diff) });
  });

  return routes;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Routes are mounted at /api/v1/apps/:appId, so the appId param key may vary
// depending on how the parent router registered the segment.
function resolveAppId(c: { req: { param: (key: string) => string | undefined } }): string {
  const id = c.req.param("appId") ?? c.req.param("id");
  if (id === undefined) {
    throw new ValidationError("Missing appId in route.", []);
  }
  return id;
}

function parseVersionParam(raw: string | undefined): number {
  const n = parseInt(raw ?? "", 10);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError(`Invalid version number "${raw ?? ""}". Must be a positive integer.`, []);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Response formatters
// ---------------------------------------------------------------------------

function formatVersionSummary(v: AppVersionRow) {
  return {
    id:            v.id,
    appId:         v.app_id,
    versionNumber: v.version_number,
    message:       v.message,
    fileCount:     Object.keys(v.files_snapshot).length,
    createdBy:     v.created_by,
    createdAt:     v.created_at.toISOString(),
  };
}

function formatVersion(v: AppVersionRow) {
  return formatVersionSummary(v);
}

function formatVersionDetail(v: AppVersionRow) {
  return {
    id:             v.id,
    appId:          v.app_id,
    versionNumber:  v.version_number,
    message:        v.message,
    filesSnapshot:  v.files_snapshot,
    createdBy:      v.created_by,
    createdAt:      v.created_at.toISOString(),
  };
}

function formatDiff(diff: SnapshotDiff) {
  return {
    added:    diff.added,
    removed:  diff.removed,
    modified: diff.modified.map((fd) => ({
      path:      fd.path,
      additions: fd.additions,
      deletions: fd.deletions,
      hunks:     fd.hunks.map((h) => ({
        oldStart: h.oldStart,
        oldLines: h.oldLines,
        newStart: h.newStart,
        newLines: h.newLines,
        lines:    h.lines.map((l) => ({
          operation:  l.operation,
          lineNumber: l.lineNumber,
          content:    l.content,
        })),
      })),
    })),
  };
}
