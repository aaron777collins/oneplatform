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
]);

const DEFAULT_MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024; // 5 GB
const FILE_UPLOADS_BUCKET = "file-uploads";
const redisUrl = process.env["OP_REDIS_URL"] ?? "redis://localhost:6379";

// The file-parse queue is shared across all upload route instances (module-level
// singleton so we don't create a new connection per request).
const fileParseQueue = new Queue<FileParseJobPayload>("ingestion:file-parse", {
  connection: { lazyConnect: true, url: redisUrl },
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5_000 },
    removeOnComplete: { age: 86_400 },
    removeOnFail: { age: 604_800 },
  },
});

export interface UploadRouteDeps {
  uploadService: UploadService;
  storage: ObjectStorageClient;
  maxFileSizeBytes?: number;
}

export function createUploadRoutes(deps: UploadRouteDeps): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { uploadService, storage } = deps;
  const maxFileSize = deps.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE;

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

    const uploadJob = await uploadService.createUpload({
      tenantId: user.tenantId,
      userId: user.userId,
      filename,
      contentType,
      fileSize: file.size,
      ...(connectorId ? { connectorId } : {}),
    });

    // Stream the multipart bytes to MinIO before returning.
    // Failure here should propagate — the client must retry rather than
    // polling a job that will never have data to parse.
    const minioKey = `file-uploads/${user.tenantId}/${uploadJob.id}/${filename}`;
    const fileStream = file.stream();
    await storage.putObject(FILE_UPLOADS_BUCKET, minioKey, fileStream, contentType);

    // Enqueue the parse worker now that the bytes are durably in MinIO.
    await fileParseQueue.add("parse", {
      uploadJobId: uploadJob.id,
      tenantId: user.tenantId,
      // Use connector ID from the job row (may be null for unlinked uploads).
      connectorId: uploadJob.connector_id ?? uploadJob.id,
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
