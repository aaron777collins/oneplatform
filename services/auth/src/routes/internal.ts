// Internal service-to-service route handlers.
// All /internal/* routes are protected by serviceAuthMiddleware (Ed25519 JWT).
// These endpoints are NOT exposed through the Gateway — they are only reachable
// from within the cluster via direct service-to-service calls.
//
// Callers must present a valid X-Service-Token. The RBAC matrix in
// @oneplatform/core/service-rbac.ts governs which services may call which methods.

import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import { ValidationError, NotFoundError, serviceAuthMiddleware } from "@oneplatform/core";
import type { TokenService } from "../services/token-service.js";
import type { GuestSessionService } from "../services/index.js";
import type { OAuthClientRepository } from "../repositories/index.js";
import {
  guestSessionRequest,
  oauthClientRequest,
} from "../schemas/index.js";

export interface InternalRouteDeps {
  tokenService: TokenService;
  guestSessionService: GuestSessionService;
  oauthClientRepository: OAuthClientRepository;
  servicePublicKeys: Record<string, string>;
}

export function createInternalRoutes(deps: InternalRouteDeps): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { tokenService, guestSessionService, oauthClientRepository, servicePublicKeys } = deps;

  // All /internal/* routes require service-to-service Ed25519 JWT auth
  routes.use("*", serviceAuthMiddleware({
    servicePublicKeys,
    targetService: "auth-service",
  }));

  // POST /internal/auth/validate — token introspection
  // Changed from GET+query-param to POST+body to prevent access tokens from
  // appearing in server logs, proxy logs, and URL history.
  // Always returns 200; callers check the `valid` field rather than the HTTP status.
  routes.post("/internal/auth/validate", async (c) => {
    const body = await c.req.json();
    const token = typeof body === "object" && body !== null && "token" in body
      ? String(body["token"])
      : null;
    if (!token) {
      throw new ValidationError("Missing 'token' field in request body");
    }

    const claims = await tokenService.verifyAccessToken(token);

    if (claims === null) {
      return c.json({
        valid: false,
        reason: "TOKEN_INVALID",
      });
    }

    // sessionId is not stored in the access token JWT claims. We derive a
    // synthetic value from the jti so callers that need it get a stable reference.
    return c.json({
      valid: true,
      userId: claims.sub,
      tenantId: claims.tid,
      roles: claims.roles,
      scopes: claims.scopes,
      emailVerified: claims.ev,
      isGuest: false,
      sessionId: claims.jti,
    });
  });

  // POST /internal/auth/guest-sessions — create a guest session
  // Called by the App Service when a public app needs to track an anonymous visitor.
  routes.post("/internal/auth/guest-sessions", async (c) => {
    const body = await c.req.json();
    const parsed = guestSessionRequest.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid guest session request", parsed.error.issues);
    }

    const result = await guestSessionService.create(
      parsed.data.tenantId,
      parsed.data.appId,
      parsed.data.ipAddress,
    );

    return c.json({
      guestToken: result.guestToken,
      expiresAt: result.expiresAt.toISOString(),
    }, 201);
  });

  // POST /internal/oauth/clients — register or update an OAuth client
  // Called by the App Service when an app is deployed or its redirect URIs change.
  // The operation is idempotent — repeated calls with the same clientId update mutable fields.
  routes.post("/internal/oauth/clients", async (c) => {
    const body = await c.req.json();
    const parsed = oauthClientRequest.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid OAuth client request", parsed.error.issues);
    }

    const client = await oauthClientRepository.upsert({
      client_id: parsed.data.clientId,
      client_type: parsed.data.clientType,
      redirect_uris: parsed.data.redirectUris,
      allowed_scopes: parsed.data.allowedScopes,
      tenant_id: parsed.data.tenantId,
      ...(parsed.data.appId !== undefined ? { app_id: parsed.data.appId } : {}),
      access_mode: parsed.data.accessMode,
    });

    return c.json(
      {
        clientId: client.client_id,
        clientType: client.client_type,
        redirectUris: client.redirect_uris,
        createdAt: client.created_at.toISOString(),
        updatedAt: client.updated_at.toISOString(),
      },
      201,
    );
  });

  // DELETE /internal/oauth/clients/:clientId — remove an OAuth client registration
  // Called by the App Service when an app is deleted.
  routes.delete("/internal/oauth/clients/:clientId", async (c) => {
    const clientId = c.req.param("clientId");

    const existing = await oauthClientRepository.findByClientId(clientId);
    if (!existing) {
      throw new NotFoundError(`OAuth client ${clientId} not found.`);
    }

    // OAuthClientRepository does not expose a delete method — the App Service
    // archive flow soft-deletes apps by revoking their redirect URIs. Clearing
    // redirect URIs prevents new OAuth flows without removing audit records.
    // TODO(OP-XXX): Add a hard-delete or deactivation column to auth.oauth_clients.
    await oauthClientRepository.upsert({
      client_id: clientId,
      redirect_uris: [],
      allowed_scopes: [],
    });

    return new Response(null, { status: 204 });
  });

  return routes;
}
