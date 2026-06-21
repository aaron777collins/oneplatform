/**
 * AppBuilderCanvas — the main drag-and-drop grid canvas.
 *
 * Responsibilities:
 *  - Render rows and columns from the builder store's layout
 *  - Orchestrate drag state (palette → canvas and canvas → canvas moves)
 *  - Show drop zones on every column during an active drag
 *  - Add/remove rows
 *  - Delegate component selection to the config panel
 *  - Preview mode toggle (renders ComponentPreview without edit chrome)
 *
 * The canvas owns drag state locally because it is transient UI state, not
 * business state. The builder store only receives completed mutations.
 */

import * as React from "react";
import { Plus, Undo2, Redo2, Eye, Pencil, Code2, Columns2 } from "lucide-react";
import { useBuilderStore } from "./builder.store.js";
import { ComponentPalette } from "./ComponentPalette.js";
import { ComponentWrapper } from "./ComponentWrapper.js";
import { ComponentPreview } from "./ComponentPreview.js";
import { ComponentConfigPanel } from "./ComponentConfigPanel.js";
import { DropZone } from "./DropZone.js";
import { layoutToReactCode } from "./code-generator.js";
import { COLUMN_PRESETS } from "./layout-helpers.js";
import type { ColumnPreset } from "./layout-helpers.js";
import type { DragState, LayoutRow } from "./types.js";
import { useIsMobile } from "@/components/mobile/ResponsiveLayout.js";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface AppBuilderCanvasProps {
  /** Called when the user wants to open the generated code in the Monaco editor. */
  onOpenInEditor?: (code: string) => void;
  className?: string;
}

// ---------------------------------------------------------------------------
// AppBuilderCanvas
// ---------------------------------------------------------------------------

export function AppBuilderCanvas({ onOpenInEditor, className = "" }: AppBuilderCanvasProps) {
  const store = useBuilderStore();
  const isMobile = useIsMobile();

  // Drag state is transient UI — lives in component state, not the builder store
  const [activeDrag, setActiveDrag] = React.useState<DragState | null>(null);

  const selectedComponent = React.useMemo(() => {
    if (store.selectedComponentId === null) return null;
    for (const row of store.layout.rows) {
      for (const col of row.columns) {
        if (col.component?.id === store.selectedComponentId) return col.component;
      }
    }
    return null;
  }, [store.layout, store.selectedComponentId]);

  // Deselect on canvas background click
  function handleCanvasClick(e: React.MouseEvent) {
    const target = e.target as HTMLElement;
    if (target.closest("[data-component-id]") === null) {
      store.selectComponent(null);
    }
  }

  function handleDrop(rowId: string, columnId: string) {
    if (activeDrag === null) return;

    if (activeDrag.source === "palette" && activeDrag.paletteType !== undefined) {
      store.dropFromPalette(activeDrag.paletteType, rowId, columnId);
    } else if (
      activeDrag.source === "canvas" &&
      activeDrag.fromColumnId !== undefined
    ) {
      store.moveComponent(activeDrag.fromColumnId, columnId);
    }

    setActiveDrag(null);
  }

  function handleOpenInEditor() {
    const code = layoutToReactCode(store.layout);
    onOpenInEditor?.(code);
  }

  const canUndo = store.history.length > 0;
  const canRedo = store.future.length > 0;

  // Mobile bottom sheet state — palette becomes a tap-to-add sheet on touch screens
  const [mobilePaletteOpen, setMobilePaletteOpen] = React.useState(false);

  // On mobile, add a component to the first available empty column.
  // If all columns are occupied, a new row is added so the user can retry.
  function handleMobilePaletteAdd(paletteType: string) {
    for (const row of store.layout.rows) {
      for (const col of row.columns) {
        if (col.component === undefined) {
          store.dropFromPalette(paletteType, row.id, col.id);
          setMobilePaletteOpen(false);
          return;
        }
      }
    }
    // No empty slot found — let the user know by closing and adding a row
    store.addRow();
    setMobilePaletteOpen(false);
  }

  return (
    <div className={`relative flex h-full flex-col overflow-hidden bg-[var(--color-background,#fff)] ${className}`}>
      {/* Top toolbar */}
      <div className="flex items-center justify-between border-b border-[var(--color-border,#e5e7eb)] px-4 py-2 shrink-0">
        <div className="flex items-center gap-1">
          {/* Undo / Redo */}
          <ToolbarButton
            onClick={store.undo}
            disabled={!canUndo}
            aria-label="Undo"
            title="Undo"
          >
            <Undo2 className="h-4 w-4" aria-hidden="true" />
          </ToolbarButton>
          <ToolbarButton
            onClick={store.redo}
            disabled={!canRedo}
            aria-label="Redo"
            title="Redo"
          >
            <Redo2 className="h-4 w-4" aria-hidden="true" />
          </ToolbarButton>
        </div>

        {/* Mode toggle */}
        <div className="flex items-center rounded-lg border border-[var(--color-border,#e5e7eb)] overflow-hidden">
          <ModeButton
            active={store.mode === "edit"}
            onClick={() => store.setMode("edit")}
            aria-label="Edit mode"
          >
            <Pencil className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
            Edit
          </ModeButton>
          <ModeButton
            active={store.mode === "preview"}
            onClick={() => store.setMode("preview")}
            aria-label="Preview mode"
          >
            <Eye className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
            Preview
          </ModeButton>
        </div>

        {/* Open in editor — secondary action, de-emphasised */}
        <ToolbarButton
          onClick={handleOpenInEditor}
          disabled={onOpenInEditor === undefined}
          aria-label="Open in Monaco editor"
          title="Open generated code in editor"
          className="opacity-60 hover:opacity-100 text-[10px]"
        >
          <Code2 className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
          <span className="text-[10px]">Editor</span>
        </ToolbarButton>

        {/* Mobile: "Add component" button — replaces the drag-and-drop palette on touch screens */}
        {isMobile && store.mode === "edit" && (
          <button
            type="button"
            onClick={() => setMobilePaletteOpen(true)}
            className="ml-2 flex items-center gap-1 rounded-md bg-[var(--color-primary,#6366f1)] px-3 py-1.5 text-xs font-medium text-white transition-colors sm:hidden"
            aria-label="Add component"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            Add
          </button>
        )}
      </div>

      {/* Three-panel body */}
      <div className="flex flex-1 min-h-0">
        {/* Left: component palette (edit mode, desktop only — mobile uses tap-to-add via the palette sheet) */}
        {store.mode === "edit" && !isMobile && (
          <ComponentPalette
            onDragStart={setActiveDrag}
            onDragEnd={() => setActiveDrag(null)}
          />
        )}

        {/* Center: canvas */}
        <div
          className="flex-1 overflow-auto p-4"
          onClick={handleCanvasClick}
          onDragOver={(e) => e.preventDefault()}
        >
          <div className="max-w-5xl mx-auto space-y-3">
            {store.layout.rows.map((row, rowIndex) => (
              <div key={row.id} className="group/row relative">
                {/* Row layout preset toolbar — visible on hover in edit mode */}
                {store.mode === "edit" && (
                  <RowLayoutToolbar
                    row={row}
                    onApplyPreset={(preset) => store.applyRowPreset(row.id, preset)}
                  />
                )}

                {/* Row container */}
                <div
                  className="grid gap-3"
                  style={{
                    gridTemplateColumns: `repeat(12, minmax(0, 1fr))`,
                    height: row.height,
                  }}
                >
                  {row.columns.map((col) => (
                    <div
                      key={col.id}
                      style={{ gridColumn: `span ${col.width}` }}
                    >
                      <DropZone
                        rowId={row.id}
                        columnId={col.id}
                        isOccupied={col.component !== undefined}
                        activeDrag={activeDrag}
                        onDrop={handleDrop}
                      >
                        {col.component !== undefined && (
                          <ComponentWrapper
                            componentId={col.component.id}
                            columnId={col.id}
                            componentType={col.component.type}
                            mode={store.mode}
                            isSelected={store.selectedComponentId === col.component.id}
                            onSelect={() => store.selectComponent(col.component!.id)}
                            onDelete={() => store.removeComponent(col.component!.id)}
                            onSettingsClick={() => store.selectComponent(col.component!.id)}
                            onDragStart={setActiveDrag}
                            onDragEnd={() => setActiveDrag(null)}
                          >
                            <ComponentPreview component={col.component} />
                          </ComponentWrapper>
                        )}
                      </DropZone>
                    </div>
                  ))}
                </div>

                {/* Row controls — visible on row hover in edit mode */}
                {store.mode === "edit" && (
                  <div className="absolute -right-8 top-0 flex flex-col gap-1 opacity-0 group-hover/row:opacity-100 transition-opacity">
                    {/* Move row up */}
                    {rowIndex > 0 && (
                      <RowControlButton
                        onClick={() => store.moveRow(rowIndex, rowIndex - 1)}
                        aria-label="Move row up"
                        title="Move up"
                      >
                        ▲
                      </RowControlButton>
                    )}
                    {/* Move row down */}
                    {rowIndex < store.layout.rows.length - 1 && (
                      <RowControlButton
                        onClick={() => store.moveRow(rowIndex, rowIndex + 1)}
                        aria-label="Move row down"
                        title="Move down"
                      >
                        ▼
                      </RowControlButton>
                    )}
                    {/* Remove row */}
                    <RowControlButton
                      onClick={() => store.removeRow(row.id)}
                      aria-label="Remove row"
                      title="Remove row"
                      danger
                    >
                      ✕
                    </RowControlButton>
                  </div>
                )}
              </div>
            ))}

            {/* Add row button (edit mode only) */}
            {store.mode === "edit" && (
              <button
                type="button"
                onClick={store.addRow}
                className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-[var(--color-border,#e5e7eb)] py-3 text-xs text-[var(--color-muted-foreground,#6b7280)] hover:border-[var(--color-primary,#6366f1)]/50 hover:text-[var(--color-primary,#6366f1)] transition-colors"
                aria-label="Add row"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                Add row
              </button>
            )}
          </div>
        </div>

        {/* Right: config panel (shown when a component is selected in edit mode, desktop only) */}
        {store.mode === "edit" && selectedComponent !== null && !isMobile && (
          <ComponentConfigPanel
            component={selectedComponent}
            onUpdateProps={(props) => store.updateProps(selectedComponent.id, props)}
            onUpdateStyles={(styles) => store.updateStyles(selectedComponent.id, styles)}
            onUpdateDataBinding={(binding) =>
              store.updateDataBinding(selectedComponent.id, binding)
            }
            onClose={() => store.selectComponent(null)}
          />
        )}
      </div>

      {/* Mobile: component palette as a tap-to-add bottom sheet */}
      {isMobile && mobilePaletteOpen && (
        <div
          className="absolute inset-0 z-20 flex flex-col justify-end"
          aria-modal="true"
          role="dialog"
          aria-label="Add component"
        >
          {/* Backdrop */}
          <button
            type="button"
            className="absolute inset-0 bg-black/40"
            onClick={() => setMobilePaletteOpen(false)}
            aria-label="Close"
            tabIndex={-1}
          />
          <div className="relative z-10 max-h-[70vh] flex flex-col rounded-t-xl border-t border-[var(--color-border,#e5e7eb)] bg-[var(--color-background,#fff)] overflow-hidden">
            <div className="flex items-center justify-between border-b border-[var(--color-border,#e5e7eb)] px-4 py-3 shrink-0">
              <span className="text-sm font-semibold text-[var(--color-foreground,#111)]">Add component</span>
              <button
                type="button"
                onClick={() => setMobilePaletteOpen(false)}
                className="rounded p-1 hover:bg-[var(--color-muted,#f3f4f6)] transition-colors"
                aria-label="Close"
              >
                <span aria-hidden="true" className="text-lg leading-none">&times;</span>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {/* Tap mode: clicking a component adds it directly instead of dragging */}
              <ComponentPalette
                onDragStart={() => undefined}
                onDragEnd={() => undefined}
                onTapAdd={handleMobilePaletteAdd}
              />
            </div>
          </div>
        </div>
      )}

      {/* Mobile: config panel as a bottom sheet when a component is selected */}
      {isMobile && store.mode === "edit" && selectedComponent !== null && (
        <div
          className="absolute inset-0 z-20 flex flex-col justify-end"
          aria-modal="true"
          role="dialog"
          aria-label="Component settings"
        >
          <button
            type="button"
            className="absolute inset-0 bg-black/40"
            onClick={() => store.selectComponent(null)}
            aria-label="Close"
            tabIndex={-1}
          />
          <div className="relative z-10 max-h-[80vh] flex flex-col rounded-t-xl border-t border-[var(--color-border,#e5e7eb)] bg-[var(--color-background,#fff)] overflow-hidden">
            <ComponentConfigPanel
              component={selectedComponent}
              onUpdateProps={(props) => store.updateProps(selectedComponent.id, props)}
              onUpdateStyles={(styles) => store.updateStyles(selectedComponent.id, styles)}
              onUpdateDataBinding={(binding) =>
                store.updateDataBinding(selectedComponent.id, binding)
              }
              onClose={() => store.selectComponent(null)}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface ToolbarButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children: React.ReactNode;
}

function ToolbarButton({ children, className = "", ...rest }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      className={`flex items-center rounded px-2 py-1.5 text-[var(--color-muted-foreground,#6b7280)] hover:bg-[var(--color-muted,#f3f4f6)] hover:text-[var(--color-foreground,#111)] disabled:cursor-not-allowed disabled:opacity-40 transition-colors ${className}`}
    >
      {children}
    </button>
  );
}

interface ModeButtonProps {
  active: boolean;
  onClick: () => void;
  "aria-label": string;
  children: React.ReactNode;
}

function ModeButton({ active, onClick, "aria-label": ariaLabel, children }: ModeButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      aria-pressed={active}
      className={`flex items-center px-3 py-1.5 text-xs font-medium transition-colors ${
        active
          ? "bg-[var(--color-primary,#6366f1)] text-white"
          : "bg-transparent text-[var(--color-muted-foreground,#6b7280)] hover:bg-[var(--color-muted,#f3f4f6)]"
      }`}
    >
      {children}
    </button>
  );
}

interface RowControlButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children: React.ReactNode;
  danger?: boolean;
}

function RowControlButton({ children, danger = false, className = "", ...rest }: RowControlButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      className={`h-6 w-6 rounded text-[10px] flex items-center justify-center transition-colors ${
        danger
          ? "bg-red-100 text-red-600 hover:bg-red-200"
          : "bg-[var(--color-muted,#f3f4f6)] text-[var(--color-muted-foreground,#6b7280)] hover:bg-[var(--color-border,#e5e7eb)]"
      } ${className}`}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Row layout preset toolbar
// ---------------------------------------------------------------------------

interface RowLayoutToolbarProps {
  row: LayoutRow;
  onApplyPreset: (preset: ColumnPreset) => void;
}

function RowLayoutToolbar({ row, onApplyPreset }: RowLayoutToolbarProps) {
  // Current column widths summary shown as e.g. "6 | 6"
  const widthSummary = row.columns.map((c) => c.width).join(" | ");

  return (
    <div className="mb-1 flex items-center gap-1 opacity-0 group-hover/row:opacity-100 transition-opacity">
      <Columns2 className="h-3 w-3 text-[var(--color-muted-foreground,#6b7280)]" aria-hidden="true" />
      <span className="text-[10px] text-[var(--color-muted-foreground,#6b7280)] font-mono mr-1">
        [{widthSummary}]
      </span>
      {(Object.entries(COLUMN_PRESETS) as Array<[ColumnPreset, { label: string; widths: number[] }]>).map(
        ([preset, { label }]) => (
          <button
            key={preset}
            type="button"
            onClick={() => onApplyPreset(preset)}
            title={`Apply layout: ${label}`}
            aria-label={`Set row to ${label}`}
            className="rounded px-1.5 py-0.5 text-[9px] font-medium bg-[var(--color-muted,#f3f4f6)] text-[var(--color-muted-foreground,#6b7280)] hover:bg-[var(--color-primary,#6366f1)]/10 hover:text-[var(--color-primary,#6366f1)] transition-colors"
          >
            {label}
          </button>
        ),
      )}
    </div>
  );
}
