/**
 * DLQJobDetail — expanded detail panel for a DLQ job.
 *
 * Shows: full error stack trace, original payload (JSON viewer), metadata.
 * Rendered inline below the selected table row or in a side panel.
 */
import * as React from "react";
import { AlertCircle, Clock, RefreshCw, ChevronDown } from "lucide-react";
import { RelativeTime } from "@/components/shared/RelativeTime.js";
import { CopyButton } from "@/components/shared/CopyButton.js";
import type { DLQJob } from "./DLQTable.js";

export interface DLQJobDetailProps {
  job: DLQJob;
  className?: string;
}

/** Extract a user-friendly summary from an error message (first sentence / line). */
function summarizeError(message: string): string {
  // Take the first line / sentence, up to 200 chars
  const firstLine = (message.split("\n")[0] ?? message).trim();
  const firstSentence = firstLine.split(/(?<=\.)\s/)[0] ?? firstLine;
  const summary = firstSentence.length < firstLine.length ? firstSentence : firstLine;
  return summary.length > 200 ? summary.slice(0, 197) + "..." : summary;
}

export function DLQJobDetail({ job, className }: DLQJobDetailProps) {
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

  return (
    <div className={className}>
      <div className="grid gap-4 md:grid-cols-2">
        {/* Error details */}
        <section>
          <div className="mb-2 flex items-center gap-2">
            <AlertCircle className="h-4 w-4 text-[var(--color-destructive)]" aria-hidden="true" />
            <h3 className="text-sm font-semibold">Error</h3>
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
          <h3 className="mb-2 text-sm font-semibold">Metadata</h3>
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
