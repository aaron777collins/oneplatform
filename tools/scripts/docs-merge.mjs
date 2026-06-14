#!/usr/bin/env node
/**
 * Root-level merge script for documentation artifacts.
 *
 * This is a plain Node.js script (not a Turbo task) that runs AFTER
 * `pnpm turbo docs:generate` completes. It fans-in per-package outputs
 * from dist/ directories into docs/generated/ for the Starlight site and
 * the gateway's static spec serving.
 *
 * WHY this is not a Turbo task:
 *   Turbo prohibits output paths that traverse outside a package boundary
 *   (../../). This script writes to docs/generated/ (the monorepo root),
 *   which is not within any single package boundary. Running it as a root
 *   shell script after Turbo is the clean solution. See design doc §7.
 *
 * Steps performed:
 *   1. Run the OpenAPI merger — reads services/{name}/dist/openapi/*.json,
 *      writes docs/generated/openapi/merged.json and copies per-service files.
 *   2. Copy TypeDoc markdown output for the 4 SDK packages.
 *   3. Copy CLI docs from packages/cli/dist/docs/ to docs/generated/cli/.
 */

import { execSync } from "node:child_process";
import { cp, mkdir } from "node:fs/promises";
import { readdir, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");

function run(cmd, description) {
  console.log(`\n[docs-merge] ${description}`);
  console.log(`  $ ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd: repoRoot });
}

async function copyPerServiceSpecs() {
  const servicesDir = join(repoRoot, "services");
  const outDir = join(repoRoot, "docs", "generated", "openapi");

  await mkdir(outDir, { recursive: true });

  let serviceNames;
  try {
    serviceNames = await readdir(servicesDir);
  } catch {
    console.warn("[docs-merge] services/ directory not found — skipping per-service copy");
    return;
  }

  for (const name of serviceNames) {
    const srcDir = join(servicesDir, name, "dist", "openapi");
    let files;
    try {
      files = await readdir(srcDir);
    } catch {
      // Service has no openapi output yet — skip
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const src = join(srcDir, file);
      const dest = join(outDir, file);
      await cp(src, dest);
      console.log(`[docs-merge] Copied ${src} → ${dest}`);
    }
  }
}

/**
 * Copies TypeDoc markdown output from packages/{pkg}/dist/typedoc to
 * docs/generated/typedoc/{pkg}. Skips any package whose dist/typedoc
 * directory does not exist yet (e.g. first run before pnpm docs:generate).
 */
async function copyTypedocOutput() {
  const sdkPackages = ["sdk", "app-sdk", "plugin-sdk", "core"];

  for (const pkg of sdkPackages) {
    const srcDir = join(repoRoot, "packages", pkg, "dist", "typedoc");
    const destDir = join(repoRoot, "docs", "generated", "typedoc", pkg);

    try {
      await access(srcDir);
    } catch {
      console.warn(
        `[docs-merge] packages/${pkg}/dist/typedoc not found — skipping (run pnpm docs:generate first)`,
      );
      continue;
    }

    await mkdir(destDir, { recursive: true });
    await cp(srcDir, destDir, { recursive: true });
    console.log(`[docs-merge] Copied packages/${pkg}/dist/typedoc → docs/generated/typedoc/${pkg}`);
  }
}

/**
 * Copies CLI docs from packages/cli/dist/docs/ to docs/generated/cli/.
 *
 * The CLI's docs:generate script writes to dist/docs/ (within the package
 * boundary so Turbo can cache the output).  This step fans the output into
 * the shared docs/generated/ directory that the Starlight site reads from.
 * Skips gracefully if the source directory does not exist yet (e.g. first
 * run before `pnpm turbo docs:generate` has been executed).
 */
async function copyCLIDocs() {
  const srcDir = join(repoRoot, "packages", "cli", "dist", "docs");
  const destDir = join(repoRoot, "docs", "generated", "cli");

  try {
    await access(srcDir);
  } catch {
    console.warn(
      "[docs-merge] packages/cli/dist/docs not found — skipping (run pnpm turbo docs:generate first)",
    );
    return;
  }

  await mkdir(destDir, { recursive: true });
  await cp(srcDir, destDir, { recursive: true });
  console.log(`[docs-merge] Copied packages/cli/dist/docs → docs/generated/cli`);
}

async function main() {
  console.log("[docs-merge] Starting documentation merge...\n");

  // Step 1: Run the OpenAPI merger to produce merged.json
  run(
    "npx tsx tools/openapi-gen/src/cli.ts --merge --services-root services/ --out docs/generated/openapi/merged.json",
    "Merging per-service OpenAPI specs into docs/generated/openapi/merged.json",
  );

  // Step 2: Copy per-service JSON files to docs/generated/openapi/
  // These are served by the gateway at /api/v1/openapi/{service}.json
  await copyPerServiceSpecs();

  // Step 3: Copy TypeDoc output for the 4 SDK packages
  await copyTypedocOutput();

  // Step 4: Copy CLI reference docs from within-package dist/ to shared generated dir
  await copyCLIDocs();

  console.log("\n[docs-merge] Documentation merge complete.");
  console.log(
    "[docs-merge] Next step: pnpm docs:build (builds the Starlight docs site)",
  );
}

main().catch((err) => {
  console.error("[docs-merge] Fatal error:", err.message ?? String(err));
  process.exit(1);
});
