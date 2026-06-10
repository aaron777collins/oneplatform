// Unit tests for migration-service.ts
// Covers: classifyChange() pure function and isTypeWiden().
// No I/O, no mocks needed — all pure logic.

import { describe, it, expect } from "vitest";
import { classifyChange, isTypeWiden } from "../services/migration-service.js";
import type { EntityDiff, ChangeClassification } from "../services/migration-service.js";
import type { FieldRow } from "../repositories/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFieldRow(overrides: Partial<FieldRow> = {}): FieldRow {
  return {
    id: "f-1",
    entity_id: "e-1",
    tenant_id: "t-1",
    name: "A Field",
    slug: "a_field",
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

function classify(
  diff: EntityDiff,
  existingFields: FieldRow[] = [],
  hasData = false,
): ChangeClassification {
  return classifyChange(diff, existingFields, hasData).classification;
}

function changes(diff: EntityDiff, existingFields: FieldRow[] = [], hasData = false) {
  return classifyChange(diff, existingFields, hasData).changes;
}

// ---------------------------------------------------------------------------
// Metadata-only changes
// ---------------------------------------------------------------------------

describe("classifyChange — metadata-only changes", () => {
  it("returns backward_compatible when only nameChanged is set", () => {
    expect(classify({ nameChanged: true })).toBe("backward_compatible");
  });

  it("returns backward_compatible when only descriptionChanged is set", () => {
    expect(classify({ descriptionChanged: true })).toBe("backward_compatible");
  });

  it("returns backward_compatible when only isPublicChanged is set", () => {
    expect(classify({ isPublicChanged: true })).toBe("backward_compatible");
  });

  it("returns backward_compatible for all three metadata flags together", () => {
    expect(classify({ nameChanged: true, descriptionChanged: true, isPublicChanged: true })).toBe(
      "backward_compatible",
    );
  });

  it("includes update_metadata change entries for each metadata flag set", () => {
    const result = classifyChange(
      { nameChanged: true, descriptionChanged: true },
      [],
      false,
    );
    const types = result.changes.map((c) => c.type);
    expect(types.filter((t) => t === "update_metadata")).toHaveLength(2);
  });

  it("returns backward_compatible for an empty diff with metadataOnly=true", () => {
    expect(classify({ metadataOnly: true })).toBe("backward_compatible");
  });

  it("returns backward_compatible for a completely empty diff", () => {
    expect(classify({})).toBe("backward_compatible");
  });

  it("returns an empty changes array for a completely empty diff", () => {
    expect(changes({})).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Adding fields
// ---------------------------------------------------------------------------

describe("classifyChange — adding fields", () => {
  it("adding an optional field (required=false) is backward_compatible even with data", () => {
    const diff: EntityDiff = {
      addFields: [{ slug: "bio", fieldType: "string", required: false, nullable: false }],
    };
    expect(classify(diff, [], true)).toBe("backward_compatible");
  });

  it("adding a nullable required field is backward_compatible even with data", () => {
    const diff: EntityDiff = {
      addFields: [{ slug: "note", fieldType: "string", required: true, nullable: true }],
    };
    expect(classify(diff, [], true)).toBe("backward_compatible");
  });

  it("adding a required non-nullable field with a default is backward_compatible even with data", () => {
    const diff: EntityDiff = {
      addFields: [
        {
          slug: "status",
          fieldType: "string",
          required: true,
          nullable: false,
          defaultValue: "active",
        },
      ],
    };
    expect(classify(diff, [], true)).toBe("backward_compatible");
  });

  it("adding a required non-nullable field WITHOUT a default is breaking when hasData=true", () => {
    const diff: EntityDiff = {
      addFields: [{ slug: "name", fieldType: "string", required: true, nullable: false }],
    };
    expect(classify(diff, [], true)).toBe("breaking");
  });

  it("adding a required non-nullable field WITHOUT a default is backward_compatible when hasData=false", () => {
    const diff: EntityDiff = {
      addFields: [{ slug: "name", fieldType: "string", required: true, nullable: false }],
    };
    expect(classify(diff, [], false)).toBe("backward_compatible");
  });

  it("records add_required_field_no_default change type for breaking add", () => {
    const diff: EntityDiff = {
      addFields: [{ slug: "code", fieldType: "string", required: true, nullable: false }],
    };
    const result = classifyChange(diff, [], true);
    const entry = result.changes.find((c) => c.type === "add_required_field_no_default");
    expect(entry).toBeDefined();
    expect(entry?.fieldSlug).toBe("code");
  });

  it("records add_field change type for non-breaking adds", () => {
    const diff: EntityDiff = {
      addFields: [{ slug: "nickname", fieldType: "string", required: false, nullable: true }],
    };
    const result = classifyChange(diff, [], true);
    expect(result.changes[0]?.type).toBe("add_field");
    expect(result.changes[0]?.fieldSlug).toBe("nickname");
  });

  it("correctly classifies a mix of safe and breaking adds in one diff", () => {
    const diff: EntityDiff = {
      addFields: [
        { slug: "safe", fieldType: "string", required: false, nullable: false },
        { slug: "breaking", fieldType: "string", required: true, nullable: false },
      ],
    };
    const result = classifyChange(diff, [], true);
    expect(result.classification).toBe("breaking");
    expect(result.changes).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Removing fields
// ---------------------------------------------------------------------------

describe("classifyChange — removing fields", () => {
  it("removing any field is always breaking", () => {
    const diff: EntityDiff = { removeFieldSlugs: ["old_field"] };
    expect(classify(diff, [], false)).toBe("breaking");
  });

  it("removing a field when hasData=true is breaking", () => {
    const diff: EntityDiff = { removeFieldSlugs: ["col"] };
    expect(classify(diff, [], true)).toBe("breaking");
  });

  it("records a remove_field change entry with the correct slug", () => {
    const diff: EntityDiff = { removeFieldSlugs: ["legacy_col"] };
    const result = classifyChange(diff, [], true);
    const entry = result.changes.find((c) => c.type === "remove_field");
    expect(entry?.fieldSlug).toBe("legacy_col");
  });

  it("removing multiple fields records one change entry per slug", () => {
    const diff: EntityDiff = { removeFieldSlugs: ["col_a", "col_b", "col_c"] };
    const result = classifyChange(diff, [], false);
    const removals = result.changes.filter((c) => c.type === "remove_field");
    expect(removals).toHaveLength(3);
    expect(removals.map((r) => r.fieldSlug)).toEqual(
      expect.arrayContaining(["col_a", "col_b", "col_c"]),
    );
  });
});

// ---------------------------------------------------------------------------
// Renaming fields
// ---------------------------------------------------------------------------

describe("classifyChange — renaming fields", () => {
  it("renaming a field is always breaking", () => {
    const diff: EntityDiff = {
      renameFields: [{ fromSlug: "old_name", toSlug: "new_name" }],
    };
    expect(classify(diff, [], false)).toBe("breaking");
  });

  it("renaming a field is breaking even with no existing data", () => {
    const diff: EntityDiff = {
      renameFields: [{ fromSlug: "x", toSlug: "y" }],
    };
    expect(classify(diff, [], false)).toBe("breaking");
  });

  it("records rename_field change with fromSlug as fieldSlug and toSlug in details", () => {
    const diff: EntityDiff = {
      renameFields: [{ fromSlug: "old", toSlug: "new" }],
    };
    const result = classifyChange(diff, [], false);
    const entry = result.changes.find((c) => c.type === "rename_field");
    expect(entry?.fieldSlug).toBe("old");
    expect(entry?.details).toContain("new");
  });

  it("renaming multiple fields records one entry per rename", () => {
    const diff: EntityDiff = {
      renameFields: [
        { fromSlug: "a", toSlug: "a2" },
        { fromSlug: "b", toSlug: "b2" },
      ],
    };
    const result = classifyChange(diff, [], false);
    const renames = result.changes.filter((c) => c.type === "rename_field");
    expect(renames).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Updating validation rules
// ---------------------------------------------------------------------------

describe("classifyChange — tighten validation (breaking when hasData)", () => {
  it("lowering maxLength is breaking when hasData=true", () => {
    const existing = [
      makeFieldRow({
        slug: "username",
        validation_rules: [{ type: "maxLength", value: 100 }],
      }),
    ];
    const diff: EntityDiff = {
      updateFields: [
        {
          slug: "username",
          validationRules: [{ type: "maxLength", value: 50 }],
        },
      ],
    };
    expect(classify(diff, existing, true)).toBe("breaking");
  });

  it("raising minLength is breaking when hasData=true", () => {
    const existing = [
      makeFieldRow({
        slug: "password",
        validation_rules: [{ type: "minLength", value: 6 }],
      }),
    ];
    const diff: EntityDiff = {
      updateFields: [
        {
          slug: "password",
          validationRules: [{ type: "minLength", value: 12 }],
        },
      ],
    };
    expect(classify(diff, existing, true)).toBe("breaking");
  });

  it("raising min value is breaking when hasData=true", () => {
    const existing = [
      makeFieldRow({
        slug: "qty",
        field_type: "number",
        validation_rules: [{ type: "min", value: 0 }],
      }),
    ];
    const diff: EntityDiff = {
      updateFields: [
        {
          slug: "qty",
          validationRules: [{ type: "min", value: 1 }],
        },
      ],
    };
    expect(classify(diff, existing, true)).toBe("breaking");
  });

  it("lowering max value is breaking when hasData=true", () => {
    const existing = [
      makeFieldRow({
        slug: "score",
        field_type: "number",
        validation_rules: [{ type: "max", value: 1000 }],
      }),
    ];
    const diff: EntityDiff = {
      updateFields: [
        {
          slug: "score",
          validationRules: [{ type: "max", value: 500 }],
        },
      ],
    };
    expect(classify(diff, existing, true)).toBe("breaking");
  });

  it("records tighten_validation change type when tightening with data", () => {
    const existing = [
      makeFieldRow({
        slug: "code",
        validation_rules: [{ type: "maxLength", value: 20 }],
      }),
    ];
    const diff: EntityDiff = {
      updateFields: [
        { slug: "code", validationRules: [{ type: "maxLength", value: 10 }] },
      ],
    };
    const result = classifyChange(diff, existing, true);
    expect(result.changes.find((c) => c.type === "tighten_validation")?.fieldSlug).toBe("code");
  });

  it("tightening validation WITHOUT data is still backward_compatible", () => {
    const existing = [
      makeFieldRow({
        slug: "name",
        validation_rules: [{ type: "maxLength", value: 100 }],
      }),
    ];
    const diff: EntityDiff = {
      updateFields: [{ slug: "name", validationRules: [{ type: "maxLength", value: 20 }] }],
    };
    expect(classify(diff, existing, false)).toBe("backward_compatible");
  });
});

describe("classifyChange — relax validation (always backward_compatible)", () => {
  it("raising maxLength is backward_compatible even with data", () => {
    const existing = [
      makeFieldRow({
        slug: "bio",
        validation_rules: [{ type: "maxLength", value: 200 }],
      }),
    ];
    const diff: EntityDiff = {
      updateFields: [{ slug: "bio", validationRules: [{ type: "maxLength", value: 500 }] }],
    };
    expect(classify(diff, existing, true)).toBe("backward_compatible");
  });

  it("lowering minLength is backward_compatible even with data", () => {
    const existing = [
      makeFieldRow({
        slug: "pin",
        validation_rules: [{ type: "minLength", value: 8 }],
      }),
    ];
    const diff: EntityDiff = {
      updateFields: [{ slug: "pin", validationRules: [{ type: "minLength", value: 4 }] }],
    };
    expect(classify(diff, existing, true)).toBe("backward_compatible");
  });

  it("raising max value is backward_compatible even with data", () => {
    const existing = [
      makeFieldRow({
        slug: "level",
        field_type: "number",
        validation_rules: [{ type: "max", value: 100 }],
      }),
    ];
    const diff: EntityDiff = {
      updateFields: [{ slug: "level", validationRules: [{ type: "max", value: 200 }] }],
    };
    expect(classify(diff, existing, true)).toBe("backward_compatible");
  });

  it("lowering min value is backward_compatible even with data", () => {
    const existing = [
      makeFieldRow({
        slug: "age",
        field_type: "number",
        validation_rules: [{ type: "min", value: 18 }],
      }),
    ];
    const diff: EntityDiff = {
      updateFields: [{ slug: "age", validationRules: [{ type: "min", value: 0 }] }],
    };
    expect(classify(diff, existing, true)).toBe("backward_compatible");
  });

  it("records relax_validation change type when relaxing", () => {
    const existing = [
      makeFieldRow({
        slug: "title",
        validation_rules: [{ type: "maxLength", value: 50 }],
      }),
    ];
    const diff: EntityDiff = {
      updateFields: [{ slug: "title", validationRules: [{ type: "maxLength", value: 255 }] }],
    };
    const result = classifyChange(diff, existing, true);
    expect(result.changes.find((c) => c.type === "relax_validation")?.fieldSlug).toBe("title");
  });
});

describe("classifyChange — field metadata updates (index, unique, name)", () => {
  it("updating field name is backward_compatible", () => {
    const existing = [makeFieldRow({ slug: "col" })];
    const diff: EntityDiff = {
      updateFields: [{ slug: "col", name: "New Display Name" }],
    };
    expect(classify(diff, existing, true)).toBe("backward_compatible");
  });

  it("changing isIndexed is backward_compatible", () => {
    const existing = [makeFieldRow({ slug: "col" })];
    const diff: EntityDiff = {
      updateFields: [{ slug: "col", isIndexed: true }],
    };
    expect(classify(diff, existing, true)).toBe("backward_compatible");
  });

  it("changing isUnique is backward_compatible", () => {
    const existing = [makeFieldRow({ slug: "col" })];
    const diff: EntityDiff = {
      updateFields: [{ slug: "col", isUnique: true }],
    };
    expect(classify(diff, existing, true)).toBe("backward_compatible");
  });

  it("records update_field_metadata change type for name/index/unique changes", () => {
    const existing = [makeFieldRow({ slug: "col" })];
    const diff: EntityDiff = {
      updateFields: [{ slug: "col", isIndexed: true }],
    };
    const result = classifyChange(diff, existing, true);
    expect(result.changes.find((c) => c.type === "update_field_metadata")?.fieldSlug).toBe("col");
  });

  it("skips updateField entries for unknown slugs silently", () => {
    const existing = [makeFieldRow({ slug: "col" })];
    const diff: EntityDiff = {
      updateFields: [{ slug: "no_such_field", isIndexed: true }],
    };
    const result = classifyChange(diff, existing, true);
    expect(result.changes).toHaveLength(0);
    expect(result.classification).toBe("backward_compatible");
  });
});

// ---------------------------------------------------------------------------
// Compound changes
// ---------------------------------------------------------------------------

describe("classifyChange — compound/mixed changes", () => {
  it("one breaking change in a set of many makes the whole diff breaking", () => {
    const existing = [makeFieldRow({ slug: "existing_col" })];
    const diff: EntityDiff = {
      nameChanged: true,
      addFields: [{ slug: "optional_new", fieldType: "string", required: false, nullable: false }],
      removeFieldSlugs: ["existing_col"], // this is breaking
    };
    expect(classify(diff, existing, false)).toBe("breaking");
  });

  it("collects all change entries for a compound diff", () => {
    const existing = [makeFieldRow({ slug: "to_remove" })];
    const diff: EntityDiff = {
      nameChanged: true,
      addFields: [{ slug: "new_opt", fieldType: "string", required: false, nullable: false }],
      removeFieldSlugs: ["to_remove"],
    };
    const result = classifyChange(diff, existing, false);
    const types = result.changes.map((c) => c.type);
    expect(types).toContain("update_metadata");
    expect(types).toContain("add_field");
    expect(types).toContain("remove_field");
  });

  it("multiple breaking changes all appear in the changes array", () => {
    const existing = [
      makeFieldRow({ slug: "col_a" }),
      makeFieldRow({ slug: "col_b" }),
    ];
    const diff: EntityDiff = {
      removeFieldSlugs: ["col_a", "col_b"],
      renameFields: [{ fromSlug: "col_a", toSlug: "col_alpha" }],
    };
    const result = classifyChange(diff, existing, false);
    expect(result.classification).toBe("breaking");
    expect(result.changes.length).toBeGreaterThanOrEqual(3);
  });

  it("rename + metadata-only is breaking", () => {
    const diff: EntityDiff = {
      descriptionChanged: true,
      renameFields: [{ fromSlug: "x", toSlug: "y" }],
    };
    expect(classify(diff)).toBe("breaking");
  });

  it("add required field with default + metadata change is backward_compatible", () => {
    const diff: EntityDiff = {
      nameChanged: true,
      addFields: [
        {
          slug: "tier",
          fieldType: "string",
          required: true,
          nullable: false,
          defaultValue: "free",
        },
      ],
    };
    expect(classify(diff, [], true)).toBe("backward_compatible");
  });
});

// ---------------------------------------------------------------------------
// isTypeWiden
// ---------------------------------------------------------------------------

describe("isTypeWiden", () => {
  it("number → string is a widen (number can be represented as string)", () => {
    expect(isTypeWiden("number", "string")).toBe(true);
  });

  it("boolean → string is a widen", () => {
    expect(isTypeWiden("boolean", "string")).toBe(true);
  });

  it("date → string is a widen", () => {
    expect(isTypeWiden("date", "string")).toBe(true);
  });

  it("enum → string is a widen", () => {
    expect(isTypeWiden("enum", "string")).toBe(true);
  });

  it("string → number is NOT a widen (narrowing)", () => {
    expect(isTypeWiden("string", "number")).toBe(false);
  });

  it("string → boolean is NOT a widen", () => {
    expect(isTypeWiden("string", "boolean")).toBe(false);
  });

  it("number → boolean is NOT a widen", () => {
    expect(isTypeWiden("number", "boolean")).toBe(false);
  });

  it("string → string (same type) is NOT a widen", () => {
    expect(isTypeWiden("string", "string")).toBe(false);
  });

  it("unknown type combination returns false without throwing", () => {
    expect(isTypeWiden("json", "array")).toBe(false);
    expect(isTypeWiden("reference", "string")).toBe(false);
  });

  it("empty string combinations return false without throwing", () => {
    expect(isTypeWiden("", "")).toBe(false);
  });
});
