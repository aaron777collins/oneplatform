// Unit tests for services/gateway/src/graphql/schema-builder.ts
//
// Verifies that ontology entity snapshots are correctly translated into
// GraphQL type definitions, query/mutation field maps, and SDL output.

import { describe, it, expect } from "vitest";
import { buildSchemaFromOntology, buildTypeDefinition, schemaToSdl } from "../graphql/schema-builder.js";
import type { OntologyType } from "../graphql/schema-builder.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const productEntity: OntologyType = {
  slug: "product",
  name: "Product",
  fields: [
    { slug: "name",       fieldType: "string",  required: true,  nullable: false },
    { slug: "price",      fieldType: "number",  required: true,  nullable: false },
    { slug: "active",     fieldType: "boolean", required: false, nullable: true  },
    { slug: "created_at", fieldType: "date",    required: false, nullable: true  },
    { slug: "metadata",   fieldType: "json",    required: false, nullable: true  },
    { slug: "tags",       fieldType: "array",   required: false, nullable: true  },
    { slug: "category_id",fieldType: "reference",required: false,nullable: true  },
  ],
};

const orderEntity: OntologyType = {
  slug: "customer_order",
  name: "CustomerOrder",
  fields: [
    { slug: "total", fieldType: "number",  required: true, nullable: false },
    { slug: "notes", fieldType: "string",  required: false, nullable: true },
  ],
};

// ---------------------------------------------------------------------------
// Schema generation
// ---------------------------------------------------------------------------

describe("buildSchemaFromOntology — type generation", () => {
  it("generates an Object type for each entity", () => {
    const schema = buildSchemaFromOntology([productEntity]);
    expect(schema.types.has("Product")).toBe(true);
    const typeDef = schema.types.get("Product");
    expect(typeDef?.kind).toBe("OBJECT");
  });

  it("includes system-generated fields on every type", () => {
    const schema = buildSchemaFromOntology([productEntity]);
    const typeDef = schema.types.get("Product");
    if (!typeDef || typeDef.kind !== "OBJECT") throw new Error("not an object type");
    expect(typeDef.fields).toHaveProperty("id");
    expect(typeDef.fields).toHaveProperty("_tenantId");
    expect(typeDef.fields).toHaveProperty("_createdAt");
    expect(typeDef.fields).toHaveProperty("_updatedAt");
  });

  it("maps ontology field types to correct GraphQL types", () => {
    const schema = buildSchemaFromOntology([productEntity]);
    const typeDef = schema.types.get("Product");
    if (!typeDef || typeDef.kind !== "OBJECT") throw new Error("not an object type");

    expect(typeDef.fields["name"]?.type).toBe("String");
    expect(typeDef.fields["price"]?.type).toBe("Float");
    expect(typeDef.fields["active"]?.type).toBe("Boolean");
    expect(typeDef.fields["created_at"]?.type).toBe("String"); // date → String (ISO-8601)
    expect(typeDef.fields["metadata"]?.type).toBe("JSON");
    expect(typeDef.fields["tags"]?.type).toBe("String");
    expect(typeDef.fields["tags"]?.isList).toBe(true);
    expect(typeDef.fields["category_id"]?.type).toBe("ID");
  });

  it("sets nullable correctly from required + nullable flags", () => {
    const schema = buildSchemaFromOntology([productEntity]);
    const typeDef = schema.types.get("Product");
    if (!typeDef || typeDef.kind !== "OBJECT") throw new Error("not an object type");

    // required=true, nullable=false → not nullable
    expect(typeDef.fields["name"]?.nullable).toBe(false);
    // required=false, nullable=true → nullable
    expect(typeDef.fields["active"]?.nullable).toBe(true);
  });

  it("generates a Connection type for list queries", () => {
    const schema = buildSchemaFromOntology([productEntity]);
    expect(schema.types.has("ProductConnection")).toBe(true);
    const conn = schema.types.get("ProductConnection");
    if (!conn || conn.kind !== "OBJECT") throw new Error("not an object type");
    expect(conn.fields).toHaveProperty("nodes");
    expect(conn.fields).toHaveProperty("nextCursor");
    expect(conn.fields).toHaveProperty("total");
  });

  it("generates types for multi-word slug using PascalCase", () => {
    const schema = buildSchemaFromOntology([orderEntity]);
    expect(schema.types.has("CustomerOrder")).toBe(true);
  });

  it("handles empty field list", () => {
    const schema = buildSchemaFromOntology([{ slug: "empty", name: "Empty", fields: [] }]);
    expect(schema.types.has("Empty")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Query generation
// ---------------------------------------------------------------------------

describe("buildSchemaFromOntology — query fields", () => {
  it("generates a single-entity query field", () => {
    const schema = buildSchemaFromOntology([productEntity]);
    expect(schema.queryFields).toHaveProperty("product");
    expect(schema.queryFields["product"]?.args).toHaveProperty("id");
    expect(schema.queryFields["product"]?.args?.["id"]?.nullable).toBe(false);
  });

  it("generates a list query field with pagination args", () => {
    const schema = buildSchemaFromOntology([productEntity]);
    expect(schema.queryFields).toHaveProperty("products");
    const listField = schema.queryFields["products"];
    expect(listField?.args).toHaveProperty("after");
    expect(listField?.args).toHaveProperty("first");
    expect(listField?.args).toHaveProperty("filter");
    expect(listField?.args).toHaveProperty("sort");
  });

  it("pluralises correctly for multi-word slugs", () => {
    const schema = buildSchemaFromOntology([orderEntity]);
    // "customer_order" → camel "customerOrder" → plural "customerOrders"
    expect(schema.queryFields).toHaveProperty("customerOrders");
  });
});

// ---------------------------------------------------------------------------
// Mutation generation
// ---------------------------------------------------------------------------

describe("buildSchemaFromOntology — mutation fields", () => {
  it("generates create mutation", () => {
    const schema = buildSchemaFromOntology([productEntity]);
    expect(schema.mutationFields).toHaveProperty("createProduct");
    const create = schema.mutationFields["createProduct"];
    expect(create?.args).toHaveProperty("input");
    expect(create?.args?.["input"]?.nullable).toBe(false);
  });

  it("generates update mutation with id and input args", () => {
    const schema = buildSchemaFromOntology([productEntity]);
    const update = schema.mutationFields["updateProduct"];
    expect(update?.args).toHaveProperty("id");
    expect(update?.args).toHaveProperty("input");
  });

  it("generates delete mutation with id arg returning Boolean", () => {
    const schema = buildSchemaFromOntology([productEntity]);
    const del = schema.mutationFields["deleteProduct"];
    expect(del?.type).toBe("Boolean");
    expect(del?.args).toHaveProperty("id");
  });
});

// ---------------------------------------------------------------------------
// fieldToEntitySlug mapping
// ---------------------------------------------------------------------------

describe("buildSchemaFromOntology — fieldToEntitySlug", () => {
  it("maps all query and mutation field names back to entity slugs", () => {
    const schema = buildSchemaFromOntology([productEntity]);
    expect(schema.fieldToEntitySlug.get("product")).toBe("product");
    expect(schema.fieldToEntitySlug.get("products")).toBe("product");
    expect(schema.fieldToEntitySlug.get("createProduct")).toBe("product");
    expect(schema.fieldToEntitySlug.get("updateProduct")).toBe("product");
    expect(schema.fieldToEntitySlug.get("deleteProduct")).toBe("product");
  });
});

// ---------------------------------------------------------------------------
// Multiple entities
// ---------------------------------------------------------------------------

describe("buildSchemaFromOntology — multiple entities", () => {
  it("generates independent type trees for each entity", () => {
    const schema = buildSchemaFromOntology([productEntity, orderEntity]);
    expect(schema.types.has("Product")).toBe(true);
    expect(schema.types.has("CustomerOrder")).toBe(true);
    expect(schema.queryFields).toHaveProperty("product");
    expect(schema.queryFields).toHaveProperty("customerOrder");
  });
});

// ---------------------------------------------------------------------------
// buildTypeDefinition helper
// ---------------------------------------------------------------------------

describe("buildTypeDefinition", () => {
  it("returns correct queryName and queryPluralName", () => {
    const def = buildTypeDefinition({
      id: "1",
      name: "Product",
      slug: "product",
      version: 1,
      isPublic: false,
      fields: [{ slug: "name", fieldType: "string", required: true, nullable: false }],
    });
    expect(def.name).toBe("Product");
    expect(def.queryName).toBe("product");
    expect(def.queryPluralName).toBe("products");
  });

  it("includes system fields and entity fields in the mapping", () => {
    const def = buildTypeDefinition({
      id: "1", name: "Product", slug: "product", version: 1, isPublic: false,
      fields: [{ slug: "price", fieldType: "number", required: true, nullable: false }],
    });
    const fieldNames = def.fields.map((f) => f.ontologyField);
    expect(fieldNames).toContain("id");
    expect(fieldNames).toContain("price");
  });
});

// ---------------------------------------------------------------------------
// SDL output
// ---------------------------------------------------------------------------

describe("schemaToSdl", () => {
  it("produces valid SDL with type and query definitions", () => {
    const schema = buildSchemaFromOntology([productEntity]);
    const sdl = schemaToSdl(schema);
    expect(sdl).toContain("type Product {");
    expect(sdl).toContain("type Query {");
    expect(sdl).toContain("type Mutation {");
    expect(sdl).toContain("product(");
    expect(sdl).toContain("createProduct(");
  });

  it("does not include built-in scalars in type block", () => {
    const schema = buildSchemaFromOntology([productEntity]);
    const sdl = schemaToSdl(schema);
    expect(sdl).not.toMatch(/^type String \{/m);
    expect(sdl).not.toMatch(/^type Boolean \{/m);
  });
});
