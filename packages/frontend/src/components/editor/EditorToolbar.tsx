/**
 * EditorToolbar — top bar of the Monaco editor page.
 *
 * Contains: app name, file path breadcrumb, dirty indicator, Save button,
 * Build button (triggers POST /builds and opens SSE log stream), Deploy button.
 *
 * Keyboard shortcuts: Ctrl/Cmd+S → save, Ctrl/Cmd+Shift+B → build (§14.6).
 */
import * as React from "react";
import { Save, Play, Rocket, ChevronRight, Circle } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { BuildStatusBadge, type BuildStatus } from "@/components/apps/BuildStatusBadge.js";
import { cn } from "@/lib/utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EditorToolbarProps {
  appName: string;
  appSlug: string;
  activeFilePath: string | null;
  isDirty: boolean;
  buildStatus: BuildStatus | "idle";
  /** Called when user triggers a manual save */
  onSave: () => void;
  /** Called when user triggers a build */
  onBuild: () => void;
  /** Called when user triggers a deploy */
  onDeploy: () => void;
  className?: string;
}

// ---------------------------------------------------------------------------
// EditorToolbar component
// ---------------------------------------------------------------------------

export function EditorToolbar({
  appName,
  appSlug,
  activeFilePath,
  isDirty,
  buildStatus,
  onSave,
  onBuild,
  onDeploy,
  className,
}: EditorToolbarProps) {
  // Keyboard shortcut listener
  React.useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const isMod = e.ctrlKey || e.metaKey;

      if (isMod && e.key === "s") {
        e.preventDefault();
        onSave();
      }

      if (isMod && e.shiftKey && e.key === "B") {
        e.preventDefault();
        onBuild();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onSave, onBuild]);

  const isBuilding = buildStatus === "building";

  return (
    <div
      className={cn(
        "flex h-10 items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-background)] px-3",
        className,
      )}
    >
      {/* App name */}
      <span className="shrink-0 text-sm font-semibold text-[var(--color-foreground)]">
        {appName}
      </span>

      {/* File path breadcrumb */}
      {activeFilePath !== null && (
        <>
          <ChevronRight className="h-4 w-4 shrink-0 text-[var(--color-muted-foreground)]" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--color-muted-foreground)]">
            {activeFilePath}
          </span>
          {isDirty && (
            <span aria-label="Unsaved changes">
              <Circle
                className="h-2 w-2 shrink-0 fill-current text-[var(--color-primary)]"
                aria-hidden="true"
              />
            </span>
          )}
        </>
      )}

      <div className="ml-auto flex items-center gap-2">
        {/* Build status badge (not shown when idle) */}
        {buildStatus !== "idle" && (
          <BuildStatusBadge status={buildStatus} />
        )}

        {/* Save button */}
        <Button
          variant="ghost"
          size="sm"
          onClick={onSave}
          disabled={!isDirty}
          title="Save (Ctrl+S)"
          aria-label="Save current file"
        >
          <Save className="h-4 w-4" aria-hidden="true" />
          <span className="ml-1.5">Save</span>
        </Button>

        {/* Build button */}
        <Button
          variant="outline"
          size="sm"
          onClick={onBuild}
          disabled={isBuilding}
          aria-busy={isBuilding}
          title="Build (Ctrl+Shift+B)"
          aria-label="Trigger build"
        >
          {isBuilding ? (
            <span
              className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
              aria-hidden="true"
            />
          ) : (
            <Play className="h-4 w-4" aria-hidden="true" />
          )}
          <span className="ml-1.5">{isBuilding ? "Building…" : "Build"}</span>
        </Button>

        {/* Deploy button */}
        <Button
          size="sm"
          onClick={onDeploy}
          disabled={isBuilding}
          aria-label={`Deploy ${appSlug}`}
        >
          <Rocket className="h-4 w-4" aria-hidden="true" />
          <span className="ml-1.5">Deploy</span>
        </Button>
      </div>
    </div>
  );
}
