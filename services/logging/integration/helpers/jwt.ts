/**
 * Minimal JWT minting helper for integration tests.
 *
 * WHY: the logging service validates Bearer JWTs using the shared OP_JWT_SECRET
 * (HS256). Rather than standing up the auth service just to obtain a token,
 * tests mint one directly using the same jose library that the auth service uses.
 * This is safe in tests because the JWT_SECRET value in .env.test is a
 * committed test-only value with no real data behind it.
 *
 * The token shape matches what the auth service issues (see token-service.ts).
 * The jti claim is required — the auth middleware rejects tokens without one.
 */

import { SignJWT } from "jose";
import { randomUUID } from "node:crypto";

export interface TestTokenOptions {
  userId?: string;
  tenantId?: string;
  roles?: string[];
  scopes?: string[];
  emailVerified?: boolean;
  expiresInSeconds?: number;
}

/**
 * Mints a short-lived HS256 JWT using the OP_JWT_SECRET from the test environment.
 * Returns the raw token string for use in Authorization: Bearer <token> headers.
 */
export async function mintTestToken(opts: TestTokenOptions = {}): Promise<string> {
  const secret = process.env["OP_JWT_SECRET"];
  if (!secret) {
    throw new Error("OP_JWT_SECRET must be set in the test environment (.env.test)");
  }

  const secretBytes = new TextEncoder().encode(secret);
  const userId = opts.userId ?? randomUUID();
  const tenantId = opts.tenantId ?? randomUUID();
  const roles = opts.roles ?? ["platform-admin"];
  const scopes = opts.scopes ?? ["admin"];
  const expiresInSeconds = opts.expiresInSeconds ?? 900;

  return new SignJWT({
    sub: userId,
    tid: tenantId,
    roles,
    scopes,
    ev: opts.emailVerified ?? true,
    unverified: false,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(`${expiresInSeconds}s`)
    .sign(secretBytes);
}
