/**
 * @oneplatform/plugin-sdk/dev
 *
 * Build-tooling utilities consumed by @oneplatform/cli.
 * Not part of the plugin SDK's public API surface — plugin source code must
 * never import from this path (it would pull build dependencies into the bundle).
 *
 * PU-013: The `op plugin dev --watch` flag already triggers hot-reload on
 * source changes (via PluginDevServer.startWatching). Enhancement path:
 * add incremental TypeScript compilation using tsc --watch or esbuild's
 * incremental mode so that only changed modules are rebuilt, rather than
 * re-bundling the entire plugin on every file save. This would reduce the
 * reload latency from ~2s (full bundle) to <200ms (incremental) for large plugins.
 */

export { generateScaffold } from "./scaffold.js";
export type { ScaffoldOptions, ScaffoldResult, ScaffoldedFile, PluginType } from "./scaffold.js";

export { packPlugin, validatePlugin } from "./pack.js";
export type { PackOptions, PackResult, ValidateOptions, ValidationResult } from "./pack.js";

export { runSimulateHook } from "./simulate-hook.js";
export type { SimulateHookCliArgs, SimulateHookOutput } from "./simulate-hook.js";
