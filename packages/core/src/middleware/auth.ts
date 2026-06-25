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
  email?: string;
  displayName?: string;
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
  /**
   * Expected JWT issuer (`iss` claim). When provided, jose rejects tokens
   * whose `iss` does not match — preventing cross-issuer token replay.
   * Omit to skip issuer validation (backward-compatible default).
   */
  issuer?: string;
  /**
   * Expected JWT audience (`aud` claim). When provided, jose rejects tokens
   * whose `aud` does not include this value — preventing cross-audience token replay.
   * Omit to skip audience validation (backward-compatible default).
   */
  audience?: string;
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
  const wildcardPublicRoutes: RegExp[] = [];
  // prefixPublicRoutes was removed — routes use exact or wildcard (glob/param) buckets.
  // Add a "prefix/*" wildcard entry to publicRoutes instead.

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
    if (normalized.includes("*")) {
      // Convert glob wildcard to a regex: escape special chars, then replace *
      // with .* so /api/v1/auth/* matches any path under that prefix.
      const escaped = normalized.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
      wildcardPublicRoutes.push(new RegExp("^" + escaped.replace(/\*/g, ".*") + "$"));
    } else if (normalized.includes(":")) {
      // Convert each :param segment into [^/]+ so mid-path and trailing params
      // match any concrete segment without producing nonsensical prefixes.
      const regexStr = normalized
        .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
        .split("/")
        .map((seg) => (seg.startsWith(":") ? "[^/]+" : seg))
        .join("/");
      wildcardPublicRoutes.push(new RegExp("^" + regexStr + "$"));
    } else {
      exactPublicRoutes.add(normalized);
    }
  }

  function isPublicRoute(rawPath: string): boolean {
    const path = rawPath.endsWith("/") && rawPath.length > 1
      ? rawPath.slice(0, -1)
      : rawPath;
    if (exactPublicRoutes.has(path)) return true;
    for (const pattern of wildcardPublicRoutes) {
      if (pattern.test(path)) return true;
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
    if (isPublicRoute(path)) {
      await next();
      return;
    }

    // Pass through /internal/* routes without demanding a Bearer token or API key.
    // These routes are protected by serviceAuthMiddleware (Ed25519 JWT + RBAC) which
    // runs immediately after this middleware in createApp(). Docker network isolation
    // alone is not a sufficient auth boundary, so serviceAuthMiddleware enforces
    // cryptographic proof of identity before any handler runs. Requiring a Bearer
    // token here in addition to the service token would break all inter-service
    // calls, because background workers and cron jobs do not hold user JWTs.
    if (path === "/internal" || path.startsWith("/internal/")) {
      await next();
      return;
    }

    const requestId: string = c.var["requestId"] ?? "";

    // Extract JWT from Bearer header or op_access_token cookie.
    // Bearer takes precedence; cookie is the browser-session path.
    const authHeader = c.req.header("Authorization");
    let jwtToken: string | undefined;

    if (authHeader?.startsWith("Bearer ")) {
      jwtToken = authHeader.slice(7);
    } else {
      const cookieHeader = c.req.header("cookie") ?? "";
      const cookieMatch = cookieHeader.match(/(?:^|;\s*)op_access_token=([^;]+)/);
      if (cookieMatch?.[1]) {
        jwtToken = cookieMatch[1];
      }
    }

    if (jwtToken) {
      let claims: JwtClaims;

      try {
        const alg = readTokenAlgorithm(jwtToken);
        if (alg === "EdDSA") {
          if (!edDsaPublicKey) {
            return c.json(
              { error: { code: "UNAUTHORIZED", message: "EdDSA token received but no public key is configured.", requestId } },
              401
            );
          }
          const { payload } = await jwtVerify(jwtToken, edDsaPublicKey, {
            algorithms: ["EdDSA"],
            ...(config.issuer !== undefined ? { issuer: config.issuer } : {}),
            ...(config.audience !== undefined ? { audience: config.audience } : {}),
          });
          claims = payload as JwtClaims;
        } else {
          const { payload } = await jwtVerify(jwtToken, secretBytes, {
            algorithms: ["HS256"],
            ...(config.issuer !== undefined ? { issuer: config.issuer } : {}),
            ...(config.audience !== undefined ? { audience: config.audience } : {}),
          });
          claims = payload as JwtClaims;
        }
      } catch {
        return c.json(
          { error: { code: "UNAUTHORIZED", message: "Invalid or expired token.", requestId } },
          401
        );
      }

      if (!claims.jti) {
        return c.json(
          { error: { code: "UNAUTHORIZED", message: "Token missing required jti claim.", requestId } },
          401
        );
      }

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
        ...(claims.email ? { email: claims.email } : {}),
        ...(claims.displayName ? { displayName: claims.displayName } : {}),
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
