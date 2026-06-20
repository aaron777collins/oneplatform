import { quotePgIdentifier } from "./pg-identifier.js";
import { fieldTypeToPostgres } from "./field-type-to-pg.js";
import type { FieldType } from "./field-type-to-pg.js";

export interface FieldDDLSpec {
  slug: string;
  fieldType: FieldType;
  required: boolean;
  nullable: boolean;
  defaultValue: unknown;
  isUnique: boolean;
  enumValues?: string[];
  refEntitySlug?: string;
}

export function buildCreateTableDDL(
  schemaName: string,
  entitySlug: string,
  fields: FieldDDLSpec[],
): string {
  const table = `${quotePgIdentifier(schemaName)}.${quotePgIdentifier(entitySlug)}`;

  const systemColumns = [
    `  "_id"           UUID        PRIMARY KEY DEFAULT gen_random_uuid()`,
    `  "_ingested_by"  UUID`,
    `  "_created_at"   TIMESTAMPTZ NOT NULL DEFAULT now()`,
    `  "_updated_at"   TIMESTAMPTZ NOT NULL DEFAULT now()`,
    `  "_version"      INTEGER     NOT NULL DEFAULT 1`,
    `  "_source_id"    TEXT`,
  ];

  const userColumns = fields.map((f) => buildColumnDef(f, schemaName));

  const allColumns = [...systemColumns, ...userColumns].join(",\n");

  return `CREATE TABLE ${table} (\n${allColumns}\n)`;
}

function buildColumnDef(field: FieldDDLSpec, schemaName: string): string {
  const col = quotePgIdentifier(field.slug);
  let pgType = fieldTypeToPostgres(field.fieldType);

  const parts = [`  ${col}`, pgType];

  if (field.fieldType === "reference" && field.refEntitySlug) {
    const refTable = `${quotePgIdentifier(schemaName)}.${quotePgIdentifier(field.refEntitySlug)}`;
    parts.push(`REFERENCES ${refTable}("_id")`);
  }

  if (!field.nullable) {
    parts.push("NOT NULL");
  }

  if (field.isUnique) {
    parts.push("UNIQUE");
  }

  if (field.defaultValue !== undefined && field.defaultValue !== null) {
    parts.push(`DEFAULT ${formatDefaultValue(field.defaultValue, field.fieldType)}`);
  }

  if (field.fieldType === "enum" && field.enumValues && field.enumValues.length > 0) {
    const vals = field.enumValues.map((v) => escapeSqlString(v)).join(", ");
    parts.push(`CHECK (${col} IN (${vals}))`);
  }

  return parts.join(" ");
}

function formatDefaultValue(value: unknown, fieldType: FieldType): string {
  if (fieldType === "json" || fieldType === "array") {
    return `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
  }
  if (fieldType === "boolean") {
    return value ? "true" : "false";
  }
  if (fieldType === "number") {
    const num = Number(value);
    if (!isFinite(num)) {
      throw new Error(`Invalid number default value: ${String(value)}`);
    }
    return String(num);
  }
  return escapeSqlString(String(value));
}

function escapeSqlString(val: string): string {
  return `'${val.replace(/'/g, "''")}'`;
}

export function buildRlsDDL(schemaName: string, entitySlug: string, tenantId: string): string {
  const table = `${quotePgIdentifier(schemaName)}.${quotePgIdentifier(entitySlug)}`;
  const policyName = quotePgIdentifier(`tenant_isolation_${entitySlug}`);
  // Strip hyphens and validate the result is a hex UUID to prevent SQL injection
  // via crafted tenant IDs containing single quotes.
  const tenantSafe = tenantId.replace(/-/g, "");
  if (!/^[a-f0-9]+$/.test(tenantSafe)) {
    throw new Error(`Invalid tenant ID for RLS policy: "${tenantId}"`);
  }

  return [
    `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`,
    `CREATE POLICY ${policyName} ON ${table} USING (current_setting('app.tenant_id') = '${tenantSafe}')`,
  ].join(";\n");
}

export function buildAddColumnDDL(
  schemaName: string,
  entitySlug: string,
  field: FieldDDLSpec,
): string {
  const table = `${quotePgIdentifier(schemaName)}.${quotePgIdentifier(entitySlug)}`;
  const col = quotePgIdentifier(field.slug);
  let pgType = fieldTypeToPostgres(field.fieldType);

  const parts = [`ALTER TABLE ${table} ADD COLUMN ${col} ${pgType}`];

  if (!field.nullable) {
    parts[0] += " NOT NULL";
  }

  if (field.defaultValue !== undefined && field.defaultValue !== null) {
    parts[0] += ` DEFAULT ${formatDefaultValue(field.defaultValue, field.fieldType)}`;
  }

  if (field.isUnique) {
    parts.push(`ALTER TABLE ${table} ADD CONSTRAINT ${quotePgIdentifier(`uq_${entitySlug}_${field.slug}`)} UNIQUE (${col})`);
  }

  if (field.fieldType === "enum" && field.enumValues && field.enumValues.length > 0) {
    const vals = field.enumValues.map((v) => escapeSqlString(v)).join(", ");
    parts.push(`ALTER TABLE ${table} ADD CONSTRAINT ${quotePgIdentifier(`chk_${entitySlug}_${field.slug}_enum`)} CHECK (${col} IN (${vals}))`);
  }

  return parts.join(";\n");
}

export function buildDropColumnDDL(
  schemaName: string,
  entitySlug: string,
  fieldSlug: string,
): string {
  const table = `${quotePgIdentifier(schemaName)}.${quotePgIdentifier(entitySlug)}`;
  return `ALTER TABLE ${table} DROP COLUMN IF EXISTS ${quotePgIdentifier(fieldSlug)}`;
}

export function buildCreateIndexDDL(
  schemaName: string,
  entitySlug: string,
  fieldSlug: string,
  options?: { concurrent?: boolean; gin?: boolean },
): string {
  const table = `${quotePgIdentifier(schemaName)}.${quotePgIdentifier(entitySlug)}`;
  const indexName = quotePgIdentifier(`idx_${entitySlug}_${fieldSlug}`);
  const col = quotePgIdentifier(fieldSlug);
  const concurrent = options?.concurrent ? " CONCURRENTLY" : "";

  if (options?.gin) {
    return `CREATE INDEX${concurrent} IF NOT EXISTS ${indexName} ON ${table} USING GIN (${col} jsonb_path_ops)`;
  }

  return `CREATE INDEX${concurrent} IF NOT EXISTS ${indexName} ON ${table} (${col})`;
}

export function buildJoinTableDDL(
  schemaName: string,
  fromSlug: string,
  toSlug: string,
  joinTableName: string,
  cascadeDelete: boolean,
): string {
  const table = `${quotePgIdentifier(schemaName)}.${quotePgIdentifier(joinTableName)}`;
  const fromTable = `${quotePgIdentifier(schemaName)}.${quotePgIdentifier(fromSlug)}`;
  const toTable = `${quotePgIdentifier(schemaName)}.${quotePgIdentifier(toSlug)}`;
  const fromCol = quotePgIdentifier(`${fromSlug}_id`);
  const toCol = quotePgIdentifier(`${toSlug}_id`);

  const deleteAction = cascadeDelete ? "ON DELETE CASCADE" : "ON DELETE RESTRICT";
  return `CREATE TABLE ${table} (
  ${fromCol} UUID NOT NULL REFERENCES ${fromTable}("_id") ${deleteAction},
  ${toCol}   UUID NOT NULL REFERENCES ${toTable}("_id")   ${deleteAction},
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (${fromCol}, ${toCol})
)`;
}

export function deriveJoinTableName(fromSlug: string, toSlug: string): string {
  const sorted = [fromSlug, toSlug].sort();
  return `${sorted[0]}_${sorted[1]}`;
}

export interface UnionViewFieldSpec {
  slug: string;
  isNew?: boolean;
  defaultExpression?: string;
  isRemoved?: boolean;
}

export function buildUnionViewDDL(
  schemaName: string,
  entitySlug: string,
  migrationId: string,
  fields: UnionViewFieldSpec[],
): string {
  const table = `${quotePgIdentifier(schemaName)}.${quotePgIdentifier(entitySlug)}`;
  const viewName = buildUnionViewName(entitySlug, migrationId);
  const qualifiedView = `${quotePgIdentifier(schemaName)}.${quotePgIdentifier(viewName)}`;

  // System columns start with "_" so they are not valid inputs for
  // quotePgIdentifier (which requires identifiers starting with [a-z]).
  // They are fixed, known-safe names so we quote them directly.
  const systemCols = ["_id", "_created_at", "_updated_at", "_version", "_source_id", "_ingested_by"];
  const systemSelect = systemCols.map((c) => `"${c}"`).join(", ");

  const activeFields = fields.filter((f) => !f.isRemoved);

  // Find new fields that have a non-null default — these are safe to use as
  // IS NOT NULL discriminants. Nullable fields with null defaults cannot be
  // used because NULL is a valid post-migration value.
  const discriminantField = fields.find(
    (f) => f.isNew && f.defaultExpression !== undefined && f.defaultExpression !== "NULL",
  );

  // When no reliable discriminant exists (all new fields are nullable-null-default),
  // use a single SELECT with COALESCE for each new field — pre-migration rows have
  // NULL which maps to the default, post-migration rows already have the correct value.
  if (!discriminantField) {
    const fieldList = activeFields.map((f) => {
      if (f.isNew && f.defaultExpression && f.defaultExpression !== "NULL") {
        return `COALESCE(${quotePgIdentifier(f.slug)}, ${f.defaultExpression}) AS ${quotePgIdentifier(f.slug)}`;
      }
      return quotePgIdentifier(f.slug);
    }).join(", ");

    return `CREATE VIEW ${qualifiedView} AS
  SELECT ${systemSelect}, ${fieldList}
  FROM ${table}`;
  }

  const migratedFieldList = activeFields.map((f) => quotePgIdentifier(f.slug)).join(", ");
  const unmigratedFieldList = activeFields.map((f) => {
    if (f.isNew) {
      return `${f.defaultExpression ?? "NULL"} AS ${quotePgIdentifier(f.slug)}`;
    }
    return quotePgIdentifier(f.slug);
  }).join(", ");

  const discriminator = `${quotePgIdentifier(discriminantField.slug)} IS NOT NULL`;
  const negDiscriminator = `${quotePgIdentifier(discriminantField.slug)} IS NULL`;

  return `CREATE VIEW ${qualifiedView} AS
  SELECT ${systemSelect}, ${migratedFieldList}
  FROM ${table}
  WHERE ${discriminator}
UNION ALL
  SELECT ${systemSelect}, ${unmigratedFieldList}
  FROM ${table}
  WHERE ${negDiscriminator}`;
}

export function buildUnionViewName(entitySlug: string, migrationId: string): string {
  const shortId = migrationId.replace(/-/g, "").slice(0, 12);
  return `v_${entitySlug}_migration_${shortId}`;
}

export function buildDropViewDDL(schemaName: string, viewName: string): string {
  return `DROP VIEW IF EXISTS ${quotePgIdentifier(schemaName)}.${quotePgIdentifier(viewName)}`;
}
