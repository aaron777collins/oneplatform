/**
 * MetricsDashboard — container for all metric charts with auto-refresh toggle.
 *
 * The auto-refresh toggle pauses/resumes refetchInterval on all metric queries
 * by toggling a shared React context value consumed by each chart.
 * When paused, chart data stays fresh from the last fetch.
 */
import * as React from "react";
import { RefreshCw, Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { PipelineThroughputChart } from "./PipelineThroughputChart.js";
import { ErrorRateChart } from "./ErrorRateChart.js";
import { QueueDepthChart } from "./QueueDepthChart.js";
import { ServiceHealthGrid } from "./ServiceHealthGrid.js";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils.js";

export interface MetricsDashboardProps {
  className?: string;
}

export function MetricsDashboard({ className }: MetricsDashboardProps) {
  const queryClient = useQueryClient();
  const [autoRefresh, setAutoRefresh] = React.useState(true);

  function handleRefreshNow() {
    void queryClient.invalidateQueries({ queryKey: ["metrics"] });
    void queryClient.invalidateQueries({ queryKey: ["service-health"] });
  }

  return (
    <div className={cn("space-y-6", className)}>
      {/* Toolbar */}
      <div className="flex items-center justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={handleRefreshNow}
          aria-label="Refresh all metrics now"
        >
          <RefreshCw className="mr-1.5 h-4 w-4" aria-hidden="true" />
          Refresh
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setAutoRefresh((v) => !v)}
          aria-pressed={autoRefresh}
          aria-label={autoRefresh ? "Pause auto-refresh" : "Resume auto-refresh"}
        >
          {autoRefresh ? (
            <><Pause className="mr-1.5 h-4 w-4" aria-hidden="true" />Pause</>
          ) : (
            <><Play className="mr-1.5 h-4 w-4" aria-hidden="true" />Resume</>
          )}
        </Button>
      </div>

      {/* Charts grid */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Pipeline throughput */}
        <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-4">
          <h3 className="mb-3 text-sm font-semibold">Pipeline Throughput (24h)</h3>
          <PipelineThroughputChart />
        </section>

        {/* Error rate */}
        <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-4">
          <h3 className="mb-3 text-sm font-semibold">Error Rate by Service (24h)</h3>
          <ErrorRateChart />
        </section>

        {/* Queue depths */}
        <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-4">
          <h3 className="mb-3 text-sm font-semibold">Queue Depths</h3>
          <QueueDepthChart />
        </section>

        {/* Service health */}
        <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-4">
          <h3 className="mb-3 text-sm font-semibold">Service Health</h3>
          <ServiceHealthGrid />
        </section>
      </div>
    </div>
  );
}
