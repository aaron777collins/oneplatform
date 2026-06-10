import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import type { UploadService } from "../services/index.js";
import { UploadFileTooLargeError, UploadUnsupportedTypeError } from "../services/errors.js";

const ALLOWED_MIME_TYPES = new Set([
  "text/csv",
  "application/json",
  "text/tab-separated-values",
  "application/x-ndjson",
]);

const DEFAULT_MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024; // 5 GB

export interface UploadRouteDeps {
  uploadService: UploadService;
  maxFileSizeBytes?: number;
}

export function createUploadRoutes(deps: UploadRouteDeps): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { uploadService } = deps;
  const maxFileSize = deps.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE;

  routes.post("/", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "Authentication required." } }, 401);
    }

    const formData = await c.req.parseBody();
    const file = formData["file"];

    if (!file || !(file instanceof File)) {
      return c.json({
        error: { code: "VALIDATION_ERROR", message: "A file field is required." },
      }, 400);
    }

    if (file.size > maxFileSize) {
      throw new UploadFileTooLargeError(
        `File size ${file.size} exceeds maximum ${maxFileSize} bytes`,
      );
    }

    const contentType = file.type || "application/octet-stream";
    if (!ALLOWED_MIME_TYPES.has(contentType)) {
      throw new UploadUnsupportedTypeError(
        `Content type "${contentType}" is not supported. Allowed: ${[...ALLOWED_MIME_TYPES].join(", ")}`,
      );
    }

    const filename = typeof formData["filename"] === "string"
      ? formData["filename"]
      : file.name || "upload";

    const connectorId = typeof formData["connectorId"] === "string"
      ? formData["connectorId"]
      : undefined;

    const result = await uploadService.createUpload({
      tenantId: user.tenantId,
      userId: user.userId,
      filename,
      contentType,
      fileSize: file.size,
      ...(connectorId ? { connectorId } : {}),
    });

    return c.json({
      data: {
        uploadJobId: result.id,
        status: result.status,
        filename: result.filename,
        contentType: result.content_type,
        fileSizeBytes: result.file_size_bytes,
      },
    }, 202);
  });

  routes.get("/:id/status", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "Authentication required." } }, 401);
    }

    const row = await uploadService.getUploadStatus(user.tenantId, c.req.param("id"));

    return c.json({
      data: {
        uploadJobId: row.id,
        status: row.status,
        filename: row.filename,
        fileSizeBytes: row.file_size_bytes,
        rowsParsed: Number(row.rows_parsed),
        rowsStaged: Number(row.rows_staged),
        rowsFailed: Number(row.rows_failed),
        percentComplete: row.status === "complete" ? 100
          : Number(row.rows_parsed) > 0 ? Math.floor((Number(row.rows_staged) / Number(row.rows_parsed)) * 100)
          : 0,
        error: row.error,
        inferredSchema: row.inferred_schema,
        createdAt: row.created_at.toISOString(),
        completedAt: row.completed_at?.toISOString() ?? null,
      },
    });
  });

  return routes;
}
