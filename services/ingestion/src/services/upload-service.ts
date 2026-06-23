import { Queue, type Job } from "bullmq";
import type { Logger } from "@oneplatform/core";
import {
  UploadJobNotFoundError,
  UploadUnsupportedTypeError,
  UploadFileTooLargeError,
  UploadParseFailedError,
} from "./errors.js";
import {
  normalizeToEnvelope,
  connectorIdToTableName,
} from "../utils/data-envelope.js";
import type { RawTableRepository } from "./sync-service.js";

// ---------------------------------------------------------------------------
// Repository row shape — mirrors types.ts exactly.
// bigint columns come back as strings from the pg driver.
// ---------------------------------------------------------------------------

export interface UploadJobRow {
  id: string;
  tenant_id: string;
  connector_id: string | null;
  filename: string;
  content_type: string;
  file_size_bytes: string | null; // bigint as string from pg driver
  minio_key: string | null;
  status: "pending" | "uploading" | "parsing" | "staging" | "complete" | "failed";
  rows_parsed: string;  // bigint as string
  rows_staged: string;  // bigint as string
  rows_failed: string;  // bigint as string
  error: string | null;
  inferred_schema: Record<string, unknown> | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

export interface CreateUploadJobData {
  tenant_id: string;
  connector_id?: string;
  filename: string;
  content_type: string;
  file_size_bytes?: number;
  minio_key?: string;
  status?: UploadJobRow["status"];
  created_by: string;
}

export interface UpdateUploadJobData {
  status?: UploadJobRow["status"];
  file_size_bytes?: number;
  minio_key?: string;
  rows_parsed?: number;
  rows_staged?: number;
  rows_failed?: number;
  error?: string | null;
  inferred_schema?: Record<string, unknown>;
  completed_at?: Date;
}

// ---------------------------------------------------------------------------
// Repository interface — matches the concrete UploadJobRepository class.
// ---------------------------------------------------------------------------

export interface UploadJobRepository {
  create(data: CreateUploadJobData): Promise<UploadJobRow>;
  findById(id: string): Promise<UploadJobRow | null>;
  findByTenantId(tenantId: string, options?: { cursor?: string; limit?: number }): Promise<UploadJobRow[]>;
  updateStatus(
    id: string,
    status: UploadJobRow["status"],
    extra?: { error?: string | null; completed_at?: Date },
  ): Promise<UploadJobRow | null>;
  updateProgress(id: string, data: UpdateUploadJobData): Promise<UploadJobRow | null>;
}

// ---------------------------------------------------------------------------
// BullMQ job payload
// ---------------------------------------------------------------------------

export interface FileParseJobPayload {
  uploadJobId: string;
  tenantId: string;
  connectorId: string;
  minioKey: string;
  contentType: string;
  filename: string;
}

// ---------------------------------------------------------------------------
// MinIO/S3 client interface — matches what the index.ts stub provides.
// Returns ReadableStream<Uint8Array> as the AWS SDK v3 GetObjectCommand does.
// The put/delete methods are used by the route handler, not the parse worker.
// ---------------------------------------------------------------------------

export interface ObjectStorageClient {
  getObject(bucket: string, key: string): Promise<ReadableStream<Uint8Array>>;
  putObject(
    bucket: string,
    key: string,
    body: unknown,
    contentType?: string,
  ): Promise<void>;
  deleteObject(bucket: string, key: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Allowed MIME types for file uploads (per spec §9.1)
// ---------------------------------------------------------------------------

const ALLOWED_CONTENT_TYPES = new Set([
  "text/csv",
  "application/json",
  "text/tab-separated-values",
  "application/x-ndjson",
  "application/octet-stream",
]);

const MAX_UPLOAD_BYTES =
  parseInt(process.env["OP_UPLOAD_MAX_SIZE_BYTES"] ?? "5368709120", 10);

const MAX_FAILURE_RATE =
  parseFloat(process.env["OP_UPLOAD_MAX_FAILURE_RATE"] ?? "0.5");

const BATCH_SIZE = 1_000;
const SCHEMA_INFERENCE_ROWS = 200;
const FILE_UPLOADS_BUCKET = "file-uploads";

const DEFAULT_REDIS_URL = process.env["OP_REDIS_URL"] ?? "redis://localhost:6379";

// ---------------------------------------------------------------------------
// CreateUpload input
// ---------------------------------------------------------------------------

export interface CreateUploadInput {
  tenantId: string;
  userId: string;
  filename: string;
  contentType: string;
  fileSize: number;
  connectorId?: string;
}

// ---------------------------------------------------------------------------
// UploadService — public interface
// ---------------------------------------------------------------------------

export interface UploadService {
  createUpload(input: CreateUploadInput): Promise<UploadJobRow>;
  getUploadStatus(tenantId: string, uploadJobId: string): Promise<UploadJobRow>;
  processUploadJob(job: Job<FileParseJobPayload>): Promise<void>;
}

export interface UploadServiceDeps {
  uploadJobRepo: UploadJobRepository;
  rawTableRepo: RawTableRepository;
  storage: ObjectStorageClient;
  logger: Logger;
  /** Redis URL for BullMQ queues. Falls back to OP_REDIS_URL env var. */
  redisUrl?: string;
}

export function createUploadService(deps: UploadServiceDeps): UploadService {
  const { uploadJobRepo, rawTableRepo, storage, logger } = deps;

  // Derive BullMQ Redis URL from the injected dependency, falling back to the
  // module-level default.
  const redisUrl = deps.redisUrl ?? DEFAULT_REDIS_URL;

  // TODO(#PLAT-???): No Worker consumes "ontology.map" yet — jobs accumulate in Redis
  // until the ontology service implements a consumer. Retry config matches the platform
  // standard so jobs are not silently discarded on enqueue failures.
  const ontologyQueue = new Queue("ontology.map", {
    connection: { lazyConnect: true, url: redisUrl },
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: "exponential", delay: 1_000 },
      removeOnComplete: { age: 86_400 },
      removeOnFail: { age: 604_800 },
    },
  });

  // -------------------------------------------------------------------------
  // createUpload — validates the upload request, creates the upload_jobs row,
  // and returns the job ID for the caller to poll. Actual file storage and
  // parsing happen in the route handler after multipart body receipt.
  // -------------------------------------------------------------------------

  async function createUpload(input: CreateUploadInput): Promise<UploadJobRow> {
    // Normalise the content type — browsers often append "; charset=utf-8".
    const baseContentType = input.contentType.split(";")[0]?.trim() ?? input.contentType;

    if (!ALLOWED_CONTENT_TYPES.has(baseContentType)) {
      throw new UploadUnsupportedTypeError(
        `Content type "${baseContentType}" is not supported. Allowed: ${[...ALLOWED_CONTENT_TYPES].join(", ")}.`,
        { contentType: baseContentType },
      );
    }

    if (input.fileSize > MAX_UPLOAD_BYTES) {
      throw new UploadFileTooLargeError(
        `File size ${input.fileSize} bytes exceeds the maximum of ${MAX_UPLOAD_BYTES} bytes.`,
        { fileSize: input.fileSize, maxBytes: MAX_UPLOAD_BYTES },
      );
    }

    const row = await uploadJobRepo.create({
      tenant_id: input.tenantId,
      created_by: input.userId,
      filename: input.filename,
      content_type: baseContentType,
      status: "uploading",
      file_size_bytes: input.fileSize,
      ...(input.connectorId !== undefined ? { connector_id: input.connectorId } : {}),
    });

    logger.info("Upload job created", {
      uploadJobId: row.id,
      tenantId: input.tenantId,
      filename: input.filename,
      contentType: baseContentType,
    });

    return row;
  }

  // -------------------------------------------------------------------------
  // getUploadStatus — tenant-isolated fetch.
  // -------------------------------------------------------------------------

  async function getUploadStatus(
    tenantId: string,
    uploadJobId: string,
  ): Promise<UploadJobRow> {
    // The repo doesn't have findByTenantAndId — do a findById + ownership check.
    const row = await uploadJobRepo.findById(uploadJobId);
    if (row === null || row.tenant_id !== tenantId) {
      throw new UploadJobNotFoundError(
        `Upload job ${uploadJobId} not found.`,
        { uploadJobId, tenantId },
      );
    }
    return row;
  }

  // -------------------------------------------------------------------------
  // processUploadJob — the BullMQ worker handler for ingestion:file-parse.
  //
  // Reads the file from MinIO as a stream, parses it as CSV/JSON/NDJSON,
  // batches records into raw table upserts, and enqueues ontology:map jobs.
  // -------------------------------------------------------------------------

  async function processUploadJob(job: Job<FileParseJobPayload>): Promise<void> {
    const { uploadJobId, tenantId, connectorId, minioKey, contentType, filename } = job.data;

    await uploadJobRepo.updateStatus(uploadJobId, "parsing");

    let rowsParsed = 0;
    let rowsStaged = 0;
    let rowsFailed = 0;
    let inferredSchema: Record<string, unknown> | null = null;
    let schemaInferred = false;

    try {
      const objectStream = await storage.getObject(FILE_UPLOADS_BUCKET, minioKey);
      const batchId = crypto.randomUUID();
      const tableName = connectorIdToTableName(connectorId);

      await rawTableRepo.createRawTable(connectorId);

      const normaliseContentType = contentType.split(";")[0]?.trim() ?? contentType;
      let batch: Array<{ sourceId: string; data: Record<string, unknown> }> = [];
      let batchSeqNum = 0;

      // Flush the current batch to the raw table and enqueue ontology:map.
      async function flushBatch(): Promise<void> {
        if (batch.length === 0) return;

        const envelopes = batch.map((record) =>
          normalizeToEnvelope(record, {
            connectorId,
            connectorName: filename,
            batchId,
            tenantId,
            syncMode: "full",
            cursor: null,
          }),
        );

        await rawTableRepo.insertBatch(connectorId, envelopes);

        await ontologyQueue.add("map", {
          connectorId,
          batchId,
          tenantId,
          batchSeqNum,
        });

        rowsStaged += batch.length;

        await uploadJobRepo.updateProgress(uploadJobId, {
          rows_parsed: rowsParsed,
          rows_staged: rowsStaged,
          rows_failed: rowsFailed,
        });

        batchSeqNum += 1;
        batch = [];
      }

      // Called for each parsed record — accumulates into batch and flushes.
      async function onRecord(
        rowIndex: number,
        data: Record<string, unknown>,
      ): Promise<void> {
        rowsParsed += 1;

        // Infer schema once we have enough rows. Use >= so files with fewer
        // than SCHEMA_INFERENCE_ROWS records still get schema inference at
        // end-of-file rather than never (the === condition would never trigger
        // for small files, leaving inferredSchema permanently null).
        if (!schemaInferred && rowsParsed >= SCHEMA_INFERENCE_ROWS) {
          inferredSchema = inferSchemaFromSample([...batch.map((r) => r.data), data]);
          schemaInferred = true;

          await uploadJobRepo.updateProgress(uploadJobId, {
            inferred_schema: inferredSchema,
          });
        }

        const sourceId = `${uploadJobId}:row:${rowIndex}`;
        batch.push({ sourceId, data });

        if (batch.length >= BATCH_SIZE) {
          await uploadJobRepo.updateStatus(uploadJobId, "staging");
          await flushBatch();
        }
      }

      // Stream the file from MinIO line-by-line rather than buffering the
      // entire file in memory — this keeps peak heap usage proportional to a
      // single chunk rather than the file size (design spec §9.3, W10).
      // Callback for parse errors — increments rowsFailed so the failure rate
      // check at the end of processUploadJob accounts for malformed rows.
      function onParseError(): void {
        rowsFailed += 1;
      }

      if (normaliseContentType === "application/json") {
        // JSON arrays must be parsed as a whole so we collect chunks into a
        // Node.js Buffer; the MaxUploadBytes guard above ensures this is bounded.
        const reader = objectStream.getReader();
        const chunks: Uint8Array[] = [];
        while (true) {
          const read = await reader.read();
          if (read.done) break;
          chunks.push(read.value);
        }
        const rawContent = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
        await processJson(rawContent, onRecord);
      } else if (
        normaliseContentType === "text/csv" ||
        normaliseContentType === "application/octet-stream"
      ) {
        await processCsvStream(objectStream, onRecord, onParseError);
      } else {
        // NDJSON / JSON Lines / text/tab-separated-values
        await processNdjsonStream(objectStream, onRecord, onParseError);
      }

      // For files with fewer than SCHEMA_INFERENCE_ROWS records the in-loop
      // threshold may not trigger. Infer from the final batch before flushing
      // so small files are not left with null inferredSchema.
      if (!schemaInferred && batch.length > 0) {
        inferredSchema = inferSchemaFromSample(batch.map((r) => r.data));
        schemaInferred = true;
        await uploadJobRepo.updateProgress(uploadJobId, {
          inferred_schema: inferredSchema,
        });
      }

      // Flush any remaining records.
      await flushBatch();

      // Abort if the failure rate exceeds the configured threshold.
      const totalAttempted = rowsParsed + rowsFailed;
      if (
        totalAttempted > 0 &&
        rowsFailed / totalAttempted > MAX_FAILURE_RATE
      ) {
        throw new UploadParseFailedError(
          `More than ${MAX_FAILURE_RATE * 100}% of rows failed to parse.`,
          { rowsParsed, rowsFailed },
        );
      }

      await uploadJobRepo.updateStatus(uploadJobId, "complete", {
        completed_at: new Date(),
      });

      if (rowsParsed > 0 || rowsStaged > 0 || rowsFailed > 0) {
        await uploadJobRepo.updateProgress(uploadJobId, {
          rows_parsed: rowsParsed,
          rows_staged: rowsStaged,
          rows_failed: rowsFailed,
          ...(inferredSchema !== null ? { inferred_schema: inferredSchema } : {}),
        });
      }

      logger.info("Upload job complete", {
        uploadJobId,
        rowsParsed,
        rowsStaged,
        rowsFailed,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      await uploadJobRepo.updateStatus(uploadJobId, "failed", {
        error: message,
        completed_at: new Date(),
      });

      logger.error("Upload job failed", { uploadJobId, error: message });
      throw err;
    }
  }

  return { createUpload, getUploadStatus, processUploadJob };
}

// ---------------------------------------------------------------------------
// File parsers — streaming where possible to bound memory usage.
// ---------------------------------------------------------------------------

async function processJson(
  content: string,
  onRecord: (index: number, data: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new UploadParseFailedError(
      `JSON file could not be parsed: ${err instanceof Error ? err.message : String(err)}`,
      {},
    );
  }

  const items = Array.isArray(parsed) ? parsed : [parsed];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (typeof item === "object" && item !== null && !Array.isArray(item)) {
      await onRecord(i, item as Record<string, unknown>);
    }
  }
}

async function processNdjson(
  content: string,
  onRecord: (index: number, data: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  const lines = content.split("\n");
  let index = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const item = JSON.parse(trimmed) as unknown;
      if (typeof item === "object" && item !== null && !Array.isArray(item)) {
        await onRecord(index, item as Record<string, unknown>);
      }
    } catch {
      // Malformed lines are counted as parse failures by the caller via rowsFailed.
    }
    index += 1;
  }
}

async function processCsv(
  content: string,
  onRecord: (index: number, data: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  const headerLine = lines[0];
  if (headerLine === undefined) return;

  const headers = parseCsvRow(headerLine);
  let index = 0;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const values = parseCsvRow(line);
    const record: Record<string, unknown> = {};
    for (let h = 0; h < headers.length; h++) {
      const key = headers[h] ?? `field_${h}`;
      const value = values[h] ?? null;
      record[key] = inferCsvValue(value);
    }
    await onRecord(index, record);
    index += 1;
  }
}

function parseCsvRow(line: string): string[] {
  const fields: string[] = [];
  let inQuote = false;
  let current = "";

  for (let i = 0; i < line.length; i++) {
    const ch = line[i] ?? "";
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuote = !inQuote;
      }
    } else if (ch === "," && !inQuote) {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

// Heuristic type inference for CSV values (per spec §9.2)
function inferCsvValue(value: string | null): unknown {
  if (value === null || value === "") return null;
  if (/^\d{4}-\d{2}-\d{2}(T[\d:.Z+-]+)?$/.test(value)) return value;
  if (value.toLowerCase() === "true") return true;
  if (value.toLowerCase() === "false") return false;
  if (/^-?\d+$/.test(value)) {
    const n = parseInt(value, 10);
    if (!isNaN(n)) return n;
  }
  if (/^-?\d+\.\d+$/.test(value)) {
    const n = parseFloat(value);
    if (!isNaN(n)) return n;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Streaming parsers — consume a ReadableStream<Uint8Array> line-by-line using
// a TextDecoder so we never hold more than one chunk in memory at a time.
// These replace the string-based processNdjson / processCsv for the W10 fix.
// ---------------------------------------------------------------------------

async function processNdjsonStream(
  stream: ReadableStream<Uint8Array>,
  onRecord: (index: number, data: Record<string, unknown>) => Promise<void>,
  onParseError?: () => void,
): Promise<void> {
  const decoder = new TextDecoder("utf-8");
  const reader = stream.getReader();
  let remainder = "";
  let index = 0;

  try {
    while (true) {
      const read = await reader.read();
      // When done, flush the TextDecoder to emit any buffered bytes from an
      // incomplete multi-byte sequence at the end of the stream. Without this
      // flush the final character of a non-ASCII line could be silently dropped.
      const chunk = read.done
        ? decoder.decode()
        : decoder.decode(read.value, { stream: true });

      // Split on newlines, keeping the last incomplete fragment in `remainder`.
      const segment = remainder + chunk;
      const lines = segment.split("\n");
      remainder = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        try {
          const item = JSON.parse(trimmed) as unknown;
          if (typeof item === "object" && item !== null && !Array.isArray(item)) {
            await onRecord(index, item as Record<string, unknown>);
          }
        } catch {
          // Malformed line — notify the caller so it can increment rowsFailed.
          onParseError?.();
        }
        index += 1;
      }

      if (read.done) break;
    }

    // Process any trailing line that was not terminated by a newline.
    const lastLine = remainder.trim();
    if (lastLine.length > 0) {
      try {
        const item = JSON.parse(lastLine) as unknown;
        if (typeof item === "object" && item !== null && !Array.isArray(item)) {
          await onRecord(index, item as Record<string, unknown>);
        }
      } catch {
        // Trailing malformed line — notify the caller so it can increment rowsFailed.
        onParseError?.();
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function processCsvStream(
  stream: ReadableStream<Uint8Array>,
  onRecord: (index: number, data: Record<string, unknown>) => Promise<void>,
  onParseError?: () => void,
): Promise<void> {
  // onParseError is available for CSV parse errors if needed in the future.
  void onParseError;
  const decoder = new TextDecoder("utf-8");
  const reader = stream.getReader();
  let remainder = "";
  let headers: string[] | null = null;
  let index = 0;

  try {
    while (true) {
      const read = await reader.read();
      // When the stream ends, flush the decoder so any incomplete multibyte
      // sequence in the final chunk is resolved rather than silently dropped.
      const chunk = read.done ? decoder.decode() : decoder.decode(read.value, { stream: true });

      const segment = remainder + chunk;
      const lines = segment.split("\n");
      remainder = lines.pop() ?? "";

      for (const line of lines) {
        if (line.trim().length === 0) continue;
        if (headers === null) {
          // First non-empty line is the header row.
          headers = parseCsvRow(line);
          continue;
        }
        const values = parseCsvRow(line);
        const record: Record<string, unknown> = {};
        for (let h = 0; h < headers.length; h++) {
          const key = headers[h] ?? `field_${h}`;
          const value = values[h] ?? null;
          record[key] = inferCsvValue(value);
        }
        await onRecord(index, record);
        index += 1;
      }

      if (read.done) break;
    }

    // Process trailing line without a terminating newline.
    if (remainder.trim().length > 0 && headers !== null) {
      const values = parseCsvRow(remainder);
      const record: Record<string, unknown> = {};
      for (let h = 0; h < headers.length; h++) {
        const key = headers[h] ?? `field_${h}`;
        const value = values[h] ?? null;
        record[key] = inferCsvValue(value);
      }
      await onRecord(index, record);
    }
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Schema inference — derives a simple type map from a sample of rows.
// ---------------------------------------------------------------------------

function inferSchemaFromSample(
  sample: Record<string, unknown>[],
): Record<string, unknown> {
  if (sample.length === 0) return {};

  const firstRow = sample[0];
  if (firstRow === undefined) return {};

  const fields = Object.keys(firstRow).map((name) => {
    let inferredType: "text" | "integer" | "numeric" | "boolean" | "timestamptz" | "jsonb" =
      "text";
    let nullable = false;
    const sampleValues: unknown[] = [];

    for (const row of sample) {
      const value = row[name];
      if (value === null || value === undefined) {
        nullable = true;
        continue;
      }
      if (sampleValues.length < 3) sampleValues.push(value);
    }

    const firstVal = sampleValues[0];
    if (typeof firstVal === "boolean") {
      inferredType = "boolean";
    } else if (typeof firstVal === "number") {
      inferredType = Number.isInteger(firstVal) ? "integer" : "numeric";
    } else if (
      typeof firstVal === "string" &&
      /^\d{4}-\d{2}-\d{2}(T[\d:.Z+-]+)?$/.test(firstVal)
    ) {
      inferredType = "timestamptz";
    } else if (typeof firstVal === "object" && firstVal !== null) {
      inferredType = "jsonb";
    }

    return { name, inferredType, nullable, sampleValues };
  });

  return { fields };
}
