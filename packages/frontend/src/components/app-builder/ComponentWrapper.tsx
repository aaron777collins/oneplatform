/**
 * ComponentWrapper — visual chrome around a placed component on the canvas.
 *
 * In edit mode it renders:
 *   - A dashed selection border when selected, dotted outline otherwise
 *   - A settings gear button to open the config panel
 *   - A delete button
 *   - Drag handle for repositioning (triggers HTML5 drag API)
 *
 * In preview mode it renders the children transparently with no chrome.
 *
 * The wrapper communicates drag intent upward via onDragStart — the canvas
 * tracks the active drag state and decides where drops are allowed.
 */

import * as React from "react";
import { Settings, Trash2, GripVertical } from "lucide-react";
import type { BuilderMode, DragState } from "./types.js";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ComponentWrapperProps {
  componentId: string;
  columnId: string;
  mode: BuilderMode;
  isSelected: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onSettingsClick: () => void;
  onDragStart: (drag: DragState) => void;
  onDragEnd: () => void;
  children: React.ReactNode;
}

// ---------------------------------------------------------------------------
// ComponentWrapper
// ---------------------------------------------------------------------------

export function ComponentWrapper({
  componentId,
  columnId,
  mode,
  isSelected,
  onSelect,
  onDelete,
  onSettingsClick,
  onDragStart,
  onDragEnd,
  children,
}: ComponentWrapperProps) {
  // Preview mode — no chrome, render children directly
  if (mode === "preview") {
    return <>{children}</>;
  }

  const borderClass = isSelected
    ? "border-2 border-dashed border-[var(--color-primary,#6366f1)]"
    : "border border-dotted border-[var(--color-border,#e5e7eb)] hover:border-[var(--color-primary,#6366f1)]/50";

  function handleDragStart(e: React.DragEvent) {
    // Encode source info in the dataTransfer so foreign drag sources are ignored
    e.dataTransfer.setData("application/x-op-drag", JSON.stringify({ source: "canvas" }));
    e.dataTransfer.effectAllowed = "move";
    onDragStart({ source: "canvas", componentId, fromColumnId: columnId });
  }

  function handleClick(e: React.MouseEvent) {
    // Prevent clicks on action buttons from also selecting the component
    e.stopPropagation();
    onSelect();
  }

  return (
    <div
      className={`group relative rounded-md transition-all ${borderClass}`}
      onClick={handleClick}
      data-component-id={componentId}
      data-column-id={columnId}
    >
      {/* Component content */}
      <div className="pointer-events-none select-none">
        {children}
      </div>

      {/* Action toolbar — visible on hover or when selected */}
      <div
        className={`absolute right-1 top-1 flex items-center gap-0.5 rounded-md bg-[var(--color-background,#fff)] border border-[var(--color-border,#e5e7eb)] shadow-sm px-0.5 transition-opacity ${
          isSelected ? "opacity-100" : "opacity-0 group-hover:opacity-100"
        }`}
        // Prevent click from propagating to the component wrapper select handler
        onClick={(e) => e.stopPropagation()}
      >
        {/* Drag handle */}
        <div
          draggable
          onDragStart={handleDragStart}
          onDragEnd={onDragEnd}
          className="cursor-grab active:cursor-grabbing rounded p-1 hover:bg-[var(--color-muted,#f3f4f6)] text-[var(--color-muted-foreground,#6b7280)]"
          aria-label="Drag to reposition component"
          title="Drag to reposition"
        >
          <GripVertical className="h-3.5 w-3.5" aria-hidden="true" />
        </div>

        {/* Settings */}
        <button
          type="button"
          onClick={onSettingsClick}
          className="rounded p-1 hover:bg-[var(--color-muted,#f3f4f6)] text-[var(--color-muted-foreground,#6b7280)] hover:text-[var(--color-foreground,#111)]"
          aria-label="Component settings"
          title="Settings"
        >
          <Settings className="h-3.5 w-3.5" aria-hidden="true" />
        </button>

        {/* Delete */}
        <button
          type="button"
          onClick={onDelete}
          className="rounded p-1 hover:bg-red-50 text-[var(--color-muted-foreground,#6b7280)] hover:text-red-600"
          aria-label="Remove component"
          title="Remove"
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>

      {/* Selection ring label — shows component type when selected */}
      {isSelected && (
        <div className="absolute -top-5 left-0 rounded-t-sm bg-[var(--color-primary,#6366f1)] px-1.5 py-0.5 text-[10px] font-medium text-white leading-none">
          {/* populated by parent with component type via data attribute */}
        </div>
      )}
    </div>
  );
}
