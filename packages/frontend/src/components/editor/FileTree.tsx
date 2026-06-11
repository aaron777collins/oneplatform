/**
 * FileTree — VFS file browser for the Monaco editor's left panel.
 *
 * Fetches files from GET /api/v1/apps/:appId/files and renders a hierarchical
 * tree using FileTreeNode. Supports create file/folder, rename, and delete
 * via context menus. Clicking a file opens it in the editor.
 */
import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, FolderPlus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Skeleton } from "@/components/ui/skeleton.js";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog.js";
import { FileTreeNode, type FileNode } from "./FileTreeNode.js";
import { useApiClient, ApiError } from "@/lib/api-client.js";
import { toast } from "@/hooks/use-toast.js";
import { cn } from "@/lib/utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface VFSFile {
  path: string;
  isDirectory: boolean;
}

export interface FileTreeProps {
  appId: string;
  activePath: string | null;
  onFileOpen: (path: string, content: string, fileVersion: number) => void;
  className?: string;
}

// ---------------------------------------------------------------------------
// Path → tree builder
// ---------------------------------------------------------------------------

function buildTree(files: VFSFile[]): FileNode[] {
  const root: FileNode = { name: "", path: "", isDirectory: true, children: [] };

  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean);
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part === undefined) continue;
      const partPath = parts.slice(0, i + 1).join("/");
      const isLast = i === parts.length - 1;
      const isDir = isLast ? file.isDirectory : true;

      if (current.children === undefined) current.children = [];

      let child = current.children.find((c) => c.name === part);
      if (child === undefined) {
        // Omit children for file nodes — exactOptionalPropertyTypes forbids `undefined`
        child = { name: part, path: partPath, isDirectory: isDir, ...(isDir ? { children: [] } : {}) };
        current.children.push(child);
      }
      // noUncheckedIndexedAccess: current is always defined at this point since we just found/created it
      current = child;
    }
  }

  // Sort: directories first, then alphabetical
  function sort(nodes: FileNode[]): void {
    nodes.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const node of nodes) {
      if (node.children !== undefined) sort(node.children);
    }
  }
  if (root.children !== undefined) sort(root.children);

  return root.children ?? [];
}

// ---------------------------------------------------------------------------
// FileTree component
// ---------------------------------------------------------------------------

export function FileTree({ appId, activePath, onFileOpen, className }: FileTreeProps) {
  const client = useApiClient();
  const queryClient = useQueryClient();

  const [deleteTarget, setDeleteTarget] = React.useState<{ path: string; isDirectory: boolean } | undefined>(undefined);

  // Fetch file list
  const filesQuery = useQuery({
    queryKey: ["apps", appId, "files"],
    queryFn: ({ signal }) =>
      client.get<{ data: VFSFile[] }>(`/v1/apps/${appId}/files`, undefined, { signal }),
    staleTime: 0, // Always refetch — optimistic locking requires fresh fileVersion (§15.5)
  });

  const treeNodes = React.useMemo(
    () => buildTree(filesQuery.data?.data ?? []),
    [filesQuery.data],
  );

  // Open file: fetch content then notify editor
  async function handleFileClick(path: string) {
    try {
      const response = await client.get<{ data: { content: string; fileVersion: number } }>(
        `/v1/apps/${appId}/files/${encodeURIComponent(path)}`,
      );
      onFileOpen(path, response.data.content, response.data.fileVersion);
    } catch {
      toast({ title: "Could not open file", variant: "destructive" });
    }
  }

  // Create file via dialog — prompt user for path
  function handleCreateFile(parentPath: string) {
    const name = window.prompt(
      parentPath ? `New file name in ${parentPath}:` : "New file path:",
    );
    if (name === null || name.trim() === "") return;
    const fullPath = parentPath ? `${parentPath}/${name.trim()}` : name.trim();
    createFileMutation.mutate({ path: fullPath, content: "" });
  }

  function handleCreateFolder(parentPath: string) {
    const name = window.prompt(
      parentPath ? `New folder name in ${parentPath}:` : "New folder path:",
    );
    if (name === null || name.trim() === "") return;
    const fullPath = parentPath ? `${parentPath}/${name.trim()}` : name.trim();
    // Create a .gitkeep placeholder so the directory appears in the tree
    createFileMutation.mutate({ path: `${fullPath}/.gitkeep`, content: "" });
  }

  function handleRename(path: string) {
    const newName = window.prompt(`Rename ${path} to:`);
    if (newName === null || newName.trim() === "") return;
    // Rename = read existing + create at new path + delete old (§11.5)
    renameMutation.mutate({ oldPath: path, newPath: newName.trim() });
  }

  const createFileMutation = useMutation({
    mutationFn: ({ path, content }: { path: string; content: string }) =>
      client.put(`/v1/apps/${appId}/files/${encodeURIComponent(path)}`, {
        content,
        fileVersion: 0, // 0 = new file (§11.5)
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["apps", appId, "files"] });
    },
    onError: (error) => {
      const message = error instanceof ApiError ? error.message : "Failed to create file.";
      toast({ title: "Create failed", description: message, variant: "destructive" });
    },
  });

  const deleteFileMutation = useMutation({
    mutationFn: (path: string) =>
      client.delete(`/v1/apps/${appId}/files/${encodeURIComponent(path)}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["apps", appId, "files"] });
      toast({ title: "File deleted" });
    },
    onError: (error) => {
      const message = error instanceof ApiError ? error.message : "Failed to delete file.";
      toast({ title: "Delete failed", description: message, variant: "destructive" });
    },
  });

  const renameMutation = useMutation({
    mutationFn: async ({ oldPath, newPath }: { oldPath: string; newPath: string }) => {
      // Fetch old content, create new file, delete old
      const existing = await client.get<{ data: { content: string; fileVersion: number } }>(
        `/v1/apps/${appId}/files/${encodeURIComponent(oldPath)}`,
      );
      await client.put(`/v1/apps/${appId}/files/${encodeURIComponent(newPath)}`, {
        content: existing.data.content,
        fileVersion: 0,
      });
      await client.delete(`/v1/apps/${appId}/files/${encodeURIComponent(oldPath)}`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["apps", appId, "files"] });
      toast({ title: "File renamed" });
    },
    onError: (error) => {
      const message = error instanceof ApiError ? error.message : "Failed to rename file.";
      toast({ title: "Rename failed", description: message, variant: "destructive" });
    },
  });

  return (
    <div className={cn("flex flex-col border-r border-[var(--color-border)]", className)}>
      {/* Toolbar */}
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-2 py-1.5">
        <span className="text-xs font-semibold uppercase tracking-wide text-[var(--color-muted-foreground)]">
          Files
        </span>
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            title="New file"
            onClick={() => handleCreateFile("")}
            aria-label="Create new file"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            title="New folder"
            onClick={() => handleCreateFolder("")}
            aria-label="Create new folder"
          >
            <FolderPlus className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            title="Refresh"
            onClick={() => void filesQuery.refetch()}
            aria-label="Refresh file tree"
          >
            <RefreshCw
              className={cn("h-3.5 w-3.5", filesQuery.isFetching && "animate-spin")}
              aria-hidden="true"
            />
          </Button>
        </div>
      </div>

      {/* Tree */}
      <div className="flex-1 overflow-y-auto py-1">
        {filesQuery.isLoading ? (
          <div className="space-y-1 px-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-5 w-full" />
            ))}
          </div>
        ) : treeNodes.length === 0 ? (
          <p className="px-3 py-4 text-xs text-[var(--color-muted-foreground)]">
            No files yet. Create a file to get started.
          </p>
        ) : (
          treeNodes.map((node) => (
            <FileTreeNode
              key={node.path}
              node={node}
              depth={0}
              activePath={activePath}
              onFileClick={(path) => void handleFileClick(path)}
              onCreateFile={handleCreateFile}
              onCreateFolder={handleCreateFolder}
              onRename={handleRename}
              onDelete={(path, isDirectory) => setDeleteTarget({ path, isDirectory })}
            />
          ))
        )}
      </div>

      {/* Delete confirmation */}
      <ConfirmDialog
        open={deleteTarget !== undefined}
        onOpenChange={(open) => { if (!open) setDeleteTarget(undefined); }}
        title={`Delete ${deleteTarget?.isDirectory ? "folder" : "file"}`}
        description={`Are you sure you want to delete "${deleteTarget?.path}"? This cannot be undone.`}
        confirmLabel="Delete"
        onConfirm={() => {
          if (deleteTarget !== undefined) {
            deleteFileMutation.mutate(deleteTarget.path);
            setDeleteTarget(undefined);
          }
        }}
        isLoading={deleteFileMutation.isPending}
      />
    </div>
  );
}
