import { createHmac, timingSafeEqual } from "crypto";
import { createMiddleware } from "hono/factory";
import { jwtVerify, importSPKI, type JWTPayload } from "jose";
import type { UserContext } from "../types.js";
import { isServiceCallAllowed } from "../service-rbac.js";

interface ServiceTokenClaims extends JWTPayload {
  sub: string;
  role: "service";
}

export interface ServiceAuthConfig {
  // The name of the service receiving this request (e.g. "ontology-service")
  targetService: string;
  // Map of callerServiceName → Ed25519 public key PEM (loaded from /data/service-keys/)
  servicePublicKeys: Record<string, string>;
}

// ---------------------------------------------------------------------------
// X-User-Context HMAC helpers
//
// We sign the raw header value with HMAC-SHA256 using OP_JWT_SECRET so that
// receiving services can confirm the context was set by a trusted peer, not
// forged by an external caller who somehow obtained a valid service token.
// ---------------------------------------------------------------------------

function getHmacKey(): string {
  const secret = process.env["OP_JWT_SECRET"];
  if (!secret) {
    throw new Error("OP_JWT_SECRET is required but not set.");
  }
  return secret;
}

/**
 * Produce an HMAC-SHA256 hex digest over the raw X-User-Context header value.
 * Exported so callers (BFF / gateway proxy) can attach the signature before forwarding.
 */
export function signUserContext(headerValue: string): string {
  return createHmac("sha256", getHmacKey()).update(headerValue).digest("hex");
}

/**
 * Constant-time comparison so an attacker cannot learn the expected signature
 * length or prefix through response timing.
 */
function verifyUserContextSignature(headerValue: string, receivedSig: string): boolean {
  const expected = signUserContext(headerValue);
  // Both buffers must be the same byte-length for timingSafeEqual to work.
  // If lengths differ the signature is already invalid; we still avoid early-exit
  // to prevent length oracle attacks.
  const expectedBuf = Buffer.from(expected, "hex");
  const receivedBuf = Buffer.from(receivedSig.length === expected.length ? receivedSig : expected, "hex");
  return timingSafeEqual(expectedBuf, receivedBuf) && receivedSig.length === expected.length;
}

// serviceAuthMiddleware enforces Ed25519 service tokens and the compiled RBAC matrix.
// Only used on /internal/* routes. X-User-Context is only forwarded to c.var.user
// when it arrives alongside a valid and authorized X-Service-Token — the two headers
// must be validated together (spec §4 Service-to-Service Auth, security invariant).
export function serviceAuthMiddleware(config: ServiceAuthConfig) {
  return createMiddleware(async (c, next) => {
    const requestId: string = c.var["requestId"] ?? "";
    const serviceToken = c.req.header("X-Service-Token");
    const userContextHeader = c.req.header("X-User-Context");

    const userContextSig = c.req.header("X-User-Context-Signature");

    // Reject X-User-Context sent without a service token — it would allow any
    // caller to spoof an elevated user context (spec §4 security invariant).
    if (!serviceToken && userContextHeader) {
      return c.json(
        {
          error: {
            code: "UNAUTHORIZED",
            message: "X-User-Context requires a valid X-Service-Token.",
            requestId,
          },
        },
        401
      );
    }

    if (!serviceToken) {
      return c.json(
        {
          error: {
            code: "UNAUTHORIZED",
            message: "X-Service-Token is required on internal routes.",
            requestId,
          },
        },
        401
      );
    }

    // Decode the service name from the token without verifying first,
    // so we can look up the correct public key.
    let callerService: string;
    try {
      const parts = serviceToken.split(".");
      // Non-null assertion is safe: a valid JWT always has 3 dot-separated parts.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString()) as ServiceTokenClaims;
      callerService = payload.sub;
    } catch {
      return c.json(
        { error: { code: "UNAUTHORIZED", message: "Malformed service token.", requestId } },
        401
      );
    }

    // Reject unknown callers — no public key = no access.
    // Avoid reflecting the unverified callerService value into the response to
    // prevent log injection from attacker-controlled JWT payloads.
    const publicKeyPem = config.servicePublicKeys[callerService];
    if (!publicKeyPem) {
      return c.json(
        {
          error: {
            code: "UNAUTHORIZED",
            message: "Service token issued by an unrecognized service.",
            requestId,
          },
        },
        401
      );
    }

    // Verify Ed25519 signature and expiry
    let claims: ServiceTokenClaims;
    try {
      const publicKey = await importSPKI(publicKeyPem, "EdDSA");
      const { payload } = await jwtVerify(serviceToken, publicKey, { algorithms: ["EdDSA"] });
      claims = payload as ServiceTokenClaims;
    } catch {
      return c.json(
        { error: { code: "UNAUTHORIZED", message: "Invalid or expired service token.", requestId } },
        401
      );
    }

    // RBAC check: consult the compiled matrix (spec §4, §5)
    const path = new URL(c.req.url).pathname;
    const method = c.req.method;
    if (!isServiceCallAllowed(claims.sub, config.targetService, method, path)) {
      return c.json(
        {
          error: {
            code: "FORBIDDEN",
            message: `Service '${claims.sub}' is not authorized to ${method} ${path} on ${config.targetService}.`,
            requestId,
          },
        },
        403
      );
    }

    // If X-User-Context is present and the service token is valid, forward the
    // user context. Services use this to act on behalf of a user (BFF pattern).
    // The accompanying HMAC signature proves the context was set by a trusted
    // peer that holds OP_JWT_SECRET — not forged by an external caller.
    if (userContextHeader) {
      // Reject contexts with missing or invalid HMAC signatures before parsing.
      if (!userContextSig || !verifyUserContextSignature(userContextHeader, userContextSig)) {
        return c.json(
          { error: { code: "UNAUTHORIZED", message: "X-User-Context-Signature is missing or invalid.", requestId } },
          401
        );
      }
      try {
        const userJson = Buffer.from(userContextHeader, "base64").toString("utf8");
        const userCtx = JSON.parse(userJson) as UserContext;
        c.set("user", userCtx);
      } catch {
        return c.json(
          { error: { code: "UNAUTHORIZED", message: "Malformed X-User-Context.", requestId } },
          401
        );
      }
    } else {
      // No user context: mark as a direct service-to-service call
      const serviceUser: UserContext = {
        userId: claims.sub,
        tenantId: "",
        roles: ["service"],
        scopes: ["admin"],
        isGuest: false,
        isService: true,
        emailVerified: true,
      };
      c.set("user", serviceUser);
    }

    await next();
  });
}
