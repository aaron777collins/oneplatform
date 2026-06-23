import { useQuery } from "@tanstack/react-query";
import { useApiClient } from "@/lib/api-client.js";
import type { ApiResponse } from "@/lib/api-client.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BootstrapStatus {
  completed: boolean;
  bootstrapToken?: string;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Fetches bootstrap status from GET /api/v1/bootstrap/status.
 *
 * Used by the bootstrap gate in the root route to decide whether to render
 * the setup wizard or the authenticated dashboard.
 *
 * staleTime is 60s because:
 * - Before bootstrap: we only need to refresh after a full-page navigation.
 * - After bootstrap: the endpoint permanently returns { completed: true };
 *   there is no value in polling more frequently.
 *
 * The query is public — no session cookie is required to call this endpoint.
 */
export function useBootstrapStatus() {
  const client = useApiClient();

  return useQuery({
    queryKey: ["bootstrap-status"],
    queryFn: (): Promise<ApiResponse<BootstrapStatus>> =>
      client.get<ApiResponse<BootstrapStatus>>("/v1/bootstrap/status"),
    staleTime: 60_000,
    // Do not retry on 4xx — if the endpoint is missing, retrying won't help
    retry: (failureCount: number, error: unknown): boolean => {
      if (typeof error === "object" && error !== null && "statusCode" in error) {
        const statusCode = (error as { statusCode: number }).statusCode;
        if (statusCode >= 400 && statusCode < 500) return false;
      }
      return failureCount < 2;
    },
  });
}
