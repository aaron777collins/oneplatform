/**
 * Connector lifecycle runner for the dev server.
 *
 * Drives the full connector lifecycle: metadata → connect → fetchBatch loop →
 * disconnect. Each call is wrapped with:
 *   - Timing measurement via performance.now()
 *   - A per-call timeout so a hung connector surfaces immediately
 *   - Structured error capture so the run summary always carries complete info
 *
 * The runner does not format output — it returns a ConnectorRunSummary that the
 * formatter and CLI command can render however they choose.
 */

import { performance } from "node:perf_hooks";
import type { BatchResult, ConnectorHandle } from "../types/connector.js";
import type {
  ConnectorRunSummary,
  ConnectorExport,
  DevServerOptions,
  ErrorInfo,
  LifecycleTiming,
} from "./types.js";
import type { DevContext } from "./dev-context.js";
import type { PluginManifest } from "../manifest/schema.js";

const DEFAULT_MAX_BATCHES = 100;
const DEFAULT_CALL_TIMEOUT_MS = 30_000;

// ─────────────────────────────────────────────────────────────────────────────
// Runner
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the full connector lifecycle against the given dev context.
 *
 * @param connector The resolved connector export from the plugin bundle.
 * @param manifest  The validated plugin manifest.
 * @param context   The dev context to inject into each lifecycle call.
 * @param options   Dev server options (maxBatches, callTimeoutMs, config).
 * @returns ConnectorRunSummary describing what happened, win or lose.
 */
export async function runConnectorLifecycle(
  connector: ConnectorExport,
  manifest: PluginManifest,
  context: DevContext,
  options: DevServerOptions,
): Promise<ConnectorRunSummary> {
  const maxBatches = options.maxBatches ?? DEFAULT_MAX_BATCHES;
  const callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const config = options.config ?? {};

  const timings: LifecycleTiming[] = [];
  const batches: BatchResult[] = [];

  // ── metadata() ─────────────────────────────────────────────────────────────
  const { result: connectorMetadata, timing: metadataTiming } = await timedCall(
    "metadata",
    () => Promise.resolve(connector.metadata()),
    callTimeoutMs,
  );

  if (metadataTiming !== null) timings.push(metadataTiming);

  if (connectorMetadata instanceof Error) {
    return buildFailureSummary(manifest, connectorMetadata, timings, batches, context);
  }

  // ── connect() ──────────────────────────────────────────────────────────────
  const { result: handle, timing: connectTiming } = await timedCall(
    "connect",
    () => connector.connect(config, context),
    callTimeoutMs,
  );

  if (connectTiming !== null) timings.push(connectTiming);

  if (handle instanceof Error) {
    return buildFailureSummary(manifest, handle, timings, batches, context);
  }

  // ── fetchBatch() loop ──────────────────────────────────────────────────────
  let cursor: string | null = null;
  let batchCount = 0;

  while (batchCount < maxBatches) {
    const { result: batch, timing: fetchTiming } = await timedCall(
      "fetchBatch",
      () => connector.fetchBatch(handle as ConnectorHandle, cursor, context),
      callTimeoutMs,
    );

    if (fetchTiming !== null) timings.push(fetchTiming);

    if (batch instanceof Error) {
      // Disconnect best-effort before returning the failure
      await tryDisconnect(connector, handle as ConnectorHandle, context, callTimeoutMs, timings);
      return buildFailureSummary(manifest, batch, timings, batches, context);
    }

    const batchResult = batch as BatchResult;
    batches.push(batchResult);
    batchCount++;

    if (!batchResult.hasMore || batchResult.nextCursor === null) {
      break;
    }

    cursor = batchResult.nextCursor;
  }

  // ── disconnect() ───────────────────────────────────────────────────────────
  const disconnectError = await tryDisconnect(
    connector,
    handle as ConnectorHandle,
    context,
    callTimeoutMs,
    timings,
  );

  // ── Summary ────────────────────────────────────────────────────────────────
  const totalRecords = batches.reduce((sum, b) => sum + b.records.length, 0);
  const peakHeapUsedBytes = process.memoryUsage().heapUsed;

  if (disconnectError !== null) {
    return buildFailureSummary(manifest, disconnectError, timings, batches, context);
  }

  return {
    manifest,
    connectorMetadata,
    handle: handle as ConnectorHandle,
    batches,
    totalRecords,
    timings,
    peakHeapUsedBytes,
    logs: context.__logs,
    success: true,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

interface TimedCallResult<T> {
  result: T | Error;
  timing: LifecycleTiming | null;
}

/**
 * Measure the wall-clock duration of an async call and cap it with a timeout.
 *
 * Returns a union result so the caller decides whether to continue or abort.
 * We never throw from timedCall — all errors are captured in result.
 *
 * The timeout handle is always cleared when fn() settles first, preventing
 * accumulation of dangling timers across up to maxBatches=100 fetchBatch calls.
 */
async function timedCall<T>(
  method: LifecycleTiming["method"],
  fn: () => Promise<T>,
  timeoutMs: number,
): Promise<TimedCallResult<T>> {
  const start = performance.now();
  let timeoutHandle: NodeJS.Timeout | undefined;

  try {
    const result = await new Promise<T>((resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(
          new Error(
            `connector.${method}() timed out after ${timeoutMs}ms. ` +
              `Increase callTimeoutMs or check the plugin for network hangs.`,
          ),
        );
      }, timeoutMs);

      // Prevent the timer from keeping the process alive when everything else finishes.
      // unref() is a Node.js-specific method on Timeout objects.
      if (typeof (timeoutHandle as NodeJS.Timeout).unref === "function") {
        (timeoutHandle as NodeJS.Timeout).unref();
      }

      fn().then(resolve, reject);
    });

    // fn() resolved before the timeout — clear the timer so it does not fire later.
    clearTimeout(timeoutHandle);
    const durationMs = Math.round(performance.now() - start);
    return { result, timing: { method, durationMs } };
  } catch (err) {
    // fn() rejected or the timeout fired — either way, clear the handle to be safe.
    clearTimeout(timeoutHandle);
    const durationMs = Math.round(performance.now() - start);
    const error = err instanceof Error ? err : new Error(String(err));
    return { result: error, timing: { method, durationMs } };
  }
}

/**
 * Attempt disconnect(), capturing any error rather than throwing.
 * disconnect() must not throw per the Connector contract; this enforces it
 * locally so a misbehaving plugin does not suppress the run summary.
 */
async function tryDisconnect(
  connector: ConnectorExport,
  handle: ConnectorHandle,
  context: DevContext,
  callTimeoutMs: number,
  timings: LifecycleTiming[],
): Promise<Error | null> {
  const { result, timing } = await timedCall(
    "disconnect",
    () => connector.disconnect(handle, context),
    callTimeoutMs,
  );
  if (timing !== null) timings.push(timing);
  return result instanceof Error ? result : null;
}

/** Build a ConnectorRunSummary for a failed run. */
function buildFailureSummary(
  manifest: PluginManifest,
  error: Error,
  timings: LifecycleTiming[],
  batches: BatchResult[],
  context: DevContext,
): ConnectorRunSummary {
  const totalRecords = batches.reduce((sum, b) => sum + b.records.length, 0);
  const peakHeapUsedBytes = process.memoryUsage().heapUsed;

  return {
    manifest,
    // connectorMetadata may be unavailable if metadata() itself failed.
    // We provide a synthetic placeholder so the summary type is always complete.
    connectorMetadata: {
      type: "connector",
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      version: manifest.version,
      author: manifest.author,
      category: "unknown",
      outputSchema: {},
      configSchema: {},
      supportsIncremental: false,
      supportsRealtime: false,
    },
    // Provide a minimal ConnectorHandle placeholder since connect() may not
    // have returned before the failure.
    handle: { connectionId: "(failed)", metadata: {} },
    batches,
    totalRecords,
    timings,
    peakHeapUsedBytes,
    logs: context.__logs,
    success: false,
    error: extractErrorInfo(error),
  };
}

/** Extract structured error information from any thrown value. */
function extractErrorInfo(err: unknown): ErrorInfo {
  if (!(err instanceof Error)) {
    return { name: "UnknownError", message: String(err) };
  }

  const e = err as Error & {
    code?: string;
    isRetryable?: boolean;
    details?: Record<string, unknown>;
  };

  return {
    name: e.name,
    message: e.message,
    ...(e.code !== undefined ? { code: e.code } : {}),
    ...(e.isRetryable !== undefined ? { isRetryable: e.isRetryable } : {}),
    ...(e.stack !== undefined ? { stack: e.stack } : {}),
    ...(e.details !== undefined ? { details: e.details } : {}),
  };
}
