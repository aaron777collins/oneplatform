/**
 * AppDetailPage — app detail with three tabs: overview, builds, settings.
 *
 * Route: /apps/:id
 *
 * Overview: config, access mode, current build status.
 * Builds: BuildHistoryTable with diff action.
 * Settings: edit name, access mode, delete with confirm.
 */
import * as React from "react";
import { useParams, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Pencil, Code2, Trash2, Globe, Lock, ExternalLink, LayoutGrid, Share2 } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import { Button } from "@/components/ui/button.js";
import { Skeleton } from "@/components/ui/skeleton.js";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { PageHeader } from "@/components/layout/PageHeader.js";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog.js";
import { RelativeTime } from "@/components/shared/RelativeTime.js";
import { BuildHistoryTable } from "@/components/apps/BuildHistoryTable.js";
import { BuildStatusBadge } from "@/components/apps/BuildStatusBadge.js";
import { AppDeployButton } from "@/components/apps/AppDeployButton.js";
import { AppRollbackDialog } from "@/components/apps/AppRollbackDialog.js";
import { ShareDialog } from "@/components/apps/ShareDialog.js";
import { useApiClient, ApiError } from "@/lib/api-client.js";
import { toast } from "@/hooks/use-toast.js";
import type { AppCardData } from "@/components/apps/AppCard.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AppDetail extends AppCardData {
  createdAt: string;
  updatedAt: string;
}

const settingsSchema = z.object({
  name: z.string().min(1).max(64),
  accessMode: z.enum(["public", "platform-user"]),
});
type SettingsValues = z.infer<typeof settingsSchema>;

// ---------------------------------------------------------------------------
// AppDetailPage component
// ---------------------------------------------------------------------------

export function AppDetailPage() {
  const { id } = useParams({ from: "/authenticated/apps/$id" });
  const navigate = useNavigate();
  const client = useApiClient();
  const queryClient = useQueryClient();

  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [rollbackOpen, setRollbackOpen] = React.useState(false);
  const [shareOpen, setShareOpen] = React.useState(false);

  const query = useQuery({
    queryKey: ["apps", id],
    queryFn: ({ signal }) =>
      client.get<{ data: AppDetail }>(`/v1/apps/${id}`, undefined, { signal }),
  });

  const app = (query.data as unknown as { data?: { data: AppDetail } })?.data?.data ?? (query.data as { data: AppDetail } | undefined)?.data;

  const form = useForm<SettingsValues>({
    resolver: zodResolver(settingsSchema),
    values: app !== undefined
      ? { name: app.name, accessMode: app.accessMode }
      : { name: "", accessMode: "platform-user" },
  });

  const updateMutation = useMutation({
    mutationFn: (values: SettingsValues) =>
      client.patch<{ data: AppDetail }>(`/v1/apps/${id}`, values),
    onSuccess: () => {
      toast({ title: "App updated" });
      void queryClient.invalidateQueries({ queryKey: ["apps", id] });
      void queryClient.invalidateQueries({ queryKey: ["apps"] });
    },
    onError: (error) => {
      const message = error instanceof ApiError ? error.message : "Update failed.";
      toast({ title: "Update failed", description: message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => client.delete(`/v1/apps/${id}`),
    onSuccess: () => {
      toast({ title: "App deleted" });
      void queryClient.invalidateQueries({ queryKey: ["apps"] });
      void navigate({ to: "/apps" });
    },
    onError: (error) => {
      const message = error instanceof ApiError ? error.message : "Delete failed.";
      toast({ title: "Delete failed", description: message, variant: "destructive" });
    },
  });

  if (query.isError) {
    return (
      <div className="flex-1 p-6">
        <PageHeader
          title="App not found"
          breadcrumbs={[
            { label: "Platform" },
            { label: "Apps", href: "/apps" },
            { label: id },
          ]}
        />
        <div className="mt-6 rounded-lg border border-[var(--color-destructive)]/30 bg-[var(--color-destructive)]/5 p-4">
          <p className="text-sm text-[var(--color-destructive)]">
            {query.error instanceof ApiError
              ? query.error.message
              : "Failed to load app. It may have been deleted or you may not have access."}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => void navigate({ to: "/apps" })}
          >
            Back to apps
          </Button>
        </div>
      </div>
    );
  }

  if (query.isLoading || app === undefined) {
    return (
      <div className="flex-1 p-6">
        <Skeleton className="mb-6 h-10 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const AccessIcon = app.accessMode === "public" ? Globe : Lock;

  return (
    <div className="flex-1 p-6">
      <PageHeader
        title={app.name}
        description={`/${app.slug}`}
        actions={
          <div className="flex gap-2">
            {/* Visual Builder is the primary editing path for most users */}
            <Button
              onClick={() => void navigate({ to: "/apps/$id/build", params: { id } })}
            >
              <LayoutGrid className="mr-2 h-4 w-4" aria-hidden="true" />
              Visual Builder
            </Button>
            <Button
              variant="outline"
              onClick={() => void navigate({ to: "/apps/$id/edit", params: { id } })}
            >
              <Code2 className="mr-2 h-4 w-4" aria-hidden="true" />
              Code Editor (Advanced)
            </Button>
            <Button variant="outline" onClick={() => setShareOpen(true)}>
              <Share2 className="mr-2 h-4 w-4" aria-hidden="true" />
              Share
            </Button>
            <AppDeployButton appId={id} />
          </div>
        }
      />

      <Tabs defaultValue="overview" className="mt-6">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="builds">Builds</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>

        {/* Overview tab */}
        <TabsContent value="overview" className="mt-4 space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-4 space-y-3">
              <h3 className="text-sm font-semibold">Configuration</h3>
              <dl className="space-y-2 text-sm">
                <div className="flex gap-2">
                  <dt className="w-28 shrink-0 text-[var(--color-muted-foreground)]">Who can access</dt>
                  <dd className="flex items-center gap-1.5">
                    <AccessIcon className="h-3.5 w-3.5" aria-hidden="true" />
                    {app.accessMode === "public"
                      ? "Anyone with the link"
                      : "My team (logged-in users)"}
                  </dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-28 shrink-0 text-[var(--color-muted-foreground)]">App ID (URL)</dt>
                  <dd className="font-mono text-xs">/{app.slug}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-28 shrink-0 text-[var(--color-muted-foreground)]">Created</dt>
                  <dd><RelativeTime value={app.createdAt} /></dd>
                </div>
              </dl>
            </div>

            <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-4 space-y-3">
              <h3 className="text-sm font-semibold">Current Build</h3>
              <div className="flex items-center gap-3">
                {app.buildStatus !== undefined ? (
                  <BuildStatusBadge status={app.buildStatus} />
                ) : (
                  <span className="rounded-full bg-[var(--color-muted)] px-2 py-0.5 text-xs text-[var(--color-muted-foreground)]">
                    Not deployed
                  </span>
                )}
                {app.lastDeployedAt !== undefined && (
                  <span className="text-sm text-[var(--color-muted-foreground)]">
                    Deployed <RelativeTime value={app.lastDeployedAt} />
                  </span>
                )}
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setRollbackOpen(true)}
                >
                  Rollback…
                </Button>
                {app.lastDeployedAt !== undefined && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => window.open(`/apps/${app.slug}`, "_blank")}
                  >
                    <ExternalLink className="mr-1.5 h-4 w-4" aria-hidden="true" />
                    Open app
                  </Button>
                )}
              </div>
            </div>
          </div>
        </TabsContent>

        {/* Builds tab */}
        <TabsContent value="builds" className="mt-4">
          <BuildHistoryTable appId={id} />
        </TabsContent>

        {/* Settings tab */}
        <TabsContent value="settings" className="mt-4 max-w-md space-y-6">
          <div className="rounded-lg border border-[var(--color-border)] p-4">
            <h3 className="mb-4 text-sm font-semibold">General</h3>
            <Form {...form}>
              <form
                onSubmit={(e) => void form.handleSubmit((v) => updateMutation.mutate(v))(e)}
                className="space-y-4"
              >
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>App name</FormLabel>
                      <FormControl><Input {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="accessMode"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Access mode</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="platform-user">My team (logged-in users)</SelectItem>
                          <SelectItem value="public">Anyone with the link</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <Button type="submit" disabled={updateMutation.isPending} aria-busy={updateMutation.isPending}>
                  <Pencil className="mr-2 h-4 w-4" aria-hidden="true" />
                  {updateMutation.isPending ? "Saving…" : "Save changes"}
                </Button>
              </form>
            </Form>
          </div>

          {/* Danger zone */}
          <div className="rounded-lg border border-[var(--color-destructive)]/30 p-4">
            <h3 className="mb-2 text-sm font-semibold text-[var(--color-destructive)]">Danger zone</h3>
            <p className="mb-3 text-sm text-[var(--color-muted-foreground)]">
              Deleting this app removes all files, builds, and deployments permanently.
            </p>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2 className="mr-2 h-4 w-4" aria-hidden="true" />
              Delete app
            </Button>
          </div>
        </TabsContent>
      </Tabs>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete app"
        description={`Delete "${app.name}"? All files, builds, and deployments will be permanently removed.`}
        confirmLabel="Delete app"
        onConfirm={() => deleteMutation.mutate()}
        isLoading={deleteMutation.isPending}
      />

      <AppRollbackDialog
        appId={id}
        open={rollbackOpen}
        onOpenChange={setRollbackOpen}
      />

      <ShareDialog
        appId={id}
        appSlug={app.slug}
        currentAccessMode={app.accessMode}
        open={shareOpen}
        onOpenChange={setShareOpen}
      />
    </div>
  );
}
