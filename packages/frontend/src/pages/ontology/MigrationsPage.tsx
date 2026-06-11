/**
 * MigrationsPage — migration history table with apply/rollback actions.
 * Route: /ontology/migrations
 */
import React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "@/components/layout/PageHeader.js";
import { Skeleton } from "@/components/ui/skeleton.js";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog.js";
import { RelativeTime } from "@/components/shared/RelativeTime.js";
import { EmptyState } from "@/components/shared/EmptyState.js";
import { useApiClient, ApiError } from "@/lib/api-client.js";
import { toast } from "@/hooks/use-toast.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type MigrationStatus = "pending" | "running" | "applied" | "rolled_back" | "failed";

interface MigrationRecord {
  id: string;
  entityType: string;
  fromVersion: number;
  toVersion: number;
  status: MigrationStatus;
  startedAt?: string;
  completedAt?: string;
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

const STATUS_CLASSES: Record<MigrationStatus, string> = {
  pending: "bg-[var(--color-status-warning)]/20 text-[var(--color-status-warning)]",
  running: "bg-[var(--color-primary)]/20 text-[var(--color-primary)]",
  applied: "bg-[var(--color-status-success)]/20 text-[var(--color-status-success)]",
  rolled_back: "bg-[var(--color-muted)] text-[var(--color-muted-foreground)]",
  failed: "bg-[var(--color-destructive)]/20 text-[var(--color-destructive)]",
};

const STATUS_LABELS: Record<MigrationStatus, string> = {
  pending: "Pending",
  running: "Running",
  applied: "Applied",
  rolled_back: "Rolled back",
  failed: "Failed",
};

// ---------------------------------------------------------------------------
// MigrationsPage component
// ---------------------------------------------------------------------------

export function MigrationsPage() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const [rollbackTarget, setRollbackTarget] = React.useState<string | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["ontology-migrations"],
    queryFn: () => client.get<{ data: MigrationRecord[] }>("/v1/ontology/migrations"),
  });

  const applyMigration = useMutation({
    mutationFn: (migrationId: string) =>
      client.post(`/v1/ontology/migrations/${migrationId}/confirm`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["ontology-migrations"] });
      toast({ title: "Migration applied" });
    },
    onError: (err) => {
      const message = err instanceof ApiError ? err.message : "Failed to apply migration";
      toast({ title: message, variant: "destructive" });
    },
  });

  const rollbackMigration = useMutation({
    mutationFn: (migrationId: string) =>
      client.post(`/v1/ontology/migrations/${migrationId}/rollback`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["ontology-migrations"] });
      toast({ title: "Migration rolled back" });
      setRollbackTarget(null);
    },
    onError: (err) => {
      const message = err instanceof ApiError ? err.message : "Failed to roll back migration";
      toast({ title: message, variant: "destructive" });
    },
  });

  const migrations = data?.data ?? [];

  return (
    <div className="flex-1 overflow-y-auto">
      <PageHeader
        title="Migrations"
        breadcrumbs={[
          { label: "Platform" },
          { label: "Ontology", href: "/ontology" },
          { label: "Migrations" },
        ]}
      />

      <div className="p-6">
        {isError ? (
          <EmptyState
            title="Failed to load migrations"
            actionLabel="Retry"
            onAction={() => void refetch()}
          />
        ) : isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : migrations.length === 0 ? (
          <EmptyState
            title="No migrations"
            description="Schema migrations will appear here when entities are created or modified."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Entity</TableHead>
                <TableHead>Version change</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Completed</TableHead>
                <TableHead className="w-32" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {migrations.map((m) => (
                <TableRow key={m.id}>
                  <TableCell className="font-medium">{m.entityType}</TableCell>
                  <TableCell className="text-sm text-[var(--color-muted-foreground)]">
                    v{m.fromVersion} → v{m.toVersion}
                  </TableCell>
                  <TableCell>
                    <Badge className={STATUS_CLASSES[m.status]}>
                      {STATUS_LABELS[m.status]}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {m.startedAt !== undefined ? (
                      <RelativeTime value={m.startedAt} className="text-sm" />
                    ) : (
                      <span className="text-sm text-[var(--color-muted-foreground)]">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {m.completedAt !== undefined ? (
                      <RelativeTime value={m.completedAt} className="text-sm" />
                    ) : (
                      <span className="text-sm text-[var(--color-muted-foreground)]">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      {m.status === "pending" && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => applyMigration.mutate(m.id)}
                          disabled={applyMigration.isPending}
                        >
                          Apply
                        </Button>
                      )}
                      {m.status === "applied" && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-[var(--color-destructive)]"
                          onClick={() => setRollbackTarget(m.id)}
                        >
                          Rollback
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <ConfirmDialog
        open={rollbackTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRollbackTarget(null);
        }}
        title="Roll back migration?"
        description="This will revert the schema change. Data written against the new schema version may be affected."
        confirmLabel="Roll back"
        onConfirm={() => {
          if (rollbackTarget !== null) {
            rollbackMigration.mutate(rollbackTarget);
          }
        }}
        isLoading={rollbackMigration.isPending}
      />
    </div>
  );
}
