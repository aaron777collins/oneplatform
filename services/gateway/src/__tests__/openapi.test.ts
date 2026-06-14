// Unit tests for services/gateway/src/routes/openapi.ts
//
// Covers:
//   - /api/v1/openapi/base.json  : static base spec endpoint
//   - /api/v1/openapi.json       : tenant-aware spec endpoint
//   - /api/v1/openapi/:service.json : per-service spec endpoint
//   - generateEntityPaths / overlay merging logic (via the route responses)
//
// File-system reads and the OntologyCache are mocked so these tests run
// without touching disk or network.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import { createOpenApiRoutes } from "../routes/openapi.js";
import type { OntologyCache, EntityDefinition } from "../services/ontology-cache.js";

// ---------------------------------------------------------------------------
// Mock node:fs/promises (used by the route to read spec files from disk)
// ---------------------------------------------------------------------------

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

import { readFile } from "node:fs/promises";
const mockReadFile = vi.mocked(readFile);

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const BASE_SPEC = {
  openapi: "3.0.3",
  info: { title: "OnePlatform", version: "1.0.0" },
  paths: {
    "/api/v1/data/{entityType}": {
      get: { summary: "List entity records", tags: ["Data"] },
    },
  },
};

function makeOntologyCache(
  entries: Map<string, EntityDefinition> = new Map(),
): OntologyCache {
  return {
    getEntry: (tenantId: string) => {
      if (entries.size === 0) return undefined;
      return {
        tenantId,
        schemaVersion: 1,
        entities: entries,
        lastFetchedAt: new Date(),
        etag: "etag-1",
      };
    },
    getEntity: (tenantId: string, entityType: string) => entries.get(entityType),
    getAllEntityTypes: (_tenantId: string) => Array.from(entries.keys()),
    refresh: vi.fn(),
    refreshAll: vi.fn(),
    startSafetyPoll: vi.fn(),
    stopSafetyPoll: vi.fn(),
    startPubSubListener: vi.fn(),
    stopPubSubListener: vi.fn(),
  };
}

const PRODUCT_ENTITY: EntityDefinition = {
  id: "ent-1",
  name: "Product",
  slug: "product",
  version: 1,
  isPublic: true,
  fields: [
    { slug: "sku",  fieldType: "string",  required: true,  nullable: false },
    { slug: "price", fieldType: "number", required: false, nullable: true  },
  ],
};

const PRIVATE_ENTITY: EntityDefinition = {
  id: "ent-2",
  name: "InternalLog",
  slug: "internal-log",
  version: 1,
  isPublic: false,
  fields: [],
};

function buildRoutes(ontologyCache: OntologyCache) {
  return createOpenApiRoutes({
    specPath: "/fake/merged.json",
    specDir: "/fake/openapi/",
    ontologyCache,
  });
}

/** Wraps the route in a minimal Hono app and performs a fetch. */
async function request(
  routes: Hono<{ Variables: AppVariables }>,
  path: string,
  user?: { tenantId: string; userId: string },
): Promise<Response> {
  const app = new Hono<{ Variables: AppVariables }>();

  if (user) {
    // Inject a mock user into context the same way the middleware stack would
    app.use("*", async (c, next) => {
      // @ts-expect-error — assigning to internal Hono variable store in tests
      c.set("user", user);
      await next();
    });
  }

  app.route("/", routes);

  return app.fetch(new Request(`http://localhost${path}`));
}

// ---------------------------------------------------------------------------
// Base spec endpoint — GET /api/v1/openapi/base.json
// ---------------------------------------------------------------------------

describe("GET /api/v1/openapi/base.json — static spec", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadFile.mockResolvedValue(JSON.stringify(BASE_SPEC));
  });

  it("returns 200 with Content-Type application/json", async () => {
    const routes = buildRoutes(makeOntologyCache());
    const res = await request(routes, "/api/v1/openapi/base.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
  });

  it("returns a document with openapi: '3.0.3'", async () => {
    const routes = buildRoutes(makeOntologyCache());
    const res = await request(routes, "/api/v1/openapi/base.json");
    const body = await res.json() as typeof BASE_SPEC;
    expect(body.openapi).toBe("3.0.3");
  });

  it("returns Cache-Control: public, max-age=300", async () => {
    const routes = buildRoutes(makeOntologyCache());
    const res = await request(routes, "/api/v1/openapi/base.json");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
  });

  it("sets Access-Control-Allow-Origin: *", async () => {
    const routes = buildRoutes(makeOntologyCache());
    const res = await request(routes, "/api/v1/openapi/base.json");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("returns 503 with SPEC_NOT_FOUND when the file does not exist", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT: file not found"));
    // Need a fresh route instance so the module-level cache is not populated
    const routes = buildRoutes(makeOntologyCache());
    const res = await request(routes, "/api/v1/openapi/base.json");
    expect(res.status).toBe(503);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("SPEC_NOT_FOUND");
  });

  it("error body includes a helpful message pointing to the generate command", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    const routes = buildRoutes(makeOntologyCache());
    const res = await request(routes, "/api/v1/openapi/base.json");
    const body = await res.json() as { error: { message: string } };
    expect(body.error.message).toMatch(/docs:generate/);
  });
});

// ---------------------------------------------------------------------------
// Tenant-aware endpoint — GET /api/v1/openapi.json
// ---------------------------------------------------------------------------

describe("GET /api/v1/openapi.json — unauthenticated", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadFile.mockResolvedValue(JSON.stringify(BASE_SPEC));
  });

  it("returns the base spec when there is no user context", async () => {
    const routes = buildRoutes(makeOntologyCache());
    const res = await request(routes, "/api/v1/openapi.json");
    expect(res.status).toBe(200);
    const body = await res.json() as typeof BASE_SPEC;
    expect(body.openapi).toBe("3.0.3");
  });

  it("returns Cache-Control: public, max-age=300 for unauthenticated requests", async () => {
    const routes = buildRoutes(makeOntologyCache());
    const res = await request(routes, "/api/v1/openapi.json");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
  });
});

describe("GET /api/v1/openapi.json — authenticated, no entity types", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadFile.mockResolvedValue(JSON.stringify(BASE_SPEC));
  });

  it("returns the base spec unchanged when tenant has no entity types", async () => {
    const routes = buildRoutes(makeOntologyCache());
    const res = await request(routes, "/api/v1/openapi.json", {
      tenantId: "tenant-1",
      userId: "user-1",
    });
    expect(res.status).toBe(200);
    const body = await res.json() as typeof BASE_SPEC;
    expect(body.openapi).toBe("3.0.3");
  });

  it("returns Cache-Control: private, max-age=60 for authenticated requests", async () => {
    const routes = buildRoutes(makeOntologyCache());
    const res = await request(routes, "/api/v1/openapi.json", {
      tenantId: "tenant-1",
      userId: "user-1",
    });
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=60");
  });
});

describe("GET /api/v1/openapi.json — authenticated, with entity types", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Each test gets a fresh route instance so the base spec cache resets
    mockReadFile.mockResolvedValue(JSON.stringify(BASE_SPEC));
  });

  it("merges entity paths into the combined spec", async () => {
    const entries = new Map<string, EntityDefinition>([
      ["product", PRODUCT_ENTITY],
    ]);
    const routes = buildRoutes(makeOntologyCache(entries));
    const res = await request(routes, "/api/v1/openapi.json", {
      tenantId: "tenant-1",
      userId: "user-1",
    });
    const body = await res.json() as { paths: Record<string, unknown> };
    expect(body.paths).toHaveProperty("/api/v1/data/product");
    expect(body.paths).toHaveProperty("/api/v1/data/product/{recordId}");
  });

  it("preserves the original base spec paths alongside entity paths", async () => {
    const entries = new Map<string, EntityDefinition>([["product", PRODUCT_ENTITY]]);
    const routes = buildRoutes(makeOntologyCache(entries));
    const res = await request(routes, "/api/v1/openapi.json", {
      tenantId: "tenant-1",
      userId: "user-1",
    });
    const body = await res.json() as { paths: Record<string, unknown> };
    expect(body.paths).toHaveProperty("/api/v1/data/{entityType}");
  });

  it("excludes private (isPublic: false) entity types from the overlay", async () => {
    const entries = new Map<string, EntityDefinition>([
      ["internal-log", PRIVATE_ENTITY],
      ["product",      PRODUCT_ENTITY],
    ]);
    const routes = buildRoutes(makeOntologyCache(entries));
    const res = await request(routes, "/api/v1/openapi.json", {
      tenantId: "tenant-1",
      userId: "user-1",
    });
    const body = await res.json() as { paths: Record<string, unknown> };
    expect(body.paths).not.toHaveProperty("/api/v1/data/internal-log");
    expect(body.paths).toHaveProperty("/api/v1/data/product");
  });

  it("entity collection path includes GET (list) and POST (create) operations", async () => {
    const entries = new Map<string, EntityDefinition>([["product", PRODUCT_ENTITY]]);
    const routes = buildRoutes(makeOntologyCache(entries));
    const res = await request(routes, "/api/v1/openapi.json", {
      tenantId: "tenant-1",
      userId: "user-1",
    });
    const body = await res.json() as { paths: Record<string, { get?: unknown; post?: unknown }> };
    const collection = body.paths["/api/v1/data/product"];
    expect(collection).toHaveProperty("get");
    expect(collection).toHaveProperty("post");
  });

  it("entity single-record path includes GET, PATCH, and DELETE operations", async () => {
    const entries = new Map<string, EntityDefinition>([["product", PRODUCT_ENTITY]]);
    const routes = buildRoutes(makeOntologyCache(entries));
    const res = await request(routes, "/api/v1/openapi.json", {
      tenantId: "tenant-1",
      userId: "user-1",
    });
    const body = await res.json() as {
      paths: Record<string, { get?: unknown; patch?: unknown; delete?: unknown }>;
    };
    const record = body.paths["/api/v1/data/product/{recordId}"];
    expect(record).toHaveProperty("get");
    expect(record).toHaveProperty("patch");
    expect(record).toHaveProperty("delete");
  });

  it("entity paths carry the correct operationId", async () => {
    const entries = new Map<string, EntityDefinition>([["product", PRODUCT_ENTITY]]);
    const routes = buildRoutes(makeOntologyCache(entries));
    const res = await request(routes, "/api/v1/openapi.json", {
      tenantId: "tenant-1",
      userId: "user-1",
    });
    const body = await res.json() as {
      paths: Record<string, { get?: { operationId?: string } }>;
    };
    expect(body.paths["/api/v1/data/product"]?.get?.operationId).toBe("listProduct");
  });

  it("entity operationId uses PascalCase for hyphenated slugs", async () => {
    const hyphenEntity: EntityDefinition = {
      ...PRODUCT_ENTITY,
      id: "ent-3",
      name: "Product Variant",
      slug: "product-variant",
    };
    const entries = new Map<string, EntityDefinition>([["product-variant", hyphenEntity]]);
    const routes = buildRoutes(makeOntologyCache(entries));
    const res = await request(routes, "/api/v1/openapi.json", {
      tenantId: "tenant-1",
      userId: "user-1",
    });
    const body = await res.json() as {
      paths: Record<string, { get?: { operationId?: string } }>;
    };
    expect(body.paths["/api/v1/data/product-variant"]?.get?.operationId)
      .toBe("listProductVariant");
  });

  it("entity field definitions appear in the item schema properties", async () => {
    const entries = new Map<string, EntityDefinition>([["product", PRODUCT_ENTITY]]);
    const routes = buildRoutes(makeOntologyCache(entries));
    const res = await request(routes, "/api/v1/openapi.json", {
      tenantId: "tenant-1",
      userId: "user-1",
    });
    const body = await res.json() as {
      paths: Record<string, {
        get?: {
          responses?: {
            "200"?: {
              content?: {
                "application/json"?: {
                  schema?: {
                    properties?: {
                      data?: {
                        items?: {
                          properties?: Record<string, unknown>;
                        };
                      };
                    };
                  };
                };
              };
            };
          };
        };
      }>;
    };

    const itemProperties =
      body.paths["/api/v1/data/product"]?.get?.responses?.["200"]?.content?.["application/json"]
        ?.schema?.properties?.data?.items?.properties;

    expect(itemProperties).toHaveProperty("sku");
    expect(itemProperties).toHaveProperty("price");
    // Standard scaffold fields are always present
    expect(itemProperties).toHaveProperty("id");
    expect(itemProperties).toHaveProperty("tenantId");
    expect(itemProperties).toHaveProperty("createdAt");
    expect(itemProperties).toHaveProperty("updatedAt");
  });

  it("nullable fields have nullable: true in the schema", async () => {
    const entries = new Map<string, EntityDefinition>([["product", PRODUCT_ENTITY]]);
    const routes = buildRoutes(makeOntologyCache(entries));
    const res = await request(routes, "/api/v1/openapi.json", {
      tenantId: "tenant-1",
      userId: "user-1",
    });
    const body = await res.json() as {
      paths: Record<string, {
        get?: {
          responses?: {
            "200"?: {
              content?: {
                "application/json"?: {
                  schema?: {
                    properties?: {
                      data?: {
                        items?: {
                          properties?: Record<string, { nullable?: boolean }>;
                        };
                      };
                    };
                  };
                };
              };
            };
          };
        };
      }>;
    };

    const itemProperties =
      body.paths["/api/v1/data/product"]?.get?.responses?.["200"]?.content?.["application/json"]
        ?.schema?.properties?.data?.items?.properties;

    expect(itemProperties?.["price"]?.nullable).toBe(true);
    expect(itemProperties?.["sku"]?.nullable).toBeUndefined();
  });

  it("returns 503 with SPEC_NOT_FOUND when the merged spec file does not exist", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    const routes = buildRoutes(makeOntologyCache());
    const res = await request(routes, "/api/v1/openapi.json", {
      tenantId: "tenant-1",
      userId: "user-1",
    });
    expect(res.status).toBe(503);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("SPEC_NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// Per-service spec endpoint — GET /api/v1/openapi/:service.json
// ---------------------------------------------------------------------------

describe("GET /api/v1/openapi/:service.json — per-service specs", () => {
  const SERVICE_SPEC = { openapi: "3.0.3", info: { title: "Auth Service", version: "1.0.0" }, paths: {} };

  beforeEach(() => {
    vi.clearAllMocks();
    mockReadFile.mockResolvedValue(JSON.stringify(SERVICE_SPEC));
  });

  it("returns 200 with valid JSON for a known service", async () => {
    const routes = buildRoutes(makeOntologyCache());
    const res = await request(routes, "/api/v1/openapi/auth.json");
    expect(res.status).toBe(200);
    const body = await res.json() as typeof SERVICE_SPEC;
    expect(body.openapi).toBe("3.0.3");
  });

  it("sets Content-Type: application/json", async () => {
    const routes = buildRoutes(makeOntologyCache());
    const res = await request(routes, "/api/v1/openapi/auth.json");
    expect(res.headers.get("Content-Type")).toContain("application/json");
  });

  it("returns Cache-Control: public, max-age=300", async () => {
    const routes = buildRoutes(makeOntologyCache());
    const res = await request(routes, "/api/v1/openapi/auth.json");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
  });

  it("returns 404 for an unknown service name", async () => {
    const routes = buildRoutes(makeOntologyCache());
    const res = await request(routes, "/api/v1/openapi/evil.json");
    expect(res.status).toBe(404);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("returns 503 when the service spec file does not exist on disk", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    const routes = buildRoutes(makeOntologyCache());
    const res = await request(routes, "/api/v1/openapi/gateway.json");
    expect(res.status).toBe(503);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("SPEC_NOT_FOUND");
  });

  it.each(["gateway", "auth", "ingestion", "ontology", "pipeline", "execution", "app", "logging", "plugin"])(
    "allows service '%s'",
    async (service) => {
      const routes = buildRoutes(makeOntologyCache());
      const res = await request(routes, `/api/v1/openapi/${service}.json`);
      // 200 means the service was in the allowlist; the mock returns valid JSON
      expect(res.status).toBe(200);
    },
  );
});
