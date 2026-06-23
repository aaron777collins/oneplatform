import { useEffect, useState } from "react";
import { containerStatsUrl } from "../client/dockerApiClient.js";
import type { ContainerStats } from "../types/docker.js";

export interface StatsState {
  current: ContainerStats | null;
  history: ContainerStats[];
  connected: boolean;
  error: string | null;
}

const MAX_HISTORY = 60;

// Subscribes to the container stats SSE stream and accumulates a rolling window
// of samples for sparkline rendering.
export function useContainerStats(id: string | null): StatsState {
  const [current, setCurrent] = useState<ContainerStats | null>(null);
  const [history, setHistory] = useState<ContainerStats[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (id === null) {
      setCurrent(null);
      setHistory([]);
      setConnected(false);
      return;
    }

    setHistory([]);
    setError(null);

    const source = new EventSource(containerStatsUrl(id), {
      withCredentials: true,
    });

    source.addEventListener("open", () => setConnected(true));

    source.addEventListener("stats", (ev) => {
      try {
        const parsed = JSON.parse((ev as MessageEvent).data) as ContainerStats;
        setCurrent(parsed);
        setHistory((prev) => {
          const next = [...prev, parsed];
          return next.length > MAX_HISTORY
            ? next.slice(next.length - MAX_HISTORY)
            : next;
        });
      } catch {
        // Ignore malformed events.
      }
    });

    source.addEventListener("done", () => {
      setConnected(false);
      source.close();
    });

    source.onerror = () => {
      setConnected(false);
      setError("Stats stream interrupted. Reconnecting…");
    };

    return () => {
      source.close();
      setConnected(false);
    };
  }, [id]);

  return { current, history, connected, error };
}
