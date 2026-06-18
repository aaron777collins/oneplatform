// Unit tests for services/gateway/src/graphql/introspection.ts
//
// Verifies that the introspection result has the shape expected by GraphQL
// tooling, and that the introspection query detector works correctly.

import { describe, it, expect } from "vitest";
import { buildIntrospectionResult, isIntrospectionQuery } from "../graphql/introspection.js";
import { buildSchemaFromOntology } from "../graphql/schema-builder.js";
import { parseDocument } from "../graphql/parser.js";
import type { OntologyType } from "../graphql/schema-builder.js";

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

// ---------------------------------------------------------------------------
// buildIntrospectionResult
// ---------------------------------------------------------------------------

describe("buildIntrospectionResult — structure", () => {
  it("returns an object with __schema key", () => {
    const result = buildIntrospectionResult(schema);
    expect(result).toHaveProperty("__schema");
  });

  it("sets queryType and mutationType", () => {
    const { __schema } = buildIntrospectionResult(schema);
    expect(__schema.queryType).toEqual({ name: "Query" });
    expect(__schema.mutationType).toEqual({ name: "Mutation" });
    expect(__schema.subscriptionType).toBeNull();
  });

  it("includes built-in scalar types", () => {
    const { __schema } = buildIntrospectionResult(schema);
    const typeNames = __schema.types.map((t) => t.name);
    for (const scalar of ["String", "Int", "Float", "Boolean", "ID", "JSON"]) {
      expect(typeNames).toContain(scalar);
    }
  });

  it("includes generated entity types", () => {
    const { __schema } = buildIntrospectionResult(schema);
    const typeNames = __schema.types.map((t) => t.name);
    expect(typeNames).toContain("Product");
    expect(typeNames).toContain("ProductConnection");
  });

  it("includes Query and Mutation pseudo-types", () => {
    const { __schema } = buildIntrospectionResult(schema);
    const typeNames = __schema.types.map((t) => t.name);
    expect(typeNames).toContain("Query");
    expect(typeNames).toContain("Mutation");
  });

  it("marks built-in scalars as SCALAR kind", () => {
    const { __schema } = buildIntrospectionResult(schema);
    const stringType = __schema.types.find((t) => t.name === "String");
    expect(stringType?.kind).toBe("SCALAR");
  });

  it("marks generated entity types as OBJECT kind", () => {
    const { __schema } = buildIntrospectionResult(schema);
    const productType = __schema.types.find((t) => t.name === "Product");
    expect(productType?.kind).toBe("OBJECT");
  });

  it("Product type has expected fields", () => {
    const { __schema } = buildIntrospectionResult(schema);
    const productType = __schema.types.find((t) => t.name === "Product");
    if (!productType?.fields) throw new Error("no fields");
    const fieldNames = productType.fields.map((f) => f.name);
    expect(fieldNames).toContain("id");
    expect(fieldNames).toContain("name");
    expect(fieldNames).toContain("price");
  });

  it("Query type has expected field names", () => {
    const { __schema } = buildIntrospectionResult(schema);
    const queryType = __schema.types.find((t) => t.name === "Query");
    if (!queryType?.fields) throw new Error("no fields");
    const fieldNames = queryType.fields.map((f) => f.name);
    expect(fieldNames).toContain("product");
    expect(fieldNames).toContain("products");
  });

  it("Mutation type has create/update/delete fields", () => {
    const { __schema } = buildIntrospectionResult(schema);
    const mutationType = __schema.types.find((t) => t.name === "Mutation");
    if (!mutationType?.fields) throw new Error("no fields");
    const fieldNames = mutationType.fields.map((f) => f.name);
    expect(fieldNames).toContain("createProduct");
    expect(fieldNames).toContain("updateProduct");
    expect(fieldNames).toContain("deleteProduct");
  });

  it("includes skip and include directives", () => {
    const { __schema } = buildIntrospectionResult(schema);
    const directiveNames = __schema.directives.map((d) => d.name);
    expect(directiveNames).toContain("skip");
    expect(directiveNames).toContain("include");
  });

  it("non-nullable fields have NON_NULL type wrapper", () => {
    const { __schema } = buildIntrospectionResult(schema);
    const productType = __schema.types.find((t) => t.name === "Product");
    if (!productType?.fields) throw new Error("no fields");
    const nameField = productType.fields.find((f) => f.name === "name");
    // name is required=true, nullable=false → should be NON_NULL
    expect(nameField?.type.kind).toBe("NON_NULL");
  });

  it("nullable fields do not have NON_NULL wrapper", () => {
    const schemaWithNullable = buildSchemaFromOntology([{
      slug: "product",
      name: "Product",
      fields: [{ slug: "desc", fieldType: "string", required: false, nullable: true }],
    }]);
    const { __schema } = buildIntrospectionResult(schemaWithNullable);
    const productType = __schema.types.find((t) => t.name === "Product");
    if (!productType?.fields) throw new Error("no fields");
    const descField = productType.fields.find((f) => f.name === "desc");
    expect(descField?.type.kind).not.toBe("NON_NULL");
  });
});

// ---------------------------------------------------------------------------
// isIntrospectionQuery
// ---------------------------------------------------------------------------

describe("isIntrospectionQuery", () => {
  it("returns true for __schema query", () => {
    const result = parseDocument(`{ __schema { queryType { name } } }`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(isIntrospectionQuery(result.document)).toBe(true);
  });

  it("returns true for __type query", () => {
    const result = parseDocument(`query IntrospectType { __type(name: "Product") { name kind } }`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(isIntrospectionQuery(result.document)).toBe(true);
  });

  it("returns false for a normal data query", () => {
    const result = parseDocument(`{ product(id: "1") { id name } }`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(isIntrospectionQuery(result.document)).toBe(false);
  });

  it("returns false for a mutation", () => {
    const result = parseDocument(`mutation { createProduct(input: {}) { id } }`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(isIntrospectionQuery(result.document)).toBe(false);
  });

  it("returns false for empty document", () => {
    const result = parseDocument(``);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(isIntrospectionQuery(result.document)).toBe(false);
  });
});
