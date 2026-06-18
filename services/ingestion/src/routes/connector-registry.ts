/**
 * Connector Registry routes — browseable catalog of available connector types.
 *
 * GET  /api/v1/connector-registry              list/search connectors
 * GET  /api/v1/connector-registry/:type        connector details
 * GET  /api/v1/connector-registry/:type/versions  version history
 * POST /api/v1/connector-registry              register a new connector type (admin)
 * POST /api/v1/connector-registry/:type/install  install connector to tenant
 *
 * Auth notes:
 * - All GET endpoints require an authenticated user.
 * - POST /connector-registry (registration) requires platform-admin role.
 * - POST /connector-registry/:type/install requires a valid tenant user.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { AppVariables } from "@oneplatform/core";
import { UnauthorizedError, ValidationError, ForbiddenError } from "@oneplatform/core";
import type { ConnectorRegistryService } from "../services/connector-registry-service.js";
import { ConnectorTypeNotFoundError } from "../services/connector-registry-service.js";

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const listRegistryQuery = z.object({
  search: z.string().optional(),
  category: z
    .enum(["database", "api", "file", "streaming", "webhook", "custom"])
    .optional(),
  sortBy: z.enum(["popular", "recent", "name"]).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const registerConnectorBody = z.object({
  type: z.string().min(1).max(200),
  displayName: z.string().min(1).max(200),
  description: z.string().min(1).max(2000),
  version: z.string().min(1).max(50),
  category: z.enum(["database", "api", "file", "streaming", "webhook", "custom"]),
  author: z.string().min(1).max(200),
  icon: z.string().max(100).optional(),
  configSchema: z.record(z.unknown()),
  capabilities: z
    .object({
      supportsIncremental: z.boolean().default(false),
      supportsRealtime: z.boolean().default(false),
      supportsCdc: z.boolean().default(false),
    })
    .optional(),
  tags: z.array(z.string().min(1).max(50)).max(20).optional(),
  changelog: z.string().max(1000).optional(),
});

// ---------------------------------------------------------------------------
// Deps interface
// ---------------------------------------------------------------------------

export interface ConnectorRegistryRouteDeps {
  connectorRegistryService: ConnectorRegistryService;
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function createConnectorRegistryRoutes(
  deps: ConnectorRegistryRouteDeps,
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { connectorRegistryService } = deps;

  // GET /api/v1/connector-registry
  routes.get("/", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    const raw = c.req.query();
    const parsed = listRegistryQuery.safeParse(raw);
    if (!parsed.success) {
      throw new ValidationError("Invalid query parameters.", parsed.error.issues);
    }

    const q = parsed.data;
    const result = await connectorRegistryService.listConnectors({
      ...(q.search !== undefined ? { search: q.search } : {}),
      ...(q.category !== undefined ? { category: q.category } : {}),
      ...(q.sortBy !== undefined ? { sortBy: q.sortBy } : {}),
      ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
      limit: q.limit,
    });

    return c.json(result);
  });

  // POST /api/v1/connector-registry — admin-only connector type registration
  routes.post("/", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    // Only platform-admin may register new connector types. The roles array is
    // populated by the auth middleware from the JWT claims.
    const roles: string[] = Array.isArray(user.roles) ? (user.roles as string[]) : [];
    if (!roles.includes("platform-admin")) {
      throw new ForbiddenError("Only platform administrators may register connector types.");
    }

    const body = await c.req.json();
    const parsed = registerConnectorBody.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid request body.", parsed.error.issues);
    }

    const d = parsed.data;
    const entry = await connectorRegistryService.registerConnector({
      type: d.type,
      displayName: d.displayName,
      description: d.description,
      version: d.version,
      category: d.category,
      author: d.author,
      ...(d.icon !== undefined ? { icon: d.icon } : {}),
      configSchema: d.configSchema,
      ...(d.capabilities !== undefined ? { capabilities: d.capabilities } : {}),
      ...(d.tags !== undefined ? { tags: d.tags } : {}),
      ...(d.changelog !== undefined ? { changelog: d.changelog } : {}),
    });

    return c.json({ data: entry }, 201);
  });

  // GET /api/v1/connector-registry/:type
  routes.get("/:type", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    const connectorType = c.req.param("type");
    if (!connectorType || connectorType.trim() === "") {
      throw new ValidationError("Connector type parameter must not be empty.", []);
    }

    const entry = await connectorRegistryService.getConnectorDetails(connectorType);
    return c.json({ data: entry });
  });

  // GET /api/v1/connector-registry/:type/versions
  routes.get("/:type/versions", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    const connectorType = c.req.param("type");
    if (!connectorType || connectorType.trim() === "") {
      throw new ValidationError("Connector type parameter must not be empty.", []);
    }

    const versions = await connectorRegistryService.getConnectorVersions(connectorType);
    return c.json({ data: versions });
  });

  // POST /api/v1/connector-registry/:type/install
  // Increments the install counter and returns the entry. The actual connector
  // instance creation is a separate POST /api/v1/connectors call; this endpoint
  // is purely the "one-click install" signal for the marketplace UI.
  routes.post("/:type/install", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    const connectorType = c.req.param("type");
    if (!connectorType || connectorType.trim() === "") {
      throw new ValidationError("Connector type parameter must not be empty.", []);
    }

    // Verify the connector type exists before incrementing — throws 404 if not.
    const entry = await connectorRegistryService.getConnectorDetails(connectorType);
    await connectorRegistryService.incrementInstallCount(connectorType);

    // Return the updated entry so the UI can reflect the new install count.
    const updated = await connectorRegistryService.getConnectorDetails(connectorType);

    return c.json(
      {
        data: {
          installed: true,
          connectorType,
          displayName: entry.displayName,
          configSchema: updated.configSchema,
          installCount: updated.installCount,
        },
      },
      200,
    );
  });

  // Map ConnectorTypeNotFoundError to 404 within this router.
  // The global error handler in @oneplatform/core handles all AppError subclasses,
  // but we re-throw here with the correct type to ensure the status code is set.
  routes.onError((err, c) => {
    if (err instanceof ConnectorTypeNotFoundError) {
      return c.json(
        { error: { code: err.code, message: err.message } },
        404,
      );
    }
    // Let the global handler deal with everything else.
    throw err;
  });

  return routes;
}
