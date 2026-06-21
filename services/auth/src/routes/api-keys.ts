// API key management route handlers.
// All routes require a valid JWT (c.var.user set by authMiddleware).
// Users can only manage their own API keys — the userId comes from the token,
// not from the request body, to prevent IDOR attacks.
// Admin routes (GET/DELETE /api/v1/admin/api-keys) additionally require admin scope.

import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import { ValidationError, ForbiddenError } from "@oneplatform/core";
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
  //
  // Query params:
  //   status — "active" (default), "revoked", or "all"
  //   limit  — results per page (1–200, default 50)
  //   offset — zero-based starting position (default 0)
  routes.get("/api/v1/api-keys", async (c) => {
    const user = c.var.user;

    const rawStatus = c.req.query("status") ?? "active";
    const status = (["active", "revoked", "all"] as const).includes(rawStatus as "active" | "revoked" | "all")
      ? (rawStatus as "active" | "revoked" | "all")
      : "active";

    const rawLimit = c.req.query("limit");
    const rawOffset = c.req.query("offset");
    const limit = rawLimit !== undefined ? parseInt(rawLimit, 10) : 50;
    const offset = rawOffset !== undefined ? parseInt(rawOffset, 10) : 0;

    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new ValidationError("limit must be an integer between 1 and 200", []);
    }
    if (!Number.isInteger(offset) || offset < 0) {
      throw new ValidationError("offset must be a non-negative integer", []);
    }

    const { keys, total } = await apiKeyService.list(user.userId, { status, limit, offset });

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
      pagination: { nextCursor: null, total, limit, offset },
    });
  });

  // DELETE /api/v1/api-keys/:id — revoke an API key
  // The service enforces ownership; non-owners receive NotFoundError (no key detail leak).
  routes.delete("/api/v1/api-keys/:id", async (c) => {
    const id = c.req.param("id");
    const user = c.var.user;
    await apiKeyService.revoke(id, user.userId, user.tenantId);
    return new Response(null, { status: 204 });
  });

  // POST /api/v1/api-keys/:id/rotate — atomically revoke old key and issue a new one
  routes.post("/api/v1/api-keys/:id/rotate", async (c) => {
    const id = c.req.param("id");
    const user = c.var.user;
    const { apiKey, keyRecord } = await apiKeyService.rotate(id, user.userId, user.tenantId);

    return c.json({
      id: keyRecord.id,
      key: apiKey,
      keyPrefix: keyRecord.keyPrefix,
      scopes: keyRecord.scopes,
      createdAt: keyRecord.createdAt.toISOString(),
    });
  });

  // ---------------------------------------------------------------------------
  // Admin endpoints — require admin scope. These allow platform admins to audit
  // and revoke API keys belonging to any user, which is required for compliance
  // and incident response scenarios where the key owner is unavailable.
  // ---------------------------------------------------------------------------

  // GET /api/v1/admin/api-keys — list all API keys across all users
  //
  // Response never includes the key hash or full key value — only the 8-char
  // prefix is returned so admins can correlate keys without being able to use them.
  //
  // Query params: status (active|revoked|all), limit (1-200), offset
  routes.get("/api/v1/admin/api-keys", async (c) => {
    const user = c.var.user;
    if (!user.scopes.includes("admin")) {
      throw new ForbiddenError("admin scope is required to list all API keys.");
    }

    const rawStatus = c.req.query("status") ?? "active";
    const status = (["active", "revoked", "all"] as const).includes(
      rawStatus as "active" | "revoked" | "all"
    )
      ? (rawStatus as "active" | "revoked" | "all")
      : "active";

    const rawLimit = c.req.query("limit");
    const rawOffset = c.req.query("offset");
    const limit = rawLimit !== undefined ? parseInt(rawLimit, 10) : 50;
    const offset = rawOffset !== undefined ? parseInt(rawOffset, 10) : 0;

    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new ValidationError("limit must be an integer between 1 and 200", []);
    }
    if (!Number.isInteger(offset) || offset < 0) {
      throw new ValidationError("offset must be a non-negative integer", []);
    }

    const { keys, total } = await apiKeyService.listAllKeys({ status, limit, offset });

    const data = keys.map((k) => ({
      keyId: k.id,
      // key_prefix allows identification without exposing the usable key value
      prefix: k.keyPrefix,
      userId: k.userId,
      displayName: k.displayName,
      scopes: k.scopes,
      expiresAt: k.expiresAt?.toISOString() ?? null,
      lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
      createdAt: k.createdAt.toISOString(),
      revokedAt: k.revokedAt?.toISOString() ?? null,
    }));

    return c.json({ data, pagination: { total, limit, offset } });
  });

  // DELETE /api/v1/admin/api-keys/:keyId — revoke any API key as a platform admin
  //
  // This bypasses the ownership check in the standard revoke() method.
  // The audit event records adminRevocation: true for traceability.
  routes.delete("/api/v1/admin/api-keys/:keyId", async (c) => {
    const keyId = c.req.param("keyId");
    const user = c.var.user;

    if (!user.scopes.includes("admin")) {
      throw new ForbiddenError("admin scope is required to revoke any API key.");
    }

    await apiKeyService.revokeAsAdmin(keyId, user.userId);
    return new Response(null, { status: 204 });
  });

  return routes;
}
