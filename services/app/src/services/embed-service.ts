// Embed token service — G-071
//
// Embed tokens are short-lived signed JWTs that are distinct from user auth
// tokens. They carry the full embed policy in their payload so the serving
// endpoint can validate origin and permissions without a DB round-trip for
// the happy path.  The DB row is the revocation store — every embed request
// checks it to honour revoke() calls made after the JWT was issued.
//
// Token lifecycle:
//   generate → persist metadata row, sign JWT with row PK as jti
//   validate → verify JWT signature + expiry, then check DB revocation
//   revoke   → mark DB row revoked_at; the JWT remains cryptographically
//              valid but every subsequent validate() call will reject it

import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import type { Logger } from "@oneplatform/core";
import type { EmbedTokenRepository } from "../repositories/embed-token-repository.js";
import type { AppRepository } from "../repositories/app-repository.js";
import type { EmbedTokenRow } from "../repositories/types.js";
import {
  AppNotFoundError,
  EmbedTokenNotFoundError,
  EmbedTokenExpiredError,
  EmbedTokenRevokedError,
  EmbedTokenInvalidError,
} from "./errors.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface EmbedOptions {
  /** JWT lifetime in seconds. Defaults to 86400 (24h). Hard cap: 30 days. */
  expiresIn?:      number;
  /** Domains that may embed the app. Empty array = no origin permitted. */
  allowedOrigins?: string[];
  /** Default is 'read' — most restrictive permission. */
  permissions?:    "read" | "read-write";
}

export interface EmbedConfig {
  appId:          string;
  tenantId:       string;
  allowedOrigins: string[];
  permissions:    "read" | "read-write";
  expiresAt:      string;   // ISO-8601
  tokenId:        string;
}

export interface EmbedTokenPayload {
  tokenId:        string;
  appId:          string;
  tenantId:       string;
  allowedOrigins: string[];
  permissions:    "read" | "read-write";
}

export interface GenerateEmbedTokenResult {
  token:   string;
  config:  EmbedConfig;
  snippet: string;
}

export interface EmbedService {
  generateEmbedToken(
    appId: string,
    tenantId: string,
    userId: string,
    options?: EmbedOptions
  ): Promise<GenerateEmbedTokenResult>;

  validateEmbedToken(token: string): Promise<EmbedTokenPayload>;

  revokeEmbedToken(tokenId: string, appId: string, tenantId: string): Promise<void>;

  listEmbedTokens(appId: string, tenantId: string): Promise<EmbedConfig[]>;
}

export interface EmbedServiceDeps {
  embedTokenRepo: EmbedTokenRepository;
  appRepo:        AppRepository;
  /** HS256 signing secret — must be distinct from the user-auth JWT secret */
  embedSecret:    Uint8Array;
  /** Base URL used for snippet generation, e.g. "https://platform.example" */
  baseUrl:        string;
  logger:         Logger;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_EXPIRES_IN_SECONDS = 86_400;         // 24 hours
const MAX_EXPIRES_IN_SECONDS     = 30 * 86_400;    // 30 days hard cap
const EMBED_JWT_ALGORITHM        = "HS256" as const;
const MAX_ALLOWED_ORIGINS        = 20;

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

function validateExpiresIn(expiresIn: number): number {
  if (!Number.isInteger(expiresIn) || expiresIn <= 0) {
    throw new Error("expiresIn must be a positive integer number of seconds.");
  }
  if (expiresIn > MAX_EXPIRES_IN_SECONDS) {
    // Clamp rather than reject — callers shouldn't be broken by the cap
    return MAX_EXPIRES_IN_SECONDS;
  }
  return expiresIn;
}

function validateAllowedOrigin(origin: string): void {
  if (origin === "*") return;  // explicit wildcard — allowed

  // Strip leading wildcard subdomain before URL parsing
  const testOrigin = origin.startsWith("*.") ? origin.slice(2) : origin;

  try {
    const url = new URL(`https://${testOrigin}`);
    // A valid origin must contain only host[:port] — no path, query, or hash
    if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
      throw new Error("must be a hostname");
    }
  } catch {
    throw new Error(
      `Invalid origin "${origin}": must be a hostname (and optional port), ` +
      `e.g. "example.com", "*.example.com", or "app.example.com:8080".`
    );
  }
}

function validateAllowedOrigins(origins: string[]): void {
  if (origins.length > MAX_ALLOWED_ORIGINS) {
    throw new Error(`allowedOrigins may not exceed ${MAX_ALLOWED_ORIGINS} entries.`);
  }
  for (const origin of origins) {
    validateAllowedOrigin(origin);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createEmbedService(deps: EmbedServiceDeps): EmbedService {
  const { embedTokenRepo, appRepo, embedSecret, baseUrl, logger } = deps;

  // -------------------------------------------------------------------------
  // generateEmbedToken — persists metadata row then signs JWT with the row PK
  // -------------------------------------------------------------------------

  async function generateEmbedToken(
    appId: string,
    tenantId: string,
    userId: string,
    options?: EmbedOptions
  ): Promise<GenerateEmbedTokenResult> {
    // Verify app belongs to tenant before issuing — prevents cross-tenant leakage
    const app = await appRepo.findByTenantAndId(tenantId, appId);
    if (app === null) {
      throw new AppNotFoundError(`App "${appId}" not found.`, { appId, tenantId });
    }

    const expiresInSeconds = options?.expiresIn !== undefined
      ? validateExpiresIn(options.expiresIn)
      : DEFAULT_EXPIRES_IN_SECONDS;

    const allowedOrigins = options?.allowedOrigins ?? [];
    validateAllowedOrigins(allowedOrigins);

    // Always default to the most restrictive permission set
    const permissions: "read" | "read-write" = options?.permissions ?? "read";

    const now       = new Date();
    const expiresAt = new Date(now.getTime() + expiresInSeconds * 1_000);

    // Persist the metadata row first.  The DB generates the PK which becomes
    // the JWT jti, so they are always in sync.  If signing fails after this
    // the orphaned DB row is harmless — no valid JWT exists for it.
    const dbRow = await embedTokenRepo.create({
      app_id:          appId,
      tenant_id:       tenantId,
      allowed_origins: allowedOrigins,
      permissions,
      expires_at:      expiresAt,
      created_by:      userId,
    });

    const token = await new SignJWT({
      tokenId:        dbRow.id,
      appId,
      tenantId,
      allowedOrigins,
      permissions,
    })
      .setProtectedHeader({ alg: EMBED_JWT_ALGORITHM })
      .setJti(dbRow.id)
      .setIssuedAt()
      .setExpirationTime(Math.floor(expiresAt.getTime() / 1_000))
      .sign(embedSecret);

    const config: EmbedConfig = {
      appId,
      tenantId,
      allowedOrigins,
      permissions,
      expiresAt: expiresAt.toISOString(),
      tokenId:   dbRow.id,
    };

    logger.info("Embed token generated", {
      appId,
      tenantId,
      tokenId:     dbRow.id,
      expiresAt:   expiresAt.toISOString(),
      permissions,
      originCount: allowedOrigins.length,
    });

    return { token, config, snippet: generateEmbedSnippet(baseUrl, token) };
  }

  // -------------------------------------------------------------------------
  // validateEmbedToken — verify JWT then check DB revocation
  // -------------------------------------------------------------------------

  async function validateEmbedToken(token: string): Promise<EmbedTokenPayload> {
    let payload: JWTPayload & Record<string, unknown>;

    try {
      const result = await jwtVerify(token, embedSecret, {
        algorithms: [EMBED_JWT_ALGORITHM],
      });
      payload = result.payload as JWTPayload & Record<string, unknown>;
    } catch {
      // jose throws JWSSignatureVerificationFailed, JWTExpired, etc.
      // We surface a single type so callers don't couple to jose internals.
      throw new EmbedTokenInvalidError("Embed token is invalid or has expired.");
    }

    const tokenId = payload["jti"];
    if (typeof tokenId !== "string" || tokenId.length === 0) {
      throw new EmbedTokenInvalidError("Embed token is missing the required jti claim.");
    }

    // Check revocation in the DB — this is the only way to honour revoke() calls
    // made after the JWT was signed.
    const dbRow = await embedTokenRepo.findById(tokenId);
    if (dbRow === null) {
      throw new EmbedTokenNotFoundError(`Embed token "${tokenId}" not found.`);
    }

    if (dbRow.revoked_at !== null) {
      throw new EmbedTokenRevokedError(`Embed token "${tokenId}" has been revoked.`);
    }

    // Belt-and-suspenders expiry against DB to handle cases where a system clock
    // was wrong at signing time.
    if (dbRow.expires_at <= new Date()) {
      throw new EmbedTokenExpiredError(`Embed token "${tokenId}" has expired.`);
    }

    return {
      tokenId:        dbRow.id,
      appId:          dbRow.app_id,
      tenantId:       dbRow.tenant_id,
      allowedOrigins: dbRow.allowed_origins,
      permissions:    dbRow.permissions,
    };
  }

  // -------------------------------------------------------------------------
  // revokeEmbedToken
  // -------------------------------------------------------------------------

  async function revokeEmbedToken(
    tokenId: string,
    appId: string,
    tenantId: string
  ): Promise<void> {
    const revoked = await embedTokenRepo.revoke(tokenId, appId, tenantId);
    if (!revoked) {
      throw new EmbedTokenNotFoundError(
        `Embed token "${tokenId}" not found or already revoked.`
      );
    }
    logger.info("Embed token revoked", { tokenId, appId, tenantId });
  }

  // -------------------------------------------------------------------------
  // listEmbedTokens
  // -------------------------------------------------------------------------

  async function listEmbedTokens(
    appId: string,
    tenantId: string
  ): Promise<EmbedConfig[]> {
    const rows = await embedTokenRepo.listActiveByApp(appId, tenantId);
    return rows.map(rowToConfig);
  }

  return { generateEmbedToken, validateEmbedToken, revokeEmbedToken, listEmbedTokens };
}

// ---------------------------------------------------------------------------
// Helpers — exported for use in the route layer and tests
// ---------------------------------------------------------------------------

function rowToConfig(row: EmbedTokenRow): EmbedConfig {
  return {
    appId:          row.app_id,
    tenantId:       row.tenant_id,
    allowedOrigins: row.allowed_origins,
    permissions:    row.permissions,
    expiresAt:      row.expires_at.toISOString(),
    tokenId:        row.id,
  };
}

/**
 * Returns true when `requestOrigin` is permitted by the token's allowedOrigins list.
 *
 * Rules (in evaluation order):
 *   "*"            → permits any origin
 *   "*.example.com" → permits any direct subdomain of example.com
 *   Exact string   → exact case-sensitive match
 *   Empty list     → rejects all origins (most restrictive)
 */
export function isOriginAllowed(requestOrigin: string, allowedOrigins: string[]): boolean {
  // Browsers send Origin with a scheme (e.g., "https://example.com:8080") but stored
  // patterns may be bare hostnames ("example.com") or host+port ("example.com:8080").
  // We compare against both `.host` (includes port) and `.hostname` (no port) so that
  // a stored pattern of "example.com:8080" matches a port-qualified origin, while a
  // stored bare pattern like "example.com" continues to match origins without a port.
  let requestHost: string;
  let requestHostname: string;
  try {
    const parsed = new URL(requestOrigin);
    requestHost     = parsed.host;      // "example.com:8080" or "example.com"
    requestHostname = parsed.hostname;  // always "example.com"
  } catch {
    requestHost     = requestOrigin;
    requestHostname = requestOrigin;
  }

  for (const pattern of allowedOrigins) {
    if (pattern === "*") return true;
    // Match against both host (port-qualified) and hostname (bare) so stored
    // patterns work regardless of whether the port was included when saved.
    if (pattern === requestHost || pattern === requestHostname) return true;

    if (pattern.startsWith("*.")) {
      const domain = pattern.slice(2);
      if (requestHostname.endsWith(`.${domain}`) && requestHostname.length > domain.length + 1) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Generates the iframe HTML snippet for embedding an app.
 * Callers should display this to developers who want to embed the app.
 */
export function generateEmbedSnippet(
  baseUrl: string,
  token: string,
  options?: { width?: string; height?: string }
): string {
  const width  = options?.width  ?? "100%";
  const height = options?.height ?? "600";
  // encodeURIComponent is safe here: the token is a compact JWT (base64url.base64url.base64url)
  const src    = `${baseUrl}/api/v1/embed/${encodeURIComponent(token)}`;

  return (
    `<iframe src="${src}" width="${width}" height="${height}" ` +
    `frameborder="0" allowfullscreen></iframe>`
  );
}
