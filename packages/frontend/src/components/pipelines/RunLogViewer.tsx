/**
 * RunLogViewer — real-time SSE log viewer for pipeline run logs.
 *
 * Uses usePipelineRunLogs to stream log lines and VirtualizedList to render
 * only the visible rows (the viewer must handle thousands of lines without
 * DOM performance degradation — §15.4).
 *
 * Features:
 * - Level filter: show only info/warn/error lines
 * - Search: substring match against log message text
 * - Auto-scroll toggle: tail-follow mode while streaming
 */
import * as React from "react";
import type { ListChildComponentProps } from "react-window";
import { Search, ChevronDown } from "lucide-react";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Button } from "@/components/ui/button.js";
import { VirtualizedList } from "@/components/shared/VirtualizedList.js";
import { usePipelineRunLogs, type LogLine } from "@/hooks/use-pipeline-run-logs.js";
import { cn } from "@/lib/utils.js";
import { formatDate } from "@/lib/utils.js";

// ---------------------------------------------------------------------------
// Level filter type
// ---------------------------------------------------------------------------

type LevelFilter = "all" | "info" | "warn" | "error";

// ---------------------------------------------------------------------------
// Log level styling
// ---------------------------------------------------------------------------

const LEVEL_CLASSES: Record<LogLine["level"], string> = {
  debug: "text-[var(--color-muted-foreground)]",
  info: "text-[var(--color-foreground)]",
  warn: "text-[var(--color-status-warning)]",
  error: "text-[var(--color-destructive)]",
};

const LEVEL_LABELS: Record<LogLine["level"], string> = {
  debug: "DBG",
  info: "INF",
  warn: "WRN",
  error: "ERR",
};

// ---------------------------------------------------------------------------
// Log row component
// ---------------------------------------------------------------------------

interface LogRowItem {
  timestamp: string;
  level: LogLine["level"];
  message: string;
}

function LogRow({ data, index, style }: ListChildComponentProps<LogRowItem[]>) {
  const item = data[index];
  if (item === undefined) return null;

  return (
    <div
      style={style}
      className={cn(
        "flex items-start gap-2 px-3 py-1 font-mono text-xs",
        index % 2 === 0 ? "bg-transparent" : "bg-[var(--color-muted)]/30",
      )}
    >
      <span className="shrink-0 text-[var(--color-muted-foreground)]">
        {formatDate(item.timestamp, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}
      </span>
      <span className={cn("w-7 shrink-0 font-semibold", LEVEL_CLASSES[item.level])}>
        {LEVEL_LABELS[item.level]}
      </span>
      <span className={cn("flex-1 break-all whitespace-pre-wrap", LEVEL_CLASSES[item.level])}>
        {item.message}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// RunLogViewer component
// ---------------------------------------------------------------------------

export interface RunLogViewerProps {
  runId: string;
  /** Height of the viewer in pixels. Defaults to 480. */
  height?: number;
  className?: string;
}

export function RunLogViewer({ runId, height = 480, className }: RunLogViewerProps) {
  const { logs, isComplete, error } = usePipelineRunLogs(runId);
  const [levelFilter, setLevelFilter] = React.useState<LevelFilter>("all");
  const [searchQuery, setSearchQuery] = React.useState("");
  const [followTail, setFollowTail] = React.useState(true);

  // Filter logs on the client side for immediate response
  const visibleLogs = React.useMemo<LogRowItem[]>(() => {
    return logs
      .filter((line) => {
        if (levelFilter !== "all" && line.level !== levelFilter) return false;
        if (searchQuery.length > 0) {
          return line.message.toLowerCase().includes(searchQuery.toLowerCase());
        }
        return true;
      })
      .map((line) => ({
        timestamp: line.timestamp,
        level: line.level,
        message: line.message,
      }));
  }, [logs, levelFilter, searchQuery]);

  const ESTIMATED_ROW_HEIGHT = 24;
  const itemSize = React.useCallback((_index: number) => ESTIMATED_ROW_HEIGHT, []);

  return (
    <div className={cn("flex flex-col rounded-md border border-[var(--color-border)]", className)}>
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] px-3 py-2">
        {/* Level filter */}
        <Select
          value={levelFilter}
          onValueChange={(v) => setLevelFilter(v as LevelFilter)}
        >
          <SelectTrigger className="h-8 w-28 text-xs">
            <SelectValue placeholder="Level" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All levels</SelectItem>
            <SelectItem value="info">Info+</SelectItem>
            <SelectItem value="warn">Warn+</SelectItem>
            <SelectItem value="error">Error only</SelectItem>
          </SelectContent>
        </Select>

        {/* Search */}
        <div className="relative flex-1">
          <Search
            className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--color-muted-foreground)]"
            aria-hidden
          />
          <Input
            className="h-8 pl-8 text-xs"
            placeholder="Search logs…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            aria-label="Search log messages"
          />
        </div>

        {/* Log count */}
        <span className="shrink-0 text-xs text-[var(--color-muted-foreground)]">
          {visibleLogs.length} {visibleLogs.length === 1 ? "line" : "lines"}
          {!isComplete && " • streaming"}
          {isComplete && " • complete"}
        </span>

        {/* Tail-follow toggle */}
        <Button
          variant={followTail ? "default" : "outline"}
          size="sm"
          className="h-8 text-xs"
          onClick={() => setFollowTail((v) => !v)}
          aria-pressed={followTail}
        >
          <ChevronDown className="h-3.5 w-3.5" aria-hidden />
          Follow
        </Button>
      </div>

      {/* Error state */}
      {error !== null && (
        <div
          className="border-b border-[var(--color-border)] bg-[var(--color-destructive)]/10 px-3 py-2 text-xs text-[var(--color-destructive)]"
          role="alert"
        >
          {error}
        </div>
      )}

      {/* Log output */}
      <div className="bg-[var(--color-card)] font-mono" style={{ height }}>
        {visibleLogs.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-[var(--color-muted-foreground)]">
            {logs.length === 0 ? "Waiting for logs…" : "No logs match current filter"}
          </div>
        ) : (
          <VirtualizedList<LogRowItem>
            items={visibleLogs}
            estimatedItemSize={ESTIMATED_ROW_HEIGHT}
            itemSize={itemSize}
            renderItem={(props) => <LogRow {...props} />}
            height={height}
            width="100%"
            followTail={followTail && !isComplete}
          />
        )}
      </div>
    </div>
  );
}
