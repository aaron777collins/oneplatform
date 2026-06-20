/**
 * PluginDevServer — orchestrates the local plugin development workflow.
 *
 * Responsibilities:
 *   1. Load and validate the plugin manifest + bundle from pluginDir.
 *   2. Create a dev context with the caller's credentials, mock data, and config.
 *   3. Drive the connector lifecycle and emit formatted results to stderr.
 *   4. Watch pluginDir for file changes and hot-reload the plugin.
 *
 * The server is intentionally simple: it does not start an HTTP server unless
 * options.port is set. For most connector development workflows, the terminal
 * output from the connector lifecycle is sufficient.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { DevServerOptions, ConnectorRunSummary } from "./types.js";
import { loadPlugin, PluginLoadError } from "./plugin-loader.js";
import { createDevContext } from "./dev-context.js";
import { runConnectorLifecycle } from "./connector-runner.js";
import {
  printStartBanner,
  printReloadBanner,
  printRunStart,
  printRunSummary,
  printWatching,
  printFatalError,
} from "./formatter.js";

// ─────────────────────────────────────────────────────────────────────────────
// PluginDevServer
// ─────────────────────────────────────────────────────────────────────────────

export class PluginDevServer {
  private watcher: fs.FSWatcher | null = null;

  // Debounce reload so rapid file saves (formatter + lint auto-fix) trigger
  // only one reload rather than several overlapping runs.
  private reloadTimer: NodeJS.Timeout | null = null;
  private readonly DEBOUNCE_MS = 300;

  // Track whether a run is already in progress so we do not start two runs
  // concurrently on burst saves.
  private runInProgress = false;

  /**
   * Load the plugin at pluginDir, run the connector lifecycle once, then (if
   * watch mode is active) wait for file changes and reload automatically.
   *
   * @param pluginDir Absolute path to the plugin project root.
   * @param options   Dev server configuration.
   * @returns The summary of the initial run. In watch mode the method resolves
   *          after the first run and watch events are handled asynchronously.
   */
  async start(
    pluginDir: string,
    options: DevServerOptions = {},
  ): Promise<ConnectorRunSummary> {
    // Validate pluginDir upfront to give an immediately actionable error rather
    // than a cryptic path-not-found from inside the loader.
    if (!fs.existsSync(pluginDir)) {
      const msg = `Plugin directory does not exist: "${pluginDir}"`;
      printFatalError(msg);
      throw new PluginLoadError(msg);
    }

    printStartBanner(pluginDir);

    const summary = await this.runOnce(pluginDir, options);
    printRunSummary(summary);

    return summary;
  }

  /**
   * Start the file watcher. Subsequent changes to any file under pluginDir
   * will trigger an automatic reload and re-run of the connector lifecycle.
   *
   * Separate from start() so callers (e.g., the CLI command) can decide
   * whether to watch based on a --watch flag.
   *
   * @param pluginDir Absolute path to the plugin project root.
   * @param options   Dev server configuration (same options as start()).
   */
  startWatching(pluginDir: string, options: DevServerOptions = {}): void {
    if (this.watcher !== null) {
      // Already watching — nothing to do.
      return;
    }

    printWatching(pluginDir);

    // We watch the dist/ directory because loadPlugin() loads the compiled
    // dist/bundle.js — not the TypeScript sources. Watching src/ would trigger
    // reloads before the build tool has written fresh output to dist/, causing
    // the dev server to load stale artifacts. The developer's own build tool
    // (esbuild --watch, tsc --watch, etc.) is responsible for rebuilding dist/
    // when src/ changes; the dev server then picks up the new bundle.
    const watchDir = path.join(pluginDir, "dist");
    const watchTarget = fs.existsSync(watchDir) ? watchDir : pluginDir;

    this.watcher = fs.watch(watchTarget, { recursive: true }, (event, filename) => {
      // fs.watch can fire multiple events for a single save; debounce them.
      if (this.reloadTimer !== null) clearTimeout(this.reloadTimer);

      const changedFile = filename ?? "(unknown file)";
      this.reloadTimer = setTimeout(() => {
        this.reloadTimer = null;
        if (this.runInProgress) return;

        printReloadBanner(changedFile);
        this.runOnce(pluginDir, options)
          .then((summary) => {
            printRunSummary(summary);
          })
          .catch((err: unknown) => {
            printFatalError(err instanceof Error ? err.message : String(err));
          });
      }, this.DEBOUNCE_MS);
    });

    // Swallow watcher errors (e.g., file system permission issues) rather than
    // crashing the dev server. The developer will see the error in the next reload.
    this.watcher.on("error", (err) => {
      process.stderr.write(`[dev-server:watch] Watcher error: ${String(err)}\n`);
    });
  }

  /**
   * Stop the file watcher and release all resources.
   *
   * Safe to call even if the server was never started or already stopped.
   */
  stop(): void {
    if (this.reloadTimer !== null) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }

    if (this.watcher !== null) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private
  // ─────────────────────────────────────────────────────────────────────────

  private async runOnce(
    pluginDir: string,
    options: DevServerOptions,
  ): Promise<ConnectorRunSummary> {
    this.runInProgress = true;

    try {
      const plugin = await loadPlugin(pluginDir);
      printRunStart(plugin.manifest.id);

      const contextOptions = {
        ...(options.tenantId       !== undefined ? { tenantId:       options.tenantId }       : {}),
        ...(options.instanceId     !== undefined ? { instanceId:     options.instanceId }     : {}),
        ...(options.credentials    !== undefined ? { credentials:    options.credentials }    : {}),
        ...(options.config         !== undefined ? { config:         options.config }         : {}),
        ...(options.mockData       !== undefined ? { mockData:       options.mockData }       : {}),
        ...(options.allowRealFetch !== undefined ? { allowRealFetch: options.allowRealFetch } : {}),
      };
      const context = createDevContext(contextOptions);

      // Drive the transformer lifecycle when a transformer plugin is loaded.
      if (plugin.transformer !== undefined) {
        return await runTransformerLifecycle(plugin.transformer, plugin.manifest, context, options);
      }

      if (plugin.connector === undefined) {
        // Non-connector/non-transformer plugins do not have a lifecycle the
        // dev server can drive. Print type-specific guidance and return a
        // synthetic summary.
        return buildNonConnectorSummary(plugin.manifest);
      }

      return await runConnectorLifecycle(plugin.connector, plugin.manifest, context, options);
    } finally {
      this.runInProgress = false;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

import type { PluginManifest } from "../manifest/schema.js";
import type { TransformerExport, DevServerOptions as DevServerOptionsType, LifecycleTiming } from "./types.js";
import type { DataRecord } from "../types/primitives.js";
import type { DevContext } from "./dev-context.js";
import { performance } from "node:perf_hooks";

/**
 * Run the transformer lifecycle: call metadata(), then transform() with sample
 * records from the input file or built-in samples.
 *
 * This provides developers working on transformer plugins the same "one-command
 * dev run" experience that connector developers already have.
 */
async function runTransformerLifecycle(
  transformer: TransformerExport,
  manifest: PluginManifest,
  context: DevContext,
  _options: DevServerOptionsType,
): Promise<ConnectorRunSummary> {
  const timings: LifecycleTiming[] = [];

  // metadata()
  const metaStart = performance.now();
  const meta = transformer.metadata();
  timings.push({ method: "metadata", durationMs: Math.round(performance.now() - metaStart) });

  process.stderr.write(`[dev-server] Transformer "${meta.name}" loaded (v${meta.version})\n`);

  // Build sample records to transform. In a future iteration, the dev server
  // could read --input <file.json> to supply custom records. For now, use
  // built-in samples that exercise common field types.
  const sampleRecords: DataRecord[] = [
    {
      sourceId: "sample-001",
      data: { id: "sample-001", name: "Alice Example", email: "alice@example.test", score: 85 },
      metadata: { createdAt: new Date().toISOString() },
    },
    {
      sourceId: "sample-002",
      data: { id: "sample-002", name: "Bob Builder", email: "bob@example.test", score: 92 },
      metadata: { createdAt: new Date().toISOString() },
    },
  ];

  const transformedRecords: DataRecord[] = [];

  // Call transform() for each sample record, measuring timing.
  for (const record of sampleRecords) {
    const txStart = performance.now();
    try {
      const result = await transformer.transform(record, context);
      timings.push({ method: "transform", durationMs: Math.round(performance.now() - txStart) });
      if (result !== null) {
        transformedRecords.push(result);
        process.stderr.write(
          `[dev-server] transform("${record.sourceId}") → record (sourceId: "${result.sourceId}")\n`,
        );
      } else {
        process.stderr.write(
          `[dev-server] transform("${record.sourceId}") → dropped (returned null)\n`,
        );
      }
    } catch (err) {
      timings.push({ method: "transform", durationMs: Math.round(performance.now() - txStart) });
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[dev-server] transform("${record.sourceId}") → ERROR: ${message}\n`,
      );
    }
  }

  process.stderr.write(
    `[dev-server] Transformer run complete: ${transformedRecords.length}/${sampleRecords.length} records passed through\n`,
  );

  return {
    manifest,
    connectorMetadata: meta,
    handle: { connectionId: "(transformer)", metadata: {} },
    batches: [{
      records: transformedRecords,
      nextCursor: null,
      hasMore: false,
      fetchedAt: new Date().toISOString(),
    }],
    totalRecords: transformedRecords.length,
    timings,
    peakHeapUsedBytes: process.memoryUsage().heapUsed,
    logs: context.__logs,
    success: true,
  };
}

function buildNonConnectorSummary(manifest: PluginManifest): ConnectorRunSummary {
  const typeGuidance: Record<string, string> = {
    transformer:
      `  Transformer plugins can be tested with:\n` +
      `    op plugin simulate-hook before:pipeline.step --input data.json\n` +
      `  Or run your test suite: npm test\n`,
    destination:
      `  Destination plugins can be tested with:\n` +
      `    op plugin simulate-hook before:ingestion.stage --input records.json\n` +
      `  Or run your test suite: npm test\n`,
    "auth-provider":
      `  Auth provider plugins can be tested with:\n` +
      `    op plugin simulate-hook before:auth.login --input params.json\n` +
      `  Or run your test suite: npm test\n`,
    widget:
      `  Widget plugins can be tested by running your test suite: npm test\n` +
      `  Widget rendering preview is not yet supported in the dev server.\n`,
  };

  const guidance = typeGuidance[manifest.type] ??
    `  Use "op plugin simulate-hook" to test ${manifest.type} plugins.\n`;

  process.stderr.write(
    `[dev-server] Plugin type "${manifest.type}" is not supported by the dev server yet.\n` +
      `  The dev server currently drives the connector lifecycle only.\n` +
      guidance,
  );

  return {
    manifest,
    connectorMetadata: {
      type:               "connector",
      id:                 manifest.id,
      name:               manifest.name,
      description:        manifest.description,
      version:            manifest.version,
      author:             manifest.author,
      category:           "unknown",
      outputSchema:       {},
      configSchema:       {},
      supportsIncremental: false,
      supportsRealtime:   false,
    },
    handle:            { connectionId: "(n/a)", metadata: {} },
    batches:           [],
    totalRecords:      0,
    timings:           [],
    peakHeapUsedBytes: process.memoryUsage().heapUsed,
    logs:              [],
    success:           true,
  };
}
