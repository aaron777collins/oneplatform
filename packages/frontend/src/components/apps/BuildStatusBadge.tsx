/**
 * BuildStatusBadge — visual indicator for a build's lifecycle state.
 *
 * Color is supplemented by text labels per §14.4 — color is never the sole differentiator.
 */
import * as React from "react";
import { Badge } from "@/components/ui/badge.js";
import { cn } from "@/lib/utils.js";

export type BuildStatus = "queued" | "building" | "success" | "failed" | "cancelled";

const STATUS_CLASSES: Record<BuildStatus, string> = {
  queued:
    "border-transparent bg-[var(--color-muted)] text-[var(--color-muted-foreground)]",
  building:
    "border-transparent bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  success:
    "border-transparent bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  failed:
    "border-transparent bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  cancelled:
    "border-transparent bg-[var(--color-muted)] text-[var(--color-muted-foreground)] opacity-75",
};

const STATUS_LABELS: Record<BuildStatus, string> = {
  queued: "Queued",
  building: "Building",
  success: "Success",
  failed: "Failed",
  cancelled: "Cancelled",
};

export interface BuildStatusBadgeProps {
  status: BuildStatus;
  className?: string;
}

export function BuildStatusBadge({ status, className }: BuildStatusBadgeProps) {
  return (
    <Badge
      className={cn(STATUS_CLASSES[status], className)}
      role="status"
      aria-label={`Build status: ${STATUS_LABELS[status]}`}
    >
      {status === "building" && (
        <span
          className="mr-1.5 h-2 w-2 animate-spin rounded-full border border-current border-t-transparent"
          aria-hidden="true"
        />
      )}
      {STATUS_LABELS[status]}
    </Badge>
  );
}
