/**
 * RunDetailPage — single pipeline run detail page with SSE log streaming.
 * Route: /pipeline-runs/$runId
 */
import React from "react";
import { useParams, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.js";
import { Skeleton } from "@/components/ui/skeleton.js";
import { PageHeader } from "@/components/layout/PageHeader.js";
import { EmptyState } from "@/components/shared/EmptyState.js";
import { RelativeTime } from "@/components/shared/RelativeTime.js";
import { RunStatusBadge } from "@/components/pipelines/RunStatusBadge.js";
import { RunLogViewer } from "@/components/pipelines/RunLogViewer.js";
import { useApiClient, type ApiResponse, ApiError } from "@/lib/api-client.js";
import { toast } from "@/hooks/use-toast.js";
import type { RunStatus } from "@/components/pipelines/RunStatusBadge.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RunDetail {
  id: string;
  pipelineId: string;
  pipelineName: string;
  status: RunStatus;
  triggeredBy: string;
  startedAt: string;
  completedAt?: string;
  error?: string;
}

// The pipeline service returns raw DB rows wrapped as
// { data: { run, steps, durationMs } } with snake_case fields and DB-native
// status values ("pending"/"completed"). Normalize that into the RunDetail
// shape the UI renders. Tolerant of both wrapped and flat, snake and camel
// payloads so the page never crashes on an unexpected response shape.
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

function normalizeRunDetail(raw: unknown, fallbackId: string): RunDetail | undefined {
  if (raw === null || typeof raw !== "object") return undefined;

  // Unwrap { run, steps, durationMs } if present, otherwise treat as the run itself.
  const container = raw as Record<string, unknown>;
  const source = (container["run"] && typeof container["run"] === "object"
    ? container["run"]
    : container) as Record<string, unknown>;

  const rawStatus = String(pick(source, "status") ?? "pending").toLowerCase();
  const status = DB_STATUS_TO_UI[rawStatus] ?? "queued";

  // error may be a string or a structured object ({ message, code, ... }).
  const rawError = pick(source, "error");
  let error: string | undefined;
  if (typeof rawError === "string" && rawError.length > 0) {
    error = rawError;
  } else if (rawError !== undefined && typeof rawError === "object") {
    const message = (rawError as Record<string, unknown>)["message"];
    error = typeof message === "string" ? message : JSON.stringify(rawError);
  }

  const completedAt = pick(source, "completedAt", "completed_at");
  const pipelineName = pick(source, "pipelineName", "pipeline_name");

  return {
    id: String(pick(source, "id") ?? fallbackId),
    pipelineId: String(pick(source, "pipelineId", "pipeline_id") ?? ""),
    pipelineName: typeof pipelineName === "string" && pipelineName.length > 0
      ? pipelineName
      : "Pipeline",
    status,
    triggeredBy: String(pick(source, "triggeredBy", "triggered_by") ?? "manual"),
    startedAt: String(pick(source, "startedAt", "started_at", "created_at") ?? ""),
    ...(typeof completedAt === "string" ? { completedAt } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

// ---------------------------------------------------------------------------
// Friendly trigger labels
// ---------------------------------------------------------------------------

const TRIGGER_LABELS: Record<string, string> = {
  manual: "Manual trigger",
  schedule: "Scheduled run",
  cron: "Scheduled (cron)",
  webhook: "Webhook trigger",
  api: "API call",
  event: "Event-driven",
  retry: "Automatic retry",
  system: "System trigger",
  user: "User-initiated",
};

function getFriendlyTrigger(raw: string): string {
  return TRIGGER_LABELS[raw.toLowerCase()] ?? raw.charAt(0).toUpperCase() + raw.slice(1);
}

// ---------------------------------------------------------------------------
// Error classification for run errors
// ---------------------------------------------------------------------------

interface ClassifiedRunError {
  category: string;
  title: string;
  suggestion: string;
}

function classifyRunError(error: string): ClassifiedRunError {
  const lower = error.toLowerCase();

  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("deadline")) {
    return {
      category: "Timeout",
      title: "Execution timed out",
      suggestion: "Consider increasing the timeout limit or optimizing the step that timed out.",
    };
  }
  if (lower.includes("permission") || lower.includes("forbidden") || lower.includes("unauthorized") || lower.includes("access denied")) {
    return {
      category: "Permission",
      title: "Permission denied",
      suggestion: "Check that the pipeline's service account has the required permissions for all connected resources.",
    };
  }
  if (lower.includes("connection") || lower.includes("network") || lower.includes("econnrefused") || lower.includes("enotfound")) {
    return {
      category: "Connection",
      title: "Connection failed",
      suggestion: "Check if the data source is accessible and that your network settings allow the connection.",
    };
  }
  if (lower.includes("syntax") || lower.includes("parse") || lower.includes("unexpected token") || lower.includes("invalid")) {
    return {
      category: "Validation",
      title: "Validation or syntax error",
      suggestion: "Review the pipeline step configuration for syntax errors or invalid data.",
    };
  }
  if (lower.includes("memory") || lower.includes("oom") || lower.includes("heap")) {
    return {
      category: "Resource",
      title: "Out of memory",
      suggestion: "The pipeline ran out of memory. Try processing data in smaller batches or increasing resource limits.",
    };
  }
  return {
    category: "Error",
    title: "Execution failed",
    suggestion: "View error details below to learn more about what went wrong.",
  };
}

// ---------------------------------------------------------------------------
// Run number helper — derive a short run number from the run ID
// ---------------------------------------------------------------------------

function formatRunNumber(runId: string): string {
  // Use the first 8 hex chars as a short identifier
  return `#${runId.slice(0, 8).toUpperCase()}`;
}

// ---------------------------------------------------------------------------
// Duration helper
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// RunDetailPage component
// ---------------------------------------------------------------------------

export function RunDetailPage() {
  const { runId } = useParams({ from: "/authenticated/pipeline-runs/$runId" });
  const client = useApiClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const { data, isLoading, isError } = useQuery({
    queryKey: ["pipeline-runs", runId],
    queryFn: () =>
      client
        .get<ApiResponse<unknown>>(`/v1/pipeline-runs/${runId}`)
        .then((res) => normalizeRunDetail(res.data, runId)),
    // Refresh every 5s while run is still active
    refetchInterval: (query) => {
      const run = query.state.data;
      if (run === undefined) return false;
      return run.status === "running" || run.status === "queued" ? 5000 : false;
    },
  });

  const cancelRun = useMutation({
    mutationFn: () => client.post<void>(`/v1/pipeline-runs/${runId}/cancel`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["pipeline-runs", runId] });
      toast({ title: "Run cancelled" });
    },
    onError: (err) => {
      const message = err instanceof ApiError ? err.message : "Failed to cancel run";
      toast({ title: message, variant: "destructive" });
    },
  });

  const run = data;

  if (isError) {
    return (
      <div className="flex-1 p-6">
        <EmptyState
          title="Run not found"
          actionLabel="Back to pipelines"
          onAction={() => void navigate({ to: "/pipelines" })}
        />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <PageHeader
        title={run ? `${run.pipelineName} ${formatRunNumber(runId)}` : `Run ${formatRunNumber(runId)}`}
        breadcrumbs={[
          { label: "Platform" },
          { label: "Pipelines", href: "/pipelines" },
          ...(run !== undefined
            ? [{ label: run.pipelineName, href: `/pipelines/${run.pipelineId}` }]
            : []),
          { label: "Run" },
        ]}
        actions={
          run?.status === "running" || run?.status === "queued" ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => cancelRun.mutate()}
              disabled={cancelRun.isPending}
              className="text-[var(--color-destructive)]"
            >
              <X className="h-4 w-4" aria-hidden />
              Cancel run
            </Button>
          ) : undefined
        }
      />

      <div className="p-6 space-y-4">
        {isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        ) : run !== undefined ? (
          <>
            {/* Run metadata */}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-xs font-medium text-[var(--color-muted-foreground)] uppercase tracking-wide">
                    Status
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <RunStatusBadge status={run.status} />
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-xs font-medium text-[var(--color-muted-foreground)] uppercase tracking-wide">
                    Triggered by
                  </CardTitle>
                </CardHeader>
                <CardContent className="text-sm">{getFriendlyTrigger(run.triggeredBy)}</CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-xs font-medium text-[var(--color-muted-foreground)] uppercase tracking-wide">
                    Started
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <RelativeTime value={run.startedAt} className="text-sm" />
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-xs font-medium text-[var(--color-muted-foreground)] uppercase tracking-wide">
                    Duration
                  </CardTitle>
                </CardHeader>
                <CardContent className="text-sm">
                  {formatDuration(run.startedAt, run.completedAt)}
                </CardContent>
              </Card>
            </div>

            {/* Error message — categorized with actionable suggestions */}
            {run.error !== undefined && (() => {
              const classified = classifyRunError(run.error);
              return (
                <div
                  className="rounded-md border border-[var(--color-destructive)]/30 bg-[var(--color-destructive)]/10 px-4 py-3"
                  role="alert"
                >
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-[var(--color-destructive)]/20 px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-destructive)] uppercase tracking-wide">
                      {classified.category}
                    </span>
                    <p className="text-sm font-semibold text-[var(--color-destructive)]">{classified.title}</p>
                  </div>
                  <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">{run.error}</p>
                  <p className="mt-1.5 text-xs text-[var(--color-muted-foreground)] italic">{classified.suggestion}</p>
                </div>
              );
            })()}

            {/* Log viewer */}
            <div>
              <h2 className="mb-3 text-sm font-semibold">Logs</h2>
              <RunLogViewer runId={runId} height={500} />
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
