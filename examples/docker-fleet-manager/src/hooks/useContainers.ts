import { useCallback } from "react";
import { fetchContainers } from "../client/dockerApiClient.js";
import type { DockerContainer } from "../types/docker.js";
import { usePolling, type PollingState } from "./usePolling.js";

export interface ContainerFilter {
  status?: string;
  name?: string;
}

// Auto-refreshing list of containers. Defaults to a 5s poll interval.
export function useContainers(
  filter: ContainerFilter = {},
  refreshMs = 5000,
): PollingState<DockerContainer[]> {
  const { status, name } = filter;
  const fetcher = useCallback(
    (signal: AbortSignal) =>
      fetchContainers({
        ...(status !== undefined ? { status } : {}),
        ...(name !== undefined ? { name } : {}),
        signal,
      }),
    [status, name],
  );

  return usePolling(fetcher, refreshMs, [status, name]);
}
