/**
 * LogRow — single log entry rendered in the virtualized log table.
 *
 * Displays: timestamp, level badge, service name, message, trace ID link.
 * Designed to be used as the renderItem for VirtualizedList.
 */
import * as React from "react";
import type { ListChildComponentProps } from "react-window";
import { TraceIdLink } from "./TraceIdLink.js";
import { formatDate } from "@/lib/utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  id: string;
  timestamp: string;
  level: LogLevel;
  service: string;
  message: string;
  traceId?: string;
}

// ---------------------------------------------------------------------------
// Level styling
// ---------------------------------------------------------------------------

const LEVEL_CLASSES: Record<LogLevel, string> = {
  debug: "bg-[var(--color-muted)] text-[var(--color-muted-foreground)]",
  info: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  warn: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
  error: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
};

// ---------------------------------------------------------------------------
// LogRow component (react-window compatible)
// ---------------------------------------------------------------------------

export function LogRow({ index, style, data }: ListChildComponentProps<LogEntry[]>) {
  const entry = data[index];
  if (entry === undefined) return null;

  return (
    <div
      style={style}
      className="flex items-start gap-2 border-b border-[var(--color-border)] px-3 py-1.5 text-xs hover:bg-[var(--color-muted)]/50"
    >
      {/* Timestamp */}
      <span className="w-36 shrink-0 font-mono text-[var(--color-muted-foreground)]">
        {formatDate(entry.timestamp, {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          fractionalSecondDigits: 3,
        })}
      </span>

      {/* Level badge */}
      <span
        className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-semibold uppercase ${LEVEL_CLASSES[entry.level]}`}
        role="status"
        aria-label={`Level: ${entry.level}`}
      >
        {entry.level}
      </span>

      {/* Service name */}
      <span className="w-28 shrink-0 truncate text-[var(--color-muted-foreground)]">
        {entry.service}
      </span>

      {/* Message */}
      <span className="min-w-0 flex-1 break-words text-[var(--color-foreground)]">
        {entry.message}
      </span>

      {/* Trace ID */}
      {entry.traceId !== undefined && (
        <TraceIdLink traceId={entry.traceId} />
      )}
    </div>
  );
}
