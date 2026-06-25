import { createMiddleware } from "hono/factory";
import { createPublicKey } from "crypto";
import type { KeyLike } from "jose";
import type { Redis } from "ioredis";
import type { UserContext } from "../types.js";
import {
  BearerTokenExtractor,
  CookieTokenExtractor,
  ApiKeyExtractor,
  createCredentialChain,
  type CredentialExtractor,
} from "./credential-extractor.js";
import { createJwtValidator } from "./jwt-validator.js";

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
  /**
   * Additional credential extractors prepended before the built-in chain.
   * Plugins use this to inject custom auth schemes (e.g. SAML assertions, mTLS).
   */
  credentialExtractors?: CredentialExtractor[];
}

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

  const jwtValidator = createJwtValidator({
    secretBytes,
    edDsaPublicKey,
    redis: config.redis,
    issuer: config.issuer,
    audience: config.audience,
  });

  const credentialChain = createCredentialChain(
    ...(config.credentialExtractors ?? []),
    new BearerTokenExtractor(),
    new CookieTokenExtractor(),
    new ApiKeyExtractor(),
  );

  return createMiddleware(async (c, next) => {
    const path = new URL(c.req.url).pathname;

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

    const credential = credentialChain.extract(c);

    if (!credential) {
      return c.json(
        { error: { code: "UNAUTHORIZED", message: "Authentication required.", requestId } },
        401
      );
    }

    if (credential.type === "jwt") {
      const result = await jwtValidator.validate(credential.token);
      if (!result.valid) {
        return c.json(
          { error: { code: "UNAUTHORIZED", message: result.message, requestId } },
          401
        );
      }
      c.set("user", result.user);
      await next();
      return;
    }

    if (credential.type === "apiKey") {
      const user = await config.validateApiKey(credential.key);
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
  });
}
