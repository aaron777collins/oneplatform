// Unit tests for utils/field-type-to-pg.ts
// Covers: fieldTypeToPostgres() — all eight known FieldType values
// and the behaviour when an unknown type is passed.

import { describe, it, expect } from "vitest";
import { fieldTypeToPostgres } from "../utils/field-type-to-pg.js";
import type { FieldType } from "../utils/field-type-to-pg.js";

// ---------------------------------------------------------------------------
// Known field-type mappings
// ---------------------------------------------------------------------------

describe("fieldTypeToPostgres()", () => {
  it("maps 'string' to TEXT", () => {
    expect(fieldTypeToPostgres("string")).toBe("TEXT");
  });

  it("maps 'number' to NUMERIC(19, 4) with precision and scale", () => {
    expect(fieldTypeToPostgres("number")).toBe("NUMERIC(19, 4)");
  });

  it("maps 'boolean' to BOOLEAN", () => {
    expect(fieldTypeToPostgres("boolean")).toBe("BOOLEAN");
  });

  it("maps 'date' to TIMESTAMPTZ (timezone-aware)", () => {
    expect(fieldTypeToPostgres("date")).toBe("TIMESTAMPTZ");
  });

  it("maps 'json' to JSONB", () => {
    expect(fieldTypeToPostgres("json")).toBe("JSONB");
  });

  it("maps 'reference' to UUID", () => {
    expect(fieldTypeToPostgres("reference")).toBe("UUID");
  });

  it("maps 'enum' to TEXT (constraint is handled separately at DDL level)", () => {
    expect(fieldTypeToPostgres("enum")).toBe("TEXT");
  });

  it("maps 'array' to JSONB", () => {
    expect(fieldTypeToPostgres("array")).toBe("JSONB");
  });

  // -------------------------------------------------------------------------
  // Exhaustiveness — all eight FieldType values are covered
  // -------------------------------------------------------------------------

  it("covers all eight members of the FieldType union without undefined gaps", () => {
    const allTypes: FieldType[] = [
      "string",
      "number",
      "boolean",
      "date",
      "json",
      "reference",
      "enum",
      "array",
    ];
    for (const t of allTypes) {
      expect(fieldTypeToPostgres(t)).toBeTruthy();
    }
  });

  // -------------------------------------------------------------------------
  // Unknown type
  // The implementation indexes into a Record<FieldType, string> so a cast of
  // an unknown string returns undefined at runtime.  Callers must not pass
  // arbitrary strings, but we verify the runtime behaviour explicitly so that
  // any future "throw on unknown" guard can be tested here too.
  // -------------------------------------------------------------------------

  it("returns undefined for an unknown field type (no throw from simple map lookup)", () => {
    // Cast deliberately breaks the type system to simulate a runtime bad value.
    const result = fieldTypeToPostgres("unknown_type" as FieldType);
    // The current implementation does a plain map lookup — returns undefined.
    expect(result).toBeUndefined();
  });

  it("returns undefined for an empty-string field type", () => {
    const result = fieldTypeToPostgres("" as FieldType);
    expect(result).toBeUndefined();
  });
});
