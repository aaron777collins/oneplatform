import { useEffect, useState } from "react";
import { containerLogsUrl } from "../client/dockerApiClient.js";

export interface LogLine {
  stream: string;
  line: string;
  ts: string;
}

export interface LogsState {
  lines: LogLine[];
  connected: boolean;
  error: string | null;
}

// Subscribes to the container log SSE stream. The BFF proxy forwards the
// sidecar's `log` events; a `done` event closes the stream cleanly.
export function useContainerLogs(id: string | null, tail = 200): LogsState {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (id === null) {
      setLines([]);
      setConnected(false);
      return;
    }

    setLines([]);
    setError(null);

    const source = new EventSource(containerLogsUrl(id, tail), {
      withCredentials: true,
    });

    source.addEventListener("open", () => setConnected(true));

    source.addEventListener("log", (ev) => {
      try {
        const parsed = JSON.parse((ev as MessageEvent).data) as LogLine;
        setLines((prev) => {
          const next = [...prev, parsed];
          // Cap retained lines to avoid unbounded memory growth.
          return next.length > 5000 ? next.slice(next.length - 5000) : next;
        });
      } catch {
        // Ignore malformed events rather than tearing down the stream.
      }
    });

    source.addEventListener("done", () => {
      setConnected(false);
      source.close();
    });

    source.onerror = () => {
      // EventSource auto-reconnects; surface a soft error but keep the stream.
      setConnected(false);
      setError("Log stream interrupted. Reconnecting…");
    };

    return () => {
      source.close();
      setConnected(false);
    };
  }, [id, tail]);

  return { lines, connected, error };
}
