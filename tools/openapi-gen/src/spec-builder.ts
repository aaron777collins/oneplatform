/**
 * Assembles a complete OpenAPI 3.0.3 document from a ServiceOpenApiMeta.
 *
 * Strategy:
 *   1. Iterate routes, build path items and operation objects.
 *   2. Every referenced Zod schema is converted to JSON Schema and stored in
 *      components/schemas, keyed by its .describe() name.
 *   3. Standard error responses (400/401/403/404/429/500) are appended to every
 *      operation so consumers always know the error contract.
 *   4. Security schemes (BearerAuth, ApiKeyAuth) are declared once in components.
 *
 * WHY collect schemas in components instead of inlining:
 *   Deduplication. Multiple routes may reference the same response type.
 *   Storing once in components/schemas produces a smaller, cleaner spec.
 */

import type { ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ServiceOpenApiMeta, RouteMeta } from "./types.js";
import { requireDescribedName, detectsLazy } from "./zod-converter.js";

// Standard HTTP status text for the most common codes
const HTTP_STATUS_TEXT: Record<number, string> = {
  200: "OK",
  201: "Created",
  204: "No Content",
  301: "Moved Permanently",
  302: "Found",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  410: "Gone",
  422: "Unprocessable Entity",
  429: "Too Many Requests",
  500: "Internal Server Error",
  503: "Service Unavailable",
};

function httpStatusText(code: number): string {
  return HTTP_STATUS_TEXT[code] ?? `HTTP ${code}`;
}

/**
 * Converts a route path like "/api/v1/auth/:userId/roles/:roleId" into an
 * operationId like "getAuthUserIdRoles" when no explicit operationId is given.
 */
function deriveOperationId(method: string, path: string): string {
  const segments = path
    .split("/")
    .filter(Boolean)
    .map((seg) => {
      if (seg.startsWith(":") || (seg.startsWith("{") && seg.endsWith("}"))) {
        // Path param: strip sigils and capitalize
        const name = seg.replace(/^[:{]|[}]$/g, "");
        return "By" + name.charAt(0).toUpperCase() + name.slice(1);
      }
      // Static segment: PascalCase and remove hyphens
      return seg
        .split("-")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join("");
    });
  return method.toLowerCase() + segments.join("");
}

/**
 * Converts a Zod object schema for query parameters into an OpenAPI parameters
 * array. The schema must be a ZodObject — individual keys become parameters.
 *
 * WHY flatten to individual parameters instead of a body-like schema:
 *   OpenAPI 3.0.3 requires query parameters to be listed individually, not as
 *   a single schema object. This is the correct representation.
 */
function buildQueryParameters(querySchema: ZodTypeAny): Array<Record<string, unknown>> {
  const converted = zodToJsonSchema(querySchema, {
    target: "openApi3",
    $refStrategy: "none",
  }) as Record<string, unknown>;

  const properties = (converted["properties"] as Record<string, unknown> | undefined) ?? {};
  const required = (converted["required"] as string[] | undefined) ?? [];

  return Object.entries(properties).map(([name, propSchema]) => ({
    name,
    in: "query",
    required: required.includes(name),
    schema: propSchema as Record<string, unknown>,
  }));
}

/**
 * Standard error responses added to every operation.
 * These are defined inline (not as component refs) for simplicity — they are
 * structurally identical across all services.
 */
const STANDARD_ERROR_RESPONSES: Record<string, Record<string, unknown>> = {
  "400": {
    description: "Bad Request — invalid input or validation error",
    content: {
      "application/json": {
        schema: {
          type: "object",
          properties: {
            error: {
              type: "object",
              properties: {
                code: { type: "string", example: "VALIDATION_ERROR" },
                message: { type: "string" },
                issues: { type: "array", items: { type: "object" } },
              },
              required: ["code", "message"],
            },
          },
          required: ["error"],
        },
      },
    },
  },
  "401": {
    description: "Unauthorized — missing or invalid Bearer token",
    content: {
      "application/json": {
        schema: {
          type: "object",
          properties: {
            error: {
              type: "object",
              properties: {
                code: { type: "string", example: "UNAUTHORIZED" },
                message: { type: "string" },
              },
              required: ["code", "message"],
            },
          },
          required: ["error"],
        },
      },
    },
  },
  "403": {
    description: "Forbidden — authenticated but insufficient permissions",
    content: {
      "application/json": {
        schema: {
          type: "object",
          properties: {
            error: {
              type: "object",
              properties: {
                code: { type: "string", example: "FORBIDDEN" },
                message: { type: "string" },
              },
              required: ["code", "message"],
            },
          },
          required: ["error"],
        },
      },
    },
  },
  "404": {
    description: "Not Found",
    content: {
      "application/json": {
        schema: {
          type: "object",
          properties: {
            error: {
              type: "object",
              properties: {
                code: { type: "string", example: "NOT_FOUND" },
                message: { type: "string" },
              },
              required: ["code", "message"],
            },
          },
          required: ["error"],
        },
      },
    },
  },
  "429": {
    description: "Too Many Requests — rate limit exceeded",
    content: {
      "application/json": {
        schema: {
          type: "object",
          properties: {
            error: {
              type: "object",
              properties: {
                code: { type: "string", example: "RATE_LIMITED" },
                message: { type: "string" },
                retryAfter: { type: "number" },
              },
              required: ["code", "message"],
            },
          },
          required: ["error"],
        },
      },
    },
  },
  "500": {
    description: "Internal Server Error",
    content: {
      "application/json": {
        schema: {
          type: "object",
          properties: {
            error: {
              type: "object",
              properties: {
                code: { type: "string", example: "INTERNAL_ERROR" },
                message: { type: "string" },
              },
              required: ["code", "message"],
            },
          },
          required: ["error"],
        },
      },
    },
  },
};

function buildOperation(
  route: RouteMeta,
  schemas: Record<string, unknown>,
): Record<string, unknown> {
  if (route.body?.schema && detectsLazy(route.body.schema)) {
    throw new Error(
      `[openapi-gen] z.lazy() detected in body schema for ${route.method} ${route.path}. ` +
        "Use a bounded-depth variant instead. See design doc Section 15 L-3.",
    );
  }

  const operation: Record<string, unknown> = {
    summary: route.summary,
    tags: route.tags,
    operationId: deriveOperationId(route.method, route.path),
    // undefined security → default to BearerAuth; empty array → public
    security: route.security ?? [{ BearerAuth: [] }],
    responses: { ...STANDARD_ERROR_RESPONSES },
  };

  if (route.description !== undefined) {
    operation["description"] = route.description;
  }

  if (route.deprecated === true) {
    operation["deprecated"] = true;
    if (route.deprecationMessage !== undefined) {
      const existing = (operation["description"] as string | undefined) ?? "";
      operation["description"] =
        `**DEPRECATED:** ${route.deprecationMessage}\n\n${existing}`.trim();
    }
  }

  // Request body — schema MUST have .describe() for the component name
  if (route.body !== undefined) {
    if (detectsLazy(route.body.schema)) {
      throw new Error(
        `[openapi-gen] z.lazy() in body schema at ${route.method} ${route.path}. ` +
          "Use a bounded-depth schema variant in openapi-meta.ts.",
      );
    }
    const schemaName = requireDescribedName(route.body.schema);
    schemas[schemaName] = zodToJsonSchema(route.body.schema, {
      target: "openApi3",
      $refStrategy: "none",
    });
    operation["requestBody"] = {
      required: route.body.required !== false,
      content: {
        [route.body.contentType]: {
          schema: { $ref: `#/components/schemas/${schemaName}` },
        },
      },
    };
  }

  // Query parameters — flattened from a Zod object schema
  const parameters: Array<Record<string, unknown>> = [];
  if (route.query !== undefined) {
    parameters.push(...buildQueryParameters(route.query.schema));
  }

  // Path parameters — each entry is a named Zod scalar
  if (route.params !== undefined) {
    for (const [name, schema] of Object.entries(route.params)) {
      if (detectsLazy(schema)) {
        throw new Error(
          `[openapi-gen] z.lazy() in path param "${name}" at ${route.method} ${route.path}.`,
        );
      }
      parameters.push({
        name,
        in: "path",
        required: true,
        schema: zodToJsonSchema(schema, { target: "openApi3", $refStrategy: "none" }),
      });
    }
  }

  if (parameters.length > 0) {
    operation["parameters"] = parameters;
  }

  // Response schemas — each MUST have .describe() for the component name
  const responses = operation["responses"] as Record<string, unknown>;
  for (const [statusCode, schema] of Object.entries(route.response)) {
    const zodSchema = schema as ZodTypeAny;
    if (detectsLazy(zodSchema)) {
      throw new Error(
        `[openapi-gen] z.lazy() in response ${statusCode} at ${route.method} ${route.path}. ` +
          "Use a bounded-depth schema variant.",
      );
    }
    const schemaName = requireDescribedName(zodSchema);
    schemas[schemaName] = zodToJsonSchema(zodSchema, {
      target: "openApi3",
      $refStrategy: "none",
    });
    // Use the route-declared content-type for 2xx responses so SSE endpoints
    // (text/event-stream) are not misdocumented as application/json.
    const isSuccess = Number(statusCode) >= 200 && Number(statusCode) < 300;
    const contentType =
      isSuccess && route.responseContentType !== undefined
        ? route.responseContentType
        : "application/json";
    responses[statusCode] = {
      description: httpStatusText(Number(statusCode)),
      content: {
        [contentType]: {
          schema: { $ref: `#/components/schemas/${schemaName}` },
        },
      },
    };
  }

  return operation;
}

export interface OpenApiDocument {
  openapi: "3.0.3";
  info: { title: string; description: string; version: string };
  servers: Array<{ url: string; description: string }>;
  tags: Array<{ name: string; description: string }>;
  paths: Record<string, Record<string, unknown>>;
  components: {
    schemas: Record<string, unknown>;
    securitySchemes: Record<string, unknown>;
  };
}

/**
 * Builds a complete OpenAPI 3.0.3 document from a ServiceOpenApiMeta.
 *
 * Every route's Zod schemas are converted to JSON Schema and registered in
 * components/schemas. Standard error responses are always added to each
 * operation so consumers know the full error contract without guessing.
 */
export function buildSpec(meta: ServiceOpenApiMeta): OpenApiDocument {
  const schemas: Record<string, unknown> = {};
  const paths: Record<string, Record<string, unknown>> = {};

  for (const route of meta.routes) {
    const pathItem = paths[route.path] ?? {};
    pathItem[route.method.toLowerCase()] = buildOperation(route, schemas);
    paths[route.path] = pathItem;
  }

  return {
    openapi: "3.0.3",
    info: meta.info,
    servers: meta.servers ?? [],
    tags: meta.tags ?? [],
    paths,
    components: {
      schemas,
      securitySchemes: {
        BearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description: "JWT access token. Obtain via POST /api/v1/auth/login.",
        },
        ApiKeyAuth: {
          type: "apiKey",
          in: "header",
          name: "Authorization",
          description:
            "API key with 'ApiKey ' prefix, e.g. 'ApiKey op_key_abc123...'. " +
            "Obtain via POST /api/v1/api-keys.",
        },
      },
    },
  };
}
