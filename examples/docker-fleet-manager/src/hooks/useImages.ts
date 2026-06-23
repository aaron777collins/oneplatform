import { useCallback } from "react";
import { fetchImages } from "../client/dockerApiClient.js";
import type { DockerImage } from "../types/docker.js";
import { usePolling, type PollingState } from "./usePolling.js";

export function useImages(refreshMs = 30000): PollingState<DockerImage[]> {
  const fetcher = useCallback((signal: AbortSignal) => fetchImages(signal), []);
  return usePolling(fetcher, refreshMs);
}
