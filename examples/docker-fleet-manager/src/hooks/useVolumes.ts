import { useCallback } from "react";
import { fetchVolumes } from "../client/dockerApiClient.js";
import type { DockerVolume } from "../types/docker.js";
import { usePolling, type PollingState } from "./usePolling.js";

export function useVolumes(refreshMs = 30000): PollingState<DockerVolume[]> {
  const fetcher = useCallback((signal: AbortSignal) => fetchVolumes(signal), []);
  return usePolling(fetcher, refreshMs);
}
