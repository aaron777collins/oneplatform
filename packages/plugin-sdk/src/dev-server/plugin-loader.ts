/**
 * Plugin loader for the dev server.
 *
 * Loads a plugin from its source directory, validates the manifest, and resolves
 * the connector export from the compiled bundle.
 *
 * Why we load the compiled bundle (dist/bundle.js) rather than the TypeScript
 * source directly: the plugin SDK mirrors the production execution environment,
 * which always loads the compiled output. Loading dist/ also means the dev server
 * tests the actual artifact that would be packed and shipped.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { validateManifest } from "../manifest/schema.js";
import type { PluginManifest } from "../manifest/schema.js";
import type { ConnectorExport, LoadedPlugin } from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Error types
// ─────────────────────────────────────────────────────────────────────────────

export class PluginLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginLoadError";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Loader
// ─────────────────────────────────────────────────────────────────────────────

const MANIFEST_FILENAME = "plugin.manifest.json";
const DEFAULT_BUNDLE_RELATIVE = "dist/bundle.js";

/**
 * Load and validate a plugin from pluginDir.
 *
 * @param pluginDir Absolute path to the plugin project root.
 * @returns LoadedPlugin containing the validated manifest and the connector
 *          export (for connector-type plugins).
 * @throws PluginLoadError with a descriptive message for any validation failure.
 */
export async function loadPlugin(pluginDir: string): Promise<LoadedPlugin> {
  // ── Manifest ───────────────────────────────────────────────────────────────
  const manifestPath = path.join(pluginDir, MANIFEST_FILENAME);
  if (!fs.existsSync(manifestPath)) {
    throw new PluginLoadError(
      `Plugin manifest not found at "${manifestPath}". ` +
        `Run "op plugin create" to scaffold a plugin, or ensure you are in the plugin root directory.`,
    );
  }

  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  } catch (err) {
    throw new PluginLoadError(
      `Failed to parse plugin manifest at "${manifestPath}": ${String(err)}`,
    );
  }

  const validationResult = validateManifest(rawManifest);
  if (!validationResult.valid) {
    const errorLines = validationResult.errors
      .map((e) => `  ${e.path}: ${e.message}`)
      .join("\n");
    throw new PluginLoadError(
      `Plugin manifest is invalid:\n${errorLines}`,
    );
  }

  const manifest: PluginManifest = validationResult.manifest;

  // ── Bundle ─────────────────────────────────────────────────────────────────
  // Only connector-type plugins have a connector lifecycle. Other plugin types
  // (transformer, destination, auth-provider, widget) have a different execution
  // model and are not driven by the dev server's connector lifecycle runner.
  if (manifest.type !== "connector") {
    return { manifest };
  }

  const bundlePath = path.join(pluginDir, DEFAULT_BUNDLE_RELATIVE);
  if (!fs.existsSync(bundlePath)) {
    throw new PluginLoadError(
      `Compiled bundle not found at "${bundlePath}". ` +
        `Run "npm run build" (or "npm run dev") in the plugin directory first.`,
    );
  }

  // Dynamic import is used so the bundle can be a standard ESM module.
  // The file:// prefix is required on all platforms for absolute paths.
  let bundleModule: unknown;
  try {
    bundleModule = await import(`file://${bundlePath}`);
  } catch (err) {
    throw new PluginLoadError(
      `Failed to import plugin bundle at "${bundlePath}": ${String(err)}`,
    );
  }

  const connector = resolveConnectorExport(bundleModule, manifest.entrypoint, bundlePath);

  return { manifest, connector };
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve and validate the connector export from the loaded bundle module.
 * Throws PluginLoadError with an actionable message if the export is missing
 * or does not satisfy the Connector interface shape.
 */
function resolveConnectorExport(
  bundleModule: unknown,
  entrypoint: string,
  bundlePath: string,
): ConnectorExport {
  if (typeof bundleModule !== "object" || bundleModule === null) {
    throw new PluginLoadError(
      `Plugin bundle at "${bundlePath}" did not export a module object.`,
    );
  }

  const mod = bundleModule as Record<string, unknown>;
  const exported = mod[entrypoint];

  if (typeof exported !== "object" || exported === null) {
    const available = Object.keys(mod).join(", ") || "(none)";
    throw new PluginLoadError(
      `Plugin bundle does not export "${entrypoint}". ` +
        `Available exports: ${available}. ` +
        `Ensure manifest.entrypoint matches the named export in src/index.ts.`,
    );
  }

  const connector = exported as Record<string, unknown>;

  for (const method of ["metadata", "connect", "fetchBatch", "disconnect"] as const) {
    if (typeof connector[method] !== "function") {
      throw new PluginLoadError(
        `Plugin export "${entrypoint}" is missing required method "${method}". ` +
          `Ensure the export implements the Connector interface.`,
      );
    }
  }

  return exported as ConnectorExport;
}
