/**
 * usage command group — API usage statistics and rate limit quotas.
 * Scope: none required for own-tenant usage; admin scope for cross-tenant.
 */
import type { Command } from "commander";
import { withContext } from "../../lib/context.js";
import type { CommandContext } from "../../lib/context.js";

// ─── API response shapes ───────────────────────────────────────────────────────

interface UsageStats {
  /** Total API calls made in the current billing period. */
  apiCallCount: number;
  /** Storage consumed across all data stores, in bytes. */
  storageBytes: number;
  /** Bytes ingested through connectors in the current period. */
  ingestedBytes: number;
  /** Number of pipeline runs executed in the current period. */
  pipelineRuns: number;
  /** ISO-8601 start of the current billing period. */
  periodStart: string;
  /** ISO-8601 end of the current billing period. */
  periodEnd: string;
}

interface UsageLimits {
  /** Maximum API calls allowed per minute for the tenant. */
  reqPerMinTenant: number;
  /** Maximum API calls allowed per minute per API key. */
  reqPerMinApiKey: number;
  /** Burst multiplier applied to the per-minute limits for short spikes. */
  burstMultiplier: number;
  /** Duration in seconds that burst allowance applies. */
  burstDurationSec: number;
  /** Maximum storage in bytes (null = unlimited). */
  maxStorageBytes: number | null;
  /** Maximum pipeline runs per day (null = unlimited). */
  maxPipelineRunsPerDay: number | null;
  /** Subscription tier name (e.g. "standard", "enterprise"). */
  tier: string;
}

// ─── Formatting helpers ────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
}

function formatLimit(value: number | null): string {
  return value === null ? "unlimited" : value.toLocaleString();
}

// ─── Action handlers ───────────────────────────────────────────────────────────

async function statsAction(_opts: Record<string, never>, ctx: CommandContext): Promise<void> {
  const stats = await ctx.http.get<UsageStats>("/api/v1/usage/stats");

  const STATS_COLUMNS = [
    { header: "Metric", key: "metric" },
    { header: "Value", key: "value" },
  ];

  const rows = [
    { metric: "API calls (period)", value: stats.apiCallCount.toLocaleString() },
    { metric: "Storage used",       value: formatBytes(stats.storageBytes) },
    { metric: "Data ingested",      value: formatBytes(stats.ingestedBytes) },
    { metric: "Pipeline runs",      value: stats.pipelineRuns.toLocaleString() },
    { metric: "Period start",       value: stats.periodStart },
    { metric: "Period end",         value: stats.periodEnd },
  ];

  ctx.renderer.render(rows, STATS_COLUMNS);
}

async function limitsAction(_opts: Record<string, never>, ctx: CommandContext): Promise<void> {
  const limits = await ctx.http.get<UsageLimits>("/api/v1/usage/limits");

  const LIMITS_COLUMNS = [
    { header: "Limit", key: "limit" },
    { header: "Value", key: "value" },
  ];

  const rows = [
    { limit: "Tier",                   value: limits.tier },
    { limit: "Req/min (tenant)",       value: limits.reqPerMinTenant.toLocaleString() },
    { limit: "Req/min (per API key)",  value: limits.reqPerMinApiKey.toLocaleString() },
    { limit: "Burst multiplier",       value: `${limits.burstMultiplier}×` },
    { limit: "Burst duration",         value: `${limits.burstDurationSec}s` },
    { limit: "Max storage",            value: formatLimit(limits.maxStorageBytes !== null ? limits.maxStorageBytes : null) },
    { limit: "Max pipeline runs/day",  value: formatLimit(limits.maxPipelineRunsPerDay) },
  ];

  ctx.renderer.render(rows, LIMITS_COLUMNS);
}

// ─── Registration ──────────────────────────────────────────────────────────────

export function registerUsage(program: Command): void {
  const usage = program.command("usage").description("API usage statistics and rate limit quotas");

  usage.command("stats")
    .description("Show API call count, storage used, and ingestion volume for the current billing period")
    .action(withContext<[Record<string, never>]>(statsAction));

  usage.command("limits")
    .description("Show rate limits and resource quotas for the current tenant tier")
    .action(withContext<[Record<string, never>]>(limitsAction));
}
