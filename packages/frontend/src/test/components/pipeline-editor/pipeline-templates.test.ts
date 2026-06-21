/**
 * Tests for pipeline-templates.ts
 *
 * Covers:
 * - Every template has required fields
 * - Every template graph has at least one node and one edge (multi-node templates)
 * - Node types are valid GraphStepType values
 * - Nodes have positive non-overlapping positions (unique id, positive x/y)
 * - Edges reference nodes that exist in the same graph
 * - Templates are usable with graphToPipelineDefinition (no entry-node errors)
 */
import { describe, it, expect } from "vitest";
import { PIPELINE_TEMPLATES } from "@/components/pipeline-editor/pipeline-templates.js";
import type { PipelineTemplate } from "@/components/pipeline-editor/pipeline-templates.js";
import { graphToPipelineDefinition } from "@/components/pipeline-editor/graph-converter.js";
import type { GraphStepType } from "@/components/pipeline-editor/graph-model.js";

const VALID_STEP_TYPES: GraphStepType[] = [
  "code",
  "connector",
  "transformer",
  "transform",
  "conditional",
  "parallel",
  "webhook",
  "wait",
  "approval",
  "sub_workflow",
];

// ---------------------------------------------------------------------------
// Shape validation
// ---------------------------------------------------------------------------

describe("PIPELINE_TEMPLATES array", () => {
  it("exports at least 6 templates", () => {
    expect(PIPELINE_TEMPLATES.length).toBeGreaterThanOrEqual(6);
  });

  it("every template has a non-empty key", () => {
    for (const t of PIPELINE_TEMPLATES) {
      expect(typeof t.key).toBe("string");
      expect(t.key.trim().length).toBeGreaterThan(0);
    }
  });

  it("every template has a non-empty name", () => {
    for (const t of PIPELINE_TEMPLATES) {
      expect(typeof t.name).toBe("string");
      expect(t.name.trim().length).toBeGreaterThan(0);
    }
  });

  it("every template has a non-empty description", () => {
    for (const t of PIPELINE_TEMPLATES) {
      expect(typeof t.description).toBe("string");
      expect(t.description.trim().length).toBeGreaterThan(0);
    }
  });

  it("every template has a non-empty icon string", () => {
    for (const t of PIPELINE_TEMPLATES) {
      expect(typeof t.icon).toBe("string");
      expect(t.icon.trim().length).toBeGreaterThan(0);
    }
  });

  it("nodeCount matches the actual node count in the graph", () => {
    for (const t of PIPELINE_TEMPLATES) {
      expect(t.nodeCount).toBe(t.graph.nodes.length);
    }
  });

  it("template keys are unique", () => {
    const keys = PIPELINE_TEMPLATES.map((t) => t.key);
    const unique = new Set(keys);
    expect(unique.size).toBe(keys.length);
  });
});

// ---------------------------------------------------------------------------
// Graph integrity checks
// ---------------------------------------------------------------------------

describe("template graphs", () => {
  function nodeIds(t: PipelineTemplate): Set<string> {
    return new Set(t.graph.nodes.map((n) => n.id));
  }

  it("every graph has at least one node", () => {
    for (const t of PIPELINE_TEMPLATES) {
      expect(t.graph.nodes.length).toBeGreaterThan(0);
    }
  });

  it("every node id is unique within its graph", () => {
    for (const t of PIPELINE_TEMPLATES) {
      const ids = t.graph.nodes.map((n) => n.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("every node has a valid GraphStepType", () => {
    for (const t of PIPELINE_TEMPLATES) {
      for (const node of t.graph.nodes) {
        expect(VALID_STEP_TYPES).toContain(node.type);
      }
    }
  });

  it("every node has non-negative x and y coordinates", () => {
    for (const t of PIPELINE_TEMPLATES) {
      for (const node of t.graph.nodes) {
        expect(node.position.x).toBeGreaterThanOrEqual(0);
        expect(node.position.y).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("every node has a non-empty label", () => {
    for (const t of PIPELINE_TEMPLATES) {
      for (const node of t.graph.nodes) {
        expect(typeof node.label).toBe("string");
        expect(node.label.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("every edge references source and target nodes that exist in the graph", () => {
    for (const t of PIPELINE_TEMPLATES) {
      const ids = nodeIds(t);
      for (const edge of t.graph.edges) {
        expect(ids.has(edge.source)).toBe(true);
        expect(ids.has(edge.target)).toBe(true);
      }
    }
  });

  it("every edge id is unique within its graph", () => {
    for (const t of PIPELINE_TEMPLATES) {
      const edgeIds = t.graph.edges.map((e) => e.id);
      expect(new Set(edgeIds).size).toBe(edgeIds.length);
    }
  });

  it("every graph with more than one node has at least one edge", () => {
    for (const t of PIPELINE_TEMPLATES) {
      if (t.graph.nodes.length > 1) {
        expect(t.graph.edges.length).toBeGreaterThan(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Converter compatibility
// ---------------------------------------------------------------------------

describe("graphToPipelineDefinition compatibility", () => {
  it("every template graph converts to a valid pipeline definition without throwing", () => {
    for (const t of PIPELINE_TEMPLATES) {
      // Multi-node templates that form a DAG must convert without error.
      // Single-node templates are trivially valid.
      expect(() => graphToPipelineDefinition(t.graph)).not.toThrow();
    }
  });

  it("converted definition version is 1 for all templates", () => {
    for (const t of PIPELINE_TEMPLATES) {
      const def = graphToPipelineDefinition(t.graph);
      expect(def.version).toBe(1);
    }
  });

  it("converted definition entryStepId matches a node id in the template graph", () => {
    for (const t of PIPELINE_TEMPLATES) {
      const def = graphToPipelineDefinition(t.graph);
      const nodeIds = new Set(t.graph.nodes.map((n) => n.id));
      expect(nodeIds.has(def.entryStepId)).toBe(true);
    }
  });

  it("step count in converted definition equals node count in template graph", () => {
    for (const t of PIPELINE_TEMPLATES) {
      const def = graphToPipelineDefinition(t.graph);
      expect(def.steps.length).toBe(t.graph.nodes.length);
    }
  });
});
