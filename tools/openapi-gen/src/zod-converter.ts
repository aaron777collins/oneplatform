/**
 * Wraps zod-to-json-schema with OpenAPI 3.0.3-specific settings.
 *
 * WHY target: "openApi3": produces JSON Schema Draft 7 compatible output
 * which aligns with OpenAPI 3.0.x. Using "jsonSchema2019-09" would produce
 * OpenAPI 3.1 compatible output but tooling support is less mature.
 *
 * WHY $refStrategy: "none": prevents internal $ref generation, which would
 * require a separate schema registry pass. Inline schemas are simpler and
 * correct for our component collection approach in spec-builder.ts.
 */

import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodTypeAny } from "zod";

/**
 * Converts a Zod schema to an OpenAPI 3.0.3-compatible JSON Schema object.
 * Strips the $schema field that zod-to-json-schema adds by default, since
 * that field is not valid inside an OpenAPI components/schemas entry.
 */
export function zodToOpenApiSchema(schema: ZodTypeAny): Record<string, unknown> {
  const jsonSchema = zodToJsonSchema(schema, {
    target: "openApi3",
    $refStrategy: "none",
  }) as Record<string, unknown>;

  // Remove the $schema meta-property — not valid in OpenAPI components
  const { $schema, ...rest } = jsonSchema;
  void $schema;
  return rest;
}

/**
 * Extracts the schema name from the Zod schema's .describe() call.
 *
 * WHY .describe() for naming: it attaches the name directly to the schema
 * object so no external registry is needed, and it survives transformations
 * like .extend() and .pick() as long as describe() is re-applied.
 *
 * Throws at build time if .describe() was not called, enforcing the rule that
 * every schema used in openapi-meta.ts must have an explicit globally-unique name.
 */
export function requireDescribedName(schema: ZodTypeAny): string {
  // _def.description is where Zod stores the .describe() string
  const description = (schema._def as { description?: string }).description;
  if (!description) {
    throw new Error(
      "[openapi-gen] Schema has no .describe() name. " +
        "Add .describe(\"UniquePascalCaseName\") in openapi-meta.ts.",
    );
  }
  return description.replace(/\s+/g, "");
}

/**
 * Detects whether a schema uses z.lazy() internally.
 * z.lazy() produces {} (any) in zod-to-json-schema and must not be used
 * directly in openapi-meta.ts — use a bounded-depth variant instead.
 */
export function detectsLazy(schema: ZodTypeAny): boolean {
  return (schema._def as { typeName?: string }).typeName === "ZodLazy";
}
