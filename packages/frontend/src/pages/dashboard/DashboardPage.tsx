/**
 * DashboardPage — the overview page shown to authenticated users after bootstrap.
 *
 * Panels (§10.3):
 * 1. Quick Start — conditional, shown when the user hasn't completed onboarding
 *    (M-21). Checks actual resource counts from the API so it hides as soon as
 *    data is flowing, not just when an app exists.
 * 2. Active Pipelines — running/recent pipeline runs with status badges
 * 3. Recent Activity — last 20 platform log events
 * 4. Service Health — colored dots per service from GET /api/v1/health/services
 *
 * Real-time: usePlatformEvents invalidates pipeline and ingestion queries on events,
 * so the pipeline panel updates without polling.
 */
import React, { useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  CheckCircle2,
  Circle,
  PlugZap,
  Database,
  GitBranch,
  LayoutGrid,
  X,
  ArrowRight,
  GripVertical,
  ChevronUp,
  ChevronDown,
} from "lucide-react";
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

// Cast Lucide icons to avoid exactOptionalPropertyTypes conflict on className
type IconComponent = React.ComponentType<{ className?: string }>;
const PlugZapIcon = PlugZap as IconComponent;
const DatabaseIcon = Database as IconComponent;
const GitBranchIcon = GitBranch as IconComponent;
const LayoutGridIcon = LayoutGrid as IconComponent;

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
// Quick Start checklist
// ---------------------------------------------------------------------------

// localStorage key for the user's manual dismiss. We store the dismissed state
// client-side so the panel stays gone after reload even if counts are still zero
// (e.g. the user set up a connector but hasn't checked the dashboard yet).
const QUICK_START_DISMISSED_KEY = "oneplatform.quickstart.dismissed";

interface ChecklistStep {
  id: string;
  label: string;
  description: string;
  done: boolean;
  href: string;
  icon: IconComponent;
}

function QuickStartPanel({
  connectorCount,
  entityCount,
  pipelineCount,
  appCount,
  onDismiss,
}: {
  connectorCount: number;
  entityCount: number;
  pipelineCount: number;
  appCount: number;
  onDismiss: () => void;
}) {
  const steps: ChecklistStep[] = [
    {
      id: "connector",
      label: "Connect a data source",
      description: "Wire up a database, API, or file source so data can flow in.",
      done: connectorCount > 0,
      href: "/connectors/new",
      icon: PlugZapIcon,
    },
    {
      id: "entity",
      label: "Define your data model",
      description: "Create entity types to describe the shape of your data.",
      done: entityCount > 0,
      href: "/ontology",
      icon: DatabaseIcon,
    },
    {
      id: "pipeline",
      label: "Build a pipeline",
      description: "Transform and route data between sources and destinations.",
      done: pipelineCount > 0,
      // Route to the pipelines list; the "New pipeline" button there starts the builder.
      // We avoid deep-linking to /pipelines/$id/edit with a synthetic ID because that
      // route requires a real ID param.
      href: "/pipelines",
      icon: GitBranchIcon,
    },
    {
      id: "app",
      label: "Create your first app",
      description: "Build an internal tool or data view on top of your data.",
      done: appCount > 0,
      href: "/apps",
      icon: LayoutGridIcon,
    },
  ];

  const completedCount = steps.filter((s) => s.done).length;

  return (
    <Card className="border-[var(--color-primary)]/30 bg-[var(--color-primary)]/5">
      <CardHeader className="flex flex-row items-start justify-between gap-4 pb-3">
        <div>
          <CardTitle className="text-base">Get started with OnePlatform</CardTitle>
          <CardDescription className="mt-0.5">
            {completedCount} of {steps.length} steps complete
          </CardDescription>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss quick start"
          className="shrink-0 rounded p-1 text-[var(--color-muted-foreground)] hover:bg-[var(--color-muted)] hover:text-[var(--color-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </CardHeader>

      <CardContent>
        <ol className="space-y-3" aria-label="Onboarding checklist">
          {steps.map((step) => {
            const Icon = step.icon;
            return (
              <li
                key={step.id}
                className="flex items-start gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-card)] p-3"
              >
                {/* Completion indicator */}
                {step.done ? (
                  <CheckCircle2
                    className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-status-success,#16a34a)]"
                    aria-label="Complete"
                  />
                ) : (
                  <Circle
                    className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-muted-foreground)]"
                    aria-label="Incomplete"
                  />
                )}

                {/* Step content */}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Icon
                      className="h-4 w-4 shrink-0 text-[var(--color-primary)]"
                      aria-hidden
                    />
                    <p
                      className={`text-sm font-medium ${
                        step.done
                          ? "text-[var(--color-muted-foreground)] line-through"
                          : "text-[var(--color-foreground)]"
                      }`}
                    >
                      {step.label}
                    </p>
                  </div>
                  {!step.done && (
                    <p className="mt-0.5 text-xs text-[var(--color-muted-foreground)]">
                      {step.description}
                    </p>
                  )}
                </div>

                {/* CTA — only shown for incomplete steps */}
                {!step.done && (
                  <Link
                    to={step.href}
                    className="shrink-0 self-center rounded border border-[var(--color-border)] bg-[var(--color-background)] px-2.5 py-1 text-xs font-medium transition-colors hover:bg-[var(--color-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
                  >
                    Start
                    <span className="sr-only"> — {step.label}</span>
                  </Link>
                )}
              </li>
            );
          })}
        </ol>
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
// Friendly service name mapping
// ---------------------------------------------------------------------------

interface ServiceMeta {
  label: string;
  icon: IconComponent;
}

const SERVICE_LABELS: Record<string, ServiceMeta> = {
  gateway:    { label: "API Gateway",      icon: PlugZapIcon },
  auth:       { label: "Authentication",   icon: PlugZapIcon },
  ingestion:  { label: "Data Ingestion",   icon: DatabaseIcon },
  ontology:   { label: "Data Ontology",    icon: DatabaseIcon },
  pipeline:   { label: "Pipeline Engine",  icon: GitBranchIcon },
  execution:  { label: "Execution Engine", icon: GitBranchIcon },
  app:        { label: "App Runtime",      icon: LayoutGridIcon },
  logging:    { label: "Logging Service",  icon: DatabaseIcon },
  plugin:     { label: "Plugin System",    icon: PlugZapIcon },
};

function getServiceLabel(raw: string): string {
  return SERVICE_LABELS[raw]?.label ?? raw.charAt(0).toUpperCase() + raw.slice(1);
}

function getServiceIcon(raw: string): IconComponent {
  return SERVICE_LABELS[raw]?.icon ?? PlugZapIcon;
}

// ---------------------------------------------------------------------------
// Widget ordering — persisted in localStorage
// ---------------------------------------------------------------------------

type WidgetId = "pipelines" | "activity" | "health";
const DEFAULT_WIDGET_ORDER: WidgetId[] = ["pipelines", "activity", "health"];
const WIDGET_ORDER_KEY = "oneplatform.dashboard.widget-order";

function loadWidgetOrder(): WidgetId[] {
  try {
    const raw = localStorage.getItem(WIDGET_ORDER_KEY);
    if (raw === null) return DEFAULT_WIDGET_ORDER;
    const parsed = JSON.parse(raw) as WidgetId[];
    // Validate: must contain exactly the known widget IDs
    if (!Array.isArray(parsed) || parsed.length !== DEFAULT_WIDGET_ORDER.length) return DEFAULT_WIDGET_ORDER;
    for (const id of DEFAULT_WIDGET_ORDER) {
      if (!parsed.includes(id)) return DEFAULT_WIDGET_ORDER;
    }
    return parsed;
  } catch {
    return DEFAULT_WIDGET_ORDER;
  }
}

function saveWidgetOrder(order: WidgetId[]): void {
  try {
    localStorage.setItem(WIDGET_ORDER_KEY, JSON.stringify(order));
  } catch {
    // localStorage unavailable — non-fatal
  }
}

// ---------------------------------------------------------------------------
// DashboardPage component
// ---------------------------------------------------------------------------

export default function DashboardPage() {
  const client = useApiClient();

  // Real-time: invalidate pipeline queries on SSE events
  usePlatformEvents(["pipeline.*", "ingestion.*"]);

  // Whether the user has manually dismissed the Quick Start panel this session.
  // Initialise from localStorage so the choice persists across reloads.
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem(QUICK_START_DISMISSED_KEY) === "true",
  );

  function handleDismiss() {
    localStorage.setItem(QUICK_START_DISMISSED_KEY, "true");
    setDismissed(true);
  }

  // ---------------------------------------------------------------------------
  // Quick Start resource-count queries (M-21)
  //
  // These share query keys with the full list pages (["connectors"], ["ontology"],
  // ["pipelines"], ["apps"]), so TanStack Query deduplicates the network requests
  // when the user navigates back from a list page to the dashboard.
  //
  // staleTime: 30_000 — these counts only matter for the first-run banner and
  // change infrequently; a 30-second window avoids redundant refetches.
  //
  // We only need total count, but the paginated endpoint is the only stable one.
  // The `limit=1` param minimises payload size while still returning the
  // pagination.total field that most list endpoints populate.
  // ---------------------------------------------------------------------------

  const { data: connectorsData, isLoading: connectorsLoading } = useQuery({
    queryKey: ["connectors"],
    queryFn: () =>
      client.get<PaginatedResponse<{ id: string }>>("/v1/connectors", { limit: 1 }),
    staleTime: 30_000,
  });

  const { data: ontologyData, isLoading: ontologyLoading } = useQuery({
    queryKey: ["ontology"],
    queryFn: () =>
      client.get<PaginatedResponse<{ id: string }>>("/v1/ontology", { limit: 1 }),
    staleTime: 30_000,
  });

  const { data: pipelinesData, isLoading: pipelinesLoading } = useQuery({
    queryKey: ["pipelines"],
    queryFn: () =>
      client.get<PaginatedResponse<PipelineSummary>>("/v1/pipelines", { limit: 1 }),
    staleTime: 10_000,
  });

  const { data: appsData, isLoading: appsLoading } = useQuery({
    queryKey: ["apps"],
    queryFn: ({ signal }) =>
      client.get<PaginatedResponse<{ id: string }>>("/v1/apps", undefined, { signal }),
    staleTime: 30_000,
  });

  // ---------------------------------------------------------------------------
  // Active / recent pipelines panel (reuses the pipelinesData query above,
  // but we need the full list — if pipelinesData only fetched limit=1 we'd
  // show at most one row. We fetch the full list for the Active Pipelines panel
  // separately so the two concerns don't constrain each other.
  // ---------------------------------------------------------------------------

  const { data: pipelinesListData, isLoading: pipelinesListLoading } = useQuery({
    queryKey: ["pipelines", "dashboard-list"],
    queryFn: () =>
      client.get<PaginatedResponse<PipelineSummary>>("/v1/pipelines"),
    staleTime: 10_000,
  });

  // Recent activity
  const { data: activityData, isLoading: activityLoading } = useQuery({
    queryKey: ["activity-feed"],
    queryFn: () =>
      client.get<PaginatedResponse<ActivityEvent>>("/v1/logs", { limit: 20, sort: "-createdAt" }),
    staleTime: 10_000,
  });

  // ---------------------------------------------------------------------------
  // Derive checklist counts from settled query data.
  //
  // We use the pagination.total field when present (most accurate); fall back to
  // data.length for endpoints that omit it. A count of 0 means "nothing exists".
  // We keep Quick Start visible while any count query is still loading to avoid
  // a flash where the panel briefly disappears then reappears.
  // ---------------------------------------------------------------------------

  function resolveCount(
    result: PaginatedResponse<{ id: string }> | undefined,
  ): number {
    if (result === undefined) return 0;
    // Use server-side total when available — more accurate than page length
    if (result.pagination.total !== null) return result.pagination.total;
    return result.data.length;
  }

  const connectorCount = resolveCount(connectorsData);
  const entityCount = resolveCount(ontologyData);
  const pipelineCount = resolveCount(pipelinesData as PaginatedResponse<{ id: string }> | undefined);
  const appCount = resolveCount(appsData);

  const checklist_loading =
    connectorsLoading || ontologyLoading || pipelinesLoading || appsLoading;

  // Show Quick Start until the user has at least one of every resource type or
  // has explicitly dismissed it. While loading, preserve the previous state
  // (dismissed flag already guards that case).
  const allStepsComplete =
    connectorCount > 0 &&
    entityCount > 0 &&
    pipelineCount > 0 &&
    appCount > 0;

  const showQuickStart = !dismissed && !checklist_loading && !allStepsComplete;

  const pipelines = pipelinesListData?.data ?? [];
  const activities = activityData?.data ?? [];

  // Widget ordering state — persisted across reloads
  const [widgetOrder, setWidgetOrder] = useState<WidgetId[]>(loadWidgetOrder);

  const moveWidget = useCallback((index: number, direction: -1 | 1) => {
    setWidgetOrder((prev) => {
      const target = index + direction;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev] as WidgetId[];
      const a = next[index] as WidgetId;
      const b = next[target] as WidgetId;
      next[index] = b;
      next[target] = a;
      saveWidgetOrder(next);
      return next;
    });
  }, []);

  // Widget render map — keyed by widget ID
  const widgetRenderers: Record<WidgetId, (index: number) => React.ReactNode> = {
    pipelines: (index) => (
      <WidgetCard key="pipelines" widgetId="pipelines" label="Active Pipelines" index={index} total={widgetOrder.length} onMove={moveWidget}>
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
          {pipelinesListLoading ? (
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
              <Link
                to="/pipelines"
                className="text-[var(--color-primary)] hover:underline"
              >
                Create one
              </Link>
            </p>
          ) : (
            <ul className="divide-y divide-[var(--color-border)]" role="list">
              {pipelines.slice(0, 8).map((pipeline) => (
                <li
                  key={pipeline.id}
                  className="flex items-center justify-between py-2.5"
                >
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
      </WidgetCard>
    ),
    activity: (index) => (
      <WidgetCard key="activity" widgetId="activity" label="Recent Activity" index={index} total={widgetOrder.length} onMove={moveWidget}>
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
            <p className="text-sm text-[var(--color-muted-foreground)]">
              No recent activity.
            </p>
          ) : (
            <ul className="divide-y divide-[var(--color-border)]" role="list">
              {activities.map((event) => (
                <li key={event.id} className="flex items-start gap-2 py-2">
                  <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
                    <Badge className={LEVEL_CLASSES[event.level]}>
                      {event.level}
                    </Badge>
                    {(() => {
                      const SvcIcon = getServiceIcon(event.service);
                      return (
                        <span className="inline-flex items-center gap-1 text-xs text-[var(--color-muted-foreground)]" title={event.service}>
                          <SvcIcon className="h-3 w-3 shrink-0" aria-hidden />
                          {getServiceLabel(event.service)}
                        </span>
                      );
                    })()}
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
      </WidgetCard>
    ),
    health: (index) => (
      <WidgetCard key="health" widgetId="health" label="Service Health" index={index} total={widgetOrder.length} onMove={moveWidget} fullWidth>
        <CardHeader>
          <CardTitle className="text-base">Service Health</CardTitle>
          <CardDescription>
            Status of all platform services. Refreshes every 30 seconds.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ServiceHealthGrid />
        </CardContent>
      </WidgetCard>
    ),
  };

  // Separate grid-paired widgets from full-width ones for layout
  const gridWidgets = widgetOrder.filter((id) => id !== "health");
  const fullWidthWidgets = widgetOrder.filter((id) => id === "health");

  return (
    <div className="flex-1">
      <header className="border-b border-[var(--color-border)] bg-[var(--color-background)] px-6 py-4">
        <h1 className="text-2xl font-bold tracking-tight">Overview</h1>
      </header>

      <div className="p-6 space-y-6">
        {/* Quick Start — shown to new users who haven't finished onboarding (M-21) */}
        {showQuickStart && (
          <QuickStartPanel
            connectorCount={connectorCount}
            entityCount={entityCount}
            pipelineCount={pipelineCount}
            appCount={appCount}
            onDismiss={handleDismiss}
          />
        )}

        <div className="grid gap-6 lg:grid-cols-2">
          {gridWidgets.map((id) => widgetRenderers[id](widgetOrder.indexOf(id)))}
        </div>

        {fullWidthWidgets.map((id) => widgetRenderers[id](widgetOrder.indexOf(id)))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// WidgetCard — wrapper that adds reorder controls to each dashboard widget
// ---------------------------------------------------------------------------

interface WidgetCardProps {
  widgetId: WidgetId;
  label: string;
  index: number;
  total: number;
  onMove: (index: number, direction: -1 | 1) => void;
  fullWidth?: boolean;
  children: React.ReactNode;
}

function WidgetCard({ widgetId, label, index, total, onMove, fullWidth, children }: WidgetCardProps) {
  return (
    <Card className={`group/widget relative ${fullWidth ? "lg:col-span-2" : ""}`}>
      {/* Reorder controls — visible on hover */}
      <div className="absolute -left-1 top-2 z-10 flex flex-col items-center gap-0.5 opacity-0 group-hover/widget:opacity-100 transition-opacity">
        <GripVertical className="h-3.5 w-3.5 text-[var(--color-muted-foreground)]" aria-hidden="true" />
        <button
          type="button"
          onClick={() => onMove(index, -1)}
          disabled={index === 0}
          className="rounded p-0.5 text-[var(--color-muted-foreground)] hover:bg-[var(--color-muted)] hover:text-[var(--color-foreground)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          aria-label={`Move ${label} up`}
          title="Move up"
        >
          <ChevronUp className="h-3 w-3" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => onMove(index, 1)}
          disabled={index === total - 1}
          className="rounded p-0.5 text-[var(--color-muted-foreground)] hover:bg-[var(--color-muted)] hover:text-[var(--color-foreground)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          aria-label={`Move ${label} down`}
          title="Move down"
        >
          <ChevronDown className="h-3 w-3" aria-hidden="true" />
        </button>
      </div>
      {children}
    </Card>
  );
}
