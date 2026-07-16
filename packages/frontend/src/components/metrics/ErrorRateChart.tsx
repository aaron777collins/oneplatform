/**
 * ErrorRateChart — Recharts area chart showing error rate by service over 24h.
 *
 * Fetches from GET /api/v1/metrics/error-rate?window=24h&interval=1h.
 */
import * as React from "react";
import {
  AreaChart,
  Area,
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

interface ErrorRateDataPoint {
  timestamp: string;
  /** Error rate per service: key is service name, value is 0–100 percentage */
  [service: string]: string | number;
}

// Stable color palette for service area series
const SERVICE_COLORS = [
  "#ef4444", // red
  "#f97316", // orange
  "#eab308", // yellow
  "#8b5cf6", // violet
  "#06b6d4", // cyan
  "#84cc16", // lime
  "#ec4899", // pink
  "#14b8a6", // teal
];

// ---------------------------------------------------------------------------
// ErrorRateChart component
// ---------------------------------------------------------------------------

export function ErrorRateChart() {
  const client = useApiClient();

  const query = useQuery({
    queryKey: ["metrics", "error-rate"],
    queryFn: ({ signal }) =>
      // The gateway returns { data: { points, services } } — a single-key envelope
      // that the responseEnvelopeMiddleware passes through without re-wrapping.
      client.get<{ data: { points: ErrorRateDataPoint[]; services: string[] } }>(
        "/v1/metrics/error-rate",
        { window: "24h", interval: "1h" },
        { signal },
      ),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const dataPoints = query.data?.data?.points ?? [];
  const services = query.data?.data?.services ?? [];

  const chartData = dataPoints.map((point) => ({
    time: formatDate(point.timestamp, { hour: "2-digit", minute: "2-digit" }),
    ...Object.fromEntries(
      services.map((svc) => [svc, typeof point[svc] === "number" ? point[svc] : 0]),
    ),
  }));

  if (query.isLoading) {
    return <Skeleton className="h-48 w-full" />;
  }

  return (
    <ResponsiveContainer width="100%" height={200}>
      <AreaChart data={chartData} margin={{ top: 4, right: 16, left: -16, bottom: 0 }}>
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
          tickFormatter={(v: number) => `${v}%`}
          domain={[0, "auto"]}
        />
        <Tooltip
          contentStyle={{
            fontSize: 12,
            borderColor: "var(--color-border)",
            backgroundColor: "var(--color-background)",
          }}
          formatter={(value: number, name: string) => [`${value.toFixed(1)}%`, name]}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        {services.map((svc, index) => (
          <Area
            key={svc}
            type="monotone"
            dataKey={svc}
            stroke={SERVICE_COLORS[index % SERVICE_COLORS.length]}
            fill={`${SERVICE_COLORS[index % SERVICE_COLORS.length]}30`}
            strokeWidth={2}
            dot={false}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}
