/**
 * Bidirectional converter between PipelineDefinition (API wire format) and
 * PipelineGraph (canvas model).
 *
 * The conversion is pure — no side effects or network calls. Round-tripping a
 * definition through graph and back should produce a semantically identical
 * definition (modulo field ordering and any UI-only fields stripped out).
 *
 * Auto-layout is applied when converting definition → graph because imported
 * definitions carry no position data. The algorithm is a simple top-down
 * Sugiyama-style layered layout: each node is assigned a layer by BFS from the
 * entry step, then positioned within its layer at equal horizontal spacing.
 */

import type { PipelineGraph, GraphNode, GraphEdge, GraphStepType, StepConfig } from "./graph-model.js";
import { NODE_WIDTH, NODE_HEIGHT, GRID_SIZE } from "./graph-model.js";

// ---------------------------------------------------------------------------
// Minimal subset of PipelineDefinition needed for the converter.
// We intentionally avoid importing the Zod schema — the converter works on
// plain objects so it is usable in tests without the full Zod runtime.
// ---------------------------------------------------------------------------

export interface ConvertibleStep {
  id: string;
  name: string;
  type: string;
  // Conditional-specific fields
  thenStepId?: string;
  elseStepId?: string;
  // All other fields are carried as-is into StepConfig
  [key: string]: unknown;
}

export interface ConvertibleDefinition {
  version: number;
  entryStepId: string;
  steps: ConvertibleStep[];
  options?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// PipelineDefinition → PipelineGraph
// ---------------------------------------------------------------------------

/**
 * Converts a stored pipeline definition to a visual graph.
 * Positions are assigned by the auto-layout algorithm.
 */
export function pipelineDefinitionToGraph(definition: ConvertibleDefinition): PipelineGraph {
  validateDefinitionForConversion(definition);

  const nodes: GraphNode[] = definition.steps.map((step) => {
    // Extract name and type from the step; everything else is config.
    const { id, name, type, thenStepId, elseStepId, ...rest } = step;
    const config: StepConfig = { thenStepId, elseStepId, ...rest };
    // Remove undefined values so the config object stays clean
    for (const key of Object.keys(config)) {
      if (config[key] === undefined) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete config[key];
      }
    }

    return {
      id,
      type: type as GraphStepType,
      // Position will be overwritten by auto-layout below
      position: { x: 0, y: 0 },
      config,
      label: name,
    };
  });

  const edges = buildEdgesFromDefinition(definition);
  applyAutoLayout(nodes, edges, definition.entryStepId);

  return { nodes, edges };
}

function buildEdgesFromDefinition(definition: ConvertibleDefinition): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const stepIndex = new Map<string, ConvertibleStep>(
    definition.steps.map((s) => [s.id, s])
  );

  // Build a sequential-flow map: for each step, the "next" step in the steps
  // array is its default successor unless overridden by a conditional.
  for (let i = 0; i < definition.steps.length - 1; i++) {
    const current = definition.steps[i];
    const next = definition.steps[i + 1];

    if (current === undefined || next === undefined) continue;

    // Conditional steps use explicit branch IDs, not sequential flow
    if (current.type === "conditional") {
      if (current.thenStepId !== undefined && stepIndex.has(current.thenStepId as string)) {
        edges.push({
          id: `${current.id}→then`,
          source: current.id,
          target: current.thenStepId as string,
          label: "then",
        });
      }
      if (current.elseStepId !== undefined && stepIndex.has(current.elseStepId as string)) {
        edges.push({
          id: `${current.id}→else`,
          source: current.id,
          target: current.elseStepId as string,
          label: "else",
        });
      }
    } else {
      edges.push({
        id: `${current.id}→${next.id}`,
        source: current.id,
        target: next.id,
      });
    }
  }

  return edges;
}

// ---------------------------------------------------------------------------
// PipelineGraph → PipelineDefinition
// ---------------------------------------------------------------------------

/**
 * Converts a visual graph back to the pipeline definition wire format.
 * Steps are ordered by topological sort starting from the first node in the
 * graph that has no incoming edges (the entry step).
 */
export function graphToPipelineDefinition(graph: PipelineGraph): ConvertibleDefinition {
  if (graph.nodes.length === 0) {
    throw new Error("Cannot convert an empty graph to a pipeline definition");
  }

  const entryStepId = findEntryNode(graph);
  const orderedSteps = topologicalSort(graph, entryStepId);

  const steps: ConvertibleStep[] = orderedSteps.map((node) => {
    const { id, type, label, config } = node;
    return {
      id,
      name: label,
      type,
      ...config,
    } as ConvertibleStep;
  });

  return {
    version: 1,
    entryStepId,
    steps,
  };
}

/**
 * Finds the entry node: the node with no incoming edges.
 * Throws if there is not exactly one such node (the graph must be a DAG with
 * a single root).
 */
function findEntryNode(graph: PipelineGraph): string {
  const targetIds = new Set(graph.edges.map((e) => e.target));
  const candidates = graph.nodes.filter((n) => !targetIds.has(n.id));

  if (candidates.length === 0) {
    throw new Error(
      "Pipeline graph contains a cycle — every node has an incoming edge. " +
        "Ensure the pipeline has a single entry point with no incoming connections."
    );
  }
  if (candidates.length > 1) {
    // Multiple roots — use the first one but warn (valid for disconnected graphs)
    const firstCandidate = candidates[0];
    if (firstCandidate === undefined) {
      throw new Error("No entry node found");
    }
    return firstCandidate.id;
  }

  const entry = candidates[0];
  if (entry === undefined) {
    throw new Error("No entry node found");
  }
  return entry.id;
}

/**
 * Kahn's algorithm topological sort — returns nodes in execution order.
 * Disconnected nodes are appended after the connected component.
 */
function topologicalSort(graph: PipelineGraph, entryId: string): GraphNode[] {
  const nodeMap = new Map<string, GraphNode>(graph.nodes.map((n) => [n.id, n]));
  const inDegree = new Map<string, number>();
  const adjList = new Map<string, string[]>();

  for (const node of graph.nodes) {
    inDegree.set(node.id, 0);
    adjList.set(node.id, []);
  }
  for (const edge of graph.edges) {
    adjList.get(edge.source)?.push(edge.target);
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
  }

  // Seed with entry node first for deterministic ordering
  const queue: string[] = [entryId];
  const visited = new Set<string>([entryId]);
  const result: GraphNode[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const node = nodeMap.get(current);
    if (node !== undefined) result.push(node);

    const neighbors = adjList.get(current) ?? [];
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
  }

  // Append any disconnected nodes (not reachable from entry)
  for (const node of graph.nodes) {
    if (!visited.has(node.id)) result.push(node);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Auto-layout: layered top-down (left-to-right layers)
// ---------------------------------------------------------------------------

const LAYER_GAP_X = NODE_WIDTH + 60;
const LAYER_GAP_Y = NODE_HEIGHT + 40;
const LAYOUT_ORIGIN_X = GRID_SIZE * 2;
const LAYOUT_ORIGIN_Y = GRID_SIZE * 2;

/**
 * Assigns positions to nodes using a simple BFS-based layer assignment.
 * Each node is placed in the earliest layer reachable from the entry node.
 * Within a layer nodes are stacked vertically.
 *
 * Mutates the position fields of the nodes array.
 */
export function applyAutoLayout(
  nodes: GraphNode[],
  edges: GraphEdge[],
  entryStepId: string
): void {
  if (nodes.length === 0) return;

  const nodeMap = new Map<string, GraphNode>(nodes.map((n) => [n.id, n]));
  const adjList = new Map<string, string[]>();

  for (const node of nodes) {
    adjList.set(node.id, []);
  }
  for (const edge of edges) {
    adjList.get(edge.source)?.push(edge.target);
  }

  // BFS to compute layer (depth) for each node
  const layerOf = new Map<string, number>();
  const queue: Array<{ id: string; layer: number }> = [{ id: entryStepId, layer: 0 }];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const item = queue.shift();
    if (item === undefined) break;
    const { id, layer } = item;

    if (visited.has(id)) continue;
    visited.add(id);
    layerOf.set(id, layer);

    for (const neighbor of adjList.get(id) ?? []) {
      if (!visited.has(neighbor)) {
        // A node may be reachable from multiple parents (e.g. conditional
        // branches merge) — use the maximum layer to avoid overlaps.
        const existing = layerOf.get(neighbor) ?? 0;
        queue.push({ id: neighbor, layer: Math.max(existing, layer + 1) });
      }
    }
  }

  // Assign disconnected nodes to the layer after the last used layer
  const maxLayer = Math.max(0, ...Array.from(layerOf.values()));
  let disconnectedLayer = maxLayer + 1;
  for (const node of nodes) {
    if (!layerOf.has(node.id)) {
      layerOf.set(node.id, disconnectedLayer++);
    }
  }

  // Group nodes by layer
  const layers = new Map<number, GraphNode[]>();
  for (const node of nodes) {
    const layer = layerOf.get(node.id) ?? 0;
    if (!layers.has(layer)) layers.set(layer, []);
    layers.get(layer)!.push(node);
  }

  // Assign positions: x is determined by layer, y by index within the layer
  for (const [layer, layerNodes] of Array.from(layers.entries())) {
    layerNodes.forEach((node, indexInLayer) => {
      const n = nodeMap.get(node.id);
      if (n === undefined) return;
      n.position = {
        x: LAYOUT_ORIGIN_X + layer * LAYER_GAP_X,
        y: LAYOUT_ORIGIN_Y + indexInLayer * LAYER_GAP_Y,
      };
    });
  }
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

function validateDefinitionForConversion(definition: ConvertibleDefinition): void {
  if (definition.version !== 1) {
    throw new Error(`Unsupported pipeline definition version: ${definition.version}`);
  }
  if (!Array.isArray(definition.steps) || definition.steps.length === 0) {
    throw new Error("Pipeline definition must contain at least one step");
  }
  if (typeof definition.entryStepId !== "string" || definition.entryStepId.length === 0) {
    throw new Error("Pipeline definition must have a non-empty entryStepId");
  }
  const stepIds = new Set(definition.steps.map((s) => s.id));
  if (!stepIds.has(definition.entryStepId)) {
    throw new Error(
      `entryStepId "${definition.entryStepId}" does not match any step in the definition`
    );
  }
}
