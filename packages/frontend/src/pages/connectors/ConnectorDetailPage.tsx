/**
 * ConnectorDetailPage — shows a single connector's detail.
 * Tabs: Overview (config/status), Sync History, Settings (edit form).
 * Route: /connectors/$id
 */
import React, { useState } from "react";
import { useParams, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.js";
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
import { PageHeader } from "@/components/layout/PageHeader.js";
import { EmptyState } from "@/components/shared/EmptyState.js";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog.js";
import { RelativeTime } from "@/components/shared/RelativeTime.js";
import { ConnectorStatusBadge } from "@/components/connectors/ConnectorStatusBadge.js";
import { ConnectorForm, type ConnectorFormValues } from "@/components/connectors/ConnectorForm.js";
import { SyncProgressBar } from "@/components/connectors/SyncProgressBar.js";
import { useApiClient, type ApiResponse, ApiError } from "@/lib/api-client.js";
import { toast } from "@/hooks/use-toast.js";
import type { ConnectorStatus } from "@/components/connectors/ConnectorStatusBadge.js";
import type { ConnectorConfigSchema } from "@/components/connectors/ConnectorForm.js";

// ---------------------------------------------------------------------------
// API types
// ---------------------------------------------------------------------------

interface ConnectorDetail {
  id: string;
  name: string;
  typeName: string;
  status: ConnectorStatus;
  lastSyncAt?: string;
  activeSyncPercent?: number;
  activeSyncEta?: string;
  configSchema: ConnectorConfigSchema;
  config: ConnectorFormValues;
}

interface SyncRecord {
  id: string;
  status: "success" | "failed" | "running";
  startedAt: string;
  completedAt?: string;
  recordsIngested?: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// ConnectorDetailPage component
// ---------------------------------------------------------------------------

export function ConnectorDetailPage() {
  const { id } = useParams({ from: "/authenticated/connectors/$id" });
  const client = useApiClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [deleteOpen, setDeleteOpen] = useState(false);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["connectors", id],
    queryFn: () => client.get<ApiResponse<ConnectorDetail>>(`/v1/connectors/${id}`),
  });

  const { data: syncsData, isLoading: syncsLoading } = useQuery({
    queryKey: ["connectors", id, "syncs"],
    queryFn: () => client.get<{ data: SyncRecord[] }>(`/v1/connectors/${id}/syncs`),
  });

  const triggerSync = useMutation({
    mutationFn: () => client.post<void>(`/v1/connectors/${id}/trigger`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["connectors", id] });
      toast({ title: "Sync triggered" });
    },
  });

  const updateConnector = useMutation({
    mutationFn: (values: ConnectorFormValues) =>
      client.patch<ApiResponse<ConnectorDetail>>(`/v1/connectors/${id}`, { config: values }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["connectors", id] });
      toast({ title: "Connector updated" });
    },
    onError: (err) => {
      const message = err instanceof ApiError ? err.message : "Failed to update connector";
      toast({ title: message, variant: "destructive" });
    },
  });

  const deleteConnector = useMutation({
    mutationFn: () => client.delete(`/v1/connectors/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["connectors"] });
      toast({ title: "Connector deleted" });
      void navigate({ to: "/connectors" });
    },
  });

  const connector = data?.data;

  if (isError) {
    return (
      <main id="main-content" tabIndex={-1} className="flex-1 p-6">
        <EmptyState
          title="Connector not found"
          description="The connector may have been deleted."
          actionLabel="Back to connectors"
          onAction={() => void navigate({ to: "/connectors" })}
        />
      </main>
    );
  }

  return (
    <main id="main-content" tabIndex={-1} className="flex-1 overflow-y-auto">
      <PageHeader
        title={isLoading ? "Loading…" : (connector?.name ?? id)}
        breadcrumbs={[
          { label: "Platform" },
          { label: "Connectors", href: "/connectors" },
          { label: connector?.name ?? id },
        ]}
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => triggerSync.mutate()}
              disabled={triggerSync.isPending || connector?.status === "disabled"}
              aria-busy={triggerSync.isPending}
            >
              <RefreshCw
                className={`h-4 w-4 ${triggerSync.isPending ? "animate-spin" : ""}`}
                aria-hidden
              />
              Sync now
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="text-[var(--color-destructive)] hover:bg-[var(--color-destructive)]/10"
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2 className="h-4 w-4" aria-hidden />
              Delete
            </Button>
          </div>
        }
      />

      <div className="p-6">
        {isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-10 w-64" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : connector !== undefined ? (
          <Tabs defaultValue="overview">
            <TabsList>
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="history">Sync History</TabsTrigger>
              <TabsTrigger value="settings">Settings</TabsTrigger>
            </TabsList>

            {/* Overview tab */}
            <TabsContent value="overview" className="mt-4 space-y-4">
              <div className="grid gap-4 sm:grid-cols-3">
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium text-[var(--color-muted-foreground)]">
                      Status
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ConnectorStatusBadge status={connector.status} />
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium text-[var(--color-muted-foreground)]">
                      Type
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="text-sm font-medium">{connector.typeName}</CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium text-[var(--color-muted-foreground)]">
                      Last sync
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {connector.lastSyncAt !== undefined ? (
                      <RelativeTime value={connector.lastSyncAt} className="text-sm" />
                    ) : (
                      <span className="text-sm text-[var(--color-muted-foreground)]">Never</span>
                    )}
                  </CardContent>
                </Card>
              </div>

              {connector.activeSyncPercent !== undefined && (
                <SyncProgressBar
                  percent={connector.activeSyncPercent}
                  {...(connector.activeSyncEta !== undefined
                    ? { estimatedCompletionAt: connector.activeSyncEta }
                    : {})}
                />
              )}
            </TabsContent>

            {/* Sync history tab */}
            <TabsContent value="history" className="mt-4">
              {syncsLoading ? (
                <Skeleton className="h-32 w-full" />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Status</TableHead>
                      <TableHead>Started</TableHead>
                      <TableHead>Duration</TableHead>
                      <TableHead className="text-right">Records</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(syncsData?.data ?? []).length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={4} className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">
                          No sync history yet.
                        </TableCell>
                      </TableRow>
                    ) : (
                      (syncsData?.data ?? []).map((sync) => (
                        <TableRow key={sync.id}>
                          <TableCell>
                            <Badge
                              className={
                                sync.status === "success"
                                  ? "bg-[var(--color-status-success)]/20 text-[var(--color-status-success)]"
                                  : sync.status === "failed"
                                  ? "bg-[var(--color-destructive)]/20 text-[var(--color-destructive)]"
                                  : "bg-[var(--color-status-warning)]/20 text-[var(--color-status-warning)]"
                              }
                            >
                              {sync.status}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <RelativeTime value={sync.startedAt} className="text-sm" />
                          </TableCell>
                          <TableCell className="text-sm">
                            {sync.completedAt !== undefined
                              ? `${Math.round((new Date(sync.completedAt).getTime() - new Date(sync.startedAt).getTime()) / 1000)}s`
                              : "—"}
                          </TableCell>
                          <TableCell className="text-right text-sm">
                            {sync.recordsIngested ?? "—"}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              )}
            </TabsContent>

            {/* Settings tab */}
            <TabsContent value="settings" className="mt-4 max-w-lg">
              <ConnectorForm
                schema={connector.configSchema}
                defaultValues={connector.config}
                onSubmit={(values) => updateConnector.mutate(values)}
                isSubmitting={updateConnector.isPending}
                submitLabel="Save settings"
              />
            </TabsContent>
          </Tabs>
        ) : null}
      </div>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete connector?"
        description="All sync history and credentials for this connector will be permanently deleted. This cannot be undone."
        confirmLabel="Delete connector"
        onConfirm={() => deleteConnector.mutate()}
        isLoading={deleteConnector.isPending}
      />
    </main>
  );
}
