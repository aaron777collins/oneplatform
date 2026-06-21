import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import { NotFoundError } from "@oneplatform/core";
import type { ProxyService } from "../services/proxy-service.js";
import type { CircuitBreaker } from "../utils/circuit-breaker.js";

export interface ProxyRouteDeps {
  proxyService: ProxyService;
  circuitBreakers: Map<string, CircuitBreaker>;
  serviceToken?: string;
}

export function createProxyRoutes(deps: ProxyRouteDeps): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { proxyService, circuitBreakers, serviceToken } = deps;

  // SECURITY BOUNDARY: /internal/* routes must never be reachable from external
  // traffic. This catch-all returns 404 (not 403) to avoid leaking that an
  // internal API surface exists. Service-to-service calls on these paths happen
  // directly between containers on the internal Docker/K8s network — they never
  // transit the Gateway. Each downstream service additionally guards /internal/*
  // with Ed25519 JWT via serviceAuthMiddleware (defense-in-depth).
  routes.all("/internal/*", (_c) => {
    throw new NotFoundError("Internal routes are not accessible via the Gateway.");
  });

  routes.all("/*", async (c) => {
    const parsedUrl = new URL(c.req.url);
    const path = parsedUrl.pathname;
    // Preserve query string so upstream receives the full request URL
    const pathWithSearch = path + parsedUrl.search;
    const resolved = proxyService.resolveUpstreamUrl(path);
    if (!resolved) {
      return c.json({
        error: {
          code: "GATEWAY_ROUTE_NOT_FOUND",
          message: `No route matches '${path}'.`,
        },
      }, 404);
    }

    const user = c.var.user;
    const doProxy = () =>
      proxyService.proxyRequest(c, resolved.serviceUrl + pathWithSearch, {
        timeoutMs: proxyService.getServiceTimeout(resolved.serviceName),
        serviceName: resolved.serviceName,
        ...(serviceToken ? { serviceToken } : {}),
        ...(user?.tenantId ? { tenantId: user.tenantId } : {}),
        ...(user?.userId ? { userId: user.userId } : {}),
        ...(user?.roles ? { roles: user.roles } : {}),
        requestId: c.var.requestId,
      });

    const breaker = circuitBreakers.get(resolved.serviceName);
    if (breaker) {
      return breaker.execute(doProxy);
    }
    return doProxy();
  });

  return routes;
}
