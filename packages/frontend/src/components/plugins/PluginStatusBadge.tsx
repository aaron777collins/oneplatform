/**
 * PluginStatusBadge — visual indicator for a plugin's lifecycle state.
 * Color is always paired with a text label for accessibility (§14.4).
 */
import * as React from "react";
import { Badge } from "@/components/ui/badge.js";
import { cn } from "@/lib/utils.js";

export type PluginStatus = "installed" | "active" | "disabled" | "error";

const STATUS_CLASSES: Record<PluginStatus, string> = {
  installed:
    "border-transparent bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  active:
    "border-transparent bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  disabled:
    "border-transparent bg-[var(--color-muted)] text-[var(--color-muted-foreground)]",
  error:
    "border-transparent bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
};

const STATUS_LABELS: Record<PluginStatus, string> = {
  installed: "Installed",
  active: "Active",
  disabled: "Disabled",
  error: "Error",
};

export interface PluginStatusBadgeProps {
  status: PluginStatus;
  className?: string;
}

export function PluginStatusBadge({ status, className }: PluginStatusBadgeProps) {
  return (
    <Badge
      className={cn(STATUS_CLASSES[status], className)}
      role="status"
      aria-label={`Plugin status: ${STATUS_LABELS[status]}`}
    >
      {STATUS_LABELS[status]}
    </Badge>
  );
}
