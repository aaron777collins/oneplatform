/**
 * AppEditorPage — full-page Monaco editor view.
 *
 * Route: /apps/:id/edit
 *
 * This page overrides the standard AppShell layout — the Monaco editor
 * occupies the full viewport with its own toolbar (§10.1).
 *
 * Fetches app metadata to provide name and slug to the AppEditor component.
 * Initializes the editor store with the appId on mount.
 */
import * as React from "react";
import { useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton.js";
import { AppEditor } from "@/components/editor/AppEditor.js";
import { useEditorStore } from "@/stores/editor.store.js";
import { useApiClient } from "@/lib/api-client.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AppMeta {
  id: string;
  name: string;
  slug: string;
}

// ---------------------------------------------------------------------------
// AppEditorPage component
// ---------------------------------------------------------------------------

export function AppEditorPage() {
  const { id } = useParams({ from: "/authenticated/apps/$id/edit" });
  const client = useApiClient();
  const setAppId = useEditorStore((s) => s.setAppId);

  // Fetch app name and slug for the toolbar
  const query = useQuery({
    queryKey: ["apps", id, "meta"],
    queryFn: ({ signal }) =>
      client.get<{ data: AppMeta }>(`/v1/apps/${id}`, undefined, { signal }),
  });

  // Initialize editor store for this app on mount; clean up on unmount
  React.useEffect(() => {
    setAppId(id);
    return () => {
      // Don't reset on unmount — preserve open files if user navigates back quickly
    };
  // setAppId is a stable Zustand action reference
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (query.isLoading || query.data === undefined) {
    return (
      <div className="flex h-screen flex-col">
        <Skeleton className="h-10 w-full shrink-0" />
        <div className="flex flex-1 gap-0">
          <Skeleton className="h-full w-60 shrink-0" />
          <Skeleton className="h-full flex-1" />
          <Skeleton className="h-full w-80 shrink-0" />
        </div>
      </div>
    );
  }

  const app = (query.data as unknown as { data?: { data: AppMeta } })?.data?.data ?? (query.data as { data: AppMeta } | undefined)?.data ?? { name: "", slug: "" };

  return (
    // Full-viewport layout — overrides AppShell's main content area
    <div className="h-screen overflow-hidden">
      <AppEditor
        appId={id}
        appName={app.name}
        appSlug={app.slug}
        className="h-full"
      />
    </div>
  );
}
