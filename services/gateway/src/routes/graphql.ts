// GraphQL endpoint handler.
//
// POST /api/v1/graphql
//
// Request body (JSON):
//   { query: string, variables?: Record<string, unknown>, operationName?: string }
//
// Pipeline per request:
//   1. Authenticate (JWT must be valid; tenant is required)
//   2. Parse the query string into an AST (depth-limit enforced by parser)
//   3. Validate the AST against the tenant's generated schema
//   4. Short-circuit to introspection handler if the query is __schema/__type
//   5. Execute resolvers (each resolver re-checks RBAC before hitting upstream)
//   6. Return { data, errors } per the GraphQL specification
//
// Introspection can be disabled in production by setting
// OP_GRAPHQL_INTROSPECTION=false in the environment. Developer environments
// should leave it enabled (the default).

import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import { UnauthorizedError, ValidationError } from "@oneplatform/core";
import type { OntologyCache } from "../services/ontology-cache.js";
import { buildSchemaFromOntology } from "../graphql/schema-builder.js";
import { parseDocument, validateDocument } from "../graphql/parser.js";
import { createResolvers, executeOperation } from "../graphql/resolver-factory.js";
import { buildIntrospectionResult, isIntrospectionQuery } from "../graphql/introspection.js";
import type { GraphQLExecutionResult, ResolverContext } from "../graphql/types.js";

export interface GraphQLRouteDeps {
  ontologyCache: OntologyCache;
  ontologyServiceUrl: string;
  ingestionServiceUrl: string;
  serviceToken?: string;
  /** Max query nesting depth. Defaults to 5. */
  maxDepth?: number;
  /**
   * When false, introspection queries return a permission-denied error.
   * Defaults to true.  Set to false in production via OP_GRAPHQL_INTROSPECTION=false.
   */
  introspectionEnabled?: boolean;
}

// Request body shape — validated manually to avoid pulling in extra Zod schemas
interface GraphQLRequestBody {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

function isValidRequestBody(body: unknown): body is GraphQLRequestBody {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const b = body as Record<string, unknown>;
  return typeof b["query"] === "string" && b["query"].length > 0;
}

export function createGraphQLRoutes(deps: GraphQLRouteDeps): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const maxDepth = deps.maxDepth ?? 5;
  // Introspection defaults to enabled; can be disabled via the environment flag
  const introspectionEnabled = deps.introspectionEnabled
    ?? process.env["OP_GRAPHQL_INTROSPECTION"] !== "false";

  routes.post("/", async (c) => {
    // -----------------------------------------------------------------
    // 1. Authentication
    // -----------------------------------------------------------------
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    // -----------------------------------------------------------------
    // 2. Parse and validate request body
    // -----------------------------------------------------------------
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json<GraphQLExecutionResult>({
        errors: [{ message: "Request body must be valid JSON." }],
      }, 400);
    }

    if (!isValidRequestBody(rawBody)) {
      return c.json<GraphQLExecutionResult>({
        errors: [{ message: "Request body must contain a non-empty 'query' field." }],
      }, 400);
    }

    const { query, variables = {}, operationName } = rawBody;

    // -----------------------------------------------------------------
    // 3. Parse GraphQL query
    // -----------------------------------------------------------------
    const parseResult = parseDocument(query, { maxDepth });
    if (!parseResult.ok) {
      return c.json<GraphQLExecutionResult>({
        errors: parseResult.errors.map((e) => ({
          message: e.message,
          locations: [{ line: e.line, column: e.column }],
        })),
      }, 400);
    }

    const doc = parseResult.document;

    // -----------------------------------------------------------------
    // 4. Ensure ontology cache is populated for this tenant
    // -----------------------------------------------------------------
    let entry = deps.ontologyCache.getEntry(user.tenantId);
    if (!entry) {
      await deps.ontologyCache.refresh(user.tenantId);
      entry = deps.ontologyCache.getEntry(user.tenantId);
    }

    const entityTypes = entry
      ? Array.from(entry.entities.values())
      : [];

    // Build (or re-use cached) schema for this tenant's ontology.
    // The schema is rebuilt on each request if the cache was just refreshed;
    // in steady state the ontology cache is stable and rebuilding is cheap.
    const schema = buildSchemaFromOntology(entityTypes);

    // -----------------------------------------------------------------
    // 5. Introspection short-circuit
    // -----------------------------------------------------------------
    if (isIntrospectionQuery(doc)) {
      if (!introspectionEnabled) {
        return c.json<GraphQLExecutionResult>({
          errors: [{ message: "Introspection is disabled in this environment." }],
        }, 403);
      }
      const introspection = buildIntrospectionResult(schema);
      return c.json<GraphQLExecutionResult>({ data: introspection as unknown as Record<string, unknown> });
    }

    // -----------------------------------------------------------------
    // 6. Schema validation
    // -----------------------------------------------------------------
    const validationErrors = validateDocument(doc, schema);
    if (validationErrors.length > 0) {
      return c.json<GraphQLExecutionResult>({
        errors: validationErrors.map((e) => ({
          message: e.message,
          extensions: { path: e.path },
        })),
      }, 400);
    }

    // -----------------------------------------------------------------
    // 7. Select operation
    // -----------------------------------------------------------------
    let operation = doc.operations[0];
    if (operationName) {
      const named = doc.operations.find((op) => op.name === operationName);
      if (!named) {
        return c.json<GraphQLExecutionResult>({
          errors: [{ message: `Operation '${operationName}' not found in document.` }],
        }, 400);
      }
      operation = named;
    }

    if (!operation) {
      return c.json<GraphQLExecutionResult>({
        errors: [{ message: "No operation found in document." }],
      }, 400);
    }

    // -----------------------------------------------------------------
    // 8. Execute
    // -----------------------------------------------------------------
    const resolverContext: ResolverContext = {
      tenantId: user.tenantId,
      userId: user.userId,
      roles: user.roles ?? [],
      scopes: user.scopes ?? [],
      serviceToken: deps.serviceToken ?? "",
      ontologyServiceUrl: deps.ontologyServiceUrl,
      ingestionServiceUrl: deps.ingestionServiceUrl,
    };

    const resolvers = createResolvers({ schema });
    const { data, errors } = await executeOperation(
      operation,
      doc,
      resolvers,
      resolverContext,
      variables,
      schema,
    );

    const result: GraphQLExecutionResult = {
      data,
      ...(errors.length > 0 ? { errors } : {}),
    };

    // Per the GraphQL spec, a response with only errors (no successful fields)
    // should still return HTTP 200. The errors array signals partial or full
    // failure to the client.
    return c.json(result);
  });

  // PU-008: Consider adding GraphQL GET support (query-string encoding).
  // The GraphQL-over-HTTP spec allows GET requests with ?query=...&variables=...
  // for cacheable read-only operations. Adding a GET handler here would let
  // HTTP-level caches (CDNs, Varnish) cache introspection and list queries,
  // reducing server load for frequently repeated queries.
  // Mutations MUST remain POST-only per the spec.

  return routes;
}
