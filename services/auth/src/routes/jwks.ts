// JWKS endpoint — exposes the Ed25519 public key as a JSON Web Key Set.
//
// Downstream consumers (API Gateway, plugin sandboxes, third-party integrations)
// use this endpoint to retrieve the verification key without needing access to
// the shared JWT secret. This is only meaningful when OP_JWT_ALGORITHM=EdDSA;
// when HS256 is active the endpoint returns an empty key set because symmetric
// keys must never be published.
//
// The endpoint is public (no auth required) because the public key is not a
// secret — its purpose is to be widely distributed for verification.

import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import { exportPublicKeyAsJwk } from "../services/token-service.js";

export function createJwksRoutes(): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();

  // GET /api/v1/auth/.well-known/jwks.json — public
  // Returns the active signing public key in JWK Set format (RFC 7517).
  // The response is suitable for consumption by any standards-compliant JWT
  // verifier (e.g. jose, jsonwebtoken, OpenID Connect middleware).
  routes.get("/api/v1/auth/.well-known/jwks.json", async (c) => {
    const jwk = await exportPublicKeyAsJwk();

    // When EdDSA is not configured the key set is intentionally empty.
    // This makes the endpoint safe to call unconditionally — callers simply
    // get an empty set and fall back to other verification methods.
    const keys = jwk !== null ? [jwk] : [];

    // Cache for 1 hour: key rotations are infrequent and clients should
    // cache aggressively to avoid hammering the auth service on every request.
    // Stale-while-revalidate allows continued use during key rollover.
    c.header("Cache-Control", "public, max-age=3600, stale-while-revalidate=600");
    c.header("Content-Type", "application/json");

    return c.json({ keys });
  });

  return routes;
}
