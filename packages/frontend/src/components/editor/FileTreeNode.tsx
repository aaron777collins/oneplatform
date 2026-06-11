/**
 * FileTreeNode — single node in the VFS file tree.
 *
 * Handles expand/collapse for directories and displays a context menu for
 * file operations (create, rename, delete). File icons differ by extension.
 */
import * as React from "react";
import {
  ChevronDown,
  ChevronRight,
  File,
  FileCode,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  MoreHorizontal,
  Plus,
  Pencil,
  Trash2,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { cn } from "@/lib/utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileNode[];
}

export interface FileTreeNodeProps {
  node: FileNode;
  depth: number;
  activePath: string | null;
  onFileClick: (path: string) => void;
  onCreateFile: (parentPath: string) => void;
  onCreateFolder: (parentPath: string) => void;
  onRename: (path: string) => void;
  onDelete: (path: string, isDirectory: boolean) => void;
}

// ---------------------------------------------------------------------------
// Extension-based icon
// ---------------------------------------------------------------------------

// Cast Lucide icons to avoid exactOptionalPropertyTypes conflict on className
type IconComponent = React.ComponentType<{ className?: string }>;

function getFileIcon(name: string): IconComponent {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const CODE_EXTS = new Set(["ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs"]);
  const JSON_EXTS = new Set(["json", "jsonc"]);
  const TEXT_EXTS = new Set(["md", "txt", "yaml", "yml", "toml", "env"]);

  if (CODE_EXTS.has(ext)) return FileCode as IconComponent;
  if (JSON_EXTS.has(ext)) return FileJson as IconComponent;
  if (TEXT_EXTS.has(ext)) return FileText as IconComponent;
  return File as IconComponent;
}

// ---------------------------------------------------------------------------
// FileTreeNode component
// ---------------------------------------------------------------------------

export function FileTreeNode({
  node,
  depth,
  activePath,
  onFileClick,
  onCreateFile,
  onCreateFolder,
  onRename,
  onDelete,
}: FileTreeNodeProps) {
  const [expanded, setExpanded] = React.useState(depth === 0);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const isActive = activePath === node.path;
  const paddingLeft = (depth * 12) + 8;

  if (node.isDirectory) {
    return (
      <div>
        <div
          className={cn(
            "group flex items-center gap-1 rounded-sm py-0.5 pr-1 text-sm transition-colors",
            "hover:bg-[var(--color-muted)] cursor-pointer select-none",
          )}
          style={{ paddingLeft }}
          onClick={() => setExpanded((v) => !v)}
          role="button"
          tabIndex={0}
          aria-expanded={expanded}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setExpanded((v) => !v);
            }
          }}
        >
          <span className="shrink-0 text-[var(--color-muted-foreground)]" aria-hidden="true">
            {expanded
              ? <ChevronDown className="h-3.5 w-3.5" />
              : <ChevronRight className="h-3.5 w-3.5" />
            }
          </span>
          {expanded
            ? <FolderOpen className="h-4 w-4 shrink-0 text-[var(--color-muted-foreground)]" aria-hidden="true" />
            : <Folder className="h-4 w-4 shrink-0 text-[var(--color-muted-foreground)]" aria-hidden="true" />
          }
          <span className="min-w-0 flex-1 truncate font-medium text-[var(--color-foreground)]">
            {node.name}
          </span>
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="invisible rounded p-0.5 hover:bg-[var(--color-muted-foreground)]/20 group-hover:visible"
                aria-label={`More options for ${node.name}`}
                onClick={(e) => e.stopPropagation()}
              >
                <MoreHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" onClick={(e) => e.stopPropagation()}>
              <DropdownMenuItem onClick={() => { setMenuOpen(false); onCreateFile(node.path); }}>
                <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
                New file
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => { setMenuOpen(false); onCreateFolder(node.path); }}>
                <Folder className="mr-2 h-4 w-4" aria-hidden="true" />
                New folder
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => { setMenuOpen(false); onRename(node.path); }}>
                <Pencil className="mr-2 h-4 w-4" aria-hidden="true" />
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-[var(--color-destructive)]"
                onClick={() => { setMenuOpen(false); onDelete(node.path, true); }}
              >
                <Trash2 className="mr-2 h-4 w-4" aria-hidden="true" />
                Delete folder
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {expanded && node.children !== undefined && (
          <div>
            {node.children.map((child) => (
              <FileTreeNode
                key={child.path}
                node={child}
                depth={depth + 1}
                activePath={activePath}
                onFileClick={onFileClick}
                onCreateFile={onCreateFile}
                onCreateFolder={onCreateFolder}
                onRename={onRename}
                onDelete={onDelete}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  // File node
  const FileIcon = getFileIcon(node.name);
  return (
    <div
      className={cn(
        "group flex items-center gap-1 rounded-sm py-0.5 pr-1 text-sm transition-colors cursor-pointer select-none",
        isActive
          ? "bg-[var(--color-primary)]/10 text-[var(--color-primary)]"
          : "hover:bg-[var(--color-muted)] text-[var(--color-foreground)]",
      )}
      style={{ paddingLeft }}
      role="button"
      tabIndex={0}
      aria-current={isActive ? "true" : undefined}
      onClick={() => onFileClick(node.path)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onFileClick(node.path);
        }
      }}
    >
      <FileIcon className="h-4 w-4 shrink-0 text-[var(--color-muted-foreground)]" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{node.name}</span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="invisible rounded p-0.5 hover:bg-[var(--color-muted-foreground)]/20 group-hover:visible"
            aria-label={`More options for ${node.name}`}
            onClick={(e) => e.stopPropagation()}
          >
            <MoreHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" onClick={(e) => e.stopPropagation()}>
          <DropdownMenuItem onClick={() => onRename(node.path)}>
            <Pencil className="mr-2 h-4 w-4" aria-hidden="true" />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-[var(--color-destructive)]"
            onClick={() => onDelete(node.path, false)}
          >
            <Trash2 className="mr-2 h-4 w-4" aria-hidden="true" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
