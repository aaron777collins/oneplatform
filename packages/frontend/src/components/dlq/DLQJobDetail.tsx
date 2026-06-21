/**
 * DLQJobDetail — expanded detail panel for a DLQ job.
 *
 * Shows: full error stack trace, original payload (JSON viewer), metadata,
 * error category badge, and an inline Retry button.
 * Rendered inline below the selected table row or in a side panel.
 */
import * as React from "react";
import { AlertCircle, Clock, RefreshCw, ChevronDown } from "lucide-react";
import { RelativeTime } from "@/components/shared/RelativeTime.js";
import { CopyButton } from "@/components/shared/CopyButton.js";
import { Button } from "@/components/ui/button.js";
import { Badge } from "@/components/ui/badge.js";
import type { DLQJob } from "./DLQTable.js";

export interface DLQJobDetailProps {
  job: DLQJob;
  /** Called when the user clicks the Retry button inside the detail panel. */
  onRetry?: (jobId: string) => void;
  isRetrying?: boolean;
  className?: string;
}

// ---------------------------------------------------------------------------
// Error category inference
// ---------------------------------------------------------------------------

type ErrorCategory = "validation" | "timeout" | "system" | "network" | "unknown";

/**
 * Infers an error category from the error message string.
 * This is intentionally heuristic — it gives operators a fast visual signal
 * without requiring the job producer to attach structured metadata.
 */
function inferErrorCategory(message: string): ErrorCategory {
  const lower = message.toLowerCase();
  if (/timeout|timed?\s*out|deadline/i.test(lower)) return "timeout";
  if (/validat|invalid|schema|required|missing field|parse error|bad request/i.test(lower)) return "validation";
  if (/network|econnrefused|enotfound|econnreset|socket|dns/i.test(lower)) return "network";
  if (/error|exception|internal|crash|fatal|oops/i.test(lower)) return "system";
  return "unknown";
}

const CATEGORY_BADGE_VARIANT: Record<ErrorCategory, "destructive" | "outline" | "secondary"> = {
  validation: "destructive",
  timeout: "outline",
  system: "destructive",
  network: "outline",
  unknown: "secondary",
};

const CATEGORY_LABEL: Record<ErrorCategory, string> = {
  validation: "Validation",
  timeout: "Timeout",
  system: "System Error",
  network: "Network",
  unknown: "Unknown",
};

/** Extract a user-friendly summary from an error message (first sentence / line). */
function summarizeError(message: string): string {
  // Take the first line / sentence, up to 200 chars
  const firstLine = (message.split("\n")[0] ?? message).trim();
  const firstSentence = firstLine.split(/(?<=\.)\s/)[0] ?? firstLine;
  const summary = firstSentence.length < firstLine.length ? firstSentence : firstLine;
  return summary.length > 200 ? summary.slice(0, 197) + "..." : summary;
}

export function DLQJobDetail({ job, onRetry, isRetrying = false, className }: DLQJobDetailProps) {
  const [showStack, setShowStack] = React.useState(false);
  const payloadString = React.useMemo(() => {
    try {
      return JSON.stringify(job.payload, null, 2);
    } catch {
      return String(job.payload);
    }
  }, [job.payload]);

  const errorSummary = summarizeError(job.errorMessage);
  const hasFullMessage = errorSummary !== job.errorMessage;
  const errorCategory = inferErrorCategory(job.errorMessage);

  return (
    <div className={className}>
      <div className="grid gap-4 md:grid-cols-2">
        {/* Error details */}
        <section>
          <div className="mb-2 flex items-center gap-2">
            <AlertCircle className="h-4 w-4 text-[var(--color-destructive)]" aria-hidden="true" />
            <h3 className="text-sm font-semibold">Error</h3>
            <Badge variant={CATEGORY_BADGE_VARIANT[errorCategory]} className="text-[10px] py-0 px-1.5">
              {CATEGORY_LABEL[errorCategory]}
            </Badge>
          </div>

          {/* User-friendly summary */}
          <div className="rounded-md bg-red-50 dark:bg-red-950/20 p-3 text-sm text-red-800 dark:text-red-300">
            <p className="font-medium">{errorSummary}</p>
            {hasFullMessage && (
              <p className="mt-1 text-xs text-red-700/80 dark:text-red-400/80">
                {job.errorMessage}
              </p>
            )}
          </div>

          {/* Stack trace — hidden by default behind a toggle */}
          {job.errorStack !== undefined && (
            <div className="mt-2">
              <button
                type="button"
                onClick={() => setShowStack((v) => !v)}
                className="flex items-center gap-1 text-xs text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)] transition-colors"
                aria-expanded={showStack}
              >
                <ChevronDown
                  className={`h-3 w-3 transition-transform ${showStack ? "rotate-180" : ""}`}
                  aria-hidden="true"
                />
                {showStack ? "Hide" : "Show"} stack trace
              </button>
              {showStack && (
                <pre className="mt-1 rounded-md bg-red-50 dark:bg-red-950/20 p-3 text-xs font-mono text-red-700/80 dark:text-red-400/80 whitespace-pre-wrap max-h-48 overflow-y-auto">
                  {job.errorStack}
                </pre>
              )}
            </div>
          )}
        </section>

        {/* Metadata */}
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold">Metadata</h3>
            {onRetry !== undefined && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => onRetry(job.id)}
                disabled={isRetrying}
                aria-busy={isRetrying}
                aria-label="Retry this job"
                className="h-7 text-xs"
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 mr-1 ${isRetrying ? "animate-spin" : ""}`}
                  aria-hidden="true"
                />
                {isRetrying ? "Retrying…" : "Retry"}
              </Button>
            )}
          </div>
          <dl className="space-y-2 text-sm">
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 text-[var(--color-muted-foreground)]">Job ID</dt>
              <dd className="font-mono text-xs break-all">{job.id}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 text-[var(--color-muted-foreground)]">Queue</dt>
              <dd className="font-mono text-xs">{job.queueName}</dd>
            </div>
            <div className="flex items-center gap-2">
              <dt className="w-24 shrink-0 text-[var(--color-muted-foreground)]">Failed</dt>
              <dd className="flex items-center gap-1 text-xs">
                <Clock className="h-3.5 w-3.5 text-[var(--color-muted-foreground)]" aria-hidden="true" />
                <RelativeTime value={job.failedAt} />
              </dd>
            </div>
            <div className="flex items-center gap-2">
              <dt className="w-24 shrink-0 text-[var(--color-muted-foreground)]">Retries</dt>
              <dd className="flex items-center gap-1 text-xs">
                <RefreshCw className="h-3.5 w-3.5 text-[var(--color-muted-foreground)]" aria-hidden="true" />
                {job.retryCount}
              </dd>
            </div>
          </dl>
        </section>
      </div>

      {/* Original payload */}
      <section className="mt-4">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Original payload</h3>
          <CopyButton value={payloadString} label="Copy payload" size="sm" />
        </div>
        <pre className="max-h-64 overflow-y-auto rounded-md bg-[var(--color-muted)] p-3 text-xs font-mono text-[var(--color-foreground)]">
          {payloadString}
        </pre>
      </section>
    </div>
  );
}
