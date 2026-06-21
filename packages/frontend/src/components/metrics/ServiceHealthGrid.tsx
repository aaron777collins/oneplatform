/**
 * ServiceHealthGrid — polls the gateway health endpoint every 30 seconds
 * and displays per-service health status for all platform services.
 *
 * The gateway /healthz endpoint returns an overall status plus a services
 * map with individual service statuses.
 *
 * Color is supplemented by text labels per §14.4 (color is never the sole indicator).
 */
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton.js";
import { useApiClient, ApiError } from "@/lib/api-client.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ServiceStatus = "healthy" | "degraded" | "down" | "unknown";

interface ServiceHealth {
  name: string;
  status: ServiceStatus;
  latencyMs?: number;
}

interface HealthzServiceEntry {
  status: string;
  latencyMs?: number;
}

interface HealthzResponse {
  status: string;
  services?: Record<string, HealthzServiceEntry>;
  [key: string]: unknown;
}

/**
 * Maps the API service key (lowercase) to a user-friendly display name.
 * Keep in sync with SERVICE_LABELS in DashboardPage.
 */
const SERVICE_FRIENDLY_NAMES: Record<string, string> = {
  gateway:   "API Gateway",
  auth:      "Authentication",
  ingestion: "Data Ingestion",
  ontology:  "Data Models",
  pipeline:  "Pipeline Engine",
  execution: "Execution Engine",
  app:       "App Runtime",
  logging:   "Logging",
  plugin:    "Plugin System",
};

/** Canonical API key names for all platform services (used for health lookups). */
const ALL_SERVICE_KEYS = [
  "gateway",
  "auth",
  "ingestion",
  "ontology",
  "pipeline",
  "execution",
  "app",
  "logging",
  "plugin",
] as const;

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

        // If the gateway returns per-service status, use it
        if (result.services !== undefined && Object.keys(result.services).length > 0) {
          const services: ServiceHealth[] = ALL_SERVICE_KEYS.map((key) => {
            const displayName = SERVICE_FRIENDLY_NAMES[key] ?? key;
            const entry = result.services?.[key];
            if (entry === undefined) {
              return { name: displayName, status: "unknown" as ServiceStatus };
            }
            const isUp = entry.status === "ok" || entry.status === "healthy";
            return {
              name: displayName,
              status: isUp ? "healthy" : entry.status === "degraded" ? "degraded" : "down",
              latencyMs: entry.latencyMs,
            } as ServiceHealth;
          });
          return { data: services };
        }

        // Fallback: only gateway status available
        const isHealthy = result.status === "ok" || result.status === "healthy";
        return {
          data: ALL_SERVICE_KEYS.map((key) => {
            const displayName = SERVICE_FRIENDLY_NAMES[key] ?? key;
            if (key === "gateway") {
              return {
                name: displayName,
                status: isHealthy ? "healthy" : "degraded",
                latencyMs,
              } as ServiceHealth;
            }
            return { name: displayName, status: "unknown" as ServiceStatus };
          }),
        };
      } catch (err) {
        // Distinguish network errors (service truly down) from auth/other errors
        const isNetworkError =
          err instanceof TypeError || // fetch network failure
          (err instanceof ApiError && err.statusCode >= 500);
        const status: ServiceStatus = isNetworkError ? "down" : "unknown";
        return {
          data: ALL_SERVICE_KEYS.map((key) => ({
            name: SERVICE_FRIENDLY_NAMES[key] ?? key,
            status,
            latencyMs: Date.now() - start,
          })),
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
          {Array.from({ length: ALL_SERVICE_KEYS.length }).map((_, i) => (
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
    </div>
  );
}
