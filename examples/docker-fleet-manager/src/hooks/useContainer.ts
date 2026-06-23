import { useCallback } from "react";
import { fetchContainer } from "../client/dockerApiClient.js";
import type { DockerContainerDetail } from "../types/docker.js";
import { usePolling, type PollingState } from "./usePolling.js";

// Single container detail. Polls at 5s so the Overview tab stays fresh while
// the detail panel is open.
export function useContainer(
  id: string | null,
  refreshMs = 5000,
): PollingState<DockerContainerDetail> {
  const fetcher = useCallback(
    (signal: AbortSignal) => {
      if (id === null) {
        return Promise.reject(new Error("No container selected."));
      }
      return fetchContainer(id, signal);
    },
    [id],
  );

  return usePolling(fetcher, refreshMs, [id]);
}
