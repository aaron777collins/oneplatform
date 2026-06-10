// Unit tests for schemas/index.ts
// Every exported Zod schema is exercised with valid canonical inputs, boundary
// values, and representative invalid inputs that must produce ZodErrors.

import { describe, it, expect } from "vitest";
import {
  validationRuleSchema,
  fieldDefinitionSchema,
  createEntityRequest,
  patchEntityRequest,
  createMappingRuleRequest,
  updateMappingRuleRequest,
  mapRequest,
  inferRequest,
  createRelationshipRequest,
  listEntitiesQuery,
  deleteEntityQuery,
  dataEnvelopeSchema,
  validateRecordRequest,
  listMigrationsQuery,
  listDraftsQuery,
  schemaQueryRequest,
} from "../schemas/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Assert that parsing succeeds and return the parsed value. */
function ok<T>(schema: { parse(v: unknown): T }, input: unknown): T {
  return schema.parse(input);
}

/** Assert that parsing fails with a ZodError. */
function fails(schema: { safeParse(v: unknown): { success: boolean } }, input: unknown): void {
  const result = schema.safeParse(input);
  expect(result.success, `Expected parse to fail but it succeeded for: ${JSON.stringify(input)}`).toBe(false);
}

/** Minimal valid data envelope used by mapRequest / inferRequest. */
const VALID_ENVELOPE = {
  _id: "e1",
  _batchId: "b1",
  _connectorId: "c1",
  _ingestedAt: "2026-01-01T00:00:00.000Z",
  data: { foo: "bar" },
};

const VALID_UUID = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";

// ---------------------------------------------------------------------------
// validationRuleSchema
// ---------------------------------------------------------------------------

describe("validationRuleSchema", () => {
  describe("min discriminant", () => {
    it("accepts min with numeric value", () => {
      const r = ok(validationRuleSchema, { type: "min", value: 0 });
      expect(r.type).toBe("min");
    });

    it("accepts min with optional message", () => {
      const r = ok(validationRuleSchema, { type: "min", value: -99.5, message: "Too small" });
      expect(r).toMatchObject({ type: "min", value: -99.5, message: "Too small" });
    });

    it("rejects min without value", () => {
      fails(validationRuleSchema, { type: "min" });
    });

    it("rejects min with non-numeric value", () => {
      fails(validationRuleSchema, { type: "min", value: "five" });
    });
  });

  describe("max discriminant", () => {
    it("accepts max with numeric value", () => {
      const r = ok(validationRuleSchema, { type: "max", value: 1000 });
      expect(r.type).toBe("max");
    });

    it("accepts max with optional message", () => {
      const r = ok(validationRuleSchema, { type: "max", value: 9999.9, message: "Too large" });
      expect(r).toMatchObject({ type: "max", value: 9999.9, message: "Too large" });
    });

    it("rejects max without value", () => {
      fails(validationRuleSchema, { type: "max" });
    });
  });

  describe("minLength discriminant", () => {
    it("accepts minLength with non-negative integer", () => {
      const r = ok(validationRuleSchema, { type: "minLength", value: 0 });
      expect(r.type).toBe("minLength");
    });

    it("accepts minLength at boundary value 0", () => {
      const r = ok(validationRuleSchema, { type: "minLength", value: 0 });
      expect((r as { value: number }).value).toBe(0);
    });

    it("rejects minLength with negative integer", () => {
      fails(validationRuleSchema, { type: "minLength", value: -1 });
    });

    it("rejects minLength with float", () => {
      fails(validationRuleSchema, { type: "minLength", value: 1.5 });
    });

    it("rejects minLength without value", () => {
      fails(validationRuleSchema, { type: "minLength" });
    });
  });

  describe("maxLength discriminant", () => {
    it("accepts maxLength with value >= 1", () => {
      const r = ok(validationRuleSchema, { type: "maxLength", value: 1 });
      expect(r.type).toBe("maxLength");
    });

    it("rejects maxLength with value 0", () => {
      fails(validationRuleSchema, { type: "maxLength", value: 0 });
    });

    it("rejects maxLength with negative value", () => {
      fails(validationRuleSchema, { type: "maxLength", value: -5 });
    });

    it("rejects maxLength with float", () => {
      fails(validationRuleSchema, { type: "maxLength", value: 2.5 });
    });
  });

  describe("pattern discriminant", () => {
    it("accepts pattern with a regex string", () => {
      const r = ok(validationRuleSchema, { type: "pattern", value: "^[a-z]+$" });
      expect(r.type).toBe("pattern");
    });

    it("accepts pattern with optional message", () => {
      const r = ok(validationRuleSchema, { type: "pattern", value: "\\d+", message: "Digits only" });
      expect(r).toMatchObject({ type: "pattern", value: "\\d+", message: "Digits only" });
    });

    it("rejects pattern without value", () => {
      fails(validationRuleSchema, { type: "pattern" });
    });

    it("rejects pattern with numeric value", () => {
      fails(validationRuleSchema, { type: "pattern", value: 42 });
    });
  });

  describe("email discriminant", () => {
    it("accepts email rule without value", () => {
      const r = ok(validationRuleSchema, { type: "email" });
      expect(r.type).toBe("email");
    });

    it("accepts email rule with optional message", () => {
      const r = ok(validationRuleSchema, { type: "email", message: "Must be a valid email" });
      expect(r).toMatchObject({ type: "email", message: "Must be a valid email" });
    });

    it("rejects email rule with unknown discriminant value", () => {
      fails(validationRuleSchema, { type: "unknown_type" });
    });
  });

  describe("url discriminant", () => {
    it("accepts url rule without value", () => {
      const r = ok(validationRuleSchema, { type: "url" });
      expect(r.type).toBe("url");
    });

    it("accepts url rule with optional message", () => {
      const r = ok(validationRuleSchema, { type: "url", message: "Must be a valid URL" });
      expect(r).toMatchObject({ type: "url", message: "Must be a valid URL" });
    });
  });

  describe("discriminant exhaustiveness", () => {
    it("rejects completely unknown type", () => {
      fails(validationRuleSchema, { type: "exists", value: true });
    });

    it("rejects empty object (no type)", () => {
      fails(validationRuleSchema, {});
    });

    it("rejects null input", () => {
      fails(validationRuleSchema, null);
    });
  });
});

// ---------------------------------------------------------------------------
// fieldDefinitionSchema
// ---------------------------------------------------------------------------

describe("fieldDefinitionSchema", () => {
  const BASE = {
    name: "My Field",
    fieldType: "string",
  } as const;

  it("accepts minimal valid field definition (defaults applied)", () => {
    const r = ok(fieldDefinitionSchema, BASE);
    expect(r.name).toBe("My Field");
    expect(r.fieldType).toBe("string");
    expect(r.required).toBe(false);
    expect(r.nullable).toBe(true);
    expect(r.validationRules).toEqual([]);
    expect(r.isIndexed).toBe(false);
    expect(r.isUnique).toBe(false);
  });

  it("accepts all supported fieldType enum values", () => {
    const types = ["string", "number", "boolean", "date", "json", "reference", "enum", "array"] as const;
    for (const fieldType of types) {
      const r = ok(fieldDefinitionSchema, { ...BASE, fieldType });
      expect(r.fieldType).toBe(fieldType);
    }
  });

  it("rejects invalid fieldType", () => {
    fails(fieldDefinitionSchema, { ...BASE, fieldType: "uuid" });
    fails(fieldDefinitionSchema, { ...BASE, fieldType: "text" });
    fails(fieldDefinitionSchema, { ...BASE, fieldType: "" });
  });

  describe("slug regex validation", () => {
    it("accepts slug matching ^[a-z][a-z0-9_]*$", () => {
      const r = ok(fieldDefinitionSchema, { ...BASE, slug: "my_field_2" });
      expect(r.slug).toBe("my_field_2");
    });

    it("accepts slug that is exactly one lowercase letter", () => {
      const r = ok(fieldDefinitionSchema, { ...BASE, slug: "a" });
      expect(r.slug).toBe("a");
    });

    it("rejects slug starting with digit", () => {
      fails(fieldDefinitionSchema, { ...BASE, slug: "1field" });
    });

    it("rejects slug starting with uppercase", () => {
      fails(fieldDefinitionSchema, { ...BASE, slug: "MyField" });
    });

    it("rejects slug with hyphen", () => {
      fails(fieldDefinitionSchema, { ...BASE, slug: "my-field" });
    });

    it("rejects slug with space", () => {
      fails(fieldDefinitionSchema, { ...BASE, slug: "my field" });
    });

    it("rejects slug longer than 64 characters", () => {
      fails(fieldDefinitionSchema, { ...BASE, slug: "a".repeat(65) });
    });

    it("accepts slug at max length of 64 characters", () => {
      const slug = "a" + "b".repeat(63);
      const r = ok(fieldDefinitionSchema, { ...BASE, slug });
      expect(r.slug).toBe(slug);
    });
  });

  describe("name length limits", () => {
    it("rejects empty name", () => {
      fails(fieldDefinitionSchema, { ...BASE, name: "" });
    });

    it("accepts name at max length 64", () => {
      const r = ok(fieldDefinitionSchema, { ...BASE, name: "x".repeat(64) });
      expect(r.name).toHaveLength(64);
    });

    it("rejects name exceeding 64 characters", () => {
      fails(fieldDefinitionSchema, { ...BASE, name: "x".repeat(65) });
    });
  });

  it("accepts nested validationRules array", () => {
    const r = ok(fieldDefinitionSchema, {
      ...BASE,
      validationRules: [
        { type: "minLength", value: 1 },
        { type: "maxLength", value: 255 },
      ],
    });
    expect(r.validationRules).toHaveLength(2);
  });

  it("rejects invalid type inside validationRules", () => {
    fails(fieldDefinitionSchema, {
      ...BASE,
      validationRules: [{ type: "badRule", value: 1 }],
    });
  });

  it("accepts enumValues array for enum fieldType", () => {
    const r = ok(fieldDefinitionSchema, {
      ...BASE,
      fieldType: "enum",
      enumValues: ["active", "inactive"],
    });
    expect(r.enumValues).toEqual(["active", "inactive"]);
  });

  it("rejects enumValues as empty array (min 1)", () => {
    fails(fieldDefinitionSchema, { ...BASE, fieldType: "enum", enumValues: [] });
  });

  it("accepts arrayItemType for array fieldType", () => {
    const r = ok(fieldDefinitionSchema, { ...BASE, fieldType: "array", arrayItemType: "string" });
    expect(r.arrayItemType).toBe("string");
  });

  it("rejects arrayItemType value not in allowed enum", () => {
    fails(fieldDefinitionSchema, { ...BASE, fieldType: "array", arrayItemType: "reference" });
  });

  it("accepts refEntitySlug for reference fieldType", () => {
    const r = ok(fieldDefinitionSchema, { ...BASE, fieldType: "reference", refEntitySlug: "product" });
    expect(r.refEntitySlug).toBe("product");
  });
});

// ---------------------------------------------------------------------------
// createEntityRequest
// ---------------------------------------------------------------------------

describe("createEntityRequest", () => {
  const MINIMAL = {
    name: "Product",
    fields: [],
  };

  it("accepts minimal valid entity with empty fields", () => {
    const r = ok(createEntityRequest, MINIMAL);
    expect(r.name).toBe("Product");
    expect(r.fields).toEqual([]);
    expect(r.isPublic).toBe(false);
  });

  it("applies isPublic default of false", () => {
    const r = ok(createEntityRequest, MINIMAL);
    expect(r.isPublic).toBe(false);
  });

  it("accepts entity with explicit slug", () => {
    const r = ok(createEntityRequest, { ...MINIMAL, slug: "product" });
    expect(r.slug).toBe("product");
  });

  it("slug is optional — omitting it succeeds", () => {
    const r = ok(createEntityRequest, MINIMAL);
    expect(r.slug).toBeUndefined();
  });

  describe("name limits", () => {
    it("rejects empty name", () => {
      fails(createEntityRequest, { ...MINIMAL, name: "" });
    });

    it("accepts name at exactly 1 character", () => {
      const r = ok(createEntityRequest, { ...MINIMAL, name: "X" });
      expect(r.name).toBe("X");
    });

    it("accepts name at max length 64", () => {
      const r = ok(createEntityRequest, { ...MINIMAL, name: "N".repeat(64) });
      expect(r.name).toHaveLength(64);
    });

    it("rejects name exceeding 64 characters", () => {
      fails(createEntityRequest, { ...MINIMAL, name: "N".repeat(65) });
    });
  });

  describe("slug regex validation", () => {
    it("rejects slug with uppercase letters", () => {
      fails(createEntityRequest, { ...MINIMAL, slug: "Product" });
    });

    it("rejects slug starting with digit", () => {
      fails(createEntityRequest, { ...MINIMAL, slug: "2product" });
    });

    it("rejects slug exceeding 64 characters", () => {
      fails(createEntityRequest, { ...MINIMAL, slug: "a".repeat(65) });
    });
  });

  describe("fields array validation", () => {
    it("accepts fields array with 200 entries (max)", () => {
      const field = { name: "f", fieldType: "string" as const };
      const fields = Array.from({ length: 200 }, (_, i) => ({ ...field, name: `f${i}` }));
      const r = ok(createEntityRequest, { ...MINIMAL, fields });
      expect(r.fields).toHaveLength(200);
    });

    it("rejects fields array exceeding 200 entries", () => {
      const field = { name: "f", fieldType: "string" as const };
      const fields = Array.from({ length: 201 }, (_, i) => ({ ...field, name: `f${i}` }));
      fails(createEntityRequest, { ...MINIMAL, fields });
    });

    it("rejects field with invalid fieldType inside fields array", () => {
      fails(createEntityRequest, {
        ...MINIMAL,
        fields: [{ name: "Bad", fieldType: "uuid" }],
      });
    });
  });

  it("accepts description up to 512 characters", () => {
    const r = ok(createEntityRequest, { ...MINIMAL, description: "d".repeat(512) });
    expect(r.description).toHaveLength(512);
  });

  it("rejects description exceeding 512 characters", () => {
    fails(createEntityRequest, { ...MINIMAL, description: "d".repeat(513) });
  });
});

// ---------------------------------------------------------------------------
// patchEntityRequest
// ---------------------------------------------------------------------------

describe("patchEntityRequest", () => {
  it("accepts completely empty patch (all fields optional)", () => {
    const r = ok(patchEntityRequest, {});
    expect(r).toEqual({});
  });

  it("accepts partial patch with only name", () => {
    const r = ok(patchEntityRequest, { name: "New Name" });
    expect(r.name).toBe("New Name");
  });

  it("accepts description set to null (nullable)", () => {
    const r = ok(patchEntityRequest, { description: null });
    expect(r.description).toBeNull();
  });

  it("accepts description set to a string", () => {
    const r = ok(patchEntityRequest, { description: "Updated description" });
    expect(r.description).toBe("Updated description");
  });

  it("rejects name exceeding 64 characters", () => {
    fails(patchEntityRequest, { name: "x".repeat(65) });
  });

  it("rejects empty name string", () => {
    fails(patchEntityRequest, { name: "" });
  });

  describe("renameFields validation", () => {
    it("accepts valid rename entry", () => {
      const r = ok(patchEntityRequest, {
        renameFields: [{ fromSlug: "old_name", toSlug: "new_name" }],
      });
      expect(r.renameFields?.[0]).toMatchObject({ fromSlug: "old_name", toSlug: "new_name" });
    });

    it("toSlug must match slug regex ^[a-z][a-z0-9_]*$", () => {
      fails(patchEntityRequest, {
        renameFields: [{ fromSlug: "old", toSlug: "NewName" }],
      });
    });

    it("rejects toSlug starting with digit", () => {
      fails(patchEntityRequest, {
        renameFields: [{ fromSlug: "old", toSlug: "1bad" }],
      });
    });

    it("rejects toSlug exceeding 64 characters", () => {
      fails(patchEntityRequest, {
        renameFields: [{ fromSlug: "old", toSlug: "a".repeat(65) }],
      });
    });

    it("accepts toSlug at exactly 64 characters", () => {
      const toSlug = "a" + "b".repeat(63);
      const r = ok(patchEntityRequest, {
        renameFields: [{ fromSlug: "x", toSlug }],
      });
      expect(r.renameFields?.[0]?.toSlug).toHaveLength(64);
    });

    it("fromSlug has no regex constraint — accepts any string", () => {
      const r = ok(patchEntityRequest, {
        renameFields: [{ fromSlug: "ANY_STRING_123", toSlug: "new_slug" }],
      });
      expect(r.renameFields?.[0]?.fromSlug).toBe("ANY_STRING_123");
    });
  });

  describe("updateFields validation", () => {
    it("accepts updateFields with slug and optional overrides", () => {
      const r = ok(patchEntityRequest, {
        updateFields: [
          { slug: "price", name: "Unit Price", isIndexed: true, isUnique: false },
        ],
      });
      expect(r.updateFields?.[0]?.slug).toBe("price");
    });

    it("accepts updateFields with validationRules", () => {
      const r = ok(patchEntityRequest, {
        updateFields: [
          { slug: "email", validationRules: [{ type: "email" }] },
        ],
      });
      expect(r.updateFields?.[0]?.validationRules).toHaveLength(1);
    });
  });

  describe("addFields and removeFieldSlugs", () => {
    it("accepts addFields array", () => {
      const r = ok(patchEntityRequest, {
        addFields: [{ name: "Price", fieldType: "number" as const }],
      });
      expect(r.addFields).toHaveLength(1);
    });

    it("accepts removeFieldSlugs array", () => {
      const r = ok(patchEntityRequest, {
        removeFieldSlugs: ["old_field", "deprecated_field"],
      });
      expect(r.removeFieldSlugs).toEqual(["old_field", "deprecated_field"]);
    });
  });
});

// ---------------------------------------------------------------------------
// createMappingRuleRequest
// ---------------------------------------------------------------------------

describe("createMappingRuleRequest", () => {
  const BASE = {
    connectorId: VALID_UUID,
    sourceFieldPath: "$.body.email",
    targetFieldId: VALID_UUID,
  };

  it("accepts minimal valid request with defaults", () => {
    const r = ok(createMappingRuleRequest, BASE);
    expect(r.transformType).toBe("direct");
    expect(r.priority).toBe(0);
  });

  describe("UUID validation", () => {
    it("rejects non-UUID connectorId", () => {
      fails(createMappingRuleRequest, { ...BASE, connectorId: "not-a-uuid" });
    });

    it("rejects non-UUID targetFieldId", () => {
      fails(createMappingRuleRequest, { ...BASE, targetFieldId: "not-a-uuid" });
    });

    it("rejects empty connectorId", () => {
      fails(createMappingRuleRequest, { ...BASE, connectorId: "" });
    });
  });

  describe("transformType enum", () => {
    it("accepts all four transform types", () => {
      const types = ["direct", "expression", "constant", "template"] as const;
      for (const transformType of types) {
        const r = ok(createMappingRuleRequest, { ...BASE, transformType });
        expect(r.transformType).toBe(transformType);
      }
    });

    it("rejects unknown transformType", () => {
      fails(createMappingRuleRequest, { ...BASE, transformType: "javascript" });
    });
  });

  it("rejects empty sourceFieldPath", () => {
    fails(createMappingRuleRequest, { ...BASE, sourceFieldPath: "" });
  });

  it("accepts optional transform expression string", () => {
    const r = ok(createMappingRuleRequest, { ...BASE, transform: "value.toLowerCase()" });
    expect(r.transform).toBe("value.toLowerCase()");
  });

  describe("priority validation", () => {
    it("accepts priority at 0 (boundary)", () => {
      const r = ok(createMappingRuleRequest, { ...BASE, priority: 0 });
      expect(r.priority).toBe(0);
    });

    it("accepts large priority integer", () => {
      const r = ok(createMappingRuleRequest, { ...BASE, priority: 999 });
      expect(r.priority).toBe(999);
    });

    it("rejects negative priority", () => {
      fails(createMappingRuleRequest, { ...BASE, priority: -1 });
    });

    it("rejects float priority", () => {
      fails(createMappingRuleRequest, { ...BASE, priority: 1.5 });
    });
  });
});

// ---------------------------------------------------------------------------
// updateMappingRuleRequest
// ---------------------------------------------------------------------------

describe("updateMappingRuleRequest", () => {
  it("accepts completely empty update (all fields optional)", () => {
    const r = ok(updateMappingRuleRequest, {});
    expect(r).toEqual({});
  });

  it("accepts all fields simultaneously", () => {
    const r = ok(updateMappingRuleRequest, {
      sourceFieldPath: "$.data.name",
      transformType: "expression",
      transform: "value.trim()",
      isActive: true,
      priority: 5,
    });
    expect(r.transformType).toBe("expression");
  });

  it("accepts transform set to null (nullable)", () => {
    const r = ok(updateMappingRuleRequest, { transform: null });
    expect(r.transform).toBeNull();
  });

  it("accepts transform set to a string", () => {
    const r = ok(updateMappingRuleRequest, { transform: "value.toUpperCase()" });
    expect(r.transform).toBe("value.toUpperCase()");
  });

  it("rejects empty sourceFieldPath when provided", () => {
    fails(updateMappingRuleRequest, { sourceFieldPath: "" });
  });

  it("rejects unknown transformType", () => {
    fails(updateMappingRuleRequest, { transformType: "regex" });
  });

  it("rejects negative priority", () => {
    fails(updateMappingRuleRequest, { priority: -1 });
  });

  it("rejects float priority", () => {
    fails(updateMappingRuleRequest, { priority: 0.5 });
  });
});

// ---------------------------------------------------------------------------
// dataEnvelopeSchema
// ---------------------------------------------------------------------------

describe("dataEnvelopeSchema", () => {
  it("accepts valid envelope", () => {
    const r = ok(dataEnvelopeSchema, VALID_ENVELOPE);
    expect(r._id).toBe("e1");
    expect(r.data).toEqual({ foo: "bar" });
  });

  it("rejects envelope missing _id", () => {
    const { _id: _removed, ...rest } = VALID_ENVELOPE;
    fails(dataEnvelopeSchema, rest);
  });

  it("rejects envelope with non-record data field", () => {
    fails(dataEnvelopeSchema, { ...VALID_ENVELOPE, data: "not an object" });
  });

  it("accepts envelope with deeply nested data", () => {
    const r = ok(dataEnvelopeSchema, { ...VALID_ENVELOPE, data: { nested: { deep: true } } });
    expect(r.data["nested"]).toEqual({ deep: true });
  });
});

// ---------------------------------------------------------------------------
// mapRequest
// ---------------------------------------------------------------------------

describe("mapRequest", () => {
  const BASE = {
    tenantId: VALID_UUID,
    connectorId: VALID_UUID,
    batchId: "batch-001",
    records: [VALID_ENVELOPE],
  };

  it("accepts valid map request", () => {
    const r = ok(mapRequest, BASE);
    expect(r.tenantId).toBe(VALID_UUID);
    expect(r.records).toHaveLength(1);
  });

  describe("tenantId UUID validation", () => {
    it("rejects non-UUID tenantId", () => {
      fails(mapRequest, { ...BASE, tenantId: "not-a-uuid" });
    });

    it("rejects empty tenantId", () => {
      fails(mapRequest, { ...BASE, tenantId: "" });
    });
  });

  describe("records array min/max", () => {
    it("rejects empty records array (min 1)", () => {
      fails(mapRequest, { ...BASE, records: [] });
    });

    it("accepts exactly 1 record (min boundary)", () => {
      const r = ok(mapRequest, { ...BASE, records: [VALID_ENVELOPE] });
      expect(r.records).toHaveLength(1);
    });

    it("accepts exactly 100 records (max boundary)", () => {
      const records = Array.from({ length: 100 }, () => ({ ...VALID_ENVELOPE }));
      const r = ok(mapRequest, { ...BASE, records });
      expect(r.records).toHaveLength(100);
    });

    it("rejects 101 records (exceeds max)", () => {
      const records = Array.from({ length: 101 }, () => ({ ...VALID_ENVELOPE }));
      fails(mapRequest, { ...BASE, records });
    });
  });

  it("rejects non-UUID connectorId", () => {
    fails(mapRequest, { ...BASE, connectorId: "bad-id" });
  });
});

// ---------------------------------------------------------------------------
// inferRequest
// ---------------------------------------------------------------------------

describe("inferRequest", () => {
  const BASE = {
    tenantId: VALID_UUID,
    connectorId: VALID_UUID,
    sample: [VALID_ENVELOPE],
  };

  it("accepts valid infer request", () => {
    const r = ok(inferRequest, BASE);
    expect(r.sample).toHaveLength(1);
  });

  it("accepts optional entityTypeHint", () => {
    const r = ok(inferRequest, { ...BASE, entityTypeHint: "product" });
    expect(r.entityTypeHint).toBe("product");
  });

  describe("sample array limits", () => {
    it("rejects empty sample array (min 1)", () => {
      fails(inferRequest, { ...BASE, sample: [] });
    });

    it("accepts exactly 1 sample (min boundary)", () => {
      const r = ok(inferRequest, { ...BASE, sample: [VALID_ENVELOPE] });
      expect(r.sample).toHaveLength(1);
    });

    it("accepts exactly 1000 samples (max boundary)", () => {
      const sample = Array.from({ length: 1000 }, () => ({ ...VALID_ENVELOPE }));
      const r = ok(inferRequest, { ...BASE, sample });
      expect(r.sample).toHaveLength(1000);
    });

    it("rejects 1001 samples (exceeds max)", () => {
      const sample = Array.from({ length: 1001 }, () => ({ ...VALID_ENVELOPE }));
      fails(inferRequest, { ...BASE, sample });
    });
  });

  it("rejects non-UUID tenantId", () => {
    fails(inferRequest, { ...BASE, tenantId: "not-uuid" });
  });
});

// ---------------------------------------------------------------------------
// createRelationshipRequest
// ---------------------------------------------------------------------------

describe("createRelationshipRequest", () => {
  const BASE = {
    fromEntitySlug: "order",
    toEntitySlug: "product",
    relationshipType: "1:N",
    fromFieldName: "productId",
  };

  it("accepts valid 1:N relationship", () => {
    const r = ok(createRelationshipRequest, BASE);
    expect(r.relationshipType).toBe("1:N");
    expect(r.cascadeDelete).toBe(false);
  });

  describe("relationshipType enum validation", () => {
    it("accepts all three relationship types", () => {
      const types = ["1:1", "1:N", "M:N"] as const;
      for (const relationshipType of types) {
        const r = ok(createRelationshipRequest, { ...BASE, relationshipType });
        expect(r.relationshipType).toBe(relationshipType);
      }
    });

    it("rejects unknown relationship type", () => {
      fails(createRelationshipRequest, { ...BASE, relationshipType: "N:M" });
    });

    it("rejects lowercase relationship type", () => {
      fails(createRelationshipRequest, { ...BASE, relationshipType: "1:n" });
    });
  });

  it("accepts optional toFieldName", () => {
    const r = ok(createRelationshipRequest, { ...BASE, toFieldName: "orders" });
    expect(r.toFieldName).toBe("orders");
  });

  it("toFieldName is optional — omitting succeeds", () => {
    const r = ok(createRelationshipRequest, BASE);
    expect(r.toFieldName).toBeUndefined();
  });

  it("accepts cascadeDelete true", () => {
    const r = ok(createRelationshipRequest, { ...BASE, cascadeDelete: true });
    expect(r.cascadeDelete).toBe(true);
  });

  it("rejects missing fromEntitySlug", () => {
    const { fromEntitySlug: _removed, ...rest } = BASE;
    fails(createRelationshipRequest, rest);
  });

  it("rejects missing fromFieldName", () => {
    const { fromFieldName: _removed, ...rest } = BASE;
    fails(createRelationshipRequest, rest);
  });
});

// ---------------------------------------------------------------------------
// listEntitiesQuery
// ---------------------------------------------------------------------------

describe("listEntitiesQuery", () => {
  it("accepts empty query and applies defaults", () => {
    const r = ok(listEntitiesQuery, {});
    expect(r.limit).toBe(50);
    expect(r.cursor).toBeUndefined();
  });

  describe("cursor", () => {
    it("accepts cursor as a string", () => {
      const r = ok(listEntitiesQuery, { cursor: "eyJpZCI6IjEyMyJ9" });
      expect(r.cursor).toBe("eyJpZCI6IjEyMyJ9");
    });

    it("cursor is optional — omitting succeeds", () => {
      const r = ok(listEntitiesQuery, { limit: "10" });
      expect(r.cursor).toBeUndefined();
    });
  });

  describe("limit coerce and range", () => {
    it("coerces string limit to number", () => {
      const r = ok(listEntitiesQuery, { limit: "25" });
      expect(r.limit).toBe(25);
    });

    it("accepts limit at min boundary of 1", () => {
      const r = ok(listEntitiesQuery, { limit: "1" });
      expect(r.limit).toBe(1);
    });

    it("accepts limit at max boundary of 100", () => {
      const r = ok(listEntitiesQuery, { limit: "100" });
      expect(r.limit).toBe(100);
    });

    it("rejects limit below minimum (0)", () => {
      fails(listEntitiesQuery, { limit: "0" });
    });

    it("rejects limit exceeding maximum (101)", () => {
      fails(listEntitiesQuery, { limit: "101" });
    });

    it("rejects non-integer limit", () => {
      fails(listEntitiesQuery, { limit: "1.5" });
    });

    it("rejects non-numeric limit string", () => {
      fails(listEntitiesQuery, { limit: "lots" });
    });
  });
});

// ---------------------------------------------------------------------------
// deleteEntityQuery
// ---------------------------------------------------------------------------

describe("deleteEntityQuery", () => {
  it("accepts empty query (confirm optional)", () => {
    const r = ok(deleteEntityQuery, {});
    expect(r.confirm).toBeUndefined();
  });

  describe("confirm boolean coerce", () => {
    // z.coerce.boolean() delegates to JavaScript's Boolean() constructor.
    // Any non-empty string — including "false" — is truthy.
    // Only the empty string "", 0, null, undefined, and false coerce to false.
    it("coerces string 'true' to boolean true", () => {
      const r = ok(deleteEntityQuery, { confirm: "true" });
      expect(r.confirm).toBe(true);
    });

    it("coerces non-empty string 'false' to boolean true (JS Boolean() semantics)", () => {
      const r = ok(deleteEntityQuery, { confirm: "false" });
      expect(r.confirm).toBe(true);
    });

    it("coerces empty string to boolean false", () => {
      const r = ok(deleteEntityQuery, { confirm: "" });
      expect(r.confirm).toBe(false);
    });

    it("accepts native boolean true", () => {
      const r = ok(deleteEntityQuery, { confirm: true });
      expect(r.confirm).toBe(true);
    });

    it("accepts native boolean false", () => {
      const r = ok(deleteEntityQuery, { confirm: false });
      expect(r.confirm).toBe(false);
    });

    it("coerces numeric 1 to true", () => {
      const r = ok(deleteEntityQuery, { confirm: 1 });
      expect(r.confirm).toBe(true);
    });

    it("coerces numeric 0 to false", () => {
      const r = ok(deleteEntityQuery, { confirm: 0 });
      expect(r.confirm).toBe(false);
    });

    it("coerces non-zero string '0' to true (JS Boolean() semantics)", () => {
      const r = ok(deleteEntityQuery, { confirm: "0" });
      expect(r.confirm).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// validateRecordRequest
// ---------------------------------------------------------------------------

describe("validateRecordRequest", () => {
  it("accepts any record with unknown values", () => {
    const r = ok(validateRecordRequest, { data: { foo: "bar", num: 42, nested: { a: 1 } } });
    expect(r.data["foo"]).toBe("bar");
  });

  it("accepts empty data record", () => {
    const r = ok(validateRecordRequest, { data: {} });
    expect(r.data).toEqual({});
  });

  it("rejects missing data field", () => {
    fails(validateRecordRequest, {});
  });

  it("rejects data as array (must be a record/object)", () => {
    fails(validateRecordRequest, { data: [1, 2, 3] });
  });
});

// ---------------------------------------------------------------------------
// listMigrationsQuery
// ---------------------------------------------------------------------------

describe("listMigrationsQuery", () => {
  it("accepts empty query and applies defaults", () => {
    const r = ok(listMigrationsQuery, {});
    expect(r.limit).toBe(50);
    expect(r.cursor).toBeUndefined();
    expect(r.status).toBeUndefined();
  });

  it("accepts all valid status enum values", () => {
    const statuses = [
      "pending_confirmation",
      "confirmed",
      "running",
      "complete",
      "failed",
      "rolled_back",
    ] as const;
    for (const status of statuses) {
      const r = ok(listMigrationsQuery, { status });
      expect(r.status).toBe(status);
    }
  });

  it("rejects unknown status value", () => {
    fails(listMigrationsQuery, { status: "archived" });
  });

  it("coerces string limit to number", () => {
    const r = ok(listMigrationsQuery, { limit: "10" });
    expect(r.limit).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// listDraftsQuery
// ---------------------------------------------------------------------------

describe("listDraftsQuery", () => {
  it("accepts empty query", () => {
    const r = ok(listDraftsQuery, {});
    expect(r.connectorId).toBeUndefined();
  });

  it("accepts valid UUID connectorId", () => {
    const r = ok(listDraftsQuery, { connectorId: VALID_UUID });
    expect(r.connectorId).toBe(VALID_UUID);
  });

  it("rejects non-UUID connectorId", () => {
    fails(listDraftsQuery, { connectorId: "not-a-uuid" });
  });
});

// ---------------------------------------------------------------------------
// schemaQueryRequest
// ---------------------------------------------------------------------------

describe("schemaQueryRequest", () => {
  it("accepts valid UUID tenantId", () => {
    const r = ok(schemaQueryRequest, { tenantId: VALID_UUID });
    expect(r.tenantId).toBe(VALID_UUID);
  });

  it("rejects non-UUID tenantId", () => {
    fails(schemaQueryRequest, { tenantId: "not-a-uuid" });
  });

  it("rejects missing tenantId", () => {
    fails(schemaQueryRequest, {});
  });
});
