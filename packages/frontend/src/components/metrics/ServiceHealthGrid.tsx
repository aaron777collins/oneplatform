/**
 * ServiceHealthGrid — polls the gateway health endpoint every 30 seconds
 * and displays per-service health status for all platform services.
 *
 * The gateway /healthz endpoint returns an overall status plus a services
 * map with individual service statuses.
 *
 * Health history is kept in-component state (ring buffer of HISTORY_SIZE
 * check results per service). This gives operators a quick visual signal of
 * recent stability without requiring a separate time-series endpoint.
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
// Health history
// ---------------------------------------------------------------------------

/** Number of poll results kept per service (one every 30s = ~12 min window). */
const HISTORY_SIZE = 24;

/** Per-check snapshot stored in the history ring buffer. */
interface HealthCheckSnapshot {
  status: ServiceStatus;
  /** Unix epoch ms — used only for tooltip display. */
  checkedAt: number;
}

type ServiceHealthHistory = Map<string, HealthCheckSnapshot[]>;

/**
 * Appends a new snapshot to the history ring for `serviceName`,
 * discarding the oldest entry when the buffer is full.
 * Returns a new Map (immutable update) so React sees the state change.
 */
function appendHistory(
  prev: ServiceHealthHistory,
  serviceName: string,
  snapshot: HealthCheckSnapshot,
): ServiceHealthHistory {
  const next = new Map(prev);
  const existing = next.get(serviceName) ?? [];
  const updated = existing.length >= HISTORY_SIZE
    ? [...existing.slice(1), snapshot]
    : [...existing, snapshot];
  next.set(serviceName, updated);
  return next;
}

/**
 * Computes a percentage uptime string from the history snapshots.
 * "Healthy" counts as healthy; anything else is considered degraded/down.
 */
function uptimeLabel(history: HealthCheckSnapshot[]): string {
  if (history.length === 0) return "";
  const healthy = history.filter((s) => s.status === "healthy").length;
  const pct = Math.round((healthy / history.length) * 100);
  return `${pct}% (last ${history.length} checks)`;
}

// ---------------------------------------------------------------------------
// HealthSparkline — mini timeline of dot indicators for one service
// ---------------------------------------------------------------------------

interface HealthSparklineProps {
  history: HealthCheckSnapshot[];
}

function HealthSparkline({ history }: HealthSparklineProps) {
  if (history.length === 0) return null;

  return (
    <div
      className="flex items-center gap-px mt-1"
      aria-label={`Health history: ${uptimeLabel(history)}`}
      role="img"
    >
      {history.map((snap, i) => (
        <span
          key={i}
          className={[
            "inline-block h-1.5 w-1.5 rounded-full",
            snap.status === "healthy"
              ? "bg-[var(--color-status-success)]"
              : snap.status === "degraded"
              ? "bg-[var(--color-status-warning)]"
              : snap.status === "down"
              ? "bg-[var(--color-destructive)]"
              : "bg-[var(--color-muted-foreground)]",
          ].join(" ")}
          title={`${snap.status} at ${new Date(snap.checkedAt).toLocaleTimeString()}`}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ServiceHealthGrid component
// ---------------------------------------------------------------------------

export interface ServiceHealthGridProps {
  className?: string;
}

export function ServiceHealthGrid({ className }: ServiceHealthGridProps) {
  const client = useApiClient();

  // Ring buffer of health snapshots per service — gives operators a quick
  // stability signal without requiring a separate time-series endpoint (PA-016).
  const [healthHistory, setHealthHistory] = React.useState<ServiceHealthHistory>(new Map());

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

  // When a fresh poll result arrives, append each service's status to its
  // history buffer so the sparklines update without re-fetching history.
  const checkedAt = React.useRef(0);
  React.useEffect(() => {
    if (data === undefined) return;
    const now = Date.now();
    // Guard against running twice for the same poll result
    if (now - checkedAt.current < 5_000) return;
    checkedAt.current = now;
    setHealthHistory((prev) => {
      let next = prev;
      for (const service of data.data) {
        next = appendHistory(next, service.name, { status: service.status, checkedAt: now });
      }
      return next;
    });
  }, [data]);

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
        {services.map((service) => {
          const history = healthHistory.get(service.name) ?? [];
          const uptime = uptimeLabel(history);
          return (
            <div key={service.name} className="flex items-start gap-2">
              <span
                className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${STATUS_DOT_CLASS[service.status]}`}
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
                {history.length > 0 && (
                  <>
                    <HealthSparkline history={history} />
                    {uptime && (
                      <p className="text-[10px] text-[var(--color-muted-foreground)] mt-0.5">
                        Uptime: {uptime}
                      </p>
                    )}
                  </>
                )}
              </div>
            </div>
          );
        })}
        {services.length === 0 && (
          <p className="col-span-full text-sm text-[var(--color-muted-foreground)]">
            No service health data available.
          </p>
        )}
      </div>
    </div>
  );
}
