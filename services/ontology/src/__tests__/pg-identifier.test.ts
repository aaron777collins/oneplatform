// Unit tests for utils/pg-identifier.ts
// Covers: quotePgIdentifier(), tenantSchemaName(), isReservedSlug(), deriveSlug().

import { describe, it, expect } from "vitest";
import {
  quotePgIdentifier,
  tenantSchemaName,
  isReservedSlug,
  deriveSlug,
} from "../utils/pg-identifier.js";

// ---------------------------------------------------------------------------
// quotePgIdentifier
// ---------------------------------------------------------------------------

describe("quotePgIdentifier()", () => {
  it("wraps a normal lowercase slug in double quotes", () => {
    expect(quotePgIdentifier("my_table")).toBe('"my_table"');
  });

  it("wraps a single-character identifier", () => {
    expect(quotePgIdentifier("a")).toBe('"a"');
  });

  it("accepts identifiers containing digits after the first character", () => {
    expect(quotePgIdentifier("col1")).toBe('"col1"');
  });

  it("accepts identifiers with underscores in the middle", () => {
    expect(quotePgIdentifier("first_name")).toBe('"first_name"');
  });

  it("accepts identifiers that start with a letter followed only by underscores and digits", () => {
    expect(quotePgIdentifier("a1_2_3")).toBe('"a1_2_3"');
  });

  it("throws for an identifier that starts with a digit", () => {
    expect(() => quotePgIdentifier("1table")).toThrow('Invalid PostgreSQL identifier: "1table"');
  });

  it("throws for an identifier that starts with an underscore", () => {
    expect(() => quotePgIdentifier("_private")).toThrow('Invalid PostgreSQL identifier: "_private"');
  });

  it("throws for an identifier containing uppercase letters", () => {
    expect(() => quotePgIdentifier("MyTable")).toThrow('Invalid PostgreSQL identifier: "MyTable"');
  });

  it("throws for an identifier containing a space (SQL injection via space)", () => {
    expect(() => quotePgIdentifier("my table")).toThrow("Invalid PostgreSQL identifier");
  });

  it("throws for an identifier containing a semicolon injection attempt", () => {
    expect(() => quotePgIdentifier("t;drop table users--")).toThrow("Invalid PostgreSQL identifier");
  });

  it("throws for an identifier containing a single-quote injection attempt", () => {
    expect(() => quotePgIdentifier("t'injection")).toThrow("Invalid PostgreSQL identifier");
  });

  it("throws for an identifier containing a double-quote injection attempt", () => {
    // Double-quote would break out of the quoted identifier context
    expect(() => quotePgIdentifier('t"break')).toThrow("Invalid PostgreSQL identifier");
  });

  it("throws for an identifier containing a hyphen", () => {
    expect(() => quotePgIdentifier("my-table")).toThrow("Invalid PostgreSQL identifier");
  });

  it("throws for an empty string", () => {
    expect(() => quotePgIdentifier("")).toThrow("Invalid PostgreSQL identifier");
  });

  it("throws for an identifier that is only digits", () => {
    expect(() => quotePgIdentifier("123")).toThrow("Invalid PostgreSQL identifier");
  });

  it("throws for an identifier with a dot (schema-qualification injection)", () => {
    expect(() => quotePgIdentifier("public.users")).toThrow("Invalid PostgreSQL identifier");
  });

  it("throws for an identifier containing a newline character", () => {
    expect(() => quotePgIdentifier("foo\nbar")).toThrow("Invalid PostgreSQL identifier");
  });
});

// ---------------------------------------------------------------------------
// tenantSchemaName
// ---------------------------------------------------------------------------

describe("tenantSchemaName()", () => {
  it("strips hyphens from a standard UUID and prefixes with tenant_", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    expect(tenantSchemaName(uuid)).toBe("tenant_550e8400e29b41d4a716446655440000");
  });

  it("preserves hex characters (a-f, 0-9) exactly", () => {
    const uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    expect(tenantSchemaName(uuid)).toBe("tenant_aaaaaaaabbbbccccddddeeeeeeeeeeee");
  });

  it("handles a UUID with all zeros", () => {
    const uuid = "00000000-0000-0000-0000-000000000000";
    expect(tenantSchemaName(uuid)).toBe("tenant_00000000000000000000000000000000");
  });

  it("produces the same output when the UUID has no hyphens (already stripped)", () => {
    const raw = "550e8400e29b41d4a716446655440000";
    expect(tenantSchemaName(raw)).toBe(`tenant_${raw}`);
  });

  it("handles multiple consecutive hyphens gracefully", () => {
    // Edge case: pathological input — all hyphens removed regardless of position
    expect(tenantSchemaName("ab--cd")).toBe("tenant_abcd");
  });
});

// ---------------------------------------------------------------------------
// isReservedSlug
// ---------------------------------------------------------------------------

describe("isReservedSlug()", () => {
  it("returns true for 'bulk'", () => {
    expect(isReservedSlug("bulk")).toBe(true);
  });

  it("returns true for 'id'", () => {
    expect(isReservedSlug("id")).toBe(true);
  });

  it("returns true for 'migrations'", () => {
    expect(isReservedSlug("migrations")).toBe(true);
  });

  it("returns true for 'validate'", () => {
    expect(isReservedSlug("validate")).toBe(true);
  });

  it("returns true for 'drafts'", () => {
    expect(isReservedSlug("drafts")).toBe(true);
  });

  it("returns true for 'mappings'", () => {
    expect(isReservedSlug("mappings")).toBe(true);
  });

  it("returns true for any slug that starts with an underscore", () => {
    expect(isReservedSlug("_id")).toBe(true);
    expect(isReservedSlug("_created_at")).toBe(true);
    expect(isReservedSlug("_")).toBe(true);
  });

  it("returns false for a normal user slug", () => {
    expect(isReservedSlug("customer")).toBe(false);
  });

  it("returns false for a slug that contains a reserved word as a substring", () => {
    expect(isReservedSlug("bulkupdate")).toBe(false);
    expect(isReservedSlug("validated")).toBe(false);
  });

  it("is case-sensitive: 'Bulk' is not reserved", () => {
    expect(isReservedSlug("Bulk")).toBe(false);
  });

  it("returns false for an empty string", () => {
    // Empty string does not start with _ and is not in the reserved set
    expect(isReservedSlug("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// deriveSlug
// ---------------------------------------------------------------------------

describe("deriveSlug()", () => {
  it("lowercases a simple name", () => {
    expect(deriveSlug("Customer")).toBe("customer");
  });

  it("replaces spaces with underscores", () => {
    expect(deriveSlug("Product Category")).toBe("product_category");
  });

  it("collapses multiple consecutive spaces into a single underscore", () => {
    expect(deriveSlug("a  b")).toBe("a_b");
  });

  it("removes characters that are not alphanumeric or underscore", () => {
    expect(deriveSlug("Invoice #42!")).toBe("invoice_42");
  });

  it("strips leading underscores produced by non-alphanumeric prefixes", () => {
    expect(deriveSlug("!Leading bang")).toBe("leading_bang");
  });

  it("strips trailing underscores produced by non-alphanumeric suffixes", () => {
    expect(deriveSlug("Trailing bang!")).toBe("trailing_bang");
  });

  it("handles a name with only special characters by returning an empty string", () => {
    expect(deriveSlug("!@#$%")).toBe("");
  });

  it("handles a name that is already a valid slug unchanged", () => {
    expect(deriveSlug("order_item")).toBe("order_item");
  });

  it("handles unicode letters by stripping them (non-ASCII removed)", () => {
    // ü → not matched by [a-z0-9_] → removed
    expect(deriveSlug("Über cool")).toBe("ber_cool");
  });

  it("handles a name that is all uppercase with underscores", () => {
    expect(deriveSlug("MY_ENTITY")).toBe("my_entity");
  });

  it("handles leading and trailing whitespace without producing boundary underscores", () => {
    expect(deriveSlug("  padded  ")).toBe("padded");
  });

  it("handles a single word with mixed case", () => {
    expect(deriveSlug("OrderLineItem")).toBe("orderlineitem");
  });

  it("handles digits-only name", () => {
    expect(deriveSlug("123")).toBe("123");
  });
});
