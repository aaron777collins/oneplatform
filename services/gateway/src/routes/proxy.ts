import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
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

  routes.all("/internal/*", (c) => {
    return c.json({ error: { code: "NOT_FOUND", message: "Internal routes are not accessible via the Gateway." } }, 404);
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
