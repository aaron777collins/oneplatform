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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
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
  const [upgradeOpen, setUpgradeOpen] = React.useState(false);
  const [upgradeUrl, setUpgradeUrl] = React.useState("");

  const query = useQuery({
    queryKey: ["plugins", id],
    queryFn: ({ signal }) =>
      client.get<{ data: PluginDetailData }>(`/v1/plugins/${id}`, undefined, { signal }),
  });

  const plugin = (query.data as unknown as { data?: { data: PluginDetailData } })?.data?.data ?? (query.data as { data: PluginDetailData } | undefined)?.data;

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
    mutationFn: (toVersion: string) =>
      client.post(`/v1/plugins/${id}/upgrade`, { toVersion }),
    onSuccess: () => {
      toast({ title: "Upgrade initiated" });
      setUpgradeOpen(false);
      setUpgradeUrl("");
      void queryClient.invalidateQueries({ queryKey: ["plugins", id] });
    },
    onError: (error) => {
      const message = error instanceof ApiError ? error.message : "Upgrade failed.";
      toast({ title: "Upgrade failed", description: message, variant: "destructive" });
    },
  });

  if (query.isError) {
    return (
      <div className="flex-1 p-6">
        <div className="rounded-lg border border-[var(--color-destructive)]/30 bg-[var(--color-destructive)]/5 p-6 text-center">
          <p className="text-sm font-medium text-[var(--color-destructive)]">
            {query.error instanceof ApiError && query.error.statusCode === 404
              ? "Plugin not found"
              : "Failed to load plugin"}
          </p>
          <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">
            {query.error instanceof ApiError
              ? query.error.message
              : "An unexpected error occurred. Please try again."}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-4"
            onClick={() => void navigate({ to: "/plugins" })}
          >
            Back to plugins
          </Button>
        </div>
      </div>
    );
  }

  if (query.isLoading || plugin === undefined) {
    return (
      <div className="flex-1 p-6">
        <Skeleton className="mb-6 h-10 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="flex-1 p-6">
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
              Upgrade to a staged version of this plugin.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setUpgradeOpen(true)}
              disabled={upgradeMutation.isPending}
            >
              {upgradeMutation.isPending ? "Upgrading…" : "Upgrade…"}
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

      <Dialog
        open={upgradeOpen}
        onOpenChange={(open) => {
          setUpgradeOpen(open);
          if (!open) setUpgradeUrl("");
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Upgrade plugin</DialogTitle>
            <DialogDescription>
              Enter the target version to upgrade to. The version must already be staged (installed but not yet active).
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <Input
              placeholder="e.g. 2.0.0"
              value={upgradeUrl}
              onChange={(e) => setUpgradeUrl(e.target.value)}
              aria-label="Target version"
              onKeyDown={(e) => {
                if (e.key === "Enter" && upgradeUrl.trim() !== "") {
                  upgradeMutation.mutate(upgradeUrl.trim());
                }
              }}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setUpgradeOpen(false);
                setUpgradeUrl("");
              }}
              disabled={upgradeMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (upgradeUrl.trim() !== "") {
                  upgradeMutation.mutate(upgradeUrl.trim());
                }
              }}
              disabled={upgradeMutation.isPending || upgradeUrl.trim() === ""}
              aria-busy={upgradeMutation.isPending}
            >
              {upgradeMutation.isPending ? "Upgrading…" : "Upgrade"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
