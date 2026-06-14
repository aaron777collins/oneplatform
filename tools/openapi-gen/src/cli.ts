#!/usr/bin/env node
/**
 * OpenAPI generation CLI entry point.
 *
 * Two modes:
 *
 *   --service <name> --meta <path> --out <path>
 *     Generates a single service's OpenAPI 3.0.3 spec.
 *     The meta file is dynamically imported (ESM) and must export a `meta`
 *     named export of type ServiceOpenApiMeta.
 *
 *   --merge --services-root <path> --out <path>
 *     Merges all per-service specs into a single base spec.
 *     Reads from <services-root>/{service}/dist/openapi/*.json files.
 *
 * WHY dynamic import for the meta file:
 *   The meta file imports from the service's own schemas (Zod schemas).
 *   Using dynamic import lets tsx handle the TypeScript transpilation at
 *   runtime so no separate build step is needed for the tool itself.
 */

import { resolve, dirname } from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { buildSpec } from "./spec-builder.js";
import { mergeSpecs } from "./merger.js";
import type { ServiceOpenApiMeta } from "./types.js";

function parseArgs(argv: string[]): Record<string, string | true> {
  const result: Record<string, string | true> = {};
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === undefined) {
      i++;
      continue;
    }
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        result[key] = next;
        i += 2;
      } else {
        result[key] = true;
        i++;
      }
    } else {
      i++;
    }
  }
  return result;
}

function requireString(
  args: Record<string, string | true>,
  key: string,
  context: string,
): string {
  const val = args[key];
  if (typeof val !== "string" || val.trim() === "") {
    throw new Error(`[openapi-gen] Missing required argument --${key} (${context})`);
  }
  return val;
}

async function runServiceMode(args: Record<string, string | true>): Promise<void> {
  const serviceName = requireString(args, "service", "--service mode");
  const metaPath = requireString(args, "meta", "--service mode");
  const outPath = requireString(args, "out", "--service mode");

  // Resolve the meta path relative to the CWD (i.e. the package directory
  // where the docs:generate script runs).
  const resolvedMeta = resolve(process.cwd(), metaPath);

  let metaModule: { meta?: ServiceOpenApiMeta };
  try {
    metaModule = (await import(resolvedMeta)) as { meta?: ServiceOpenApiMeta };
  } catch (err) {
    throw new Error(
      `[openapi-gen] Failed to import meta file "${resolvedMeta}": ${String(err)}`,
    );
  }

  const meta = metaModule.meta;
  if (!meta || typeof meta !== "object") {
    throw new Error(
      `[openapi-gen] "${resolvedMeta}" must export a named "meta" of type ServiceOpenApiMeta.`,
    );
  }

  console.log(`[openapi-gen] Building spec for service "${serviceName}"...`);
  const spec = buildSpec(meta);

  const resolvedOut = resolve(process.cwd(), outPath);
  await mkdir(dirname(resolvedOut), { recursive: true });
  await writeFile(resolvedOut, JSON.stringify(spec, null, 2), "utf-8");
  console.log(`[openapi-gen] Wrote ${resolvedOut}`);
}

async function runMergeMode(args: Record<string, string | true>): Promise<void> {
  const servicesRoot = requireString(args, "services-root", "--merge mode");
  const outPath = requireString(args, "out", "--merge mode");

  await mergeSpecs({
    servicesRoot: resolve(process.cwd(), servicesRoot),
    outPath: resolve(process.cwd(), outPath),
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args["merge"] === true) {
    await runMergeMode(args);
  } else if (typeof args["service"] === "string") {
    await runServiceMode(args);
  } else {
    throw new Error(
      "[openapi-gen] Usage:\n" +
        "  openapi-gen --service <name> --meta <path> --out <path>\n" +
        "  openapi-gen --merge --services-root <path> --out <path>",
    );
  }
}

main().catch((err) => {
  console.error((err as Error).message ?? String(err));
  process.exit(1);
});
