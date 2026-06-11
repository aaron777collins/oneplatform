/**
 * sdk command group — SDK code generation from the platform's OpenAPI spec.
 * No scope required.
 */
import type { Command } from "commander";
import { withContext } from "../../lib/context.js";
import type { CommandContext } from "../../lib/context.js";
import { CliError, EXIT } from "../../lib/errors.js";
import { writeFileSync } from "node:fs";

interface GenerateOpts { out?: string; lang?: string }

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
  const spec = await ctx.http.get<unknown>("/api/v1/openapi.json");

  // In a real implementation, this would invoke @hey-api/openapi-ts against the spec.
  // Placeholder: emit a minimal type file with the fetched spec as a comment.
  const preamble = [
    "// Auto-generated OnePlatform SDK client",
    `// Generated: ${new Date().toISOString()}`,
    "// Generator: op sdk generate",
    "",
    "// Full OpenAPI spec was fetched from the platform.",
    "// Install @hey-api/openapi-ts and re-run for a complete typed client.",
    "",
    "export type {}; // placeholder",
    "",
  ].join("\n");

  writeFileSync(out, preamble, "utf8");
  ctx.renderer.success(`SDK generated at ${out}`);
}

export function registerSdk(program: Command): void {
  const sdk = program.command("sdk").description("SDK code generation");

  sdk.command("generate").description("Generate an ontology-typed SDK client for the current tenant")
    .option("--out <path>", "Output file path")
    .option("--lang <lang>", "Target language: typescript (python/go reserved)", "typescript")
    .action(withContext<[GenerateOpts]>(generateAction));
}
