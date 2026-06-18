import { readFileSync } from "node:fs";

/**
 * Reads the `version` field from the package.json that lives one directory
 * above the caller's compiled file.
 *
 * Usage (in each service's src/index.ts):
 *
 *   import { readPackageVersion } from "@oneplatform/core";
 *   const version = readPackageVersion(import.meta.url);
 *
 * How the path resolves at runtime:
 *   - caller is   services/gateway/dist/index.js
 *   - URL becomes file:///…/services/gateway/dist/index.js
 *   - "../package.json" resolves to services/gateway/package.json  ✓
 *
 * Why readFileSync instead of an async import()?
 * Version is needed at startup before the app is created. Synchronous I/O
 * at startup is an accepted trade-off (one small file, read once).
 *
 * Falls back to "0.0.0-dev" when the file is absent or malformed so that
 * development environments without a full build still start cleanly.
 */
export function readPackageVersion(callerImportMetaUrl: string): string {
  try {
    const pkgUrl = new URL("../package.json", callerImportMetaUrl);
    const raw = readFileSync(pkgUrl, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "version" in parsed &&
      typeof (parsed as Record<string, unknown>)["version"] === "string"
    ) {
      return (parsed as Record<string, unknown>)["version"] as string;
    }
    return "0.0.0-dev";
  } catch {
    // File absent (dev environment without a built dist), or JSON parse error.
    return "0.0.0-dev";
  }
}
