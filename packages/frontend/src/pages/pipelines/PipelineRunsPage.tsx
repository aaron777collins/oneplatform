/**
 * PipelineRunsPage — cross-pipeline run history list.
 * Route: /pipeline-runs
 *
 * Lists runs across all pipelines, newest first. Each row links to the run
 * detail page. The list endpoint returns raw run rows (snake_case, no pipeline
 * name), so the page is tolerant of both snake_case and camelCase field names
 * and resolves the pipeline name from the cached pipelines list.
 */
import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input.js";
import { Skeleton } from "@/components/ui/skeleton.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { PageHeader } from "@/components/layout/PageHeader.js";
import { EmptyState } from "@/components/shared/EmptyState.js";
import { RelativeTime } from "@/components/shared/RelativeTime.js";
import { RunStatusBadge, type RunStatus } from "@/components/pipelines/RunStatusBadge.js";
import { useApiClient, type PaginatedResponse } from "@/lib/api-client.js";

// ---------------------------------------------------------------------------
// API types — the list endpoint returns raw run rows. Field casing varies
// (snake_case from the DB, camelCase in the OpenAPI contract), so the row is
// read tolerantly below.
// ---------------------------------------------------------------------------

interface PipelineRow {
  id: string;
  name: string;
}

interface PipelineListItem {
  pipeline: PipelineRow;
}

// Map DB-native / contract status values onto the badge's UI status set.
const DB_STATUS_TO_UI: Record<string, RunStatus> = {
  pending: "queued",
  queued: "queued",
  running: "running",
  completed: "success",
  success: "success",
  failed: "failed",
  cancelled: "cancelled",
};

function pick(obj: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = obj[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

interface RunListRow {
  id: string;
  pipelineId: string;
  status: RunStatus;
  triggeredBy: string;
  startedAt: string;
  completedAt?: string;
}

function normalizeRun(raw: unknown): RunListRow | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const source = raw as Record<string, unknown>;

  const id = pick(source, "id");
  if (typeof id !== "string" || id.length === 0) return undefined;

  const rawStatus = String(pick(source, "status") ?? "pending").toLowerCase();
  const completedAt = pick(source, "completedAt", "completed_at");

  return {
    id,
    pipelineId: String(pick(source, "pipelineId", "pipeline_id") ?? ""),
    status: DB_STATUS_TO_UI[rawStatus] ?? "queued",
    triggeredBy: String(pick(source, "triggeredBy", "triggered_by") ?? "manual"),
    startedAt: String(pick(source, "startedAt", "started_at", "createdAt", "created_at") ?? ""),
    ...(typeof completedAt === "string" && completedAt.length > 0 ? { completedAt } : {}),
  };
}

// Human-readable run duration. While a run is still active (no completedAt) the
// elapsed time is measured against now, matching the run detail page.
function formatDuration(startedAt: string, completedAt?: string): string {
  const start = new Date(startedAt).getTime();
  if (Number.isNaN(start)) return "—";
  const end = completedAt !== undefined ? new Date(completedAt).getTime() : Date.now();
  const diffMs = end - start;
  if (Number.isNaN(diffMs) || diffMs < 0) return "—";

  const seconds = Math.round(diffMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes < 60) return `${minutes}m ${secs}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m`;
}

const STATUS_FILTER_OPTIONS: Array<{ value: RunStatus | "all"; label: string }> = [
  { value: "all", label: "All statuses" },
  { value: "queued", label: "Queued" },
  { value: "running", label: "Running" },
  { value: "success", label: "Success" },
  { value: "failed", label: "Failed" },
  { value: "cancelled", label: "Cancelled" },
];

// ---------------------------------------------------------------------------
// PipelineRunsPage component
// ---------------------------------------------------------------------------

export function PipelineRunsPage() {
  const client = useApiClient();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<RunStatus | "all">("all");

  const runsQuery = useQuery({
    queryKey: ["pipeline-runs", "list"],
    queryFn: () =>
      client.get<PaginatedResponse<unknown>>("/v1/pipeline-runs?limit=100&sort=-startedAt"),
    // Poll while any run may still be active so the list stays fresh.
    refetchInterval: 10_000,
  });

  // Reuse the pipelines list (shared cache key with PipelinesPage) to resolve
  // pipeline names, since the run rows only carry pipeline IDs.
  const pipelinesQuery = useQuery({
    queryKey: ["pipelines"],
    queryFn: () => client.get<PaginatedResponse<PipelineListItem>>("/v1/pipelines"),
  });

  const nameById = new Map<string, string>();
  for (const item of pipelinesQuery.data?.data ?? []) {
    if (item?.pipeline?.id) nameById.set(item.pipeline.id, item.pipeline.name);
  }

  const runs: RunListRow[] = (runsQuery.data?.data ?? [])
    .map(normalizeRun)
    .filter((r): r is RunListRow => r !== undefined);

  const query = search.trim().toLowerCase();
  const filtered = runs.filter((run) => {
    if (statusFilter !== "all" && run.status !== statusFilter) return false;
    if (query.length === 0) return true;
    const name = nameById.get(run.pipelineId) ?? "";
    return name.toLowerCase().includes(query) || run.id.toLowerCase().includes(query);
  });

  return (
    <div className="flex-1 overflow-y-auto">
      <PageHeader
        title="Pipeline runs"
        breadcrumbs={[
          { label: "Platform" },
          { label: "Pipelines", href: "/pipelines" },
          { label: "Runs" },
        ]}
      />

      <div className="p-6 space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative max-w-sm flex-1 min-w-48">
            <Search
              className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-muted-foreground)]"
              aria-hidden
            />
            <Input
              className="pl-9"
              placeholder="Search runs…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search runs"
            />
          </div>
          <Select
            value={statusFilter}
            onValueChange={(value) => setStatusFilter(value as RunStatus | "all")}
          >
            <SelectTrigger className="w-40" aria-label="Filter by status">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              {STATUS_FILTER_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {runsQuery.isError ? (
          <EmptyState
            title="Failed to load runs"
            actionLabel="Retry"
            onAction={() => void runsQuery.refetch()}
          />
        ) : runsQuery.isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            title={runs.length === 0 ? "No pipeline runs yet" : "No runs match your filters"}
            description={
              runs.length === 0
                ? "Runs appear here once you trigger a pipeline."
                : "Try a different search term or status filter."
            }
          />
        ) : (
          <div className="overflow-hidden rounded-lg border border-[var(--color-border)]">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] bg-[var(--color-muted)]/40 text-left text-xs uppercase tracking-wide text-[var(--color-muted-foreground)]">
                  <th className="px-4 py-2.5 font-medium">Pipeline</th>
                  <th className="px-4 py-2.5 font-medium">Run</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 font-medium">Started</th>
                  <th className="px-4 py-2.5 font-medium">Duration</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((run) => (
                  <tr
                    key={run.id}
                    className="cursor-pointer border-b border-[var(--color-border)] last:border-b-0 hover:bg-[var(--color-muted)]/40"
                    onClick={() =>
                      void navigate({ to: "/pipeline-runs/$runId", params: { runId: run.id } })
                    }
                  >
                    <td className="px-4 py-3 font-medium">
                      {nameById.get(run.pipelineId) ?? "Pipeline"}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-[var(--color-muted-foreground)]">
                      #{run.id.slice(0, 8).toUpperCase()}
                    </td>
                    <td className="px-4 py-3">
                      <RunStatusBadge status={run.status} />
                    </td>
                    <td className="px-4 py-3 text-[var(--color-muted-foreground)]">
                      {run.startedAt ? <RelativeTime value={run.startedAt} /> : "—"}
                    </td>
                    <td className="px-4 py-3 text-[var(--color-muted-foreground)]">
                      {run.startedAt ? formatDuration(run.startedAt, run.completedAt) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
