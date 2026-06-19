/**
 * VisualPipelineEditor — top-level composition of canvas + palette + config panel.
 *
 * This component owns the PipelineGraph state and the selection state.
 * It surfaces the final graph (as a PipelineDefinition) via onDefinitionChange
 * so the parent page (PipelineBuilderPage) can persist or preview it.
 *
 * Layout:
 *   [NodePalette | PipelineCanvas | NodeConfigPanel?]
 *
 * The config panel is conditionally rendered when a node is selected (double-
 * clicked or selected and the panel is explicitly opened). Single-click only
 * selects — double-click opens the config panel.
 */
import * as React from "react";
import { Undo2, Redo2 } from "lucide-react";
import { NodePalette } from "./NodePalette.js";
import { PipelineCanvas } from "./PipelineCanvas.js";
import { NodeConfigPanel } from "./NodeConfigPanel.js";
import {
  type PipelineGraph,
  type SelectionState,
  type GraphStepType,
  type StepConfig,
  NODE_WIDTH,
  NODE_HEIGHT,
  GRID_SIZE,
  snapToGrid,
} from "./graph-model.js";
import { pipelineDefinitionToGraph, graphToPipelineDefinition, type ConvertibleDefinition } from "./graph-converter.js";
import { cn } from "@/lib/utils.js";

// ---------------------------------------------------------------------------
// History stack size limit
// ---------------------------------------------------------------------------
const MAX_HISTORY_SIZE = 50;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface VisualPipelineEditorProps {
  /**
   * Initial pipeline definition loaded from the API.
   * When undefined the canvas starts empty.
   */
  initialDefinition?: ConvertibleDefinition;
  /** Called whenever the graph changes — debounce if needed in the parent */
  onDefinitionChange?: (definition: ConvertibleDefinition) => void;
  className?: string;
}

// ---------------------------------------------------------------------------
// VisualPipelineEditor
// ---------------------------------------------------------------------------

export function VisualPipelineEditor({
  initialDefinition,
  onDefinitionChange,
  className,
}: VisualPipelineEditorProps) {
  const [graph, setGraph] = React.useState<PipelineGraph>(() => {
    if (initialDefinition === undefined) return { nodes: [], edges: [] };
    try {
      return pipelineDefinitionToGraph(initialDefinition);
    } catch {
      // If the definition is invalid, start with an empty canvas rather than
      // crashing the editor. The parent can show its own error state.
      return { nodes: [], edges: [] };
    }
  });

  const [selection, setSelection] = React.useState<SelectionState>({ kind: "none" });
  const [configPanelOpen, setConfigPanelOpen] = React.useState(false);

  // Undo / redo history stacks
  const [history, setHistory] = React.useState<PipelineGraph[]>([]);
  const [future, setFuture] = React.useState<PipelineGraph[]>([]);

  // Sync definition to parent on every graph change, maintaining undo history
  function handleGraphChange(next: PipelineGraph) {
    // Push current graph to history stack before applying the change
    setHistory((prev) => {
      const updated = [...prev, graph];
      return updated.length > MAX_HISTORY_SIZE ? updated.slice(-MAX_HISTORY_SIZE) : updated;
    });
    setFuture([]); // Clear redo stack on new change
    setGraph(next);
    if (onDefinitionChange === undefined) return;
    if (next.nodes.length === 0) return;
    try {
      onDefinitionChange(graphToPipelineDefinition(next));
    } catch {
      // Non-convertible transient state (e.g. disconnected graph during drag)
      // — silently skip until the user resolves it
    }
  }

  function handleUndo() {
    if (history.length === 0) return;
    const prev = history[history.length - 1]!;
    setHistory((h) => h.slice(0, -1));
    setFuture((f) => [...f, graph]);
    setGraph(prev);
    if (onDefinitionChange !== undefined && prev.nodes.length > 0) {
      try { onDefinitionChange(graphToPipelineDefinition(prev)); } catch { /* transient */ }
    }
  }

  function handleRedo() {
    if (future.length === 0) return;
    const next = future[future.length - 1]!;
    setFuture((f) => f.slice(0, -1));
    setHistory((h) => {
      const updated = [...h, graph];
      return updated.length > MAX_HISTORY_SIZE ? updated.slice(-MAX_HISTORY_SIZE) : updated;
    });
    setGraph(next);
    if (onDefinitionChange !== undefined && next.nodes.length > 0) {
      try { onDefinitionChange(graphToPipelineDefinition(next)); } catch { /* transient */ }
    }
  }

  // Keyboard shortcuts for undo/redo
  React.useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const isMeta = e.metaKey || e.ctrlKey;
      if (isMeta && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
      } else if (isMeta && (e.key === "y" || (e.key === "z" && e.shiftKey))) {
        e.preventDefault();
        handleRedo();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  function handleSelectionChange(sel: SelectionState) {
    setSelection(sel);
    // Close config panel when selection is cleared
    if (sel.kind !== "node") {
      setConfigPanelOpen(false);
    }
  }

  function handleNodeDoubleClick(nodeId: string) {
    setSelection({ kind: "node", nodeId });
    setConfigPanelOpen(true);
  }

  // Called by NodePalette "add" keyboard action — add node at canvas centre
  function handlePaletteAdd(type: GraphStepType) {
    const id = crypto.randomUUID();
    const offset = graph.nodes.length * 30;
    const position = {
      x: snapToGrid(GRID_SIZE * 5 + offset),
      y: snapToGrid(GRID_SIZE * 3 + offset),
    };
    handleGraphChange({
      ...graph,
      nodes: [
        ...graph.nodes,
        { id, type, position, config: {}, label: `New ${type}` },
      ],
    });
    setSelection({ kind: "node", nodeId: id });
  }

  function handleNodeUpdate(nodeId: string, label: string, config: StepConfig) {
    handleGraphChange({
      ...graph,
      nodes: graph.nodes.map((n) =>
        n.id === nodeId ? { ...n, label, config } : n
      ),
    });
  }

  const selectedNode =
    selection.kind === "node" && configPanelOpen
      ? graph.nodes.find((n) => n.id === selection.nodeId)
      : undefined;

  return (
    <div
      className={cn("flex h-full flex-col overflow-hidden", className)}
      aria-label="Visual pipeline editor"
    >
      {/* Toolbar with undo/redo */}
      <div className="flex items-center gap-1 border-b border-[var(--color-border)] px-3 py-1.5 shrink-0 bg-[var(--color-card)]">
        <button
          type="button"
          onClick={handleUndo}
          disabled={history.length === 0}
          className="flex items-center rounded px-2 py-1 text-[var(--color-muted-foreground)] hover:bg-[var(--color-muted)] hover:text-[var(--color-foreground)] disabled:cursor-not-allowed disabled:opacity-40 transition-colors"
          aria-label="Undo"
          title="Undo (Ctrl+Z)"
        >
          <Undo2 className="h-4 w-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={handleRedo}
          disabled={future.length === 0}
          className="flex items-center rounded px-2 py-1 text-[var(--color-muted-foreground)] hover:bg-[var(--color-muted)] hover:text-[var(--color-foreground)] disabled:cursor-not-allowed disabled:opacity-40 transition-colors"
          aria-label="Redo"
          title="Redo (Ctrl+Y)"
        >
          <Redo2 className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      {/* Editor panels */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
      {/* Left: step palette */}
      <NodePalette onAdd={handlePaletteAdd} />

      {/* Centre: canvas */}
      <PipelineCanvas
        graph={graph}
        selection={selection}
        onSelectionChange={handleSelectionChange}
        onGraphChange={handleGraphChange}
        onNodeDoubleClick={handleNodeDoubleClick}
        className="flex-1"
      />

      {/* Right: config panel (conditional) */}
      {selectedNode !== undefined && (
        <NodeConfigPanel
          node={selectedNode}
          allNodes={graph.nodes}
          onUpdate={handleNodeUpdate}
          onClose={() => setConfigPanelOpen(false)}
        />
      )}
      </div>
    </div>
  );
}
