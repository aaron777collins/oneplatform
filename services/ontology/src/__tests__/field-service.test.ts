// Unit tests for field-service.ts
// Covers: buildFieldZodValidator, buildEntityZodSchema, buildCreateInputSchema, serializeZodSchema.
// All tests are pure — no external deps, no mocks required.

import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  buildFieldZodValidator,
  buildEntityZodSchema,
  buildCreateInputSchema,
  serializeZodSchema,
} from "../services/field-service.js";
import type { FieldRow, ValidationRule } from "../repositories/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeField(overrides: Partial<FieldRow> = {}): FieldRow {
  return {
    id: "field-1",
    entity_id: "entity-1",
    tenant_id: "tenant-1",
    name: "Test Field",
    slug: "test_field",
    field_type: "string",
    required: true,
    nullable: false,
    default_value: null,
    validation_rules: [],
    enum_values: null,
    array_item_type: null,
    ref_entity_id: null,
    is_indexed: false,
    is_unique: false,
    sort_order: 0,
    system_generated: false,
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
    ...overrides,
  };
}

function parseOk(validator: z.ZodTypeAny, value: unknown): unknown {
  return validator.parse(value);
}

function parseFails(validator: z.ZodTypeAny, value: unknown): boolean {
  const result = validator.safeParse(value);
  return !result.success;
}

// ---------------------------------------------------------------------------
// buildFieldZodValidator — string type
// ---------------------------------------------------------------------------

describe("buildFieldZodValidator — string", () => {
  it("accepts any string value for a basic required string field", () => {
    const v = buildFieldZodValidator(makeField({ field_type: "string" }));
    expect(parseOk(v, "hello")).toBe("hello");
  });

  it("rejects a number for a required string field", () => {
    const v = buildFieldZodValidator(makeField({ field_type: "string" }));
    expect(parseFails(v, 42)).toBe(true);
  });

  it("enforces minLength rule", () => {
    const rules: ValidationRule[] = [{ type: "minLength", value: 5 }];
    const v = buildFieldZodValidator(makeField({ field_type: "string", validation_rules: rules }));
    expect(parseFails(v, "ab")).toBe(true);
    expect(parseOk(v, "abcde")).toBe("abcde");
  });

  it("enforces maxLength rule", () => {
    const rules: ValidationRule[] = [{ type: "maxLength", value: 3 }];
    const v = buildFieldZodValidator(makeField({ field_type: "string", validation_rules: rules }));
    expect(parseFails(v, "abcd")).toBe(true);
    expect(parseOk(v, "abc")).toBe("abc");
  });

  it("enforces both minLength and maxLength simultaneously", () => {
    const rules: ValidationRule[] = [
      { type: "minLength", value: 2 },
      { type: "maxLength", value: 5 },
    ];
    const v = buildFieldZodValidator(makeField({ field_type: "string", validation_rules: rules }));
    expect(parseFails(v, "a")).toBe(true);
    expect(parseFails(v, "abcdef")).toBe(true);
    expect(parseOk(v, "abc")).toBe("abc");
  });

  it("enforces pattern rule with a regex string", () => {
    const rules: ValidationRule[] = [{ type: "pattern", value: "^[0-9]+$" }];
    const v = buildFieldZodValidator(makeField({ field_type: "string", validation_rules: rules }));
    expect(parseFails(v, "abc")).toBe(true);
    expect(parseOk(v, "123")).toBe("123");
  });

  it("enforces email rule", () => {
    const rules: ValidationRule[] = [{ type: "email" }];
    const v = buildFieldZodValidator(makeField({ field_type: "string", validation_rules: rules }));
    expect(parseFails(v, "not-an-email")).toBe(true);
    expect(parseOk(v, "user@example.com")).toBe("user@example.com");
  });

  it("enforces url rule", () => {
    const rules: ValidationRule[] = [{ type: "url" }];
    const v = buildFieldZodValidator(makeField({ field_type: "string", validation_rules: rules }));
    expect(parseFails(v, "not-a-url")).toBe(true);
    expect(parseOk(v, "https://example.com")).toBe("https://example.com");
  });

  it("propagates custom error messages from validation rules", () => {
    const rules: ValidationRule[] = [{ type: "minLength", value: 10, message: "Too short, mate" }];
    const v = buildFieldZodValidator(makeField({ field_type: "string", validation_rules: rules }));
    const result = v.safeParse("hi");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe("Too short, mate");
    }
  });

  it("accepts empty string at minLength boundary of 0 when no min rule", () => {
    const v = buildFieldZodValidator(makeField({ field_type: "string" }));
    expect(parseOk(v, "")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// buildFieldZodValidator — number type
// ---------------------------------------------------------------------------

describe("buildFieldZodValidator — number", () => {
  it("accepts a numeric value for a required number field", () => {
    const v = buildFieldZodValidator(makeField({ field_type: "number" }));
    expect(parseOk(v, 42)).toBe(42);
  });

  it("rejects a string for a required number field", () => {
    const v = buildFieldZodValidator(makeField({ field_type: "number" }));
    expect(parseFails(v, "42")).toBe(true);
  });

  it("accepts float values", () => {
    const v = buildFieldZodValidator(makeField({ field_type: "number" }));
    expect(parseOk(v, 3.14)).toBe(3.14);
  });

  it("enforces min rule", () => {
    const rules: ValidationRule[] = [{ type: "min", value: 5 }];
    const v = buildFieldZodValidator(makeField({ field_type: "number", validation_rules: rules }));
    expect(parseFails(v, 4)).toBe(true);
    expect(parseOk(v, 5)).toBe(5);
  });

  it("enforces max rule", () => {
    const rules: ValidationRule[] = [{ type: "max", value: 100 }];
    const v = buildFieldZodValidator(makeField({ field_type: "number", validation_rules: rules }));
    expect(parseFails(v, 101)).toBe(true);
    expect(parseOk(v, 100)).toBe(100);
  });

  it("enforces min/max boundary values exactly (inclusive)", () => {
    const rules: ValidationRule[] = [
      { type: "min", value: 0 },
      { type: "max", value: 10 },
    ];
    const v = buildFieldZodValidator(makeField({ field_type: "number", validation_rules: rules }));
    expect(parseOk(v, 0)).toBe(0);
    expect(parseOk(v, 10)).toBe(10);
    expect(parseFails(v, -1)).toBe(true);
    expect(parseFails(v, 11)).toBe(true);
  });

  it("accepts negative numbers when no min rule is set", () => {
    const v = buildFieldZodValidator(makeField({ field_type: "number" }));
    expect(parseOk(v, -9999)).toBe(-9999);
  });
});

// ---------------------------------------------------------------------------
// buildFieldZodValidator — boolean type
// ---------------------------------------------------------------------------

describe("buildFieldZodValidator — boolean", () => {
  it("accepts true", () => {
    const v = buildFieldZodValidator(makeField({ field_type: "boolean" }));
    expect(parseOk(v, true)).toBe(true);
  });

  it("accepts false", () => {
    const v = buildFieldZodValidator(makeField({ field_type: "boolean" }));
    expect(parseOk(v, false)).toBe(false);
  });

  it("rejects string 'true'", () => {
    const v = buildFieldZodValidator(makeField({ field_type: "boolean" }));
    expect(parseFails(v, "true")).toBe(true);
  });

  it("rejects number 1", () => {
    const v = buildFieldZodValidator(makeField({ field_type: "boolean" }));
    expect(parseFails(v, 1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildFieldZodValidator — date type
// ---------------------------------------------------------------------------

describe("buildFieldZodValidator — date", () => {
  it("accepts a valid ISO-8601 datetime string", () => {
    const v = buildFieldZodValidator(makeField({ field_type: "date" }));
    expect(parseOk(v, "2024-01-15T12:30:00Z")).toBe("2024-01-15T12:30:00Z");
  });

  it("accepts ISO-8601 datetime with milliseconds", () => {
    const v = buildFieldZodValidator(makeField({ field_type: "date" }));
    expect(parseOk(v, "2024-01-15T12:30:00.123Z")).toBe("2024-01-15T12:30:00.123Z");
  });

  it("rejects a date-only string (missing time component)", () => {
    const v = buildFieldZodValidator(makeField({ field_type: "date" }));
    expect(parseFails(v, "2024-01-15")).toBe(true);
  });

  it("rejects a plaintext non-date string", () => {
    const v = buildFieldZodValidator(makeField({ field_type: "date" }));
    expect(parseFails(v, "not a date")).toBe(true);
  });

  it("rejects a JS Date object (expects string)", () => {
    const v = buildFieldZodValidator(makeField({ field_type: "date" }));
    expect(parseFails(v, new Date())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildFieldZodValidator — json type
// ---------------------------------------------------------------------------

describe("buildFieldZodValidator — json", () => {
  it("accepts an object with string values", () => {
    const v = buildFieldZodValidator(makeField({ field_type: "json" }));
    const obj = { key: "value" };
    expect(parseOk(v, obj)).toEqual(obj);
  });

  it("accepts an empty object", () => {
    const v = buildFieldZodValidator(makeField({ field_type: "json" }));
    expect(parseOk(v, {})).toEqual({});
  });

  it("accepts an object with mixed value types", () => {
    const v = buildFieldZodValidator(makeField({ field_type: "json" }));
    const obj = { a: 1, b: "two", c: true, d: null };
    expect(parseOk(v, obj)).toEqual(obj);
  });

  it("rejects an array (json is z.record, not an array)", () => {
    const v = buildFieldZodValidator(makeField({ field_type: "json" }));
    expect(parseFails(v, [1, 2, 3])).toBe(true);
  });

  it("rejects a primitive string", () => {
    const v = buildFieldZodValidator(makeField({ field_type: "json" }));
    expect(parseFails(v, "hello")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildFieldZodValidator — reference type
// ---------------------------------------------------------------------------

describe("buildFieldZodValidator — reference", () => {
  it("accepts a valid UUID v4", () => {
    const v = buildFieldZodValidator(makeField({ field_type: "reference" }));
    expect(parseOk(v, "550e8400-e29b-41d4-a716-446655440000")).toBe(
      "550e8400-e29b-41d4-a716-446655440000",
    );
  });

  it("rejects a non-UUID string", () => {
    const v = buildFieldZodValidator(makeField({ field_type: "reference" }));
    expect(parseFails(v, "not-a-uuid")).toBe(true);
  });

  it("rejects an integer ID", () => {
    const v = buildFieldZodValidator(makeField({ field_type: "reference" }));
    expect(parseFails(v, 12345)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildFieldZodValidator — enum type
// ---------------------------------------------------------------------------

describe("buildFieldZodValidator — enum", () => {
  it("accepts a value that is in the enum list", () => {
    const v = buildFieldZodValidator(
      makeField({ field_type: "enum", enum_values: ["draft", "published", "archived"] }),
    );
    expect(parseOk(v, "draft")).toBe("draft");
  });

  it("rejects a value not in the enum list", () => {
    const v = buildFieldZodValidator(
      makeField({ field_type: "enum", enum_values: ["draft", "published"] }),
    );
    expect(parseFails(v, "deleted")).toBe(true);
  });

  it("falls back to z.string() when enum_values is null", () => {
    const v = buildFieldZodValidator(makeField({ field_type: "enum", enum_values: null }));
    expect(parseOk(v, "anything")).toBe("anything");
  });

  it("falls back to z.string() when enum_values is empty array", () => {
    const v = buildFieldZodValidator(makeField({ field_type: "enum", enum_values: [] }));
    expect(parseOk(v, "anything")).toBe("anything");
  });

  it("handles enum values containing special characters safely", () => {
    const v = buildFieldZodValidator(
      makeField({ field_type: "enum", enum_values: ["option-1", "option/2", "option 3"] }),
    );
    expect(parseOk(v, "option-1")).toBe("option-1");
    expect(parseFails(v, "other")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildFieldZodValidator — array type
// ---------------------------------------------------------------------------

describe("buildFieldZodValidator — array", () => {
  it("accepts an array of strings when array_item_type is string", () => {
    const v = buildFieldZodValidator(makeField({ field_type: "array", array_item_type: "string" }));
    expect(parseOk(v, ["a", "b"])).toEqual(["a", "b"]);
  });

  it("rejects mixed types in string array", () => {
    const v = buildFieldZodValidator(makeField({ field_type: "array", array_item_type: "string" }));
    expect(parseFails(v, ["a", 1])).toBe(true);
  });

  it("accepts an array of numbers when array_item_type is number", () => {
    const v = buildFieldZodValidator(makeField({ field_type: "array", array_item_type: "number" }));
    expect(parseOk(v, [1, 2, 3])).toEqual([1, 2, 3]);
  });

  it("accepts an array of booleans when array_item_type is boolean", () => {
    const v = buildFieldZodValidator(makeField({ field_type: "array", array_item_type: "boolean" }));
    expect(parseOk(v, [true, false])).toEqual([true, false]);
  });

  it("accepts an array of ISO datetime strings when array_item_type is date", () => {
    const v = buildFieldZodValidator(makeField({ field_type: "array", array_item_type: "date" }));
    expect(parseOk(v, ["2024-01-01T00:00:00Z"])).toEqual(["2024-01-01T00:00:00Z"]);
  });

  it("accepts an array of objects when array_item_type is json", () => {
    const v = buildFieldZodValidator(makeField({ field_type: "array", array_item_type: "json" }));
    expect(parseOk(v, [{ a: 1 }])).toEqual([{ a: 1 }]);
  });

  it("defaults to string item type when array_item_type is null", () => {
    const v = buildFieldZodValidator(makeField({ field_type: "array", array_item_type: null }));
    // null falls through to default → z.unknown() array item — accepts anything
    expect(parseOk(v, ["hello"])).toEqual(["hello"]);
  });

  it("accepts an empty array", () => {
    const v = buildFieldZodValidator(makeField({ field_type: "array", array_item_type: "string" }));
    expect(parseOk(v, [])).toEqual([]);
  });

  it("rejects a non-array value", () => {
    const v = buildFieldZodValidator(makeField({ field_type: "array", array_item_type: "string" }));
    expect(parseFails(v, "not an array")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildFieldZodValidator — nullable / required / default combinations
// ---------------------------------------------------------------------------

describe("buildFieldZodValidator — nullable, required, default", () => {
  it("accepts null when nullable is true", () => {
    const v = buildFieldZodValidator(
      makeField({ field_type: "string", nullable: true, required: true }),
    );
    expect(parseOk(v, null)).toBeNull();
  });

  it("rejects null when nullable is false", () => {
    const v = buildFieldZodValidator(
      makeField({ field_type: "string", nullable: false, required: true }),
    );
    expect(parseFails(v, null)).toBe(true);
  });

  it("accepts undefined when required is false (optional field)", () => {
    const v = buildFieldZodValidator(
      makeField({ field_type: "string", required: false, nullable: false }),
    );
    expect(parseOk(v, undefined)).toBeUndefined();
  });

  it("rejects undefined for a strictly required field", () => {
    const v = buildFieldZodValidator(
      makeField({ field_type: "string", required: true, nullable: false }),
    );
    expect(parseFails(v, undefined)).toBe(true);
  });

  it("accepts both null and undefined when nullable=true and required=false", () => {
    const v = buildFieldZodValidator(
      makeField({ field_type: "string", nullable: true, required: false }),
    );
    expect(parseOk(v, null)).toBeNull();
    expect(parseOk(v, undefined)).toBeUndefined();
  });

  it("uses default_value when input is undefined", () => {
    const v = buildFieldZodValidator(
      makeField({
        field_type: "string",
        required: false,
        nullable: false,
        default_value: "fallback",
      }),
    );
    expect(parseOk(v, undefined)).toBe("fallback");
  });

  it("uses numeric default_value for a number field", () => {
    const v = buildFieldZodValidator(
      makeField({
        field_type: "number",
        required: false,
        nullable: false,
        default_value: 0,
      }),
    );
    expect(parseOk(v, undefined)).toBe(0);
  });

  it("uses boolean default_value for a boolean field", () => {
    const v = buildFieldZodValidator(
      makeField({
        field_type: "boolean",
        required: false,
        nullable: false,
        default_value: false,
      }),
    );
    expect(parseOk(v, undefined)).toBe(false);
  });

  it("does not apply default when field has no default_value (null sentinel)", () => {
    const v = buildFieldZodValidator(
      makeField({ field_type: "string", required: false, nullable: false, default_value: null }),
    );
    // no default — undefined stays undefined
    expect(parseOk(v, undefined)).toBeUndefined();
  });

  it("unknown field_type falls back to z.unknown() accepting any value", () => {
    const v = buildFieldZodValidator(makeField({ field_type: "custom_type_xyz" }));
    expect(parseOk(v, { anything: true })).toEqual({ anything: true });
    expect(parseOk(v, 42)).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// buildEntityZodSchema
// ---------------------------------------------------------------------------

describe("buildEntityZodSchema", () => {
  it("includes all five system columns: _id, _createdAt, _updatedAt, _version, _sourceId", () => {
    const schema = buildEntityZodSchema([]);
    const shape = schema.shape;
    expect(shape).toHaveProperty("_id");
    expect(shape).toHaveProperty("_createdAt");
    expect(shape).toHaveProperty("_updatedAt");
    expect(shape).toHaveProperty("_version");
    expect(shape).toHaveProperty("_sourceId");
  });

  it("validates _id as a UUID string", () => {
    const schema = buildEntityZodSchema([]);
    const result = schema.safeParse({
      _id: "not-a-uuid",
      _createdAt: "2024-01-01T00:00:00Z",
      _updatedAt: "2024-01-01T00:00:00Z",
      _version: 1,
      _sourceId: null,
    });
    expect(result.success).toBe(false);
  });

  it("validates _version as an integer", () => {
    const schema = buildEntityZodSchema([]);
    const result = schema.safeParse({
      _id: "550e8400-e29b-41d4-a716-446655440000",
      _createdAt: "2024-01-01T00:00:00Z",
      _updatedAt: "2024-01-01T00:00:00Z",
      _version: 3.14, // not an integer
      _sourceId: null,
    });
    expect(result.success).toBe(false);
  });

  it("allows _sourceId to be null", () => {
    const schema = buildEntityZodSchema([]);
    const result = schema.safeParse({
      _id: "550e8400-e29b-41d4-a716-446655440000",
      _createdAt: "2024-01-01T00:00:00Z",
      _updatedAt: "2024-01-01T00:00:00Z",
      _version: 1,
      _sourceId: null,
    });
    expect(result.success).toBe(true);
  });

  it("includes user-defined fields alongside system columns", () => {
    const fields: FieldRow[] = [
      makeField({ slug: "title", field_type: "string" }),
      makeField({ slug: "count", field_type: "number" }),
    ];
    const schema = buildEntityZodSchema(fields);
    expect(schema.shape).toHaveProperty("title");
    expect(schema.shape).toHaveProperty("count");
    expect(schema.shape).toHaveProperty("_id");
  });

  it("validates a fully valid entity object with user fields", () => {
    const fields: FieldRow[] = [makeField({ slug: "name", field_type: "string" })];
    const schema = buildEntityZodSchema(fields);
    const result = schema.safeParse({
      _id: "550e8400-e29b-41d4-a716-446655440000",
      _createdAt: "2024-01-01T00:00:00Z",
      _updatedAt: "2024-01-01T00:00:00Z",
      _version: 1,
      _sourceId: null,
      name: "Alice",
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildCreateInputSchema
// ---------------------------------------------------------------------------

describe("buildCreateInputSchema", () => {
  it("does NOT include system columns (_id, _createdAt, etc)", () => {
    const schema = buildCreateInputSchema([makeField({ slug: "title", field_type: "string" })]);
    const shape = schema.shape;
    expect(shape).not.toHaveProperty("_id");
    expect(shape).not.toHaveProperty("_createdAt");
    expect(shape).not.toHaveProperty("_updatedAt");
    expect(shape).not.toHaveProperty("_version");
    expect(shape).not.toHaveProperty("_sourceId");
  });

  it("includes the user-defined field slugs", () => {
    const fields: FieldRow[] = [
      makeField({ slug: "email", field_type: "string" }),
      makeField({ slug: "age", field_type: "number" }),
    ];
    const schema = buildCreateInputSchema(fields);
    expect(schema.shape).toHaveProperty("email");
    expect(schema.shape).toHaveProperty("age");
  });

  it("produces an empty object schema when no fields are provided", () => {
    const schema = buildCreateInputSchema([]);
    const result = schema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("validates user field constraints (e.g. email format)", () => {
    const rules: ValidationRule[] = [{ type: "email" }];
    const fields: FieldRow[] = [
      makeField({ slug: "email_addr", field_type: "string", validation_rules: rules }),
    ];
    const schema = buildCreateInputSchema(fields);
    expect(schema.safeParse({ email_addr: "bad" }).success).toBe(false);
    expect(schema.safeParse({ email_addr: "good@example.com" }).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// serializeZodSchema — code generation and security
// ---------------------------------------------------------------------------

describe("serializeZodSchema", () => {
  it("starts with the correct export declaration using the entityName", () => {
    const code = serializeZodSchema([], "MyEntity");
    expect(code).toContain("export const MyEntitySchema = z.object({");
  });

  it("includes all five system column definitions in generated code", () => {
    const code = serializeZodSchema([], "Test");
    expect(code).toContain("_id: z.string().uuid()");
    expect(code).toContain("_createdAt: z.string().datetime()");
    expect(code).toContain("_updatedAt: z.string().datetime()");
    expect(code).toContain("_version: z.number().int()");
    expect(code).toContain("_sourceId: z.string().nullable()");
  });

  it("closes the object with a }); terminator", () => {
    const code = serializeZodSchema([], "Test");
    const trimmed = code.trimEnd();
    expect(trimmed.slice(-3)).toBe("});"  );
  });

  it("serializes a string field correctly", () => {
    const code = serializeZodSchema(
      [makeField({ slug: "title", field_type: "string" })],
      "Test",
    );
    expect(code).toContain("title: z.string()");
  });

  it("serializes a number field correctly", () => {
    const code = serializeZodSchema(
      [makeField({ slug: "score", field_type: "number" })],
      "Test",
    );
    expect(code).toContain("score: z.number()");
  });

  it("serializes a boolean field correctly", () => {
    const code = serializeZodSchema(
      [makeField({ slug: "active", field_type: "boolean" })],
      "Test",
    );
    expect(code).toContain("active: z.boolean()");
  });

  it("serializes a date field correctly", () => {
    const code = serializeZodSchema(
      [makeField({ slug: "created", field_type: "date" })],
      "Test",
    );
    expect(code).toContain("created: z.string().datetime()");
  });

  it("serializes a json field correctly", () => {
    const code = serializeZodSchema(
      [makeField({ slug: "meta", field_type: "json" })],
      "Test",
    );
    expect(code).toContain("meta: z.record(z.unknown())");
  });

  it("serializes a reference field correctly", () => {
    const code = serializeZodSchema(
      [makeField({ slug: "owner_id", field_type: "reference" })],
      "Test",
    );
    expect(code).toContain("owner_id: z.string().uuid()");
  });

  it("serializes an enum field using JSON.stringify — not raw interpolation (security fix)", () => {
    // Malicious enum value contains backticks and injection attempt.
    // JSON.stringify produces properly quoted string literals, preventing code injection.
    const maliciousValues = ['normal', '"); process.exit(1); //', '`injected`'];
    const code = serializeZodSchema(
      [
        makeField({
          slug: "status",
          field_type: "enum",
          enum_values: maliciousValues,
        }),
      ],
      "Test",
    );
    // The FULL JSON.stringify output must appear verbatim — values are quoted and escaped.
    const expectedJson = JSON.stringify(maliciousValues);
    expect(code).toContain(`z.enum(${expectedJson})`);
    // The backtick injection must appear JSON-escaped inside a string, not as a raw template literal.
    // JSON.stringify wraps it in double-quotes so it cannot break out of the string context.
    expect(code).toContain(JSON.stringify('`injected`'));
    // Confirm the value is not interpolated as a bare backtick outside a JSON string.
    // The literal substring `injected` (with surrounding backticks unescaped) would indicate
    // template-literal injection. JSON.stringify encodes the value inside double-quotes instead.
    expect(code).not.toContain("``injected``");
  });

  it("serializes enum with normal values using JSON.stringify encoding", () => {
    const code = serializeZodSchema(
      [
        makeField({
          slug: "role",
          field_type: "enum",
          enum_values: ["admin", "viewer", "editor"],
        }),
      ],
      "Test",
    );
    expect(code).toContain('z.enum(["admin","viewer","editor"])');
  });

  it("serializes an enum field with empty values as z.string()", () => {
    const code = serializeZodSchema(
      [makeField({ slug: "tag", field_type: "enum", enum_values: [] })],
      "Test",
    );
    expect(code).toContain("tag: z.string()");
  });

  it("serializes an array field with a specified item type", () => {
    const code = serializeZodSchema(
      [makeField({ slug: "tags", field_type: "array", array_item_type: "string" })],
      "Test",
    );
    expect(code).toContain("tags: z.array(z.string())");
  });

  it("serializes pattern rule using JSON.stringify for the regex value (XSS-safe)", () => {
    const dangerousPattern = ".*<script>.*";
    const rules: ValidationRule[] = [{ type: "pattern", value: dangerousPattern }];
    const code = serializeZodSchema(
      [makeField({ slug: "val", field_type: "string", validation_rules: rules })],
      "Test",
    );
    // The regex source must be JSON-encoded in the output
    expect(code).toContain(`new RegExp(${JSON.stringify(dangerousPattern)})`);
  });

  it("appends .nullable() for nullable fields", () => {
    const code = serializeZodSchema(
      [makeField({ slug: "bio", field_type: "string", nullable: true })],
      "Test",
    );
    expect(code).toContain("bio: z.string().nullable()");
  });

  it("appends .optional() for non-required fields", () => {
    const code = serializeZodSchema(
      [makeField({ slug: "middle_name", field_type: "string", required: false })],
      "Test",
    );
    expect(code).toContain("middle_name: z.string().optional()");
  });

  it("appends .nullable().optional() for nullable + non-required fields", () => {
    const code = serializeZodSchema(
      [
        makeField({
          slug: "alias",
          field_type: "string",
          nullable: true,
          required: false,
        }),
      ],
      "Test",
    );
    expect(code).toContain("alias: z.string().nullable().optional()");
  });

  it("serializes unknown field types as z.unknown()", () => {
    const code = serializeZodSchema(
      [makeField({ slug: "mystery", field_type: "custom_xyz" })],
      "Test",
    );
    expect(code).toContain("mystery: z.unknown()");
  });

  it("correctly includes minLength and maxLength chains for string fields", () => {
    const rules: ValidationRule[] = [
      { type: "minLength", value: 3 },
      { type: "maxLength", value: 50 },
    ];
    const code = serializeZodSchema(
      [makeField({ slug: "name", field_type: "string", validation_rules: rules })],
      "Test",
    );
    expect(code).toContain("z.string().min(3).max(50)");
  });

  it("correctly includes min and max chains for number fields", () => {
    const rules: ValidationRule[] = [
      { type: "min", value: 0 },
      { type: "max", value: 999 },
    ];
    const code = serializeZodSchema(
      [makeField({ slug: "qty", field_type: "number", validation_rules: rules })],
      "Test",
    );
    expect(code).toContain("z.number().min(0).max(999)");
  });
});
