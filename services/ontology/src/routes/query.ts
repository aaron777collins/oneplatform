import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import { ValidationError, ForbiddenError } from "@oneplatform/core";
import type { QueryService, StructuredQuery } from "../services/query-service.js";
import { structuredQuerySchema } from "../schemas/index.js";

export interface QueryRouteDeps {
  queryService: QueryService;
}

const REQUIRED_READ_SCOPE = "ontology:read";

export function createQueryRoutes(deps: QueryRouteDeps): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { queryService } = deps;

  // POST /api/v1/ontology/query — execute a structured query and return paginated results.
  routes.post("/api/v1/ontology/query", async (c) => {
    const user = c.var.user;
    if (!user.scopes.includes(REQUIRED_READ_SCOPE) && !user.scopes.includes("admin")) {
      throw new ForbiddenError("ontology:read scope is required.");
    }

    const body = await c.req.json();
    const parsed = structuredQuerySchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid query request", parsed.error.issues);
    }

    const result = await queryService.executeQuery(user.tenantId, parsed.data as StructuredQuery);
    return c.json({ data: result });
  });

  // POST /api/v1/ontology/query/validate — validate a query without executing it.
  // Uses the same read scope because it still resolves entity field metadata.
  routes.post("/api/v1/ontology/query/validate", async (c) => {
    const user = c.var.user;
    if (!user.scopes.includes(REQUIRED_READ_SCOPE) && !user.scopes.includes("admin")) {
      throw new ForbiddenError("ontology:read scope is required.");
    }

    const body = await c.req.json();
    const parsed = structuredQuerySchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid query request", parsed.error.issues);
    }

    const result = await queryService.validateQuery(user.tenantId, parsed.data as StructuredQuery);
    return c.json({ data: result });
  });

  return routes;
}
