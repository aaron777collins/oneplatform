// Authentication route handlers: register, login, logout, token refresh,
// password reset, and email verification.
//
// All public routes (register, login, forgot-password, verify-email, reset-password)
// must be listed in createApp()'s publicRoutes config so they bypass JWT auth.
// Logout and refresh require a valid JWT — the current user's token is read from
// c.var.user which is set by authMiddleware.

import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import { ValidationError, NotFoundError, RateLimitError } from "@oneplatform/core";
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
  changePasswordRequest,
} from "../schemas/index.js";

/**
 * Determine whether the request reached the platform over HTTPS so the cookie
 * `Secure` attribute is set correctly. The auth service runs on plain HTTP
 * behind a TLS-terminating proxy (Caddy/gateway), so `c.req.url` is always
 * http:// — we must consult `x-forwarded-proto` (injected by the proxy from the
 * real client connection) as well, otherwise `Secure` is never set in
 * production and tokens can leak over a downgraded connection.
 */
export function isSecureRequest(c: { req: { url: string; header: (name: string) => string | undefined } }): boolean {
  if (c.req.url.startsWith("https://")) return true;
  const forwardedProto = c.req.header("x-forwarded-proto");
  if (forwardedProto === undefined) return false;
  // May be a comma-separated list (proto chain); the leftmost is the client-facing proto.
  return forwardedProto.split(",")[0]?.trim().toLowerCase() === "https";
}

export interface AuthRouteDeps {
  authService: AuthService;
  tokenService: TokenService;
  userRepository: UserRepository;
  tenantRepository: TenantRepository;
  redis?: import("ioredis").Redis;
}

export function createAuthRoutes(deps: AuthRouteDeps): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { authService, tokenService, userRepository, tenantRepository, redis } = deps;

  // -------------------------------------------------------------------------
  // In-memory rate limiter for the refresh endpoint (V5-026).
  // 10 requests per 60-second window per IP. Uses Redis when available
  // (multi-instance safe); falls back to in-memory for single-instance
  // deployments and tests.
  // -------------------------------------------------------------------------

  const REFRESH_RATE_LIMIT = 10;
  const REFRESH_RATE_WINDOW_SEC = 60;
  const REFRESH_RATE_WINDOW_MS = REFRESH_RATE_WINDOW_SEC * 1_000;
  const refreshAttempts = new Map<string, { count: number; windowStartMs: number }>();

  // Periodic cleanup prevents the in-memory fallback Map from growing
  // unboundedly when many distinct IPs make requests and never return.
  // Entries whose window has fully elapsed are safe to remove.
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of refreshAttempts) {
      if (now - entry.windowStartMs >= REFRESH_RATE_WINDOW_MS) {
        refreshAttempts.delete(ip);
      }
    }
  }, REFRESH_RATE_WINDOW_MS);
  if (typeof cleanupTimer === "object" && "unref" in cleanupTimer) {
    (cleanupTimer as { unref(): void }).unref();
  }

  async function checkRefreshRateLimit(ip: string): Promise<void> {
    const key = `auth:refresh-rate:${ip}`;
    if (redis) {
      // Atomic Lua script makes INCR + EXPIRE a single operation, eliminating
      // the TOCTOU window where a crash between the two calls would leave the
      // key without a TTL and permanently block that IP.
      const count = await redis.eval(
        `local count = redis.call("INCR", KEYS[1])
if count == 1 then
  redis.call("EXPIRE", KEYS[1], ARGV[1])
end
return count`,
        1,
        key,
        REFRESH_RATE_WINDOW_SEC,
      ) as number;
      if (count > REFRESH_RATE_LIMIT) {
        const ttl = await redis.ttl(key);
        throw new RateLimitError(Math.max(ttl, 1));
      }
      return;
    }
    // In-memory fallback
    const now = Date.now();
    const entry = refreshAttempts.get(ip);
    if (!entry || now - entry.windowStartMs >= REFRESH_RATE_WINDOW_SEC * 1_000) {
      refreshAttempts.set(ip, { count: 1, windowStartMs: now });
      return;
    }
    entry.count++;
    if (entry.count > REFRESH_RATE_LIMIT) {
      const retryAfter = Math.ceil(
        (REFRESH_RATE_WINDOW_SEC * 1_000 - (now - entry.windowStartMs)) / 1_000,
      );
      throw new RateLimitError(Math.max(retryAfter, 1));
    }
  }

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

    // Resolve the tenant when the client omits tenantId (single-tenant
    // deployments). A login carries one specific user identity, so we can only
    // auto-resolve when the deployment is unambiguously single-tenant.
    let tenantId = parsed.data.tenantId;
    if (tenantId === undefined) {
      const { tenants, total } = await tenantRepository.list({ limit: 2 });
      if (total !== 1 || tenants[0] === undefined) {
        throw new ValidationError(
          "tenantId is required when multiple tenants exist.",
          [],
        );
      }
      tenantId = tenants[0].id;
    }

    const result = await authService.login({
      email: parsed.data.email,
      password: parsed.data.password,
      tenantId,
    });

    if (c.req.header("Origin") !== undefined && result.accessToken !== undefined) {
      const isSecure = isSecureRequest(c);
      const secureSuffix = isSecure ? "; Secure" : "";
      c.header(
        "Set-Cookie",
        `op_access_token=${result.accessToken}; HttpOnly; SameSite=Lax; Path=/${secureSuffix}`,
      );
      if (result.refreshToken !== undefined) {
        c.header(
          "Set-Cookie",
          `op_refresh_token=${result.refreshToken}; HttpOnly; SameSite=Lax; Path=/api/v1/auth/refresh${secureSuffix}`,
          { append: true },
        );
      }
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
      scopes: [],
      isGuest: false,
      emailVerified: found.email_verified ?? false,
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
    //
    // Cookie-auth sessions (browser) do NOT send a Bearer header; fall back to
    // the op_access_token HttpOnly cookie so those tokens also reach the blocklist.
    const authHeader = c.req.header("Authorization");
    const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;

    const cookieHeader = c.req.header("cookie") ?? "";
    const accessCookieMatch = cookieHeader.match(/(?:^|;\s*)op_access_token=([^;]+)/);
    const cookieAccessToken = accessCookieMatch?.[1] ?? undefined;

    const rawToken = bearerToken ?? cookieAccessToken;

    let accessTokenJti = "";
    let accessTokenExp = 0;

    if (rawToken !== undefined) {
      const claims = await tokenService.verifyAccessToken(rawToken);
      if (claims !== null) {
        accessTokenJti = claims.jti;
        accessTokenExp = claims.exp;
      }
    }

    if (!rawToken && !parsed.data.refreshToken && !parsed.data.all) {
      return c.json(
        {
          error: {
            code: "BAD_REQUEST",
            message: "No Authorization header, access-token cookie, or refresh token provided. Nothing to revoke.",
          },
        },
        400,
      );
    }

    await authService.logout(
      parsed.data.refreshToken,
      accessTokenJti,
      accessTokenExp,
      user.userId,
      parsed.data.all,
    );

    // Expire both cookies so browser sessions are fully cleared on logout.
    // Max-Age=0 is the standard way to instruct the browser to delete a cookie
    // immediately, regardless of the original expiry or Secure flag.
    const isSecure = isSecureRequest(c);
    const secureSuffix = isSecure ? "; Secure" : "";
    const logoutResponse = new Response(null, { status: 204 });
    logoutResponse.headers.append(
      "Set-Cookie",
      `op_access_token=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secureSuffix}`,
    );
    logoutResponse.headers.append(
      "Set-Cookie",
      `op_refresh_token=; HttpOnly; SameSite=Lax; Path=/api/v1/auth/refresh; Max-Age=0${secureSuffix}`,
    );
    return logoutResponse;
  });

  // POST /api/v1/auth/refresh — public (the refresh token is in the body or cookie)
  // Rotates the refresh token and issues a new access token.
  // Rate limited to 10 req/min per IP (V5-026).
  //
  // Dual-mode token retrieval: browser clients send the refresh token as an
  // HttpOnly cookie (op_refresh_token) set during login. API clients send it
  // in the JSON body. The cookie takes precedence when both are present, but
  // in practice only one will be set.
  routes.post("/api/v1/auth/refresh", async (c) => {
    // Trust only gateway-injected headers. x-forwarded-for is client-controllable
    // on the auth service's internal interface, so including it as a fallback
    // lets an attacker rotate apparent IP for unlimited refresh attempts.
    const ip = c.req.header("cf-connecting-ip")
      ?? c.req.header("x-real-ip")
      ?? "unknown";
    await checkRefreshRateLimit(ip);

    // Try to extract the refresh token from the HttpOnly cookie first (browser
    // clients). The cookie is set with Path=/api/v1/auth/refresh so it is only
    // sent to this endpoint. Falls back to the JSON body for API clients.
    const cookieHeader = c.req.header("cookie") ?? "";
    const cookieMatch = cookieHeader.match(/(?:^|;\s*)op_refresh_token=([^;]+)/);
    const cookieRefreshToken = cookieMatch?.[1] ?? null;

    let refreshToken: string | undefined;

    if (cookieRefreshToken) {
      refreshToken = cookieRefreshToken;
    } else {
      const body = await c.req.json().catch(() => ({}));
      const parsed = refreshRequest.safeParse(body);
      if (!parsed.success) {
        throw new ValidationError("Invalid refresh request — provide refreshToken in the JSON body or as the op_refresh_token cookie", parsed.error.issues);
      }
      refreshToken = parsed.data.refreshToken;
    }

    const result = await tokenService.rotateRefreshToken(refreshToken);

    // If the request came from a browser (Origin header present), set both the
    // new access token and refresh token as HttpOnly cookies so the browser
    // automatically sends them on subsequent requests without the frontend
    // needing to read tokens from the response body.
    if (c.req.header("Origin") !== undefined) {
      const isSecure = isSecureRequest(c);
      c.header(
        "Set-Cookie",
        `op_access_token=${result.accessToken}; HttpOnly; SameSite=Lax; Path=/${isSecure ? "; Secure" : ""}`,
      );
      c.header(
        "Set-Cookie",
        `op_refresh_token=${result.refreshToken}; HttpOnly; SameSite=Lax; Path=/api/v1/auth/refresh${isSecure ? "; Secure" : ""}`,
        { append: true },
      );
    }

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

  // POST /api/v1/auth/change-password — requires auth (V5-023)
  // Validates the caller's current password before setting the new one.
  // Revokes all sessions on success so the user must re-authenticate.
  routes.post("/api/v1/auth/change-password", async (c) => {
    const body = await c.req.json();
    const parsed = changePasswordRequest.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid change-password request", parsed.error.issues);
    }
    const user = c.var.user;
    await authService.changePassword(user.userId, parsed.data.currentPassword, parsed.data.newPassword);
    return c.json({ data: { message: "Password changed successfully." } });
  });

  // GET /api/v1/auth/verify-email/:token — public
  routes.get("/api/v1/auth/verify-email/:token", async (c) => {
    const token = c.req.param("token");
    const result = await authService.verifyEmail(token);
    return c.json(result);
  });

  return routes;
}
