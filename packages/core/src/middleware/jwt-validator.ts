import { jwtVerify, type JWTPayload } from "jose";
import type { Redis } from "ioredis";
import type { KeyLike } from "jose";
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

export interface JwtValidatorConfig {
  secretBytes: Uint8Array;
  edDsaPublicKey: KeyLike | null;
  redis: Redis;
  issuer?: string | undefined;
  audience?: string | undefined;
}

export type JwtValidationResult =
  | { valid: true; user: UserContext }
  | { valid: false; message: string };

// Reads `alg` from the JWT header without verifying the signature.
// Returns "HS256" as the default so the downstream jwtVerify call rejects unrecognised algorithms.
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

export function createJwtValidator(config: JwtValidatorConfig): {
  validate(token: string): Promise<JwtValidationResult>;
} {
  return {
    async validate(token: string): Promise<JwtValidationResult> {
      let claims: JwtClaims;

      try {
        const alg = readTokenAlgorithm(token);
        if (alg === "EdDSA") {
          if (!config.edDsaPublicKey) {
            return { valid: false, message: "EdDSA token received but no public key is configured." };
          }
          const { payload } = await jwtVerify(token, config.edDsaPublicKey, {
            algorithms: ["EdDSA"],
            ...(config.issuer !== undefined ? { issuer: config.issuer } : {}),
            ...(config.audience !== undefined ? { audience: config.audience } : {}),
          });
          claims = payload as JwtClaims;
        } else {
          const { payload } = await jwtVerify(token, config.secretBytes, {
            algorithms: ["HS256"],
            ...(config.issuer !== undefined ? { issuer: config.issuer } : {}),
            ...(config.audience !== undefined ? { audience: config.audience } : {}),
          });
          claims = payload as JwtClaims;
        }
      } catch {
        return { valid: false, message: "Invalid or expired token." };
      }

      if (!claims.jti) {
        return { valid: false, message: "Token missing required jti claim." };
      }

      const [tokenRevoked, userRevoked] = await Promise.all([
        config.redis.exists(`revocation:${claims.jti}`),
        config.redis.exists(`revocation:user:${claims.sub}`),
      ]);
      if (tokenRevoked || userRevoked) {
        return { valid: false, message: "Token has been revoked." };
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

      return { valid: true, user };
    },
  };
}
