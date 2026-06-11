/**
 * PluginDetailPage — detail view for a single plugin.
 *
 * Route: /plugins/:id
 *
 * Tabs: overview, instances (per-tenant), config, actions (upgrade/uninstall).
 */
import * as React from "react";
import { useParams } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import { Button } from "@/components/ui/button.js";
import { Skeleton } from "@/components/ui/skeleton.js";
import { PageHeader } from "@/components/layout/PageHeader.js";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog.js";
import { RelativeTime } from "@/components/shared/RelativeTime.js";
import { PluginStatusBadge } from "@/components/plugins/PluginStatusBadge.js";
import { PluginConfigForm } from "@/components/plugins/PluginConfigForm.js";
import { useApiClient, ApiError } from "@/lib/api-client.js";
import { toast } from "@/hooks/use-toast.js";
import type { PluginCardData } from "@/components/plugins/PluginCard.js";
import type { ConnectorConfigSchema, ConnectorFormValues } from "@/components/connectors/ConnectorForm.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PluginInstance {
  id: string;
  tenantId: string;
  status: string;
  configuredAt: string;
}

interface PluginDetailData extends PluginCardData {
  createdAt: string;
  configSchema?: ConnectorConfigSchema;
  currentConfig?: ConnectorFormValues;
  instances?: PluginInstance[];
}

// ---------------------------------------------------------------------------
// PluginDetailPage component
// ---------------------------------------------------------------------------

export function PluginDetailPage() {
  const { id } = useParams({ from: "/authenticated/plugins/$id" });
  const navigate = useNavigate();
  const client = useApiClient();
  const queryClient = useQueryClient();

  const [uninstallOpen, setUninstallOpen] = React.useState(false);

  const query = useQuery({
    queryKey: ["plugins", id],
    queryFn: ({ signal }) =>
      client.get<{ data: PluginDetailData }>(`/v1/plugins/${id}`, undefined, { signal }),
  });

  const plugin = query.data?.data;

  const updateConfigMutation = useMutation({
    mutationFn: (values: ConnectorFormValues) =>
      client.patch(`/v1/plugins/${id}/config`, values),
    onSuccess: () => {
      toast({ title: "Plugin config updated" });
      void queryClient.invalidateQueries({ queryKey: ["plugins", id] });
    },
    onError: (error) => {
      const message = error instanceof ApiError ? error.message : "Config update failed.";
      toast({ title: "Config update failed", description: message, variant: "destructive" });
    },
  });

  const uninstallMutation = useMutation({
    mutationFn: () => client.delete(`/v1/plugins/${id}`),
    onSuccess: () => {
      toast({ title: "Plugin uninstalled" });
      void queryClient.invalidateQueries({ queryKey: ["plugins"] });
      void navigate({ to: "/plugins" });
    },
    onError: (error) => {
      const message = error instanceof ApiError ? error.message : "Uninstall failed.";
      toast({ title: "Uninstall failed", description: message, variant: "destructive" });
    },
  });

  const upgradeMutation = useMutation({
    mutationFn: (url: string) =>
      client.post(`/v1/plugins/${id}/upgrade`, { sourceUrl: url }),
    onSuccess: () => {
      toast({ title: "Upgrade initiated" });
      void queryClient.invalidateQueries({ queryKey: ["plugins", id] });
    },
    onError: (error) => {
      const message = error instanceof ApiError ? error.message : "Upgrade failed.";
      toast({ title: "Upgrade failed", description: message, variant: "destructive" });
    },
  });

  if (query.isLoading || plugin === undefined) {
    return (
      <main id="main-content" tabIndex={-1} className="flex-1 p-6">
        <Skeleton className="mb-6 h-10 w-64" />
        <Skeleton className="h-64 w-full" />
      </main>
    );
  }

  return (
    <main id="main-content" tabIndex={-1} className="flex-1 p-6">
      <PageHeader
        title={plugin.name}
        description={`${plugin.type} · v${plugin.version} · by ${plugin.author}`}
        actions={<PluginStatusBadge status={plugin.status} />}
      />

      <Tabs defaultValue="overview" className="mt-6">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="instances">Instances</TabsTrigger>
          {plugin.configSchema !== undefined && (
            <TabsTrigger value="config">Config</TabsTrigger>
          )}
          <TabsTrigger value="actions">Actions</TabsTrigger>
        </TabsList>

        {/* Overview */}
        <TabsContent value="overview" className="mt-4">
          <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-4 space-y-2 max-w-lg">
            <dl className="space-y-2 text-sm">
              <div className="flex gap-2">
                <dt className="w-24 shrink-0 text-[var(--color-muted-foreground)]">Type</dt>
                <dd>{plugin.type}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-24 shrink-0 text-[var(--color-muted-foreground)]">Version</dt>
                <dd>v{plugin.version}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-24 shrink-0 text-[var(--color-muted-foreground)]">Author</dt>
                <dd>{plugin.author}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-24 shrink-0 text-[var(--color-muted-foreground)]">Installed</dt>
                <dd><RelativeTime value={plugin.createdAt} /></dd>
              </div>
              {plugin.description !== undefined && (
                <div className="flex gap-2">
                  <dt className="w-24 shrink-0 text-[var(--color-muted-foreground)]">Description</dt>
                  <dd>{plugin.description}</dd>
                </div>
              )}
            </dl>
          </div>
        </TabsContent>

        {/* Instances */}
        <TabsContent value="instances" className="mt-4">
          {plugin.instances === undefined || plugin.instances.length === 0 ? (
            <p className="text-sm text-[var(--color-muted-foreground)]">No instances configured.</p>
          ) : (
            <div className="space-y-2">
              {plugin.instances.map((instance) => (
                <div
                  key={instance.id}
                  className="flex items-center justify-between rounded-md border border-[var(--color-border)] px-3 py-2 text-sm"
                >
                  <span className="font-mono text-xs">{instance.tenantId}</span>
                  <span className="text-[var(--color-muted-foreground)]">
                    <RelativeTime value={instance.configuredAt} />
                  </span>
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        {/* Config */}
        {plugin.configSchema !== undefined && (
          <TabsContent value="config" className="mt-4 max-w-md">
            <PluginConfigForm
              schema={plugin.configSchema}
              {...(plugin.currentConfig !== undefined ? { defaultValues: plugin.currentConfig } : {})}
              onSubmit={(values) => updateConfigMutation.mutate(values)}
              isSubmitting={updateConfigMutation.isPending}
            />
          </TabsContent>
        )}

        {/* Actions */}
        <TabsContent value="actions" className="mt-4 max-w-md space-y-4">
          <div className="rounded-lg border border-[var(--color-border)] p-4 space-y-3">
            <h3 className="text-sm font-semibold">Upgrade</h3>
            <p className="text-sm text-[var(--color-muted-foreground)]">
              Provide a new plugin URL to upgrade to a later version.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const url = window.prompt("Enter upgrade URL:");
                if (url !== null && url.trim() !== "") {
                  upgradeMutation.mutate(url.trim());
                }
              }}
              disabled={upgradeMutation.isPending}
            >
              {upgradeMutation.isPending ? "Upgrading…" : "Upgrade from URL…"}
            </Button>
          </div>

          <div className="rounded-lg border border-[var(--color-destructive)]/30 p-4 space-y-3">
            <h3 className="text-sm font-semibold text-[var(--color-destructive)]">Danger zone</h3>
            <p className="text-sm text-[var(--color-muted-foreground)]">
              Uninstalling removes this plugin from all tenants permanently.
            </p>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setUninstallOpen(true)}
            >
              Uninstall plugin
            </Button>
          </div>
        </TabsContent>
      </Tabs>

      <ConfirmDialog
        open={uninstallOpen}
        onOpenChange={setUninstallOpen}
        title="Uninstall plugin"
        description={`Uninstall "${plugin.name}"? All instances across all tenants will be removed.`}
        confirmLabel="Uninstall"
        onConfirm={() => uninstallMutation.mutate()}
        isLoading={uninstallMutation.isPending}
      />
    </main>
  );
}
