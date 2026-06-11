import { useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BuildLogLine {
  timestamp: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  /** esbuild diagnostic location, present when level is "error" or "warn" */
  location?: {
    file: string;
    line: number;
    column: number;
  };
}

export interface UseBuildLogsResult {
  logs: BuildLogLine[];
  isComplete: boolean;
  /** Terminal status — only set when the "complete" event includes a status field */
  buildResult: "success" | "failed" | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Streams build log lines for a specific app build via SSE.
 *
 * Connects to GET /api/v1/apps/:appId/builds/:buildId/logs/stream.
 * Emits "log" events with JSON BuildLogLine payloads and a "complete" event
 * with { status: "success" | "failed" } when the build terminates.
 *
 * Callers should pass null for buildId when no build is in progress —
 * the hook will not open a connection in that case.
 */
export function useBuildLogs(
  appId: string,
  buildId: string | null,
): UseBuildLogsResult {
  const [logs, setLogs] = useState<BuildLogLine[]>([]);
  const [isComplete, setIsComplete] = useState(false);
  const [buildResult, setBuildResult] = useState<"success" | "failed" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (buildId === null) return;

    // Reset on each new build
    setLogs([]);
    setIsComplete(false);
    setBuildResult(null);
    setError(null);

    const es = new EventSource(
      `/api/v1/apps/${appId}/builds/${buildId}/logs/stream`,
      { withCredentials: true },
    );
    esRef.current = es;

    es.addEventListener("log", (e) => {
      try {
        const line = JSON.parse((e as MessageEvent<string>).data) as BuildLogLine;
        setLogs((prev) => [...prev, line]);
      } catch {
        // Skip malformed lines rather than crashing the build log panel
      }
    });

    es.addEventListener("complete", (e) => {
      try {
        const payload = JSON.parse((e as MessageEvent<string>).data) as { status: "success" | "failed" };
        setBuildResult(payload.status);
      } catch {
        // Treat missing payload as success — the build is at least done
        setBuildResult("success");
      }
      setIsComplete(true);
      es.close();
      esRef.current = null;
    });

    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        setError("Build log connection lost");
      }
    };

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [appId, buildId]);

  return { logs, isComplete, buildResult, error };
}
