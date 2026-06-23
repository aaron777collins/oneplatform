/**
 * Unit tests for the DataService gRPC implementation.
 *
 * All outbound HTTP calls are intercepted via globalThis.fetch mocks so no
 * live ingestion service is required.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createDataService } from "../grpc/services/data-service.js";
import type { Entity, ListEntitiesResponse } from "@oneplatform/sdk/grpc-types";
import type { RpcContext } from "../grpc/service-registry.js";

const INGESTION_URL = "http://ingestion-service:3000";

function makeEntity(id: string): Entity {
  return {
    id,
    entityType: "Product",
    tenantId: "t1",
    dataJson: JSON.stringify({ name: "Test Product" }),
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
}

function mockFetch(response: unknown, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => response,
    }),
  );
}

// Default RPC context representing an authenticated request from tenant "t1".
// Tests that need to verify tenant mismatch rejection should override tenantId.
function makeCtx(overrides: Partial<RpcContext> = {}): RpcContext {
  return {
    tenantId: "t1",
    userId: "user-1",
    roles: ["viewer"],
    requestId: "req-test",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// GetEntity
// ---------------------------------------------------------------------------

describe("DataService.GetEntity", () => {
  it("calls the ingestion service with correct URL and returns an Entity", async () => {
    const entity = makeEntity("ent-1");
    mockFetch({ data: entity });

    const svc = createDataService({ ingestionServiceUrl: INGESTION_URL });
    const result = await svc.GetEntity({
      entityType: "Product",
      id: "ent-1",
      tenantId: "t1",
    }, makeCtx());

    expect(result).toEqual(entity);
    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(fetchCall?.[0]).toContain("/api/v1/data/Product/ent-1");
  });

  it("throws when entityType is empty", async () => {
    const svc = createDataService({ ingestionServiceUrl: INGESTION_URL });
    await expect(
      svc.GetEntity({ entityType: "", id: "x", tenantId: "t1" }, makeCtx()),
    ).rejects.toThrow(/required/i);
  });

  it("throws NotFoundError when ingestion returns 404", async () => {
    mockFetch({ message: "not found" }, 404);
    const svc = createDataService({ ingestionServiceUrl: INGESTION_URL });
    await expect(
      svc.GetEntity({ entityType: "Product", id: "missing", tenantId: "t1" }, makeCtx()),
    ).rejects.toThrow("not found");
  });

  it("throws UnauthorizedError when request tenantId does not match ctx", async () => {
    const svc = createDataService({ ingestionServiceUrl: INGESTION_URL });
    await expect(
      svc.GetEntity({ entityType: "Product", id: "x", tenantId: "other-tenant" }, makeCtx({ tenantId: "t1" })),
    ).rejects.toThrow(/does not match/i);
  });
});

// ---------------------------------------------------------------------------
// ListEntities
// ---------------------------------------------------------------------------

describe("DataService.ListEntities", () => {
  it("returns a paginated response", async () => {
    const listRes: ListEntitiesResponse = {
      items: [makeEntity("a"), makeEntity("b")],
      nextCursor: "cursor-2",
      total: 10,
    };
    mockFetch({ data: listRes });

    const svc = createDataService({ ingestionServiceUrl: INGESTION_URL });
    const result = await svc.ListEntities({
      entityType: "Product",
      tenantId: "t1",
      pageSize: 2,
      pageCursor: "",
      filterJson: "",
    }, makeCtx());

    expect(result.items).toHaveLength(2);
    expect(result.nextCursor).toBe("cursor-2");
  });

  it("appends cursor and pageSize as query params", async () => {
    mockFetch({ data: { items: [], nextCursor: "", total: 0 } });
    const svc = createDataService({ ingestionServiceUrl: INGESTION_URL });
    await svc.ListEntities({
      entityType: "Product",
      tenantId: "t1",
      pageSize: 5,
      pageCursor: "cursor-prev",
      filterJson: "",
    }, makeCtx());

    const url = vi.mocked(globalThis.fetch).mock.calls[0]?.[0] as string;
    expect(url).toContain("pageSize=5");
    expect(url).toContain("cursor=cursor-prev");
  });
});

// ---------------------------------------------------------------------------
// CreateEntity
// ---------------------------------------------------------------------------

describe("DataService.CreateEntity", () => {
  it("POSTs to the correct URL and returns the created entity", async () => {
    const created = makeEntity("new-1");
    mockFetch({ data: created });

    const svc = createDataService({ ingestionServiceUrl: INGESTION_URL });
    const result = await svc.CreateEntity({
      entityType: "Product",
      tenantId: "t1",
      dataJson: JSON.stringify({ name: "New Product" }),
    }, makeCtx());

    expect(result.id).toBe("new-1");
    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/data/Product");
    expect(init.method).toBe("POST");
  });

  it("throws when dataJson is invalid JSON", async () => {
    const svc = createDataService({ ingestionServiceUrl: INGESTION_URL });
    await expect(
      svc.CreateEntity({ entityType: "Product", tenantId: "t1", dataJson: "not-json" }, makeCtx()),
    ).rejects.toThrow(/valid JSON/i);
  });
});

// ---------------------------------------------------------------------------
// UpdateEntity
// ---------------------------------------------------------------------------

describe("DataService.UpdateEntity", () => {
  it("sends a PATCH request to the entity's URL", async () => {
    const updated = makeEntity("upd-1");
    mockFetch({ data: updated });

    const svc = createDataService({ ingestionServiceUrl: INGESTION_URL });
    await svc.UpdateEntity({
      entityType: "Product",
      id: "upd-1",
      tenantId: "t1",
      dataJson: JSON.stringify({ name: "Updated" }),
    }, makeCtx());

    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/data/Product/upd-1");
    expect(init.method).toBe("PATCH");
  });
});

// ---------------------------------------------------------------------------
// DeleteEntity
// ---------------------------------------------------------------------------

describe("DataService.DeleteEntity", () => {
  it("sends a DELETE request and returns success=true", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 204 }),
    );

    const svc = createDataService({ ingestionServiceUrl: INGESTION_URL });
    const result = await svc.DeleteEntity({
      entityType: "Product",
      id: "del-1",
      tenantId: "t1",
    }, makeCtx());

    expect(result.success).toBe(true);
    expect(result.id).toBe("del-1");
  });

  it("throws NotFoundError when entity does not exist", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ message: "entity not found" }),
      }),
    );

    const svc = createDataService({ ingestionServiceUrl: INGESTION_URL });
    await expect(
      svc.DeleteEntity({ entityType: "Product", id: "ghost", tenantId: "t1" }, makeCtx()),
    ).rejects.toThrow("not found");
  });
});

// ---------------------------------------------------------------------------
// StreamEntities
// ---------------------------------------------------------------------------

describe("DataService.StreamEntities", () => {
  it("yields entities across multiple pages", async () => {
    const page1: ListEntitiesResponse = {
      items: [makeEntity("s-1"), makeEntity("s-2")],
      nextCursor: "page-2",
      total: 4,
    };
    const page2: ListEntitiesResponse = {
      items: [makeEntity("s-3"), makeEntity("s-4")],
      nextCursor: "",
      total: 4,
    };

    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => {
        callCount++;
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: callCount === 1 ? page1 : page2 }),
        };
      }),
    );

    const svc = createDataService({ ingestionServiceUrl: INGESTION_URL });
    const results: Entity[] = [];
    for await (const entity of svc.StreamEntities({
      entityType: "Product",
      tenantId: "t1",
      filterJson: "",
      limit: 0,
    }, makeCtx())) {
      results.push(entity);
    }

    expect(results).toHaveLength(4);
    expect(results.map((e) => e.id)).toEqual(["s-1", "s-2", "s-3", "s-4"]);
  });

  it("respects the limit parameter", async () => {
    const page: ListEntitiesResponse = {
      items: [makeEntity("a"), makeEntity("b"), makeEntity("c")],
      nextCursor: "",
      total: 3,
    };
    mockFetch({ data: page });

    const svc = createDataService({ ingestionServiceUrl: INGESTION_URL });
    const results: Entity[] = [];
    for await (const entity of svc.StreamEntities({
      entityType: "Product",
      tenantId: "t1",
      filterJson: "",
      limit: 2,
    }, makeCtx())) {
      results.push(entity);
    }

    expect(results).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// BulkIngest
// ---------------------------------------------------------------------------

describe("DataService.BulkIngest", () => {
  it("returns 0 accepted for an empty stream", async () => {
    const svc = createDataService({ ingestionServiceUrl: INGESTION_URL });
    const result = await svc.BulkIngest((async function* () {})(), makeCtx());
    expect(result.accepted).toBe(0);
    expect(result.rejected).toBe(0);
  });

  it("posts records to the ingest endpoint and returns accepted count", async () => {
    mockFetch({ data: { accepted: 2 } });

    const svc = createDataService({ ingestionServiceUrl: INGESTION_URL });
    const records = (async function* () {
      yield { connectorId: "c1", tenantId: "t1", dataJson: "{}", externalId: "" };
      yield { connectorId: "c1", tenantId: "t1", dataJson: "{}", externalId: "" };
    })();

    const result = await svc.BulkIngest(records, makeCtx());
    expect(result.accepted).toBe(2);
    expect(result.rejected).toBe(0);
  });

  it("marks records with invalid JSON as rejected", async () => {
    const svc = createDataService({ ingestionServiceUrl: INGESTION_URL });
    const records = (async function* () {
      yield { connectorId: "c1", tenantId: "t1", dataJson: "BAD JSON", externalId: "" };
    })();

    const result = await svc.BulkIngest(records, makeCtx());
    expect(result.rejected).toBe(1);
    expect(result.errors[0]?.code).toBe("INVALID_JSON");
  });

  it("includes service token in outbound request headers", async () => {
    mockFetch({ data: { accepted: 1 } });

    const svc = createDataService({
      ingestionServiceUrl: INGESTION_URL,
      serviceTokenSigner: { sign: async () => "svc-token-abc" },
    });
    const records = (async function* () {
      yield { connectorId: "c1", tenantId: "t1", dataJson: "{}", externalId: "" };
    })();

    await svc.BulkIngest(records, makeCtx());
    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["x-service-token"]).toBe("svc-token-abc");
  });
});
