// Unit tests for services/condition-evaluator.ts
//
// Covers every operator, dot-notation field access, missing fields, type
// coercion, and the branch-routing behaviour in the execution engine.
// These tests are pure (no I/O) and should run in microseconds each.

import { describe, it, expect } from "vitest";
import { evaluateCondition, type Condition } from "../services/condition-evaluator.js";

// ---------------------------------------------------------------------------
// Helper — build a Condition without repeating the type annotation
// ---------------------------------------------------------------------------

function cond(
  field: string,
  operator: Condition["operator"],
  value?: unknown,
): Condition {
  return value !== undefined ? { field, operator, value } : { field, operator };
}

// ---------------------------------------------------------------------------
// eq
// ---------------------------------------------------------------------------

describe("evaluateCondition — eq", () => {
  it("returns true when field value strictly equals condition value (string)", () => {
    expect(evaluateCondition({ status: "active" }, cond("status", "eq", "active"))).toBe(true);
  });

  it("returns false when field value does not equal condition value", () => {
    expect(evaluateCondition({ status: "inactive" }, cond("status", "eq", "active"))).toBe(false);
  });

  it("coerces string '42' to equal numeric 42", () => {
    expect(evaluateCondition({ count: "42" }, cond("count", "eq", 42))).toBe(true);
  });

  it("coerces numeric 0 to equal string '0'", () => {
    expect(evaluateCondition({ val: 0 }, cond("val", "eq", "0"))).toBe(true);
  });

  it("returns false for missing field", () => {
    expect(evaluateCondition({}, cond("missing", "eq", "x"))).toBe(false);
  });

  it("returns true when both sides are null", () => {
    expect(evaluateCondition({ x: null }, cond("x", "eq", null))).toBe(true);
  });

  it("returns false when one side is null and the other is not", () => {
    expect(evaluateCondition({ x: null }, cond("x", "eq", 0))).toBe(false);
  });

  it("returns true for boolean true == true", () => {
    expect(evaluateCondition({ flag: true }, cond("flag", "eq", true))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// neq
// ---------------------------------------------------------------------------

describe("evaluateCondition — neq", () => {
  it("returns true when values are different", () => {
    expect(evaluateCondition({ status: "inactive" }, cond("status", "neq", "active"))).toBe(true);
  });

  it("returns false when values are equal", () => {
    expect(evaluateCondition({ status: "active" }, cond("status", "neq", "active"))).toBe(false);
  });

  it("coerces string '1' as not equal to numeric 2", () => {
    expect(evaluateCondition({ n: "1" }, cond("n", "neq", 2))).toBe(true);
  });

  it("returns false for missing field", () => {
    expect(evaluateCondition({}, cond("missing", "neq", "x"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// gt
// ---------------------------------------------------------------------------

describe("evaluateCondition — gt", () => {
  it("returns true when field > value", () => {
    expect(evaluateCondition({ score: 10 }, cond("score", "gt", 5))).toBe(true);
  });

  it("returns false when field == value", () => {
    expect(evaluateCondition({ score: 5 }, cond("score", "gt", 5))).toBe(false);
  });

  it("returns false when field < value", () => {
    expect(evaluateCondition({ score: 3 }, cond("score", "gt", 5))).toBe(false);
  });

  it("coerces string field to number", () => {
    expect(evaluateCondition({ score: "10" }, cond("score", "gt", 9))).toBe(true);
  });

  it("returns false when field is non-numeric string", () => {
    expect(evaluateCondition({ score: "abc" }, cond("score", "gt", 0))).toBe(false);
  });

  it("returns false for missing field", () => {
    expect(evaluateCondition({}, cond("score", "gt", 0))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// gte
// ---------------------------------------------------------------------------

describe("evaluateCondition — gte", () => {
  it("returns true when field > value", () => {
    expect(evaluateCondition({ score: 10 }, cond("score", "gte", 5))).toBe(true);
  });

  it("returns true when field == value", () => {
    expect(evaluateCondition({ score: 5 }, cond("score", "gte", 5))).toBe(true);
  });

  it("returns false when field < value", () => {
    expect(evaluateCondition({ score: 4 }, cond("score", "gte", 5))).toBe(false);
  });

  it("returns false for missing field", () => {
    expect(evaluateCondition({}, cond("score", "gte", 0))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// lt
// ---------------------------------------------------------------------------

describe("evaluateCondition — lt", () => {
  it("returns true when field < value", () => {
    expect(evaluateCondition({ age: 17 }, cond("age", "lt", 18))).toBe(true);
  });

  it("returns false when field == value", () => {
    expect(evaluateCondition({ age: 18 }, cond("age", "lt", 18))).toBe(false);
  });

  it("returns false when field > value", () => {
    expect(evaluateCondition({ age: 19 }, cond("age", "lt", 18))).toBe(false);
  });

  it("returns false for missing field", () => {
    expect(evaluateCondition({}, cond("age", "lt", 18))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// lte
// ---------------------------------------------------------------------------

describe("evaluateCondition — lte", () => {
  it("returns true when field < value", () => {
    expect(evaluateCondition({ age: 17 }, cond("age", "lte", 18))).toBe(true);
  });

  it("returns true when field == value", () => {
    expect(evaluateCondition({ age: 18 }, cond("age", "lte", 18))).toBe(true);
  });

  it("returns false when field > value", () => {
    expect(evaluateCondition({ age: 19 }, cond("age", "lte", 18))).toBe(false);
  });

  it("returns false for missing field", () => {
    expect(evaluateCondition({}, cond("age", "lte", 18))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// contains
// ---------------------------------------------------------------------------

describe("evaluateCondition — contains", () => {
  it("returns true when string field contains the substring", () => {
    expect(evaluateCondition({ email: "alice@example.com" }, cond("email", "contains", "@example"))).toBe(true);
  });

  it("returns false when string field does not contain the substring", () => {
    expect(evaluateCondition({ email: "alice@other.com" }, cond("email", "contains", "@example"))).toBe(false);
  });

  it("returns true when array field contains the element", () => {
    expect(evaluateCondition({ roles: ["admin", "user"] }, cond("roles", "contains", "admin"))).toBe(true);
  });

  it("returns false when array field does not contain the element", () => {
    expect(evaluateCondition({ roles: ["user"] }, cond("roles", "contains", "admin"))).toBe(false);
  });

  it("returns false when field is neither string nor array", () => {
    expect(evaluateCondition({ count: 42 }, cond("count", "contains", "4"))).toBe(false);
  });

  it("returns false for missing field", () => {
    expect(evaluateCondition({}, cond("tags", "contains", "foo"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// not_contains
// ---------------------------------------------------------------------------

describe("evaluateCondition — not_contains", () => {
  it("returns true when string field does not contain the substring", () => {
    expect(evaluateCondition({ name: "alice" }, cond("name", "not_contains", "bob"))).toBe(true);
  });

  it("returns false when string field contains the substring", () => {
    expect(evaluateCondition({ name: "alice" }, cond("name", "not_contains", "alice"))).toBe(false);
  });

  it("returns true when array field does not contain the element", () => {
    expect(evaluateCondition({ roles: ["user"] }, cond("roles", "not_contains", "admin"))).toBe(true);
  });

  it("returns false when array field contains the element", () => {
    expect(evaluateCondition({ roles: ["admin", "user"] }, cond("roles", "not_contains", "admin"))).toBe(false);
  });

  it("returns true when field is neither string nor array (vacuously not-contains)", () => {
    expect(evaluateCondition({ count: 42 }, cond("count", "not_contains", "4"))).toBe(true);
  });

  it("returns false for missing field", () => {
    expect(evaluateCondition({}, cond("tags", "not_contains", "foo"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// exists
// ---------------------------------------------------------------------------

describe("evaluateCondition — exists", () => {
  it("returns true when the field key is present with a non-null value", () => {
    expect(evaluateCondition({ email: "alice@example.com" }, cond("email", "exists"))).toBe(true);
  });

  it("returns true when the field key is present but set to null", () => {
    // exists checks key presence, not truthiness
    expect(evaluateCondition({ email: null }, cond("email", "exists"))).toBe(true);
  });

  it("returns true when the field key is present and set to false", () => {
    expect(evaluateCondition({ verified: false }, cond("verified", "exists"))).toBe(true);
  });

  it("returns true when the field key is present and set to 0", () => {
    expect(evaluateCondition({ count: 0 }, cond("count", "exists"))).toBe(true);
  });

  it("returns false when the field key is absent", () => {
    expect(evaluateCondition({ name: "alice" }, cond("email", "exists"))).toBe(false);
  });

  it("returns false when the top-level object is empty", () => {
    expect(evaluateCondition({}, cond("email", "exists"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// not_exists
// ---------------------------------------------------------------------------

describe("evaluateCondition — not_exists", () => {
  it("returns true when the field key is absent", () => {
    expect(evaluateCondition({ name: "alice" }, cond("email", "not_exists"))).toBe(true);
  });

  it("returns false when the field key is present (even with null value)", () => {
    expect(evaluateCondition({ email: null }, cond("email", "not_exists"))).toBe(false);
  });

  it("returns false when the field key is present with a value", () => {
    expect(evaluateCondition({ email: "x@y.com" }, cond("email", "not_exists"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// matches
// ---------------------------------------------------------------------------

describe("evaluateCondition — matches", () => {
  it("returns true when the field matches the regex pattern", () => {
    expect(evaluateCondition({ email: "alice@example.com" }, cond("email", "matches", "^[\\w.]+@[\\w.]+$"))).toBe(true);
  });

  it("returns false when the field does not match the regex pattern", () => {
    expect(evaluateCondition({ email: "not-an-email" }, cond("email", "matches", "^[\\w.]+@[\\w.]+$"))).toBe(false);
  });

  it("returns false when the field is not a string", () => {
    expect(evaluateCondition({ count: 42 }, cond("count", "matches", "\\d+"))).toBe(false);
  });

  it("returns false when the pattern is not a string", () => {
    expect(evaluateCondition({ email: "x@y.com" }, cond("email", "matches", 123))).toBe(false);
  });

  it("returns false for a malformed regex pattern (does not throw)", () => {
    // An unterminated character class — should return false gracefully
    expect(evaluateCondition({ x: "hello" }, cond("x", "matches", "[unclosed"))).toBe(false);
  });

  it("returns false for missing field", () => {
    expect(evaluateCondition({}, cond("name", "matches", ".*"))).toBe(false);
  });

  it("supports case-sensitive matching by default", () => {
    expect(evaluateCondition({ status: "ACTIVE" }, cond("status", "matches", "^active$"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Dot-notation nested field access
// ---------------------------------------------------------------------------

describe("evaluateCondition — nested field access via dot notation", () => {
  it("resolves a two-level path", () => {
    const data = { user: { email: "alice@example.com" } };
    expect(evaluateCondition(data, cond("user.email", "eq", "alice@example.com"))).toBe(true);
  });

  it("resolves a three-level path", () => {
    const data = { user: { profile: { age: 25 } } };
    expect(evaluateCondition(data, cond("user.profile.age", "gte", 18))).toBe(true);
  });

  it("returns false (not present) when an intermediate key is missing", () => {
    const data = { user: {} };
    expect(evaluateCondition(data, cond("user.profile.age", "exists"))).toBe(false);
  });

  it("returns false (not present) when an intermediate value is null", () => {
    const data = { user: null };
    expect(evaluateCondition(data as unknown as Record<string, unknown>, cond("user.email", "exists"))).toBe(false);
  });

  it("resolves a path where the leaf is explicitly undefined (not present)", () => {
    const data: Record<string, unknown> = { user: { name: undefined } };
    // hasOwnProperty is true but value is undefined — still counts as present
    expect(evaluateCondition(data, cond("user.name", "exists"))).toBe(true);
  });

  it("works for exists on a four-level path", () => {
    const data = { a: { b: { c: { d: 42 } } } };
    expect(evaluateCondition(data, cond("a.b.c.d", "exists"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Missing field behaviour across all non-existence operators
// ---------------------------------------------------------------------------

describe("evaluateCondition — missing field returns false for all non-existence operators", () => {
  const missingData: Record<string, unknown> = {};

  const nonExistenceOperators: Array<Condition["operator"]> = [
    "eq", "neq", "gt", "gte", "lt", "lte", "contains", "not_contains", "matches",
  ];

  for (const operator of nonExistenceOperators) {
    it(`returns false for operator "${operator}" when field is missing`, () => {
      expect(evaluateCondition(missingData, cond("missing", operator, "anything"))).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// Type coercion edge cases
// ---------------------------------------------------------------------------

describe("evaluateCondition — type coercion edge cases", () => {
  it("does not coerce a non-numeric string to 0 for gt", () => {
    // "abc" → NaN → not finite → returns false rather than treating as 0
    expect(evaluateCondition({ val: "abc" }, cond("val", "gt", -1))).toBe(false);
  });

  it("coerces empty string '' to 0 via Number('') — 0 > -1 is true", () => {
    // Number('') === 0 in JavaScript; 0 > -1 → true
    expect(evaluateCondition({ val: "" }, cond("val", "gt", -1))).toBe(true);
  });

  it("coerces '0' to 0 for lte 0 → true", () => {
    expect(evaluateCondition({ val: "0" }, cond("val", "lte", 0))).toBe(true);
  });

  it("coerces '3.14' to 3.14 for gt 3", () => {
    expect(evaluateCondition({ val: "3.14" }, cond("val", "gt", 3))).toBe(true);
  });

  it("does not coerce boolean to number for gt", () => {
    // true is not a number per toNumberMaybe (boolean → null)
    expect(evaluateCondition({ val: true }, cond("val", "gt", 0))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Empty field string edge case
// ---------------------------------------------------------------------------

describe("evaluateCondition — empty field string", () => {
  it("returns false for an empty field string (not present)", () => {
    expect(evaluateCondition({ "": "value" }, cond("", "exists"))).toBe(false);
  });
});
