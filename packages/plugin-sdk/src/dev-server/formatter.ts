/**
 * Terminal output formatter for the dev server.
 *
 * All output goes to process.stderr so it can be separated from any
 * machine-readable JSON written to stdout (e.g., when piped to jq).
 *
 * Design principle: every formatter function is pure — it receives data and
 * writes to stderr. No state is held between calls. This makes the formatter
 * trivially testable by capturing stderr writes.
 */

import type { ConnectorRunSummary, LifecycleTiming } from "./types.js";

// ANSI color codes — checked for TTY support before use.
// We inline them rather than importing a color library to keep dev-server
// dependency-free (the plugin-sdk may not have chalk installed).
const COLORS = {
  reset:   "\x1b[0m",
  bold:    "\x1b[1m",
  dim:     "\x1b[2m",
  green:   "\x1b[32m",
  yellow:  "\x1b[33m",
  red:     "\x1b[31m",
  cyan:    "\x1b[36m",
  magenta: "\x1b[35m",
  gray:    "\x1b[90m",
} as const;

function color(code: keyof typeof COLORS, text: string): string {
  // Only emit escape codes when stderr is a real TTY — avoids polluting log
  // files or CI output with raw escape sequences.
  if (!process.stderr.isTTY) return text;
  return `${COLORS[code]}${text}${COLORS.reset}`;
}

function bold(text: string): string    { return color("bold",    text); }
function dim(text: string): string     { return color("dim",     text); }
function green(text: string): string   { return color("green",   text); }
function yellow(text: string): string  { return color("yellow",  text); }
function red(text: string): string     { return color("red",     text); }
function cyan(text: string): string    { return color("cyan",    text); }
function gray(text: string): string    { return color("gray",    text); }

const write = (line: string): void => { process.stderr.write(line + "\n"); };
const sep   = (): void => write(gray("─".repeat(60)));

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/** Print the dev server startup banner. */
export function printStartBanner(pluginDir: string): void {
  sep();
  write(bold(cyan("  OnePlatform Plugin Dev Server")));
  write(dim(`  Plugin directory: ${pluginDir}`));
  sep();
}

/** Print the reload banner shown when the watcher detects a file change. */
export function printReloadBanner(changedFile: string): void {
  write("");
  write(yellow(`  File changed: ${changedFile}`));
  write(yellow("  Reloading plugin..."));
  write("");
}

/** Print a short line indicating the lifecycle run is starting. */
export function printRunStart(pluginId: string): void {
  write("");
  write(bold(`Running connector: ${pluginId}`));
  write(dim("  metadata() → connect() → fetchBatch() loop → disconnect()"));
}

/** Print a timing line for a lifecycle method call. */
export function printTiming(timing: LifecycleTiming, extra?: string): void {
  const badge = timing.durationMs < 1000
    ? green(`${timing.durationMs}ms`)
    : yellow(`${timing.durationMs}ms`);
  const extraStr = extra !== undefined ? `  ${dim(extra)}` : "";
  write(`  ${cyan(timing.method.padEnd(12))} ${badge}${extraStr}`);
}

/**
 * Pretty-print the first batch of fetched records.
 * Subsequent batches are summarized to avoid flooding the terminal.
 */
export function printRecords(
  batchIndex: number,
  records: Array<Record<string, unknown>>,
): void {
  const label = `  Batch ${batchIndex + 1} — ${records.length} record(s)`;
  write(label);

  if (batchIndex === 0 && records.length > 0) {
    // Show the full first record so the developer can verify field shapes.
    const first = records[0];
    write(dim("    First record:"));
    const lines = JSON.stringify(first, null, 4).split("\n");
    for (const line of lines) {
      write(dim(`      ${line}`));
    }
  }
}

/** Print the run summary after the lifecycle completes. */
export function printRunSummary(summary: ConnectorRunSummary): void {
  write("");
  sep();

  if (summary.success) {
    write(bold(green("  Run complete")));
  } else {
    write(bold(red("  Run failed")));
  }

  write("");
  write(`  Plugin         ${dim(summary.manifest.id)}`);
  write(`  Version        ${dim(summary.manifest.version)}`);
  write(`  Total records  ${bold(String(summary.totalRecords))}`);
  write(`  Batches        ${bold(String(summary.batches.length))}`);
  write(`  Memory (heap)  ${dim(formatBytes(summary.peakHeapUsedBytes))}`);

  if (summary.timings.length > 0) {
    write("");
    write(bold("  Timings"));
    for (const timing of summary.timings) {
      printTiming(timing);
    }
  }

  if (summary.logs.length > 0) {
    write("");
    write(bold(`  Plugin logs (${summary.logs.length})`));
    for (const entry of summary.logs) {
      const levelColor =
        entry.level === "error" ? red(entry.level) :
        entry.level === "warn"  ? yellow(entry.level) :
        entry.level === "debug" ? gray(entry.level) :
        cyan(entry.level);
      const metaStr =
        entry.metadata !== undefined ? `  ${gray(JSON.stringify(entry.metadata))}` : "";
      write(`    [${levelColor}] ${entry.message}${metaStr}`);
    }
  }

  if (!summary.success && summary.error !== undefined) {
    write("");
    write(bold(red("  Error")));
    write(`    ${red(summary.error.name)}: ${summary.error.message}`);
    if (summary.error.code !== undefined) {
      write(`    Code:       ${summary.error.code}`);
    }
    if (summary.error.isRetryable !== undefined) {
      write(`    Retryable:  ${String(summary.error.isRetryable)}`);
    }
    if (summary.error.details !== undefined) {
      write(`    Details:    ${JSON.stringify(summary.error.details)}`);
    }
    if (summary.error.stack !== undefined) {
      write("");
      write(dim("  Stack trace:"));
      const stackLines = summary.error.stack.split("\n");
      for (const line of stackLines) {
        write(dim(`    ${line}`));
      }
    }
  }

  sep();
  write("");
}

/** Print the watch mode idle message. */
export function printWatching(pluginDir: string): void {
  write(dim(`  Watching "${pluginDir}" for changes. Press Ctrl+C to stop.`));
}

/** Print a fatal error that prevents the dev server from starting. */
export function printFatalError(message: string): void {
  write(red(`\nFatal: ${message}`));
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
