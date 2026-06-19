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

  // Sync definition to parent on every graph change
  function handleGraphChange(next: PipelineGraph) {
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
      className={cn("flex h-full overflow-hidden", className)}
      aria-label="Visual pipeline editor"
    >
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
  );
}
