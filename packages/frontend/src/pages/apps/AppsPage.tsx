/**
 * AppsPage — grid of app cards with search and access mode filter.
 *
 * Route: /apps
 *
 * Provides a "New App" button that opens a TemplatePickerDialog (G-075).
 */
import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Plus, Search, LayoutGrid } from "lucide-react";

// Cast Lucide icons to avoid exactOptionalPropertyTypes conflict on className
type IconComponent = React.ComponentType<{ className?: string }>;
const LayoutGridIcon = LayoutGrid as IconComponent;
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Skeleton } from "@/components/ui/skeleton.js";
import { EmptyState } from "@/components/shared/EmptyState.js";
import { PageHeader } from "@/components/layout/PageHeader.js";
import { AppCard, type AppCardData, type AppAccessMode } from "@/components/apps/AppCard.js";
import { TemplatePickerDialog } from "@/components/apps/TemplatePickerDialog.js";
import { useApiClient } from "@/lib/api-client.js";
import type { PaginatedResponse } from "@/lib/api-client.js";

// ---------------------------------------------------------------------------
// AppsPage component
// ---------------------------------------------------------------------------

export function AppsPage() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [search, setSearch] = React.useState("");
  const [accessFilter, setAccessFilter] = React.useState<AppAccessMode | "all">("all");
  const [dialogOpen, setDialogOpen] = React.useState(false);

  const query = useQuery({
    queryKey: ["apps"],
    queryFn: ({ signal }) =>
      client.get<PaginatedResponse<AppCardData>>("/v1/apps", undefined, { signal }),
  });

  const apps = query.data?.data ?? [];

  const filtered = React.useMemo(() => {
    const lower = search.toLowerCase();
    return apps.filter((app) => {
      if (accessFilter !== "all" && app.accessMode !== accessFilter) return false;
      if (lower !== "" && !app.name.toLowerCase().includes(lower) && !app.slug.includes(lower)) return false;
      return true;
    });
  }, [apps, search, accessFilter]);

  return (
    <div className="flex-1 p-6">
      <PageHeader
        title="Apps"
        description="Custom dashboards and internal applications."
        actions={
          <Button onClick={() => setDialogOpen(true)}>
            <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
            New App
          </Button>
        }
      />

      {/* Filters */}
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <div className="relative min-w-0 flex-1 max-w-sm">
          <Search
            className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-muted-foreground)]"
            aria-hidden="true"
          />
          <Input
            placeholder="Search apps…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8"
            aria-label="Search apps"
          />
        </div>

        <div className="flex gap-1" role="group" aria-label="Filter by access mode">
          {(["all", "public", "platform-user"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setAccessFilter(mode)}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                accessFilter === mode
                  ? "border-[var(--color-primary)] bg-[var(--color-primary)] text-[var(--color-primary-foreground)]"
                  : "border-[var(--color-border)] hover:bg-[var(--color-muted)]"
              }`}
              aria-pressed={accessFilter === mode}
            >
              {mode === "all" ? "All" : mode === "public" ? "Public" : "Platform users"}
            </button>
          ))}
        </div>
      </div>

      {/* Grid */}
      {query.isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-40 w-full rounded-lg" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={LayoutGridIcon}
          title={apps.length === 0 ? "No apps yet" : "No apps match your filters"}
          {...(apps.length === 0 ? {
            description: "Create your first app to get started.",
            actionLabel: "New App",
            onAction: () => setDialogOpen(true),
          } : {})}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {filtered.map((app) => (
            <AppCard
              key={app.id}
              app={app}
              onClick={(id) => void navigate({ to: "/apps/$id", params: { id } })}
              onEdit={(id) => void navigate({ to: "/apps/$id/edit", params: { id } })}
            />
          ))}
        </div>
      )}

      {/* Template picker dialog — G-075 */}
      <TemplatePickerDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreated={(app) => {
          void queryClient.invalidateQueries({ queryKey: ["apps"] });
          void navigate({ to: "/apps/$id", params: { id: app.id } });
        }}
      />
    </div>
  );
}
