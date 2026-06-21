/**
 * PipelineCanvas — the SVG canvas that renders nodes and edges and handles
 * all pointer interactions: pan, zoom, node drag, and connection drawing.
 *
 * Coordinate system:
 *   - "screen space" = pixel coordinates relative to the SVG element
 *   - "canvas space" = logical coordinates stored in GraphNode.position
 *   - transform: screen = (canvas * scale) + pan
 *   - inverse: canvas = (screen - pan) / scale
 *
 * Interaction model:
 *   - Drag on empty canvas area → pan
 *   - Wheel / pinch → zoom (clamped to 0.2×–3×)
 *   - Drag a node → move node (grid-snapped on release)
 *   - Drag from output port → draw connection; release on input port → create edge
 *   - Click node → select
 *   - Double-click node → open config panel
 *   - Drop from NodePalette → add new node at drop position
 *   - Delete key when node selected → remove node
 */
import * as React from "react";
import { MousePointerClick } from "lucide-react";
import { PipelineNode } from "./PipelineNode.js";
import { ConnectionLine, ArrowheadDef } from "./ConnectionLine.js";
import {
  type PipelineGraph,
  type GraphNode,
  type GraphEdge,
  type ViewportTransform,
  type SelectionState,
  type GraphStepType,
  NODE_WIDTH,
  NODE_HEIGHT,
  GRID_SIZE,
  snapToGrid,
  inputPortPosition,
  outputPortPosition,
} from "./graph-model.js";
import { PALETTE_DRAG_TYPE_KEY } from "./NodePalette.js";
import { cn } from "@/lib/utils.js";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface PipelineCanvasProps {
  graph: PipelineGraph;
  selection: SelectionState;
  onSelectionChange: (sel: SelectionState) => void;
  onGraphChange: (graph: PipelineGraph) => void;
  onNodeDoubleClick: (nodeId: string) => void;
  className?: string;
}

// ---------------------------------------------------------------------------
// Interaction state types (local to canvas)
// ---------------------------------------------------------------------------

type DragMode =
  | { kind: "none" }
  | { kind: "pan"; startScreenX: number; startScreenY: number; startPan: { x: number; y: number } }
  | { kind: "node"; nodeId: string; startScreenX: number; startScreenY: number; startPos: { x: number; y: number } }
  | { kind: "connect"; sourceNodeId: string; currentScreenX: number; currentScreenY: number };

// ---------------------------------------------------------------------------
// PipelineCanvas
// ---------------------------------------------------------------------------

export function PipelineCanvas({
  graph,
  selection,
  onSelectionChange,
  onGraphChange,
  onNodeDoubleClick,
  className,
}: PipelineCanvasProps) {
  const svgRef = React.useRef<SVGSVGElement>(null);
  const [viewport, setViewport] = React.useState<ViewportTransform>({ x: 0, y: 0, scale: 1 });
  const [dragMode, setDragMode] = React.useState<DragMode>({ kind: "none" });

  // ---------------------------------------------------------------------------
  // Coordinate helpers
  // ---------------------------------------------------------------------------

  function screenToCanvas(sx: number, sy: number): { x: number; y: number } {
    const rect = svgRef.current?.getBoundingClientRect();
    const relX = sx - (rect?.left ?? 0);
    const relY = sy - (rect?.top ?? 0);
    return {
      x: (relX - viewport.x) / viewport.scale,
      y: (relY - viewport.y) / viewport.scale,
    };
  }

  // ---------------------------------------------------------------------------
  // Zoom (wheel)
  // ---------------------------------------------------------------------------

  React.useEffect(() => {
    const svg = svgRef.current;
    if (svg === null) return;

    function handleWheel(e: WheelEvent) {
      e.preventDefault();

      const rect = svg!.getBoundingClientRect();
      // Zoom toward the cursor position
      const cursorX = e.clientX - rect.left;
      const cursorY = e.clientY - rect.top;

      setViewport((prev) => {
        const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
        const newScale = Math.min(3, Math.max(0.2, prev.scale * zoomFactor));

        // Adjust pan so the canvas point under the cursor stays fixed
        const scaleRatio = newScale / prev.scale;
        const newX = cursorX - scaleRatio * (cursorX - prev.x);
        const newY = cursorY - scaleRatio * (cursorY - prev.y);

        return { x: newX, y: newY, scale: newScale };
      });
    }

    svg.addEventListener("wheel", handleWheel, { passive: false });
    return () => svg.removeEventListener("wheel", handleWheel);
  }, []);

  // ---------------------------------------------------------------------------
  // Mouse down on canvas background → start pan
  // ---------------------------------------------------------------------------

  function handleCanvasMouseDown(e: React.MouseEvent<SVGSVGElement>) {
    // Only trigger pan from left-click on the bare canvas (not on a node)
    if (e.button !== 0) return;
    if ((e.target as Element) !== svgRef.current && (e.target as Element).tagName !== "rect") return;

    setDragMode({
      kind: "pan",
      startScreenX: e.clientX,
      startScreenY: e.clientY,
      startPan: { x: viewport.x, y: viewport.y },
    });

    onSelectionChange({ kind: "none" });
  }

  // ---------------------------------------------------------------------------
  // Mouse move → handle active drag mode
  // ---------------------------------------------------------------------------

  function handleMouseMove(e: React.MouseEvent<SVGSVGElement>) {
    if (dragMode.kind === "none") return;

    if (dragMode.kind === "pan") {
      const dx = e.clientX - dragMode.startScreenX;
      const dy = e.clientY - dragMode.startScreenY;
      setViewport((prev) => ({
        ...prev,
        x: dragMode.startPan.x + dx,
        y: dragMode.startPan.y + dy,
      }));
    }

    if (dragMode.kind === "node") {
      const dx = (e.clientX - dragMode.startScreenX) / viewport.scale;
      const dy = (e.clientY - dragMode.startScreenY) / viewport.scale;
      const newX = dragMode.startPos.x + dx;
      const newY = dragMode.startPos.y + dy;

      // Live update (not grid-snapped) for smooth drag feedback
      onGraphChange({
        ...graph,
        nodes: graph.nodes.map((n) =>
          n.id === dragMode.nodeId
            ? { ...n, position: { x: newX, y: newY } }
            : n
        ),
      });
    }

    if (dragMode.kind === "connect") {
      setDragMode((prev) =>
        prev.kind === "connect"
          ? { ...prev, currentScreenX: e.clientX, currentScreenY: e.clientY }
          : prev
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Mouse up → commit drag, snap node, create edge
  // ---------------------------------------------------------------------------

  function handleMouseUp(e: React.MouseEvent<SVGSVGElement>) {
    if (dragMode.kind === "node") {
      // Snap to grid on release
      onGraphChange({
        ...graph,
        nodes: graph.nodes.map((n) =>
          n.id === dragMode.nodeId
            ? {
                ...n,
                position: {
                  x: snapToGrid(n.position.x),
                  y: snapToGrid(n.position.y),
                },
              }
            : n
        ),
      });
    }

    setDragMode({ kind: "none" });
  }

  // ---------------------------------------------------------------------------
  // Node interaction handlers
  // ---------------------------------------------------------------------------

  function handleNodeSelect(nodeId: string) {
    onSelectionChange({ kind: "node", nodeId });
  }

  function handleNodeMove(nodeId: string, dx: number, dy: number) {
    onGraphChange({
      ...graph,
      nodes: graph.nodes.map((n) =>
        n.id === nodeId
          ? { ...n, position: { x: snapToGrid(n.position.x + dx), y: snapToGrid(n.position.y + dy) } }
          : n
      ),
    });
  }

  function handleNodeDelete(nodeId: string) {
    onGraphChange({
      nodes: graph.nodes.filter((n) => n.id !== nodeId),
      edges: graph.edges.filter((e) => e.source !== nodeId && e.target !== nodeId),
    });
    if (selection.kind === "node" && selection.nodeId === nodeId) {
      onSelectionChange({ kind: "none" });
    }
  }

  function handleNodeDragStart(nodeId: string, e: React.MouseEvent) {
    const node = graph.nodes.find((n) => n.id === nodeId);
    if (node === undefined) return;
    setDragMode({
      kind: "node",
      nodeId,
      startScreenX: e.clientX,
      startScreenY: e.clientY,
      startPos: { ...node.position },
    });
  }

  // ---------------------------------------------------------------------------
  // Port drag — drawing a new connection
  // ---------------------------------------------------------------------------

  function handlePortDragStart(nodeId: string, e: React.MouseEvent) {
    e.stopPropagation();
    setDragMode({
      kind: "connect",
      sourceNodeId: nodeId,
      currentScreenX: e.clientX,
      currentScreenY: e.clientY,
    });
  }

  function handlePortDrop(targetNodeId: string) {
    if (dragMode.kind !== "connect") return;
    const { sourceNodeId } = dragMode;

    // Prevent self-loop and duplicate edges
    if (sourceNodeId === targetNodeId) {
      setDragMode({ kind: "none" });
      return;
    }
    const alreadyExists = graph.edges.some(
      (e) => e.source === sourceNodeId && e.target === targetNodeId
    );
    if (alreadyExists) {
      setDragMode({ kind: "none" });
      return;
    }

    onGraphChange({
      ...graph,
      edges: [
        ...graph.edges,
        { id: `${sourceNodeId}→${targetNodeId}`, source: sourceNodeId, target: targetNodeId },
      ],
    });
    setDragMode({ kind: "none" });
  }

  // ---------------------------------------------------------------------------
  // Drag-and-drop from NodePalette
  // ---------------------------------------------------------------------------

  function handleDragOver(e: React.DragEvent<SVGSVGElement>) {
    if (e.dataTransfer.types.includes(PALETTE_DRAG_TYPE_KEY)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  }

  function handleDrop(e: React.DragEvent<SVGSVGElement>) {
    const rawType = e.dataTransfer.getData(PALETTE_DRAG_TYPE_KEY);
    if (rawType.length === 0) return;
    e.preventDefault();

    const canvasPos = screenToCanvas(e.clientX, e.clientY);
    addNode(rawType as GraphStepType, { x: snapToGrid(canvasPos.x), y: snapToGrid(canvasPos.y) });
  }

  function addNode(type: GraphStepType, position: { x: number; y: number }) {
    const id = crypto.randomUUID();
    const newNode: GraphNode = {
      id,
      type,
      position,
      config: {},
      label: `New ${type}`,
    };
    onGraphChange({ ...graph, nodes: [...graph.nodes, newNode] });
    onSelectionChange({ kind: "node", nodeId: id });
  }

  // ---------------------------------------------------------------------------
  // Keyboard: palette-initiated add at centre of viewport
  // ---------------------------------------------------------------------------

  function handlePaletteAdd(type: GraphStepType) {
    const svgRect = svgRef.current?.getBoundingClientRect();
    const centreX = ((svgRect?.width ?? 600) / 2 - viewport.x) / viewport.scale;
    const centreY = ((svgRect?.height ?? 400) / 2 - viewport.y) / viewport.scale;
    addNode(type, { x: snapToGrid(centreX - NODE_WIDTH / 2), y: snapToGrid(centreY - NODE_HEIGHT / 2) });
  }

  // ---------------------------------------------------------------------------
  // Edge selection / deletion
  // ---------------------------------------------------------------------------

  function handleEdgeSelect(edgeId: string) {
    onSelectionChange({ kind: "edge", edgeId });
  }

  // Keyboard: delete selected edge
  React.useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (selection.kind !== "edge") return;
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      // Avoid deleting edge when typing in an input
      if ((e.target as HTMLElement).tagName === "INPUT" || (e.target as HTMLElement).tagName === "TEXTAREA") return;
      onGraphChange({
        ...graph,
        edges: graph.edges.filter((edge) => edge.id !== selection.edgeId),
      });
      onSelectionChange({ kind: "none" });
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [selection, graph, onGraphChange, onSelectionChange]);

  // ---------------------------------------------------------------------------
  // In-progress connection line (rubber-band)
  // ---------------------------------------------------------------------------

  let rubberBandLine: React.ReactNode = null;
  if (dragMode.kind === "connect") {
    const sourceNode = graph.nodes.find((n) => n.id === dragMode.sourceNodeId);
    if (sourceNode !== undefined) {
      const srcPort = outputPortPosition(sourceNode);
      // Transform source port from canvas to screen space, then to our SVG coordinate within the group
      const srcScreenX = srcPort.x * viewport.scale + viewport.x;
      const srcScreenY = srcPort.y * viewport.scale + viewport.y;
      const svgRect = svgRef.current?.getBoundingClientRect();
      const tgtX = dragMode.currentScreenX - (svgRect?.left ?? 0);
      const tgtY = dragMode.currentScreenY - (svgRect?.top ?? 0);

      // Draw in screen space (outside the transform group) so we don't need to invert
      rubberBandLine = (
        <ConnectionLine
          id="rubber-band"
          sourceX={srcScreenX}
          sourceY={srcScreenY}
          targetX={tgtX}
          targetY={tgtY}
          isDragging
        />
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Grid dots background
  // ---------------------------------------------------------------------------

  const gridPatternId = "canvas-grid";

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <svg
      ref={svgRef}
      className={cn("flex-1 w-full h-full select-none", className)}
      style={{ cursor: dragMode.kind === "pan" ? "grabbing" : dragMode.kind === "connect" ? "crosshair" : "default" }}
      onMouseDown={handleCanvasMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      aria-label="Pipeline canvas"
      role="application"
    >
      <defs>
        <pattern
          id={gridPatternId}
          width={GRID_SIZE}
          height={GRID_SIZE}
          patternUnits="userSpaceOnUse"
          patternTransform={`translate(${viewport.x % GRID_SIZE},${viewport.y % GRID_SIZE})`}
        >
          <circle cx={0} cy={0} r={0.8} className="fill-[var(--color-border)]" />
        </pattern>
        <ArrowheadDef />
      </defs>

      {/* Grid background */}
      <rect width="100%" height="100%" fill={`url(#${gridPatternId})`} className="fill-[var(--color-background)]" />

      {/* Canvas content group — applies viewport transform */}
      <g transform={`translate(${viewport.x},${viewport.y}) scale(${viewport.scale})`}>
        {/* Edges (rendered below nodes) */}
        {graph.edges.map((edge) => {
          const sourceNode = graph.nodes.find((n) => n.id === edge.source);
          const targetNode = graph.nodes.find((n) => n.id === edge.target);
          if (sourceNode === undefined || targetNode === undefined) return null;

          const src = outputPortPosition(sourceNode);
          const tgt = inputPortPosition(targetNode);
          const isSelected = selection.kind === "edge" && selection.edgeId === edge.id;

          return (
            <ConnectionLine
              key={edge.id}
              id={edge.id}
              sourceX={src.x}
              sourceY={src.y}
              targetX={tgt.x}
              targetY={tgt.y}
              {...(edge.label !== undefined ? { label: edge.label } : {})}
              selected={isSelected}
              onClick={handleEdgeSelect}
            />
          );
        })}

        {/* Nodes */}
        {graph.nodes.map((node) => {
          const isSelected = selection.kind === "node" && selection.nodeId === node.id;
          return (
            <PipelineNode
              key={node.id}
              node={node}
              selected={isSelected}
              onSelect={handleNodeSelect}
              onDoubleClick={onNodeDoubleClick}
              onMove={handleNodeMove}
              onDelete={handleNodeDelete}
              onPortDragStart={handlePortDragStart}
              onPortDrop={handlePortDrop}
            />
          );
        })}
      </g>

      {/* Rubber-band connection line — rendered in screen space */}
      {rubberBandLine}

      {/* Empty-state overlay — shown when there are no nodes yet.
          Uses a foreignObject so we can use HTML/Tailwind inside the SVG
          without converting pixel dimensions to SVG units. The overlay sits
          in screen space (outside the viewport transform group) so it always
          appears centred regardless of pan/zoom. */}
      {graph.nodes.length === 0 && (
        <foreignObject x="0" y="0" width="100%" height="100%" style={{ pointerEvents: "none" }}>
          <div
            // @ts-expect-error — xmlns required for foreignObject content in some SVG renderers
            xmlns="http://www.w3.org/1999/xhtml"
            className="flex h-full w-full items-center justify-center"
          >
            <div className="flex flex-col items-center gap-3 rounded-xl bg-[var(--color-background)]/80 px-8 py-6 text-center backdrop-blur-sm">
              <MousePointerClick
                className="h-8 w-8 text-[var(--color-muted-foreground)]"
                aria-hidden="true"
              />
              <p className="max-w-xs text-sm text-[var(--color-muted-foreground)]">
                Drag a step from the panel on the left, or click a step to add it
                to your pipeline.
              </p>
            </div>
          </div>
        </foreignObject>
      )}
    </svg>
  );
}
