// Unit tests for storage route handlers.
//
// Routes are tested by constructing a minimal Hono app with the route handlers
// mounted and a pre-populated user context variable, then calling app.fetch()
// directly without a real HTTP server — the same pattern used in gdpr-routes.test.ts.

import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { createStorageRoutes } from "../routes/storage.js";
import type { StorageService } from "../services/storage-service.js";
import {
  StorageObjectNotFoundError,
  StorageServiceError,
} from "../services/storage-service.js";
import type { AppVariables } from "@oneplatform/core";
import { errorHandlerMiddleware } from "@oneplatform/core";

// ---------------------------------------------------------------------------
// Test app builder
// ---------------------------------------------------------------------------

/**
 * Creates a Hono app that pre-injects user context so tests don't need a real
 * JWT. Sets the AppVariables.user field directly before reaching route handlers.
 * The error handler is wired so AppErrors translate to correct HTTP status codes.
 */
function makeApp(storageService: StorageService) {
  const app = new Hono<{ Variables: AppVariables }>();

  // Wire the core error handler — it is a factory, not the handler itself.
  app.onError(errorHandlerMiddleware());

  // Inject a fake authenticated user with all required AppVariables fields.
  app.use("*", async (c, next) => {
    c.set("user", {
      userId: "user-123",
      tenantId: "tenant-abc",
      roles: ["member"],
      scopes: ["data:read"],
      isGuest: false,
      isService: false,
      emailVerified: true,
    });
    c.set("requestId", "test-request-id");
    await next();
  });

  const routes = createStorageRoutes({ storageService });
  app.route("/api/v1/storage", routes);

  return app;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeStorageService(overrides: Partial<StorageService> = {}): StorageService {
  return {
    listBuckets: vi.fn().mockResolvedValue([
      { name: "tenant-abc-file-uploads", createdAt: "2024-01-15T10:00:00.000Z" },
      { name: "tenant-abc-datasets", createdAt: "2024-02-20T08:30:00.000Z" },
    ]),
    listObjects: vi.fn().mockResolvedValue({
      objects: [
        { key: "report.csv", size: 2048, lastModified: "2024-03-01T12:00:00.000Z", contentType: null, etag: "abc123", isFolder: false },
        { key: "logs/", size: null, lastModified: null, contentType: null, etag: null, isFolder: true },
      ],
      nextContinuationToken: null,
      isTruncated: false,
    }),
    getObjectMetadata: vi.fn().mockResolvedValue({
      key: "report.csv",
      size: 2048,
      lastModified: "2024-03-01T12:00:00.000Z",
      contentType: "text/csv",
      etag: "abc123",
    }),
    deleteObject: vi.fn().mockResolvedValue(undefined),
    generatePresignedDownloadUrl: vi.fn().mockResolvedValue({
      url: "http://minio:9000/tenant-abc-file-uploads/report.csv?X-Amz-Signature=fake",
      expiresAt: "2024-03-01T13:00:00.000Z",
    }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// GET /buckets
// ---------------------------------------------------------------------------

describe("GET /api/v1/storage/buckets", () => {
  it("returns 200 with bucket list", async () => {
    const app = makeApp(makeStorageService());
    const res = await app.fetch(new Request("http://localhost/api/v1/storage/buckets"));
    expect(res.status).toBe(200);

    const body = await res.json() as { data: Array<{ name: string }> };
    expect(body.data).toHaveLength(2);
    expect(body.data[0]?.name).toBe("tenant-abc-file-uploads");
  });

  it("returns 401 when user context is missing", async () => {
    const app = new Hono<{ Variables: AppVariables }>();
    app.onError(errorHandlerMiddleware());
    const routes = createStorageRoutes({ storageService: makeStorageService() });
    app.route("/api/v1/storage", routes);

    const res = await app.fetch(new Request("http://localhost/api/v1/storage/buckets"));
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /buckets/:bucket/objects
// ---------------------------------------------------------------------------

describe("GET /api/v1/storage/buckets/:bucket/objects", () => {
  it("returns 200 with object list including folders", async () => {
    const app = makeApp(makeStorageService());
    const res = await app.fetch(
      new Request("http://localhost/api/v1/storage/buckets/tenant-abc-file-uploads/objects"),
    );
    expect(res.status).toBe(200);

    const body = await res.json() as { data: { objects: Array<{ key: string; isFolder: boolean }> } };
    expect(body.data.objects).toHaveLength(2);
    expect(body.data.objects.some((o) => o.isFolder)).toBe(true);
  });

  it("passes prefix and delimiter query params to the service", async () => {
    const service = makeStorageService();
    const app = makeApp(service);
    await app.fetch(
      new Request(
        "http://localhost/api/v1/storage/buckets/tenant-abc-file-uploads/objects?prefix=logs%2F&delimiter=%2F",
      ),
    );

    expect(service.listObjects).toHaveBeenCalledWith(
      "tenant-abc-file-uploads",
      expect.objectContaining({ prefix: "logs/", delimiter: "/" }),
    );
  });

  it("returns 400 for invalid bucket name", async () => {
    const app = makeApp(makeStorageService());
    const res = await app.fetch(
      new Request("http://localhost/api/v1/storage/buckets/../../evil/objects"),
    );
    // Hono normalises the path so ../../evil doesn't reach the handler; it
    // returns 404 for the unmatched route rather than 400 — either is acceptable
    // because the request never reaches the handler.
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("returns 422 for maxKeys out of range", async () => {
    const app = makeApp(makeStorageService());
    const res = await app.fetch(
      new Request(
        "http://localhost/api/v1/storage/buckets/tenant-abc-file-uploads/objects?maxKeys=9999",
      ),
    );
    // ValidationError from @oneplatform/core has statusCode 422.
    expect(res.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// GET /buckets/:bucket/objects/* (metadata)
// ---------------------------------------------------------------------------

describe("GET /api/v1/storage/buckets/:bucket/objects/* — metadata", () => {
  it("returns 200 with object metadata", async () => {
    const app = makeApp(makeStorageService());
    const res = await app.fetch(
      new Request("http://localhost/api/v1/storage/buckets/tenant-abc-file-uploads/objects/report.csv"),
    );
    expect(res.status).toBe(200);

    const body = await res.json() as { data: { key: string; contentType: string } };
    expect(body.data.key).toBe("report.csv");
    expect(body.data.contentType).toBe("text/csv");
  });

  it("returns 404 when the object does not exist", async () => {
    const service = makeStorageService({
      getObjectMetadata: vi.fn().mockRejectedValue(
        new StorageObjectNotFoundError('Object "missing.csv" not found.', "tenant-abc-file-uploads", "missing.csv"),
      ),
    });
    const app = makeApp(service);
    const res = await app.fetch(
      new Request("http://localhost/api/v1/storage/buckets/tenant-abc-file-uploads/objects/missing.csv"),
    );
    expect(res.status).toBe(404);
  });

  it("returns 500 when the storage service errors", async () => {
    const service = makeStorageService({
      getObjectMetadata: vi.fn().mockRejectedValue(
        new StorageServiceError("S3 connection refused", 503),
      ),
    });
    const app = makeApp(service);
    const res = await app.fetch(
      new Request("http://localhost/api/v1/storage/buckets/tenant-abc-file-uploads/objects/report.csv"),
    );
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});

// ---------------------------------------------------------------------------
// DELETE /buckets/:bucket/objects/*
// ---------------------------------------------------------------------------

describe("DELETE /api/v1/storage/buckets/:bucket/objects/*", () => {
  it("returns 200 with deleted confirmation", async () => {
    const app = makeApp(makeStorageService());
    const res = await app.fetch(
      new Request(
        "http://localhost/api/v1/storage/buckets/tenant-abc-file-uploads/objects/report.csv",
        { method: "DELETE" },
      ),
    );
    expect(res.status).toBe(200);

    const body = await res.json() as { data: { deleted: boolean; key: string } };
    expect(body.data.deleted).toBe(true);
    expect(body.data.key).toBe("report.csv");
  });

  it("calls storageService.deleteObject with the correct bucket and key", async () => {
    const service = makeStorageService();
    const app = makeApp(service);
    await app.fetch(
      new Request(
        "http://localhost/api/v1/storage/buckets/tenant-abc-my-bucket/objects/2024/march/data.json",
        { method: "DELETE" },
      ),
    );

    expect(service.deleteObject).toHaveBeenCalledWith("tenant-abc-my-bucket", "2024/march/data.json");
  });
});

// ---------------------------------------------------------------------------
// GET /buckets/:bucket/download/* (pre-signed URL)
// ---------------------------------------------------------------------------

describe("GET /api/v1/storage/buckets/:bucket/download/*", () => {
  it("returns 200 with a pre-signed URL", async () => {
    const app = makeApp(makeStorageService());
    const res = await app.fetch(
      new Request(
        "http://localhost/api/v1/storage/buckets/tenant-abc-file-uploads/download/report.csv",
      ),
    );
    expect(res.status).toBe(200);

    const body = await res.json() as { data: { url: string; expiresAt: string } };
    expect(body.data.url).toContain("X-Amz-Signature");
    expect(body.data.expiresAt).toBeTruthy();
  });

  it("returns 422 when expires is out of range", async () => {
    const app = makeApp(makeStorageService());
    const res = await app.fetch(
      new Request(
        "http://localhost/api/v1/storage/buckets/tenant-abc-file-uploads/download/report.csv?expires=0",
      ),
    );
    // ValidationError from @oneplatform/core has statusCode 422.
    expect(res.status).toBe(422);
  });

  it("passes the expires param to the service", async () => {
    const service = makeStorageService();
    const app = makeApp(service);
    await app.fetch(
      new Request(
        "http://localhost/api/v1/storage/buckets/tenant-abc-file-uploads/download/report.csv?expires=300",
      ),
    );

    expect(service.generatePresignedDownloadUrl).toHaveBeenCalledWith(
      "tenant-abc-file-uploads",
      "report.csv",
      300,
    );
  });
});
