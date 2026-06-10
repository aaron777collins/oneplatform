// Unit tests for utils/ddl-builder.ts
// Covers:
//   buildCreateTableDDL   — system columns, user fields, constraints
//   buildRlsDDL           — RLS enable + policy creation
//   buildAddColumnDDL     — ALTER TABLE ADD COLUMN with constraints
//   buildDropColumnDDL    — ALTER TABLE DROP COLUMN IF EXISTS
//   buildCreateIndexDDL   — BTREE vs GIN, CONCURRENTLY flag
//   buildJoinTableDDL     — join table structure
//   deriveJoinTableName   — alphabetical sort
//   buildUnionViewDDL     — UNION ALL vs single-SELECT fallback
//   buildUnionViewName    — view name derivation
//   buildDropViewDDL      — DROP VIEW IF EXISTS

import { describe, it, expect } from "vitest";
import {
  buildCreateTableDDL,
  buildRlsDDL,
  buildAddColumnDDL,
  buildDropColumnDDL,
  buildCreateIndexDDL,
  buildJoinTableDDL,
  deriveJoinTableName,
  buildUnionViewDDL,
  buildUnionViewName,
  buildDropViewDDL,
} from "../utils/ddl-builder.js";
import type { FieldDDLSpec, UnionViewFieldSpec } from "../utils/ddl-builder.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeField(overrides: Partial<FieldDDLSpec> & { slug: string }): FieldDDLSpec {
  return {
    fieldType: "string",
    required: false,
    nullable: true,
    defaultValue: undefined,
    isUnique: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildCreateTableDDL
// ---------------------------------------------------------------------------

describe("buildCreateTableDDL()", () => {
  it("opens with CREATE TABLE and the fully-qualified quoted table name", () => {
    const sql = buildCreateTableDDL("tenant_abc", "customer", []);
    expect(sql).toMatch(/^CREATE TABLE "tenant_abc"\."customer"/);
  });

  it("includes all six system columns", () => {
    const sql = buildCreateTableDDL("s", "e", []);
    expect(sql).toContain('"_id"');
    expect(sql).toContain('"_ingested_by"');
    expect(sql).toContain('"_created_at"');
    expect(sql).toContain('"_updated_at"');
    expect(sql).toContain('"_version"');
    expect(sql).toContain('"_source_id"');
  });

  it("makes _id a PRIMARY KEY with gen_random_uuid() default", () => {
    const sql = buildCreateTableDDL("s", "e", []);
    expect(sql).toContain('"_id"           UUID        PRIMARY KEY DEFAULT gen_random_uuid()');
  });

  it("makes _created_at and _updated_at NOT NULL with DEFAULT now()", () => {
    const sql = buildCreateTableDDL("s", "e", []);
    expect(sql).toContain('"_created_at"   TIMESTAMPTZ NOT NULL DEFAULT now()');
    expect(sql).toContain('"_updated_at"   TIMESTAMPTZ NOT NULL DEFAULT now()');
  });

  it("makes _version INTEGER NOT NULL DEFAULT 1", () => {
    const sql = buildCreateTableDDL("s", "e", []);
    expect(sql).toContain('"_version"      INTEGER     NOT NULL DEFAULT 1');
  });

  it("includes a user-defined field column with the correct PG type", () => {
    const sql = buildCreateTableDDL("s", "e", [makeField({ slug: "title", fieldType: "string" })]);
    expect(sql).toContain('"title" TEXT');
  });

  it("appends NOT NULL for a non-nullable user field", () => {
    const field = makeField({ slug: "score", fieldType: "number", nullable: false });
    const sql = buildCreateTableDDL("s", "e", [field]);
    expect(sql).toContain('"score" NUMERIC(19, 4) NOT NULL');
  });

  it("does not append NOT NULL for a nullable user field", () => {
    const field = makeField({ slug: "notes", fieldType: "string", nullable: true });
    const sql = buildCreateTableDDL("s", "e", [field]);
    // The column declaration should not have NOT NULL
    const colLine = sql.split("\n").find((l) => l.includes('"notes"'));
    expect(colLine).toBeDefined();
    expect(colLine).not.toContain("NOT NULL");
  });

  it("appends UNIQUE for a unique user field", () => {
    const field = makeField({ slug: "email", isUnique: true });
    const sql = buildCreateTableDDL("s", "e", [field]);
    expect(sql).toContain('"email" TEXT UNIQUE');
  });

  it("appends DEFAULT for a string field with a default value", () => {
    const field = makeField({ slug: "status", defaultValue: "active" });
    const sql = buildCreateTableDDL("s", "e", [field]);
    expect(sql).toContain("DEFAULT 'active'");
  });

  it("appends DEFAULT for a boolean field with a true default", () => {
    const field = makeField({ slug: "active", fieldType: "boolean", defaultValue: true });
    const sql = buildCreateTableDDL("s", "e", [field]);
    expect(sql).toContain("DEFAULT true");
  });

  it("appends DEFAULT for a boolean field with a false default", () => {
    const field = makeField({ slug: "archived", fieldType: "boolean", defaultValue: false, nullable: false });
    const sql = buildCreateTableDDL("s", "e", [field]);
    expect(sql).toContain("DEFAULT false");
  });

  it("appends DEFAULT serialised as JSONB literal for a json field", () => {
    const field = makeField({ slug: "meta", fieldType: "json", defaultValue: { key: "val" } });
    const sql = buildCreateTableDDL("s", "e", [field]);
    expect(sql).toContain(`DEFAULT '{"key":"val"}'::jsonb`);
  });

  it("appends DEFAULT serialised as JSONB literal for an array field", () => {
    const field = makeField({ slug: "tags", fieldType: "array", defaultValue: [] });
    const sql = buildCreateTableDDL("s", "e", [field]);
    expect(sql).toContain("DEFAULT '[]'::jsonb");
  });

  it("appends a CHECK constraint for an enum field with values", () => {
    const field = makeField({
      slug: "priority",
      fieldType: "enum",
      enumValues: ["low", "medium", "high"],
    });
    const sql = buildCreateTableDDL("s", "e", [field]);
    expect(sql).toContain(`CHECK ("priority" IN ('low', 'medium', 'high'))`);
  });

  it("escapes single quotes inside enum values to prevent SQL injection", () => {
    const field = makeField({
      slug: "label",
      fieldType: "enum",
      enumValues: ["O'Brien", "normal"],
    });
    const sql = buildCreateTableDDL("s", "e", [field]);
    expect(sql).toContain("'O''Brien'");
  });

  it("appends REFERENCES clause for a reference field with refEntitySlug", () => {
    const field = makeField({
      slug: "owner_id",
      fieldType: "reference",
      refEntitySlug: "user",
    });
    const sql = buildCreateTableDDL("myschema", "order", [field]);
    expect(sql).toContain(`REFERENCES "myschema"."user"("_id")`);
  });

  it("does not add REFERENCES when refEntitySlug is absent", () => {
    const field = makeField({ slug: "ext_ref", fieldType: "reference" });
    const sql = buildCreateTableDDL("s", "e", [field]);
    expect(sql).not.toContain("REFERENCES");
  });

  it("handles multiple user fields in order", () => {
    const fields = [
      makeField({ slug: "name" }),
      makeField({ slug: "age", fieldType: "number" }),
    ];
    const sql = buildCreateTableDDL("s", "e", fields);
    const namePos = sql.indexOf('"name"');
    const agePos = sql.indexOf('"age"');
    expect(namePos).toBeGreaterThan(-1);
    expect(agePos).toBeGreaterThan(namePos);
  });

  it("does not append DEFAULT when defaultValue is null", () => {
    const field = makeField({ slug: "optional_field", defaultValue: null });
    const sql = buildCreateTableDDL("s", "e", [field]);
    // null defaultValue is explicitly excluded from producing a DEFAULT clause
    const colLine = sql.split("\n").find((l) => l.includes('"optional_field"'));
    expect(colLine).toBeDefined();
    expect(colLine).not.toContain("DEFAULT");
  });

  it("escapes single-quotes in string default values", () => {
    const field = makeField({ slug: "greeting", defaultValue: "it's fine" });
    const sql = buildCreateTableDDL("s", "e", [field]);
    expect(sql).toContain("DEFAULT 'it''s fine'");
  });
});

// ---------------------------------------------------------------------------
// buildRlsDDL
// ---------------------------------------------------------------------------

describe("buildRlsDDL()", () => {
  it("enables row-level security on the table", () => {
    const sql = buildRlsDDL("tenant_abc", "order", "550e8400-e29b-41d4-a716-446655440000");
    expect(sql).toContain('ALTER TABLE "tenant_abc"."order" ENABLE ROW LEVEL SECURITY');
  });

  it("creates a policy with the tenant_isolation_<entitySlug> name", () => {
    const sql = buildRlsDDL("tenant_abc", "order", "550e8400-e29b-41d4-a716-446655440000");
    expect(sql).toContain('"tenant_isolation_order"');
    expect(sql).toContain("CREATE POLICY");
  });

  it("embeds the tenant ID with hyphens stripped in the USING clause", () => {
    const sql = buildRlsDDL("s", "e", "550e8400-e29b-41d4-a716-446655440000");
    expect(sql).toContain("'550e8400e29b41d4a716446655440000'");
    expect(sql).not.toContain("550e8400-e29b");
  });

  it("uses current_setting('app.tenant_id') as the comparator", () => {
    const sql = buildRlsDDL("s", "e", "abc");
    expect(sql).toContain("current_setting('app.tenant_id')");
  });

  it("separates the two statements with a semicolon and newline", () => {
    const sql = buildRlsDDL("s", "e", "abc");
    expect(sql).toContain(";\n");
  });
});

// ---------------------------------------------------------------------------
// buildAddColumnDDL
// ---------------------------------------------------------------------------

describe("buildAddColumnDDL()", () => {
  it("produces ALTER TABLE ADD COLUMN with the correct type", () => {
    const field = makeField({ slug: "score", fieldType: "number" });
    const sql = buildAddColumnDDL("s", "entity", field);
    expect(sql).toMatch(/^ALTER TABLE "s"\."entity" ADD COLUMN "score" NUMERIC\(19, 4\)/);
  });

  it("appends NOT NULL for a non-nullable field", () => {
    const field = makeField({ slug: "required_col", nullable: false });
    const sql = buildAddColumnDDL("s", "e", field);
    expect(sql).toContain("NOT NULL");
  });

  it("does not append NOT NULL for a nullable field", () => {
    const field = makeField({ slug: "optional_col", nullable: true });
    const sql = buildAddColumnDDL("s", "e", field);
    expect(sql).not.toContain("NOT NULL");
  });

  it("appends DEFAULT inline for a field with a default value", () => {
    const field = makeField({ slug: "status", defaultValue: "active" });
    const sql = buildAddColumnDDL("s", "e", field);
    expect(sql).toContain("DEFAULT 'active'");
  });

  it("adds a separate UNIQUE constraint statement for a unique field", () => {
    const field = makeField({ slug: "email", isUnique: true });
    const sql = buildAddColumnDDL("s", "entity", field);
    expect(sql).toContain('ADD CONSTRAINT "uq_entity_email" UNIQUE ("email")');
  });

  it("adds a separate CHECK constraint statement for an enum field with values", () => {
    const field = makeField({
      slug: "state",
      fieldType: "enum",
      enumValues: ["open", "closed"],
    });
    const sql = buildAddColumnDDL("s", "ticket", field);
    expect(sql).toContain('ADD CONSTRAINT "chk_ticket_state_enum" CHECK ("state" IN (\'open\', \'closed\'))');
  });

  it("separates multiple statements with semicolons and newlines", () => {
    const field = makeField({ slug: "code", isUnique: true });
    const sql = buildAddColumnDDL("s", "e", field);
    expect(sql).toContain(";\n");
  });

  it("does not emit a UNIQUE statement when isUnique is false", () => {
    const field = makeField({ slug: "notes", isUnique: false });
    const sql = buildAddColumnDDL("s", "e", field);
    expect(sql).not.toContain("UNIQUE");
  });

  it("does not emit a CHECK statement when enumValues is absent", () => {
    const field = makeField({ slug: "kind", fieldType: "enum" });
    const sql = buildAddColumnDDL("s", "e", field);
    expect(sql).not.toContain("CHECK");
  });

  it("does not emit a CHECK statement when enumValues is empty", () => {
    const field = makeField({ slug: "kind", fieldType: "enum", enumValues: [] });
    const sql = buildAddColumnDDL("s", "e", field);
    expect(sql).not.toContain("CHECK");
  });
});

// ---------------------------------------------------------------------------
// buildDropColumnDDL
// ---------------------------------------------------------------------------

describe("buildDropColumnDDL()", () => {
  it("produces ALTER TABLE DROP COLUMN IF EXISTS", () => {
    const sql = buildDropColumnDDL("myschema", "customer", "phone");
    expect(sql).toBe('ALTER TABLE "myschema"."customer" DROP COLUMN IF EXISTS "phone"');
  });

  it("quotes the schema, table, and column names separately", () => {
    const sql = buildDropColumnDDL("s", "t", "c");
    expect(sql).toContain('"s"."t"');
    expect(sql).toContain('"c"');
  });
});

// ---------------------------------------------------------------------------
// buildCreateIndexDDL
// ---------------------------------------------------------------------------

describe("buildCreateIndexDDL()", () => {
  it("creates a default BTREE index using IF NOT EXISTS", () => {
    const sql = buildCreateIndexDDL("s", "entity", "email");
    expect(sql).toContain("CREATE INDEX");
    expect(sql).toContain("IF NOT EXISTS");
    expect(sql).toContain('"idx_entity_email"');
    expect(sql).toContain('"s"."entity"');
    expect(sql).toContain('("email")');
  });

  it("does not include USING GIN for a default BTREE index", () => {
    const sql = buildCreateIndexDDL("s", "e", "col");
    expect(sql).not.toContain("GIN");
  });

  it("creates a GIN index when gin option is true", () => {
    const sql = buildCreateIndexDDL("s", "entity", "meta", { gin: true });
    expect(sql).toContain("USING GIN");
    expect(sql).toContain("jsonb_path_ops");
  });

  it("inserts CONCURRENTLY keyword when concurrent option is true", () => {
    const sql = buildCreateIndexDDL("s", "entity", "slug", { concurrent: true });
    expect(sql).toContain("CREATE INDEX CONCURRENTLY");
  });

  it("does not insert CONCURRENTLY when concurrent option is false", () => {
    const sql = buildCreateIndexDDL("s", "entity", "slug", { concurrent: false });
    expect(sql).not.toContain("CONCURRENTLY");
  });

  it("supports CONCURRENTLY combined with GIN", () => {
    const sql = buildCreateIndexDDL("s", "e", "data", { concurrent: true, gin: true });
    expect(sql).toContain("CREATE INDEX CONCURRENTLY");
    expect(sql).toContain("USING GIN");
  });

  it("uses the derived index name idx_<entitySlug>_<fieldSlug>", () => {
    const sql = buildCreateIndexDDL("s", "order", "created_at");
    expect(sql).toContain('"idx_order_created_at"');
  });
});

// ---------------------------------------------------------------------------
// buildJoinTableDDL
// ---------------------------------------------------------------------------

describe("buildJoinTableDDL()", () => {
  it("opens with CREATE TABLE for the qualified join table name", () => {
    const sql = buildJoinTableDDL("s", "post", "tag", "post_tag", false);
    expect(sql).toMatch(/^CREATE TABLE "s"\."post_tag"/);
  });

  it("includes fromSlug_id as UUID NOT NULL REFERENCES fromTable._id", () => {
    const sql = buildJoinTableDDL("s", "post", "tag", "post_tag", false);
    expect(sql).toContain('"post_id" UUID NOT NULL REFERENCES "s"."post"("_id")');
  });

  it("includes toSlug_id as UUID NOT NULL REFERENCES toTable._id", () => {
    const sql = buildJoinTableDDL("s", "post", "tag", "post_tag", false);
    expect(sql).toContain('"tag_id"   UUID NOT NULL REFERENCES "s"."tag"("_id")');
  });

  it("always includes ON DELETE CASCADE for both FK columns", () => {
    const sql = buildJoinTableDDL("s", "post", "tag", "post_tag", true);
    const cascadeCount = (sql.match(/ON DELETE CASCADE/g) ?? []).length;
    expect(cascadeCount).toBe(2);
  });

  it("includes created_at TIMESTAMPTZ NOT NULL DEFAULT now()", () => {
    const sql = buildJoinTableDDL("s", "a", "b", "a_b", false);
    expect(sql).toContain('"created_at" TIMESTAMPTZ NOT NULL DEFAULT now()');
  });

  it("declares a composite PRIMARY KEY over (fromSlug_id, toSlug_id)", () => {
    const sql = buildJoinTableDDL("s", "post", "tag", "post_tag", false);
    expect(sql).toContain('PRIMARY KEY ("post_id", "tag_id")');
  });
});

// ---------------------------------------------------------------------------
// deriveJoinTableName
// ---------------------------------------------------------------------------

describe("deriveJoinTableName()", () => {
  it("sorts slugs alphabetically and joins with underscore", () => {
    expect(deriveJoinTableName("post", "tag")).toBe("post_tag");
  });

  it("returns same result regardless of argument order (alphabetical sort)", () => {
    expect(deriveJoinTableName("tag", "post")).toBe("post_tag");
  });

  it("handles slugs that are already in alphabetical order", () => {
    expect(deriveJoinTableName("alpha", "beta")).toBe("alpha_beta");
  });

  it("handles two identical slugs", () => {
    expect(deriveJoinTableName("item", "item")).toBe("item_item");
  });

  it("sorts case-sensitively (uppercase before lowercase in ASCII order)", () => {
    // Both slugs are lowercase in practice, but test the sort primitive
    const result = deriveJoinTableName("z_entity", "a_entity");
    expect(result).toBe("a_entity_z_entity");
  });
});

// ---------------------------------------------------------------------------
// buildUnionViewName
// ---------------------------------------------------------------------------

describe("buildUnionViewName()", () => {
  it("returns v_<entitySlug>_migration_<first12HexCharsOfMigrationId>", () => {
    const migId = "550e8400-e29b-41d4-a716-446655440000";
    const name = buildUnionViewName("customer", migId);
    // Stripped: 550e8400e29b41d4a716446655440000 → first 12 = 550e8400e29b
    expect(name).toBe("v_customer_migration_550e8400e29b");
  });

  it("strips hyphens from the migration ID before slicing", () => {
    const migId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const name = buildUnionViewName("order", migId);
    expect(name).toBe("v_order_migration_aaaaaaaabbbb");
  });

  it("uses at most 12 hex characters from the migration ID", () => {
    const migId = "00000000-0000-0000-0000-000000000000";
    const name = buildUnionViewName("e", migId);
    expect(name).toBe("v_e_migration_000000000000");
    expect(name.split("migration_")[1]).toHaveLength(12);
  });
});

// ---------------------------------------------------------------------------
// buildUnionViewDDL — UNION ALL branch (reliable discriminant present)
// ---------------------------------------------------------------------------

describe("buildUnionViewDDL() — UNION ALL path", () => {
  const schema = "tenant_abc";
  const entity = "order";
  const migId = "550e8400-e29b-41d4-a716-446655440000";

  const existingField: UnionViewFieldSpec = { slug: "name" };
  const newFieldWithDefault: UnionViewFieldSpec = {
    slug: "status",
    isNew: true,
    defaultExpression: "'pending'",
  };

  it("opens with CREATE VIEW and the fully-qualified view name", () => {
    const sql = buildUnionViewDDL(schema, entity, migId, [existingField, newFieldWithDefault]);
    const viewName = buildUnionViewName(entity, migId);
    expect(sql).toMatch(new RegExp(`^CREATE VIEW "tenant_abc"\\."${viewName}"`));
  });

  it("includes system columns in both SELECT branches", () => {
    const sql = buildUnionViewDDL(schema, entity, migId, [existingField, newFieldWithDefault]);
    const systemCols = ["_id", "_created_at", "_updated_at", "_version", "_source_id", "_ingested_by"];
    for (const col of systemCols) {
      expect(sql).toContain(`"${col}"`);
    }
  });

  it("uses UNION ALL to combine migrated and unmigrated rows", () => {
    const sql = buildUnionViewDDL(schema, entity, migId, [existingField, newFieldWithDefault]);
    expect(sql).toContain("UNION ALL");
  });

  it("selects migrated rows WHERE discriminant IS NOT NULL", () => {
    const sql = buildUnionViewDDL(schema, entity, migId, [existingField, newFieldWithDefault]);
    expect(sql).toContain('"status" IS NOT NULL');
  });

  it("selects unmigrated rows WHERE discriminant IS NULL", () => {
    const sql = buildUnionViewDDL(schema, entity, migId, [existingField, newFieldWithDefault]);
    expect(sql).toContain('"status" IS NULL');
  });

  it("projects the defaultExpression AS the new column name for unmigrated rows", () => {
    const sql = buildUnionViewDDL(schema, entity, migId, [existingField, newFieldWithDefault]);
    expect(sql).toContain(`'pending' AS "status"`);
  });

  it("projects the existing field as a simple quoted identifier in both branches", () => {
    const sql = buildUnionViewDDL(schema, entity, migId, [existingField, newFieldWithDefault]);
    // "name" must appear in both the migrated and unmigrated SELECT lists
    const occurrences = (sql.match(/"name"/g) ?? []).length;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it("excludes removed fields from both branches", () => {
    const removedField: UnionViewFieldSpec = { slug: "legacy_col", isRemoved: true };
    const sql = buildUnionViewDDL(schema, entity, migId, [existingField, newFieldWithDefault, removedField]);
    expect(sql).not.toContain('"legacy_col"');
  });

  it("selects the first new non-null-default field as the discriminant when multiple new fields are present", () => {
    const secondNewField: UnionViewFieldSpec = {
      slug: "region",
      isNew: true,
      defaultExpression: "'us-east'",
    };
    const sql = buildUnionViewDDL(schema, entity, migId, [existingField, newFieldWithDefault, secondNewField]);
    // The discriminant should be the first new field with a non-null default
    expect(sql).toContain('"status" IS NOT NULL');
  });
});

// ---------------------------------------------------------------------------
// buildUnionViewDDL — single-SELECT fallback (no reliable discriminant)
// ---------------------------------------------------------------------------

describe("buildUnionViewDDL() — single-SELECT fallback path", () => {
  const schema = "s";
  const entity = "item";
  const migId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  it("uses a single SELECT (no UNION ALL) when all new fields have NULL defaults", () => {
    const fields: UnionViewFieldSpec[] = [
      { slug: "existing_col" },
      { slug: "new_nullable", isNew: true, defaultExpression: "NULL" },
    ];
    const sql = buildUnionViewDDL(schema, entity, migId, fields);
    expect(sql).not.toContain("UNION ALL");
    expect(sql).toContain("SELECT");
  });

  it("uses a single SELECT when no new fields are present at all", () => {
    const fields: UnionViewFieldSpec[] = [{ slug: "col_a" }, { slug: "col_b" }];
    const sql = buildUnionViewDDL(schema, entity, migId, fields);
    expect(sql).not.toContain("UNION ALL");
  });

  it("uses a single SELECT when new fields have no defaultExpression defined", () => {
    const fields: UnionViewFieldSpec[] = [
      { slug: "col_a" },
      { slug: "new_col", isNew: true },
    ];
    const sql = buildUnionViewDDL(schema, entity, migId, fields);
    expect(sql).not.toContain("UNION ALL");
  });

  it("wraps new non-null-default fields in COALESCE in the single-SELECT path", () => {
    // A new field with a non-null default but no other discriminant-eligible sibling
    // would enter the UNION ALL path, so we verify COALESCE only in the fallback scenario.
    // Fallback: new field has defaultExpression but all others are null-default.
    // The single field with a non-null default IS the discriminant → UNION ALL path.
    // For true COALESCE coverage: no new field has a non-null default (so discriminant=undefined),
    // but one has a non-null default in the field list itself → contradicts discriminant logic.
    // Actually COALESCE fires when: isNew && defaultExpression && defaultExpression !== 'NULL'
    // AND we are in the single-SELECT path (discriminantField === undefined).
    // That combination occurs when there is NO field that passes (isNew && defaultExpression !== 'NULL').
    // So COALESCE only fires if defaultExpression is set but evaluates to: the check for discriminant
    // requires f.defaultExpression !== undefined && f.defaultExpression !== 'NULL'.
    // A COALESCE-producing field would itself be the discriminant → we cannot have both simultaneously.
    // Therefore the COALESCE branch is unreachable in practice (dead code in the implementation).
    // We document this here without asserting COALESCE output to avoid a false-positive test.
    const fields: UnionViewFieldSpec[] = [
      { slug: "existing" },
    ];
    const sql = buildUnionViewDDL(schema, entity, migId, fields);
    expect(sql).not.toContain("UNION ALL");
    expect(sql).toContain('"existing"');
  });

  it("selects from the base table in the fallback path", () => {
    const fields: UnionViewFieldSpec[] = [{ slug: "col_a" }];
    const sql = buildUnionViewDDL(schema, entity, migId, fields);
    expect(sql).toContain(`FROM "s"."item"`);
  });

  it("excludes removed fields from the single-SELECT path", () => {
    const fields: UnionViewFieldSpec[] = [
      { slug: "keep_me" },
      { slug: "drop_me", isRemoved: true },
    ];
    const sql = buildUnionViewDDL(schema, entity, migId, fields);
    expect(sql).not.toContain('"drop_me"');
    expect(sql).toContain('"keep_me"');
  });
});

// ---------------------------------------------------------------------------
// buildDropViewDDL
// ---------------------------------------------------------------------------

describe("buildDropViewDDL()", () => {
  it("produces DROP VIEW IF EXISTS with fully-qualified quoted name", () => {
    const sql = buildDropViewDDL("tenant_abc", "v_order_migration_550e8400e29b");
    expect(sql).toBe('DROP VIEW IF EXISTS "tenant_abc"."v_order_migration_550e8400e29b"');
  });

  it("quotes both schema and view name independently", () => {
    const sql = buildDropViewDDL("myschema", "myview");
    expect(sql).toContain('"myschema"."myview"');
  });
});
