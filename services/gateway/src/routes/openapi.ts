// Gateway OpenAPI spec endpoints (ADR-29).
//
// Implements a hybrid static + tenant-dynamic approach:
//   - The static base spec is loaded from disk once and held in memory.
//   - Authenticated requests receive the base spec merged with concrete OpenAPI
//     path entries for the requesting tenant's ontology-defined entity types.
//   - Unauthenticated requests receive the static base spec as-is.
//
// The entity overlay reads from the in-process OntologyCache — no network call
// on the hot path. The cache is populated via Redis pub/sub and a 5-minute
// safety poll by the time any request arrives.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import type { OntologyCache, EntityDefinition } from "../services/ontology-cache.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OpenApiRouteDeps {
  /** Absolute path to docs/generated/openapi/merged.json (the static base spec). */
  specPath: string;
  /** Absolute path to docs/generated/openapi/ directory (for per-service specs). */
  specDir: string;
  /** The live ontology cache — used to generate the tenant-dynamic overlay. */
  ontologyCache: OntologyCache;
}

// ---------------------------------------------------------------------------
// Allowed per-service spec names — guards the :service path parameter so we
// never attempt to read an arbitrary file from disk.
// ---------------------------------------------------------------------------

const ALLOWED_SERVICE_SPECS = new Set([
  "gateway",
  "auth",
  "ingestion",
  "ontology",
  "pipeline",
  "execution",
  "app",
  "logging",
  "plugin",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Converts a slug like "product-variant" to "ProductVariant". */
function toPascalCase(slug: string): string {
  return slug
    .split(/[-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/**
 * Maps ontology field types to their JSON Schema (OAS 3.0) equivalents.
 * Unrecognised types fall back to `{}` (any) so new field types never break
 * the endpoint — the spec degrades gracefully rather than erroring.
 */
function fieldTypeToJsonSchema(
  fieldType: string,
  nullable: boolean,
): Record<string, unknown> {
  const base = fieldTypeToBaseSchema(fieldType);
  if (nullable) {
    // OAS 3.0 nullable modifier — 3.1 uses oneOf with null but we target 3.0.3
    return { ...base, nullable: true };
  }
  return base;
}

function fieldTypeToBaseSchema(fieldType: string): Record<string, unknown> {
  switch (fieldType) {
    case "string":   return { type: "string" };
    case "number":   return { type: "number" };
    case "integer":  return { type: "integer" };
    case "boolean":  return { type: "boolean" };
    case "date":     return { type: "string", format: "date" };
    case "datetime": return { type: "string", format: "date-time" };
    case "uuid":     return { type: "string", format: "uuid" };
    case "text":     return { type: "string" };
    case "json":     return { type: "object" };
    case "array":    return { type: "array", items: {} };
    default:         return {};
  }
}

/** Builds the JSON Schema object shape for a single entity type. */
function buildEntityItemSchema(entity: EntityDefinition): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    id:        { type: "string", format: "uuid" },
    tenantId:  { type: "string", format: "uuid" },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  };

  for (const field of entity.fields) {
    properties[field.slug] = fieldTypeToJsonSchema(field.fieldType, field.nullable);
  }

  return { type: "object", properties };
}

/**
 * Generates concrete OpenAPI path entries for every public entity type owned
 * by the given tenant. Only entities marked `isPublic` are included — private
 * internal entity types are never exposed in the external spec.
 */
function buildEntityOverlay(
  ontologyCache: OntologyCache,
  tenantId: string,
): Record<string, unknown> {
  const entityTypes = ontologyCache.getAllEntityTypes(tenantId);
  const paths: Record<string, unknown> = {};

  for (const slug of entityTypes) {
    const entity = ontologyCache.getEntity(tenantId, slug);
    // Skip non-public entities — private types are implementation details
    if (!entity?.isPublic) continue;

    const pascal = toPascalCase(slug);
    const basePath = `/api/v1/data/${slug}`;

    // Collection endpoint
    paths[basePath] = {
      get: {
        summary: `List ${entity.name} records`,
        description: `Returns paginated ${entity.name} records for the requesting tenant.`,
        operationId: `list${pascal}`,
        tags: ["Data", entity.name],
        security: [{ BearerAuth: [] }],
        parameters: [
          { name: "cursor", in: "query", required: false, schema: { type: "string" } },
          {
            name: "limit",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
          },
        ],
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: { type: "array", items: buildEntityItemSchema(entity) },
                  },
                },
              },
            },
          },
          "401": { description: "Unauthorized" },
          "404": { description: "Entity type not found in ontology" },
        },
      },
      post: {
        summary: `Create ${entity.name} record`,
        operationId: `create${pascal}`,
        tags: ["Data", entity.name],
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object" },
            },
          },
        },
        responses: {
          "201": {
            description: "Created",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { data: buildEntityItemSchema(entity) },
                },
              },
            },
          },
          "400": { description: "Validation error" },
          "401": { description: "Unauthorized" },
        },
      },
    };

    // Single-record endpoint
    paths[`${basePath}/{recordId}`] = {
      get: {
        summary: `Get ${entity.name} record`,
        operationId: `get${pascal}ById`,
        tags: ["Data", entity.name],
        security: [{ BearerAuth: [] }],
        parameters: [
          { name: "recordId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { data: buildEntityItemSchema(entity) },
                },
              },
            },
          },
          "401": { description: "Unauthorized" },
          "404": { description: "Record not found" },
        },
      },
      patch: {
        summary: `Update ${entity.name} record`,
        operationId: `update${pascal}`,
        tags: ["Data", entity.name],
        security: [{ BearerAuth: [] }],
        parameters: [
          { name: "recordId", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object" },
            },
          },
        },
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { data: buildEntityItemSchema(entity) },
                },
              },
            },
          },
          "400": { description: "Validation error" },
          "401": { description: "Unauthorized" },
          "404": { description: "Record not found" },
        },
      },
      delete: {
        summary: `Delete ${entity.name} record`,
        operationId: `delete${pascal}`,
        tags: ["Data", entity.name],
        security: [{ BearerAuth: [] }],
        parameters: [
          { name: "recordId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "204": { description: "No content" },
          "401": { description: "Unauthorized" },
          "404": { description: "Record not found" },
        },
      },
    };
  }

  return paths;
}

/** Shallow-merges the overlay paths into the base spec, returning a new object. */
function mergeOverlayIntoBase(
  base: Record<string, unknown>,
  overlayPaths: Record<string, unknown>,
): Record<string, unknown> {
  const basePaths = (base["paths"] as Record<string, unknown>) ?? {};
  return {
    ...base,
    paths: { ...basePaths, ...overlayPaths },
  };
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function createOpenApiRoutes(deps: OpenApiRouteDeps): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { specPath, specDir, ontologyCache } = deps;

  // Lazy singleton — loaded on the first request, then held in memory.
  // A process restart is required to pick up a regenerated spec, which is
  // intentional: spec regeneration happens during CI/deploy, not at runtime.
  let baseSpec: Record<string, unknown> | null = null;

  async function loadBaseSpec(): Promise<Record<string, unknown> | null> {
    if (baseSpec !== null) return baseSpec;
    try {
      const raw = await readFile(specPath, "utf-8");
      baseSpec = JSON.parse(raw) as Record<string, unknown>;
      return baseSpec;
    } catch {
      // File not found or parse error — caller will return 503 with guidance
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // GET /api/v1/openapi.json — Tenant-aware spec (auth optional)
  //
  // Authenticated requests get the base spec merged with concrete entity paths.
  // Unauthenticated requests fall back to the static base spec.
  // Public endpoint: the spec is documentation, not secret data.
  // ---------------------------------------------------------------------------
  routes.get("/api/v1/openapi.json", async (c) => {
    const spec = await loadBaseSpec();
    if (!spec) {
      return c.json(
        {
          error: {
            code: "SPEC_NOT_FOUND",
            message:
              "OpenAPI spec not yet generated. " +
              "Run: pnpm turbo docs:generate && pnpm docs:merge",
          },
        },
        503,
      );
    }

    const user = c.var.user;
    if (user?.tenantId) {
      // Authenticated — overlay tenant-specific entity paths
      const overlayPaths = buildEntityOverlay(ontologyCache, user.tenantId);
      const combined = mergeOverlayIntoBase(spec, overlayPaths);
      return c.json(combined, 200, {
        "Cache-Control": "private, max-age=60",
        "Access-Control-Allow-Origin": "*",
      });
    }

    // Unauthenticated — return base spec with generic templated paths
    return new Response(JSON.stringify(spec), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300",
        "Access-Control-Allow-Origin": "*",
      },
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/v1/openapi/base.json — Static base spec, no auth required
  //
  // Intended for the Starlight docs site's Scalar explorer, and for SDK code
  // generators that do not need tenant-specific entity paths.
  // ---------------------------------------------------------------------------
  routes.get("/api/v1/openapi/base.json", async (c) => {
    const spec = await loadBaseSpec();
    if (!spec) {
      return c.json(
        {
          error: {
            code: "SPEC_NOT_FOUND",
            message:
              "OpenAPI spec not yet generated. " +
              "Run: pnpm turbo docs:generate && pnpm docs:merge",
          },
        },
        503,
      );
    }

    return new Response(JSON.stringify(spec), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300",
        "Access-Control-Allow-Origin": "*",
      },
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/v1/openapi/:service.json — Per-service specs
  //
  // Enables the Scalar explorer in the docs site to load each service's spec
  // independently. Per-service files are not cached in-process — they are a
  // low-traffic developer-tools path and disk reads are cheap enough.
  //
  // Note: Hono captures the full segment including ".json" into :serviceFile
  // (e.g. "auth.json"). We strip the suffix after capture so we never need
  // a regex constraint in the route pattern, which some Hono router variants
  // do not support for suffix matching.
  // ---------------------------------------------------------------------------
  routes.get("/api/v1/openapi/:serviceFile", async (c) => {
    const serviceFile = c.req.param("serviceFile");

    // Enforce the .json suffix — reject anything that doesn't look like
    // "<service>.json" so this slot is never accidentally matched for other paths.
    if (!serviceFile.endsWith(".json")) {
      return c.json(
        { error: { code: "NOT_FOUND", message: `Unknown path: '/api/v1/openapi/${serviceFile}'.` } },
        404,
      );
    }

    const service = serviceFile.slice(0, -".json".length);

    if (!ALLOWED_SERVICE_SPECS.has(service)) {
      return c.json(
        { error: { code: "NOT_FOUND", message: `Unknown service spec: '${service}'.` } },
        404,
      );
    }

    try {
      const content = await readFile(join(specDir, `${service}.json`), "utf-8");
      return new Response(content, {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=300",
          "Access-Control-Allow-Origin": "*",
        },
      });
    } catch {
      return c.json(
        {
          error: {
            code: "SPEC_NOT_FOUND",
            message: `Spec for service '${service}' not yet generated.`,
          },
        },
        503,
      );
    }
  });

  return routes;
}
