/**
 * Pre-built pipeline template definitions for the template gallery wizard.
 *
 * Each template provides a ready-to-use PipelineGraph so a user can start
 * with a sensible skeleton rather than an empty canvas. Nodes are
 * pre-positioned in a left-to-right layout that the VisualPipelineEditor
 * will render immediately without needing the auto-layout pass.
 *
 * WHY pre-positioned instead of relying on applyAutoLayout?
 * We want the template to appear exactly as designed — applyAutoLayout may
 * re-order nodes differently depending on edge topology. Static positions
 * guarantee the visual matches the template card preview.
 */

import type { PipelineGraph, GraphStepType } from "./graph-model.js";

// ---------------------------------------------------------------------------
// Layout constants — mirrors graph-model.ts constants but expressed here to
// avoid a circular dependency between the template file and graph-model.
// ---------------------------------------------------------------------------

/** Horizontal gap between node layers (node width 200 + 60px gap) */
const LAYER_X_STEP = 260;
/** Vertical gap between nodes in the same layer (node height 72 + 40px gap) */
const LAYER_Y_STEP = 112;
/** Canvas origin for template nodes */
const ORIGIN_X = 40;
const ORIGIN_Y = 40;

// ---------------------------------------------------------------------------
// Builder helpers — create consistently-shaped nodes and edges
// ---------------------------------------------------------------------------

function node(
  id: string,
  type: GraphStepType,
  label: string,
  layer: number,
  indexInLayer = 0,
): PipelineGraph["nodes"][number] {
  return {
    id,
    type,
    label,
    position: {
      x: ORIGIN_X + layer * LAYER_X_STEP,
      y: ORIGIN_Y + indexInLayer * LAYER_Y_STEP,
    },
    config: {},
  };
}

function edge(source: string, target: string, label?: "then" | "else"): PipelineGraph["edges"][number] {
  return {
    id: `${source}→${target}${label !== undefined ? `→${label}` : ""}`,
    source,
    target,
    ...(label !== undefined ? { label } : {}),
  };
}

// ---------------------------------------------------------------------------
// Template definitions
// ---------------------------------------------------------------------------

export interface PipelineTemplate {
  /** Unique key — used for stable React keys and analytics */
  key: string;
  /** Display name shown on the template card */
  name: string;
  /** One-sentence description of what this pipeline does */
  description: string;
  /**
   * Lucide icon name string. The gallery component maps this to the actual
   * icon component so this file has no lucide-react import dependency.
   */
  icon: string;
  /** Approximate node count — shown on the card as a quick complexity hint */
  nodeCount: number;
  /** Ready-to-use graph; applied to the VisualPipelineEditor when selected */
  graph: PipelineGraph;
}

export const PIPELINE_TEMPLATES: PipelineTemplate[] = [
  // ---------------------------------------------------------------------------
  // REST API to Database
  // ---------------------------------------------------------------------------
  {
    key: "rest-api-to-database",
    name: "REST API to Database",
    description: "Fetch data from a REST API, transform it, and write the results to a database.",
    icon: "Plug",
    nodeCount: 3,
    graph: {
      nodes: [
        node("n1", "connector", "REST API Source", 0),
        node("n2", "transform", "Transform Data", 1),
        node("n3", "connector", "Write to Database", 2),
      ],
      edges: [
        edge("n1", "n2"),
        edge("n2", "n3"),
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // Database Sync
  // ---------------------------------------------------------------------------
  {
    key: "database-sync",
    name: "Database Sync",
    description: "Read from a source database, map schemas, and write to a destination database.",
    icon: "ArrowLeftRight",
    nodeCount: 3,
    graph: {
      nodes: [
        node("n1", "connector", "Source Database", 0),
        node("n2", "transform", "Schema Mapping", 1),
        node("n3", "connector", "Destination Database", 2),
      ],
      edges: [
        edge("n1", "n2"),
        edge("n2", "n3"),
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // Webhook Processing
  // ---------------------------------------------------------------------------
  {
    key: "webhook-processing",
    name: "Webhook Processing",
    description: "Receive a webhook event, transform the payload, run custom code, then forward it.",
    icon: "Webhook",
    nodeCount: 4,
    graph: {
      nodes: [
        node("n1", "webhook", "Webhook Trigger", 0),
        node("n2", "transform", "Transform Payload", 1),
        node("n3", "code", "Custom Logic", 2),
        node("n4", "connector", "Forward to Destination", 3),
      ],
      edges: [
        edge("n1", "n2"),
        edge("n2", "n3"),
        edge("n3", "n4"),
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // Scheduled ETL
  // ---------------------------------------------------------------------------
  {
    key: "scheduled-etl",
    name: "Scheduled ETL",
    description: "Run a scheduled extract-transform-load job with a filter step to drop bad rows.",
    icon: "Clock",
    nodeCount: 4,
    graph: {
      nodes: [
        node("n1", "connector", "Extract (Cron Source)", 0),
        node("n2", "transform", "Transform", 1),
        node("n3", "conditional", "Filter Invalid Rows", 2),
        node("n4", "connector", "Load to Destination", 3),
      ],
      edges: [
        edge("n1", "n2"),
        edge("n2", "n3"),
        edge("n3", "n4", "then"),
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // Data Enrichment
  // ---------------------------------------------------------------------------
  {
    key: "data-enrichment",
    name: "Data Enrichment",
    description: "Pull source records, call an external API to enrich them, then merge and store.",
    icon: "Code2",
    nodeCount: 4,
    graph: {
      nodes: [
        node("n1", "connector", "Source Records", 0),
        node("n2", "code", "API Lookup (Enrich)", 1),
        node("n3", "transform", "Merge Enriched Data", 2),
        node("n4", "connector", "Write Enriched Records", 3),
      ],
      edges: [
        edge("n1", "n2"),
        edge("n2", "n3"),
        edge("n3", "n4"),
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // Multi-Source Merge
  // ---------------------------------------------------------------------------
  {
    key: "multi-source-merge",
    name: "Multi-Source Merge",
    description: "Read from two independent sources in parallel, merge the results, then write.",
    icon: "Layers",
    nodeCount: 4,
    graph: {
      nodes: [
        // Two source nodes at the same layer (index 0 and 1)
        node("n1", "connector", "Source A", 0, 0),
        node("n2", "connector", "Source B", 0, 1),
        // Merge and destination are sequential after the sources
        node("n3", "transform", "Merge Results", 1, 0),
        node("n4", "connector", "Write to Destination", 2, 0),
      ],
      edges: [
        edge("n1", "n3"),
        edge("n2", "n3"),
        edge("n3", "n4"),
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // Approval Workflow
  // ---------------------------------------------------------------------------
  {
    key: "approval-workflow",
    name: "Approval Workflow",
    description: "Process incoming data, pause for human review, then route based on the decision.",
    icon: "GitBranch",
    nodeCount: 4,
    graph: {
      nodes: [
        node("n1", "connector", "Ingest Data", 0),
        node("n2", "approval", "Human Review", 1),
        node("n3", "connector", "Approved: Write Output", 2, 0),
        node("n4", "code", "Rejected: Log & Notify", 2, 1),
      ],
      edges: [
        edge("n1", "n2"),
        edge("n2", "n3", "then"),
        edge("n2", "n4", "else"),
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // Sub-workflow Orchestration
  // ---------------------------------------------------------------------------
  {
    key: "sub-workflow-orchestration",
    name: "Sub-workflow Orchestration",
    description: "Fan data out through multiple specialised sub-pipelines, then aggregate.",
    icon: "Workflow",
    nodeCount: 4,
    graph: {
      nodes: [
        node("n1", "connector", "Data Source", 0),
        node("n2", "sub_workflow", "Sub-pipeline A", 1, 0),
        node("n3", "sub_workflow", "Sub-pipeline B", 1, 1),
        node("n4", "transform", "Aggregate Results", 2),
      ],
      edges: [
        edge("n1", "n2"),
        edge("n1", "n3"),
        edge("n2", "n4"),
        edge("n3", "n4"),
      ],
    },
  },
];
