/**
 * ConnectorStatusBadge — displays connector sync status as a color-coded badge.
 * Color is never the sole indicator; text label always accompanies the color (§14.4).
 */
import * as React from "react";
import { Badge } from "@/components/ui/badge.js";
import { cn } from "@/lib/utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConnectorStatus = "active" | "syncing" | "error" | "disabled";

// ---------------------------------------------------------------------------
// ConnectorStatusBadge component
// ---------------------------------------------------------------------------

const STATUS_LABELS: Record<ConnectorStatus, string> = {
  active: "Active",
  syncing: "Syncing",
  error: "Error",
  disabled: "Disabled",
};

const STATUS_CLASSES: Record<ConnectorStatus, string> = {
  active:
    "border-transparent bg-[var(--color-status-success)]/20 text-[var(--color-status-success)] hover:bg-[var(--color-status-success)]/30",
  syncing:
    "border-transparent bg-[var(--color-status-warning)]/20 text-[var(--color-status-warning)] hover:bg-[var(--color-status-warning)]/30",
  error:
    "border-transparent bg-[var(--color-destructive)]/20 text-[var(--color-destructive)] hover:bg-[var(--color-destructive)]/30",
  disabled:
    "border-transparent bg-[var(--color-muted)] text-[var(--color-muted-foreground)] hover:bg-[var(--color-muted)]/80",
};

export interface ConnectorStatusBadgeProps {
  status: ConnectorStatus;
  className?: string;
}

export function ConnectorStatusBadge({ status, className }: ConnectorStatusBadgeProps) {
  return (
    <Badge
      className={cn(STATUS_CLASSES[status], className)}
      role="status"
    >
      {STATUS_LABELS[status]}
    </Badge>
  );
}
