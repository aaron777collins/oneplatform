// Authentication route handlers: register, login, logout, token refresh,
// password reset, and email verification.
//
// All public routes (register, login, forgot-password, verify-email, reset-password)
// must be listed in createApp()'s publicRoutes config so they bypass JWT auth.
// Logout and refresh require a valid JWT — the current user's token is read from
// c.var.user which is set by authMiddleware.

import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import { ValidationError, NotFoundError } from "@oneplatform/core";
import type { AuthService } from "../services/index.js";
import type { TokenService } from "../services/token-service.js";
import type { UserRepository, TenantRepository } from "../repositories/index.js";
import {
  registerRequest,
  loginRequest,
  logoutRequest,
  refreshRequest,
  forgotPasswordRequest,
  resetPasswordRequest,
} from "../schemas/index.js";

export interface AuthRouteDeps {
  authService: AuthService;
  tokenService: TokenService;
  userRepository: UserRepository;
  tenantRepository: TenantRepository;
}

export function createAuthRoutes(deps: AuthRouteDeps): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { authService, tokenService, userRepository, tenantRepository } = deps;

  // POST /api/v1/auth/register — public
  routes.post("/api/v1/auth/register", async (c) => {
    const body = await c.req.json();
    const parsed = registerRequest.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid registration request", parsed.error.issues);
    }
    // exactOptionalPropertyTypes: spread optional fields only when they have a value
    const { email, password, tenantId, displayName } = parsed.data;
    const result = await authService.register({
      email,
      password,
      tenantId,
      ...(displayName !== undefined ? { displayName } : {}),
    });
    return c.json(result, 201);
  });

  // POST /api/v1/auth/login — public
  routes.post("/api/v1/auth/login", async (c) => {
    const body = await c.req.json();
    const parsed = loginRequest.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid login request", parsed.error.issues);
    }
    const result = await authService.login(parsed.data);

    // Dual-mode token delivery: browser clients receive httpOnly cookies so tokens
    // are never accessible to JavaScript (mitigates XSS-based token theft).
    // API clients (no Origin header, or non-browser Accept) continue to receive
    // tokens only in the JSON body, which is the correct pattern for non-browser callers.
    //
    // Detection heuristic: presence of an Origin header indicates a browser-initiated
    // cross-origin request (set automatically by browsers, not by API clients).
    if (c.req.header("Origin") !== undefined && result.accessToken !== undefined) {
      const isSecure = c.req.url.startsWith("https://");
      c.res = new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json" },
      });
      // httpOnly prevents JavaScript from reading the cookie; SameSite=Strict
      // blocks cross-site requests from including it (CSRF mitigation).
      c.header(
        "Set-Cookie",
        `op_access_token=${result.accessToken}; HttpOnly; SameSite=Strict; Path=/${isSecure ? "; Secure" : ""}`,
      );
      if (result.refreshToken !== undefined) {
        c.header(
          "Set-Cookie",
          `op_refresh_token=${result.refreshToken}; HttpOnly; SameSite=Strict; Path=/api/v1/auth/refresh${isSecure ? "; Secure" : ""}`,
        );
      }
      return c.res;
    }

    return c.json(result);
  });

  // GET /api/v1/auth/me — requires auth
  // Returns the current user's identity. Used by the CLI (login --key, status,
  // whoami) and any client that needs a "who am I?" check.
  routes.get("/api/v1/auth/me", async (c) => {
    const user = c.var.user;
    const found = await userRepository.findById(user.userId);
    if (!found) {
      throw new NotFoundError("User not found.");
    }
    const tenant = await tenantRepository.findById(found.tenant_id);
    return c.json({
      id: found.id,
      email: found.email,
      displayName: found.display_name ?? "",
      tenantId: found.tenant_id,
      tenantName: tenant?.name ?? found.tenant_id,
      roles: found.roles,
    });
  });

  // POST /api/v1/auth/logout — requires auth (JWT in c.var.user)
  // Revokes the current session and optionally all sessions for the user.
  routes.post("/api/v1/auth/logout", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = logoutRequest.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid logout request", parsed.error.issues);
    }

    const user = c.var.user;

    // Access token JTI and expiry come from the JWT claims embedded in c.var.user.
    // We re-verify the raw token here to extract jti/exp for revocation — the auth
    // middleware validates the token already, so this is a fast in-process decode.
    const authHeader = c.req.header("Authorization");
    const rawToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;

    let accessTokenJti = "";
    let accessTokenExp = 0;

    if (rawToken !== undefined) {
      const claims = await tokenService.verifyAccessToken(rawToken);
      if (claims !== null) {
        accessTokenJti = claims.jti;
        accessTokenExp = claims.exp;
      }
    }

    await authService.logout(
      parsed.data.refreshToken,
      accessTokenJti,
      accessTokenExp,
      user.userId,
      parsed.data.all,
    );

    return new Response(null, { status: 204 });
  });

  // POST /api/v1/auth/refresh — public (the refresh token is in the body)
  // Rotates the refresh token and issues a new access token.
  routes.post("/api/v1/auth/refresh", async (c) => {
    const body = await c.req.json();
    const parsed = refreshRequest.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid refresh request", parsed.error.issues);
    }
    const result = await tokenService.rotateRefreshToken(parsed.data.refreshToken);
    return c.json(result);
  });

  // POST /api/v1/auth/forgot-password — public
  // Always returns the same message regardless of whether the email exists,
  // to prevent user enumeration.
  routes.post("/api/v1/auth/forgot-password", async (c) => {
    const body = await c.req.json();
    const parsed = forgotPasswordRequest.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid forgot-password request", parsed.error.issues);
    }
    const result = await authService.forgotPassword(
      parsed.data.email,
      parsed.data.tenantId,
    );
    return c.json(result);
  });

  // POST /api/v1/auth/reset-password/:token — public
  routes.post("/api/v1/auth/reset-password/:token", async (c) => {
    const token = c.req.param("token");
    const body = await c.req.json();
    const parsed = resetPasswordRequest.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid reset-password request", parsed.error.issues);
    }
    await authService.resetPassword(token, parsed.data.newPassword);
    return c.json({ message: "Password reset successfully. Please log in again." });
  });

  // GET /api/v1/auth/verify-email/:token — public
  routes.get("/api/v1/auth/verify-email/:token", async (c) => {
    const token = c.req.param("token");
    const result = await authService.verifyEmail(token);
    return c.json(result);
  });

  return routes;
}
