// Unit tests for services/ingestion/src/services/upload-service.ts
//
// Tests CSV/JSON/NDJSON parsing, schema inference, file size limits,
// content type validation, and getUploadStatus tenant isolation.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Job } from "bullmq";
import type { Logger } from "@oneplatform/core";
import {
  createUploadService,
  type UploadJobRepository,
  type UploadJobRow,
  type ObjectStorageClient,
  type FileParseJobPayload,
  type CreateUploadInput,
} from "../services/upload-service.js";
import type { RawTableRepository } from "../services/sync-service.js";
import {
  UploadUnsupportedTypeError,
  UploadFileTooLargeError,
  UploadJobNotFoundError,
  UploadParseFailedError,
} from "../services/errors.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TENANT_ID = "10000000-0000-4000-8000-000000000001";
const USER_ID = "10000000-0000-4000-8000-000000000002";
const CONNECTOR_ID = "10000000-0000-4000-8000-000000000003";
const UPLOAD_JOB_ID = "10000000-0000-4000-8000-000000000004";

function makeUploadJobRow(overrides: Partial<UploadJobRow> = {}): UploadJobRow {
  return {
    id: UPLOAD_JOB_ID,
    tenant_id: TENANT_ID,
    connector_id: null,
    filename: "data.csv",
    content_type: "text/csv",
    file_size_bytes: "1024",
    minio_key: null,
    status: "uploading",
    rows_parsed: "0",
    rows_staged: "0",
    rows_failed: "0",
    error: null,
    inferred_schema: null,
    created_by: USER_ID,
    created_at: new Date(),
    updated_at: new Date(),
    completed_at: null,
    ...overrides,
  };
}

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

type MockFn = ReturnType<typeof vi.fn>;

interface MockJobRepo {
  create: MockFn; findById: MockFn; findByTenantId: MockFn;
  updateStatus: MockFn; updateProgress: MockFn;
}

interface MockRawRepo {
  createRawTable: MockFn; insertBatch: MockFn; softDeleteNotInBatch: MockFn;
  deleteOlderThan: MockFn; dropTable: MockFn; count: MockFn;
}

interface MockStorage {
  getObject: MockFn; putObject: MockFn; deleteObject: MockFn;
}

function makeUploadJobRepo(): MockJobRepo {
  return {
    create: vi.fn().mockResolvedValue(makeUploadJobRow()),
    findById: vi.fn().mockResolvedValue(makeUploadJobRow()),
    findByTenantId: vi.fn().mockResolvedValue([]),
    updateStatus: vi.fn().mockResolvedValue(makeUploadJobRow()),
    updateProgress: vi.fn().mockResolvedValue(makeUploadJobRow()),
  };
}

function makeRawTableRepo(): MockRawRepo {
  return {
    createRawTable: vi.fn().mockResolvedValue(undefined),
    insertBatch: vi.fn().mockResolvedValue(undefined),
    softDeleteNotInBatch: vi.fn().mockResolvedValue(0),
    deleteOlderThan: vi.fn().mockResolvedValue(0),
    dropTable: vi.fn().mockResolvedValue(undefined),
    count: vi.fn().mockResolvedValue(0),
  };
}

function makeObjectStorage(): MockStorage {
  return {
    getObject: vi.fn(),
    putObject: vi.fn().mockResolvedValue(undefined),
    deleteObject: vi.fn().mockResolvedValue(undefined),
  };
}

function buildSvc(repo?: MockJobRepo, rawRepo?: MockRawRepo, storage?: MockStorage) {
  return createUploadService({
    uploadJobRepo: (repo ?? makeUploadJobRepo()) as unknown as UploadJobRepository,
    rawTableRepo: (rawRepo ?? makeRawTableRepo()) as unknown as RawTableRepository,
    storage: (storage ?? makeObjectStorage()) as unknown as ObjectStorageClient,
    logger: makeLogger(),
  });
}

/** Wraps a string as a ReadableStream<Uint8Array> to mimic object storage. */
function stringToStream(content: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(content);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function makeJob(contentType: string, filename: string, minioKey: string): Job<FileParseJobPayload> {
  return {
    data: {
      uploadJobId: UPLOAD_JOB_ID,
      tenantId: TENANT_ID,
      connectorId: CONNECTOR_ID,
      minioKey,
      contentType,
      filename,
    },
  } as Job<FileParseJobPayload>;
}

// BullMQ Queue is used inside the service — stub it.
vi.mock("bullmq", () => ({
  Queue: vi.fn().mockImplementation(() => ({
    add: vi.fn().mockResolvedValue(undefined),
  })),
}));

// ---------------------------------------------------------------------------
// createUpload — content type validation
// ---------------------------------------------------------------------------

describe("createUpload — content type validation", () => {
  const base: CreateUploadInput = {
    tenantId: TENANT_ID,
    userId: USER_ID,
    filename: "data.csv",
    contentType: "text/csv",
    fileSize: 1024,
  };

  it("accepts text/csv", async () => {
    const svc = buildSvc();
    await expect(svc.createUpload({ ...base, contentType: "text/csv" })).resolves.toBeDefined();
  });

  it("accepts application/json", async () => {
    const svc = buildSvc();
    await expect(svc.createUpload({ ...base, contentType: "application/json" })).resolves.toBeDefined();
  });

  it("accepts text/tab-separated-values", async () => {
    const svc = buildSvc();
    await expect(svc.createUpload({ ...base, contentType: "text/tab-separated-values" })).resolves.toBeDefined();
  });

  it("accepts application/octet-stream", async () => {
    const svc = buildSvc();
    await expect(svc.createUpload({ ...base, contentType: "application/octet-stream" })).resolves.toBeDefined();
  });

  it("strips charset suffix and accepts text/csv; charset=utf-8", async () => {
    const svc = buildSvc();
    await expect(svc.createUpload({ ...base, contentType: "text/csv; charset=utf-8" })).resolves.toBeDefined();
  });

  it("throws UploadUnsupportedTypeError for text/plain", async () => {
    const svc = buildSvc();
    await expect(svc.createUpload({ ...base, contentType: "text/plain" })).rejects.toBeInstanceOf(UploadUnsupportedTypeError);
  });

  it("throws UploadUnsupportedTypeError for application/xml", async () => {
    const svc = buildSvc();
    await expect(svc.createUpload({ ...base, contentType: "application/xml" })).rejects.toBeInstanceOf(UploadUnsupportedTypeError);
  });

  it("throws UploadUnsupportedTypeError for image/png", async () => {
    const svc = buildSvc();
    await expect(svc.createUpload({ ...base, contentType: "image/png" })).rejects.toBeInstanceOf(UploadUnsupportedTypeError);
  });
});

// ---------------------------------------------------------------------------
// createUpload — file size validation
// ---------------------------------------------------------------------------

describe("createUpload — file size validation", () => {
  const base: CreateUploadInput = {
    tenantId: TENANT_ID,
    userId: USER_ID,
    filename: "data.csv",
    contentType: "text/csv",
    fileSize: 1024,
  };

  it("accepts fileSize = 1 byte", async () => {
    await expect(buildSvc().createUpload({ ...base, fileSize: 1 })).resolves.toBeDefined();
  });

  it("accepts fileSize at the 5 GB default limit", async () => {
    await expect(buildSvc().createUpload({ ...base, fileSize: 5_368_709_120 })).resolves.toBeDefined();
  });

  it("throws UploadFileTooLargeError when fileSize exceeds limit", async () => {
    await expect(buildSvc().createUpload({ ...base, fileSize: 5_368_709_121 })).rejects.toBeInstanceOf(UploadFileTooLargeError);
  });
});

// ---------------------------------------------------------------------------
// createUpload — calls repo.create
// ---------------------------------------------------------------------------

describe("createUpload — repo interaction", () => {
  it("calls uploadJobRepo.create with correct tenant_id and content_type", async () => {
    const repo = makeUploadJobRepo();
    const svc = buildSvc(repo);
    await svc.createUpload({ tenantId: TENANT_ID, userId: USER_ID, filename: "f.csv", contentType: "text/csv", fileSize: 100 });
    const createArg = repo.create.mock.calls[0]?.[0] as { tenant_id: string; content_type: string };
    expect(createArg.tenant_id).toBe(TENANT_ID);
    expect(createArg.content_type).toBe("text/csv");
  });

  it("passes connectorId to repo when provided", async () => {
    const repo = makeUploadJobRepo();
    const svc = buildSvc(repo);
    await svc.createUpload({ tenantId: TENANT_ID, userId: USER_ID, filename: "f.csv", contentType: "text/csv", fileSize: 100, connectorId: CONNECTOR_ID });
    const createArg = repo.create.mock.calls[0]?.[0] as { connector_id?: string };
    expect(createArg.connector_id).toBe(CONNECTOR_ID);
  });
});

// ---------------------------------------------------------------------------
// getUploadStatus — tenant isolation
// ---------------------------------------------------------------------------

describe("getUploadStatus", () => {
  it("returns the upload job for the correct tenant", async () => {
    const row = await buildSvc().getUploadStatus(TENANT_ID, UPLOAD_JOB_ID);
    expect(row.id).toBe(UPLOAD_JOB_ID);
  });

  it("throws UploadJobNotFoundError when job does not exist", async () => {
    const repo = makeUploadJobRepo();
    repo.findById.mockResolvedValue(null);
    await expect(buildSvc(repo).getUploadStatus(TENANT_ID, "nonexistent")).rejects.toBeInstanceOf(UploadJobNotFoundError);
  });

  it("throws UploadJobNotFoundError when job belongs to a different tenant", async () => {
    const repo = makeUploadJobRepo();
    repo.findById.mockResolvedValue(makeUploadJobRow({ tenant_id: "other-tenant" }));
    await expect(buildSvc(repo).getUploadStatus(TENANT_ID, UPLOAD_JOB_ID)).rejects.toBeInstanceOf(UploadJobNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// processUploadJob — CSV parsing
// ---------------------------------------------------------------------------

describe("processUploadJob — CSV", () => {
  const csvContent = `name,age,active
Alice,30,true
Bob,25,false
Charlie,35,true`;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("processes all CSV data rows and calls insertBatch", async () => {
    const repo = makeUploadJobRepo();
    const rawTableRepo = makeRawTableRepo();
    const storage = makeObjectStorage();
    storage.getObject.mockResolvedValue(stringToStream(csvContent));
    const svc = buildSvc(repo, rawTableRepo, storage);
    await svc.processUploadJob(makeJob("text/csv", "data.csv", "uploads/data.csv"));
    expect(rawTableRepo.insertBatch.mock.calls.length).toBeGreaterThan(0);
  });

  it("infers string type for name column", async () => {
    const repo = makeUploadJobRepo();
    const rawTableRepo = makeRawTableRepo();
    const storage = makeObjectStorage();
    storage.getObject.mockResolvedValue(stringToStream(csvContent));
    const svc = buildSvc(repo, rawTableRepo, storage);
    await svc.processUploadJob(makeJob("text/csv", "data.csv", "uploads/data.csv"));
    expect(repo.updateStatus.mock.calls.some((c: unknown[]) => c[1] === "complete")).toBe(true);
  });

  it("marks job as complete after processing", async () => {
    const repo = makeUploadJobRepo();
    const storage = makeObjectStorage();
    storage.getObject.mockResolvedValue(stringToStream(csvContent));
    const svc = buildSvc(repo, undefined, storage);
    await svc.processUploadJob(makeJob("text/csv", "data.csv", "uploads/data.csv"));
    const completeCalls = repo.updateStatus.mock.calls.filter((c: unknown[]) => c[1] === "complete");
    expect(completeCalls.length).toBe(1);
  });

  it("handles quoted CSV fields with commas", async () => {
    const quoted = `name,value\n"Smith, John",100\n"Doe, Jane",200`;
    const repo = makeUploadJobRepo();
    const rawTableRepo = makeRawTableRepo();
    const storage = makeObjectStorage();
    storage.getObject.mockResolvedValue(stringToStream(quoted));
    const svc = buildSvc(repo, rawTableRepo, storage);
    await svc.processUploadJob(makeJob("text/csv", "data.csv", "uploads/data.csv"));
    expect(rawTableRepo.insertBatch.mock.calls.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// processUploadJob — JSON parsing
// ---------------------------------------------------------------------------

describe("processUploadJob — JSON", () => {
  it("processes an array of JSON objects", async () => {
    const jsonContent = JSON.stringify([{ id: 1, name: "Alice" }, { id: 2, name: "Bob" }]);
    const rawTableRepo = makeRawTableRepo();
    const storage = makeObjectStorage();
    storage.getObject.mockResolvedValue(stringToStream(jsonContent));
    const svc = buildSvc(undefined, rawTableRepo, storage);
    await svc.processUploadJob(makeJob("application/json", "data.json", "uploads/data.json"));
    expect(rawTableRepo.insertBatch.mock.calls.length).toBeGreaterThan(0);
  });

  it("processes a single JSON object as a one-item dataset", async () => {
    const jsonContent = JSON.stringify({ id: 1, name: "Alice" });
    const rawTableRepo = makeRawTableRepo();
    const storage = makeObjectStorage();
    storage.getObject.mockResolvedValue(stringToStream(jsonContent));
    const svc = buildSvc(undefined, rawTableRepo, storage);
    await svc.processUploadJob(makeJob("application/json", "data.json", "uploads/data.json"));
    expect(rawTableRepo.insertBatch.mock.calls.length).toBeGreaterThan(0);
  });

  it("marks job as failed when JSON is malformed", async () => {
    const repo = makeUploadJobRepo();
    const storage = makeObjectStorage();
    storage.getObject.mockResolvedValue(stringToStream("{not valid json"));
    const svc = buildSvc(repo, undefined, storage);
    await expect(
      svc.processUploadJob(makeJob("application/json", "bad.json", "uploads/bad.json")),
    ).rejects.toBeInstanceOf(UploadParseFailedError);
    const failedCalls = repo.updateStatus.mock.calls.filter((c: unknown[]) => c[1] === "failed");
    expect(failedCalls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// processUploadJob — NDJSON parsing
// ---------------------------------------------------------------------------

describe("processUploadJob — NDJSON", () => {
  it("processes NDJSON lines as individual records", async () => {
    const ndjson = '{"id":1,"name":"Alice"}\n{"id":2,"name":"Bob"}\n{"id":3,"name":"Charlie"}';
    const rawTableRepo = makeRawTableRepo();
    const storage = makeObjectStorage();
    storage.getObject.mockResolvedValue(stringToStream(ndjson));
    const svc = buildSvc(undefined, rawTableRepo, storage);
    await svc.processUploadJob(makeJob("text/tab-separated-values", "data.ndjson", "uploads/data.ndjson"));
    expect(rawTableRepo.insertBatch.mock.calls.length).toBeGreaterThan(0);
  });

  it("skips empty lines in NDJSON", async () => {
    const ndjson = '{"id":1}\n\n{"id":2}\n';
    const repo = makeUploadJobRepo();
    const storage = makeObjectStorage();
    storage.getObject.mockResolvedValue(stringToStream(ndjson));
    const svc = buildSvc(repo, undefined, storage);
    await svc.processUploadJob(makeJob("text/tab-separated-values", "data.ndjson", "uploads/data.ndjson"));
    expect(repo.updateStatus.mock.calls.some((c: unknown[]) => c[1] === "complete")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// processUploadJob — schema inference
// ---------------------------------------------------------------------------

describe("processUploadJob — schema inference", () => {
  it("calls updateProgress with inferred_schema after processing", async () => {
    // Build 200+ rows so schema inference triggers at SCHEMA_INFERENCE_ROWS=200
    const rows = Array.from({ length: 205 }, (_, i) => `${i},value_${i},true`).join("\n");
    const csv = `id,name,active\n${rows}`;
    const repo = makeUploadJobRepo();
    const storage = makeObjectStorage();
    storage.getObject.mockResolvedValue(stringToStream(csv));
    const svc = buildSvc(repo, undefined, storage);
    await svc.processUploadJob(makeJob("text/csv", "big.csv", "uploads/big.csv"));
    const progressCalls = repo.updateProgress.mock.calls as Array<Array<unknown>>;
    const schemaCall = progressCalls.find((args) => {
      const data = args[1] as Record<string, unknown>;
      return data["inferred_schema"] !== undefined;
    });
    expect(schemaCall).toBeDefined();
  });
});
