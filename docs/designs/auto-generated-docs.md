# Auto-Generated Documentation System — Design

**Date:** 2026-06-14
**Status:** REVISED — v2 (fixes BLOCK-1, BLOCK-2, BLOCK-3, WARN-1 through WARN-4)
**ADR reference:** ADR-23 (Auto-Generated Documentation), ADR-22 (SDK, CLI, and API as First-Class Citizens), ADR-29 (Tenant-Aware OpenAPI Spec)
**L1 reference:** `docs/superpowers/specs/2026-06-10-oneplatform-design.md` §10 (CLI and SDKs)

---

## Table of Contents

1. [Problem Statement and Constraints](#1-problem-statement-and-constraints)
2. [System Overview and Component Diagram](#2-system-overview-and-component-diagram)
3. [OpenAPI Generation Strategy](#3-openapi-generation-strategy)
4. [TypeDoc Configuration and TSDoc Standards](#4-typedoc-configuration-and-tsdoc-standards)
5. [CLI Docs Generator Integration](#5-cli-docs-generator-integration)
6. [Docs Site Framework (Starlight/Astro)](#6-docs-site-framework-starlightastro)
7. [Build Pipeline (Turbo Tasks and Dependencies)](#7-build-pipeline-turbo-tasks-and-dependencies)
8. [CI Drift Check Mechanism](#8-ci-drift-check-mechanism)
9. [Gateway /api/v1/openapi.json Endpoint — Hybrid Static + Tenant-Dynamic Spec](#9-gateway-apiv1openapiJSON-endpoint)
10. [Directory Structure for Generated Artifacts](#10-directory-structure-for-generated-artifacts)
11. [Per-Service and Per-Package Implementation Plan](#11-per-service-and-per-package-implementation-plan)
12. [Technology Choices and Rationale](#12-technology-choices-and-rationale)
13. [Security Considerations](#13-security-considerations)
14. [Testing Strategy](#14-testing-strategy)
15. [Known Limitations and Acknowledged Gaps](#15-known-limitations-and-acknowledged-gaps)

---

## 1. Problem Statement and Constraints

### The Problem

OnePlatform has 9 microservices and 6 packages implementing a complete data platform. The platform is API-first by design (ADR-22), but currently has no OpenAPI specifications, no API reference site, and no TypeDoc output for the SDK packages. The only working documentation generation is the CLI reference in `packages/cli/src/lib/docs-generator.ts`, which is wired only in the CLI's own `package.json` and not integrated into the turbo pipeline in a useful way.

The existing documentation gap breaks three platform promises:
- `op sdk generate` expects `/api/v1/openapi.json` at the gateway but the endpoint does not exist
- External consumers of `@oneplatform/sdk` have no API reference
- New contributors cannot discover service API contracts without reading source code

### Hard Constraints

The following constraints are non-negotiable and drive the entire design:

1. **Do not rewrite 188 route handlers.** The services use manual `safeParse()` against Zod schemas, not `@hono/zod-openapi`'s `createRoute()`. Requiring all route handlers to be refactored to use `createRoute()` is a multi-week breaking change that would touch every service. The documentation system must extract information from the existing code pattern.

2. **ADR-29 compliance: tenant-specific spec.** `GET /api/v1/openapi.json` must return a spec that includes ontology-defined entity type routes for the requesting tenant. The gateway has a live `OntologyCache` per tenant (hydrated from the ontology service). A static build-time merged spec cannot satisfy this requirement alone — it must be augmented at request time. The design in Section 9 implements a hybrid: a static base spec covers all platform-owned routes, and a tenant-dynamic overlay is generated at request time from the ontology cache and merged before serving.

3. **Build-time base spec, runtime dynamic overlay.** The static merged spec is generated at build time and kept in version control. The dynamic overlay (entity-specific paths) is generated in the gateway handler on each request from the ontology cache. The static + dynamic merge is fast enough for a hot request path because the ontology cache is in-process memory, not a network call.

4. **Single source of truth is code.** Every piece of generated documentation must derive from code (Zod schemas, TypeScript types, Commander.js command definitions, route handler comments). Separately-maintained documentation is prohibited per ADR-23.

5. **Must work with the existing turbo pipeline.** The `turbo.json` `docs:generate` task already exists with `"dependsOn": ["^build"]`. The new system extends this task without restructuring the build graph.

6. **Each service owns its own docs generation.** Each service adds a `docs:generate` script to its `package.json`. Turbo's workspace-aware caching handles deduplication.

7. **Turbo output paths must not traverse outside the package directory.** Turbo does not permit output globs containing `../../`. Per-service OpenAPI output is written to `dist/openapi/{service}.json` within each service package. The merger reads from those per-package locations and writes `docs/generated/openapi/merged.json` as a root-only shell step outside Turbo's task graph.

### What "Auto-Generated" Means

There are three tiers of documentation in this system:

| Tier | Source | Generator | Output |
|------|--------|-----------|--------|
| OpenAPI 3.0.3 | Zod schemas + route-to-schema mapping file | `@oneplatform/openapi-gen` (new internal tool) | Per-service `dist/openapi/{service}.json` + merged `docs/generated/openapi/merged.json` |
| TypeDoc API reference | TypeScript source with TSDoc comments | TypeDoc | Per-package `dist/typedoc/` Markdown + JSON |
| CLI reference | Commander.js `program` object introspection | Existing `docs-generator.ts` | `docs/generated/cli/` Markdown files |

All three tiers are assembled by the Starlight/Astro docs site into a single navigable documentation portal.

**OpenAPI version choice: 3.0.3.** `zod-to-json-schema` with `target: "openApi3"` produces JSON Schema Draft 7 / OpenAPI 3.0.x compatible output, not 3.1. Using `target: "jsonSchema2019-09"` would produce JSON Schema 2019-09 (OpenAPI 3.1 compatible) but `@scalar/react` and most code generators have broader 3.0.x tooling support. This design standardizes on OpenAPI 3.0.3 using `target: "openApi3"` and sets `openapi: "3.0.3"` in all generated documents. If the platform migrates to 3.1 in the future, the `target` parameter and `openapi` field must both be updated together.

---

## 2. System Overview and Component Diagram

```
SOURCE (code)

  services/*/src/schemas/index.ts   --- Zod schemas (request/response)
  services/*/src/routes/*.ts        --- route-to-schema mapping comments
  services/*/src/openapi-meta.ts    --- NEW: per-service route metadata
  packages/{sdk,app-sdk,plugin-sdk,core}/src/**  --- TSDoc comments
  packages/cli/src/index.ts         --- Commander.js program object

        |
        | turbo docs:generate (per service/package)
        |

GENERATORS

  tools/openapi-gen/          --- new internal tool (Node.js/TypeScript)
  |  Reads:  services/*/src/openapi-meta.ts
  |  Reads:  services/*/src/schemas/index.ts (Zod via zod-to-json-schema)
  |  Writes: services/*/dist/openapi/{service}.json   <-- within package boundary

  typedoc                     --- per-package, configured via typedoc.json
  |  Reads:  packages/{sdk,app-sdk,plugin-sdk,core}/src/**/*.ts
  |  Writes: packages/*/dist/typedoc/                  <-- within package boundary

  packages/cli docs:generate  --- existing docs-generator.ts, now wired
  |  Reads:  buildProgram() Commander.js object
  |  Writes: docs/generated/cli/                       <-- CLI is a root consumer

        |
        | pnpm docs:merge (root shell step, NOT a Turbo task)
        |

MERGER (root-only shell step)

  tools/openapi-gen/src/cli.ts --merge
  |  Reads:  services/*/dist/openapi/*.json            <-- from per-package dist
  |  Reads:  packages/*/dist/typedoc/**                <-- from per-package dist
  |  Writes: docs/generated/openapi/merged.json        <-- root artifact
  |  Writes: docs/generated/typedoc/**                 <-- root artifact copies

        |
        | pnpm docs:build (root shell step)
        |

DOCS SITE (packages/docs --- new Astro/Starlight package)

  Reads docs/generated/**  and  docs/designs/**  and  docs/decisions/**
  Renders via Starlight (static site build at build time)
  Output: packages/docs/dist/ (served by Frontend nginx or separately)

        |
        | served at runtime
        |

RUNTIME SERVING

  /api/v1/openapi.json  --- Gateway: merges static base spec + tenant-dynamic
                            overlay at request time (see Section 9)
  /api/v1/openapi/base.json  --- Gateway: static base spec (no auth required)
  /docs                 --- Gateway proxies to docs site (Starlight SPA)
  /docs/api/{service}   --- Scalar API explorer embedded in Starlight
  /docs/sdk/{package}   --- TypeDoc output embedded in Starlight
  /docs/cli             --- CLI markdown reference in Starlight
```

### Data Flow Summary

1. A developer changes a Zod schema in `services/auth/src/schemas/index.ts`.
2. `turbo docs:generate` detects the change (via turbo's content hashing).
3. `openapi-gen` re-reads the schema file and the service's `openapi-meta.ts`, re-runs `zodToJsonSchema`, and regenerates `services/auth/dist/openapi/auth.json`.
4. The root `pnpm docs:merge` step reads all per-service `dist/openapi/*.json` files and regenerates `docs/generated/openapi/merged.json` (the static base spec).
5. The Starlight docs site rebuilds and picks up the new spec.
6. The CI drift check compares the freshly-generated output to what is committed to git; if they differ, CI fails.
7. At request time, the gateway's `/api/v1/openapi.json` handler loads the static base spec from disk, queries the ontology cache for the requesting tenant's entity definitions, generates OpenAPI paths for those entity routes, merges them into the base spec, and returns the combined tenant-specific document. `op sdk generate` receives this combined spec.

---

## 3. OpenAPI Generation Strategy

### The Core Problem: No `createRoute()` Wiring

The existing services use the pattern:

```typescript
// services/auth/src/routes/auth.ts
routes.post("/api/v1/auth/login", async (c) => {
  const parsed = loginRequest.safeParse(await c.req.json());
  // ...
});
```

The Zod schema (`loginRequest`) is defined in `src/schemas/index.ts`. The route path, HTTP method, and which schema applies to the body/query/response are implicit — they live only in the handler code. An AST-based extractor that tries to infer this mapping from the handler source is fragile and would require parsing `c.req.json()` vs `c.req.query()` calls and tracing which schema variable is passed to `safeParse()`. That approach breaks on any non-trivial refactoring.

### The Solution: Per-Service `openapi-meta.ts`

Each service adds a single new file: `services/{name}/src/openapi-meta.ts`. This file is a pure TypeScript data structure — no Hono imports, no request handling — that declares the mapping from route to schema. It is the contract between the route implementation and the documentation system.

This file is the **only** new code developers must write when adding a route. It is not request middleware, not validation logic — it is a parallel declaration of what the route already does.

#### Format of `openapi-meta.ts`

```typescript
// services/auth/src/openapi-meta.ts
import type { ServiceOpenApiMeta } from "@oneplatform/openapi-gen";
import {
  loginRequest,
  loginResponse,
  registerRequest,
  registerResponse,
  refreshRequest,
  refreshResponse,
  bootstrapRequest,
  bootstrapResponse,
  bootstrapStatusResponse,
  forgotPasswordRequest,
  forgotPasswordResponse,
  resetPasswordRequest,
  resetPasswordResponse,
  createApiKeyRequest,
  apiKeyResponse,
  apiKeyListResponse,
  createRoleRequest,
  roleResponse,
  roleListResponse,
  updateRoleRequest,
  updateRolePermissionsRequest,
  rolePermissionsResponse,
  updateUserRequest,
  userResponse,
  userListResponse,
} from "./schemas/index.js";

export const meta: ServiceOpenApiMeta = {
  info: {
    title: "Auth Service",
    description: "Authentication, authorization, API keys, roles, and user management.",
    version: "1.0.0",
  },
  servers: [{ url: "http://localhost:3000", description: "Local (via Gateway)" }],
  tags: [
    { name: "Bootstrap", description: "First-run platform initialization" },
    { name: "Auth", description: "Login, logout, token refresh, password reset" },
    { name: "OAuth", description: "OAuth 2.0 provider flows" },
    { name: "API Keys", description: "Programmatic access credentials" },
    { name: "Roles", description: "RBAC role management" },
    { name: "Users", description: "User management" },
  ],
  routes: [
    {
      method: "GET",
      path: "/api/v1/auth/bootstrap/status",
      summary: "Bootstrap status",
      description: "Returns whether the platform has been bootstrapped (first admin created).",
      tags: ["Bootstrap"],
      security: [],
      response: { 200: bootstrapStatusResponse.describe("BootstrapStatusResponse") },
    },
    {
      method: "POST",
      path: "/api/v1/auth/bootstrap",
      summary: "Bootstrap the platform",
      description: "Creates the first admin user and tenant. One-time use; returns 410 Gone after first call.",
      tags: ["Bootstrap"],
      security: [],
      body: { schema: bootstrapRequest, contentType: "application/json" },
      response: { 201: bootstrapResponse.describe("BootstrapResponse") },
    },
    {
      method: "POST",
      path: "/api/v1/auth/register",
      summary: "Register a user",
      tags: ["Auth"],
      security: [],
      body: { schema: registerRequest, contentType: "application/json" },
      response: { 201: registerResponse.describe("RegisterResponse") },
    },
    {
      method: "POST",
      path: "/api/v1/auth/login",
      summary: "Login",
      tags: ["Auth"],
      security: [],
      body: { schema: loginRequest, contentType: "application/json" },
      response: { 200: loginResponse.describe("LoginResponse") },
    },
    // ... remaining routes
  ],
};
```

Note that every response schema uses `.describe("UniqueName")`. This is required — see the `_Response` naming and schema name collision discussion in Section 15.

#### `ServiceOpenApiMeta` Type (from `tools/openapi-gen/src/types.ts`)

```typescript
import type { ZodTypeAny } from "zod";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RouteBodyMeta {
  schema: ZodTypeAny;
  contentType: "application/json" | "multipart/form-data";
  required?: boolean; // defaults to true
}

export interface RouteQueryMeta {
  schema: ZodTypeAny;
}

export interface RouteParamMeta {
  // path params — key is the param name (matches :paramName in path)
  [paramName: string]: ZodTypeAny;
}

export interface RouteResponseMeta {
  // key is HTTP status code
  [statusCode: number]: ZodTypeAny;
}

export interface RouteMeta {
  method: HttpMethod;
  path: string; // e.g. "/api/v1/auth/login"
  summary: string;
  description?: string;
  tags: string[];
  security?: Array<Record<string, string[]>>; // [] means public; undefined means Bearer JWT
  body?: RouteBodyMeta;
  query?: RouteQueryMeta;
  params?: RouteParamMeta;
  response: RouteResponseMeta;
  deprecated?: boolean;
  deprecationMessage?: string;
}

export interface ServiceOpenApiMeta {
  info: {
    title: string;
    description: string;
    version: string;
  };
  servers?: Array<{ url: string; description: string }>;
  tags?: Array<{ name: string; description: string }>;
  routes: RouteMeta[];
}
```

### The Generator Tool (`tools/openapi-gen/`)

The generator is a standalone Node.js/TypeScript tool in `tools/openapi-gen/`. It is not a library imported by services at runtime — it is a build-time CLI called from each service's `docs:generate` script.

#### How It Works

The generator uses the `zod-to-json-schema` package (MIT, 2M weekly downloads, zero runtime dependencies when used as a build tool) to convert each Zod schema into JSON Schema. It then assembles the full OpenAPI 3.0.3 document.

```
tools/openapi-gen/
├── package.json
├── tsconfig.json
└── src/
    ├── types.ts           # ServiceOpenApiMeta, RouteMeta, etc.
    ├── zod-converter.ts   # wraps zod-to-json-schema, adds OAS3.0 refinements
    ├── spec-builder.ts    # assembles OpenAPI 3.0.3 document from meta + schemas
    ├── merger.ts          # merges per-service specs into docs/generated/openapi/merged.json
    └── cli.ts             # entry point: parses argv, calls spec-builder
```

#### `tools/openapi-gen/src/cli.ts` entry point

```typescript
#!/usr/bin/env node
// Usage:
//   openapi-gen --service auth --meta services/auth/src/openapi-meta.ts \
//               --out services/auth/dist/openapi/auth.json
//
//   openapi-gen --merge                               \
//               --services-root services/             \
//               --out docs/generated/openapi/merged.json
```

The generator is invoked via `tsx` (the existing TypeScript runner used across the monorepo, no separate compilation step required for the tool itself):

```bash
# From within services/auth/ (as a package.json script):
tsx ../../tools/openapi-gen/src/cli.ts \
  --service auth \
  --meta src/openapi-meta.ts \
  --out dist/openapi/auth.json
```

The `--out` path is always relative to the package directory, keeping the output within the package boundary and satisfying Turbo's output glob constraints.

#### `tools/openapi-gen/src/spec-builder.ts` — core logic

```typescript
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ServiceOpenApiMeta, RouteMeta } from "./types.js";

export function buildSpec(meta: ServiceOpenApiMeta): OpenAPIObject {
  const schemas: Record<string, unknown> = {};
  const paths: Record<string, PathItemObject> = {};

  for (const route of meta.routes) {
    const pathItem = paths[route.path] ?? {};
    const operation = buildOperation(route, schemas);
    pathItem[route.method.toLowerCase()] = operation;
    paths[route.path] = pathItem;
  }

  return {
    openapi: "3.0.3",   // OpenAPI 3.0.3 — aligns with target: "openApi3"
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
        },
        ApiKeyAuth: {
          type: "apiKey",
          in: "header",
          name: "Authorization",
          description: "API key with 'ApiKey ' prefix",
        },
      },
    },
  };
}

function buildOperation(route: RouteMeta, schemas: Record<string, unknown>) {
  const operation: OperationObject = {
    summary: route.summary,
    tags: route.tags,
    operationId: deriveOperationId(route.method, route.path),
    security: route.security ?? [{ BearerAuth: [] }],
    responses: {},
  };

  if (route.description) operation.description = route.description;
  if (route.deprecated) {
    operation.deprecated = true;
    if (route.deprecationMessage) operation.description =
      `**DEPRECATED:** ${route.deprecationMessage}\n\n${operation.description ?? ""}`;
  }

  // Request body
  if (route.body) {
    const schemaName = requireDescribedName(route.body.schema, route, "body");
    schemas[schemaName] = zodToJsonSchema(route.body.schema, {
      target: "openApi3",   // produces JSON Schema Draft 7 / OAS 3.0 compatible
      $refStrategy: "none",
    });
    operation.requestBody = {
      required: route.body.required !== false,
      content: {
        [route.body.contentType]: {
          schema: { $ref: `#/components/schemas/${schemaName}` },
        },
      },
    };
  }

  // Query parameters
  if (route.query) {
    const jsonSchema = zodToJsonSchema(route.query.schema, {
      target: "openApi3",
      $refStrategy: "none",
    });
    operation.parameters = objectSchemaToParameters(jsonSchema, "query");
  }

  // Path parameters
  if (route.params) {
    operation.parameters = (operation.parameters ?? []).concat(
      Object.entries(route.params).map(([name, schema]) => ({
        name,
        in: "path",
        required: true,
        schema: zodToJsonSchema(schema, { target: "openApi3", $refStrategy: "none" }),
      }))
    );
  }

  // Responses — each response schema MUST have a .describe("UniqueName") call
  for (const [statusCode, schema] of Object.entries(route.response)) {
    const schemaName = requireDescribedName(schema as ZodTypeAny, route, `response.${statusCode}`);
    schemas[schemaName] = zodToJsonSchema(schema as ZodTypeAny, {
      target: "openApi3",
      $refStrategy: "none",
    });
    operation.responses[statusCode] = {
      description: httpStatusText(Number(statusCode)),
      content: {
        "application/json": {
          schema: { $ref: `#/components/schemas/${schemaName}` },
        },
      },
    };
  }

  // Standard error responses added to every route
  addStandardErrors(operation.responses);

  return operation;
}

/**
 * Extracts the schema name from _def.description (set via .describe()).
 * Throws at build time if .describe() was not called — enforces the naming contract.
 */
function requireDescribedName(schema: ZodTypeAny, route: RouteMeta, position: string): string {
  const name = (schema._def as { description?: string }).description;
  if (!name) {
    throw new Error(
      `[openapi-gen] Schema at ${route.method} ${route.path} (${position}) has no .describe() name. ` +
      `Add .describe("UniquePascalCaseName") in openapi-meta.ts.`
    );
  }
  return name;
}
```

The `requireDescribedName` function enforces that every schema used in `openapi-meta.ts` has an explicit `.describe()` call, which prevents schema name collisions (the `_Response` suffix issue discussed in Section 15 is resolved by requiring fully unique names via `.describe()`).

### Merger Tool (`tools/openapi-gen/src/merger.ts`)

After all per-service specs are generated into `services/*/dist/openapi/{service}.json`, the merger combines them into a single static base spec. The merger:

1. Reads all `services/*/dist/openapi/{service}.json` files by scanning `services/` for `dist/openapi/*.json`.
2. Merges the `paths` objects — each service contributes its own paths. Path conflicts (two services sharing the same path) are flagged as a build error.
3. Merges the `components.schemas` objects. Schema name conflicts that have different content (same name, different shape) are build errors. Identical schemas are deduplicated.
4. Sets the merged document's `info` to the platform-level description.
5. Adds an `x-service-map` extension that records which service owns each path (useful for debugging and for the docs site's service navigation).
6. Writes to `docs/generated/openapi/merged.json`. This is the static base spec served to unauthenticated or non-tenant-identified requests, and is the starting point for tenant-specific overlay generation at request time.

The merger is invoked by a root-level `docs:merge` script in the monorepo root `package.json` as a plain shell step (not a Turbo task — see Section 7):

```bash
# root package.json script
tsx tools/openapi-gen/src/cli.ts \
  --merge \
  --services-root services/ \
  --out docs/generated/openapi/merged.json
```

### Handling the Data Routes: Static Templated Paths vs. Tenant-Dynamic Paths

The gateway's `data.ts` routes serve ontology-defined entity types. The gateway mounts these at `/api/v1/data` with three sub-patterns: `/:entityType`, `/:entityType/:recordId`, and `/:entityType/:recordId/:relation`. These are authenticated routes — `c.var.user.tenantId` is required (see `services/gateway/src/routes/data.ts`).

There are two complementary representations of these routes:

**In the static base spec** (all tenants): The gateway's `openapi-meta.ts` documents the data routes using generic OpenAPI path templates. This satisfies tools and consumers that load the spec without tenant context:

```typescript
// services/gateway/src/openapi-meta.ts (data route entries)
{
  method: "GET",
  path: "/api/v1/data/{entityType}",
  summary: "Query entity records",
  description: "Returns paginated records for the specified ontology entity type. " +
    "Available entity types are defined per tenant via the Ontology Service. " +
    "Use GET /api/v1/openapi.json with a valid Bearer token to receive the " +
    "tenant-specific spec with concrete entity type paths.",
  tags: ["Data"],
  params: { entityType: z.string().min(1).describe("Ontology entity type slug") },
  query: dataQuerySchema,
  response: {
    200: z.object({
      data: z.array(z.record(z.unknown())).describe("Entity records"),
      pagination: paginationSchema,
    }).describe("EntityListResponse"),
  },
},
```

**In the tenant-dynamic overlay** (at request time): The gateway handler generates concrete paths for the requesting tenant's entity types and merges them into the base spec before serving. This is the ADR-29 requirement. See Section 9 for the full implementation.

---

## 4. TypeDoc Configuration and TSDoc Standards

### Packages That Get TypeDoc

| Package | Audience | Priority |
|---------|----------|----------|
| `@oneplatform/sdk` | External developers | Critical |
| `@oneplatform/app-sdk` | App developers | Critical |
| `@oneplatform/plugin-sdk` | Plugin developers | Critical |
| `@oneplatform/core` | Internal contributors | Important |

The `frontend` package is a React SPA, not a library, and does not get TypeDoc output.

### TypeDoc Output Location

TypeDoc writes to `dist/typedoc/` within each package. This keeps output within the package boundary (satisfying Turbo), and the `docs:merge` shell step copies the Markdown output to `docs/generated/typedoc/{package}/` for the Starlight site to consume.

```json
// packages/sdk/typedoc.json
{
  "entryPoints": ["src/index.ts"],
  "entryPointStrategy": "resolve",
  "out": "dist/typedoc",
  "json": "dist/typedoc.json",
  "plugin": ["typedoc-plugin-markdown"],
  "theme": "markdown",
  "readme": "none",
  "excludePrivate": true,
  "excludeInternal": true,
  "excludeExternals": false,
  "includeVersion": true,
  "navigationLinks": {
    "OnePlatform Docs": "/docs"
  },
  "name": "@oneplatform/sdk",
  "titleLink": "/docs/sdk/sdk",
  "githubPages": false,
  "sort": ["source-order"],
  "groupOrder": ["Functions", "Classes", "Interfaces", "Type Aliases", "Variables"],
  "categorizeByGroup": false,
  "searchInComments": true
}
```

The `typedoc-plugin-markdown` plugin (MIT) generates Markdown output instead of HTML, which is then imported into the Starlight docs site. This avoids running a separate TypeDoc HTML server and lets Starlight own the visual presentation.

The `docs:generate` script in each package:

```json
// packages/sdk/package.json (addition)
"docs:generate": "typedoc --options typedoc.json"
```

The `docs:merge` shell step copies TypeDoc output to the shared generated directory:

```bash
# part of root docs:merge script
cp -r packages/sdk/dist/typedoc     docs/generated/typedoc/sdk
cp -r packages/app-sdk/dist/typedoc docs/generated/typedoc/app-sdk
cp -r packages/plugin-sdk/dist/typedoc docs/generated/typedoc/plugin-sdk
cp -r packages/core/dist/typedoc    docs/generated/typedoc/core
```

### TSDoc Standards

The existing codebase has good JSDoc in `plugin-sdk` and minimal JSDoc in `sdk` and `core`. The following standards are adopted and enforced via `eslint-plugin-tsdoc`:

**Required for all public exports in sdk, app-sdk, plugin-sdk:**

```typescript
/**
 * Creates an authenticated OnePlatform API client.
 *
 * @param options - Client configuration. Either `apiKey` (server-side) or
 *   `accessToken` (browser PKCE flow) must be provided. See {@link ClientOptions}.
 *
 * @returns A fully configured {@link OnePlatformClient} instance.
 *
 * @throws {@link ConfigurationError} If no authentication method is provided.
 * @throws {@link NetworkError} If the initial connection check fails.
 *
 * @example
 * ```typescript
 * const client = createClient({ apiKey: process.env.OP_API_KEY });
 * const pipelines = await client.pipelines.list();
 * ```
 *
 * @public
 */
export function createClient(options: ClientOptions): OnePlatformClient { ... }
```

**Minimum for `@oneplatform/core` internal exports:**

```typescript
/**
 * Creates and configures the Hono application with the standard 11-middleware stack.
 * All services call this exactly once at startup.
 *
 * @internal
 */
export function createApp(config: CreateAppConfig): Hono<...> { ... }
```

**TSDoc tags used across the codebase:**

- `@public` — part of the public API surface (sdk, app-sdk, plugin-sdk exports)
- `@internal` — implementation detail, excluded from TypeDoc output
- `@deprecated` — with reason and migration path
- `@example` — at least one example per exported function/class
- `@throws` — for every error type a caller must handle
- `@param` — every parameter, including optional ones
- `@returns` — every non-void return value
- `@see` — cross-references to related API members

**ESLint enforcement:** `eslint-plugin-tsdoc` is added to each package's dev dependencies. The rule `tsdoc/syntax` is set to `error`. The rule that requires every public export to have a JSDoc block is enabled as a separate `jsdoc/require-jsdoc` rule targeting exported declarations.

The `core` package uses `@internal` tags on all exports to suppress them from TypeDoc by default. A subset of "contributor-facing" APIs (e.g., `createApp`, `AppError` subclasses, `UserContext`) are marked `@public` and will appear in the generated core docs.

---

## 5. CLI Docs Generator Integration

### Current State

The CLI has a working generator at `packages/cli/src/lib/docs-generator.ts` that:
- Introspects the Commander.js `program` object returned by `buildProgram()`
- Generates per-command-group Markdown files in the output directory
- Generates an `index.md` table of contents
- Has a `docs:generate` script in `packages/cli/package.json` that writes to `../../docs/generated/cli`

The gap is that this script is not connected to the turbo `docs:generate` task in a way that makes it run as part of the full pipeline.

### What Is Already Correct

The `docs:generate` script in `packages/cli/package.json` already writes to `docs/generated/cli/`. The CLI generator is an exception to the "write inside package boundary" rule because the CLI package is a build-time tool that produces root-level artifacts, not a library that other packages depend on. The CLI's output is not a Turbo-cached artifact — it is written directly to the shared `docs/generated/` directory by the `docs:merge` shell step.

Actually, to maintain consistency with the "within package boundary" rule for Turbo outputs: the CLI `docs:generate` script should write to `dist/docs/` within `packages/cli`, and the `docs:merge` shell step copies the output to `docs/generated/cli/`. This is the cleanest approach.

The updated CLI `docs:generate` script:

```json
// packages/cli/package.json (updated)
"docs:generate": "tsx src/lib/docs-generator.ts --out dist/docs"
```

And in the `docs:merge` shell step:

```bash
cp -r packages/cli/dist/docs/* docs/generated/cli/
```

### What Needs to Change

1. The CLI `docs:generate` script must be updated to write to `dist/docs/` (within-package boundary, Turbo-safe) instead of writing directly to the root `docs/generated/cli/` directory.

2. The generated Markdown needs frontmatter for Starlight to ingest it. The `docs-generator.ts` file needs a minor update to prepend YAML frontmatter to each generated file:

```typescript
// packages/cli/src/lib/docs-generator.ts — addition to writeFileSync calls
const frontmatter = `---\ntitle: "op ${groupName}"\ndescription: "CLI reference for op ${groupName} commands"\nsidebar:\n  order: ${idx + 1}\n---\n\n`;
writeFileSync(join(outputDir, `${groupName}.md`), frontmatter + groupMd, "utf8");
```

This is the only change to the existing generator logic.

### Output

After `pnpm --filter @oneplatform/cli docs:generate` followed by the `docs:merge` copy step:

```
docs/generated/cli/
├── index.md
├── auth.md
├── connectors.md
├── pipelines.md
├── apps.md
├── plugins.md
├── logs.md
├── ontology.md
├── users.md
└── service.md
```

Each file has the Starlight frontmatter prepended and the Commander.js-generated content as the body.

---

## 6. Docs Site Framework (Starlight/Astro)

### Why Starlight

Starlight (by Astro, MIT license) is the only viable choice that satisfies all constraints simultaneously:

- **Markdown-native.** All three generators (OpenAPI-gen, TypeDoc with markdown plugin, CLI generator) output Markdown. Starlight consumes Markdown directories natively with zero configuration.
- **Static build.** Starlight builds to static HTML/JS/CSS, producing a `dist/` directory that is served by nginx with no Node.js runtime. This fits the Docker Compose deployment model.
- **Embeds React components.** Starlight uses Astro's island architecture, which allows React components (e.g., the Scalar API explorer) to be embedded in Markdown pages with `<ScalarApiExplorer spec={...} />` as an Astro component.
- **Multi-source content.** Starlight's content collections can pull from multiple directories, mapping each to a sidebar section. The generator outputs go to `docs/generated/`, the design docs in `docs/designs/`, and the ADRs in `docs/decisions/` can all be mapped to sidebar sections.
- **Zero-config search.** Starlight ships with Pagefind (static search, MIT) built in. No separate search service needed.
- **Version support via Starlight Versions plugin.** API versioning is planned (ADR-22); when v2 arrives, the versioned docs plugin handles the sidebar version switcher.

Alternatives considered:
- **VitePress:** does not have first-class multi-source content collection support. Would require manually copying generated files into the VitePress docs directory on every regeneration.
- **Docusaurus:** React-only, larger bundle, more complex MDX configuration for Astro island-equivalent patterns.
- **GitBook / Mintlify:** cloud-hosted, not self-hostable, breaks the self-hosted deployment model.

### Package Location

```
packages/docs/           # new Astro/Starlight package
├── package.json
├── astro.config.mjs
├── tsconfig.json
└── src/
    ├── content/
    │   └── docs/         # Starlight content root
    │       ├── index.mdx              # docs home page
    │       ├── api/                   # Scalar explorer pages
    │       │   ├── gateway.mdx
    │       │   ├── auth.mdx
    │       │   └── ...
    │       └── architecture/          # symlinked from docs/designs/ and docs/decisions/
    └── components/
        └── ScalarApiExplorer.tsx      # React component wrapping @scalar/react
```

### Astro Configuration

The Astro configuration must use dynamic paths instead of hardcoded absolute paths, so the monorepo can be checked out anywhere on disk:

```javascript
// packages/docs/astro.config.mjs
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import react from "@astrojs/react";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// Dynamic paths relative to this config file's location.
// packages/docs/astro.config.mjs -> ../../docs (monorepo root docs/)
const repoDocsDir = fileURLToPath(new URL("../../docs", import.meta.url));
const generatedDir = resolve(repoDocsDir, "generated");
const architectureDir = repoDocsDir;

export default defineConfig({
  integrations: [
    react(),
    starlight({
      title: "OnePlatform Docs",
      logo: { src: "./src/assets/logo.svg" },
      social: { github: "https://github.com/yourorg/oneplatform" },
      sidebar: [
        { label: "Getting Started", autogenerate: { directory: "docs/getting-started" } },
        {
          label: "API Reference",
          items: [
            { label: "Overview", link: "/api/" },
            { label: "Gateway", link: "/api/gateway" },
            { label: "Auth", link: "/api/auth" },
            { label: "Ingestion", link: "/api/ingestion" },
            { label: "Ontology", link: "/api/ontology" },
            { label: "Pipeline", link: "/api/pipeline" },
            { label: "Execution", link: "/api/execution" },
            { label: "App", link: "/api/app" },
            { label: "Logging", link: "/api/logging" },
            { label: "Plugin", link: "/api/plugin" },
          ],
        },
        {
          label: "SDK Reference",
          items: [
            { label: "@oneplatform/sdk", autogenerate: { directory: "generated/typedoc/sdk" } },
            { label: "@oneplatform/app-sdk", autogenerate: { directory: "generated/typedoc/app-sdk" } },
            { label: "@oneplatform/plugin-sdk", autogenerate: { directory: "generated/typedoc/plugin-sdk" } },
          ],
        },
        {
          label: "CLI Reference",
          autogenerate: { directory: "generated/cli" },
        },
        {
          label: "Architecture",
          items: [
            { label: "ADR Index", autogenerate: { directory: "architecture/decisions" } },
            { label: "Service Designs", autogenerate: { directory: "architecture/designs" } },
          ],
        },
      ],
      customCss: ["./src/styles/custom.css"],
    }),
  ],
  vite: {
    resolve: {
      alias: {
        // Dynamic alias computed from this file's location — no hardcoded paths.
        "generated": generatedDir,
        "architecture": architectureDir,
      },
    },
  },
});
```

The `fileURLToPath(new URL("../../docs", import.meta.url))` pattern computes the path relative to `astro.config.mjs` at load time, so the config works regardless of where the monorepo is checked out. This replaces the previous hardcoded `/home/ubuntu/topics/oneplatform/docs/generated` path.

### API Reference Pages (Scalar Embed)

Each API reference page is an `.mdx` file that embeds the Scalar API explorer:

```mdx
---
title: Auth Service API
description: Authentication, authorization, API keys, roles, and user management.
---

import ScalarApiExplorer from "../../components/ScalarApiExplorer.tsx";

<ScalarApiExplorer specUrl="/api/v1/openapi/auth.json" />

The Auth Service handles all platform authentication. See the [CLI Reference](/docs/cli/auth)
for command-line equivalents.
```

The `ScalarApiExplorer` component uses `@scalar/react` (MIT):

```typescript
// packages/docs/src/components/ScalarApiExplorer.tsx
import { ApiReferenceReact } from "@scalar/react";
import "@scalar/api-reference/style.css";

interface Props {
  specUrl: string;
}

export default function ScalarApiExplorer({ specUrl }: Props) {
  return (
    <ApiReferenceReact
      configuration={{
        spec: { url: specUrl },
        theme: "default",
        layout: "modern",
        darkMode: true,
        showSidebar: true,
        hideDownloadButton: false,
      }}
    />
  );
}
```

The per-service spec files (`auth.json`, etc.) are served by the Gateway at `/api/v1/openapi/{service}.json` (see Section 9). The merged spec is at `/api/v1/openapi.json` (tenant-specific combined) or `/api/v1/openapi/base.json` (static, no tenant overlay).

### `docs:generate` Script for the Docs Site

```json
// packages/docs/package.json
{
  "name": "@oneplatform/docs",
  "private": true,
  "scripts": {
    "build": "astro build",
    "dev": "astro dev",
    "docs:generate": "echo 'Docs site has no generate step — it reads from docs/generated/'",
    "clean": "rm -rf dist"
  }
}
```

The Starlight site's `build` step (not its `docs:generate` step) is what assembles the final site. The `docs:generate` step is a no-op for the docs package itself because it is a consumer, not a producer, of generated artifacts. The turbo task ordering (see Section 7) ensures all producer `docs:generate` tasks run before the docs site's `build` task.

---

## 7. Build Pipeline (Turbo Tasks and Dependencies)

### Problem: Three Turbo Constraints That Must All Be Satisfied

Three Turbo 2.x constraints shape the pipeline design:

1. **Output paths must not traverse outside the package directory.** A path like `"../../docs/generated/**"` in a service's `outputs` array is rejected by Turbo. Per-service outputs must be within `dist/` under each service package.

2. **`dependsOn` without `^` means "same package".** In Turbo 2.x, `"dependsOn": ["docs:merge"]` in a task that runs in `packages/docs` looks for a `docs:merge` script in `packages/docs/package.json`, not in the root. If `docs:merge` lives in the root, the dependency cannot be expressed this way.

3. **The merger must read from all per-service `dist/openapi/` outputs.** The merger is a fan-in step that has no meaningful single-package home — it reads from all services and writes to the root `docs/generated/`.

### Resolution: Two-Level Pipeline

The solution is to separate the Turbo-managed per-package tasks from the root-only shell steps:

**Level 1 (Turbo-managed, parallelized):** Per-service and per-package `docs:generate` tasks. Each task writes within its own package directory (`dist/openapi/`, `dist/typedoc/`). Turbo caches these outputs correctly because paths are within the package boundary.

**Level 2 (Root shell steps, sequential):** The `docs:merge` and `docs:build` scripts in the root `package.json` run after `turbo docs:generate` completes. They are plain npm scripts, not Turbo tasks. They read from the per-package `dist/` outputs and write to `docs/generated/`. The CI and developer workflows call these explicitly in sequence.

This resolves all three constraints: Turbo manages only the parallelizable per-package work; the fan-in aggregation steps run outside Turbo where they belong.

### Updated `turbo.json`

The `turbo.json` `docs:generate` task is updated with correct output paths. The `docs:merge` and `docs:build` tasks are removed from `turbo.json` entirely — they are root-only shell steps.

```json
{
  "$schema": "https://turbo.build/schema.json",
  "ui": "tui",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    },
    "test": {
      "dependsOn": ["^build"],
      "outputs": ["coverage/**"]
    },
    "lint": {
      "outputs": []
    },
    "clean": {
      "cache": false
    },
    "docs:generate": {
      "dependsOn": ["^build"],
      "outputs": ["dist/openapi/**", "dist/typedoc/**", "dist/docs/**"],
      "env": ["NODE_ENV"]
    },
    "test:integration:level1": {
      "dependsOn": ["build"],
      "outputs": ["coverage/**"]
    },
    "test:integration:level2": {
      "dependsOn": ["build"],
      "outputs": []
    }
  }
}
```

Note: `dist/docs/**` covers the CLI package's output. `dist/openapi/**` covers service OpenAPI outputs. `dist/typedoc/**` covers TypeDoc package outputs. All paths are within-package relative globs — no `../../` traversal.

### Root `package.json` Scripts

```json
// root package.json (additions)
"docs:merge": "tsx tools/openapi-gen/src/cli.ts --merge --services-root services/ --out docs/generated/openapi/merged.json && cp -r packages/sdk/dist/typedoc docs/generated/typedoc/sdk && cp -r packages/app-sdk/dist/typedoc docs/generated/typedoc/app-sdk && cp -r packages/plugin-sdk/dist/typedoc docs/generated/typedoc/plugin-sdk && cp -r packages/core/dist/typedoc docs/generated/typedoc/core && cp -r packages/cli/dist/docs/. docs/generated/cli/",
"docs:build": "pnpm --filter @oneplatform/docs build"
```

For readability, the `docs:merge` logic can be extracted to a script file:

```json
"docs:merge": "node tools/scripts/docs-merge.mjs",
"docs:build": "pnpm --filter @oneplatform/docs build"
```

### Full Pipeline Sequence (for CI)

```bash
# Step 1: Build all workspaces (parallelized by turbo)
pnpm turbo build

# Step 2: Generate per-service OpenAPI specs, TypeDoc, and CLI docs (parallelized by turbo)
pnpm turbo docs:generate

# Step 3: Merge outputs into docs/generated/ (root shell step — runs after Step 2)
pnpm docs:merge

# Step 4: Build the Starlight docs site (root shell step — runs after Step 3)
pnpm docs:build
```

These four steps are run in sequence in CI. There is no single Turbo command that executes all four in order because Steps 3 and 4 are not Turbo tasks. This is intentional — the fan-in steps are too simple to justify a Turbo task graph entry.

### Per-Service `docs:generate` Scripts

Each service adds the following to its `package.json`:

```json
// services/auth/package.json (addition)
"docs:generate": "tsx ../../tools/openapi-gen/src/cli.ts --service auth --meta src/openapi-meta.ts --out dist/openapi/auth.json"
```

```json
// services/gateway/package.json (addition)
"docs:generate": "tsx ../../tools/openapi-gen/src/cli.ts --service gateway --meta src/openapi-meta.ts --out dist/openapi/gateway.json"
```

Per-package `docs:generate` scripts for TypeDoc packages:

```json
// packages/sdk/package.json (addition)
"docs:generate": "typedoc --options typedoc.json"

// packages/app-sdk/package.json (addition)
"docs:generate": "typedoc --options typedoc.json"

// packages/plugin-sdk/package.json (addition)
"docs:generate": "typedoc --options typedoc.json"

// packages/core/package.json (addition)
"docs:generate": "typedoc --options typedoc.json"
```

The CLI's updated `docs:generate` script:

```json
// packages/cli/package.json (updated)
"docs:generate": "tsx src/lib/docs-generator.ts --out dist/docs"
```

---

## 8. CI Drift Check Mechanism

### The Problem

If a developer changes a Zod schema or adds a route but forgets to update the `openapi-meta.ts` file, the generated OpenAPI spec will be out of date. The drift check catches this in CI.

### Strategy: Regenerate and Diff

The CI drift check is a separate CI step that:
1. Runs the full doc generation pipeline (`pnpm turbo docs:generate && pnpm docs:merge`)
2. Runs `git diff --exit-code docs/generated/`
3. If there is any diff, CI fails with a human-readable error message

This works because `docs/generated/` is committed to git. The generated artifacts are stored in version control, not produced on-the-fly at runtime. This is the same strategy used by tools like `graphql-codegen`, `openapi-generator`, and TypeScript's generated `.d.ts` files for public packages.

### Why Commit Generated Artifacts

Committing generated artifacts to git is unusual but correct for this use case:

- **The gateway serves the static base spec as a file loaded at startup.** If the spec is not in the repo, the Docker image build would need to run the generator, adding a TypeScript runtime and all dev dependencies to the production image. Committing the artifact keeps production images minimal.
- **The docs site builds from these artifacts.** The Starlight build reads `docs/generated/`. If artifacts are not committed, CI would need two phases: generate-then-build, which breaks the simple `docker build` model.
- **Auditable change history.** When a developer adds a new endpoint, the PR diff shows both the schema change and the generated spec change. Reviewers see exactly what the API contract change looks like in OpenAPI format.
- **The drift check enforces freshness.** If artifacts are committed, the drift check becomes a simple `git diff`. If artifacts were not committed, the check would need to compare two independently-generated artifacts, which is more complex.

### CI Job Definition (GitHub Actions example)

```yaml
# .github/workflows/docs-drift.yml
name: Docs Drift Check

on: [push, pull_request]

jobs:
  docs-drift:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: "20", cache: "pnpm" }
      - run: pnpm install --frozen-lockfile
      - run: pnpm turbo build --filter='!@oneplatform/docs'
      - run: pnpm turbo docs:generate
      - run: pnpm docs:merge
      - name: Check for drift
        run: |
          if ! git diff --exit-code docs/generated/; then
            echo ""
            echo "ERROR: Generated documentation is out of sync with source code."
            echo "Run 'pnpm turbo docs:generate && pnpm docs:merge' locally and commit the result."
            exit 1
          fi
```

The `--filter='!@oneplatform/docs'` exclusion prevents building the Starlight site in the drift check (the site build reads from `docs/generated/` which is checked by the diff, not by the site build itself).

### What the Drift Check Catches

| Scenario | Caught? |
|----------|---------|
| Developer adds a Zod field to a schema but does not update `openapi-meta.ts` | No — `openapi-meta.ts` still references the same schema object. The generated spec will automatically include the new field (zod-to-json-schema reflects the live schema). |
| Developer adds a new route but does not add it to `openapi-meta.ts` | Yes — the spec will be missing the route. If the generated spec matches the committed one, the new route is undocumented. The developer must add it to `openapi-meta.ts` and regenerate. |
| Developer modifies a route path but does not update `openapi-meta.ts` | Yes — the old path still appears in the spec; the new path is missing. |
| Developer adds a new TSDoc comment to an SDK export | Yes — TypeDoc output will differ. |
| Developer adds a new CLI command | Yes — CLI markdown output will differ. |

Note on the first row: a Zod schema change is automatically reflected in the spec because `openapi-meta.ts` references the schema object (not a static JSON snapshot). This is the key advantage of the build-time extraction approach — schema changes are automatically propagated to the spec without any manual update.

### Lint Rule: All Routes Must Be in `openapi-meta.ts`

To catch the second scenario proactively (new routes missing from meta), a validation script is added to each service's `docs:generate` step:

```bash
# services/auth/package.json docs:generate (extended)
"docs:generate": "tsx ../../tools/openapi-gen/src/cli.ts --service auth --meta src/openapi-meta.ts --out dist/openapi/auth.json && node ../../tools/openapi-gen/scripts/validate-coverage.mjs services/auth"
```

The `validate-coverage.mjs` script uses a regex scan of `src/routes/*.ts` to find all `routes.{method}(` calls and verifies that each path appears in `openapi-meta.ts`. It prints a warning (not an error) for routes that are internal-only (paths starting with `/internal/`), which are intentionally excluded from the public spec.

**Acknowledged limitation:** The regex scan in `validate-coverage.mjs` is best-effort. It correctly identifies single-line route registrations (`routes.post("/path", ...)`) but may miss multi-line registrations where the path string is on a different line from the method call, or registrations that use a variable as the path. False negatives (uncovered routes not reported) are possible in those cases. This is documented and acceptable — the drift check catches the case where the spec diverges from committed state regardless of whether the coverage validator catches it first.

---

## 9. Gateway `/api/v1/openapi.json` Endpoint — Hybrid Static + Tenant-Dynamic Spec

### ADR-29 Requirement

ADR-29 requires that `GET /api/v1/openapi.json` returns a tenant-specific spec including auto-generated routes for ontology-defined entity types. A purely static file cannot satisfy this because entity types are user-defined per tenant.

### Hybrid Architecture

The gateway handler implements a two-layer approach:

1. **Static base spec** — loaded from `docs/generated/openapi/merged.json` at process startup and cached in memory. This covers all platform-owned routes and uses generic templated paths for data routes (`/api/v1/data/{entityType}`).

2. **Tenant-dynamic overlay** — generated at request time for authenticated requests. The gateway queries its in-process `OntologyCache` (already populated from the ontology service) for the requesting tenant's entity definitions, generates concrete OpenAPI path entries for each entity type, and merges them into the base spec before returning.

The overlay generation reads from the `OntologyCache` — which is already in-process memory (populated via Redis pub/sub and a 5-minute safety poll, as seen in `services/gateway/src/services/ontology-cache.ts`). There are no network calls on the hot path. The merge is a simple object merge of the `paths` section.

For unauthenticated requests (no valid JWT), the endpoint falls back to returning the static base spec with the generic templated paths.

### New Route: `services/gateway/src/routes/openapi.ts`

```typescript
import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import type { AppVariables } from "@oneplatform/core";
import type { OntologyCache } from "../services/ontology-cache.js";

export interface OpenApiRouteDeps {
  /** Absolute path to docs/generated/openapi/merged.json (the static base spec). */
  specPath: string;
  /** Absolute path to docs/generated/openapi/ directory (for per-service specs). */
  specDir: string;
  /** The live ontology cache — used to generate the tenant-dynamic overlay. */
  ontologyCache: OntologyCache;
}

export function createOpenApiRoutes(deps: OpenApiRouteDeps): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();

  // In-memory cache of the static base spec (parsed JSON).
  // Loaded once at first request. A process restart is required to pick up
  // a new static spec after regeneration.
  let baseSpec: Record<string, unknown> | null = null;

  async function loadBaseSpec(): Promise<Record<string, unknown> | null> {
    if (baseSpec) return baseSpec;
    try {
      const raw = await readFile(deps.specPath, "utf-8");
      baseSpec = JSON.parse(raw) as Record<string, unknown>;
      return baseSpec;
    } catch {
      return null;
    }
  }

  // Generates OpenAPI path entries for a tenant's entity types.
  // Reads from the in-process OntologyCache — no network call.
  function buildEntityOverlay(tenantId: string): Record<string, unknown> {
    const entityTypes = deps.ontologyCache.getAllEntityTypes(tenantId);
    const paths: Record<string, unknown> = {};

    for (const slug of entityTypes) {
      const entity = deps.ontologyCache.getEntity(tenantId, slug);
      if (!entity || !entity.isPublic) continue;

      // List endpoint: GET /api/v1/data/{slug}
      paths[`/api/v1/data/${slug}`] = {
        get: {
          summary: `List ${entity.name} records`,
          description: `Returns paginated ${entity.name} records for the requesting tenant.`,
          operationId: `list${pascalCase(slug)}`,
          tags: ["Data", entity.name],
          security: [{ BearerAuth: [] }],
          parameters: [
            { name: "cursor", in: "query", schema: { type: "string" } },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 50 } },
          ],
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      data: {
                        type: "array",
                        items: buildEntityItemSchema(entity),
                      },
                      pagination: { $ref: "#/components/schemas/PaginationSchema" },
                    },
                  },
                },
              },
            },
          },
        },
      };

      // Record endpoint: GET /api/v1/data/{slug}/{recordId}
      paths[`/api/v1/data/${slug}/{recordId}`] = {
        get: {
          summary: `Get ${entity.name} record`,
          operationId: `get${pascalCase(slug)}ById`,
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
            "404": { description: "Record not found" },
          },
        },
      };
    }

    return paths;
  }

  function buildEntityItemSchema(entity: ReturnType<OntologyCache["getEntity"]> & {}): Record<string, unknown> {
    const properties: Record<string, unknown> = {
      id: { type: "string", format: "uuid" },
      tenantId: { type: "string", format: "uuid" },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    };
    for (const field of entity.fields) {
      properties[field.slug] = fieldTypeToJsonSchema(field.fieldType, field.nullable);
    }
    return { type: "object", properties };
  }

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

  // GET /api/v1/openapi.json
  // Returns the tenant-specific combined spec when a valid Bearer token is present.
  // Falls back to the static base spec for unauthenticated or system-level requests.
  // Public endpoint: no authentication middleware blocks this route.
  routes.get("/api/v1/openapi.json", async (c) => {
    const spec = await loadBaseSpec();
    if (!spec) {
      return c.json({
        error: {
          code: "SPEC_NOT_FOUND",
          message: "OpenAPI spec not yet generated. Run: pnpm turbo docs:generate && pnpm docs:merge",
        },
      }, 503);
    }

    const user = c.var.user;
    if (user?.tenantId) {
      // Authenticated request — generate tenant-specific overlay
      const overlayPaths = buildEntityOverlay(user.tenantId);
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

  // GET /api/v1/openapi/base.json — static base spec, no tenant overlay
  // Intended for SDK code generators that do not need tenant-specific paths,
  // and for the Starlight docs site to load as the source spec for Scalar.
  routes.get("/api/v1/openapi/base.json", async (c) => {
    const spec = await loadBaseSpec();
    if (!spec) {
      return c.json({ error: { code: "SPEC_NOT_FOUND", message: "Spec not generated." } }, 503);
    }
    return new Response(JSON.stringify(spec), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300",
        "Access-Control-Allow-Origin": "*",
      },
    });
  });

  // GET /api/v1/openapi/{service}.json — per-service specs
  // Enables the Scalar explorer in the docs site to load each service's spec independently.
  routes.get("/api/v1/openapi/:service{[a-z-]+}.json", async (c) => {
    const service = c.req.param("service");
    const allowed = ["gateway", "auth", "ingestion", "ontology", "pipeline",
                     "execution", "app", "logging", "plugin"];
    if (!allowed.includes(service)) {
      return c.json({ error: { code: "NOT_FOUND", message: `Unknown service: ${service}` } }, 404);
    }
    const { join } = await import("node:path");
    try {
      const content = await readFile(join(deps.specDir, `${service}.json`), "utf-8");
      return new Response(content, {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=300",
          "Access-Control-Allow-Origin": "*",
        },
      });
    } catch {
      return c.json({
        error: { code: "SPEC_NOT_FOUND", message: `Spec for service '${service}' not yet generated.` },
      }, 503);
    }
  });

  return routes;
}
```

### `op sdk generate` Integration

`op sdk generate` calls `GET /api/v1/openapi.json` with the user's stored Bearer token. Because the user is authenticated, the gateway returns the tenant-specific combined spec (base + entity overlay). The SDK generator then sees both platform-owned routes and the tenant's concrete entity type routes.

### Cache-Control Headers

- **Authenticated tenant-specific response:** `Cache-Control: private, max-age=60`. Tenant entities change infrequently but can change. 60 seconds is appropriate.
- **Unauthenticated base spec:** `Cache-Control: public, max-age=300`. The base spec changes only on redeploy.
- **Per-service specs:** `Cache-Control: public, max-age=300`. Same as base.

Note: Per-service spec files read from disk are not cached in-process in the revised design (unlike the base spec which is). Per-service specs are only used by the Scalar explorer in the docs site, which is a relatively low-traffic path. If per-service spec read latency becomes a concern, an in-process cache can be added at that time.

### Wiring in `services/gateway/src/index.ts`

```typescript
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createOpenApiRoutes } from "./routes/openapi.js";

// Compute paths relative to this file's location.
// services/gateway/src/index.ts -> ../../../../docs/generated/openapi/
const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultSpecPath = join(__dirname, "../../../../docs/generated/openapi/merged.json");
const defaultSpecDir = join(__dirname, "../../../../docs/generated/openapi/");

const specPath = process.env["OP_OPENAPI_SPEC_PATH"] ?? defaultSpecPath;
const specDir = process.env["OP_OPENAPI_SPEC_DIR"] ?? defaultSpecDir;

const openApiRoutes = createOpenApiRoutes({ specPath, specDir, ontologyCache });
app.route("/", openApiRoutes);
```

The `openApiRoutes` must be registered before the catch-all `proxyRoutes` to prevent the proxy from intercepting `/api/v1/openapi.json`.

### Docker Compose: Mounting the Spec

```yaml
gateway-service:
  volumes:
    - ./docs/generated/openapi:/data/openapi:ro
  environment:
    OP_OPENAPI_SPEC_PATH: /data/openapi/merged.json
    OP_OPENAPI_SPEC_DIR: /data/openapi/
```

### Self-Documentation in `openapi-meta.ts`

The gateway's `openapi-meta.ts` documents the OpenAPI endpoints themselves:

```typescript
{
  method: "GET",
  path: "/api/v1/openapi.json",
  summary: "Combined OpenAPI spec (tenant-specific)",
  description: "When called with a valid Bearer token, returns the platform OpenAPI spec " +
    "merged with auto-generated paths for the requesting tenant's ontology entity types. " +
    "Without authentication, returns the static base spec with generic templated data paths.",
  tags: ["Meta"],
  security: [],
  response: { 200: z.unknown().describe("OpenAPI303Document") },
},
{
  method: "GET",
  path: "/api/v1/openapi/base.json",
  summary: "Static base OpenAPI spec",
  description: "Returns the static merged OpenAPI spec for all platform-owned routes. " +
    "No tenant overlay applied. Suitable for SDK generation without tenant context.",
  tags: ["Meta"],
  security: [],
  response: { 200: z.unknown().describe("OpenAPI303BaseDocument") },
},
```

### ADR-23 Ontology Docs Tier (Per-Tenant Runtime Docs) — Deferred

ADR-23 describes a future "ontology docs tier" where per-tenant entity types would have fully rendered documentation pages (not just OpenAPI paths) visible in the docs site at runtime. This tier is explicitly out of scope for this design. The tenant-dynamic overlay in the OpenAPI spec satisfies ADR-29. A full per-tenant docs site (Tier 3 from ADR-23) would require a separate runtime rendering pipeline, SSR or tenant-specific static builds, and is deferred to a future design.

---

## 10. Directory Structure for Generated Artifacts

```
docs/
├── decisions/                         # Architecture Decision Records (hand-written)
│   ├── 001-architecture-decisions.md
│   └── 002-expanded-architecture-decisions.md
├── designs/                           # Per-service design docs (hand-written)
│   ├── auto-generated-docs.md         # this document
│   └── ...
└── generated/                         # All auto-generated content (committed to git)
    ├── .gitkeep                        # ensures directory exists in a clean checkout
    ├── openapi/
    │   ├── merged.json                # Static base spec — all services merged (served at /api/v1/openapi/base.json, and as the base for /api/v1/openapi.json)
    │   ├── gateway.json               # Copied from services/gateway/dist/openapi/ by docs:merge
    │   ├── auth.json
    │   ├── ingestion.json
    │   ├── ontology.json
    │   ├── pipeline.json
    │   ├── execution.json
    │   ├── app.json
    │   ├── logging.json
    │   └── plugin.json
    ├── typedoc/
    │   ├── sdk/                        # Copied from packages/sdk/dist/typedoc/ by docs:merge
    │   │   ├── index.md
    │   │   ├── functions/
    │   │   │   └── createClient.md
    │   │   └── ...
    │   ├── app-sdk/
    │   ├── plugin-sdk/
    │   └── core/
    └── cli/
        ├── index.md
        ├── auth.md
        ├── connectors.md
        ├── pipelines.md
        ├── apps.md
        ├── plugins.md
        ├── logs.md
        ├── ontology.md
        ├── users.md
        └── service.md
```

### Per-Package Intermediate Outputs (not committed to git)

Each service and package writes to its own `dist/` directory:

```
services/auth/dist/openapi/auth.json         # Turbo-cached, gitignored
services/gateway/dist/openapi/gateway.json   # Turbo-cached, gitignored
packages/sdk/dist/typedoc/                   # Turbo-cached, gitignored
packages/cli/dist/docs/                      # Turbo-cached, gitignored
```

These are gitignored (already covered by the existing `dist/` gitignore) and managed by Turbo's cache. The `docs:merge` step reads from them and writes the committed artifacts to `docs/generated/`.

### `.gitignore` Handling

The `docs/generated/` directory is committed to git (not gitignored). Generated artifacts are source-controlled artifacts, not build-time intermediates. The reasoning is explained in Section 8.

The `packages/docs/dist/` output of the Starlight build is gitignored (it is a deployment artifact, not a source artifact):

```gitignore
# packages/docs/.gitignore
dist/
.astro/
```

---

## 11. Per-Service and Per-Package Implementation Plan

### Priority Order

Implementation is sequenced by developer impact and dependency order:

**Phase 1 — Foundation (Week 1)**
- Create `tools/openapi-gen/` tool (with `requireDescribedName` enforcement)
- Create `docs/generated/` directory structure
- Create `services/auth/src/openapi-meta.ts` (most complete schemas, good reference)
- Wire auth service `docs:generate` script (writes to `dist/openapi/auth.json`)
- Add auth `openapi-meta.ts` drift check to CI

**Phase 2 — Remaining Services (Week 2)**
- Create `openapi-meta.ts` for all 9 services
- Wire all service `docs:generate` scripts
- Add merger step (`pnpm docs:merge` root shell script)
- Wire gateway `/api/v1/openapi.json` endpoint (hybrid handler with ontology overlay)
- Fix `op sdk generate` command

**Phase 3 — SDK and Package Docs (Week 2-3)**
- Add TypeDoc to `sdk`, `app-sdk`, `plugin-sdk`, `core` (output to `dist/typedoc/`)
- Add TSDoc comments where missing (prioritize `sdk` and `app-sdk` first)
- Wire TypeDoc `docs:generate` for all 4 packages

**Phase 4 — Docs Site (Week 3)**
- Create `packages/docs/` Starlight package
- Configure content collections for all generators' output (using dynamic paths in `astro.config.mjs`)
- Embed Scalar API explorer in API reference pages
- Wire `docs:build` root shell script
- Deploy docs site behind Gateway

**Phase 5 — CI and Hardening (Week 3-4)**
- Full CI drift check covering all generators
- Route coverage validation script
- TSDoc completeness check (ESLint `jsdoc/require-jsdoc`)
- Lint rule for `.refine()` / `.superRefine()` on OpenAPI-bound schemas (see Section 15)
- Performance test: ensure full `pnpm turbo docs:generate` completes in under 2 minutes

### Per-Service Implementation Details

#### Gateway Service (`services/gateway/`)

**New file:** `services/gateway/src/openapi-meta.ts`

Routes to document:
- `GET /healthz` and `GET /readyz` (Health)
- `POST /api/v1/webhooks`, `GET /api/v1/webhooks`, `GET /api/v1/webhooks/:id`, `PATCH /api/v1/webhooks/:id`, `DELETE /api/v1/webhooks/:id` (Webhooks)
- `GET /api/v1/webhooks/:id/deliveries`, `POST /api/v1/webhooks/:id/deliveries/:deliveryId/redeliver` (Webhook Deliveries)
- `GET /api/v1/events` (SSE)
- `GET /api/v1/data/{entityType}`, `GET /api/v1/data/{entityType}/{recordId}`, `GET /api/v1/data/{entityType}/{recordId}/{relation}` (Data — generic templated paths)
- `GET /api/v1/admin/rate-limits`, `PUT /api/v1/admin/rate-limits` (Admin)
- `GET /api/v1/openapi.json`, `GET /api/v1/openapi/base.json`, `GET /api/v1/openapi/{service}.json` (Meta)

The `customHeadersSchema` in `services/gateway/src/schemas/index.ts` uses `.superRefine()`. This falls under the `.superRefine()` acknowledged limitation in Section 15 — the constraint checking that custom headers do not override reserved headers is not representable in OpenAPI. The schema will document the type (`Record<string, string>`) without the constraint. The description field in the schema's `.describe()` call should note the reserved header restriction.

**`package.json` addition:**
```json
"docs:generate": "tsx ../../tools/openapi-gen/src/cli.ts --service gateway --meta src/openapi-meta.ts --out dist/openapi/gateway.json"
```

#### Auth Service (`services/auth/`)

**New file:** `services/auth/src/openapi-meta.ts`

Routes to document (from `src/routes/`): all routes in `auth.ts`, `bootstrap.ts`, `oauth.ts`, `api-keys.ts`, `roles.ts`, `users.ts`, `health.ts`. The routes in `internal.ts` are excluded from the public spec (they start with `/internal/`).

All schemas are already fully defined in `src/schemas/index.ts` with `z.infer<>` type exports. This is the most complete service to start with.

**`package.json` addition:**
```json
"docs:generate": "tsx ../../tools/openapi-gen/src/cli.ts --service auth --meta src/openapi-meta.ts --out dist/openapi/auth.json"
```

#### Ingestion Service (`services/ingestion/`)

**New file:** `services/ingestion/src/openapi-meta.ts`

Key schemas: `listConnectorsQuery`, the cron-validated connector sync schema, file upload schemas. The ingestion service has a complex cron validation via `.superRefine()` — see the `.superRefine()` acknowledged limitation in Section 15. The `openapi-meta.ts` references the Zod schema object which includes the cron field with its constraints, but the functional constraint (valid cron expression) will not appear as a `pattern` in the OpenAPI output. The description field on the schema should document the cron format requirements in plain text.

#### Ontology Service (`services/ontology/`)

**New file:** `services/ontology/src/openapi-meta.ts`

The ontology service has complex discriminated unions (`fieldDefinitionSchema`, `validationRuleSchema`) and nested objects. The `zod-to-json-schema` library handles discriminated unions via `oneOf` in JSON Schema, which maps correctly to OpenAPI 3.0.3. Test this mapping explicitly in the `openapi-gen` test suite.

#### Pipeline Service (`services/pipeline/`)

**New file:** `services/pipeline/src/openapi-meta.ts`

The pipeline service uses `z.lazy()` for the recursive `ParallelStep.branches` definition. See the `z.lazy()` acknowledged limitation in Section 15. For the public spec, a bounded-depth variant of the step schema (without `z.lazy()`) should be defined in `openapi-meta.ts` instead of referencing the recursive production schema directly:

```typescript
// services/pipeline/src/openapi-meta.ts
// Use a bounded-depth schema for OpenAPI documentation — z.lazy() produces
// {} (any) in zod-to-json-schema. The actual runtime schema uses z.lazy()
// for unlimited depth; this bounded variant documents up to 3 levels of nesting.
const stepSchemaForDocs = z.union([
  ActionStepSchema,
  z.object({
    type: z.literal("parallel"),
    branches: z.array(z.union([ActionStepSchema, z.object({ type: z.literal("parallel"), branches: z.array(ActionStepSchema) })])),
  }),
]).describe("PipelineStep");
```

#### Execution Service (`services/execution/`)

**New file:** `services/execution/src/openapi-meta.ts`

Two distinct schemas: `RunRequestSchema` (public, JS/TS only, 512KB limit) and `InternalRunRequestSchema` (service-to-service, all languages, 10MB limit). Only `RunRequestSchema` goes in the public spec. `InternalRunRequestSchema` is documented in the internal spec extension (`x-internal: true` tag in the route meta).

#### App Service (`services/app/`)

**New file:** `services/app/src/openapi-meta.ts`

The app service has VFS endpoints, build endpoints, BFF endpoints, and env var endpoints. BFF endpoints (`/bff/*`) are internal to the App Service and should be marked `x-internal: true` in the meta — they are not documented in the public spec (they are only called by `@oneplatform/app-sdk` and are an implementation detail of the BFF pattern).

#### Logging Service (`services/logging/`)

**New file:** `services/logging/src/openapi-meta.ts`

Log query endpoints with time range, level, and trace ID filters. The logging service may have some endpoints that are only useful to internal services (e.g., the write endpoint). These should be `x-internal: true`.

#### Plugin Service (`services/plugin/`)

**New file:** `services/plugin/src/openapi-meta.ts`

Uses schemas from `src/schemas/index.ts` including the complex `PluginManifestSchema` with nested `HookDeclarationSchema`. The `bundleChecksum` field uses `.regex()` (64-char hex SHA-256) — this will correctly appear in the generated spec as a `pattern` field because `.regex()` is a declarative constraint that `zod-to-json-schema` can introspect.

### Per-Package Implementation Details

#### `@oneplatform/plugin-sdk`

**Status:** Has good JSDoc. Needs TSDoc-specific tags added (`@param`, `@returns`, `@throws`, `@example` where missing) and `@public`/`@internal` annotations.

**Action:** Add `typedoc.json`. Run TypeDoc. Review output. Add missing TSDoc tags in a targeted pass (estimate: 2 hours).

#### `@oneplatform/sdk`

**Status:** Minimal JSDoc. The `createClient` function and resource methods need full TSDoc.

**Action:** Add `typedoc.json`. Add TSDoc to all public exports in `src/index.ts` and their implementations. Estimate: 6 hours for complete coverage.

#### `@oneplatform/app-sdk`

**Status:** React hooks API — needs full TSDoc on all hooks (`useQuery`, `useMutation`, `useSubscription`, `useUser`, `usePermission`, `useAppStorage`).

**Action:** Add `typedoc.json`. Add TSDoc to the hooks API. The complete hook signatures are already documented in ADR-26 and can be translated to TSDoc comments directly. Estimate: 4 hours.

#### `@oneplatform/core`

**Status:** No JSDoc. Internal library.

**Action:** Add `typedoc.json` with `excludeInternal: false` (to show internal docs for contributors) and a separate `typedoc.contributor.json` with `excludeInternal: true` (for the public docs site). Add `@internal` tags to implementation files and `@public` tags to the contributor-facing subset. Estimate: 4 hours for a curated first pass.

---

## 12. Technology Choices and Rationale

| Technology | Role | License | Rationale |
|------------|------|---------|-----------|
| `zod-to-json-schema` | Converts Zod schemas to JSON Schema for OpenAPI | MIT | The only well-maintained library that handles all Zod constructs (discriminated unions, transforms). Produces OpenAPI 3.0.3-compatible output via `target: "openApi3"`. Limitations for `.refine()`, `.superRefine()`, and `z.lazy()` are documented in Section 15. Alternative `zod-openapi` requires `@hono/zod-openapi` which we are explicitly avoiding. |
| TypeDoc | API reference generator | MIT | The TypeScript API documentation standard. First-class support for TSDoc comments. The markdown plugin enables Starlight integration without a separate HTML server. |
| `typedoc-plugin-markdown` | TypeDoc output as Markdown | MIT | Enables TypeDoc output to be consumed by Starlight without running two separate doc servers. |
| Astro/Starlight | Docs site framework | MIT | Best static site generator for Markdown-heavy technical docs. Ships with Pagefind (static search), sidebar navigation, and island architecture for React component embedding. See Section 6 for full rationale. |
| `@scalar/react` | Interactive API explorer | MIT | Lighter than Swagger UI, better UX than Redoc, supports OpenAPI 3.0.3 natively. Renders inside a React island in Starlight. Already listed in ADR-16 tech stack as "Scalar or Stoplight Elements". |
| `tsx` | TypeScript script runner | MIT | Already used across the monorepo. Used to run the openapi-gen tool without a separate compilation step for the tool itself. |

---

## 13. Security Considerations

### OpenAPI Spec Disclosure

The merged OpenAPI spec at `/api/v1/openapi.json` is a public endpoint with `Access-Control-Allow-Origin: *`. This is intentional: the spec is documentation, not secret data. However, two categories of routes must NOT appear in the public spec:

1. **Internal service-to-service routes** (`/internal/*`): these routes are protected by `X-Service-Token` validation and are not intended for external callers. They must be excluded from the public spec. The `openapi-meta.ts` format's convention is to simply not include them in the `routes` array. The route coverage validation script (`validate-coverage.mjs`) knows to ignore paths starting with `/internal/`.

2. **Bootstrap endpoint** (after bootstrap is complete): the bootstrap endpoint's existence in the spec is acceptable (it is documented to return `410 Gone` after use), but its presence should not suggest to attackers that it is perpetually active. The spec entry includes a prominent `description` noting the `410 Gone` behavior.

The spec should not contain actual example values that include real tenant IDs, user IDs, or credentials. All examples in `openapi-meta.ts` schemas use clearly synthetic UUIDs (e.g., `123e4567-e89b-12d3-a456-426614174000`).

### Tenant Data Leakage in the Dynamic Overlay

The tenant-dynamic overlay contains only entity type slugs, field names, and field types — all of which are schema metadata, not data records. The overlay is generated from the `OntologyCache` entry for the requesting tenant, which is keyed by the JWT-verified `tenantId`. Cross-tenant leakage is not possible as long as the JWT validation is correct (which it is — handled by the existing middleware stack in `@oneplatform/core`).

The overlay does not include data values, record IDs, or any tenant-specific content beyond schema shape.

### Generator Tool Attack Surface

The `openapi-gen` tool runs at build time in the CI environment, not in production. It:
- Only reads from the local filesystem (no network calls)
- Only writes to `services/*/dist/openapi/` and `docs/generated/openapi/` (controlled directories)
- Does not execute user-supplied code (the Zod schemas are TypeScript source files that are imported, not `eval`'d)

The tool's dependencies (`zod-to-json-schema`, `tsx`) are standard build dependencies with no runtime attack surface.

### Docs Site Authentication

The Starlight docs site, served at `/docs`, is public documentation. No authentication is required to view it. This is consistent with the platform's documentation philosophy (ADR-23): the docs describe the API, not the data.

However, the Scalar API explorer embedded in the docs site allows users to make live API calls. The explorer must be configured to require users to supply their own API key or Bearer token — it must not auto-populate credentials. The `ScalarApiExplorer` component must not read credentials from `localStorage` or `sessionStorage` and must not include any credential auto-fill.

---

## 14. Testing Strategy

### Unit Tests for `tools/openapi-gen/`

The generator tool has its own Vitest test suite at `tools/openapi-gen/src/__tests__/`:

```
tools/openapi-gen/src/__tests__/
├── zod-converter.test.ts    # tests for Zod-to-JSON-Schema conversion edge cases
├── spec-builder.test.ts     # tests for OpenAPI document assembly
├── merger.test.ts           # tests for multi-service spec merging
└── fixtures/
    ├── auth-meta.ts         # simplified auth service meta for testing
    └── expected-auth.json   # expected OpenAPI output for auth-meta.ts
```

Key test cases:
- `z.discriminatedUnion()` produces valid OpenAPI `discriminator` object in OAS 3.0.3
- Bounded-depth step schema (Pipeline service) terminates and produces valid JSON Schema
- `z.regex()` (plugin bundleChecksum) correctly produces `pattern` field
- `.refine()` schema produces a build-time warning or error (not silently dropped)
- `z.lazy()` schema detected and build error raised (directing developer to use bounded-depth variant)
- Schema name conflicts in merger produce a build error
- Path conflicts in merger produce a build error
- Internal routes excluded from public spec when not listed in `routes` array
- `requireDescribedName` throws when `.describe()` is missing from a schema in `openapi-meta.ts`
- `openapi` field in generated output is `"3.0.3"` (not `"3.1.0"`)

### Unit Tests for Gateway OpenAPI Handler

Tests in `services/gateway/src/__tests__/openapi.test.ts`:
- Unauthenticated request returns base spec with generic templated data paths
- Authenticated request with tenant that has entity types returns spec with concrete entity paths
- Authenticated request with tenant that has no entity types returns base spec unchanged
- `buildEntityOverlay` correctly maps entity field types to JSON Schema types
- `isPublic: false` entity types are excluded from the overlay
- Handler returns 503 when the spec file is missing

### Integration Test: End-to-End Spec Generation

A test in `tools/openapi-gen/src/__tests__/integration.test.ts` runs the generator CLI against a real service's `openapi-meta.ts` (auth service is the reference implementation) and validates the output against the committed `docs/generated/openapi/auth.json`. This test doubles as the drift check for the generator tool itself.

### Docs Site Build Test

The Starlight site build is tested in CI as a separate step (`pnpm docs:build`). A failed build (broken import, invalid Markdown frontmatter, missing content collection entry) fails CI. The output is not deployed in the test run — the build succeeding is the test.

### TypeDoc Output Validation

A lightweight script (`tools/openapi-gen/scripts/validate-typedoc.mjs`) checks that the TypeDoc JSON output (the `.json` file generated alongside the Markdown) contains a minimum number of documented exports per package. This prevents regressions where TypeDoc generates an empty or near-empty output due to configuration errors:

```javascript
// tools/openapi-gen/scripts/validate-typedoc.mjs
const minimums = {
  sdk: 30,       // createClient + all resource methods + error types
  "app-sdk": 8,  // 6 hooks + AppProvider + AppSDKError
  "plugin-sdk": 15, // all interface exports
  core: 10,      // public contributor-facing exports
};
```

If the generated JSON contains fewer documented items than the minimum, the validation script exits with a non-zero code and CI fails.

---

## 15. Known Limitations and Acknowledged Gaps

This section documents the limitations of the generation approach. Each limitation is a conscious decision with a documented rationale — none are "unknowns to be discovered later."

### L-1: OpenAPI Version is 3.0.3, Not 3.1.0

`zod-to-json-schema` with `target: "openApi3"` produces JSON Schema Draft 7 compatible output, which aligns with OpenAPI 3.0.x. OpenAPI 3.1.0 requires JSON Schema 2020-12 (available via `target: "jsonSchema2019-09"`), but OpenAPI 3.1.0 support in downstream tooling (Scalar, swagger-codegen, openapi-typescript) is less mature than 3.0.3 support.

**Decision:** Standardize on OpenAPI 3.0.3. The `openapi` field in all generated documents is `"3.0.3"`. The `target: "openApi3"` parameter in `zod-to-json-schema` calls is the correct choice for this version.

**Migration path:** When tooling support for 3.1.0 matures, change `target` to `"jsonSchema2019-09"` and `openapi` field to `"3.1.0"` in `spec-builder.ts`. Update all tests.

### L-2: `.refine()` and `.superRefine()` Constraints Are Not Representable in OpenAPI

`zod-to-json-schema` cannot introspect arbitrary JavaScript functions. Any Zod schema that uses `.refine()` or `.superRefine()` will produce valid JSON Schema output, but the custom constraint will be silently absent from the output.

Examples in the codebase:
- `customHeadersSchema` in `services/gateway/src/schemas/index.ts` uses `.superRefine()` to reject reserved header keys
- `createScheduleRequest` in `services/ingestion/` uses `.superRefine()` for cron expression validation

**Decision:** These constraints are documented in plain text in the schema's `.describe()` call in `openapi-meta.ts`. The generated spec is structurally accurate but missing the semantic constraint.

**Enforcement:** A lint rule (`openapi-gen/lint/no-refine-in-meta.mjs`) is added to the generator's `docs:generate` step. It statically analyzes each `openapi-meta.ts` file and warns when any schema referenced in the meta uses `.refine()` or `.superRefine()`. This prevents developers from unknowingly depending on a constraint that will not appear in the spec. The warning message instructs the developer to either use a declarative equivalent (`.regex()`, `.min()`, `.max()`, `.enum()`) if possible, or to add the constraint description as a `.describe()` annotation.

### L-3: `z.lazy()` Recursive Schemas Produce `{}` (any) in the Generated Spec

`zod-to-json-schema` replaces `z.lazy()` references with `{}` (empty schema, equivalent to `any`) by default. The `PipelineStepSchema` in the pipeline service uses `z.lazy()` for `ParallelStep.branches`. If the production schema were referenced directly in `openapi-meta.ts`, the generated spec would type the nested steps as `any`.

**Decision:** Services with `z.lazy()` schemas must provide a bounded-depth variant for `openapi-meta.ts`. The bounded-depth variant explicitly inlines up to N levels of nesting (3 levels is sufficient for documentation purposes). The production schema is unchanged. See the Pipeline Service section in Section 11 for the bounded-depth variant pattern.

**Enforcement:** The `requireDescribedName` function already requires a `.describe()` call on every schema. The generator also checks whether the schema's `_def` contains a `ZodLazy` type and raises a build error if `z.lazy()` is used directly in a route's `openapi-meta.ts` registration, directing the developer to use a bounded-depth variant instead.

### L-4: Schema Name Collisions via `_Response` Suffix

The naive approach of deriving schema names by appending `_Response` to the Zod schema's description would cause collisions when two routes reuse the same response schema. For example, if two services both have a response schema described as `"UserResponse"`, the merger would detect a name collision.

**Decision:** Schema names are required to be globally unique across all services. The `requireDescribedName` function enforces that every schema in `openapi-meta.ts` has an explicit `.describe("UniqueName")` call. For response schemas, the convention is `{Entity}{Action}Response` (e.g., `"LoginResponse"`, `"CreateApiKeyResponse"`). The merger's conflict detection catches any remaining collisions at build time.

No `_Response` suffix is automatically appended by the generator. The name used in `.describe()` is the exact name used in `components/schemas`. Developers are responsible for choosing globally unique names.

### L-5: Route Coverage Validator Is Best-Effort for Multi-Line Registrations

The `validate-coverage.mjs` regex scanner identifies route registrations matching the pattern `routes.{method}(` on a single line. Multi-line registrations where the HTTP method and path are on separate lines, or registrations using a variable as the path, may not be detected.

**Decision:** The validator is best-effort. It catches the common case (single-line registrations). The drift check (Section 8) provides the safety net — if a route exists but is not documented, the spec will not contain the route, but CI will only fail if the spec differs from what is committed. If an undocumented route is committed without being added to `openapi-meta.ts`, it will be invisible in the spec until someone notices and adds it. This is acceptable for the initial implementation.

**Future improvement:** Replace the regex scanner with a TypeScript AST-based scanner (using `ts-morph`) that accurately identifies all route registrations regardless of formatting.

### L-6: ADR-23 Ontology Docs Tier (Per-Tenant Runtime Docs) Is Deferred

ADR-23 describes a per-tenant runtime documentation tier where entity type definitions are rendered as full documentation pages visible in the docs site for each tenant. This design does not implement that tier. The tenant-dynamic overlay in Section 9 satisfies ADR-29 (tenant-specific OpenAPI spec) but does not provide human-readable per-tenant entity documentation pages.

**Status:** Explicitly deferred. A future design doc will address per-tenant runtime docs if and when the requirement is prioritized.

---

## Appendix: File Summary

This design results in the following new and modified files:

**New files:**
- `tools/openapi-gen/package.json`
- `tools/openapi-gen/tsconfig.json`
- `tools/openapi-gen/src/types.ts`
- `tools/openapi-gen/src/zod-converter.ts`
- `tools/openapi-gen/src/spec-builder.ts`
- `tools/openapi-gen/src/merger.ts`
- `tools/openapi-gen/src/cli.ts`
- `tools/openapi-gen/src/__tests__/` (test suite)
- `tools/openapi-gen/scripts/validate-coverage.mjs`
- `tools/openapi-gen/scripts/validate-typedoc.mjs`
- `tools/openapi-gen/lint/no-refine-in-meta.mjs`
- `tools/scripts/docs-merge.mjs` (root merge + copy script)
- `services/{gateway,auth,ingestion,ontology,pipeline,execution,app,logging,plugin}/src/openapi-meta.ts` (9 files)
- `packages/{sdk,app-sdk,plugin-sdk,core}/typedoc.json` (4 files)
- `packages/docs/` (entire Starlight package)
- `services/gateway/src/routes/openapi.ts` (hybrid static+dynamic OpenAPI handler)
- `docs/generated/.gitkeep`

**Modified files:**
- `turbo.json` — update `docs:generate` outputs to within-package paths; remove `docs:merge` and `docs:build` tasks (they move to root shell scripts)
- `package.json` (root) — add `docs:merge` and `docs:build` shell scripts
- `services/{all}/package.json` — add `docs:generate` scripts (output to `dist/openapi/`)
- `packages/{sdk,app-sdk,plugin-sdk,core}/package.json` — add `docs:generate` scripts (output to `dist/typedoc/`)
- `packages/cli/package.json` — update `docs:generate` to write to `dist/docs/`
- `packages/cli/src/lib/docs-generator.ts` — add Starlight frontmatter to output; add `--out` flag support
- `services/gateway/src/index.ts` — mount OpenAPI routes; pass `ontologyCache` to `createOpenApiRoutes`
- `docker/docker-compose.yml` — mount `docs/generated/openapi/` into gateway container
- `.github/workflows/` — add docs drift check CI job
