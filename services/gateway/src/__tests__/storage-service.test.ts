// Unit tests for storage-service.ts.
//
// The service talks to MinIO/S3 via raw HTTP using AWS Signature V4. Tests
// intercept the global fetch so no real network calls are made. The goal is
// to verify:
//   1. Correct S3 API paths and query parameters are constructed.
//   2. ListBuckets / ListObjectsV2 XML parsing returns the expected shapes.
//   3. HeadObject metadata extraction is correct.
//   4. DeleteObject treats 404 as idempotent success.
//   5. Pre-signed URL generation includes the required Sig V4 query params.
//   6. Validation errors are thrown for out-of-range inputs.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createStorageService,
  StorageObjectNotFoundError,
  StorageServiceError,
  StorageValidationError,
} from "../services/storage-service.js";

// ---------------------------------------------------------------------------
// Fixture XML responses (minimal valid S3 XML)
// ---------------------------------------------------------------------------

const LIST_BUCKETS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ListAllMyBucketsResult>
  <Owner><ID>owner-id</ID><DisplayName>owner</DisplayName></Owner>
  <Buckets>
    <Bucket>
      <Name>file-uploads</Name>
      <CreationDate>2024-01-15T10:00:00.000Z</CreationDate>
    </Bucket>
    <Bucket>
      <Name>datasets</Name>
      <CreationDate>2024-02-20T08:30:00.000Z</CreationDate>
    </Bucket>
  </Buckets>
</ListAllMyBucketsResult>`;

const LIST_OBJECTS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <Name>file-uploads</Name>
  <Prefix></Prefix>
  <Delimiter>/</Delimiter>
  <IsTruncated>false</IsTruncated>
  <Contents>
    <Key>report.csv</Key>
    <LastModified>2024-03-01T12:00:00.000Z</LastModified>
    <ETag>&quot;abc123&quot;</ETag>
    <Size>2048</Size>
  </Contents>
  <Contents>
    <Key>data.json</Key>
    <LastModified>2024-03-05T09:00:00.000Z</LastModified>
    <ETag>&quot;def456&quot;</ETag>
    <Size>512</Size>
  </Contents>
  <CommonPrefixes>
    <Prefix>logs/</Prefix>
  </CommonPrefixes>
  <CommonPrefixes>
    <Prefix>exports/</Prefix>
  </CommonPrefixes>
</ListBucketResult>`;

const LIST_OBJECTS_TRUNCATED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <Name>file-uploads</Name>
  <Prefix>large/</Prefix>
  <IsTruncated>true</IsTruncated>
  <NextContinuationToken>token-abc-123</NextContinuationToken>
  <Contents>
    <Key>large/file-001.csv</Key>
    <LastModified>2024-03-01T12:00:00.000Z</LastModified>
    <ETag>&quot;aaa&quot;</ETag>
    <Size>1024</Size>
  </Contents>
</ListBucketResult>`;

const LIST_OBJECTS_EMPTY_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <Name>empty-bucket</Name>
  <IsTruncated>false</IsTruncated>
</ListBucketResult>`;

// ---------------------------------------------------------------------------
// Test configuration (credentials are arbitrary for unit tests)
// ---------------------------------------------------------------------------

const TEST_CONFIG = {
  endpoint: "http://minio:9000",
  region: "us-east-1",
  accessKeyId: "minioadmin",
  secretAccessKey: "minioadmin",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOkResponse(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
    text: async () => body,
    json: async () => JSON.parse(body) as unknown,
  } as unknown as Response;
}

function makeErrorResponse(status: number): Response {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    text: async () => `<Error><Code>NoSuchBucket</Code></Error>`,
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("StorageService — listBuckets", () => {
  // MockInstance<TArgs, TReturn> — use broad types to avoid the complex
  // conditional type produced by vi.spyOn(globalThis, "fetch").
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: import("vitest").MockInstance<any[], any>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeOkResponse(LIST_BUCKETS_XML),
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("calls GET / on the configured endpoint", async () => {
    const service = createStorageService(TEST_CONFIG);
    await service.listBuckets();

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe("http://minio:9000/");
    expect((init as RequestInit).method).toBe("GET");
  });

  it("includes an Authorization header with AWS4-HMAC-SHA256", async () => {
    const service = createStorageService(TEST_CONFIG);
    await service.listBuckets();

    const headers = (fetchSpy.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toMatch(/^AWS4-HMAC-SHA256 Credential=/);
  });

  it("returns two buckets with correct names and createdAt", async () => {
    const service = createStorageService(TEST_CONFIG);
    const buckets = await service.listBuckets();

    expect(buckets).toHaveLength(2);
    expect(buckets[0]).toMatchObject({ name: "file-uploads", createdAt: "2024-01-15T10:00:00.000Z" });
    expect(buckets[1]).toMatchObject({ name: "datasets", createdAt: "2024-02-20T08:30:00.000Z" });
  });

  it("throws StorageServiceError on non-2xx response", async () => {
    fetchSpy.mockResolvedValue(makeErrorResponse(403));
    const service = createStorageService(TEST_CONFIG);

    await expect(service.listBuckets()).rejects.toBeInstanceOf(StorageServiceError);
  });
});

// ---------------------------------------------------------------------------

describe("StorageService — listObjects", () => {
  // MockInstance<TArgs, TReturn> — use broad types to avoid the complex
  // conditional type produced by vi.spyOn(globalThis, "fetch").
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: import("vitest").MockInstance<any[], any>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeOkResponse(LIST_OBJECTS_XML),
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("calls GET /{bucket} with list-type=2", async () => {
    const service = createStorageService(TEST_CONFIG);
    await service.listObjects("file-uploads");

    const [url] = fetchSpy.mock.calls[0]!;
    const parsed = new URL(String(url));
    expect(parsed.pathname).toBe("/file-uploads");
    expect(parsed.searchParams.get("list-type")).toBe("2");
  });

  it("includes prefix and delimiter query params when provided", async () => {
    const service = createStorageService(TEST_CONFIG);
    await service.listObjects("file-uploads", { prefix: "logs/", delimiter: "/" });

    const [url] = fetchSpy.mock.calls[0]!;
    const parsed = new URL(String(url));
    expect(parsed.searchParams.get("prefix")).toBe("logs/");
    expect(parsed.searchParams.get("delimiter")).toBe("/");
  });

  it("parses Contents entries as non-folder objects", async () => {
    const service = createStorageService(TEST_CONFIG);
    const result = await service.listObjects("file-uploads");

    const files = result.objects.filter((o) => !o.isFolder);
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({
      key: "report.csv",
      size: 2048,
      etag: "abc123",
      isFolder: false,
      lastModified: "2024-03-01T12:00:00.000Z",
    });
  });

  it("parses CommonPrefixes entries as folder objects", async () => {
    const service = createStorageService(TEST_CONFIG);
    const result = await service.listObjects("file-uploads");

    const folders = result.objects.filter((o) => o.isFolder);
    expect(folders).toHaveLength(2);
    expect(folders[0]).toMatchObject({ key: "logs/", isFolder: true, size: null });
    expect(folders[1]).toMatchObject({ key: "exports/", isFolder: true });
  });

  it("strips ETag surrounding quotes", async () => {
    const service = createStorageService(TEST_CONFIG);
    const result = await service.listObjects("file-uploads");

    const file = result.objects.find((o) => o.key === "report.csv");
    expect(file?.etag).toBe("abc123");
  });

  it("returns isTruncated=false and null nextContinuationToken when complete", async () => {
    const service = createStorageService(TEST_CONFIG);
    const result = await service.listObjects("file-uploads");

    expect(result.isTruncated).toBe(false);
    expect(result.nextContinuationToken).toBeNull();
  });

  it("returns isTruncated=true and next token when result is truncated", async () => {
    fetchSpy.mockResolvedValue(makeOkResponse(LIST_OBJECTS_TRUNCATED_XML));
    const service = createStorageService(TEST_CONFIG);
    const result = await service.listObjects("file-uploads", { prefix: "large/" });

    expect(result.isTruncated).toBe(true);
    expect(result.nextContinuationToken).toBe("token-abc-123");
  });

  it("returns empty objects array for an empty bucket", async () => {
    fetchSpy.mockResolvedValue(makeOkResponse(LIST_OBJECTS_EMPTY_XML));
    const service = createStorageService(TEST_CONFIG);
    const result = await service.listObjects("empty-bucket");

    expect(result.objects).toHaveLength(0);
    expect(result.isTruncated).toBe(false);
  });

  it("passes continuationToken as a query param when provided", async () => {
    fetchSpy.mockResolvedValue(makeOkResponse(LIST_OBJECTS_EMPTY_XML));
    const service = createStorageService(TEST_CONFIG);
    await service.listObjects("file-uploads", { continuationToken: "token-abc" });

    const [url] = fetchSpy.mock.calls[0]!;
    const parsed = new URL(String(url));
    expect(parsed.searchParams.get("continuation-token")).toBe("token-abc");
  });

  it("throws StorageServiceError on non-2xx response", async () => {
    fetchSpy.mockResolvedValue(makeErrorResponse(404));
    const service = createStorageService(TEST_CONFIG);

    await expect(service.listObjects("missing-bucket")).rejects.toBeInstanceOf(StorageServiceError);
  });
});

// ---------------------------------------------------------------------------

describe("StorageService — getObjectMetadata", () => {
  // MockInstance<TArgs, TReturn> — use broad types to avoid the complex
  // conditional type produced by vi.spyOn(globalThis, "fetch").
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: import("vitest").MockInstance<any[], any>;

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("calls HEAD /{bucket}/{key}", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeOkResponse("", 200, {
        "content-length": "4096",
        "last-modified": "Thu, 01 Mar 2024 12:00:00 GMT",
        "content-type": "text/csv",
        etag: '"etag-value"',
      }),
    );
    const service = createStorageService(TEST_CONFIG);
    await service.getObjectMetadata("file-uploads", "report.csv");

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain("/file-uploads/report.csv");
    expect((init as RequestInit).method).toBe("HEAD");
  });

  it("returns metadata from response headers", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeOkResponse("", 200, {
        "content-length": "4096",
        "last-modified": "Thu, 01 Mar 2024 12:00:00 GMT",
        "content-type": "text/csv",
        etag: '"etag-value"',
      }),
    );
    const service = createStorageService(TEST_CONFIG);
    const meta = await service.getObjectMetadata("file-uploads", "report.csv");

    expect(meta.key).toBe("report.csv");
    expect(meta.size).toBe(4096);
    expect(meta.contentType).toBe("text/csv");
    expect(meta.etag).toBe("etag-value"); // quotes stripped
  });

  it("throws StorageObjectNotFoundError on 404", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(makeErrorResponse(404));
    const service = createStorageService(TEST_CONFIG);

    await expect(service.getObjectMetadata("file-uploads", "missing.csv"))
      .rejects
      .toBeInstanceOf(StorageObjectNotFoundError);
  });

  it("encodes object keys containing slashes correctly", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeOkResponse("", 200, { "content-length": "0", etag: '"abc"' }),
    );
    const service = createStorageService(TEST_CONFIG);
    await service.getObjectMetadata("file-uploads", "2024/march/report.csv");

    const [url] = fetchSpy.mock.calls[0]!;
    // Slashes between segments are preserved; individual segments are encoded.
    expect(String(url)).toContain("/file-uploads/2024/march/report.csv");
  });
});

// ---------------------------------------------------------------------------

describe("StorageService — deleteObject", () => {
  // MockInstance<TArgs, TReturn> — use broad types to avoid the complex
  // conditional type produced by vi.spyOn(globalThis, "fetch").
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: import("vitest").MockInstance<any[], any>;

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("calls DELETE /{bucket}/{key}", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(makeOkResponse("", 204));
    const service = createStorageService(TEST_CONFIG);
    await service.deleteObject("file-uploads", "report.csv");

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain("/file-uploads/report.csv");
    expect((init as RequestInit).method).toBe("DELETE");
  });

  it("treats 404 response as success (idempotent delete)", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(makeErrorResponse(404));
    const service = createStorageService(TEST_CONFIG);

    // Should not throw
    await expect(service.deleteObject("file-uploads", "already-gone.csv")).resolves.toBeUndefined();
  });

  it("throws StorageServiceError on 403 response", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(makeErrorResponse(403));
    const service = createStorageService(TEST_CONFIG);

    await expect(service.deleteObject("file-uploads", "protected.csv"))
      .rejects
      .toBeInstanceOf(StorageServiceError);
  });
});

// ---------------------------------------------------------------------------

describe("StorageService — generatePresignedDownloadUrl", () => {
  it("returns a URL containing required Sig V4 query parameters", async () => {
    const service = createStorageService(TEST_CONFIG);
    const result = await service.generatePresignedDownloadUrl("file-uploads", "report.csv", 3600);

    const url = new URL(result.url);
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-Credential")).toContain("minioadmin");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("3600");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(url.searchParams.get("X-Amz-Signature")).toBeTruthy();
    expect(url.searchParams.get("X-Amz-Date")).toBeTruthy();
  });

  it("includes the object key in the URL path", async () => {
    const service = createStorageService(TEST_CONFIG);
    const result = await service.generatePresignedDownloadUrl("my-bucket", "path/to/file.csv", 300);

    const url = new URL(result.url);
    expect(url.pathname).toBe("/my-bucket/path/to/file.csv");
  });

  it("returns an expiresAt timestamp in the future", async () => {
    const before = Date.now();
    const service = createStorageService(TEST_CONFIG);
    const result = await service.generatePresignedDownloadUrl("file-uploads", "report.csv", 600);

    const expiresAt = new Date(result.expiresAt).getTime();
    expect(expiresAt).toBeGreaterThan(before + 599_000);
    expect(expiresAt).toBeLessThan(before + 601_000);
  });

  it("throws StorageValidationError when expiresInSeconds is 0", async () => {
    const service = createStorageService(TEST_CONFIG);

    await expect(service.generatePresignedDownloadUrl("bucket", "key", 0))
      .rejects
      .toBeInstanceOf(StorageValidationError);
  });

  it("throws StorageValidationError when expiresInSeconds exceeds 7 days", async () => {
    const service = createStorageService(TEST_CONFIG);

    await expect(service.generatePresignedDownloadUrl("bucket", "key", 604801))
      .rejects
      .toBeInstanceOf(StorageValidationError);
  });

  it("makes no HTTP request — URL generation is entirely in-process", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const service = createStorageService(TEST_CONFIG);
    await service.generatePresignedDownloadUrl("file-uploads", "report.csv");

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
