import { createMiddleware } from "hono/factory";
import { jwtVerify, type JWTPayload } from "jose";
import type { Redis } from "ioredis";
import type { UserContext } from "../types.js";

// Roles that unverified users may NOT hold (spec §4 Email Verification).
// An unverified user is capped at viewer regardless of their token claims.
const ELEVATED_ROLES = new Set([
  "platform-admin", "tenant-admin", "developer", "editor",
]);

interface JwtClaims extends JWTPayload {
  sub: string;
  tid: string;
  roles: string[];
  scopes: string[];
  unverified?: boolean;
}

export interface AuthMiddlewareConfig {
  jwtSecret: string;
  redis: Redis;
  // validateApiKey looks up the API key in the auth service's database.
  // Returns UserContext if valid, null if not found or revoked.
  validateApiKey: (key: string) => Promise<UserContext | null>;
  // Routes that bypass auth entirely (e.g. /healthz, /readyz, /api/v1/auth/*)
  publicRoutes?: string[];
}

// authMiddleware is the primary user-facing authentication layer.
// It runs after requestId and cors, before serviceAuth (spec §5 middleware stack).
export function authMiddleware(config: AuthMiddlewareConfig) {
  const secretBytes = new TextEncoder().encode(config.jwtSecret);
  const publicRouteSet = new Set(config.publicRoutes ?? []);

  return createMiddleware(async (c, next) => {
    const path = new URL(c.req.url).pathname;

    // Skip auth entirely for explicitly public routes (healthz, bootstrap, etc.)
    // Internal routes are NOT automatically skipped here — Docker network isolation
    // is not a sufficient auth boundary. Each service must explicitly list its
    // internal routes in publicRoutes if they should be accessible without user auth.
    // /internal/* routes are protected by serviceAuthMiddleware (Ed25519 JWT) which
    // runs as the next middleware layer in createApp(). They still pass through here,
    // but serviceAuthMiddleware will enforce the service token before any handler runs.
    if (publicRouteSet.has(path)) {
      await next();
      return;
    }

    const requestId: string = c.var["requestId"] ?? "";

    // Try Bearer JWT first
    const authHeader = c.req.header("Authorization");
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      let claims: JwtClaims;

      try {
        const { payload } = await jwtVerify(token, secretBytes, { algorithms: ["HS256"] });
        claims = payload as JwtClaims;
      } catch {
        return c.json(
          { error: { code: "UNAUTHORIZED", message: "Invalid or expired token.", requestId } },
          401
        );
      }

      // Spec §4: all access tokens MUST carry jti. Reject tokens without jti
      // to prevent irrevocable token bypass via the revocation blocklist.
      if (!claims.jti) {
        return c.json(
          { error: { code: "UNAUTHORIZED", message: "Token missing required jti claim.", requestId } },
          401
        );
      }

      // Check Redis revocation blocklist — every request, O(1) (spec §4 JWT Strategy)
      const revoked = await config.redis.exists(`revocation:${claims.jti}`);
      if (revoked) {
        return c.json(
          { error: { code: "UNAUTHORIZED", message: "Token has been revoked.", requestId } },
          401
        );
      }

      // Unverified users: downgrade to viewer-only, preserve emailVerified=false flag
      // so downstream code can prompt them to verify (spec §4 Email Verification).
      let roles = claims.roles ?? [];
      let scopes = claims.scopes ?? [];
      const isUnverified = claims.unverified === true;

      if (isUnverified) {
        roles = roles.filter((r) => !ELEVATED_ROLES.has(r));
        if (!roles.includes("viewer")) roles = ["viewer"];
        scopes = ["data:read", "ontology:read", "pipelines:read", "apps:read", "logs:read"];
      }

      const user: UserContext = {
        userId: claims.sub,
        tenantId: claims.tid,
        roles,
        scopes,
        isGuest: false,
        isService: false,
        emailVerified: !isUnverified,
      };

      c.set("user", user);
      await next();
      return;
    }

    // Try X-API-Key header
    const apiKey = c.req.header("X-API-Key");
    if (apiKey) {
      const user = await config.validateApiKey(apiKey);
      if (!user) {
        return c.json(
          { error: { code: "UNAUTHORIZED", message: "Invalid API key.", requestId } },
          401
        );
      }
      c.set("user", user);
      await next();
      return;
    }

    // No auth credential provided
    return c.json(
      { error: { code: "UNAUTHORIZED", message: "Authentication required.", requestId } },
      401
    );
  });
}
