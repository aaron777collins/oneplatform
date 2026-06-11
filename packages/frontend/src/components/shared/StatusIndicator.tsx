/**
 * StatusIndicator — colored dot + text label for entity status display.
 *
 * Color is NEVER the sole indicator of status (§14.4). Each status also has
 * a text label, and optionally an icon. This satisfies WCAG 1.4.1 (Use of Color).
 */
import * as React from "react";
import { cn } from "@/lib/utils.js";

// ---------------------------------------------------------------------------
// Status type
// ---------------------------------------------------------------------------

export type StatusValue = "active" | "error" | "pending" | "disabled" | "warning" | "unknown";

interface StatusConfig {
  dotClass: string;
  label: string;
}

const STATUS_CONFIG: Record<StatusValue, StatusConfig> = {
  active: {
    dotClass: "bg-[var(--color-status-success)]",
    label: "Active",
  },
  error: {
    dotClass: "bg-[var(--color-status-error)]",
    label: "Error",
  },
  pending: {
    dotClass: "bg-[var(--color-status-warning)] animate-pulse",
    label: "Pending",
  },
  disabled: {
    dotClass: "bg-[var(--color-muted-foreground)]",
    label: "Disabled",
  },
  warning: {
    dotClass: "bg-[var(--color-status-warning)]",
    label: "Warning",
  },
  unknown: {
    dotClass: "bg-[var(--color-muted-foreground)]",
    label: "Unknown",
  },
};

// ---------------------------------------------------------------------------
// StatusIndicator component
// ---------------------------------------------------------------------------

export interface StatusIndicatorProps {
  status: StatusValue;
  /** Override the default label for the status. */
  label?: string;
  className?: string;
}

export function StatusIndicator({ status, label, className }: StatusIndicatorProps) {
  const config = STATUS_CONFIG[status];
  const displayLabel = label ?? config.label;

  return (
    <span
      className={cn("inline-flex items-center gap-1.5", className)}
      role="status"
    >
      <span
        className={cn("h-2 w-2 rounded-full shrink-0", config.dotClass)}
        aria-hidden="true"
      />
      <span className="text-sm">{displayLabel}</span>
    </span>
  );
}
