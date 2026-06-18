/**
 * StatusBadge — colored pill for entity lifecycle states.
 *
 * Predefined status→color mappings cover the common platform states. Callers
 * can pass an arbitrary `status` string plus an explicit `color` override for
 * domain-specific statuses not covered by the default map.
 *
 * Color is NEVER the sole differentiator — the status label is always visible
 * (§14.4 accessibility requirement).
 */

import * as React from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PredefinedStatus =
  | "active"
  | "inactive"
  | "error"
  | "warning"
  | "pending";

export type StatusColor = "green" | "gray" | "red" | "yellow" | "blue";

export interface StatusBadgeProps {
  status: PredefinedStatus | string;
  /**
   * Explicit color override. When absent, the component falls back to the
   * `PREDEFINED_COLORS` map and then to "gray" for unknown statuses.
   */
  color?: StatusColor;
  className?: string;
}

// ---------------------------------------------------------------------------
// Color definitions
// ---------------------------------------------------------------------------

const PREDEFINED_COLORS: Record<PredefinedStatus, StatusColor> = {
  active: "green",
  inactive: "gray",
  error: "red",
  warning: "yellow",
  pending: "blue",
};

const COLOR_CLASSES: Record<StatusColor, string> = {
  green:
    "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  gray:
    "bg-[var(--color-muted,#f3f4f6)] text-[var(--color-muted-foreground,#6b7280)]",
  red:
    "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  yellow:
    "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
  blue:
    "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
};

// ---------------------------------------------------------------------------
// StatusBadge component
// ---------------------------------------------------------------------------

export function StatusBadge({ status, color, className }: StatusBadgeProps) {
  const resolvedColor: StatusColor =
    color ??
    PREDEFINED_COLORS[status as PredefinedStatus] ??
    "gray";

  const colorClass = COLOR_CLASSES[resolvedColor];
  // Capitalise the status for display so raw API values like "active" render
  // as "Active" without requiring callers to pre-format.
  const label = status.charAt(0).toUpperCase() + status.slice(1);

  return (
    <span
      role="status"
      aria-label={`Status: ${label}`}
      className={[
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
        colorClass,
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {label}
    </span>
  );
}
