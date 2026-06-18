/**
 * Graph model for the visual pipeline editor.
 *
 * A PipelineGraph is the in-memory representation of what the user sees on
 * the canvas. It maps cleanly to/from PipelineDefinition (the API format) via
 * the converter functions in graph-converter.ts.
 *
 * We keep the graph model separate from the API schema so the canvas can
 * carry UI-only state (position, selection) without polluting the definition.
 */

// Step types mirror the pipeline service schema's discriminated union.
// "parallel" is included here but rendered as a special compound node.
export type GraphStepType =
  | "code"
  | "connector"
  | "transformer"
  | "transform"
  | "conditional"
  | "parallel"
  | "webhook"
  | "wait"
  | "approval"
  | "sub_workflow";

// Minimal config retained per node — full config lives in the step definition
// returned by the API. We keep a typed partial here so the config panel can
// render fields without re-fetching.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type StepConfig = Record<string, any>;

export interface GraphNode {
  id: string;
  /** Maps to StepSchema.type */
  type: GraphStepType;
  /** Canvas position in logical (pre-zoom) coordinates */
  position: { x: number; y: number };
  /** A copy of the raw step config fields (name, code, condition, etc.) */
  config: StepConfig;
  /** Human-readable label shown in the node header */
  label: string;
}

export interface GraphEdge {
  id: string;
  /** Source node ID */
  source: string;
  /** Target node ID */
  target: string;
  /**
   * Edge semantic for conditional steps.
   *   "then" → thenStepId branch
   *   "else" → elseStepId branch (optional)
   *   undefined → normal sequential flow
   */
  label?: "then" | "else";
}

export interface PipelineGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// ---------------------------------------------------------------------------
// Viewport state — kept separate so the graph model is serialisable
// ---------------------------------------------------------------------------

export interface ViewportTransform {
  /** Pan offset in screen pixels */
  x: number;
  y: number;
  /** Zoom scale (1.0 = 100%) */
  scale: number;
}

// ---------------------------------------------------------------------------
// Canvas interaction state
// ---------------------------------------------------------------------------

export type SelectionState =
  | { kind: "none" }
  | { kind: "node"; nodeId: string }
  | { kind: "edge"; edgeId: string };

// ---------------------------------------------------------------------------
// Port geometry helpers
// ---------------------------------------------------------------------------

/** Width/height of a rendered node in logical pixels */
export const NODE_WIDTH = 200;
export const NODE_HEIGHT = 72;
/** Radius of a connection port circle */
export const PORT_RADIUS = 6;

/**
 * Returns the canvas-space centre of a node's output port (right side, middle).
 * Used by ConnectionLine to anchor the bezier curve.
 */
export function outputPortPosition(node: GraphNode): { x: number; y: number } {
  return {
    x: node.position.x + NODE_WIDTH,
    y: node.position.y + NODE_HEIGHT / 2,
  };
}

/**
 * Returns the canvas-space centre of a node's input port (left side, middle).
 */
export function inputPortPosition(node: GraphNode): { x: number; y: number } {
  return {
    x: node.position.x,
    y: node.position.y + NODE_HEIGHT / 2,
  };
}

// ---------------------------------------------------------------------------
// Grid snapping
// ---------------------------------------------------------------------------

export const GRID_SIZE = 20;

/** Snaps a value to the nearest grid multiple */
export function snapToGrid(value: number): number {
  return Math.round(value / GRID_SIZE) * GRID_SIZE;
}
