import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";

const JWT_SECRET = process.env["OP_JWT_SECRET"] ?? "test-jwt-secret-for-integration-tests-32c";

/**
 * Creates a valid signed JWT for use in Level 1 test requests.
 *
 * Why jti is required: the auth middleware checks every token against the Redis
 * revocation blocklist using `revocation:{jti}`. Tokens without jti are rejected
 * with 401 before any route handler runs.
 *
 * Why tid (not tenantId): the JWT claim name is `tid` per the JwtClaims interface
 * in packages/core/src/middleware/auth.ts — the UserContext.tenantId is populated
 * from claims.tid, not claims.tenantId.
 */
export async function createTestToken(tenantId: string, userId?: string): Promise<string> {
  const secretBytes = new TextEncoder().encode(JWT_SECRET);

  return new SignJWT({
    tid: tenantId,
    roles: ["admin"],
    scopes: ["*"],
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId ?? randomUUID())
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(secretBytes);
}

/**
 * Returns Authorization header value for a test request.
 */
export async function authHeader(tenantId: string, userId?: string): Promise<string> {
  const token = await createTestToken(tenantId, userId);
  return `Bearer ${token}`;
}
