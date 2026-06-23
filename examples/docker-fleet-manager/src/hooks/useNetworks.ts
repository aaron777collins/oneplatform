import { useCallback } from "react";
import { fetchNetworks } from "../client/dockerApiClient.js";
import type { DockerNetwork } from "../types/docker.js";
import { usePolling, type PollingState } from "./usePolling.js";

export function useNetworks(refreshMs = 30000): PollingState<DockerNetwork[]> {
  const fetcher = useCallback((signal: AbortSignal) => fetchNetworks(signal), []);
  return usePolling(fetcher, refreshMs);
}
