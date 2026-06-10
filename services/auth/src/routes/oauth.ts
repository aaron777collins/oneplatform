// OAuth 2.0 route handlers.
// The authorize route redirects the browser to the provider's consent screen.
// The callback route receives the authorization code and exchanges it for tokens.
//
// Both routes are listed as public (no JWT required) because the browser
// navigates to them without an auth header. The state parameter and Redis-backed
// PKCE verifier provide the security binding.

import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import { ValidationError } from "@oneplatform/core";
import type { OAuthService } from "../services/index.js";
import { oauthAuthorizeQuery, oauthCallbackQuery } from "../schemas/index.js";
import { OAuthStateInvalidError } from "../services/errors.js";

export interface OAuthRouteDeps {
  oauthService: OAuthService;
}

export function createOAuthRoutes(deps: OAuthRouteDeps): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { oauthService } = deps;

  // GET /api/v1/oauth/:provider/authorize — public
  // Redirects the browser to the provider's consent screen.
  // tenantId must be supplied as a query parameter so the callback can
  // upsert the user into the correct tenant.
  routes.get("/api/v1/oauth/:provider/authorize", async (c) => {
    const provider = c.req.param("provider");
    const rawQuery = c.req.query();
    const parsed = oauthAuthorizeQuery.safeParse(rawQuery);
    if (!parsed.success) {
      throw new ValidationError("Invalid OAuth authorize query", parsed.error.issues);
    }

    const { url } = await oauthService.getAuthorizationUrl(
      provider,
      parsed.data.tenantId,
      parsed.data.redirectUri,
    );

    return c.redirect(url, 302);
  });

  // GET /api/v1/oauth/:provider/callback — public
  // Receives the authorization code from the provider, exchanges it for tokens,
  // and returns the platform access/refresh tokens.
  // On error (user denied, state expired, etc.) the provider may set ?error=...
  routes.get("/api/v1/oauth/:provider/callback", async (c) => {
    const provider = c.req.param("provider");
    const rawQuery = c.req.query();
    const parsed = oauthCallbackQuery.safeParse(rawQuery);
    if (!parsed.success) {
      throw new ValidationError("Invalid OAuth callback query", parsed.error.issues);
    }

    // Provider-side denial (e.g. user clicked "Cancel") is an explicit error path.
    // We convert it to an OAuthStateInvalidError so the error handler returns a
    // consistent JSON response.
    if (parsed.data.error !== undefined) {
      throw new OAuthStateInvalidError(
        `OAuth provider returned an error: ${parsed.data.error}`,
      );
    }

    const result = await oauthService.handleCallback(
      provider,
      parsed.data.code,
      parsed.data.state,
    );

    return c.json(result);
  });

  return routes;
}
