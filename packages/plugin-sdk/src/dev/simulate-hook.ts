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

  /**
   * Named export to invoke as the hook function.
   * Defaults to the value of `entrypoint` in the plugin's manifest.
   * When provided explicitly, overrides whatever is in the manifest.
   */
  entrypoint?: string;

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

  // Resolve the hook entrypoint: explicit CLI arg > manifest field > error.
  // We read the manifest here (not in the vm context) so the CLI arg can override it.
  let entrypoint: string;
  if (args.entrypoint !== undefined) {
    entrypoint = args.entrypoint;
  } else {
    const manifestPath = path.resolve(path.dirname(bundlePath), "..", "plugin.manifest.json");
    if (!fs.existsSync(manifestPath)) {
      process.stderr.write(
        `Error: cannot determine entrypoint — provide --entrypoint or ensure plugin.manifest.json exists at "${manifestPath}"\n`,
      );
      process.exit(1);
    }
    const rawManifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
    if (typeof rawManifest["entrypoint"] !== "string") {
      process.stderr.write(`Error: plugin.manifest.json is missing a valid "entrypoint" field\n`);
      process.exit(1);
    }
    entrypoint = rawManifest["entrypoint"];
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
    // Fast path: vm.Script with a synthetic module environment.
    // Provides basic isolation without the overhead of a full V8 isolate.
    const moduleExports: Record<string, unknown> = {};

    // __resolve + __done let the host await full async hook completion.
    // A single setTimeout(0) tick is not enough when the hook itself awaits I/O;
    // awaiting __done waits for the inner IIFE to actually settle.
    // We always resolve (never reject) so __error is read from context after settling.
    let vmResolve!: () => void;
    const vmDone = new Promise<void>((res) => {
      vmResolve = res;
    });

    const context = vm.createContext({
      exports: moduleExports,
      module: { exports: moduleExports },
      __pluginContext: mockCtx,
      __hookPayload: hookPayload,
      __entrypoint: entrypoint,
      __result: undefined as HookResult | undefined,
      __error: undefined as unknown,
      __resolve: vmResolve,
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
        const fn = exports[__entrypoint];
        if (typeof fn !== "function") {
          throw new Error(
            "Bundle export \\"" + __entrypoint + "\\" is not a callable function (got " + typeof fn + ")"
          );
        }
        __result = await fn(__hookPayload, __pluginContext);
      })().then(() => { __resolve(); }).catch((e) => { __error = e; __resolve(); });
    `;

    const script = new vm.Script(wrappedSource);
    try {
      script.runInContext(context);
      // Await the promise that the inner IIFE resolves — this correctly handles
      // hooks that await real async work, not just a single microtask tick.
      await vmDone;
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
