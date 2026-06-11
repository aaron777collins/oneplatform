/**
 * QueueDepthChart — Recharts bar chart showing current depth of each BullMQ queue.
 *
 * Fetches from GET /api/v1/metrics/queue-depths. Refreshes every 30 seconds.
 */
import * as React from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton.js";
import { useApiClient } from "@/lib/api-client.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface QueueDepth {
  queueName: string;
  waiting: number;
  active: number;
  failed: number;
  delayed: number;
}

// ---------------------------------------------------------------------------
// QueueDepthChart component
// ---------------------------------------------------------------------------

export function QueueDepthChart() {
  const client = useApiClient();

  const query = useQuery({
    queryKey: ["metrics", "queue-depths"],
    queryFn: ({ signal }) =>
      client.get<{ data: QueueDepth[] }>(
        "/v1/metrics/queue-depths",
        undefined,
        { signal },
      ),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  const queues = query.data?.data ?? [];

  const chartData = queues.map((q) => ({
    name: q.queueName.length > 16 ? `…${q.queueName.slice(-14)}` : q.queueName,
    Waiting: q.waiting,
    Active: q.active,
    Failed: q.failed,
    Delayed: q.delayed,
    // For coloring: high failed count is a warning signal
    hasFailed: q.failed > 0,
  }));

  if (query.isLoading) {
    return <Skeleton className="h-48 w-full" />;
  }

  if (chartData.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center text-sm text-[var(--color-muted-foreground)]">
        No queue data available.
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={chartData} margin={{ top: 4, right: 16, left: -16, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
        <XAxis
          dataKey="name"
          tick={{ fontSize: 10 }}
          tickLine={false}
          axisLine={false}
          interval={0}
          angle={-30}
          textAnchor="end"
          height={40}
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
        <Bar dataKey="Waiting" fill="#3b82f6" radius={[2, 2, 0, 0]}>
          {chartData.map((entry, index) => (
            <Cell
              key={index}
              fill={entry.hasFailed ? "#f97316" : "#3b82f6"}
            />
          ))}
        </Bar>
        <Bar dataKey="Active" fill="#16a34a" radius={[2, 2, 0, 0]} />
        <Bar dataKey="Failed" fill="#dc2626" radius={[2, 2, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
