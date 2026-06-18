// Unit tests for services/gateway/src/graphql/parser.ts
//
// Covers: query/mutation parsing, alias, arguments, variables, fragments,
// inline fragments, depth limiting, and schema-aware validation.

import { describe, it, expect } from "vitest";
import { parseDocument, validateDocument } from "../graphql/parser.js";
import { buildSchemaFromOntology } from "../graphql/schema-builder.js";
import type { OntologyType } from "../graphql/schema-builder.js";
import type { GraphQLField } from "../graphql/types.js";

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

// Helper that asserts a selection is a plain field (not a spread/inline frag)
function asField(sel: unknown): GraphQLField {
  const s = sel as { kind?: string };
  if (s.kind === "FragmentSpread" || s.kind === "InlineFragment") {
    throw new Error(`Expected GraphQLField but got ${s.kind}`);
  }
  return sel as GraphQLField;
}

// ---------------------------------------------------------------------------
// Basic query parsing
// ---------------------------------------------------------------------------

describe("parseDocument — basic query", () => {
  it("parses an anonymous query", () => {
    const result = parseDocument(`{ product(id: "1") { id name } }`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.operations).toHaveLength(1);
    expect(result.document.operations[0]?.kind).toBe("query");
    expect(result.document.operations[0]?.name).toBeNull();
  });

  it("parses a named query", () => {
    const result = parseDocument(`query GetProduct { product(id: "1") { id } }`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.operations[0]?.name).toBe("GetProduct");
  });

  it("parses a named mutation", () => {
    const result = parseDocument(`mutation CreateProd { createProduct(input: {}) { id } }`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.operations[0]?.kind).toBe("mutation");
  });

  it("parses field aliases", () => {
    const result = parseDocument(`{ p: product(id: "1") { n: name } }`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const field = asField(result.document.operations[0]?.selectionSet.selections[0]);
    expect(field.alias).toBe("p");
    expect(field.name).toBe("product");
    const subField = asField(field.selectionSet?.selections[0]);
    expect(subField.alias).toBe("n");
    expect(subField.name).toBe("name");
  });

  it("parses subscription operation kind", () => {
    const result = parseDocument(`subscription Sub { product(id: "1") { id } }`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.operations[0]?.kind).toBe("subscription");
  });
});

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

describe("parseDocument — arguments", () => {
  it("parses string argument", () => {
    const result = parseDocument(`{ product(id: "abc") { id } }`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const field = asField(result.document.operations[0]?.selectionSet.selections[0]);
    const arg = field.arguments[0];
    expect(arg?.name).toBe("id");
    expect(arg?.value.kind).toBe("StringValue");
    if (arg?.value.kind === "StringValue") expect(arg.value.value).toBe("abc");
  });

  it("parses integer argument", () => {
    const result = parseDocument(`{ products(first: 10) { nodes { id } } }`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const field = asField(result.document.operations[0]?.selectionSet.selections[0]);
    const arg = field.arguments[0];
    expect(arg?.value.kind).toBe("IntValue");
  });

  it("parses boolean argument", () => {
    const result = parseDocument(`{ products(filter: true) { nodes { id } } }`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const field = asField(result.document.operations[0]?.selectionSet.selections[0]);
    const arg = field.arguments[0];
    expect(arg?.value.kind).toBe("BooleanValue");
  });

  it("parses null argument", () => {
    const result = parseDocument(`{ products(filter: null) { nodes { id } } }`);
    expect(result.ok).toBe(true);
  });

  it("parses object argument", () => {
    const result = parseDocument(`{ createProduct(input: { name: "Widget", price: 9.99 }) { id } }`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const field = asField(result.document.operations[0]?.selectionSet.selections[0]);
    const arg = field.arguments[0];
    expect(arg?.value.kind).toBe("ObjectValue");
  });

  it("parses list argument", () => {
    const result = parseDocument(`{ products(sort: ["name", "price"]) { nodes { id } } }`);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------

describe("parseDocument — variables", () => {
  it("parses variable definitions", () => {
    const result = parseDocument(`query GetP($id: ID!) { product(id: $id) { id } }`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const op = result.document.operations[0];
    expect(op?.variableDefinitions).toHaveLength(1);
    expect(op?.variableDefinitions[0]?.name).toBe("id");
    expect(op?.variableDefinitions[0]?.type).toBe("ID");
    expect(op?.variableDefinitions[0]?.nullable).toBe(false);
  });

  it("parses nullable variable definition", () => {
    const result = parseDocument(`query GetP($cursor: String) { products(after: $cursor) { nodes { id } } }`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.operations[0]?.variableDefinitions[0]?.nullable).toBe(true);
  });

  it("parses variable reference in argument", () => {
    const result = parseDocument(`query GetP($id: ID!) { product(id: $id) { id } }`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const field = asField(result.document.operations[0]?.selectionSet.selections[0]);
    const arg = field.arguments[0];
    expect(arg?.value.kind).toBe("Variable");
    if (arg?.value.kind === "Variable") expect(arg.value.name).toBe("id");
  });

  it("parses list variable type", () => {
    const result = parseDocument(`query Batch($ids: [ID!]!) { products { nodes { id } } }`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const varDef = result.document.operations[0]?.variableDefinitions[0];
    expect(varDef?.isList).toBe(true);
    expect(varDef?.nullable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fragments
// ---------------------------------------------------------------------------

describe("parseDocument — fragments", () => {
  it("parses a named fragment definition", () => {
    const result = parseDocument(`
      fragment ProductFields on Product { id name price }
      query GetP { product(id: "1") { ...ProductFields } }
    `);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.fragments.has("ProductFields")).toBe(true);
    const frag = result.document.fragments.get("ProductFields");
    expect(frag?.typeCondition).toBe("Product");
  });

  it("parses a fragment spread in selection set", () => {
    const result = parseDocument(`
      fragment PF on Product { id }
      query { product(id: "1") { ...PF } }
    `);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const field = asField(result.document.operations[0]?.selectionSet.selections[0]);
    const sel = field.selectionSet?.selections[0];
    expect(sel?.kind).toBe("FragmentSpread");
  });

  it("parses an inline fragment", () => {
    const result = parseDocument(`
      query { product(id: "1") { ... on Product { id name } } }
    `);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const field = asField(result.document.operations[0]?.selectionSet.selections[0]);
    const sel = field.selectionSet?.selections[0];
    expect(sel?.kind).toBe("InlineFragment");
    if (sel?.kind === "InlineFragment") {
      expect(sel.typeCondition).toBe("Product");
    }
  });

  it("returns error for duplicate fragment names", () => {
    const result = parseDocument(`
      fragment F on Product { id }
      fragment F on Product { name }
      query { product(id: "1") { ...F } }
    `);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.message.includes("Duplicate fragment"))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Depth limiting
// ---------------------------------------------------------------------------

describe("parseDocument — depth limiting", () => {
  it("accepts a query at exactly maxDepth", () => {
    // 5 field levels: a(1).b(2).c(3).d(4).e(5)
    const q = `{ a { b { c { d { e } } } } }`;
    const result = parseDocument(q, { maxDepth: 5 });
    expect(result.ok).toBe(true);
  });

  it("rejects a query that exceeds maxDepth", () => {
    // 6 field levels: a(1).b(2).c(3).d(4).e(5).f(6)
    const q = `{ a { b { c { d { e { f } } } } } }`;
    const result = parseDocument(q, { maxDepth: 5 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.message).toMatch(/maximum allowed depth/i);
    }
  });

  it("uses default maxDepth of 5", () => {
    // 6 levels should fail with the default
    const q = `{ a { b { c { d { e { f } } } } } }`;
    const result = parseDocument(q);
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Schema-aware validation
// ---------------------------------------------------------------------------

describe("validateDocument", () => {
  it("passes for a valid query", () => {
    const result = parseDocument(`{ product(id: "1") { id name price } }`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const errors = validateDocument(result.document, schema);
    expect(errors).toHaveLength(0);
  });

  it("reports unknown top-level field", () => {
    const result = parseDocument(`{ unknownField { id } }`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const errors = validateDocument(result.document, schema);
    expect(errors.some((e) => e.message.includes("unknownField"))).toBe(true);
  });

  it("reports unknown sub-field", () => {
    const result = parseDocument(`{ product(id: "1") { id nonexistentField } }`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const errors = validateDocument(result.document, schema);
    expect(errors.some((e) => e.message.includes("nonexistentField"))).toBe(true);
  });

  it("reports unknown argument", () => {
    const result = parseDocument(`{ product(id: "1", bogus: "x") { id } }`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const errors = validateDocument(result.document, schema);
    expect(errors.some((e) => e.message.includes("bogus"))).toBe(true);
  });

  it("passes for a valid mutation field", () => {
    const result = parseDocument(`mutation { createProduct(input: {}) { id name } }`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const errors = validateDocument(result.document, schema);
    expect(errors).toHaveLength(0);
  });

  it("passes with a valid fragment spread", () => {
    const result = parseDocument(`
      fragment PF on Product { id name }
      query { product(id: "1") { ...PF } }
    `);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const errors = validateDocument(result.document, schema);
    expect(errors).toHaveLength(0);
  });

  it("reports unknown fragment spread", () => {
    const result = parseDocument(`{ product(id: "1") { ...NonExistentFrag } }`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const errors = validateDocument(result.document, schema);
    expect(errors.some((e) => e.message.includes("NonExistentFrag"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("parseDocument — edge cases", () => {
  it("handles comments in query", () => {
    const result = parseDocument(`
      # This is a comment
      query GetProduct {
        # Fetch single product
        product(id: "1") {
          id # the id field
        }
      }
    `);
    expect(result.ok).toBe(true);
  });

  it("handles escaped strings in arguments", () => {
    const result = parseDocument(`{ product(id: "he said \\"hello\\"") { id } }`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const field = asField(result.document.operations[0]?.selectionSet.selections[0]);
    const arg = field.arguments[0];
    if (arg?.value.kind === "StringValue") {
      expect(arg.value.value).toBe(`he said "hello"`);
    }
  });

  it("parses float arguments", () => {
    const result = parseDocument(`{ products(filter: "1.5e2") { nodes { id } } }`);
    expect(result.ok).toBe(true);
  });

  it("handles empty query body gracefully", () => {
    const result = parseDocument("");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.operations).toHaveLength(0);
  });

  it("handles directives", () => {
    const result = parseDocument(`{ product(id: "1") { id @include(if: true) } }`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const productField = asField(result.document.operations[0]?.selectionSet.selections[0]);
    const idField = asField(productField.selectionSet?.selections[0]);
    expect(idField.directives).toContain("include");
  });
});
