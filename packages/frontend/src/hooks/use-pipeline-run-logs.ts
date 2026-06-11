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

/**
 * Streams log lines from a pipeline run via SSE.
 *
 * Connects to GET /api/v1/pipeline-runs/:runId/logs/stream.
 * The stream emits "log" events with JSON LogLine payloads, and a
 * "complete" event when the run finishes (either success or failure).
 *
 * The connection is closed on unmount or when runId changes.
 * EventSource reconnects automatically on transient failures — the "complete"
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
      `/api/v1/pipeline-runs/${runId}/logs/stream`,
      { withCredentials: true },
    );
    esRef.current = es;

    es.addEventListener("log", (e) => {
      try {
        const line = JSON.parse((e as MessageEvent<string>).data) as LogLine;
        setLogs((prev) => [...prev, line]);
      } catch {
        // Malformed log line — skip silently rather than crashing the viewer
      }
    });

    es.addEventListener("complete", () => {
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
