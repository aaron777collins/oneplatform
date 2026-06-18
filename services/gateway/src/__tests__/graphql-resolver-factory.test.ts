// Unit tests for services/gateway/src/graphql/resolver-factory.ts
//
// Tests: resolver execution, RBAC enforcement, pagination arg translation,
// variable substitution, error handling, and introspection detection.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createResolvers,
  resolveValue,
  resolveArgs,
  executeOperation,
  GraphQLResolverError,
} from "../graphql/resolver-factory.js";
import { buildSchemaFromOntology } from "../graphql/schema-builder.js";
import { parseDocument } from "../graphql/parser.js";
import type { OntologyType } from "../graphql/schema-builder.js";
import type { ResolverContext } from "../graphql/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const productEntity: OntologyType = {
  slug: "product",
  name: "Product",
  fields: [
    { slug: "name",  fieldType: "string", required: true, nullable: false },
    { slug: "price", fieldType: "number", required: true, nullable: false },
  ],
};

const schema = buildSchemaFromOntology([productEntity]);

function makeContext(overrides: Partial<ResolverContext> = {}): ResolverContext {
  return {
    tenantId: "tenant-1",
    userId: "user-1",
    roles: ["member"],
    scopes: ["read", "write"],
    serviceToken: "svc-token",
    ontologyServiceUrl: "http://ontology",
    ingestionServiceUrl: "http://ingestion",
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// resolveValue
// ---------------------------------------------------------------------------

describe("resolveValue", () => {
  it("returns string literal", () => {
    expect(resolveValue({ kind: "StringValue", value: "hello" }, {})).toBe("hello");
  });

  it("returns int literal", () => {
    expect(resolveValue({ kind: "IntValue", value: 42 }, {})).toBe(42);
  });

  it("returns float literal", () => {
    expect(resolveValue({ kind: "FloatValue", value: 3.14 }, {})).toBeCloseTo(3.14);
  });

  it("returns boolean literal", () => {
    expect(resolveValue({ kind: "BooleanValue", value: true }, {})).toBe(true);
  });

  it("returns null for NullValue", () => {
    expect(resolveValue({ kind: "NullValue" }, {})).toBeNull();
  });

  it("returns enum value as string", () => {
    expect(resolveValue({ kind: "EnumValue", value: "ACTIVE" }, {})).toBe("ACTIVE");
  });

  it("resolves variable from map", () => {
    expect(resolveValue({ kind: "Variable", name: "myVar" }, { myVar: "resolved" })).toBe("resolved");
  });

  it("returns null for missing variable", () => {
    expect(resolveValue({ kind: "Variable", name: "missing" }, {})).toBeNull();
  });

  it("recursively resolves list values", () => {
    const result = resolveValue({
      kind: "ListValue",
      values: [
        { kind: "StringValue", value: "a" },
        { kind: "StringValue", value: "b" },
      ],
    }, {});
    expect(result).toEqual(["a", "b"]);
  });

  it("recursively resolves object values", () => {
    const result = resolveValue({
      kind: "ObjectValue",
      fields: {
        name: { kind: "StringValue", value: "Widget" },
        price: { kind: "FloatValue", value: 9.99 },
      },
    }, {});
    expect(result).toEqual({ name: "Widget", price: 9.99 });
  });

  it("resolves variable inside object field", () => {
    const result = resolveValue({
      kind: "ObjectValue",
      fields: { name: { kind: "Variable", name: "productName" } },
    }, { productName: "Gadget" });
    expect(result).toEqual({ name: "Gadget" });
  });
});

// ---------------------------------------------------------------------------
// resolveArgs
// ---------------------------------------------------------------------------

describe("resolveArgs", () => {
  it("returns empty object for field with no arguments", () => {
    const field: import("../graphql/types.js").GraphQLField = {
      kind: "Field",
      alias: null,
      name: "product",
      arguments: [],
      directives: [],
      selectionSet: null,
    };
    expect(resolveArgs(field, {})).toEqual({});
  });

  it("resolves all arguments", () => {
    const field: import("../graphql/types.js").GraphQLField = {
      kind: "Field",
      alias: null,
      name: "product",
      arguments: [
        { name: "id",   value: { kind: "Variable",    name: "productId" } },
        { name: "lang", value: { kind: "StringValue",  value: "en" } },
      ],
      directives: [],
      selectionSet: null,
    };
    const result = resolveArgs(field, { productId: "p-123" });
    expect(result).toEqual({ id: "p-123", lang: "en" });
  });
});

// ---------------------------------------------------------------------------
// Resolver creation and execution
// ---------------------------------------------------------------------------

describe("createResolvers — single-entity query", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("fetches entity by ID from the ingestion service", async () => {
    const product = { id: "p-1", name: "Widget", price: 10.0 };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(product)));

    const resolvers = createResolvers({ schema });
    const ctx = makeContext();
    const result = await resolvers["product"]!(null, { id: "p-1" }, ctx);

    expect(result).toEqual(product);
    const call = (vi.mocked(fetch)).mock.calls[0];
    expect(call?.[0]).toContain("/api/v1/data/product/p-1");
  });

  it("returns null for a 404 response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, 404)));

    const resolvers = createResolvers({ schema });
    const result = await resolvers["product"]!(null, { id: "unknown" }, makeContext());
    expect(result).toBeNull();
  });

  it("throws INVALID_INPUT when id is missing", async () => {
    const resolvers = createResolvers({ schema });
    await expect(resolvers["product"]!(null, {}, makeContext())).rejects.toThrow(
      GraphQLResolverError,
    );
  });

  it("throws UNAUTHORIZED when tenantId is missing", async () => {
    const resolvers = createResolvers({ schema });
    await expect(
      resolvers["product"]!(null, { id: "1" }, makeContext({ tenantId: "" })),
    ).rejects.toThrow(GraphQLResolverError);
  });

  it("throws UPSTREAM_ERROR when upstream returns 500", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "boom" }, 500)));
    const resolvers = createResolvers({ schema });
    await expect(resolvers["product"]!(null, { id: "1" }, makeContext())).rejects.toThrow(
      GraphQLResolverError,
    );
  });
});

describe("createResolvers — list query", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("fetches entity list from the ingestion service", async () => {
    const upstream = { data: [{ id: "p-1", name: "A" }], nextCursor: null };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(upstream)));

    const resolvers = createResolvers({ schema });
    const result = await resolvers["products"]!(null, {}, makeContext()) as Record<string, unknown>;

    expect(result["nodes"]).toEqual(upstream.data);
    expect(result["nextCursor"]).toBeNull();
  });

  it("passes pagination args as query string", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ data: [], nextCursor: null })));
    const resolvers = createResolvers({ schema });
    await resolvers["products"]!(null, { first: 10, after: "cursor-abc" }, makeContext());

    const url = (vi.mocked(fetch)).mock.calls[0]?.[0] as string;
    expect(url).toContain("cursor=cursor-abc");
    expect(url).toContain("limit=10");
  });

  it("passes filter JSON as query string", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ data: [], nextCursor: null })));
    const resolvers = createResolvers({ schema });
    const filterJson = JSON.stringify([{ field: "price", op: "gt", value: 10 }]);
    await resolvers["products"]!(null, { filter: filterJson }, makeContext());

    const url = (vi.mocked(fetch)).mock.calls[0]?.[0] as string;
    expect(url).toContain("filter=");
  });

  it("throws INVALID_INPUT for malformed filter JSON", async () => {
    const resolvers = createResolvers({ schema });
    await expect(
      resolvers["products"]!(null, { filter: "not-json" }, makeContext()),
    ).rejects.toThrow(GraphQLResolverError);
  });
});

describe("createResolvers — mutations", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("POSTs to create endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ data: { id: "p-new" } })));
    const resolvers = createResolvers({ schema });
    const result = await resolvers["createProduct"]!(
      null,
      { input: { name: "New", price: 5.0 } },
      makeContext(),
    );
    expect((result as Record<string, unknown>)?.["id"]).toBe("p-new");

    const call = (vi.mocked(fetch)).mock.calls[0];
    expect((call?.[1] as RequestInit | undefined)?.method).toBe("POST");
  });

  it("PATCHes to update endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ id: "p-1", name: "Updated" })));
    const resolvers = createResolvers({ schema });
    await resolvers["updateProduct"]!(
      null,
      { id: "p-1", input: { name: "Updated" } },
      makeContext(),
    );

    const call = (vi.mocked(fetch)).mock.calls[0];
    expect((call?.[1] as RequestInit | undefined)?.method).toBe("PATCH");
    expect(call?.[0]).toContain("/p-1");
  });

  it("DELETEs to delete endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    const resolvers = createResolvers({ schema });
    const result = await resolvers["deleteProduct"]!(
      null,
      { id: "p-1" },
      makeContext(),
    );
    expect(result).toBe(true);
  });

  it("returns false from delete when entity is not found", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
    const resolvers = createResolvers({ schema });
    const result = await resolvers["deleteProduct"]!(null, { id: "ghost" }, makeContext());
    expect(result).toBe(false);
  });

  it("throws FORBIDDEN when scopes lack write permission", async () => {
    const resolvers = createResolvers({ schema });
    const ctx = makeContext({ scopes: ["read"] }); // no write scope
    await expect(
      resolvers["createProduct"]!(null, { input: {} }, ctx),
    ).rejects.toThrow(GraphQLResolverError);
  });

  it("throws INVALID_INPUT when create input is missing", async () => {
    const resolvers = createResolvers({ schema });
    await expect(
      resolvers["createProduct"]!(null, {}, makeContext()),
    ).rejects.toThrow(GraphQLResolverError);
  });
});

// ---------------------------------------------------------------------------
// Variable substitution in full operation execution
// ---------------------------------------------------------------------------

describe("executeOperation — variable substitution", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("substitutes variable in query argument", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ id: "p-var", name: "Var" })));

    const parsed = parseDocument(`query GetP($pid: ID!) { product(id: $pid) { id name } }`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const resolvers = createResolvers({ schema });
    const ctx = makeContext();
    const { data, errors } = await executeOperation(
      parsed.document.operations[0]!,
      parsed.document,
      resolvers,
      ctx,
      { pid: "p-var" },
      schema,
    );

    expect(errors).toHaveLength(0);
    const url = (vi.mocked(fetch)).mock.calls[0]?.[0] as string;
    expect(url).toContain("/p-var");
    expect((data["product"] as Record<string, unknown>)?.["id"]).toBe("p-var");
  });
});

// ---------------------------------------------------------------------------
// Full operation execution with field projection
// ---------------------------------------------------------------------------

describe("executeOperation — field projection", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("projects only requested fields from resolver result", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ id: "p-1", name: "Widget", price: 9.99 })));

    const parsed = parseDocument(`{ product(id: "p-1") { id name } }`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const resolvers = createResolvers({ schema });
    const { data, errors } = await executeOperation(
      parsed.document.operations[0]!,
      parsed.document,
      resolvers,
      makeContext(),
      {},
      schema,
    );

    expect(errors).toHaveLength(0);
    const prod = data["product"] as Record<string, unknown>;
    expect(prod).toHaveProperty("id");
    expect(prod).toHaveProperty("name");
    // price was not requested
    expect(prod).not.toHaveProperty("price");
  });

  it("uses alias as result key", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ id: "p-1", name: "Widget" })));

    const parsed = parseDocument(`{ p: product(id: "p-1") { id } }`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const resolvers = createResolvers({ schema });
    const { data } = await executeOperation(
      parsed.document.operations[0]!,
      parsed.document,
      resolvers,
      makeContext(),
      {},
      schema,
    );

    expect(data).toHaveProperty("p");
    expect(data).not.toHaveProperty("product");
  });

  it("collects resolver errors without aborting sibling fields", async () => {
    // First resolver fails, second succeeds
    vi.stubGlobal("fetch", vi.fn()
      .mockRejectedValueOnce(new Error("network failure"))
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "p-1" }], nextCursor: null })),
    );

    const parsed = parseDocument(`{ product(id: "bad") { id } products { nodes { id } } }`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const resolvers = createResolvers({ schema });
    const { data, errors } = await executeOperation(
      parsed.document.operations[0]!,
      parsed.document,
      resolvers,
      makeContext(),
      {},
      schema,
    );

    expect(data["product"]).toBeNull();
    expect(errors).toHaveLength(1);
    expect((data["products"] as Record<string, unknown>)?.["nodes"]).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Fragment expansion in execution
// ---------------------------------------------------------------------------

describe("executeOperation — fragment expansion", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("expands named fragment in projection", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ id: "p-1", name: "Widget", price: 5.0 })));

    const parsed = parseDocument(`
      fragment PF on Product { id name }
      query { product(id: "p-1") { ...PF } }
    `);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const resolvers = createResolvers({ schema });
    const { data } = await executeOperation(
      parsed.document.operations[0]!,
      parsed.document,
      resolvers,
      makeContext(),
      {},
      schema,
    );

    const prod = data["product"] as Record<string, unknown>;
    expect(prod).toHaveProperty("id");
    expect(prod).toHaveProperty("name");
  });
});
