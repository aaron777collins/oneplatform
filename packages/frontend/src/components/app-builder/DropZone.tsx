/**
 * DropZone — a column's droppable area.
 *
 * Renders a highlighted target when a drag is in progress and the drag source
 * is compatible with this column (empty column accepts any source; occupied
 * column accepts canvas-to-canvas swaps).
 *
 * All HTML5 Drag and Drop event handling lives here so AppBuilderCanvas stays
 * focused on layout orchestration.
 */

import * as React from "react";
import type { DragState } from "./types.js";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface DropZoneProps {
  rowId: string;
  columnId: string;
  isOccupied: boolean;
  activeDrag: DragState | null;
  onDrop: (rowId: string, columnId: string) => void;
  children?: React.ReactNode;
}

// ---------------------------------------------------------------------------
// DropZone
// ---------------------------------------------------------------------------

export function DropZone({
  rowId,
  columnId,
  isOccupied,
  activeDrag,
  onDrop,
  children,
}: DropZoneProps) {
  const [isDragOver, setIsDragOver] = React.useState(false);

  // A drop is valid when:
  //  - Dragging from palette into an empty column
  //  - Dragging from canvas into any column (swap supported)
  const isDropCandidate =
    activeDrag !== null &&
    (activeDrag.source === "palette" ? !isOccupied : activeDrag.fromColumnId !== columnId);

  function handleDragOver(e: React.DragEvent) {
    if (!isDropCandidate) return;
    // Must call preventDefault to signal a valid drop target
    e.preventDefault();
    e.dataTransfer.dropEffect = activeDrag?.source === "palette" ? "copy" : "move";
    setIsDragOver(true);
  }

  function handleDragLeave() {
    setIsDragOver(false);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragOver(false);
    if (!isDropCandidate) return;

    // Validate the data matches what we put there — ignore foreign drops
    const raw = e.dataTransfer.getData("application/x-op-drag");
    if (raw === "") return;

    onDrop(rowId, columnId);
  }

  const highlightClass = isDragOver
    ? "bg-[var(--color-primary,#6366f1)]/10 border-[var(--color-primary,#6366f1)] border-2"
    : isDropCandidate
    ? "border-dashed border border-[var(--color-primary,#6366f1)]/30 bg-[var(--color-primary,#6366f1)]/5"
    : "";

  return (
    <div
      className={`relative h-full min-h-[60px] rounded transition-all ${highlightClass}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      data-drop-zone
      data-row-id={rowId}
      data-col-id={columnId}
    >
      {/* Empty placeholder label */}
      {!isOccupied && activeDrag === null && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span className="text-[10px] text-[var(--color-muted-foreground,#9ca3af)] border border-dashed border-[var(--color-border,#e5e7eb)] rounded px-2 py-1">
            Drop here
          </span>
        </div>
      )}

      {isDragOver && isDropCandidate && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none rounded">
          <span className="text-xs font-medium text-[var(--color-primary,#6366f1)]">
            {isOccupied ? "Swap" : "Place"}
          </span>
        </div>
      )}

      {children}
    </div>
  );
}
