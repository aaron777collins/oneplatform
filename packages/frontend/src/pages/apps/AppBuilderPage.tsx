/**
 * AppBuilderPage — visual drag-and-drop app builder.
 *
 * Route: /apps/:id/build
 *
 * Full-viewport layout (same pattern as AppEditorPage) because the builder
 * needs all available space for the canvas + palette + config panel.
 *
 * On "Open in editor" the generated React code is injected into the VFS
 * at /src/App.tsx and the user is navigated to the Monaco editor.
 */

import * as React from "react";
import { useParams, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton.js";
import { AppBuilderCanvas } from "@/components/app-builder/AppBuilderCanvas.js";
import { useBuilderStore } from "@/components/app-builder/builder.store.js";
import { useApiClient, ApiError } from "@/lib/api-client.js";
import { toast } from "@/hooks/use-toast.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AppMeta {
  id: string;
  name: string;
  slug: string;
}

// ---------------------------------------------------------------------------
// AppBuilderPage
// ---------------------------------------------------------------------------

export function AppBuilderPage() {
  const { id } = useParams({ from: "/authenticated/apps/$id/build" });
  const navigate = useNavigate();
  const client = useApiClient();
  const queryClient = useQueryClient();
  const resetLayout = useBuilderStore((s) => s.resetLayout);

  const query = useQuery({
    queryKey: ["apps", id, "meta"],
    queryFn: ({ signal }) =>
      client.get<{ data: AppMeta }>(`/v1/apps/${id}`, undefined, { signal }),
  });

  // Reset builder state when the app id changes so stale layouts are not shown
  React.useEffect(() => {
    resetLayout();
  // resetLayout is a stable Zustand action reference
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Save generated code to the app VFS and navigate to Monaco editor
  const openInEditorMutation = useMutation({
    mutationFn: (code: string) =>
      client.put<{ data: { fileVersion: number } }>(
        `/v1/apps/${id}/files/${encodeURIComponent("/src/App.tsx")}`,
        { content: code, fileVersion: 0 },
      ),
    onSuccess: () => {
      toast({ title: "Layout exported to editor" });
      void queryClient.invalidateQueries({ queryKey: ["apps", id, "files"] });
      void navigate({ to: "/apps/$id/edit", params: { id } });
    },
    onError: (error) => {
      const message = error instanceof ApiError ? error.message : "Export failed.";
      toast({ title: "Export failed", description: message, variant: "destructive" });
    },
  });

  if (query.isLoading || query.data === undefined) {
    return (
      <div className="flex h-screen flex-col">
        <Skeleton className="h-10 w-full shrink-0" />
        <div className="flex flex-1 gap-0">
          <Skeleton className="h-full w-60 shrink-0" />
          <Skeleton className="h-full flex-1" />
          <Skeleton className="h-full w-72 shrink-0" />
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen overflow-hidden">
      {/* App name strip */}
      <div className="flex items-center gap-3 border-b border-[var(--color-border,#e5e7eb)] bg-[var(--color-background,#fff)] px-4 py-2 shrink-0 h-10">
        <button
          type="button"
          onClick={() => void navigate({ to: "/apps/$id", params: { id } })}
          className="text-xs text-[var(--color-muted-foreground,#6b7280)] hover:text-[var(--color-foreground,#111)] transition-colors"
          aria-label="Back to app detail"
        >
          {(() => {
            const appMeta = (query.data as unknown as { data?: { data: AppMeta } })?.data?.data ?? (query.data as { data: AppMeta } | undefined)?.data;
            return `← ${appMeta?.name ?? "App"}`;
          })()}
        </button>
        <span className="text-xs text-[var(--color-muted-foreground,#6b7280)]">/</span>
        <span className="text-xs font-medium text-[var(--color-foreground,#111)]">Visual Builder</span>
      </div>

      <AppBuilderCanvas
        className="h-[calc(100vh-2.5rem)]"
        onOpenInEditor={(code) => openInEditorMutation.mutate(code)}
      />
    </div>
  );
}
