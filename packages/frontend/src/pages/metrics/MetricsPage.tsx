/**
 * MetricsPage — full metrics dashboard with charts and service health.
 *
 * Route: /metrics
 */
import * as React from "react";
import { PageHeader } from "@/components/layout/PageHeader.js";
import { MetricsDashboard } from "@/components/metrics/MetricsDashboard.js";

export function MetricsPage() {
  return (
    <div className="flex-1 p-6">
      <PageHeader
        title="Metrics"
        description="Pipeline throughput, error rates, queue depths, and service health."
      />
      <div className="mt-6">
        <MetricsDashboard />
      </div>
    </div>
  );
}
