import type { FieldRow, EntityRow, RelationshipRow } from "../repositories/types.js";
import { serializeZodSchema } from "./field-service.js";

export interface EntityRouteDefinition {
  entitySlug: string;
  entityName: string;
  schemaVersion: number;
  routes: {
    list:   { path: string; method: "GET";    requiredScope: string };
    get:    { path: string; method: "GET";    requiredScope: string };
    create: { path: string; method: "POST";   requiredScope: string };
    update: { path: string; method: "PATCH";  requiredScope: string };
    delete: { path: string; method: "DELETE"; requiredScope: string };
  };
  isPublic: boolean;
  inputSchema: string;
  outputSchema: string;
}

export function generateTypeScriptInterface(entity: EntityRow, fields: FieldRow[]): string {
  const name = toPascalCase(entity.slug);
  const lines: string[] = [];

  lines.push(`export interface ${name} {`);
  lines.push(`  _id: string;`);
  lines.push(`  _createdAt: string;`);
  lines.push(`  _updatedAt: string;`);
  lines.push(`  _version: number;`);
  lines.push(`  _sourceId: string | null;`);

  for (const field of fields) {
    const tsType = fieldTypeToTs(field);
    const optional = !field.required ? "?" : "";
    const nullable = field.nullable ? " | null" : "";
    lines.push(`  ${field.slug}${optional}: ${tsType}${nullable};`);
  }

  lines.push(`}`);
  lines.push(``);

  lines.push(`export interface Create${name}Input {`);
  for (const field of fields) {
    if (field.system_generated) continue;
    const tsType = fieldTypeToTs(field);
    const optional = !field.required ? "?" : "";
    const nullable = field.nullable ? " | null" : "";
    lines.push(`  ${field.slug}${optional}: ${tsType}${nullable};`);
  }
  lines.push(`}`);
  lines.push(``);

  lines.push(`export interface Update${name}Input extends Partial<Create${name}Input> {}`);

  return lines.join("\n");
}

export function generateZodSchema(entity: EntityRow, fields: FieldRow[]): string {
  return serializeZodSchema(fields, toPascalCase(entity.slug));
}

export function generateRouteDefinition(entity: EntityRow, fields: FieldRow[]): EntityRouteDefinition {
  const base = `/api/v1/data/${entity.slug}`;
  const scope = `${entity.slug}:read`;
  const writeScope = `${entity.slug}:write`;

  return {
    entitySlug: entity.slug,
    entityName: entity.name,
    schemaVersion: entity.version,
    routes: {
      list:   { path: base,         method: "GET",    requiredScope: scope },
      get:    { path: `${base}/:id`, method: "GET",    requiredScope: scope },
      create: { path: base,         method: "POST",   requiredScope: writeScope },
      update: { path: `${base}/:id`, method: "PATCH",  requiredScope: writeScope },
      delete: { path: `${base}/:id`, method: "DELETE", requiredScope: writeScope },
    },
    isPublic: entity.is_public,
    inputSchema: generateZodSchema(entity, fields),
    outputSchema: generateZodSchema(entity, fields),
  };
}

function fieldTypeToTs(field: FieldRow): string {
  switch (field.field_type) {
    case "string": return "string";
    case "number": return "number";
    case "boolean": return "boolean";
    case "date": return "string";
    case "json": return "Record<string, unknown>";
    case "reference": return "string";
    case "enum":
      if (field.enum_values && field.enum_values.length > 0) {
        return field.enum_values.map((v) => `"${v}"`).join(" | ");
      }
      return "string";
    case "array":
      return `${scalarTypeToTs(field.array_item_type ?? "string")}[]`;
    default:
      return "unknown";
  }
}

function scalarTypeToTs(itemType: string): string {
  switch (itemType) {
    case "string": return "string";
    case "number": return "number";
    case "boolean": return "boolean";
    case "date": return "string";
    case "json": return "Record<string, unknown>";
    default: return "unknown";
  }
}

function toPascalCase(slug: string): string {
  return slug
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
}
