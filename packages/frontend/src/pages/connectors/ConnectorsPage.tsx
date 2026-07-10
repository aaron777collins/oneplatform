/**
 * ConnectorsPage — grid of connector cards with search/filter.
 *
 * Fetches GET /api/v1/connectors, renders ConnectorCard per result.
 * Trigger-sync calls POST /api/v1/connectors/{id}/trigger.
 * "New Connector" navigates to /connectors/new.
 */
import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Skeleton } from "@/components/ui/skeleton.js";
import { EmptyState } from "@/components/shared/EmptyState.js";
import { PageHeader } from "@/components/layout/PageHeader.js";
import { ConnectorCard, type ConnectorCardData } from "@/components/connectors/ConnectorCard.js";
import { useApiClient } from "@/lib/api-client.js";
import { toast } from "@/hooks/use-toast.js";
import type { ConnectorStatus } from "@/components/connectors/ConnectorStatusBadge.js";

// ---------------------------------------------------------------------------
// API types
// ---------------------------------------------------------------------------

/** Shape of a single connector row from the DB (snake_case). */
interface ConnectorRowApi {
  id: string;
  plugin_id: string;
  name: string;
  description: string | null;
  config: Record<string, unknown>;
  sync_mode: "full" | "incremental";
  schedule_cron: string | null;
  is_enabled: boolean;
  created_at: string;
  updated_at: string;
}

/** Shape of the sync-state row joined onto each connector. */
interface SyncStateRowApi {
  status: "never_run" | "running" | "success" | "failed" | "cancelled";
  last_sync_at: string | null;
  last_sync_job_id: string | null;
  rows_last_sync: string;
  rows_total: string;
}

/** Each item in the list endpoint is `{ connector, syncState }`. */
interface ConnectorWithSyncStateApi {
  connector: ConnectorRowApi;
  syncState: SyncStateRowApi;
}

/** The list endpoint returns `{ items/data, nextCursor, total }`. */
interface ConnectorListResponse {
  items: ConnectorWithSyncStateApi[];
  data: ConnectorWithSyncStateApi[];
  nextCursor: string | null;
  total: number;
}

/** Map sync-state status to the badge-level ConnectorStatus. */
function syncStatusToConnectorStatus(s: SyncStateRowApi["status"]): ConnectorStatus {
  switch (s) {
    case "running": return "syncing";
    case "success": return "active";
    case "failed": return "error";
    case "cancelled": return "disabled";
    case "never_run":
    default: return "disabled";
  }
}

function toCardData(record: ConnectorWithSyncStateApi): ConnectorCardData {
  const { connector, syncState } = record;
  return {
    id: connector.id,
    name: connector.name,
    typeName: connector.plugin_id,
    status: syncStatusToConnectorStatus(syncState.status),
    ...(syncState.last_sync_at !== null ? { lastSyncAt: syncState.last_sync_at } : {}),
  };
}

// ---------------------------------------------------------------------------
// ConnectorsPage component
// ---------------------------------------------------------------------------

export function ConnectorsPage() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["connectors"],
    queryFn: () => client.get<ConnectorListResponse>("/v1/connectors"),
  });

  const triggerSync = useMutation({
    mutationFn: (id: string) =>
      client.post<void>(`/v1/connectors/${id}/trigger`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["connectors"] });
      toast({ title: "Sync triggered", description: "The connector sync has started." });
    },
    onError: () => {
      toast({
        title: "Sync failed",
        description: "Could not trigger sync. Please try again.",
        variant: "destructive",
      });
    },
  });

  const inner = data?.data ?? data;
  const connectors: ConnectorWithSyncStateApi[] = Array.isArray(inner)
    ? inner
    : (inner as unknown as { items?: ConnectorWithSyncStateApi[] })?.items ?? [];

  const filtered = search.trim().length === 0
    ? connectors
    : connectors.filter((c) =>
        c.connector.name.toLowerCase().includes(search.toLowerCase()) ||
        c.connector.plugin_id.toLowerCase().includes(search.toLowerCase()),
      );

  return (
    <div className="flex-1 overflow-y-auto">
      <PageHeader
        title="Connectors"
        breadcrumbs={[{ label: "Platform" }, { label: "Connectors" }]}
        actions={
          <Button onClick={() => void navigate({ to: "/connectors/new" })}>
            <Plus className="h-4 w-4" aria-hidden />
            New connector
          </Button>
        }
      />

      <div className="p-6 space-y-4">
        {/* Search */}
        <div className="relative max-w-sm">
          <Search
            className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-muted-foreground)]"
            aria-hidden
          />
          <Input
            className="pl-9"
            placeholder="Search connectors…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search connectors"
          />
        </div>

        {/* Grid */}
        {isError ? (
          <EmptyState
            title="Failed to load connectors"
            description="Check your connection and try again."
            actionLabel="Retry"
            onAction={() => void refetch()}
          />
        ) : isLoading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="space-y-3 rounded-lg border border-[var(--color-border)] p-4">
                <Skeleton className="h-5 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-8 w-full" />
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            title={connectors.length === 0 ? "No connectors yet" : "No connectors match your search"}
            description={
              connectors.length === 0
                ? "Add your first connector to start ingesting data."
                : "Try a different search term."
            }
            {...(connectors.length === 0
              ? {
                  actionLabel: "Add connector",
                  onAction: () => void navigate({ to: "/connectors/new" }),
                }
              : {})}
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {filtered.map((item) => (
              <ConnectorCard
                key={item.connector.id}
                connector={toCardData(item)}
                onSync={(id) => triggerSync.mutate(id)}
                isSyncing={
                  triggerSync.isPending &&
                  triggerSync.variables === item.connector.id
                }
                onClick={(id) => void navigate({ to: "/connectors/$id", params: { id } })}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
