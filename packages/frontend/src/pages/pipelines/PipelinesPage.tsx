/**
 * PipelinesPage — pipeline list with cards, search, and "New Pipeline" button.
 * Route: /pipelines
 */
import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Skeleton } from "@/components/ui/skeleton.js";
import { PageHeader } from "@/components/layout/PageHeader.js";
import { EmptyState } from "@/components/shared/EmptyState.js";
import { PipelineCard, type PipelineCardData, type TriggerType } from "@/components/pipelines/PipelineCard.js";
import { useApiClient, type PaginatedResponse } from "@/lib/api-client.js";

// ---------------------------------------------------------------------------
// API types — the list endpoint returns { pipeline: PipelineRow, lastRunAt }
// ---------------------------------------------------------------------------

interface PipelineRow {
  id: string;
  name: string;
  slug: string;
  description?: string;
  definition?: { steps?: Array<{ type?: string }> };
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface PipelineListItem {
  pipeline: PipelineRow;
  lastRunAt?: string | null;
}

function toCardData(item: PipelineListItem): PipelineCardData {
  const p = item.pipeline;
  return {
    id: p.id,
    name: p.name,
    triggerType: "manual" as TriggerType,
    ...(item.lastRunAt ? { lastRunAt: item.lastRunAt } : {}),
  };
}

// ---------------------------------------------------------------------------
// PipelinesPage component
// ---------------------------------------------------------------------------

export function PipelinesPage() {
  const client = useApiClient();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["pipelines"],
    queryFn: () => client.get<PaginatedResponse<PipelineListItem>>("/v1/pipelines"),
  });

  const items: PipelineListItem[] = data?.data ?? [];
  const filtered = search.trim().length === 0
    ? items
    : items.filter((item) => item.pipeline.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="flex-1 overflow-y-auto">
      <PageHeader
        title="Pipelines"
        breadcrumbs={[{ label: "Platform" }, { label: "Pipelines" }]}
        actions={
          <Button onClick={() => void navigate({ to: "/pipelines/new" })}>
            <Plus className="h-4 w-4" aria-hidden />
            New pipeline
          </Button>
        }
      />

      <div className="p-6 space-y-4">
        <div className="relative max-w-sm">
          <Search
            className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-muted-foreground)]"
            aria-hidden
          />
          <Input
            className="pl-9"
            placeholder="Search pipelines…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search pipelines"
          />
        </div>

        {isError ? (
          <EmptyState
            title="Failed to load pipelines"
            actionLabel="Retry"
            onAction={() => void refetch()}
          />
        ) : isLoading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="space-y-3 rounded-lg border border-[var(--color-border)] p-4">
                <Skeleton className="h-5 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-4 w-2/3" />
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            title={items.length === 0 ? "No pipelines yet" : "No pipelines match your search"}
            description={
              items.length === 0
                ? "Create your first pipeline to automate data processing."
                : "Try a different search term."
            }
            {...(items.length === 0
              ? {
                  actionLabel: "New pipeline",
                  onAction: () => void navigate({ to: "/pipelines/new" }),
                }
              : {})}
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {filtered.map((item) => (
              <PipelineCard
                key={item.pipeline.id}
                pipeline={toCardData(item)}
                onClick={(id) => void navigate({ to: "/pipelines/$id", params: { id } })}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
