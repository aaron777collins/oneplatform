/**
 * sdk command group — SDK code generation from the platform's OpenAPI spec.
 * No scope required.
 */
import type { Command } from "commander";
import { withContext } from "../../lib/context.js";
import type { CommandContext } from "../../lib/context.js";
import { CliError, EXIT } from "../../lib/errors.js";
import { writeFileSync } from "node:fs";
import { generateEntityTypes } from "../../lib/generate-entity-types.js";
import type { OntologyEntitySchema } from "../../lib/generate-entity-types.js";
import { generateTypesFromOpenApi } from "../../lib/openapi-type-generator.js";
import type { OpenApiSpec } from "../../lib/openapi-type-generator.js";

interface GenerateOpts { out?: string; lang?: string }
interface GenerateTypesOpts { out?: string }

async function generateTypesAction(opts: GenerateTypesOpts, ctx: CommandContext): Promise<void> {
  ctx.renderer.info("Fetching entity schemas from platform...");

  // The transport unwraps { data: T } envelopes automatically.
  // The list endpoint may return { items, nextCursor, total } (paginated) or
  // a flat array depending on the ontology service version. Handle both shapes
  // so the CLI works regardless.
  const result = await ctx.http.get<
    | { items: OntologyEntitySchema[]; nextCursor?: string | null; total?: number | null }
    | OntologyEntitySchema[]
  >("/api/v1/ontology", { limit: 200 });

  const entities: OntologyEntitySchema[] = Array.isArray(result) ? result : (result.items ?? []);

  if (entities.length === 0) {
    ctx.renderer.info("No entity schemas found. Create entities with `op ontology create` first.");
  }

  const content = generateEntityTypes(entities);
  const outPath = opts.out ?? "op-types.d.ts";
  writeFileSync(outPath, content, "utf8");
  ctx.renderer.success(`Type declarations written to ${outPath} (${entities.length} entities)`);
  ctx.renderer.info("Add the file to your tsconfig.json \"include\" array for type-safe useQuery<T>() calls.");
}

async function generateAction(opts: GenerateOpts, ctx: CommandContext): Promise<void> {
  const lang = opts.lang ?? "typescript";
  const out = opts.out ?? (lang === "typescript" ? "./oneplatform.gen.ts" : `./oneplatform.gen.${lang}`);

  if (lang !== "typescript") {
    throw new CliError(
      `Language '${lang}' is reserved for future versions. Only 'typescript' is supported currently.`,
      EXIT.GENERAL,
    );
  }

  ctx.renderer.info("Fetching OpenAPI spec from platform...");
  const spec = await ctx.http.get<OpenApiSpec>("/api/v1/openapi.json");

  // Generate TypeScript interfaces directly from the OpenAPI components.schemas
  // section without requiring @hey-api/openapi-ts. The generator handles object
  // schemas with properties, primitive type aliases, enum unions, and array types.
  // Complex combiners (allOf/anyOf/oneOf) and $ref cycles are emitted as `unknown`
  // with a comment pointing to @hey-api/openapi-ts for full resolution.
  const content = generateTypesFromOpenApi(spec);
  const schemaCount = Object.keys(spec.components?.schemas ?? {}).length;

  writeFileSync(out, content, "utf8");
  ctx.renderer.success(
    `TypeScript types generated at ${out} (${schemaCount} schema${schemaCount === 1 ? "" : "s"})`,
  );
  if (schemaCount === 0) {
    ctx.renderer.info(
      "No schemas found in components.schemas. The platform may not expose a typed spec at this endpoint.",
    );
  }
}

export function registerSdk(program: Command): void {
  const sdk = program.command("sdk").description("SDK code generation");

  sdk.command("generate").description("Generate an ontology-typed SDK client for the current tenant")
    .option("--out <path>", "Output file path")
    .option("--lang <lang>", "Target language: typescript (python/go reserved)", "typescript")
    .action(withContext<[GenerateOpts]>(generateAction));

  sdk.command("generate-types")
    .description(
      "Generate TypeScript type declarations from ontology entity schemas.\n" +
      "Writes op-types.d.ts that augments @oneplatform/app-sdk with\n" +
      "EntityTypeMap entries for type-safe useQuery<EntityTypeMap[\"customer\"]>() calls.",
    )
    .option("--out <path>", "Output file path (default: op-types.d.ts)")
    .action(withContext<[GenerateTypesOpts]>(generateTypesAction));
}
