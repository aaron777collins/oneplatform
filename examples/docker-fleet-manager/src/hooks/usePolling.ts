import { useEffect, useRef, useState, useCallback } from "react";
import { DockerApiClientError } from "../client/dockerApiClient.js";

export interface PollingState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
}

// Generic polling hook. Re-fetches on an interval, pauses while the browser tab
// is hidden, and cancels in-flight requests on unmount. Used by all list hooks.
export function usePolling<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  refreshMs: number,
  deps: ReadonlyArray<unknown> = [],
): PollingState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  // Keep the latest fetcher in a ref so the effect doesn't re-subscribe when an
  // inline fetcher identity changes on every render.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function run(): Promise<void> {
      try {
        const result = await fetcherRef.current(controller.signal);
        if (!cancelled) {
          setData(result);
          setError(null);
        }
      } catch (err) {
        if (cancelled || controller.signal.aborted) return;
        const message =
          err instanceof DockerApiClientError
            ? err.message
            : "Failed to load data.";
        setError(message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void run();

    let intervalId: ReturnType<typeof setInterval> | null = null;

    function start(): void {
      if (intervalId === null) {
        intervalId = setInterval(() => {
          void run();
        }, refreshMs);
      }
    }
    function stop(): void {
      if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
      }
    }

    function onVisibility(): void {
      if (document.visibilityState === "hidden") {
        stop();
      } else {
        void run();
        start();
      }
    }

    if (document.visibilityState !== "hidden") {
      start();
    }
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      controller.abort();
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshMs, tick, ...deps]);

  return { data, error, loading, refresh };
}
