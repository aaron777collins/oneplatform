/**
 * RunStatusBadge — displays pipeline run status as a color-coded badge.
 * Color is supplemented by text labels per §14.4.
 */
import * as React from "react";
import { Badge } from "@/components/ui/badge.js";
import { cn } from "@/lib/utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RunStatus = "queued" | "running" | "success" | "failed" | "cancelled";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const STATUS_LABELS: Record<RunStatus, string> = {
  queued: "Queued",
  running: "Running",
  success: "Success",
  failed: "Failed",
  cancelled: "Cancelled",
};

const STATUS_CLASSES: Record<RunStatus, string> = {
  queued:
    "border-transparent bg-[var(--color-muted)] text-[var(--color-muted-foreground)]",
  running:
    "border-transparent bg-[var(--color-status-warning)]/20 text-[var(--color-status-warning)]",
  success:
    "border-transparent bg-[var(--color-status-success)]/20 text-[var(--color-status-success)]",
  failed:
    "border-transparent bg-[var(--color-destructive)]/20 text-[var(--color-destructive)]",
  cancelled:
    "border-transparent bg-[var(--color-muted)] text-[var(--color-muted-foreground)]",
};

// ---------------------------------------------------------------------------
// RunStatusBadge component
// ---------------------------------------------------------------------------

export interface RunStatusBadgeProps {
  status: RunStatus;
  className?: string;
}

export function RunStatusBadge({ status, className }: RunStatusBadgeProps) {
  return (
    <Badge
      className={cn(STATUS_CLASSES[status], className)}
      role="status"
    >
      {status === "running" && (
        <span
          className="mr-1 inline-block h-2 w-2 animate-pulse rounded-full bg-[var(--color-status-warning)]"
          aria-hidden="true"
        />
      )}
      {STATUS_LABELS[status]}
    </Badge>
  );
}
