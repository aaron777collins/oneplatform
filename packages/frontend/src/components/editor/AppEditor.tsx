/**
 * AppEditor — full-page three-panel Monaco editor layout.
 *
 * Panels: FileTree (left, resizable) | EditorPane (center) | PreviewPane (right, resizable).
 * Panel widths are persisted in localStorage per §11.1.
 *
 * File changes are debounced 500ms before calling PUT /api/v1/apps/:appId/files/:path.
 * Build is triggered via POST /api/v1/apps/:appId/builds; SSE log stream follows.
 *
 * This component owns the AppEditor layout. The EditorPane component handles
 * Monaco instantiation. This component handles the save/build/deploy orchestration.
 */
import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEditorStore } from "@/stores/editor.store.js";
import { useApiClient, ApiError } from "@/lib/api-client.js";
import { useBuildLogs } from "@/hooks/use-build-logs.js";
import { toast } from "@/hooks/use-toast.js";
import { debounce } from "@/lib/utils.js";
import { FileTree } from "./FileTree.js";
import { EditorPane } from "./EditorPane.js";
import { PreviewPane } from "./PreviewPane.js";
import { EditorToolbar } from "./EditorToolbar.js";
import { BuildErrorPanel, type BuildError } from "./BuildErrorPanel.js";
import { cn } from "@/lib/utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AppBuild {
  id: string;
  status: string;
  errorDetail?: BuildError[];
}

export interface AppEditorProps {
  appId: string;
  appName: string;
  appSlug: string;
  className?: string;
}

// ---------------------------------------------------------------------------
// Panel width persistence helpers
// ---------------------------------------------------------------------------

const STORAGE_KEY_FILE_TREE_WIDTH = "op-editor-file-tree-width";
const STORAGE_KEY_PREVIEW_WIDTH = "op-editor-preview-width";
const DEFAULT_FILE_TREE_WIDTH = 240;
const DEFAULT_PREVIEW_WIDTH = 380;

function getStoredWidth(key: string, defaultValue: number): number {
  try {
    const stored = localStorage.getItem(key);
    if (stored === null) return defaultValue;
    const parsed = parseInt(stored, 10);
    return isNaN(parsed) ? defaultValue : parsed;
  } catch {
    return defaultValue;
  }
}

function storeWidth(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // localStorage unavailable — non-fatal
  }
}

// ---------------------------------------------------------------------------
// AppEditor component
// ---------------------------------------------------------------------------

export function AppEditor({ appId, appName, appSlug, className }: AppEditorProps) {
  const client = useApiClient();
  const queryClient = useQueryClient();

  const editorStore = useEditorStore();

  // Refs keep the debounced callback from closing over stale client/store values
  const clientRef = React.useRef(client);
  clientRef.current = client;
  const storeRef = React.useRef(editorStore);
  storeRef.current = editorStore;
  const [activeBuildId, setActiveBuildId] = React.useState<string | null>(null);
  const [buildErrors, setBuildErrors] = React.useState<BuildError[]>([]);

  // Panel widths (resizable, persisted in localStorage)
  const [fileTreeWidth, setFileTreeWidth] = React.useState(() =>
    getStoredWidth(STORAGE_KEY_FILE_TREE_WIDTH, DEFAULT_FILE_TREE_WIDTH),
  );
  const [previewWidth, setPreviewWidth] = React.useState(() =>
    getStoredWidth(STORAGE_KEY_PREVIEW_WIDTH, DEFAULT_PREVIEW_WIDTH),
  );

  // Active file from editor store
  const activeFilePath = editorStore.activeFilePath;
  const activeFile = activeFilePath !== null ? editorStore.openFiles.get(activeFilePath) : undefined;

  // SSE build log streaming
  const buildLogs = useBuildLogs(appId, activeBuildId);

  // When a build completes, update the editor store and optionally show errors
  React.useEffect(() => {
    if (!buildLogs.isComplete) return;
    if (buildLogs.buildResult === "failed") {
      editorStore.setBuildStatus("failed");
      // TODO(PLAT-442): parse errors from buildLogs when error_detail is included in log events
    } else if (buildLogs.buildResult === "success") {
      editorStore.setBuildStatus("success");
      setBuildErrors([]);
      toast({ title: "Build succeeded" });
    }
  // editorStore is stable — no need to list individual actions as deps
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildLogs.isComplete, buildLogs.buildResult]);

  // Debounced auto-save: waits 500ms after last keystroke
  const debouncedSave = React.useMemo(
    () =>
      debounce(async (path: string, content: string, fileVersion: number) => {
        try {
          const encodedPath = path.split("/").map(encodeURIComponent).join("/");
          const result = await clientRef.current.put<{ data: { fileVersion: number } }>(
            `/v1/apps/${appId}/files/${encodedPath}`,
            { content, fileVersion },
          );
          storeRef.current.markSaved(path, result.data.fileVersion);
        } catch (err) {
          if (err instanceof ApiError && err.code === "APP_FILE_VERSION_CONFLICT") {
            toast({
              title: "Save conflict",
              description: "File modified elsewhere. Reload to merge changes.",
              variant: "destructive",
            });
          } else {
            toast({ title: "Save failed", variant: "destructive" });
          }
        }
      }, 500),
    // appId is the only dep that would require a new debounce instance
    [appId], // eslint-disable-line react-hooks/exhaustive-deps
  );

  function handleEditorChange(content: string) {
    if (activeFilePath === null) return;
    editorStore.markDirty(activeFilePath, content);
    if (activeFile !== undefined) {
      debouncedSave(activeFilePath, content, activeFile.fileVersion);
    }
  }

  function handleManualSave() {
    debouncedSave.cancel();
    if (activeFilePath === null || activeFile === undefined) return;
    void (async () => {
      try {
        const encodedPath = activeFilePath.split("/").map(encodeURIComponent).join("/");
        const result = await client.put<{ data: { fileVersion: number } }>(
          `/v1/apps/${appId}/files/${encodedPath}`,
          { content: activeFile.content, fileVersion: activeFile.fileVersion },
        );
        editorStore.markSaved(activeFilePath, result.data.fileVersion);
        toast({ title: "Saved" });
      } catch (err) {
        const message = err instanceof ApiError ? err.message : "Save failed.";
        toast({ title: "Save failed", description: message, variant: "destructive" });
      }
    })();
  }

  const buildMutation = useMutation({
    mutationFn: () =>
      client.post<{ data: AppBuild }>(`/v1/apps/${appId}/builds`),
    onSuccess: (response) => {
      const build = response.data;
      editorStore.setBuildStatus("building", build.id);
      setActiveBuildId(build.id);
      setBuildErrors([]);
      void queryClient.invalidateQueries({ queryKey: ["apps", appId, "builds"] });
    },
    onError: (error) => {
      const message = error instanceof ApiError ? error.message : "Build failed to start.";
      toast({ title: "Build error", description: message, variant: "destructive" });
    },
  });

  const deployMutation = useMutation({
    // POST to the deploy endpoint promotes the latest successful build to
    // production — distinct from /builds which creates a new build.
    mutationFn: () =>
      client.post<{ data: AppBuild }>(`/v1/apps/${appId}/deploy`),
    onSuccess: (response) => {
      const build = response.data;
      toast({ title: "Deploy started", description: `Build ${build.id.slice(0, 8)} queued.` });
      void queryClient.invalidateQueries({ queryKey: ["apps", appId, "builds"] });
    },
    onError: (error) => {
      const message = error instanceof ApiError ? error.message : "Deploy failed.";
      toast({ title: "Deploy failed", description: message, variant: "destructive" });
    },
  });

  function handleJumpToError(error: BuildError) {
    // Open the erroring file then set active; editor will handle line navigation
    // via Monaco's revealLine after the file content is loaded
    editorStore.setActiveFile(error.file);
  }

  // Drag handle for file tree resize
  function handleFileTreeDrag(e: React.MouseEvent) {
    const startX = e.clientX;
    const startWidth = fileTreeWidth;
    function onMove(ev: MouseEvent) {
      const newWidth = Math.max(120, Math.min(480, startWidth + ev.clientX - startX));
      setFileTreeWidth(newWidth);
      storeWidth(STORAGE_KEY_FILE_TREE_WIDTH, newWidth);
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  // Drag handle for preview pane resize
  function handlePreviewDrag(e: React.MouseEvent) {
    const startX = e.clientX;
    const startWidth = previewWidth;
    function onMove(ev: MouseEvent) {
      const newWidth = Math.max(200, Math.min(600, startWidth - (ev.clientX - startX)));
      setPreviewWidth(newWidth);
      storeWidth(STORAGE_KEY_PREVIEW_WIDTH, newWidth);
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  const buildStatus = editorStore.buildStatus === "idle"
    ? "idle" as const
    : editorStore.buildStatus;

  return (
    <div className={cn("flex h-full flex-col overflow-hidden", className)}>
      <EditorToolbar
        appName={appName}
        appSlug={appSlug}
        activeFilePath={activeFilePath}
        isDirty={activeFile?.isDirty ?? false}
        buildStatus={buildStatus}
        onSave={handleManualSave}
        onBuild={() => buildMutation.mutate()}
        onDeploy={() => deployMutation.mutate()}
      />

      {/* Three-panel layout */}
      <div className="flex min-h-0 flex-1">
        {/* Left: File tree */}
        <div style={{ width: fileTreeWidth }} className="shrink-0">
          <FileTree
            appId={appId}
            activePath={activeFilePath}
            onFileOpen={(path, content, fileVersion) => {
              editorStore.openFile(path, content, fileVersion);
            }}
            className="h-full"
          />
        </div>

        {/* Drag handle: file tree resize */}
        <div
          className="w-1 cursor-col-resize bg-[var(--color-border)] hover:bg-[var(--color-primary)]/40 transition-colors"
          onMouseDown={handleFileTreeDrag}
          role="separator"
          aria-label="Resize file tree"
        />

        {/* Center: Monaco editor */}
        <div className="flex min-w-0 flex-1 flex-col">
          <EditorPane
            appId={appId}
            filePath={activeFilePath}
            content={activeFile?.content ?? ""}
            onChange={handleEditorChange}
            className="flex-1"
          />
          {buildErrors.length > 0 && (
            <BuildErrorPanel
              errors={buildErrors}
              onJumpToError={handleJumpToError}
            />
          )}
        </div>

        {/* Drag handle: preview resize */}
        <div
          className="w-1 cursor-col-resize bg-[var(--color-border)] hover:bg-[var(--color-primary)]/40 transition-colors"
          onMouseDown={handlePreviewDrag}
          role="separator"
          aria-label="Resize preview pane"
        />

        {/* Right: Preview */}
        <div style={{ width: previewWidth }} className="shrink-0">
          <PreviewPane appSlug={appSlug} className="h-full" />
        </div>
      </div>
    </div>
  );
}
