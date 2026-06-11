/**
 * PipelineThroughputChart — Recharts line chart showing pipeline executions per hour
 * over the past 24 hours.
 *
 * Fetches from GET /api/v1/metrics/pipeline-throughput?window=24h&interval=1h.
 */
import * as React from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton.js";
import { useApiClient } from "@/lib/api-client.js";
import { formatDate } from "@/lib/utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ThroughputDataPoint {
  timestamp: string;
  executions: number;
  successes: number;
  failures: number;
}

// ---------------------------------------------------------------------------
// PipelineThroughputChart component
// ---------------------------------------------------------------------------

export function PipelineThroughputChart() {
  const client = useApiClient();

  const query = useQuery({
    queryKey: ["metrics", "pipeline-throughput"],
    queryFn: ({ signal }) =>
      client.get<{ data: ThroughputDataPoint[] }>(
        "/v1/metrics/pipeline-throughput",
        { window: "24h", interval: "1h" },
        { signal },
      ),
    refetchInterval: 60_000, // Refresh every minute
    staleTime: 30_000,
  });

  const dataPoints = query.data?.data ?? [];

  const chartData = dataPoints.map((point) => ({
    time: formatDate(point.timestamp, { hour: "2-digit", minute: "2-digit" }),
    Executions: point.executions,
    Successes: point.successes,
    Failures: point.failures,
  }));

  if (query.isLoading) {
    return <Skeleton className="h-48 w-full" />;
  }

  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={chartData} margin={{ top: 4, right: 16, left: -16, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
        <XAxis
          dataKey="time"
          tick={{ fontSize: 11 }}
          tickLine={false}
          axisLine={false}
        />
        <YAxis
          tick={{ fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          allowDecimals={false}
        />
        <Tooltip
          contentStyle={{
            fontSize: 12,
            borderColor: "var(--color-border)",
            backgroundColor: "var(--color-background)",
          }}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Line
          type="monotone"
          dataKey="Executions"
          stroke="var(--color-primary)"
          strokeWidth={2}
          dot={false}
        />
        <Line
          type="monotone"
          dataKey="Successes"
          stroke="#16a34a"
          strokeWidth={2}
          dot={false}
        />
        <Line
          type="monotone"
          dataKey="Failures"
          stroke="#dc2626"
          strokeWidth={2}
          dot={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
