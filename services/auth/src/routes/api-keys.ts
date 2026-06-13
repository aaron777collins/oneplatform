// API key management route handlers.
// All routes require a valid JWT (c.var.user set by authMiddleware).
// Users can only manage their own API keys — the userId comes from the token,
// not from the request body, to prevent IDOR attacks.

import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import { ValidationError } from "@oneplatform/core";
import type { ApiKeyService } from "../services/index.js";
import { createApiKeyRequest } from "../schemas/index.js";

export interface ApiKeyRouteDeps {
  apiKeyService: ApiKeyService;
}

export function createApiKeyRoutes(deps: ApiKeyRouteDeps): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { apiKeyService } = deps;

  // POST /api/v1/api-keys — create a new API key for the authenticated user
  routes.post("/api/v1/api-keys", async (c) => {
    const body = await c.req.json();
    const parsed = createApiKeyRequest.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid API key creation request", parsed.error.issues);
    }

    const user = c.var.user;

    // exactOptionalPropertyTypes: expiresAt is optional in Zod schema (string | undefined)
    // but CreateApiKeyInput uses exactOptionalPropertyTypes, so we must spread conditionally.
    const { name, scopes, expiresAt } = parsed.data;
    // Pass the caller's own scopes so the service can enforce the subset constraint.
    const { apiKey, keyRecord } = await apiKeyService.create(
      user.userId,
      user.tenantId,
      {
        name,
        scopes,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      },
      user.scopes,
    );

    return c.json(
      {
        id: keyRecord.id,
        name: keyRecord.name,
        // Full key value only returned on creation; subsequent calls return prefix only
        key: apiKey,
        keyPrefix: keyRecord.keyPrefix,
        scopes: keyRecord.scopes,
        expiresAt: keyRecord.expiresAt?.toISOString() ?? null,
        createdAt: keyRecord.createdAt.toISOString(),
      },
      201,
    );
  });

  // GET /api/v1/api-keys — list the authenticated user's API keys
  routes.get("/api/v1/api-keys", async (c) => {
    const user = c.var.user;
    const keys = await apiKeyService.list(user.userId);

    const data = keys.map((k) => ({
      id: k.id,
      name: k.name,
      keyPrefix: k.keyPrefix,
      scopes: k.scopes,
      expiresAt: k.expiresAt?.toISOString() ?? null,
      lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
      createdAt: k.createdAt.toISOString(),
      revokedAt: k.revokedAt?.toISOString() ?? null,
    }));

    return c.json({
      data,
      pagination: { nextCursor: null, total: data.length },
    });
  });

  // DELETE /api/v1/api-keys/:id — revoke an API key
  // The service enforces ownership; non-owners receive NotFoundError (no key detail leak).
  routes.delete("/api/v1/api-keys/:id", async (c) => {
    const id = c.req.param("id");
    const user = c.var.user;
    await apiKeyService.revoke(id, user.userId);
    return new Response(null, { status: 204 });
  });

  // POST /api/v1/api-keys/:id/rotate — atomically revoke old key and issue a new one
  routes.post("/api/v1/api-keys/:id/rotate", async (c) => {
    const id = c.req.param("id");
    const user = c.var.user;
    const { apiKey, keyRecord } = await apiKeyService.rotate(id, user.userId);

    return c.json({
      id: keyRecord.id,
      key: apiKey,
      keyPrefix: keyRecord.keyPrefix,
      scopes: keyRecord.scopes,
      createdAt: keyRecord.createdAt.toISOString(),
    });
  });

  return routes;
}
