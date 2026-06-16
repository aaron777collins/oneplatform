/**
 * ServiceHealthGrid — polls GET /healthz on the gateway every 30 seconds
 * and displays the gateway health status.
 *
 * Per-service health aggregation is a planned future feature. Currently only
 * the gateway health check endpoint is available.
 *
 * Color is supplemented by text labels per §14.4 (color is never the sole indicator).
 */
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton.js";
import { useApiClient, ApiError } from "@/lib/api-client.js";
import { Info } from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ServiceStatus = "healthy" | "degraded" | "down" | "unknown";

interface ServiceHealth {
  name: string;
  status: ServiceStatus;
  latencyMs?: number;
}

interface HealthzResponse {
  status: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Status config
// ---------------------------------------------------------------------------

const STATUS_DOT_CLASS: Record<ServiceStatus, string> = {
  healthy: "bg-[var(--color-status-success)]",
  degraded: "bg-[var(--color-status-warning)] animate-pulse",
  down: "bg-[var(--color-destructive)]",
  unknown: "bg-[var(--color-muted-foreground)]",
};

const STATUS_LABELS: Record<ServiceStatus, string> = {
  healthy: "Healthy",
  degraded: "Degraded",
  down: "Down",
  unknown: "Unknown",
};

// ---------------------------------------------------------------------------
// ServiceHealthGrid component
// ---------------------------------------------------------------------------

export interface ServiceHealthGridProps {
  className?: string;
}

export function ServiceHealthGrid({ className }: ServiceHealthGridProps) {
  const client = useApiClient();

  const { data, isLoading, isError } = useQuery({
    queryKey: ["service-health"],
    queryFn: async (): Promise<{ data: ServiceHealth[] }> => {
      const start = Date.now();
      try {
        const result = await client.get<HealthzResponse>("/healthz");
        const latencyMs = Date.now() - start;
        const isHealthy = result.status === "ok" || result.status === "healthy";
        return {
          data: [
            {
              name: "Gateway",
              status: isHealthy ? "healthy" : "degraded",
              latencyMs,
            },
          ],
        };
      } catch (err) {
        return {
          data: [
            {
              name: "Gateway",
              status: "down" as ServiceStatus,
              latencyMs: Date.now() - start,
            },
          ],
        };
      }
    },
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  const services = data?.data ?? [];

  if (isLoading) {
    return (
      <div className={className}>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {Array.from({ length: 1 }).map((_, i) => (
            <div key={i} className="flex items-center gap-2">
              <Skeleton className="h-2.5 w-2.5 rounded-full" />
              <Skeleton className="h-4 w-24" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className={className}>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
        {services.map((service) => (
          <div key={service.name} className="flex items-center gap-2">
            <span
              className={`h-2.5 w-2.5 shrink-0 rounded-full ${STATUS_DOT_CLASS[service.status]}`}
              aria-hidden="true"
            />
            <div className="min-w-0">
              <p className="truncate text-sm">{service.name}</p>
              <p className="text-xs text-[var(--color-muted-foreground)]">
                {STATUS_LABELS[service.status]}
                {service.latencyMs !== undefined && service.status === "healthy" && (
                  <span className="ml-1">{service.latencyMs}ms</span>
                )}
              </p>
            </div>
          </div>
        ))}
        {services.length === 0 && (
          <p className="col-span-full text-sm text-[var(--color-muted-foreground)]">
            No service health data available.
          </p>
        )}
      </div>
      <div className="mt-3 flex items-start gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-muted)]/40 px-3 py-2">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-muted-foreground)]" aria-hidden="true" />
        <p className="text-xs text-[var(--color-muted-foreground)]">
          Per-service health aggregation is a planned feature. Currently showing gateway health only.
        </p>
      </div>
    </div>
  );
}
