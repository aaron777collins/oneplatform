/**
 * @oneplatform/plugin-sdk/dev-server
 *
 * Local development server for plugin authors. Drives the connector lifecycle
 * against a mock context and hot-reloads on source file changes.
 *
 * Import from this path in the CLI and dev tooling only.
 * Plugin source code must never import from this path.
 */

export { PluginDevServer } from "./plugin-dev-server.js";
export { createDevContext } from "./dev-context.js";
export type { DevContext } from "./dev-context.js";
export { PluginLoadError } from "./plugin-loader.js";

export type {
  DevServerOptions,
  DevContextOptions,
  ConnectorRunSummary,
  DevLogEntry,
  ErrorInfo,
  LifecycleTiming,
  LoadedPlugin,
  ConnectorExport,
} from "./types.js";
