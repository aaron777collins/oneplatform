/**
 * DashboardPage — the overview page shown to authenticated users after bootstrap.
 *
 * Panels (§10.3):
 * 1. Quick Start — conditional, shown when user has zero apps (Casey's onboarding)
 * 2. Active Pipelines — running/recent pipeline runs with status badges
 * 3. Recent Activity — last 20 platform log events
 * 4. Service Health — colored dots per service from GET /api/v1/health/services
 *
 * Real-time: usePlatformEvents invalidates pipeline and ingestion queries on events,
 * so the pipeline panel updates without polling.
 */
import React from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Upload, Layers, PlugZap, ArrowRight } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card.js";
import { Button } from "@/components/ui/button.js";
import { Skeleton } from "@/components/ui/skeleton.js";
import { Badge } from "@/components/ui/badge.js";
import { RelativeTime } from "@/components/shared/RelativeTime.js";
import { ServiceHealthGrid } from "@/components/metrics/ServiceHealthGrid.js";
import { RunStatusBadge } from "@/components/pipelines/RunStatusBadge.js";
import { usePlatformEvents } from "@/hooks/use-platform-events.js";
import { useApiClient, type PaginatedResponse } from "@/lib/api-client.js";
import { truncate } from "@/lib/utils.js";
import type { RunStatus } from "@/components/pipelines/RunStatusBadge.js";

// ---------------------------------------------------------------------------
// API types
// ---------------------------------------------------------------------------

interface PipelineSummary {
  id: string;
  name: string;
  lastRunStatus?: RunStatus;
  lastRunAt?: string;
}

interface ActivityEvent {
  id: string;
  service: string;
  level: "info" | "warn" | "error";
  message: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Quick Start panel
// ---------------------------------------------------------------------------

function QuickStartPanel({ onCsvUpload, onBrowseConnectors }: {
  onCsvUpload: () => void;
  onBrowseConnectors: () => void;
}) {
  return (
    <Card className="border-[var(--color-primary)]/30 bg-[var(--color-primary)]/5">
      <CardHeader>
        <CardTitle className="text-base">Get started with OnePlatform</CardTitle>
        <CardDescription>
          Choose how you want to bring your data in.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-3">
          <button
            className="flex flex-col items-start gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-card)] p-4 text-left transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
            onClick={onCsvUpload}
          >
            <Upload className="h-5 w-5 text-[var(--color-primary)]" aria-hidden />
            <div>
              <p className="text-sm font-semibold">Upload CSV</p>
              <p className="mt-0.5 text-xs text-[var(--color-muted-foreground)]">
                Import a spreadsheet and auto-generate your data schema.
              </p>
            </div>
          </button>

          <Link
            to="/apps"
            className="flex flex-col items-start gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-card)] p-4 text-left transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
          >
            <Layers className="h-5 w-5 text-[var(--color-primary)]" aria-hidden />
            <div>
              <p className="text-sm font-semibold">Create from Template</p>
              <p className="mt-0.5 text-xs text-[var(--color-muted-foreground)]">
                Start with a pre-built starter app template.
              </p>
            </div>
          </Link>

          <button
            className="flex flex-col items-start gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-card)] p-4 text-left transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
            onClick={onBrowseConnectors}
          >
            <PlugZap className="h-5 w-5 text-[var(--color-primary)]" aria-hidden />
            <div>
              <p className="text-sm font-semibold">Browse Connectors</p>
              <p className="mt-0.5 text-xs text-[var(--color-muted-foreground)]">
                Connect to databases, APIs, and services.
              </p>
            </div>
          </button>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Level badge for activity events
// ---------------------------------------------------------------------------

const LEVEL_CLASSES: Record<ActivityEvent["level"], string> = {
  info: "bg-[var(--color-muted)] text-[var(--color-muted-foreground)]",
  warn: "bg-[var(--color-status-warning)]/20 text-[var(--color-status-warning)]",
  error: "bg-[var(--color-destructive)]/20 text-[var(--color-destructive)]",
};

// ---------------------------------------------------------------------------
// DashboardPage component
// ---------------------------------------------------------------------------

export default function DashboardPage() {
  const client = useApiClient();
  const navigate = useNavigate();

  // Real-time: invalidate pipeline queries on SSE events
  usePlatformEvents(["pipeline.*", "ingestion.*"]);

  // Fetch apps to determine if Quick Start should show
  const { data: appsData } = useQuery({
    queryKey: ["apps"],
    queryFn: () => client.get<PaginatedResponse<{ id: string }>>("/v1/apps"),
  });

  // Active / recent pipelines
  const { data: pipelinesData, isLoading: pipelinesLoading } = useQuery({
    queryKey: ["pipelines"],
    queryFn: () => client.get<PaginatedResponse<PipelineSummary>>("/v1/pipelines"),
    staleTime: 10_000,
  });

  // Recent activity
  const { data: activityData, isLoading: activityLoading } = useQuery({
    queryKey: ["activity-feed"],
    queryFn: () => client.get<PaginatedResponse<ActivityEvent>>("/v1/logs", { limit: 20, sort: "-createdAt" }),
    staleTime: 10_000,
  });

  const showQuickStart = appsData?.data?.length === 0;
  const pipelines = pipelinesData?.data ?? [];
  const activities = activityData?.data ?? [];

  return (
    <main id="main-content" tabIndex={-1} className="flex-1 overflow-y-auto">
      <header className="border-b border-[var(--color-border)] bg-[var(--color-background)] px-6 py-4">
        <h1 className="text-2xl font-bold tracking-tight">Overview</h1>
      </header>

      <div className="p-6 space-y-6">
        {/* Quick Start — only for new users with zero apps */}
        {showQuickStart === true && (
          <QuickStartPanel
            onCsvUpload={() => void navigate({ to: "/ontology" })}
            onBrowseConnectors={() => void navigate({ to: "/connectors" })}
          />
        )}

        <div className="grid gap-6 lg:grid-cols-2">
          {/* Active Pipelines */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-base">Active Pipelines</CardTitle>
              <Button variant="ghost" size="sm" asChild>
                <Link to="/pipelines" className="text-xs">
                  View all
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                </Link>
              </Button>
            </CardHeader>
            <CardContent>
              {pipelinesLoading ? (
                <div className="space-y-3">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="flex items-center justify-between">
                      <Skeleton className="h-4 w-40" />
                      <Skeleton className="h-5 w-16" />
                    </div>
                  ))}
                </div>
              ) : pipelines.length === 0 ? (
                <p className="text-sm text-[var(--color-muted-foreground)]">
                  No pipelines yet.{" "}
                  <Link to="/pipelines" className="text-[var(--color-primary)] hover:underline">
                    Create one
                  </Link>
                </p>
              ) : (
                <ul className="divide-y divide-[var(--color-border)]" role="list">
                  {pipelines.slice(0, 8).map((pipeline) => (
                    <li key={pipeline.id} className="flex items-center justify-between py-2.5">
                      <div className="min-w-0 flex-1">
                        <Link
                          to="/pipelines/$id"
                          params={{ id: pipeline.id }}
                          className="text-sm font-medium hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-ring)]"
                        >
                          {pipeline.name}
                        </Link>
                        {pipeline.lastRunAt !== undefined && (
                          <RelativeTime
                            value={pipeline.lastRunAt}
                            className="block text-xs text-[var(--color-muted-foreground)]"
                          />
                        )}
                      </div>
                      {pipeline.lastRunStatus !== undefined && (
                        <RunStatusBadge status={pipeline.lastRunStatus} />
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {/* Recent Activity */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-base">Recent Activity</CardTitle>
              <Button variant="ghost" size="sm" asChild>
                <Link to="/logs" className="text-xs">
                  View all
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                </Link>
              </Button>
            </CardHeader>
            <CardContent>
              {activityLoading ? (
                <div className="space-y-3">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="flex items-start gap-2">
                      <Skeleton className="h-4 w-12 shrink-0" />
                      <Skeleton className="h-4 w-full" />
                    </div>
                  ))}
                </div>
              ) : activities.length === 0 ? (
                <p className="text-sm text-[var(--color-muted-foreground)]">No recent activity.</p>
              ) : (
                <ul className="divide-y divide-[var(--color-border)]" role="list">
                  {activities.map((event) => (
                    <li key={event.id} className="flex items-start gap-2 py-2">
                      <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
                        <Badge className={LEVEL_CLASSES[event.level]}>
                          {event.level}
                        </Badge>
                        <span className="text-xs text-[var(--color-muted-foreground)]">
                          {event.service}
                        </span>
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm" title={event.message}>
                          {truncate(event.message, 120)}
                        </p>
                        <RelativeTime
                          value={event.createdAt}
                          className="text-xs text-[var(--color-muted-foreground)]"
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Service Health */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Service Health</CardTitle>
            <CardDescription>
              Status of all platform services. Refreshes every 30 seconds.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ServiceHealthGrid />
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
