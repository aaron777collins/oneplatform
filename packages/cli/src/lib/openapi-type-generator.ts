/**
 * Minimal OpenAPI-to-TypeScript type generator.
 *
 * WHY NOT @hey-api/openapi-ts:
 * Adding a heavy code-generation dependency for a single CLI command creates a
 * significant install footprint and version coupling. This generator covers the
 * common case (object schemas with properties) without external dependencies.
 * For advanced needs (discriminated unions, allOf/oneOf, recursive refs) users
 * can point @hey-api/openapi-ts at the same spec URL.
 *
 * SCOPE: Reads the OpenAPI 3.x `components.schemas` section and emits a
 * TypeScript interface for each schema object. Inline primitive schemas become
 * type aliases. $ref cycles and complex combiners (allOf/anyOf/oneOf) are
 * emitted as `unknown` with a comment so the output is always syntactically
 * valid even when the generator cannot fully resolve the type.
 */

// ─── OpenAPI shape types (only the parts we read) ─────────────────────────────

interface OpenApiSchema {
  type?: string;
  description?: string;
  properties?: Record<string, OpenApiSchema>;
  items?: OpenApiSchema;
  required?: string[];
  enum?: unknown[];
  $ref?: string;
  allOf?: OpenApiSchema[];
  anyOf?: OpenApiSchema[];
  oneOf?: OpenApiSchema[];
  nullable?: boolean;
  format?: string;
}

interface OpenApiComponents {
  schemas?: Record<string, OpenApiSchema>;
}

export interface OpenApiSpec {
  openapi?: string;
  info?: { title?: string; version?: string };
  components?: OpenApiComponents;
  paths?: Record<string, unknown>;
}

// ─── Generator ────────────────────────────────────────────────────────────────

/**
 * Converts an OpenAPI $ref string to a local TypeScript type name.
 * "#/components/schemas/Foo" → "Foo"
 */
function refToName(ref: string): string {
  const parts = ref.split("/");
  return parts[parts.length - 1] ?? ref;
}

/**
 * Converts an OpenAPI schema to a TypeScript type expression.
 * Returns a string like "string", "number", "Foo[]", "{ id: string }", etc.
 */
function schemaToTypeExpr(
  schema: OpenApiSchema,
  indent: number,
  schemaNames: Set<string>,
): string {
  if (schema.$ref) {
    const name = refToName(schema.$ref);
    return schemaNames.has(name) ? name : "unknown /* unresolved $ref */";
  }

  // allOf / anyOf / oneOf: emit a comment rather than silently collapsing.
  if (schema.allOf ?? schema.anyOf ?? schema.oneOf) {
    return "unknown /* allOf/anyOf/oneOf — use @hey-api/openapi-ts for full resolution */";
  }

  if (schema.enum) {
    return schema.enum.map((v) => JSON.stringify(v)).join(" | ");
  }

  const pad = " ".repeat(indent * 2);
  const innerPad = " ".repeat((indent + 1) * 2);

  switch (schema.type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array": {
      if (!schema.items) return "unknown[]";
      const itemType = schemaToTypeExpr(schema.items, indent, schemaNames);
      return `Array<${itemType}>`;
    }
    case "object": {
      if (!schema.properties || Object.keys(schema.properties).length === 0) {
        return "Record<string, unknown>";
      }
      const required = new Set(schema.required ?? []);
      const propLines = Object.entries(schema.properties).map(([key, propSchema]) => {
        const optMark = required.has(key) ? "" : "?";
        const nullable = propSchema.nullable ? " | null" : "";
        const typeExpr = schemaToTypeExpr(propSchema, indent + 1, schemaNames);
        const docComment =
          propSchema.description
            ? `${innerPad}/** ${propSchema.description} */\n`
            : "";
        // Sanitize property keys that are not valid JS identifiers
        const safeKey = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key) ? key : `"${key}"`;
        return `${docComment}${innerPad}${safeKey}${optMark}: ${typeExpr}${nullable};`;
      });
      return `{\n${propLines.join("\n")}\n${pad}}`;
    }
    default:
      // Unknown or missing type — emit unknown rather than crashing.
      return "unknown";
  }
}

/**
 * Generates TypeScript type declarations from an OpenAPI spec.
 *
 * @param spec - Parsed OpenAPI JSON object.
 * @returns A string of TypeScript declarations ready to write to a .ts file.
 */
export function generateTypesFromOpenApi(spec: OpenApiSpec): string {
  const schemas = spec.components?.schemas ?? {};
  const schemaNames = new Set(Object.keys(schemas));

  const lines: string[] = [
    "// Auto-generated OnePlatform API types",
    `// Source: OpenAPI ${spec.openapi ?? "?"} — ${spec.info?.title ?? "OnePlatform"} ${spec.info?.version ?? ""}`,
    `// Generated: ${new Date().toISOString()}`,
    "// Generator: op sdk generate",
    "//",
    "// DO NOT EDIT — regenerate with: op sdk generate",
    "//",
    "// For more complete type generation (discriminated unions, $ref cycles,",
    "// server client methods) install @hey-api/openapi-ts and point it at the",
    "// spec returned by: op sdk generate --out spec.json (future flag)",
    "",
    "/* eslint-disable */",
    "// @ts-nocheck",
    "",
  ];

  if (schemaNames.size === 0) {
    lines.push("// No schemas found in components.schemas");
    lines.push("export type {}");
    return lines.join("\n") + "\n";
  }

  for (const [name, schema] of Object.entries(schemas)) {
    if (schema.description) {
      lines.push(`/** ${schema.description} */`);
    }

    if (schema.enum) {
      // Emit as a const union type rather than an interface
      const members = schema.enum.map((v) => JSON.stringify(v)).join(" | ");
      lines.push(`export type ${name} = ${members};`);
      lines.push("");
      continue;
    }

    if (!schema.type || schema.type === "object" || schema.properties) {
      const required = new Set(schema.required ?? []);
      const props = schema.properties ?? {};
      const propLines: string[] = [];

      for (const [key, propSchema] of Object.entries(props)) {
        const optMark = required.has(key) ? "" : "?";
        const nullable = propSchema.nullable ? " | null" : "";
        const typeExpr = schemaToTypeExpr(propSchema, 1, schemaNames);
        if (propSchema.description) {
          propLines.push(`  /** ${propSchema.description} */`);
        }
        const safeKey = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key) ? key : `"${key}"`;
        propLines.push(`  ${safeKey}${optMark}: ${typeExpr}${nullable};`);
      }

      if (propLines.length === 0) {
        lines.push(`export interface ${name} {`);
        lines.push("  [key: string]: unknown;");
      } else {
        lines.push(`export interface ${name} {`);
        propLines.forEach((l) => lines.push(l));
      }
      lines.push("}");
    } else {
      // Scalar or array type at the top level — emit as a type alias
      const typeExpr = schemaToTypeExpr(schema, 0, schemaNames);
      lines.push(`export type ${name} = ${typeExpr};`);
    }

    lines.push("");
  }

  return lines.join("\n") + "\n";
}
