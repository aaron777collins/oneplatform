/**
 * @oneplatform/plugin-sdk/dev
 *
 * Build-tooling utilities consumed by @oneplatform/cli.
 * Not part of the plugin SDK's public API surface — plugin source code must
 * never import from this path (it would pull build dependencies into the bundle).
 */

export { generateScaffold } from "./scaffold.js";
export type { ScaffoldOptions, ScaffoldResult, ScaffoldedFile, PluginType } from "./scaffold.js";

export { packPlugin, validatePlugin } from "./pack.js";
export type { PackOptions, PackResult, ValidateOptions, ValidationResult } from "./pack.js";

export { runSimulateHook } from "./simulate-hook.js";
export type { SimulateHookCliArgs, SimulateHookOutput } from "./simulate-hook.js";
