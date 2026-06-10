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

// serviceAuthMiddleware enforces Ed25519 service tokens and the compiled RBAC matrix.
// Only used on /internal/* routes. X-User-Context is only forwarded to c.var.user
// when it arrives alongside a valid and authorized X-Service-Token — the two headers
// must be validated together (spec §4 Service-to-Service Auth, security invariant).
export function serviceAuthMiddleware(config: ServiceAuthConfig) {
  return createMiddleware(async (c, next) => {
    const requestId: string = c.var["requestId"] ?? "";
    const serviceToken = c.req.header("X-Service-Token");
    const userContextHeader = c.req.header("X-User-Context");

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

    // Reject unknown callers — no public key = no access
    const publicKeyPem = config.servicePublicKeys[callerService];
    if (!publicKeyPem) {
      return c.json(
        {
          error: {
            code: "UNAUTHORIZED",
            message: `Unknown service: ${callerService}`,
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
    if (userContextHeader) {
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
