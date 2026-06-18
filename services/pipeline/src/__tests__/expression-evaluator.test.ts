// Unit tests for services/expression-evaluator.ts (G-051)
//
// The expression evaluator is the safety-critical component of the transform
// engine: it must parse and evaluate user-supplied expressions WITHOUT
// allowing access to globals, prototype chains, or eval().
// Tests cover:
//   - Every operator type
//   - All built-in functions
//   - Field path resolution (including nested fields)
//   - Short-circuit evaluation of && and ||
//   - Security: blocked identifiers must throw
//   - Error cases: syntax errors, division by zero, depth limits

import { describe, it, expect } from "vitest";
import {
  evaluate,
  evaluateBoolean,
  ExpressionEvaluatorError,
} from "../services/expression-evaluator.js";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function ctx(record: Record<string, unknown>) {
  return { record };
}

// ---------------------------------------------------------------------------
// Literals
// ---------------------------------------------------------------------------

describe("literals", () => {
  it("evaluates an integer literal", () => {
    expect(evaluate("42", ctx({}))).toBe(42);
  });

  it("evaluates a float literal", () => {
    expect(evaluate("3.14", ctx({}))).toBe(3.14);
  });

  it("evaluates a double-quoted string literal", () => {
    expect(evaluate('"hello"', ctx({}))).toBe("hello");
  });

  it("evaluates a single-quoted string literal", () => {
    expect(evaluate("'world'", ctx({}))).toBe("world");
  });

  it("evaluates true", () => {
    expect(evaluate("true", ctx({}))).toBe(true);
  });

  it("evaluates false", () => {
    expect(evaluate("false", ctx({}))).toBe(false);
  });

  it("evaluates null", () => {
    expect(evaluate("null", ctx({}))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Field references
// ---------------------------------------------------------------------------

describe("field references", () => {
  it("reads a top-level field from the record", () => {
    expect(evaluate("age", ctx({ age: 30 }))).toBe(30);
  });

  it("reads a nested field using dot notation", () => {
    expect(evaluate("user.name", ctx({ user: { name: "Alice" } }))).toBe("Alice");
  });

  it("returns undefined for a missing field", () => {
    expect(evaluate("missing", ctx({}))).toBeUndefined();
  });

  it("returns undefined for a missing nested field", () => {
    expect(evaluate("a.b.c", ctx({ a: { b: null } }))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Arithmetic operators
// ---------------------------------------------------------------------------

describe("arithmetic", () => {
  it("adds two numbers", () => {
    expect(evaluate("1 + 2", ctx({}))).toBe(3);
  });

  it("subtracts two numbers", () => {
    expect(evaluate("10 - 4", ctx({}))).toBe(6);
  });

  it("multiplies two numbers", () => {
    expect(evaluate("3 * 4", ctx({}))).toBe(12);
  });

  it("divides two numbers", () => {
    expect(evaluate("10 / 4", ctx({}))).toBe(2.5);
  });

  it("computes modulo", () => {
    expect(evaluate("10 % 3", ctx({}))).toBe(1);
  });

  it("applies operator precedence (* before +)", () => {
    expect(evaluate("2 + 3 * 4", ctx({}))).toBe(14);
  });

  it("respects parentheses over precedence", () => {
    expect(evaluate("(2 + 3) * 4", ctx({}))).toBe(20);
  });

  it("uses field values in arithmetic", () => {
    expect(evaluate("price * quantity", ctx({ price: 5, quantity: 3 }))).toBe(15);
  });

  it("concatenates strings with + when one side is a string", () => {
    expect(evaluate('"Hello " + name', ctx({ name: "World" }))).toBe("Hello World");
  });

  it("throws ExpressionEvaluatorError on division by zero", () => {
    expect(() => evaluate("1 / 0", ctx({}))).toThrow(ExpressionEvaluatorError);
    expect(() => evaluate("1 / 0", ctx({}))).toThrow("Division by zero");
  });

  it("throws ExpressionEvaluatorError on modulo by zero", () => {
    expect(() => evaluate("5 % 0", ctx({}))).toThrow(ExpressionEvaluatorError);
  });
});

// ---------------------------------------------------------------------------
// Comparison operators
// ---------------------------------------------------------------------------

describe("comparison operators", () => {
  it("== returns true for equal values", () => {
    expect(evaluate("1 == 1", ctx({}))).toBe(true);
  });

  it("== returns false for unequal values", () => {
    expect(evaluate("1 == 2", ctx({}))).toBe(false);
  });

  it("!= returns true for unequal values", () => {
    expect(evaluate("1 != 2", ctx({}))).toBe(true);
  });

  it("< returns true when left is less", () => {
    expect(evaluate("1 < 2", ctx({}))).toBe(true);
  });

  it("<= returns true for equal values", () => {
    expect(evaluate("2 <= 2", ctx({}))).toBe(true);
  });

  it("> returns true when left is greater", () => {
    expect(evaluate("3 > 2", ctx({}))).toBe(true);
  });

  it(">= returns true for equal values", () => {
    expect(evaluate("3 >= 3", ctx({}))).toBe(true);
  });

  it("compares a field value to a literal", () => {
    expect(evaluate("score > 80", ctx({ score: 90 }))).toBe(true);
    expect(evaluate("score > 80", ctx({ score: 70 }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Logical operators
// ---------------------------------------------------------------------------

describe("logical operators", () => {
  it("&& returns true when both sides are truthy", () => {
    expect(evaluate("true && true", ctx({}))).toBe(true);
  });

  it("&& returns false when left is falsy", () => {
    expect(evaluate("false && true", ctx({}))).toBe(false);
  });

  it("|| returns true when left is truthy (short-circuits)", () => {
    expect(evaluate("true || false", ctx({}))).toBe(true);
  });

  it("|| returns true when right is truthy", () => {
    expect(evaluate("false || true", ctx({}))).toBe(true);
  });

  it("|| returns false when both sides are falsy", () => {
    expect(evaluate("false || false", ctx({}))).toBe(false);
  });

  it("! negates a truthy value", () => {
    expect(evaluate("!true", ctx({}))).toBe(false);
  });

  it("! negates a falsy value", () => {
    expect(evaluate("!false", ctx({}))).toBe(true);
  });

  it("short-circuits && (right side not evaluated on false left)", () => {
    // If right side were evaluated with a missing operand it would throw;
    // the fact that it doesn't throw proves short-circuiting works.
    expect(evaluate("false && missing_fn()", ctx({}))).toBe(false);
  });

  it("complex logical expression with fields", () => {
    const record = { age: 25, active: true };
    expect(evaluate("age >= 18 && active == true", ctx(record))).toBe(true);
    expect(evaluate("age >= 18 && active == false", ctx(record))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unary minus
// ---------------------------------------------------------------------------

describe("unary minus", () => {
  it("negates a numeric literal", () => {
    expect(evaluate("-5", ctx({}))).toBe(-5);
  });

  it("negates a field value", () => {
    expect(evaluate("-amount", ctx({ amount: 10 }))).toBe(-10);
  });
});

// ---------------------------------------------------------------------------
// Built-in functions
// ---------------------------------------------------------------------------

describe("built-ins — string", () => {
  it("startsWith returns true when string starts with prefix", () => {
    expect(evaluate('startsWith(name, "Al")', ctx({ name: "Alice" }))).toBe(true);
  });

  it("startsWith returns false when string does not start with prefix", () => {
    expect(evaluate('startsWith(name, "Bob")', ctx({ name: "Alice" }))).toBe(false);
  });

  it("endsWith returns true when string ends with suffix", () => {
    expect(evaluate('endsWith(email, ".com")', ctx({ email: "test@example.com" }))).toBe(true);
  });

  it("includes returns true when substring is present", () => {
    expect(evaluate('includes(desc, "cat")', ctx({ desc: "concatenate" }))).toBe(true);
  });

  it("toLowerCase converts to lowercase", () => {
    expect(evaluate("toLowerCase(name)", ctx({ name: "ALICE" }))).toBe("alice");
  });

  it("toUpperCase converts to uppercase", () => {
    expect(evaluate("toUpperCase(name)", ctx({ name: "alice" }))).toBe("ALICE");
  });

  it("trim removes leading/trailing whitespace", () => {
    expect(evaluate("trim(s)", ctx({ s: "  hello  " }))).toBe("hello");
  });

  it("length returns string length", () => {
    expect(evaluate("length(s)", ctx({ s: "hello" }))).toBe(5);
  });

  it("toString converts a number to string", () => {
    expect(evaluate("toString(n)", ctx({ n: 42 }))).toBe("42");
  });

  it("toString returns empty string for null", () => {
    expect(evaluate("toString(v)", ctx({ v: null }))).toBe("");
  });

  it("concat joins multiple arguments", () => {
    expect(evaluate('concat("Hello", " ", name)', ctx({ name: "World" }))).toBe("Hello World");
  });
});

describe("built-ins — numeric", () => {
  it("toNumber converts a string to number", () => {
    expect(evaluate("toNumber(s)", ctx({ s: "3.14" }))).toBe(3.14);
  });

  it("toNumber returns null for non-numeric string", () => {
    expect(evaluate("toNumber(s)", ctx({ s: "abc" }))).toBeNull();
  });

  it("round rounds to the specified digits", () => {
    expect(evaluate("round(v, 2)", ctx({ v: 3.14159 }))).toBe(3.14);
  });

  it("round with no digits rounds to integer", () => {
    expect(evaluate("round(v)", ctx({ v: 3.6 }))).toBe(4);
  });

  it("floor returns the floor", () => {
    expect(evaluate("floor(v)", ctx({ v: 3.9 }))).toBe(3);
  });

  it("ceil returns the ceiling", () => {
    expect(evaluate("ceil(v)", ctx({ v: 3.1 }))).toBe(4);
  });

  it("abs returns absolute value", () => {
    expect(evaluate("abs(v)", ctx({ v: -5 }))).toBe(5);
  });
});

describe("built-ins — null checking", () => {
  it("isNull returns true for null", () => {
    expect(evaluate("isNull(v)", ctx({ v: null }))).toBe(true);
  });

  it("isNull returns false for non-null", () => {
    expect(evaluate("isNull(v)", ctx({ v: 0 }))).toBe(false);
  });

  it("isNotNull returns true for non-null", () => {
    expect(evaluate("isNotNull(v)", ctx({ v: "x" }))).toBe(true);
  });

  it("coalesce returns first non-null value", () => {
    expect(evaluate("coalesce(a, b, 42)", ctx({ a: null, b: null }))).toBe(42);
  });

  it("coalesce returns first argument if non-null", () => {
    expect(evaluate("coalesce(a, b)", ctx({ a: 10, b: 20 }))).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// evaluateBoolean helper
// ---------------------------------------------------------------------------

describe("evaluateBoolean", () => {
  it("returns true for a truthy expression", () => {
    expect(evaluateBoolean("score > 80", ctx({ score: 90 }))).toBe(true);
  });

  it("returns false for a falsy expression", () => {
    expect(evaluateBoolean("score > 80", ctx({ score: 70 }))).toBe(false);
  });

  it("coerces non-boolean truthy result to true", () => {
    expect(evaluateBoolean("42", ctx({}))).toBe(true);
  });

  it("coerces zero to false", () => {
    expect(evaluateBoolean("0", ctx({}))).toBe(false);
  });

  it("coerces empty string to false", () => {
    expect(evaluateBoolean('""', ctx({}))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Security: blocked identifiers
// ---------------------------------------------------------------------------

describe("security — blocked identifiers", () => {
  it("throws ExpressionEvaluatorError for 'eval'", () => {
    expect(() => evaluate("eval", ctx({}))).toThrow(ExpressionEvaluatorError);
    expect(() => evaluate("eval", ctx({}))).toThrow("not permitted");
  });

  it("throws for 'globalThis'", () => {
    expect(() => evaluate("globalThis", ctx({}))).toThrow(ExpressionEvaluatorError);
  });

  it("throws for 'process'", () => {
    expect(() => evaluate("process", ctx({}))).toThrow(ExpressionEvaluatorError);
  });

  it("throws for '__proto__'", () => {
    expect(() => evaluate("__proto__", ctx({}))).toThrow(ExpressionEvaluatorError);
  });

  it("throws for 'constructor'", () => {
    expect(() => evaluate("constructor", ctx({}))).toThrow(ExpressionEvaluatorError);
  });

  it("throws for 'Function'", () => {
    expect(() => evaluate("Function", ctx({}))).toThrow(ExpressionEvaluatorError);
  });
});

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

describe("error handling", () => {
  it("throws ExpressionEvaluatorError for expression exceeding 2000 chars", () => {
    const longExpr = "a".repeat(2001);
    expect(() => evaluate(longExpr, ctx({}))).toThrow(ExpressionEvaluatorError);
    expect(() => evaluate(longExpr, ctx({}))).toThrow("2000 character limit");
  });

  it("throws for unexpected characters", () => {
    expect(() => evaluate("a @ b", ctx({}))).toThrow(ExpressionEvaluatorError);
  });

  it("throws for unclosed parenthesis", () => {
    expect(() => evaluate("(1 + 2", ctx({}))).toThrow(ExpressionEvaluatorError);
  });

  it("throws for unknown function name", () => {
    expect(() => evaluate("unknownFn(1)", ctx({}))).toThrow(ExpressionEvaluatorError);
    expect(() => evaluate("unknownFn(1)", ctx({}))).toThrow("Unknown function");
  });

  it("throws for applying arithmetic to a non-number", () => {
    expect(() => evaluate('"hello" - 1', ctx({}))).toThrow(ExpressionEvaluatorError);
  });
});
