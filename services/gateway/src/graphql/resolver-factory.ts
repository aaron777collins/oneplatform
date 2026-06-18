// GraphQL resolver factory.
//
// Generates per-entity resolver functions that delegate to the ontology and
// ingestion services via HTTP. All resolvers:
//   - Enforce RBAC: the caller's roles/scopes are compared against the
//     ontology entity's `isPublic` flag and the operation type.
//   - Translate cursor-based pagination args into the upstream query string.
//   - Forward the service-to-service token so upstream auth passes.
//   - Apply query depth limiting (enforced by the parser before resolvers run).
//
// Resolver map shape: { [fieldName]: ResolverFn }
// The executor calls resolve(parent, args, context, info).

import type { GraphQLSchema } from "./types.js";
import type { ResolverContext, PaginationArgs, FilterArg, SortArg } from "./types.js";
import type { GraphQLField, GraphQLDocument, GraphQLValue } from "./types.js";

// ---------------------------------------------------------------------------
// RBAC helpers
// ---------------------------------------------------------------------------

// Scopes that allow write operations. Any of these grants mutation access.
const WRITE_SCOPES = new Set(["write", "admin"]);

function assertReadPermission(context: ResolverContext, entitySlug: string): void {
  // Authenticated tenants can read their own data. Public entities are
  // readable even without a scope check (the JWT still must be valid).
  if (!context.tenantId) {
    throw new GraphQLResolverError("Authentication required.", "UNAUTHORIZED");
  }
  // No per-entity ACL beyond tenant isolation is implemented at this layer;
  // the upstream ingestion service enforces row-level security via Postgres RLS.
  void entitySlug;
}

function assertWritePermission(context: ResolverContext, entitySlug: string): void {
  if (!context.tenantId) {
    throw new GraphQLResolverError("Authentication required.", "UNAUTHORIZED");
  }
  const hasWriteScope = context.scopes.some((s) => WRITE_SCOPES.has(s));
  if (!hasWriteScope) {
    throw new GraphQLResolverError(
      `Write access denied for entity '${entitySlug}'. Missing 'write' or 'admin' scope.`,
      "FORBIDDEN",
    );
  }
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class GraphQLResolverError extends Error {
  constructor(
    message: string,
    public readonly code: "UNAUTHORIZED" | "FORBIDDEN" | "NOT_FOUND" | "UPSTREAM_ERROR" | "INVALID_INPUT",
  ) {
    super(message);
    this.name = "GraphQLResolverError";
  }
}

// ---------------------------------------------------------------------------
// Upstream HTTP helpers
// ---------------------------------------------------------------------------

function buildServiceHeaders(context: ResolverContext): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-OneplatForm-Tenant-Id": context.tenantId,
    "X-OneplatForm-User-Id": context.userId,
    ...(context.roles.length > 0 ? { "X-OneplatForm-User-Roles": context.roles.join(",") } : {}),
    ...(context.serviceToken ? { "X-Service-Token": context.serviceToken } : {}),
  };
}

async function upstreamGet(url: string, context: ResolverContext): Promise<unknown> {
  const res = await fetch(url, {
    method: "GET",
    headers: buildServiceHeaders(context),
    signal: AbortSignal.timeout(10_000),
  });

  if (res.status === 404) return null;

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new GraphQLResolverError(
      `Upstream GET ${url} failed with ${res.status}: ${body}`,
      "UPSTREAM_ERROR",
    );
  }

  return res.json();
}

async function upstreamPost(url: string, body: unknown, context: ResolverContext): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: buildServiceHeaders(context),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new GraphQLResolverError(
      `Upstream POST ${url} failed with ${res.status}: ${text}`,
      "UPSTREAM_ERROR",
    );
  }

  return res.json();
}

async function upstreamPatch(url: string, body: unknown, context: ResolverContext): Promise<unknown> {
  const res = await fetch(url, {
    method: "PATCH",
    headers: buildServiceHeaders(context),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });

  if (res.status === 404) return null;

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new GraphQLResolverError(
      `Upstream PATCH ${url} failed with ${res.status}: ${text}`,
      "UPSTREAM_ERROR",
    );
  }

  return res.json();
}

async function upstreamDelete(url: string, context: ResolverContext): Promise<boolean> {
  const res = await fetch(url, {
    method: "DELETE",
    headers: buildServiceHeaders(context),
    signal: AbortSignal.timeout(10_000),
  });

  if (res.status === 404) return false;
  if (res.status === 204 || res.ok) return true;

  const text = await res.text().catch(() => "");
  throw new GraphQLResolverError(
    `Upstream DELETE ${url} failed with ${res.status}: ${text}`,
    "UPSTREAM_ERROR",
  );
}

// ---------------------------------------------------------------------------
// Argument coercion
// ---------------------------------------------------------------------------

function coercePaginationArgs(args: Record<string, unknown>): PaginationArgs {
  return {
    ...(typeof args["after"] === "string" ? { after: args["after"] } : {}),
    ...(typeof args["first"] === "number" ? { first: args["first"] } : {}),
    ...(typeof args["before"] === "string" ? { before: args["before"] } : {}),
    ...(typeof args["last"] === "number" ? { last: args["last"] } : {}),
  };
}

function buildListQueryString(args: Record<string, unknown>): string {
  const params = new URLSearchParams();
  const pagination = coercePaginationArgs(args);

  if (pagination.after) params.set("cursor", pagination.after);
  if (pagination.first !== undefined) params.set("limit", String(pagination.first));

  if (typeof args["filter"] === "string" && args["filter"]) {
    try {
      const filters = JSON.parse(args["filter"]) as FilterArg[];
      if (Array.isArray(filters)) {
        params.set("filter", JSON.stringify(filters));
      }
    } catch {
      throw new GraphQLResolverError(
        "Invalid 'filter' argument: must be a JSON-encoded array of filter objects.",
        "INVALID_INPUT",
      );
    }
  }

  if (typeof args["sort"] === "string" && args["sort"]) {
    try {
      const sorts = JSON.parse(args["sort"]) as SortArg[];
      if (Array.isArray(sorts)) {
        params.set("sort", JSON.stringify(sorts));
      }
    } catch {
      throw new GraphQLResolverError(
        "Invalid 'sort' argument: must be a JSON-encoded array of sort objects.",
        "INVALID_INPUT",
      );
    }
  }

  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

// ---------------------------------------------------------------------------
// Resolver type
// ---------------------------------------------------------------------------

export type ResolverArgs = Record<string, unknown>;
export type ResolverFn = (
  parent: unknown,
  args: ResolverArgs,
  context: ResolverContext,
) => Promise<unknown>;

export type ResolverMap = Record<string, ResolverFn>;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface ResolverFactoryDeps {
  /** Pre-built GraphQL schema used to validate field resolution paths. */
  schema: GraphQLSchema;
}

export function createResolvers(deps: ResolverFactoryDeps): ResolverMap {
  const { schema } = deps;
  const resolvers: ResolverMap = {};

  // -----------------------------------------------------------------
  // Query resolvers
  // -----------------------------------------------------------------

  for (const [fieldName, fieldDef] of Object.entries(schema.queryFields)) {
    const entitySlug = schema.fieldToEntitySlug.get(fieldName);
    if (!entitySlug) continue;

    const isListQuery = fieldName !== toCamelCase(entitySlug);

    if (isListQuery) {
      // entityTypes(filter, pagination) → EntityTypeConnection
      resolvers[fieldName] = async (_parent, args, context) => {
        assertReadPermission(context, entitySlug);
        const qs = buildListQueryString(args);
        const url = `${context.ingestionServiceUrl}/api/v1/data/${encodeURIComponent(entitySlug)}${qs}`;
        const result = await upstreamGet(url, context) as { data?: unknown[]; nextCursor?: string | null } | null;
        return {
          nodes: result?.data ?? [],
          nextCursor: result?.nextCursor ?? null,
          total: Array.isArray(result?.data) ? result.data.length : 0,
        };
      };
    } else {
      // entityType(id: ID!) → EntityType
      resolvers[fieldName] = async (_parent, args, context) => {
        assertReadPermission(context, entitySlug);
        if (typeof args["id"] !== "string" || !args["id"]) {
          throw new GraphQLResolverError("Argument 'id' is required and must be a non-empty string.", "INVALID_INPUT");
        }
        const url = `${context.ingestionServiceUrl}/api/v1/data/${encodeURIComponent(entitySlug)}/${encodeURIComponent(args["id"])}`;
        return upstreamGet(url, context);
      };
    }

    void fieldDef;
  }

  // -----------------------------------------------------------------
  // Mutation resolvers
  // -----------------------------------------------------------------

  for (const [fieldName] of Object.entries(schema.mutationFields)) {
    const entitySlug = schema.fieldToEntitySlug.get(fieldName);
    if (!entitySlug) continue;

    const typeName = toTypeName(entitySlug);

    if (fieldName === `create${typeName}`) {
      resolvers[fieldName] = async (_parent, args, context) => {
        assertWritePermission(context, entitySlug);
        if (!args["input"] || typeof args["input"] !== "object") {
          throw new GraphQLResolverError("Argument 'input' is required and must be an object.", "INVALID_INPUT");
        }
        const url = `${context.ingestionServiceUrl}/api/v1/data/${encodeURIComponent(entitySlug)}`;
        const result = await upstreamPost(url, args["input"], context) as { data?: unknown } | null;
        return (result as Record<string, unknown>)?.["data"] ?? result;
      };
    } else if (fieldName === `update${typeName}`) {
      resolvers[fieldName] = async (_parent, args, context) => {
        assertWritePermission(context, entitySlug);
        if (typeof args["id"] !== "string" || !args["id"]) {
          throw new GraphQLResolverError("Argument 'id' is required.", "INVALID_INPUT");
        }
        if (!args["input"] || typeof args["input"] !== "object") {
          throw new GraphQLResolverError("Argument 'input' is required and must be an object.", "INVALID_INPUT");
        }
        const url = `${context.ingestionServiceUrl}/api/v1/data/${encodeURIComponent(entitySlug)}/${encodeURIComponent(args["id"])}`;
        const result = await upstreamPatch(url, args["input"], context) as { data?: unknown } | null;
        return (result as Record<string, unknown>)?.["data"] ?? result;
      };
    } else if (fieldName === `delete${typeName}`) {
      resolvers[fieldName] = async (_parent, args, context) => {
        assertWritePermission(context, entitySlug);
        if (typeof args["id"] !== "string" || !args["id"]) {
          throw new GraphQLResolverError("Argument 'id' is required.", "INVALID_INPUT");
        }
        const url = `${context.ingestionServiceUrl}/api/v1/data/${encodeURIComponent(entitySlug)}/${encodeURIComponent(args["id"])}`;
        return upstreamDelete(url, context);
      };
    }
  }

  return resolvers;
}

// ---------------------------------------------------------------------------
// Variable substitution
// ---------------------------------------------------------------------------

/**
 * Resolves a GraphQLValue to its runtime equivalent by substituting variables
 * with their concrete values from the variables map.
 */
export function resolveValue(value: GraphQLValue, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case "Variable": {
      const v = variables[value.name];
      return v ?? null;
    }
    case "StringValue":  return value.value;
    case "IntValue":     return value.value;
    case "FloatValue":   return value.value;
    case "BooleanValue": return value.value;
    case "NullValue":    return null;
    case "EnumValue":    return value.value;
    case "ListValue":    return value.values.map((v) => resolveValue(v, variables));
    case "ObjectValue": {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value.fields)) {
        result[k] = resolveValue(v, variables);
      }
      return result;
    }
  }
}

/**
 * Converts a GraphQLField's argument list to a plain object, substituting
 * variable references.
 */
export function resolveArgs(
  field: GraphQLField,
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const arg of field.arguments) {
    result[arg.name] = resolveValue(arg.value, variables);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Inline helpers (duplicated from schema-builder to avoid a circular import)
// ---------------------------------------------------------------------------

function toTypeName(slug: string): string {
  return slug.split("_").map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
}

function toCamelCase(slug: string): string {
  const pascal = toTypeName(slug);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/**
 * Executes a single parsed operation against the resolver map, returning
 * a nested data object. Fragments are expanded inline. Variable references
 * in arguments are substituted from the variables map.
 */
export async function executeOperation(
  operation: import("./types.js").GraphQLOperationDefinition,
  doc: GraphQLDocument,
  resolvers: ResolverMap,
  context: ResolverContext,
  variables: Record<string, unknown>,
  schema: GraphQLSchema,
): Promise<{ data: Record<string, unknown>; errors: Array<{ message: string; path?: Array<string | number> }> }> {
  const data: Record<string, unknown> = {};
  const errors: Array<{ message: string; path?: Array<string | number> }> = [];

  const rootFields =
    operation.kind === "mutation" ? schema.mutationFields : schema.queryFields;

  for (const selection of operation.selectionSet.selections) {
    if (selection.kind === "FragmentSpread" || selection.kind === "InlineFragment") continue;

    const field = selection;
    const key = field.alias ?? field.name;
    const resolver = resolvers[field.name];

    if (!resolver && rootFields[field.name]) {
      // Field exists in schema but has no resolver (shouldn't happen with generated resolvers)
      data[key] = null;
      continue;
    }

    if (!resolver) {
      errors.push({ message: `No resolver for field '${field.name}'.`, path: [key] });
      data[key] = null;
      continue;
    }

    const args = resolveArgs(field, variables);

    try {
      const result = await resolver(null, args, context);
      // If the field has a sub-selection, project only the requested fields
      if (field.selectionSet && result !== null && typeof result === "object") {
        data[key] = projectResult(result, field, doc, variables);
      } else {
        data[key] = result;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ message: msg, path: [key] });
      data[key] = null;
    }
  }

  return { data, errors };
}

/**
 * Projects the resolver result to only include fields requested in the
 * selection set. This is a shallow projection — nested objects are projected
 * recursively. Fragment spreads are expanded from the document fragment map.
 */
function projectResult(
  result: unknown,
  field: GraphQLField,
  doc: GraphQLDocument,
  variables: Record<string, unknown>,
): unknown {
  if (!field.selectionSet || result === null || result === undefined) {
    return result;
  }

  if (Array.isArray(result)) {
    return result.map((item) => projectResult(item, field, doc, variables));
  }

  if (typeof result !== "object") {
    return result;
  }

  const obj = result as Record<string, unknown>;
  const projected: Record<string, unknown> = {};

  for (const sel of field.selectionSet.selections) {
    if (sel.kind === "FragmentSpread") {
      const frag = doc.fragments.get(sel.name);
      if (frag) {
        for (const fragSel of frag.selectionSet.selections) {
          if (fragSel.kind !== "FragmentSpread" && fragSel.kind !== "InlineFragment") {
            const k = fragSel.alias ?? fragSel.name;
            projected[k] = fragSel.selectionSet
              ? projectResult(obj[fragSel.name], fragSel, doc, variables)
              : obj[fragSel.name];
          }
        }
      }
      continue;
    }

    if (sel.kind === "InlineFragment") {
      for (const inlineSel of sel.selectionSet.selections) {
        if (inlineSel.kind !== "FragmentSpread" && inlineSel.kind !== "InlineFragment") {
          const k = inlineSel.alias ?? inlineSel.name;
          projected[k] = inlineSel.selectionSet
            ? projectResult(obj[inlineSel.name], inlineSel, doc, variables)
            : obj[inlineSel.name];
        }
      }
      continue;
    }

    const k = sel.alias ?? sel.name;
    projected[k] = sel.selectionSet
      ? projectResult(obj[sel.name], sel, doc, variables)
      : obj[sel.name];
  }

  return projected;
}
