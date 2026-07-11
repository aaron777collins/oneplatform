/**
 * DLQPage — dead letter queue with search, queue filter, and bulk actions.
 *
 * Route: /dlq
 */
import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Search, RefreshCw, Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input.js";
import { Button } from "@/components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { PageHeader } from "@/components/layout/PageHeader.js";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog.js";
import { DLQTable } from "@/components/dlq/DLQTable.js";
import { useApiClient, ApiError } from "@/lib/api-client.js";
import { toast } from "@/hooks/use-toast.js";
import { usePermission } from "@/hooks/use-auth.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Bulk DLQ actions -- only visible to users with the "operator" role.
 */
function DLQBulkActions({
  bulkReplayMutation,
  onDiscardAll,
}: {
  bulkReplayMutation: { mutate: () => void; isPending: boolean };
  onDiscardAll: () => void;
}): React.ReactElement | null {
  const canManage = usePermission("operator");
  if (!canManage) return null;
  return (
    <div className="flex gap-2">
      <Button
        variant="outline"
        size="sm"
        onClick={() => bulkReplayMutation.mutate()}
        disabled={bulkReplayMutation.isPending}
        aria-busy={bulkReplayMutation.isPending}
      >
        <RefreshCw className="mr-1.5 h-4 w-4" aria-hidden="true" />
        {bulkReplayMutation.isPending ? "Replaying…" : "Replay all"}
      </Button>
      <Button
        variant="outline"
        size="sm"
        className="border-[var(--color-destructive)]/30 text-[var(--color-destructive)] hover:bg-[var(--color-destructive)]/10"
        onClick={onDiscardAll}
      >
        <Trash2 className="mr-1.5 h-4 w-4" aria-hidden="true" />
        Discard all
      </Button>
    </div>
  );
}

interface QueueInfo {
  name: string;
  depth: number;
}

// ---------------------------------------------------------------------------
// DLQPage component
// ---------------------------------------------------------------------------

export function DLQPage() {
  const client = useApiClient();
  const queryClient = useQueryClient();

  const [search, setSearch] = React.useState("");
  const [selectedQueue, setSelectedQueue] = React.useState<string | undefined>(undefined);
  const [bulkDiscardOpen, setBulkDiscardOpen] = React.useState(false);

  // Fetch available queues for the filter select
  const queuesQuery = useQuery({
    queryKey: ["dlq", "queues"],
    queryFn: ({ signal }) =>
      client.get<{ data: QueueInfo[] }>("/v1/metrics/queue-depths", undefined, { signal }),
    staleTime: 30_000,
  });

  const queuesInner = (queuesQuery.data as unknown as { data?: { data: QueueInfo[] } })?.data?.data ?? (queuesQuery.data as { data: QueueInfo[] } | undefined)?.data;
  const queues = queuesInner ?? [];

  // Bulk replay all jobs in the selected queue
  const bulkReplayMutation = useMutation({
    mutationFn: () =>
      client.post("/v1/dlq/bulk-replay", {
        ...(selectedQueue !== undefined ? { queueName: selectedQueue } : {}),
      }),
    onSuccess: () => {
      toast({ title: "All jobs requeued" });
      void queryClient.invalidateQueries({ queryKey: ["dlq"] });
    },
    onError: (error) => {
      const message = error instanceof ApiError ? error.message : "Bulk replay failed.";
      toast({ title: "Bulk replay failed", description: message, variant: "destructive" });
    },
  });

  const bulkDiscardMutation = useMutation({
    mutationFn: () =>
      client.delete("/v1/dlq/bulk", {
        ...(selectedQueue !== undefined ? { params: { queueName: selectedQueue } } : {}),
      } as Parameters<typeof client.delete>[1]),
    onSuccess: () => {
      toast({ title: "All jobs discarded" });
      void queryClient.invalidateQueries({ queryKey: ["dlq"] });
      setBulkDiscardOpen(false);
    },
    onError: (error) => {
      const message = error instanceof ApiError ? error.message : "Bulk discard failed.";
      toast({ title: "Bulk discard failed", description: message, variant: "destructive" });
      setBulkDiscardOpen(false);
    },
  });

  return (
    <div className="flex-1 p-6">
      <PageHeader
        title="Dead Letter Queue"
        description="Failed jobs that could not be automatically retried."
        actions={
          <DLQBulkActions
            bulkReplayMutation={bulkReplayMutation}
            onDiscardAll={() => setBulkDiscardOpen(true)}
          />
        }
      />

      {/* Filters */}
      <div className="mb-6 mt-4 flex flex-wrap items-center gap-3">
        <div className="relative min-w-0 max-w-sm flex-1">
          <Search
            className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-muted-foreground)]"
            aria-hidden="true"
          />
          <Input
            placeholder="Search jobs…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8"
            aria-label="Search DLQ jobs"
          />
        </div>

        <label htmlFor="queue-filter" className="sr-only">Filter by queue</label>
        <Select
          value={selectedQueue ?? "all"}
          onValueChange={(v) => setSelectedQueue(v === "all" ? undefined : v)}
        >
          <SelectTrigger id="queue-filter" className="w-44">
            <SelectValue placeholder="All queues" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All queues</SelectItem>
            {queues.map((q) => (
              <SelectItem key={q.name} value={q.name}>
                {q.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <DLQTable
        {...(selectedQueue !== undefined ? { queueName: selectedQueue } : {})}
        search={search}
      />

      <ConfirmDialog
        open={bulkDiscardOpen}
        onOpenChange={setBulkDiscardOpen}
        title="Discard all jobs?"
        description={
          selectedQueue !== undefined
            ? `Permanently delete all DLQ jobs in queue "${selectedQueue}". This cannot be undone.`
            : "Permanently delete ALL DLQ jobs across all queues. This cannot be undone."
        }
        confirmLabel="Discard all"
        onConfirm={() => bulkDiscardMutation.mutate()}
        isLoading={bulkDiscardMutation.isPending}
      />
    </div>
  );
}
