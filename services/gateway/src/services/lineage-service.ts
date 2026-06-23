// Data lineage tracking service.
//
// Builds an on-demand directed acyclic graph (DAG) that describes how data
// moves through the platform: connectors ingest into raw tables, raw tables
// map to ontology types, ontology types feed pipeline inputs, and pipeline
// outputs are consumed by apps.
//
// WHY the gateway owns this:
//   The gateway is the only service that knows the full topology. Building the
//   lineage graph here keeps it a pure read-only projection — no persistent
//   lineage store is needed and the graph is always computed from live data.
//
// WHY on-demand (no persistent store):
//   Lineage relationships change infrequently relative to read frequency. An
//   on-demand approach avoids cache invalidation complexity and guarantees
//   accuracy at query time. Caching can be layered in later if benchmarks
//   show the fan-out calls are a bottleneck.

import type { Logger, ServiceTokenSigner } from "@oneplatform/core";

// ---------------------------------------------------------------------------
// Public graph types
// ---------------------------------------------------------------------------

export type LineageNodeType =
  | "connector"
  | "raw_table"
  | "ontology_type"
  | "pipeline"
  | "pipeline_step"
  | "app";

export type LineageEdgeRelationship =
  | "ingests_from"
  | "maps_to"
  | "transforms"
  | "consumes";

export interface LineageNode {
  id: string;
  type: LineageNodeType;
  name: string;
  metadata: Record<string, unknown>;
}

export interface LineageEdge {
  source: string; // node ID
  target: string; // node ID
  relationship: LineageEdgeRelationship;
  metadata?: Record<string, unknown>;
}

export interface LineageGraph {
  nodes: LineageNode[];
  edges: LineageEdge[];
}

// ---------------------------------------------------------------------------
// Service dependencies
// ---------------------------------------------------------------------------

export interface LineageServiceConfig {
  ingestionServiceUrl: string;
  ontologyServiceUrl: string;
  pipelineServiceUrl: string;
  appServiceUrl: string;
  serviceTokenSigner?: ServiceTokenSigner;
  /** Per-call HTTP timeout. Defaults to 10 000 ms. */
  timeoutMs?: number;
}

export interface LineageServiceDeps {
  config: LineageServiceConfig;
  logger: Logger;
}

// ---------------------------------------------------------------------------
// Public service interface
// ---------------------------------------------------------------------------

export interface LineageService {
  /**
   * Build the full lineage graph for a tenant.
   * Optionally scoped to the sub-graph reachable from a single entity.
   */
  buildLineageGraph(
    tenantId: string,
    entityType?: LineageNodeType,
    entityId?: string,
  ): Promise<LineageGraph>;
}

// ---------------------------------------------------------------------------
// Internal wire shapes for downstream service responses
// ---------------------------------------------------------------------------

interface ConnectorPayload {
  id: string;
  name: string;
  plugin_id: string;
  instance_id: string;
  is_enabled: boolean;
  [key: string]: unknown;
}

interface MappingRulePayload {
  id: string;
  connector_id: string;
  target_entity_id: string;
  [key: string]: unknown;
}

interface EntityPayload {
  id: string;
  name: string;
  slug: string;
  [key: string]: unknown;
}

interface PipelinePayload {
  id: string;
  name: string;
  slug: string;
  is_active: boolean;
  definition: {
    steps: Array<{
      id: string;
      name: string;
      type: string;
      connectorInstanceId?: string;
      [key: string]: unknown;
    }>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface AppPayload {
  id: string;
  name: string;
  slug: string;
  entity_type?: string;
  entity_types?: string[];
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Cycle detection
// ---------------------------------------------------------------------------

// DFS-based cycle detection returns the set of node IDs involved in a cycle
// so callers can log a specific warning rather than a generic "cycle found".
function detectCycle(
  nodes: LineageNode[],
  edges: LineageEdge[],
): string[] {
  const adj = new Map<string, string[]>();
  for (const node of nodes) {
    adj.set(node.id, []);
  }
  for (const edge of edges) {
    const neighbors = adj.get(edge.source);
    if (neighbors !== undefined) {
      neighbors.push(edge.target);
    }
  }

  const visited = new Set<string>();
  const inStack = new Set<string>();
  const cycleNodes: string[] = [];

  function dfs(nodeId: string): boolean {
    if (inStack.has(nodeId)) {
      cycleNodes.push(nodeId);
      return true;
    }
    if (visited.has(nodeId)) return false;

    visited.add(nodeId);
    inStack.add(nodeId);

    for (const neighbor of adj.get(nodeId) ?? []) {
      if (dfs(neighbor)) return true;
    }

    inStack.delete(nodeId);
    return false;
  }

  for (const node of nodes) {
    if (!visited.has(node.id)) {
      if (dfs(node.id)) break;
    }
  }

  return cycleNodes;
}

// ---------------------------------------------------------------------------
// Sub-graph extraction — BFS from a root node in both directions
// ---------------------------------------------------------------------------

function extractSubgraph(
  graph: LineageGraph,
  rootId: string,
): LineageGraph {
  const nodeIndex = new Map<string, LineageNode>();
  for (const node of graph.nodes) {
    nodeIndex.set(node.id, node);
  }

  const reachable = new Set<string>();
  const queue: string[] = [rootId];

  // Build adjacency for both directions so we surface the full sub-graph
  // regardless of whether the root is upstream or downstream of other nodes.
  const forward = new Map<string, string[]>();
  const backward = new Map<string, string[]>();
  for (const node of graph.nodes) {
    forward.set(node.id, []);
    backward.set(node.id, []);
  }
  for (const edge of graph.edges) {
    forward.get(edge.source)?.push(edge.target);
    backward.get(edge.target)?.push(edge.source);
  }

  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined || reachable.has(id)) continue;
    reachable.add(id);

    for (const neighbor of [...(forward.get(id) ?? []), ...(backward.get(id) ?? [])]) {
      if (!reachable.has(neighbor)) {
        queue.push(neighbor);
      }
    }
  }

  const nodes = graph.nodes.filter((n) => reachable.has(n.id));
  const edges = graph.edges.filter(
    (e) => reachable.has(e.source) && reachable.has(e.target),
  );

  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createLineageService(deps: LineageServiceDeps): LineageService {
  const { config, logger } = deps;
  const timeoutMs = config.timeoutMs ?? 10_000;

  // -------------------------------------------------------------------------
  // callService — authenticated GET to an internal service endpoint.
  // Returns an empty array/object on non-ok responses so one unavailable
  // service does not fail the entire graph build.
  // -------------------------------------------------------------------------

  async function callService(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        headers: config.serviceTokenSigner !== undefined
          ? { "X-Service-Token": await config.serviceTokenSigner.sign() }
          : {},
        signal: controller.signal,
      });

      if (!response.ok) {
        // Log but do not throw — a partially-degraded graph is better than no graph.
        logger.warn("Lineage: upstream call returned non-ok status", {
          url,
          status: response.status,
        });
        return null;
      }

      return await response.json();
    } catch (err) {
      logger.warn("Lineage: upstream call failed", {
        url,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // -------------------------------------------------------------------------
  // fetchConnectors — list all connectors for the tenant
  // -------------------------------------------------------------------------

  async function fetchConnectors(tenantId: string): Promise<ConnectorPayload[]> {
    const url =
      `${config.ingestionServiceUrl}/internal/ingestion/connectors?tenantId=${encodeURIComponent(tenantId)}&limit=1000`;
    const body = await callService(url);
    if (body === null || typeof body !== "object") return [];
    const data = (body as Record<string, unknown>)["data"];
    if (!Array.isArray(data)) return [];
    return data as ConnectorPayload[];
  }

  // -------------------------------------------------------------------------
  // fetchMappingRules — list all active mapping rules for the tenant
  // -------------------------------------------------------------------------

  async function fetchMappingRules(tenantId: string): Promise<MappingRulePayload[]> {
    const url =
      `${config.ontologyServiceUrl}/internal/ontology/mapping-rules?tenantId=${encodeURIComponent(tenantId)}&limit=1000`;
    const body = await callService(url);
    if (body === null || typeof body !== "object") return [];
    const data = (body as Record<string, unknown>)["data"];
    if (!Array.isArray(data)) return [];
    return data as MappingRulePayload[];
  }

  // -------------------------------------------------------------------------
  // fetchEntities — list all ontology entity types for the tenant
  // -------------------------------------------------------------------------

  async function fetchEntities(tenantId: string): Promise<EntityPayload[]> {
    const url =
      `${config.ontologyServiceUrl}/internal/ontology/entities?tenantId=${encodeURIComponent(tenantId)}&limit=1000`;
    const body = await callService(url);
    if (body === null || typeof body !== "object") return [];
    const data = (body as Record<string, unknown>)["data"];
    if (!Array.isArray(data)) return [];
    return data as EntityPayload[];
  }

  // -------------------------------------------------------------------------
  // fetchPipelines — list all pipelines for the tenant
  // -------------------------------------------------------------------------

  async function fetchPipelines(tenantId: string): Promise<PipelinePayload[]> {
    const url =
      `${config.pipelineServiceUrl}/internal/pipeline/pipelines?tenantId=${encodeURIComponent(tenantId)}&limit=1000`;
    const body = await callService(url);
    if (body === null || typeof body !== "object") return [];
    const data = (body as Record<string, unknown>)["data"];
    if (!Array.isArray(data)) return [];
    // Cast through unknown to satisfy strict-mode array variance.
    return (data as unknown[]).filter(
      (p): p is PipelinePayload =>
        typeof p === "object" && p !== null && "definition" in p,
    );
  }

  // -------------------------------------------------------------------------
  // fetchApps — list all apps for the tenant
  // -------------------------------------------------------------------------

  async function fetchApps(tenantId: string): Promise<AppPayload[]> {
    const url =
      `${config.appServiceUrl}/internal/app/apps?tenantId=${encodeURIComponent(tenantId)}&limit=1000`;
    const body = await callService(url);
    if (body === null || typeof body !== "object") return [];
    const data = (body as Record<string, unknown>)["data"];
    if (!Array.isArray(data)) return [];
    return data as AppPayload[];
  }

  // -------------------------------------------------------------------------
  // buildLineageGraph — assemble the full tenant graph then optionally scope it
  // -------------------------------------------------------------------------

  async function buildLineageGraph(
    tenantId: string,
    entityType?: LineageNodeType,
    entityId?: string,
  ): Promise<LineageGraph> {
    if (!tenantId || tenantId.trim() === "") {
      throw new Error("buildLineageGraph: tenantId must be a non-empty string.");
    }

    // Fan-out to all services in parallel — each fetch is independently
    // fault-tolerant so a degraded service produces a partial graph, not an error.
    const [connectors, mappingRules, entities, pipelines, apps] = await Promise.all([
      fetchConnectors(tenantId),
      fetchMappingRules(tenantId),
      fetchEntities(tenantId),
      fetchPipelines(tenantId),
      fetchApps(tenantId),
    ]);

    const nodes: LineageNode[] = [];
    const edges: LineageEdge[] = [];

    // -----------------------------------------------------------------------
    // Layer 1: Connector → raw_table nodes and ingests_from edges.
    //
    // Each connector has a corresponding raw table in the ingestion schema
    // (named after the connector's instance_id). We model both as separate
    // nodes so the graph accurately represents the ingestion boundary.
    // -----------------------------------------------------------------------

    const connectorIdToRawTableId = new Map<string, string>();

    for (const connector of connectors) {
      const connectorNodeId = `connector:${connector.id}`;
      const rawTableNodeId = `raw_table:${connector.id}`;

      nodes.push({
        id: connectorNodeId,
        type: "connector",
        name: connector.name,
        metadata: {
          pluginId: connector.plugin_id,
          instanceId: connector.instance_id,
          isEnabled: connector.is_enabled,
        },
      });

      nodes.push({
        id: rawTableNodeId,
        type: "raw_table",
        name: `raw:${connector.name}`,
        metadata: {
          connectorId: connector.id,
          instanceId: connector.instance_id,
        },
      });

      edges.push({
        source: connectorNodeId,
        target: rawTableNodeId,
        relationship: "ingests_from",
      });

      connectorIdToRawTableId.set(connector.id, rawTableNodeId);
    }

    // -----------------------------------------------------------------------
    // Layer 2: raw_table → ontology_type via mapping rules.
    //
    // A mapping rule links a connector (the source of raw data) to a target
    // entity type. We draw the edge from the raw_table node (not the connector
    // node) because it is the data artifact that actually gets mapped.
    // -----------------------------------------------------------------------

    // Index entities by ID for fast lookup during edge construction.
    const entityById = new Map<string, EntityPayload>();
    for (const entity of entities) {
      nodes.push({
        id: `ontology_type:${entity.id}`,
        type: "ontology_type",
        name: entity.name,
        metadata: { slug: entity.slug },
      });
      entityById.set(entity.id, entity);
    }

    // Track which (rawTable, entityType) pairs already have an edge to deduplicate
    // when multiple mapping rules for the same connector target the same entity.
    const mappingEdgeKeys = new Set<string>();

    for (const rule of mappingRules) {
      const rawTableNodeId = connectorIdToRawTableId.get(rule.connector_id);
      const entity = entityById.get(rule.target_entity_id);

      // Gracefully skip rules whose connector or entity has been deleted.
      if (rawTableNodeId === undefined || entity === undefined) continue;

      const edgeKey = `${rawTableNodeId}→ontology_type:${rule.target_entity_id}`;
      if (mappingEdgeKeys.has(edgeKey)) continue;
      mappingEdgeKeys.add(edgeKey);

      edges.push({
        source: rawTableNodeId,
        target: `ontology_type:${rule.target_entity_id}`,
        relationship: "maps_to",
        metadata: { ruleId: rule.id },
      });
    }

    // -----------------------------------------------------------------------
    // Layer 3: Pipeline nodes, step nodes, and transforms edges.
    //
    // Each pipeline becomes a node. Steps of type "connector" reference a
    // connector instance_id — we draw a "transforms" edge from the ontology
    // type(s) that the referenced connector maps to, to the pipeline node.
    // Each step also becomes its own node connected to its parent pipeline.
    // -----------------------------------------------------------------------

    // Build an instance_id → connector mapping for connector-step resolution.
    const connectorByInstanceId = new Map<string, ConnectorPayload>();
    for (const connector of connectors) {
      connectorByInstanceId.set(connector.instance_id, connector);
    }

    for (const pipeline of pipelines) {
      const pipelineNodeId = `pipeline:${pipeline.id}`;

      nodes.push({
        id: pipelineNodeId,
        type: "pipeline",
        name: pipeline.name,
        metadata: { slug: pipeline.slug, isActive: pipeline.is_active },
      });

      const steps = Array.isArray(pipeline.definition.steps)
        ? pipeline.definition.steps
        : [];

      for (const step of steps) {
        const stepNodeId = `pipeline_step:${pipeline.id}:${step.id}`;

        nodes.push({
          id: stepNodeId,
          type: "pipeline_step",
          name: step.name,
          metadata: {
            stepId: step.id,
            stepType: step.type,
            pipelineId: pipeline.id,
          },
        });

        // Step belongs to its pipeline.
        edges.push({
          source: pipelineNodeId,
          target: stepNodeId,
          relationship: "transforms",
        });

        // Connector steps create a dependency edge from the ontology types that
        // the referenced connector feeds into, to this pipeline step.
        if (step.type === "connector" && typeof step.connectorInstanceId === "string") {
          const connector = connectorByInstanceId.get(step.connectorInstanceId);
          if (connector !== undefined) {
            // Find all ontology types this connector feeds via mapping rules.
            const fedEntityIds = mappingRules
              .filter((r) => r.connector_id === connector.id)
              .map((r) => r.target_entity_id);

            for (const entityId of [...new Set(fedEntityIds)]) {
              if (entityById.has(entityId)) {
                edges.push({
                  source: `ontology_type:${entityId}`,
                  target: stepNodeId,
                  relationship: "transforms",
                  metadata: { connectorInstanceId: step.connectorInstanceId },
                });
              }
            }
          }
        }

        // Transformer steps reference entity types directly.
        if (step.type === "transformer" && typeof step["entityType"] === "string") {
          const entityTypeSlug = step["entityType"] as string;
          const entity = entities.find((e) => e.slug === entityTypeSlug);
          if (entity !== undefined) {
            edges.push({
              source: `ontology_type:${entity.id}`,
              target: stepNodeId,
              relationship: "transforms",
            });
          }
        }
      }
    }

    // -----------------------------------------------------------------------
    // Layer 4: App nodes and consumes edges from ontology types.
    //
    // Apps declare which entity types they consume. We draw "consumes" edges
    // from the ontology_type nodes to the app node.
    // -----------------------------------------------------------------------

    for (const app of apps) {
      const appNodeId = `app:${app.id}`;

      nodes.push({
        id: appNodeId,
        type: "app",
        name: app.name,
        metadata: { slug: app.slug },
      });

      // Support both single entity_type and multi entity_types fields.
      const consumedEntityTypes: string[] = [];
      if (typeof app.entity_type === "string") {
        consumedEntityTypes.push(app.entity_type);
      }
      if (Array.isArray(app.entity_types)) {
        for (const et of app.entity_types) {
          if (typeof et === "string") {
            consumedEntityTypes.push(et);
          }
        }
      }

      for (const entityTypeSlug of consumedEntityTypes) {
        const entity = entities.find((e) => e.slug === entityTypeSlug);
        if (entity !== undefined) {
          edges.push({
            source: `ontology_type:${entity.id}`,
            target: appNodeId,
            relationship: "consumes",
          });
        }
      }
    }

    const fullGraph: LineageGraph = { nodes, edges };

    // -----------------------------------------------------------------------
    // Cycle detection — lineage should always be a DAG. Log a warning but
    // return the graph as-is so the caller can inspect what caused the cycle.
    // -----------------------------------------------------------------------

    const cycleNodes = detectCycle(fullGraph.nodes, fullGraph.edges);
    if (cycleNodes.length > 0) {
      logger.warn("Lineage graph contains a cycle — returning graph for inspection", {
        tenantId,
        cycleNodes,
      });
    }

    // -----------------------------------------------------------------------
    // Sub-graph scoping — when the caller specifies an entity type+ID, extract
    // only the portion of the graph reachable from that node.
    // -----------------------------------------------------------------------

    if (entityType !== undefined && entityId !== undefined) {
      const rootNodeId = `${entityType}:${entityId}`;
      const nodeExists = fullGraph.nodes.some((n) => n.id === rootNodeId);
      if (!nodeExists) {
        // Return an empty graph rather than an error — the entity may have been
        // recently deleted and callers should handle the empty case gracefully.
        logger.info("Lineage: root node not found in graph — returning empty sub-graph", {
          tenantId,
          entityType,
          entityId,
          rootNodeId,
        });
        return { nodes: [], edges: [] };
      }
      return extractSubgraph(fullGraph, rootNodeId);
    }

    return fullGraph;
  }

  return { buildLineageGraph };
}
