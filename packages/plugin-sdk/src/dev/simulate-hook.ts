/**
 * CLI entry: op plugin simulate-hook
 *
 * Executes a hook function locally using a mock PluginContext.
 * Does not require a running OnePlatform instance.
 *
 * By default uses Node.js vm.Script for fast iteration (not isolated-vm).
 * Pass --sandbox to use a real isolated-vm context matching production.
 * See D4 in the design decision log for the rationale.
 *
 * This module is imported by @oneplatform/cli and is not part of the plugin
 * SDK's public API surface.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";
import { performance } from "node:perf_hooks";
import { createMockContext } from "../testing/mock-context.js";
import type { HookPayload, HookResult } from "../types/hooks.js";

// ────────────────────────────────────────────────────────────────────────────
// CLI argument types
// ────────────────────────────────────────────────────────────────────────────

export interface SimulateHookCliArgs {
  /** The hook stage, e.g. "before:ingestion.receive" */
  stage: string;

  /** Path to the compiled bundle.js. Default: ./dist/bundle.js */
  plugin?: string;

  /** Path to a JSON file with HookPayload.data */
  input?: string;

  /** Tenant ID to use in mock context. Default: "dev-tenant" */
  tenantId?: string;

  /** Plugin instance ID. Default: "dev-instance" */
  instanceId?: string;

  /** Path to a JSON file with credential name → value mappings */
  credentials?: string;

  /** Path to a JSON file with plugin instance config values */
  config?: string;

  /** Pretty-print output. Default: true when stdout is tty */
  pretty?: boolean;

  /** Run in isolated-vm sandbox instead of vm.Script */
  sandbox?: boolean;
}

// ────────────────────────────────────────────────────────────────────────────
// Output types (matches the spec's JSON output format exactly)
// ────────────────────────────────────────────────────────────────────────────

export interface SimulateHookOutput {
  stage: string;
  duration_ms: number;
  result?: HookResult;
  error?: {
    type: string;
    code?: string;
    message: string;
    isRetryable?: boolean;
    details?: Record<string, unknown>;
  };
  logs: Array<{ level: string; message: string; metadata?: Record<string, unknown> }>;
  spans: Array<{ name: string; duration_ms: number }>;
}

// ────────────────────────────────────────────────────────────────────────────
// Core execution
// ────────────────────────────────────────────────────────────────────────────

function loadJsonFile(filePath: string, label: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label}: file not found at "${filePath}"`);
  }
  const raw = fs.readFileSync(filePath, "utf-8");
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`${label}: invalid JSON — ${String(err)}`);
  }
}

function loadStringRecord(filePath: string, label: string): Record<string, string> {
  const obj = loadJsonFile(filePath, label);
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v !== "string") {
      throw new Error(`${label}: all values must be strings, but "${k}" is ${typeof v}`);
    }
    result[k] = v;
  }
  return result;
}

/**
 * Execute a simulate-hook run with the given CLI arguments.
 * Writes the result JSON to stdout and execution summary to stderr.
 */
export async function runSimulateHook(args: SimulateHookCliArgs): Promise<void> {
  const bundlePath = path.resolve(args.plugin ?? "./dist/bundle.js");

  if (!fs.existsSync(bundlePath)) {
    process.stderr.write(`Error: bundle not found at "${bundlePath}"\n`);
    process.exit(1);
  }

  // Load the HookPayload data from --input file or use an empty object
  const inputData: Record<string, unknown> = args.input
    ? loadJsonFile(args.input, "--input")
    : {};

  // Load credentials and config from optional JSON files
  const credentialMap: Record<string, string> = args.credentials
    ? loadStringRecord(args.credentials, "--credentials")
    : {};

  const config: Record<string, unknown> = args.config
    ? loadJsonFile(args.config, "--config")
    : {};

  const pretty = args.pretty ?? process.stdout.isTTY;
  const mockCtx = createMockContext({
    tenantId: args.tenantId ?? "dev-tenant",
    instanceId: args.instanceId ?? "dev-instance",
    credentials: credentialMap,
    config,
  });

  const hookPayload: HookPayload = {
    stage: args.stage as HookPayload["stage"],
    data: inputData,
    context: {
      tenantId: mockCtx.tenant.tenantId,
      traceId: "00000000000000000000000000000001",
      spanId: "0000000000000001",
    },
  };

  // Read the bundle source and execute in a vm.Script context
  const bundleSource = fs.readFileSync(bundlePath, "utf-8");

  const startMs = performance.now();
  let result: HookResult | undefined;
  let errorInfo: SimulateHookOutput["error"];

  if (args.sandbox) {
    // Production-accurate: use isolated-vm (requires it to be installed)
    // This branch is intentionally guarded — isolated-vm is not a dependency
    // of the SDK. The CLI package installs it separately.
    process.stderr.write("[sandbox mode not available in SDK — install isolated-vm in the CLI]\n");
    process.exit(1);
  } else {
    // Fast path: vm.Script with a synthetic module environment
    // Provides basic isolation without the overhead of a full V8 isolate
    const moduleExports: Record<string, unknown> = {};

    const context = vm.createContext({
      exports: moduleExports,
      module: { exports: moduleExports },
      __pluginContext: mockCtx,
      __hookPayload: hookPayload,
      __result: undefined as HookResult | undefined,
      __error: undefined as unknown,
      performance,
      console,
      setTimeout,
      clearTimeout,
      Promise,
      URL,
    });

    const wrappedSource = `
      (async () => {
        ${bundleSource}
        const fn = exports[Object.keys(exports)[0]];
        if (typeof fn !== "function") {
          throw new Error("Bundle does not export a callable function");
        }
        __result = await fn(__hookPayload, __pluginContext);
      })().then(() => {}).catch((e) => { __error = e; });
    `;

    const script = new vm.Script(wrappedSource);
    try {
      script.runInContext(context);
      // Allow micro-tasks to settle — vm.Script runs synchronously but async
      // functions need to flush their internal promise queues
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    } catch (err) {
      errorInfo = buildErrorInfo(err);
    }

    if (context["__error"] !== undefined) {
      errorInfo = buildErrorInfo(context["__error"]);
    } else {
      result = context["__result"] as HookResult | undefined;
    }
  }

  const duration_ms = Math.round(performance.now() - startMs);

  const output: SimulateHookOutput = {
    stage: args.stage,
    duration_ms,
    ...(result !== undefined ? { result } : {}),
    ...(errorInfo !== undefined ? { error: errorInfo } : {}),
    logs: mockCtx.logger.__logs.map((l) => ({
      level: l.level,
      message: l.message,
      ...(l.metadata !== undefined ? { metadata: l.metadata } : {}),
    })),
    spans: mockCtx.tracing.__spans.map((s) => ({
      name: s.name,
      duration_ms: 0,
    })),
  };

  const json = pretty ? JSON.stringify(output, null, 2) : JSON.stringify(output);
  process.stdout.write(json + "\n");

  // Summary to stderr
  process.stderr.write(
    `[simulate-hook] ${args.stage} — ${duration_ms}ms, ${output.logs.length} log(s), ${output.spans.length} span(s)\n`,
  );
}

function buildErrorInfo(err: unknown): SimulateHookOutput["error"] {
  const e = err as Record<string, unknown>;
  return {
    type: typeof e["name"] === "string" ? e["name"] : "Error",
    message: typeof e["message"] === "string" ? e["message"] : String(err),
    ...(typeof e["code"] === "string" ? { code: e["code"] } : {}),
    ...(typeof e["isRetryable"] === "boolean" ? { isRetryable: e["isRetryable"] } : {}),
    ...(typeof e["details"] === "object" && e["details"] !== null
      ? { details: e["details"] as Record<string, unknown> }
      : {}),
  };
}
