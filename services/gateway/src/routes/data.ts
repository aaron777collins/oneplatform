import { Hono } from "hono";
import type { Context } from "hono";
import type { AppVariables } from "@oneplatform/core";
import type { OntologyCache } from "../services/ontology-cache.js";
import type { ProxyService } from "../services/proxy-service.js";
import type { CircuitBreaker } from "../utils/circuit-breaker.js";

export interface DataRouteDeps {
  ontologyCache: OntologyCache;
  proxyService: ProxyService;
  ingestionServiceUrl: string;
  circuitBreaker?: CircuitBreaker;
  serviceToken?: string;
}

export function createDataRoutes(deps: DataRouteDeps): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.all("/:entityType", async (c) => handleDataRoute(c, deps));
  routes.all("/:entityType/:recordId", async (c) => handleDataRoute(c, deps));
  routes.all("/:entityType/:recordId/:relation", async (c) => handleDataRoute(c, deps));

  return routes;
}

async function handleDataRoute(
  c: Context<{ Variables: AppVariables }>,
  deps: DataRouteDeps,
): Promise<Response> {
  const user = c.var.user;
  if (!user?.tenantId) {
    return c.json({ error: { code: "UNAUTHORIZED", message: "Authentication required." } }, 401);
  }

  const entityType = c.req.param("entityType");
  if (!entityType) {
    return c.json({ error: { code: "NOT_FOUND", message: "Entity type is required." } }, 404);
  }

  const entry = deps.ontologyCache.getEntry(user.tenantId);
  if (!entry) {
    await deps.ontologyCache.refresh(user.tenantId);
  }

  const entity = deps.ontologyCache.getEntity(user.tenantId, entityType);
  if (!entity) {
    return c.json({
      error: {
        code: "GATEWAY_ENTITY_TYPE_NOT_FOUND",
        message: `Entity type '${entityType}' is not defined in the ontology for this tenant.`,
      },
    }, 404);
  }

  const path = new URL(c.req.url).pathname;
  const doProxy = () =>
    deps.proxyService.proxyRequest(c, deps.ingestionServiceUrl + path, {
      timeoutMs: 10_000,
      serviceName: "ingestion",
      tenantId: user.tenantId,
      userId: user.userId,
      requestId: c.var.requestId,
      ...(deps.serviceToken ? { serviceToken: deps.serviceToken } : {}),
    });

  if (deps.circuitBreaker) {
    return deps.circuitBreaker.execute(doProxy);
  }
  return doProxy();
}
