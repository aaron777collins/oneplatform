/**
 * Public types for the PluginDevServer.
 *
 * Separated from the implementation so callers that only need the type shapes
 * can import without pulling in fs/path/perf_hooks at module evaluation time.
 */

import type { BatchResult, ConnectorHandle } from "../types/connector.js";
import type { DataRecord } from "../types/primitives.js";
import type { PluginContext } from "../types/context.js";
import type { TransformerContext } from "../types/transformer.js";
import type { AnyPluginMetadata } from "../types/metadata.js";
import type { PluginManifest } from "../manifest/schema.js";

// ─────────────────────────────────────────────────────────────────────────────
// Dev server options
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Options passed to PluginDevServer.start().
 *
 * All fields are optional — reasonable defaults are applied for local iteration.
 */
export interface DevServerOptions {
  /**
   * TCP port for the optional webhook / HTTP testing endpoint.
   * When omitted the dev server runs headless (no HTTP listener is created).
   * Set to 0 to let the OS assign a free port.
   */
  port?: number;

  /**
   * Custom mock data injected into the dev context's fetch handler.
   * Keys are URL substrings; values are the JSON payloads that should be returned
   * when a fetch call URL contains the key.
   *
   * Example: { "api.example.com/items": { items: [], nextCursor: null } }
   */
  mockData?: Record<string, unknown>;

  /**
   * Test credentials available to the plugin during the dev run.
   * Map of credential name → value, loaded from a local dev-secrets file.
   *
   * Credentials are never logged. They are held in-process for the lifetime
   * of the dev server and released when stop() is called.
   */
  credentials?: Record<string, string>;

  /**
   * Plugin instance configuration values injected into the dev context's tenant.
   * Matches the shape of the manifest's configSchema.
   */
  config?: Record<string, unknown>;

  /**
   * Tenant ID used in the dev context.
   * Default: "dev-tenant"
   */
  tenantId?: string;

  /**
   * Plugin instance ID used in the dev context.
   * Default: "dev-instance"
   */
  instanceId?: string;

  /**
   * When true, fetch() calls in the dev context are forwarded to the real network.
   * Default: false — all fetch calls are intercepted by the mockData handler.
   */
  allowRealFetch?: boolean;

  /**
   * Maximum number of fetchBatch iterations before the dev run is halted.
   * Prevents runaway connectors from looping indefinitely during development.
   * Default: 100
   */
  maxBatches?: number;

  /**
   * Timeout in milliseconds for each connector lifecycle call (connect, fetchBatch,
   * disconnect). The dev server wraps each call in a Promise.race() with a timeout
   * rejection so hangs surface immediately rather than silently blocking.
   * Default: 30_000 (30 seconds)
   */
  callTimeoutMs?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Dev context options
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Options for createDevContext().
 * Exposes only the subset of DevServerOptions relevant to context construction.
 */
export interface DevContextOptions {
  tenantId?: string;
  instanceId?: string;
  credentials?: Record<string, string>;
  config?: Record<string, unknown>;
  mockData?: Record<string, unknown>;
  allowRealFetch?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Run result types
// ─────────────────────────────────────────────────────────────────────────────

/** Timing for a single lifecycle method invocation. */
export interface LifecycleTiming {
  method: "metadata" | "connect" | "fetchBatch" | "disconnect" | "transform";
  durationMs: number;
}

/** Summary of a completed connector dev run. */
export interface ConnectorRunSummary {
  /** Manifest that was loaded and validated. */
  manifest: PluginManifest;

  /** Metadata returned by the connector's metadata() method. */
  connectorMetadata: AnyPluginMetadata;

  /** Handle returned by connect(). */
  handle: ConnectorHandle;

  /** All batches returned across all fetchBatch() calls. */
  batches: BatchResult[];

  /** Total records fetched across all batches. */
  totalRecords: number;

  /** Timing for each lifecycle method call. fetchBatch entries appear in order. */
  timings: LifecycleTiming[];

  /** Peak heap used (bytes) as reported by process.memoryUsage() after all batches. */
  peakHeapUsedBytes: number;

  /** Log entries emitted by the plugin during the run. */
  logs: DevLogEntry[];

  /** Whether the run completed without error. */
  success: boolean;

  /** The error that terminated the run, if any. */
  error?: ErrorInfo;
}

/** A log entry captured from the dev context's logger. */
export interface DevLogEntry {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  metadata?: Record<string, unknown>;
}

/** Structured error information extracted from a thrown value. */
export interface ErrorInfo {
  name: string;
  message: string;
  code?: string;
  isRetryable?: boolean;
  stack?: string;
  details?: Record<string, unknown>;
}

/** The plugin loaded from disk and its validated manifest. */
export interface LoadedPlugin {
  manifest: PluginManifest;
  /**
   * The connector export resolved from the bundle file.
   * undefined when the plugin type is not "connector".
   */
  connector?: ConnectorExport;
  /**
   * The transformer export resolved from the bundle file.
   * undefined when the plugin type is not "transformer".
   */
  transformer?: TransformerExport;
}

/**
 * A connector export resolved from the loaded bundle.
 * The dev server performs structural validation here rather than relying on
 * TypeScript types, because the bundle is loaded via dynamic import at runtime.
 */
export interface ConnectorExport {
  metadata: () => AnyPluginMetadata;
  connect: (
    config: Record<string, unknown>,
    context: PluginContext,
  ) => Promise<ConnectorHandle>;
  fetchBatch: (
    handle: ConnectorHandle,
    cursor: string | null,
    context: PluginContext,
  ) => Promise<BatchResult>;
  disconnect: (
    handle: ConnectorHandle,
    context: PluginContext,
  ) => Promise<void>;
}

/**
 * A transformer export resolved from the loaded bundle.
 * The dev server performs structural validation here rather than relying on
 * TypeScript types, because the bundle is loaded via dynamic import at runtime.
 */
export interface TransformerExport {
  metadata: () => AnyPluginMetadata;
  transform: (
    record: DataRecord,
    context: TransformerContext,
  ) => Promise<DataRecord | null>;
  transformBatch?: (
    records: DataRecord[],
    context: TransformerContext,
  ) => Promise<DataRecord[]>;
}
