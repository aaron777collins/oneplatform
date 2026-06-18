/**
 * Tests for graph-converter.ts
 *
 * Covers:
 * - pipelineDefinitionToGraph — converts API definition to visual graph
 * - graphToPipelineDefinition — converts visual graph back to API definition
 * - Round-trip fidelity: definition → graph → definition
 * - applyAutoLayout — positional correctness
 * - Error paths: empty steps, bad entryStepId, cycle detection
 */
import { describe, it, expect } from "vitest";
import {
  pipelineDefinitionToGraph,
  graphToPipelineDefinition,
  applyAutoLayout,
  type ConvertibleDefinition,
} from "@/components/pipeline-editor/graph-converter.js";
import type { GraphNode, GraphEdge } from "@/components/pipeline-editor/graph-model.js";
import { GRID_SIZE, NODE_WIDTH, NODE_HEIGHT } from "@/components/pipeline-editor/graph-model.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function linearDefinition(): ConvertibleDefinition {
  return {
    version: 1,
    entryStepId: "step-a",
    steps: [
      { id: "step-a", name: "Fetch data", type: "connector", connectorInstanceId: "uuid-1" },
      { id: "step-b", name: "Filter rows", type: "transform", transform: { operation: "filter", condition: "x > 0" } },
      { id: "step-c", name: "Send webhook", type: "webhook", url: "https://example.com", method: "POST" },
    ],
  };
}

function conditionalDefinition(): ConvertibleDefinition {
  return {
    version: 1,
    entryStepId: "step-a",
    steps: [
      {
        id: "step-a",
        name: "Check status",
        type: "conditional",
        condition: { field: "status", operator: "eq", value: "active" },
        thenStepId: "step-b",
        elseStepId: "step-c",
      },
      { id: "step-b", name: "Handle active", type: "code", language: "typescript", code: "return true;" },
      { id: "step-c", name: "Handle inactive", type: "code", language: "typescript", code: "return false;" },
    ],
  };
}

// ---------------------------------------------------------------------------
// pipelineDefinitionToGraph
// ---------------------------------------------------------------------------

describe("pipelineDefinitionToGraph", () => {
  it("produces one node per step", () => {
    const graph = pipelineDefinitionToGraph(linearDefinition());
    expect(graph.nodes).toHaveLength(3);
  });

  it("maps step id, name, and type correctly", () => {
    const graph = pipelineDefinitionToGraph(linearDefinition());
    const node = graph.nodes.find((n) => n.id === "step-a");
    expect(node).toBeDefined();
    expect(node!.label).toBe("Fetch data");
    expect(node!.type).toBe("connector");
  });

  it("carries step-specific config fields onto the node", () => {
    const graph = pipelineDefinitionToGraph(linearDefinition());
    const webhookNode = graph.nodes.find((n) => n.id === "step-c");
    expect(webhookNode!.config.url).toBe("https://example.com");
    expect(webhookNode!.config.method).toBe("POST");
  });

  it("produces edges for sequential steps", () => {
    const graph = pipelineDefinitionToGraph(linearDefinition());
    // Expect a → b and b → c
    const abEdge = graph.edges.find((e) => e.source === "step-a" && e.target === "step-b");
    const bcEdge = graph.edges.find((e) => e.source === "step-b" && e.target === "step-c");
    expect(abEdge).toBeDefined();
    expect(bcEdge).toBeDefined();
  });

  it("produces labelled then/else edges for conditional steps", () => {
    const graph = pipelineDefinitionToGraph(conditionalDefinition());
    const thenEdge = graph.edges.find((e) => e.source === "step-a" && e.label === "then");
    const elseEdge = graph.edges.find((e) => e.source === "step-a" && e.label === "else");
    expect(thenEdge?.target).toBe("step-b");
    expect(elseEdge?.target).toBe("step-c");
  });

  it("assigns non-zero positions via auto-layout", () => {
    const graph = pipelineDefinitionToGraph(linearDefinition());
    // All nodes must have been positioned
    for (const node of graph.nodes) {
      expect(node.position.x).toBeGreaterThanOrEqual(0);
      expect(node.position.y).toBeGreaterThanOrEqual(0);
    }
  });

  it("throws on unsupported version", () => {
    const bad = { ...linearDefinition(), version: 2 } as unknown as ConvertibleDefinition;
    expect(() => pipelineDefinitionToGraph(bad)).toThrow(/unsupported.*version/i);
  });

  it("throws when entryStepId does not match any step", () => {
    const bad = { ...linearDefinition(), entryStepId: "nonexistent" };
    expect(() => pipelineDefinitionToGraph(bad)).toThrow(/entryStepId/i);
  });

  it("throws on empty steps array", () => {
    const bad = { ...linearDefinition(), steps: [] };
    expect(() => pipelineDefinitionToGraph(bad)).toThrow(/at least one step/i);
  });
});

// ---------------------------------------------------------------------------
// graphToPipelineDefinition
// ---------------------------------------------------------------------------

describe("graphToPipelineDefinition", () => {
  it("produces version 1", () => {
    const graph = pipelineDefinitionToGraph(linearDefinition());
    const def = graphToPipelineDefinition(graph);
    expect(def.version).toBe(1);
  });

  it("sets entryStepId to the node with no incoming edges", () => {
    const graph = pipelineDefinitionToGraph(linearDefinition());
    const def = graphToPipelineDefinition(graph);
    expect(def.entryStepId).toBe("step-a");
  });

  it("includes all steps in the output", () => {
    const graph = pipelineDefinitionToGraph(linearDefinition());
    const def = graphToPipelineDefinition(graph);
    expect(def.steps).toHaveLength(3);
  });

  it("maps node label back to step name", () => {
    const graph = pipelineDefinitionToGraph(linearDefinition());
    const def = graphToPipelineDefinition(graph);
    const stepA = def.steps.find((s) => s.id === "step-a");
    expect(stepA?.name).toBe("Fetch data");
  });

  it("preserves step type", () => {
    const graph = pipelineDefinitionToGraph(linearDefinition());
    const def = graphToPipelineDefinition(graph);
    const stepC = def.steps.find((s) => s.id === "step-c");
    expect(stepC?.type).toBe("webhook");
  });

  it("throws on empty graph", () => {
    expect(() => graphToPipelineDefinition({ nodes: [], edges: [] })).toThrow(/empty graph/i);
  });
});

// ---------------------------------------------------------------------------
// Round-trip
// ---------------------------------------------------------------------------

describe("round-trip conversion", () => {
  it("linear pipeline: step ids are preserved", () => {
    const original = linearDefinition();
    const graph = pipelineDefinitionToGraph(original);
    const roundTripped = graphToPipelineDefinition(graph);

    const originalIds = original.steps.map((s) => s.id).sort();
    const roundTrippedIds = roundTripped.steps.map((s) => s.id).sort();
    expect(roundTrippedIds).toEqual(originalIds);
  });

  it("linear pipeline: step names are preserved", () => {
    const original = linearDefinition();
    const graph = pipelineDefinitionToGraph(original);
    const roundTripped = graphToPipelineDefinition(graph);

    for (const originalStep of original.steps) {
      const rtStep = roundTripped.steps.find((s) => s.id === originalStep.id);
      expect(rtStep?.name).toBe(originalStep.name);
    }
  });

  it("linear pipeline: step types are preserved", () => {
    const original = linearDefinition();
    const graph = pipelineDefinitionToGraph(original);
    const roundTripped = graphToPipelineDefinition(graph);

    for (const originalStep of original.steps) {
      const rtStep = roundTripped.steps.find((s) => s.id === originalStep.id);
      expect(rtStep?.type).toBe(originalStep.type);
    }
  });

  it("conditional pipeline: branch step IDs are preserved", () => {
    const original = conditionalDefinition();
    const graph = pipelineDefinitionToGraph(original);
    const roundTripped = graphToPipelineDefinition(graph);

    const rtStepA = roundTripped.steps.find((s) => s.id === "step-a");
    expect(rtStepA?.thenStepId).toBe("step-b");
    expect(rtStepA?.elseStepId).toBe("step-c");
  });

  it("code step: code field is preserved", () => {
    const original: ConvertibleDefinition = {
      version: 1,
      entryStepId: "s1",
      steps: [{ id: "s1", name: "Run script", type: "code", language: "typescript", code: "return 42;" }],
    };
    const graph = pipelineDefinitionToGraph(original);
    const roundTripped = graphToPipelineDefinition(graph);
    expect(roundTripped.steps[0]?.code).toBe("return 42;");
  });
});

// ---------------------------------------------------------------------------
// applyAutoLayout
// ---------------------------------------------------------------------------

describe("applyAutoLayout", () => {
  function makeNodes(count: number): GraphNode[] {
    return Array.from({ length: count }, (_, i) => ({
      id: `n${i}`,
      type: "code" as const,
      position: { x: 0, y: 0 },
      config: {},
      label: `Node ${i}`,
    }));
  }

  it("positions all nodes at non-negative coordinates", () => {
    const nodes = makeNodes(3);
    const edges: GraphEdge[] = [
      { id: "e1", source: "n0", target: "n1" },
      { id: "e2", source: "n1", target: "n2" },
    ];
    applyAutoLayout(nodes, edges, "n0");

    for (const node of nodes) {
      expect(node.position.x).toBeGreaterThanOrEqual(0);
      expect(node.position.y).toBeGreaterThanOrEqual(0);
    }
  });

  it("assigns increasing x positions to sequential chain", () => {
    const nodes = makeNodes(3);
    const edges: GraphEdge[] = [
      { id: "e1", source: "n0", target: "n1" },
      { id: "e2", source: "n1", target: "n2" },
    ];
    applyAutoLayout(nodes, edges, "n0");

    const x0 = nodes.find((n) => n.id === "n0")!.position.x;
    const x1 = nodes.find((n) => n.id === "n1")!.position.x;
    const x2 = nodes.find((n) => n.id === "n2")!.position.x;

    expect(x1).toBeGreaterThan(x0);
    expect(x2).toBeGreaterThan(x1);
  });

  it("places parallel branches at the same x but different y", () => {
    // n0 → n1 and n0 → n2 (two branches from the same node)
    const nodes = makeNodes(3);
    const edges: GraphEdge[] = [
      { id: "e1", source: "n0", target: "n1" },
      { id: "e2", source: "n0", target: "n2" },
    ];
    applyAutoLayout(nodes, edges, "n0");

    const n1 = nodes.find((n) => n.id === "n1")!;
    const n2 = nodes.find((n) => n.id === "n2")!;

    expect(n1.position.x).toBe(n2.position.x);
    expect(n1.position.y).not.toBe(n2.position.y);
  });

  it("positions are grid-aligned", () => {
    const nodes = makeNodes(4);
    const edges: GraphEdge[] = [
      { id: "e1", source: "n0", target: "n1" },
      { id: "e2", source: "n1", target: "n2" },
      { id: "e3", source: "n2", target: "n3" },
    ];
    applyAutoLayout(nodes, edges, "n0");

    for (const node of nodes) {
      expect(node.position.x % GRID_SIZE).toBe(0);
      expect(node.position.y % GRID_SIZE).toBe(0);
    }
  });

  it("handles disconnected nodes gracefully", () => {
    const nodes = makeNodes(3); // n0, n1 connected; n2 disconnected
    const edges: GraphEdge[] = [{ id: "e1", source: "n0", target: "n1" }];
    applyAutoLayout(nodes, edges, "n0");

    const n2 = nodes.find((n) => n.id === "n2")!;
    // Disconnected node must still receive a position
    expect(typeof n2.position.x).toBe("number");
    expect(typeof n2.position.y).toBe("number");
  });

  it("is a no-op for empty nodes array", () => {
    // Should not throw
    expect(() => applyAutoLayout([], [], "n0")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Connection validation helpers (cycle detection via converter)
// ---------------------------------------------------------------------------

describe("cycle detection", () => {
  it("graphToPipelineDefinition throws when every node has an incoming edge (pure cycle)", () => {
    // n0 → n1 → n0 — neither node has zero in-degree
    const nodes: GraphNode[] = [
      { id: "n0", type: "code", position: { x: 0, y: 0 }, config: {}, label: "A" },
      { id: "n1", type: "code", position: { x: 100, y: 0 }, config: {}, label: "B" },
    ];
    const edges: GraphEdge[] = [
      { id: "e1", source: "n0", target: "n1" },
      { id: "e2", source: "n1", target: "n0" },
    ];
    expect(() => graphToPipelineDefinition({ nodes, edges })).toThrow(/cycle/i);
  });
});
