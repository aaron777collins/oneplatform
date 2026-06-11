/**
 * SyncProgressBar — visual progress bar for active sync jobs.
 *
 * Displays percentage complete and estimated time remaining (ETA).
 * Uses aria-valuenow / aria-valuemax for accessibility so screen readers
 * can announce progress without needing to read the visual bar.
 */
import * as React from "react";
import { cn } from "@/lib/utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SyncProgressBarProps {
  /** 0–100 inclusive */
  percent: number;
  /** ISO 8601 string or undefined when ETA is not yet available */
  estimatedCompletionAt?: string;
  /** Label describing what is being synced */
  label?: string;
  className?: string;
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function formatEta(isoString: string): string {
  const now = Date.now();
  const target = new Date(isoString).getTime();
  const diffMs = target - now;

  if (diffMs <= 0) return "finishing…";

  const seconds = Math.round(diffMs / 1000);
  if (seconds < 60) return `~${seconds}s remaining`;

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `~${minutes}m remaining`;

  const hours = Math.round(minutes / 60);
  return `~${hours}h remaining`;
}

// ---------------------------------------------------------------------------
// SyncProgressBar component
// ---------------------------------------------------------------------------

export function SyncProgressBar({
  percent,
  estimatedCompletionAt,
  label = "Syncing…",
  className,
}: SyncProgressBarProps) {
  const clampedPercent = Math.min(100, Math.max(0, percent));

  return (
    <div className={cn("space-y-1", className)}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-[var(--color-foreground)]">{label}</span>
        <span className="text-xs text-[var(--color-muted-foreground)]">
          {estimatedCompletionAt !== undefined
            ? formatEta(estimatedCompletionAt)
            : `${clampedPercent}%`}
        </span>
      </div>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-[var(--color-muted)]"
        role="progressbar"
        aria-valuenow={clampedPercent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div
          className="h-full rounded-full bg-[var(--color-primary)] transition-[width] duration-300 ease-in-out"
          style={{ width: `${clampedPercent}%` }}
        />
      </div>
    </div>
  );
}
