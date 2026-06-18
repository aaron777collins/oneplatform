import { createMiddleware } from "hono/factory";
import { jwtVerify, type JWTPayload } from "jose";
import { createPublicKey } from "crypto";
import type { KeyLike } from "jose";
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
  /**
   * Ed25519 public key for verifying EdDSA-signed tokens.
   * Provide as a base64-encoded SPKI PEM string (the same format written by
   * generate-jwt-keys.sh and exported via OP_JWT_PUBLIC_KEY).
   * When absent, EdDSA tokens are rejected with 401.
   */
  jwtPublicKey?: string;
  redis: Redis;
  // validateApiKey looks up the API key in the auth service's database.
  // Returns UserContext if valid, null if not found or revoked.
  validateApiKey: (key: string) => Promise<UserContext | null>;
  // Routes that bypass auth entirely (e.g. /healthz, /readyz, /api/v1/auth/*)
  publicRoutes?: string[];
}

/**
 * Primary user-facing authentication middleware.
 *
 * Accepts either a `Bearer` JWT or an `X-API-Key` header. Sets `c.var.user`
 * to the resolved {@link UserContext} on success. Bypasses auth for routes
 * listed in `config.publicRoutes`.
 *
 * Supports both HS256 (symmetric) and EdDSA (Ed25519 asymmetric) tokens.
 * The algorithm is read from the token header; the appropriate key is selected
 * automatically. EdDSA verification requires `config.jwtPublicKey` to be set.
 *
 * Runs after `requestId` and `cors`, before `serviceAuth` (spec §5).
 * Wired automatically by {@link createApp}.
 */
export function authMiddleware(config: AuthMiddlewareConfig) {
  const secretBytes = new TextEncoder().encode(config.jwtSecret);
  const exactPublicRoutes = new Set<string>();
  const prefixPublicRoutes: string[] = [];

  // Pre-parse the Ed25519 public key once at middleware-creation time so we
  // pay the PEM-parse cost on startup, not on every request.
  let edDsaPublicKey: KeyLike | null = null;
  if (config.jwtPublicKey) {
    try {
      const pem = Buffer.from(config.jwtPublicKey, "base64").toString("utf8");
      edDsaPublicKey = createPublicKey(pem) as unknown as KeyLike;
    } catch (err) {
      // Fail loudly at startup if the key is malformed — a silent failure would
      // allow all EdDSA tokens through without verification.
      throw new Error(
        `authMiddleware: failed to parse jwtPublicKey: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  for (const route of config.publicRoutes ?? []) {
    const normalized = route.endsWith("/") && route.length > 1
      ? route.slice(0, -1)
      : route;
    if (normalized.includes(":")) {
      // Strip the trailing `/:paramName` segment(s) to get the prefix.
      const prefix = normalized.replace(/\/:[^/]+/g, "");
      prefixPublicRoutes.push(prefix);
    } else {
      exactPublicRoutes.add(normalized);
    }
  }

  function isPublicRoute(rawPath: string): boolean {
    const path = rawPath.endsWith("/") && rawPath.length > 1
      ? rawPath.slice(0, -1)
      : rawPath;
    if (exactPublicRoutes.has(path)) return true;
    for (const prefix of prefixPublicRoutes) {
      if (path === prefix || path.startsWith(prefix + "/")) return true;
    }
    return false;
  }

  /**
   * Reads the `alg` field from the JWT header without verifying the signature.
   * Used to pick the correct verification key before calling jwtVerify.
   * Returns "HS256" as the default when the header cannot be decoded or has
   * an unrecognised algorithm — the downstream jwtVerify call will reject it.
   */
  function readTokenAlgorithm(token: string): "HS256" | "EdDSA" {
    try {
      const headerPart = token.split(".")[0];
      if (!headerPart) return "HS256";
      const header = JSON.parse(
        Buffer.from(headerPart, "base64url").toString("utf8")
      ) as { alg?: string };
      return header.alg === "EdDSA" ? "EdDSA" : "HS256";
    } catch {
      return "HS256";
    }
  }

  return createMiddleware(async (c, next) => {
    const path = new URL(c.req.url).pathname;

    // Skip auth entirely for explicitly public routes (healthz, bootstrap, etc.)
    // Internal routes are NOT automatically skipped here — Docker network isolation
    // is not a sufficient auth boundary. Each service must explicitly list its
    // internal routes in publicRoutes if they should be accessible without user auth.
    // /internal/* routes are protected by serviceAuthMiddleware (Ed25519 JWT) which
    // runs as the next middleware layer in createApp(). They still pass through here,
    // but serviceAuthMiddleware will enforce the service token before any handler runs.
    if (isPublicRoute(path)) {
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
        const alg = readTokenAlgorithm(token);
        if (alg === "EdDSA") {
          // EdDSA requires the public key to be configured — reject loudly if
          // it was not provided rather than silently falling back to HS256.
          if (!edDsaPublicKey) {
            return c.json(
              {
                error: {
                  code: "UNAUTHORIZED",
                  message: "EdDSA token received but no public key is configured.",
                  requestId,
                },
              },
              401
            );
          }
          const { payload } = await jwtVerify(token, edDsaPublicKey, { algorithms: ["EdDSA"] });
          claims = payload as JwtClaims;
        } else {
          const { payload } = await jwtVerify(token, secretBytes, { algorithms: ["HS256"] });
          claims = payload as JwtClaims;
        }
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
      // Two blocklist levels: per-token (logout) and per-user (deactivation/password reset).
      const [tokenRevoked, userRevoked] = await Promise.all([
        config.redis.exists(`revocation:${claims.jti}`),
        config.redis.exists(`revocation:user:${claims.sub}`),
      ]);
      if (tokenRevoked || userRevoked) {
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
