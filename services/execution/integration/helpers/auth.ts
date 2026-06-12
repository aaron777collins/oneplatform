import { SignJWT } from "jose";
import { randomUUID } from "node:crypto";

// The execution service verifies HS256 JWTs using OP_JWT_SECRET.
// Tokens must carry jti (required by the auth middleware revocation check),
// tid (tenant ID), sub, roles, and scopes.
const JWT_SECRET = process.env["OP_JWT_SECRET"] ?? "test-jwt-secret-for-integration-tests-32c";
const secretBytes = new TextEncoder().encode(JWT_SECRET);

export interface TestTokenOptions {
  userId?: string;
  roles?: string[];
  scopes?: string[];
}

/**
 * Creates a signed HS256 JWT that the execution service's auth middleware
 * will accept. Each call generates a unique jti to avoid revocation conflicts.
 */
export async function createTestToken(
  tenantId: string,
  opts: TestTokenOptions = {},
): Promise<string> {
  const {
    userId = randomUUID(),
    roles = ["tenant-admin"],
    // execution:run and execution:read are the scopes checked in exec routes
    scopes = ["execution:run", "execution:read", "*"],
  } = opts;

  return new SignJWT({
    sub: userId,
    tid: tenantId,
    roles,
    scopes,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .setJti(randomUUID())
    .sign(secretBytes);
}
