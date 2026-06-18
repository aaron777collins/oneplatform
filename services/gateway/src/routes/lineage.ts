// Lineage API route handlers.
//
// GET /api/v1/lineage        — scoped sub-graph for a single entity
// GET /api/v1/lineage/graph  — full tenant lineage graph
//
// Both endpoints require an authenticated tenant context. The graph is
// computed on-demand by LineageService and never cached here — cache
// invalidation is the LineageService's responsibility if it adds one.

import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import { UnauthorizedError, ValidationError } from "@oneplatform/core";
import type { LineageService, LineageNodeType } from "../services/lineage-service.js";

const VALID_NODE_TYPES = new Set<string>([
  "connector",
  "raw_table",
  "ontology_type",
  "pipeline",
  "pipeline_step",
  "app",
]);

function isValidNodeType(value: string): value is LineageNodeType {
  return VALID_NODE_TYPES.has(value);
}

export interface LineageRouteDeps {
  lineageService: LineageService;
}

export function createLineageRoutes(
  deps: LineageRouteDeps,
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { lineageService } = deps;

  // -------------------------------------------------------------------------
  // GET /graph — full tenant lineage graph
  // -------------------------------------------------------------------------
  routes.get("/graph", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    const graph = await lineageService.buildLineageGraph(user.tenantId);

    return c.json({
      data: graph,
      meta: {
        nodeCount: graph.nodes.length,
        edgeCount: graph.edges.length,
      },
    });
  });

  // -------------------------------------------------------------------------
  // GET / — scoped sub-graph for a specific entity
  //
  // Query parameters:
  //   entityType  required  One of the LineageNodeType values
  //   entityId    required  The entity's UUID
  // -------------------------------------------------------------------------
  routes.get("/", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    const rawEntityType = c.req.query("entityType");
    const rawEntityId = c.req.query("entityId");

    // Both params are required together; reject partial or missing combinations.
    if (rawEntityType === undefined && rawEntityId === undefined) {
      // No filters — return the full graph (same as /graph).
      const graph = await lineageService.buildLineageGraph(user.tenantId);
      return c.json({
        data: graph,
        meta: {
          nodeCount: graph.nodes.length,
          edgeCount: graph.edges.length,
        },
      });
    }

    if (rawEntityType === undefined || rawEntityType === "") {
      throw new ValidationError(
        "Query parameter 'entityType' is required when 'entityId' is provided.",
        [],
      );
    }

    if (!isValidNodeType(rawEntityType)) {
      throw new ValidationError(
        `Invalid entityType "${rawEntityType}". Must be one of: ${[...VALID_NODE_TYPES].join(", ")}.`,
        [],
      );
    }

    if (rawEntityId === undefined || rawEntityId === "") {
      throw new ValidationError(
        "Query parameter 'entityId' is required when 'entityType' is provided.",
        [],
      );
    }

    const graph = await lineageService.buildLineageGraph(
      user.tenantId,
      rawEntityType,
      rawEntityId,
    );

    return c.json({
      data: graph,
      meta: {
        nodeCount: graph.nodes.length,
        edgeCount: graph.edges.length,
        entityType: rawEntityType,
        entityId: rawEntityId,
      },
    });
  });

  return routes;
}
