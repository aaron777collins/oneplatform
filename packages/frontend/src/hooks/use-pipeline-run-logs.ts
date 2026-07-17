import { useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LogLine {
  timestamp: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  /** Optional structured fields from the log record */
  fields?: Record<string, unknown>;
}

export interface UsePipelineRunLogsResult {
  logs: LogLine[];
  isComplete: boolean;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

// Cap the in-memory log buffer to prevent unbounded memory growth for
// long-running pipelines. Oldest lines are evicted when the cap is reached.
const MAX_LINES = 10_000;

/**
 * Streams log lines from a pipeline run via SSE.
 *
 * Connects to GET /api/v1/pipeline-runs/:runId/logs.
 * The stream emits "log" events with JSON log payloads, and a
 * "done" event when the run finishes (either success or failure).
 *
 * The connection is closed on unmount or when runId changes.
 * EventSource reconnects automatically on transient failures — the "done"
 * event is idempotent so duplicate delivery is safe.
 */
export function usePipelineRunLogs(runId: string): UsePipelineRunLogsResult {
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [isComplete, setIsComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    // Reset state when the runId changes
    setLogs([]);
    setIsComplete(false);
    setError(null);

    const es = new EventSource(
      `/api/v1/pipeline-runs/${runId}/logs`,
      { withCredentials: true },
    );
    esRef.current = es;

    es.addEventListener("log", (e) => {
      try {
        // The server emits records with a `createdAt` timestamp and may omit or
        // send an unexpected `level`. Normalize into the LogLine shape the
        // viewer renders so a stray field never crashes it.
        const raw = JSON.parse((e as MessageEvent<string>).data) as Record<string, unknown>;
        const rawLevel = String(raw["level"] ?? "info").toLowerCase();
        const level: LogLine["level"] =
          rawLevel === "debug" || rawLevel === "warn" || rawLevel === "error"
            ? rawLevel
            : "info";
        const line: LogLine = {
          timestamp: String(raw["timestamp"] ?? raw["createdAt"] ?? raw["created_at"] ?? ""),
          level,
          message: String(raw["message"] ?? ""),
          ...(raw["details"] !== undefined && raw["details"] !== null
            ? { fields: raw["details"] as Record<string, unknown> }
            : {}),
        };
        setLogs((prev) => {
          const next = [...prev, line];
          // Evict oldest lines when the buffer exceeds MAX_LINES to bound memory usage
          return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
        });
      } catch {
        // Malformed log line — skip silently rather than crashing the viewer
      }
    });

    // The server signals stream completion with a "done" event.
    es.addEventListener("done", () => {
      setIsComplete(true);
      es.close();
      esRef.current = null;
    });

    es.onerror = () => {
      // EventSource reconnects automatically. We surface an error message only
      // if it has been in error state for > 5 seconds (handled by the caller's
      // LogViewer UI via the reconnect count from useSSEStream if needed).
      // For now we track it without blocking reconnect.
      if (es.readyState === EventSource.CLOSED) {
        setError("Connection lost — log stream unavailable");
      }
    };

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [runId]);

  return { logs, isComplete, error };
}
