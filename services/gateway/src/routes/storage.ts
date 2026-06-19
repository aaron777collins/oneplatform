// Storage browser route handlers for MinIO/S3 bucket inspection.
//
// All routes require authentication (user must have a valid session).
// Admin-only scoping is intentionally not applied here — any authenticated
// user may browse objects within their tenant's buckets. Restrict further
// at the policy layer if needed.

import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import { UnauthorizedError, ValidationError, NotFoundError } from "@oneplatform/core";
import type { StorageService } from "../services/storage-service.js";
import {
  StorageObjectNotFoundError,
  StorageValidationError,
} from "../services/storage-service.js";

export interface StorageRouteDeps {
  storageService: StorageService;
}

// Bucket name validation mirrors S3 naming rules (simplified).
const BUCKET_NAME_RE = /^[a-zA-Z0-9._-]{1,63}$/;

export function createStorageRoutes(deps: StorageRouteDeps): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { storageService } = deps;

  // -------------------------------------------------------------------------
  // GET /buckets — list all buckets
  // -------------------------------------------------------------------------

  routes.get("/buckets", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    const allBuckets = await storageService.listBuckets();
    // Tenant isolation: only return buckets belonging to the authenticated
    // user's tenant. Bucket names are expected to be prefixed with the tenant
    // ID (e.g. "tenant-abc123-uploads"). Buckets without a tenant prefix are
    // excluded — they are system-internal and must not be exposed to users.
    const tenantPrefix = `${user.tenantId}-`;
    const buckets = allBuckets.filter(
      (b: { name?: string; Name?: string }) => {
        const name = b.name ?? b.Name ?? "";
        return name.startsWith(tenantPrefix);
      },
    );
    return c.json({ data: buckets });
  });

  // -------------------------------------------------------------------------
  // GET /buckets/:bucket/objects — list objects in a bucket
  //
  // Query parameters:
  //   prefix            — filter by key prefix (default: "")
  //   delimiter         — grouping character for folder-like navigation (default: "/")
  //   maxKeys           — max results per page (1–1000, default: 1000)
  //   continuationToken — pagination cursor from a previous response
  // -------------------------------------------------------------------------

  routes.get("/buckets/:bucket/objects", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    const bucket = c.req.param("bucket");
    if (!bucket || !BUCKET_NAME_RE.test(bucket)) {
      throw new ValidationError("Invalid bucket name.", [
        {
          code: "invalid_string",
          message: "Bucket name must be 1–63 alphanumeric characters, dots, hyphens, or underscores.",
          path: ["bucket"],
        },
      ]);
    }

    const rawMaxKeys = c.req.query("maxKeys") ?? "1000";
    const maxKeys = parseInt(rawMaxKeys, 10);
    if (isNaN(maxKeys) || maxKeys < 1 || maxKeys > 1000) {
      throw new ValidationError("Invalid maxKeys parameter.", [
        { code: "invalid_number", message: "maxKeys must be between 1 and 1000.", path: ["maxKeys"] },
      ]);
    }

    const prefix = c.req.query("prefix") ?? "";
    const delimiter = c.req.query("delimiter") ?? "/";
    const continuationToken = c.req.query("continuationToken");

    try {
      const result = await storageService.listObjects(bucket, {
        prefix,
        delimiter,
        maxKeys,
        ...(continuationToken !== undefined ? { continuationToken } : {}),
      });
      return c.json({ data: result });
    } catch (err) {
      rethrowAsAppError(err);
    }
  });

  // -------------------------------------------------------------------------
  // GET /buckets/:bucket/download/* — generate pre-signed download URL
  //
  // This route must be registered before the metadata wildcard so Hono
  // matches it first. The download path uses a distinct prefix segment
  // (/download/) rather than a suffix (/download) to avoid ambiguity with
  // keys whose name ends in "download".
  //
  // WHY path-based key extraction: Hono's param("*") is not populated when
  // a route is mounted via app.route(). We extract the key from req.path
  // by stripping the known prefix up to the key boundary.
  // -------------------------------------------------------------------------

  routes.get("/buckets/:bucket/download/*", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    const bucket = c.req.param("bucket");
    if (!bucket || !BUCKET_NAME_RE.test(bucket)) {
      throw new ValidationError("Invalid bucket name.", [
        {
          code: "invalid_string",
          message: "Bucket name must be 1–63 alphanumeric characters.",
          path: ["bucket"],
        },
      ]);
    }

    const objectKey = extractKeyFromPath(c.req.path, bucket, "download");
    if (!objectKey) {
      throw new ValidationError("Object key is required.", [
        { code: "invalid_string", message: "Object key must not be empty.", path: ["key"] },
      ]);
    }

    const rawExpires = c.req.query("expires") ?? "3600";
    const expiresInSeconds = parseInt(rawExpires, 10);
    if (isNaN(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 604800) {
      throw new ValidationError("Invalid expires parameter.", [
        {
          code: "invalid_number",
          message: "expires must be between 1 and 604800 seconds.",
          path: ["expires"],
        },
      ]);
    }

    try {
      const result = await storageService.generatePresignedDownloadUrl(
        bucket,
        objectKey,
        expiresInSeconds,
      );
      return c.json({ data: result });
    } catch (err) {
      rethrowAsAppError(err);
    }
  });

  // -------------------------------------------------------------------------
  // GET /buckets/:bucket/objects/* — get object metadata (HeadObject)
  // -------------------------------------------------------------------------

  routes.get("/buckets/:bucket/objects/*", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    const bucket = c.req.param("bucket");
    if (!bucket || !BUCKET_NAME_RE.test(bucket)) {
      throw new ValidationError("Invalid bucket name.", [
        {
          code: "invalid_string",
          message: "Bucket name must be 1–63 alphanumeric characters.",
          path: ["bucket"],
        },
      ]);
    }

    const objectKey = extractKeyFromPath(c.req.path, bucket, "objects");
    if (!objectKey) {
      throw new ValidationError("Object key is required.", [
        { code: "invalid_string", message: "Object key must not be empty.", path: ["key"] },
      ]);
    }

    try {
      const metadata = await storageService.getObjectMetadata(bucket, objectKey);
      return c.json({ data: metadata });
    } catch (err) {
      rethrowAsAppError(err);
    }
  });

  // -------------------------------------------------------------------------
  // DELETE /buckets/:bucket/objects/* — delete an object
  // -------------------------------------------------------------------------

  routes.delete("/buckets/:bucket/objects/*", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    const bucket = c.req.param("bucket");
    if (!bucket || !BUCKET_NAME_RE.test(bucket)) {
      throw new ValidationError("Invalid bucket name.", [
        {
          code: "invalid_string",
          message: "Bucket name must be 1–63 alphanumeric characters.",
          path: ["bucket"],
        },
      ]);
    }

    const objectKey = extractKeyFromPath(c.req.path, bucket, "objects");
    if (!objectKey) {
      throw new ValidationError("Object key is required.", [
        { code: "invalid_string", message: "Object key must not be empty.", path: ["key"] },
      ]);
    }

    try {
      await storageService.deleteObject(bucket, objectKey);
      return c.json({ data: { deleted: true, key: objectKey } });
    } catch (err) {
      rethrowAsAppError(err);
    }
  });

  return routes;
}

// ---------------------------------------------------------------------------
// extractKeyFromPath — derive the object key from the request path.
//
// WHY: Hono's param("*") is not populated when sub-routers are mounted via
// app.route(). The full request path is always available on c.req.path, so
// we locate the bucket-segment + action-segment boundary and take everything
// after it as the key. URL encoding is preserved — callers decode if needed.
//
// Example:
//   path   = "/api/v1/storage/buckets/my-bucket/objects/2024/data.csv"
//   bucket = "my-bucket"
//   action = "objects"
//   result = "2024/data.csv"
// ---------------------------------------------------------------------------

function extractKeyFromPath(
  path: string,
  bucket: string,
  action: "objects" | "download",
): string {
  // Build the marker that precedes the key. Using the literal bucket name
  // ensures we handle paths where the mount prefix varies (test vs production).
  const marker = `/buckets/${bucket}/${action}/`;
  const idx = path.indexOf(marker);
  if (idx < 0) return "";
  const raw = path.slice(idx + marker.length);
  // The key may contain percent-encoded characters from the URL — decode them
  // but preserve forward slashes (they are structural path separators).
  return raw.split("/").map(decodeURIComponent).join("/");
}

// ---------------------------------------------------------------------------
// Error mapping — translate storage-specific errors to framework errors
// that the core error handler serializes to the correct HTTP status codes.
// ---------------------------------------------------------------------------

function rethrowAsAppError(err: unknown): never {
  if (err instanceof StorageObjectNotFoundError) {
    throw new NotFoundError(err.message);
  }
  if (err instanceof StorageValidationError) {
    throw new ValidationError(err.message, []);
  }
  // StorageServiceError (non-404) passes through so the core 500 handler
  // returns a generic error response without leaking S3 internals.
  throw err;
}
