import { Hono } from "hono";
import { Queue } from "bullmq";
import type { AppVariables } from "@oneplatform/core";
import { UnauthorizedError, ValidationError } from "@oneplatform/core";
import type { UploadService, ObjectStorageClient, FileParseJobPayload } from "../services/upload-service.js";
import { UploadFileTooLargeError, UploadUnsupportedTypeError } from "../services/errors.js";

const ALLOWED_MIME_TYPES = new Set([
  "text/csv",
  "application/json",
  "text/tab-separated-values",
  "application/x-ndjson",
  "application/octet-stream",
]);

const DEFAULT_MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024; // 5 GB
const FILE_UPLOADS_BUCKET = "file-uploads";

export interface UploadRouteDeps {
  uploadService: UploadService;
  storage: ObjectStorageClient;
  maxFileSizeBytes?: number;
  /** Redis URL for the file-parse queue — must match the validated service config. */
  redisUrl: string;
}

export function createUploadRoutes(deps: UploadRouteDeps): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { uploadService, storage } = deps;
  const maxFileSize = deps.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE;

  // Queue is created inside the factory so it uses the validated config URL
  // rather than reading process.env at import time. This also ensures the queue
  // is scoped to this route instance and can be closed during graceful shutdown.
  const fileParseQueue = new Queue<FileParseJobPayload>("ingestion:file-parse", {
    connection: { lazyConnect: true, url: deps.redisUrl },
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: "exponential", delay: 1_000 },
      removeOnComplete: { count: 0 },
      removeOnFail: { count: 100 },
    },
  });

  routes.post("/", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    const formData = await c.req.parseBody();
    const file = formData["file"];

    if (!file || !(file instanceof File)) {
      throw new ValidationError("A file field is required.");
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

    if (!connectorId) {
      throw new ValidationError(
        "connectorId is required. File uploads must be linked to a connector so the ingested data can be tracked and cleaned up by the retention service.",
      );
    }

    const uploadJob = await uploadService.createUpload({
      tenantId: user.tenantId,
      userId: user.userId,
      filename,
      contentType,
      fileSize: file.size,
      connectorId,
    });

    // Stream the multipart bytes to MinIO before returning.
    // Failure here should propagate — the client must retry rather than
    // polling a job that will never have data to parse.
    const minioKey = `file-uploads/${user.tenantId}/${uploadJob.id}/${filename}`;
    const fileStream = file.stream();
    await storage.putObject(FILE_UPLOADS_BUCKET, minioKey, fileStream, contentType);

    // Enqueue the parse worker now that the bytes are durably in MinIO.
    // connector_id is guaranteed non-null here because we validated it above.
    await fileParseQueue.add("parse", {
      uploadJobId: uploadJob.id,
      tenantId: user.tenantId,
      connectorId: uploadJob.connector_id ?? connectorId,
      minioKey,
      contentType,
      filename,
    });

    return c.json({
      data: {
        uploadJobId: uploadJob.id,
        status: uploadJob.status,
        filename: uploadJob.filename,
        contentType: uploadJob.content_type,
        fileSizeBytes: uploadJob.file_size_bytes,
      },
    }, 202);
  });

  routes.get("/:id/status", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
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
