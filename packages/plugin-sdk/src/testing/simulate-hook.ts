/**
 * Programmatic simulate-hook API for use in integration tests.
 *
 * This is the in-process API surface. The CLI entry point (src/dev/simulate-hook.ts)
 * wraps this API with argument parsing and file I/O. Test code imports directly from
 * here to avoid spawning a child process.
 */

import type { HookPayload, HookResult, HookStage } from "../types/hooks.js";
import type { MockContextOptions } from "./mock-context.js";
import { createMockContext } from "./mock-context.js";

export interface SimulateHookOptions {
  /**
   * Absolute or relative path to the compiled bundle.js.
   * The module must export a function named `entrypoint`.
   */
  bundlePath: string;

  /** The hook stage identifier (used for payload.stage). */
  stage: HookStage;

  /** The named export in the bundle that implements this hook. */
  entrypoint: string;

  /** The data to include in the HookPayload. */
  payload: {
    data: Record<string, unknown>;
    context?: Partial<HookPayload["context"]>;
  };

  /** Options forwarded to createMockContext(). */
  contextOptions?: MockContextOptions;
}

export interface SimulateHookResult {
  stage: HookStage;
  duration_ms: number;
  result?: HookResult;
  error?: {
    type: string;
    code?: string;
    message: string;
    isRetryable?: boolean;
    details?: Record<string, unknown>;
  };
  logs: Array<{
    level: string;
    message: string;
    metadata?: Record<string, unknown>;
  }>;
  spans: Array<{
    name: string;
    duration_ms: number;
  }>;
}

/**
 * Execute a hook function in-process using a mock PluginContext.
 *
 * Dynamically imports the bundle and invokes the named entrypoint.
 * Suitable for integration tests that want to verify hook behaviour without
 * starting a real OnePlatform instance.
 *
 * @example
 * const result = await simulateHook({
 *   bundlePath: "./dist/bundle.js",
 *   stage: "before:ingestion.receive",
 *   entrypoint: "onBeforeIngestionReceive",
 *   payload: { data: { name: "Alice" } },
 * });
 */
export async function simulateHook(options: SimulateHookOptions): Promise<SimulateHookResult> {
  const {
    bundlePath,
    stage,
    entrypoint,
    payload,
    contextOptions = {},
  } = options;

  const mockContext = createMockContext(contextOptions);

  const hookPayload: HookPayload = {
    stage,
    data: payload.data,
    context: {
      tenantId: mockContext.tenant.tenantId,
      traceId: "00000000000000000000000000000001",
      spanId: "0000000000000001",
      ...payload.context,
    },
  };

  // Dynamic import allows the bundle to be loaded at runtime without
  // complicating the TypeScript compilation of the SDK itself.
  let bundle: Record<string, unknown>;
  try {
    bundle = (await import(bundlePath)) as Record<string, unknown>;
  } catch (importErr) {
    throw new Error(
      `simulateHook: failed to import bundle at "${bundlePath}": ${String(importErr)}`,
    );
  }

  const hookFn = bundle[entrypoint];
  if (typeof hookFn !== "function") {
    throw new Error(
      `simulateHook: bundle export "${entrypoint}" is not a function (got ${typeof hookFn})`,
    );
  }

  const startMs = performance.now();
  let result: HookResult | undefined;
  let errorInfo: SimulateHookResult["error"];

  try {
    result = (await (hookFn as (p: HookPayload, ctx: typeof mockContext) => Promise<HookResult>)(
      hookPayload,
      mockContext,
    )) as HookResult;
  } catch (err) {
    const e = err as Record<string, unknown>;
    errorInfo = {
      type: typeof e["name"] === "string" ? e["name"] : "Error",
      message: typeof e["message"] === "string" ? e["message"] : String(err),
      ...(typeof e["code"] === "string" ? { code: e["code"] } : {}),
      ...(typeof e["isRetryable"] === "boolean" ? { isRetryable: e["isRetryable"] } : {}),
      ...(typeof e["details"] === "object" && e["details"] !== null
        ? { details: e["details"] as Record<string, unknown> }
        : {}),
    };
  }

  const duration_ms = performance.now() - startMs;

  return {
    stage,
    duration_ms: Math.round(duration_ms),
    ...(result !== undefined ? { result } : {}),
    ...(errorInfo !== undefined ? { error: errorInfo } : {}),
    logs: mockContext.logger.__logs.map((log) => ({
      level: log.level,
      message: log.message,
      ...(log.metadata !== undefined ? { metadata: log.metadata } : {}),
    })),
    spans: mockContext.tracing.__spans.map((span) => ({
      name: span.name,
      // Span duration is not tracked precisely in the mock — report 0
      duration_ms: 0,
    })),
  };
}
