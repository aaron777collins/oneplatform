/**
 * OIDC Auth Provider — implements the AuthProvider interface for standard
 * OpenID Connect identity providers.
 *
 * Tested against: Okta, Azure AD (v2 endpoint), Auth0, Google Workspace,
 * and Keycloak. Uses OIDC discovery to stay compatible with any provider
 * that publishes a /.well-known/openid-configuration document.
 *
 * Flow:
 *   1. getAuthorizationUrl()  — redirects the browser to the IdP login page
 *   2. handleCallback()       — exchanges the authorization code for tokens
 *   3. validateToken()        — verifies the access/id token signature and claims
 *   4. refreshToken()         — exchanges a refresh token for a new access token
 *   5. mapClaimsToRoles()     — maps IdP group/role claims to platform RBAC names
 *
 * All HTTP calls go through the FetchProxy. JWT verification uses Web Crypto
 * so the plugin runs inside the isolated-vm sandbox without Node.js builtins.
 */

import type {
  AuthProvider,
  AuthProviderMetadata,
  AuthOptions,
  AuthContext,
  AuthResult,
  CallbackParams,
  TokenValidation,
  TokenPair,
  PluginContext,
  FetchProxy,
  PluginLogger,
} from "@oneplatform/plugin-sdk";
import {
  PluginAuthError,
  PluginConfigError,
  PluginTimeoutError,
} from "@oneplatform/plugin-sdk";
import { fetchDiscoveryDocument } from "./discovery.js";
import { verifyJwt } from "./jwks.js";

// ────────────────────────────────────────────────────────────────────────────
// Configuration types
// ────────────────────────────────────────────────────────────────────────────

/** Validated, typed representation of the tenant-admin configuration. */
interface OidcConfig {
  issuerUrl: string;
  clientId: string;
  scopes: string[];
  /** Dot-delimited path to the roles claim: "groups", "resource_access.myapp.roles", etc. */
  roleClaimPath: string | null;
  /** IdP role name → OnePlatform role name. Applied after extracting the roles claim. */
  roleMapping: Record<string, string>;
  jwksCacheTtlSeconds: number;
}

// ────────────────────────────────────────────────────────────────────────────
// OIDC token response shape (RFC 6749 §5.1 + OIDC Core §3.1.3.3)
// ────────────────────────────────────────────────────────────────────────────

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Config parsing
// ────────────────────────────────────────────────────────────────────────────

function parseConfig(raw: Record<string, unknown>): OidcConfig {
  const issuerUrl = raw["issuerUrl"];
  if (typeof issuerUrl !== "string" || issuerUrl.trim() === "") {
    throw new PluginConfigError("issuerUrl is required and must be a non-empty string", "issuerUrl");
  }

  try {
    new URL(issuerUrl);
  } catch {
    throw new PluginConfigError(`issuerUrl is not a valid URL: "${issuerUrl}"`, "issuerUrl");
  }

  if (!issuerUrl.startsWith("https://")) {
    throw new PluginConfigError(
      `issuerUrl must use HTTPS. Received: "${issuerUrl}"`,
      "issuerUrl",
    );
  }

  const clientId = raw["clientId"];
  if (typeof clientId !== "string" || clientId.trim() === "") {
    throw new PluginConfigError("clientId is required and must be a non-empty string", "clientId");
  }

  const rawScopes = raw["scopes"];
  let scopes: string[];
  if (Array.isArray(rawScopes) && rawScopes.length > 0) {
    scopes = rawScopes.map(String);
  } else {
    scopes = ["openid", "profile", "email"];
  }

  // Always include "openid" — the protocol requires it for ID token issuance.
  if (!scopes.includes("openid")) {
    scopes = ["openid", ...scopes];
  }

  const rawRoleClaimPath = raw["roleClaimPath"];
  const roleClaimPath =
    typeof rawRoleClaimPath === "string" && rawRoleClaimPath.trim() !== ""
      ? rawRoleClaimPath.trim()
      : null;

  const rawRoleMapping = raw["roleMapping"];
  const roleMapping: Record<string, string> =
    rawRoleMapping !== null &&
    rawRoleMapping !== undefined &&
    typeof rawRoleMapping === "object" &&
    !Array.isArray(rawRoleMapping)
      ? (rawRoleMapping as Record<string, string>)
      : {};

  const rawCacheTtl = raw["jwksCacheTtlSeconds"];
  const jwksCacheTtlSeconds =
    typeof rawCacheTtl === "number" && rawCacheTtl >= 60 && rawCacheTtl <= 86400
      ? Math.floor(rawCacheTtl)
      : 3600;

  return {
    issuerUrl: issuerUrl.trim(),
    clientId: clientId.trim(),
    scopes,
    roleClaimPath,
    roleMapping,
    jwksCacheTtlSeconds,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Role claim extraction
// ────────────────────────────────────────────────────────────────────────────

/**
 * Navigate a dot-delimited path through a claims object to extract a roles value.
 * e.g., path="resource_access.myapp.roles" on Keycloak token claims.
 *
 * Returns an array of strings. Non-array, non-string results become empty.
 */
function extractRolesClaim(claims: Record<string, unknown>, path: string): string[] {
  const segments = path.split(".");
  let cursor: unknown = claims;

  for (const segment of segments) {
    if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) {
      return [];
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }

  if (typeof cursor === "string") {
    return [cursor];
  }

  if (Array.isArray(cursor)) {
    return cursor.filter((v): v is string => typeof v === "string");
  }

  return [];
}

// ────────────────────────────────────────────────────────────────────────────
// Token endpoint helper
// ────────────────────────────────────────────────────────────────────────────

/**
 * POST to the OIDC token endpoint with the given form-encoded body.
 * Used for both the authorization code exchange and the refresh token grant.
 */
async function postTokenEndpoint(
  tokenEndpoint: string,
  formFields: Record<string, string>,
  fetchProxy: FetchProxy,
  logger: PluginLogger,
): Promise<TokenResponse> {
  const body = new URLSearchParams(formFields).toString();

  let response: Response;
  try {
    response = await fetchProxy.fetch(tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new PluginTimeoutError(`Token endpoint request failed: ${message}`);
  }

  let tokenResponse: TokenResponse;
  try {
    tokenResponse = (await response.json()) as TokenResponse;
  } catch {
    throw new PluginAuthError(
      `Token endpoint returned non-JSON response (HTTP ${response.status})`,
      { status: response.status, tokenEndpoint },
    );
  }

  // RFC 6749 §5.2: error responses use HTTP 400 with an "error" field.
  if (!response.ok || tokenResponse.error !== undefined) {
    const errorCode = tokenResponse.error ?? `http_${response.status}`;
    const errorDescription = tokenResponse.error_description ?? "Token endpoint returned an error";
    throw new PluginAuthError(
      `Token exchange failed: ${errorDescription} (${errorCode})`,
      { errorCode, errorDescription, status: response.status },
    );
  }

  if (typeof tokenResponse.access_token !== "string" || tokenResponse.access_token === "") {
    throw new PluginAuthError(
      "Token endpoint response did not contain an access_token",
      { status: response.status },
    );
  }

  logger.debug("Token endpoint exchange successful", {
    hasRefreshToken: tokenResponse.refresh_token !== undefined,
    hasIdToken: tokenResponse.id_token !== undefined,
    expiresIn: tokenResponse.expires_in,
  });

  return tokenResponse;
}

// ────────────────────────────────────────────────────────────────────────────
// JWT payload decoder (no signature verification)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Decode a JWT payload without verifying the signature.
 * Only used for tokens received directly from the token endpoint over TLS —
 * those tokens are implicitly trusted because they came from the provider,
 * not from the browser. Never use this for tokens received from clients.
 */
function decodeJwtPayloadUnsafe(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return {};
  }

  // noUncheckedIndexedAccess: length === 3 is verified above
  const payloadPart = parts[1] as string;

  try {
    // Prefer Node.js Buffer for reliable multi-byte handling.
    // The atob() fallback covers browser and WASM environments.
    const json =
      typeof Buffer !== "undefined"
        ? Buffer.from(payloadPart, "base64url").toString("utf8")
        : atob(payloadPart.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Hash helper
// ────────────────────────────────────────────────────────────────────────────

/**
 * Deterministic string hash for cache key derivation.
 * Used to create a stable lock key from a refresh token without embedding
 * the token value in the key. Not cryptographic — just needs to be stable
 * within a process lifetime.
 */
function hashString(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    // djb2 algorithm
    hash = ((hash << 5) + hash) ^ value.charCodeAt(i);
  }
  // Convert to unsigned 32-bit hex to keep keys short and URL-safe
  return (hash >>> 0).toString(16);
}

// ────────────────────────────────────────────────────────────────────────────
// Cache keys
// ────────────────────────────────────────────────────────────────────────────

// Store the resolved client secret in the plugin-scoped cache so handleCallback
// and refreshToken (which receive AuthContext, not PluginContext) can access it.
// TTL of 86400s — rotated at plugin re-enable time via initialize().
const CLIENT_SECRET_CACHE_KEY = "oidc:clientSecret";

// Cache the authorization endpoint URL so getAuthorizationUrl() (synchronous,
// no access to FetchProxy) can build a correct URL after the first discovery.
const AUTH_ENDPOINT_CACHE_KEY = "oidc:authEndpoint";

// ────────────────────────────────────────────────────────────────────────────
// Main provider class
// ────────────────────────────────────────────────────────────────────────────

class OidcAuthProvider implements AuthProvider {
  /** Parsed configuration, set by initialize(). */
  private config: OidcConfig | null = null;

  /**
   * FetchProxy captured from PluginContext at initialize() time.
   *
   * AuthProvider interface methods (handleCallback, validateToken, refreshToken)
   * receive AuthContext, which deliberately omits FetchProxy. The FetchProxy is
   * needed for discovery and JWKS requests in those methods. We capture it once
   * here so we do not need to thread PluginContext through the entire call graph.
   */
  private fetchProxy: FetchProxy | null = null;

  /**
   * In-memory cache of the authorization endpoint URL.
   * Populated by initialize() after fetching the discovery document.
   * getAuthorizationUrl() is synchronous so it cannot hit the network —
   * this field allows it to return a correct URL without async discovery.
   */
  private authorizationEndpoint: string | null = null;

  metadata(): AuthProviderMetadata {
    return {
      type: "auth-provider",
      id: "com.oneplatform.auth-provider-oidc",
      name: "OIDC Auth Provider",
      description:
        "OpenID Connect authentication. Compatible with Okta, Azure AD, Auth0, Google Workspace, and Keycloak.",
      version: "1.0.0",
      author: "OnePlatform",
      protocol: "oidc",
      supportsTokenValidation: true,
      supportsTokenRefresh: true,
      scopes: ["openid", "profile", "email", "offline_access"],
      tags: ["oidc", "oauth2", "sso", "okta", "azure-ad", "auth0", "google", "keycloak"],
      configSchema: {
        type: "object",
        required: ["issuerUrl", "clientId", "scopes"],
        properties: {
          issuerUrl: { type: "string", format: "uri" },
          clientId: { type: "string" },
          scopes: { type: "array", items: { type: "string" } },
          roleClaimPath: { type: "string" },
          roleMapping: { type: "object", additionalProperties: { type: "string" } },
          jwksCacheTtlSeconds: { type: "number", minimum: 60, maximum: 86400 },
        },
        additionalProperties: false,
      },
    };
  }

  /**
   * Initialize the provider with the tenant configuration.
   *
   * Called once by the platform after loading the plugin bundle with the full
   * PluginContext (not AuthContext). We use this opportunity to:
   *   1. Parse and validate the configuration.
   *   2. Capture the FetchProxy for use by AuthContext-scoped methods.
   *   3. Fetch and cache the OIDC discovery document to avoid the first-login RTT.
   *   4. Resolve the client secret from CredentialAccessor and store it in the
   *      plugin-scoped cache so AuthContext methods can access it without credentials.
   */
  async initialize(config: Record<string, unknown>, context: PluginContext): Promise<void> {
    const span = context.tracing.startSpan("OidcAuthProvider.initialize");

    try {
      this.config = parseConfig(config);
      this.fetchProxy = context.fetch;

      // Fetch discovery document to validate issuerUrl eagerly and populate
      // the authorization endpoint before the first login attempt.
      const discovery = await fetchDiscoveryDocument({
        issuerUrl: this.config.issuerUrl,
        cacheTtlSeconds: this.config.jwksCacheTtlSeconds,
        fetch: context.fetch,
        cache: context.cache,
        logger: context.logger,
      });

      // Store authorization endpoint in-memory so getAuthorizationUrl() can use
      // it synchronously. Also store in cache so it survives a warm restart.
      this.authorizationEndpoint = discovery.authorization_endpoint;
      await context.cache.set(
        AUTH_ENDPOINT_CACHE_KEY,
        discovery.authorization_endpoint,
        this.config.jwksCacheTtlSeconds,
      );

      // Resolve and cache the client secret. AuthContext methods cannot access
      // credentials directly — they receive a cache-scoped context. We bridge
      // the gap by caching the resolved secret here under a well-known key.
      // TTL matches jwksCacheTtlSeconds so both expire and are refreshed together.
      const clientSecret = await context.credentials.get("clientSecret");
      await context.cache.set(CLIENT_SECRET_CACHE_KEY, clientSecret, this.config.jwksCacheTtlSeconds);

      context.logger.info("OIDC provider initialized", {
        issuerUrl: this.config.issuerUrl,
        clientId: this.config.clientId,
        scopes: this.config.scopes,
      });

      span.setAttribute("oidc.issuerUrl", this.config.issuerUrl);
      span.setAttribute("oidc.clientId", this.config.clientId);
    } finally {
      span.end();
    }
  }

  /**
   * Build the authorization URL that the browser navigates to.
   *
   * Uses response_type=code (authorization code flow) with a client secret
   * for confidential client authentication. The state parameter (CSRF protection)
   * is generated by the Auth Service and passed through verbatim.
   *
   * Azure AD note: response_mode=query ensures the authorization code arrives as
   * a query parameter, which is required for server-side callback handling.
   */
  getAuthorizationUrl(state: string, options: AuthOptions): string {
    const cfg = this.requireConfig();

    // Use the discovery-provided endpoint when available; fall back to the
    // standard /{issuer}/authorize path convention for the first call edge case.
    const authEndpoint =
      this.authorizationEndpoint ?? this.buildFallbackAuthEndpoint(cfg.issuerUrl);

    const params = new URLSearchParams({
      response_type: "code",
      response_mode: "query",
      client_id: cfg.clientId,
      redirect_uri: options.redirectUri,
      scope: this.mergeScopes(cfg.scopes, options.scopes).join(" "),
      state,
    });

    // Pass through provider-specific params (login_hint, prompt, acr_values, etc.)
    if (options.additionalParams !== undefined) {
      for (const [key, value] of Object.entries(options.additionalParams)) {
        params.set(key, value);
      }
    }

    return `${authEndpoint}?${params.toString()}`;
  }

  /**
   * Exchange the authorization code for tokens.
   *
   * The Auth Service has already verified the state parameter before calling
   * this method. We exchange the code at the token endpoint and extract claims
   * from the id_token (or access_token for OAuth2-only providers). Claims are
   * decoded without re-verifying the signature because the token came directly
   * from the provider over TLS — it is implicitly trusted at this point.
   */
  async handleCallback(params: CallbackParams, context: AuthContext): Promise<AuthResult> {
    const cfg = this.requireConfig();
    const fetchProxy = this.requireFetch();

    // Surface provider-side errors (user denied, session expired, etc.) clearly.
    if (params.error !== undefined) {
      throw new PluginAuthError(
        `OIDC callback error: ${params.errorDescription ?? params.error}`,
        { error: params.error, errorDescription: params.errorDescription },
      );
    }

    if (params.code.trim() === "") {
      throw new PluginAuthError("OIDC callback received an empty authorization code");
    }

    const discovery = await fetchDiscoveryDocument({
      issuerUrl: cfg.issuerUrl,
      cacheTtlSeconds: cfg.jwksCacheTtlSeconds,
      fetch: fetchProxy,
      cache: context.cache,
      logger: context.logger,
    });

    // Keep the in-memory endpoint current on discovery cache refresh
    this.authorizationEndpoint = discovery.authorization_endpoint;

    // Read the pre-cached client secret written by initialize().
    const clientSecret = await context.cache.get<string>(CLIENT_SECRET_CACHE_KEY);
    if (clientSecret === null) {
      throw new PluginAuthError(
        "OIDC client secret not available — ensure initialize() completed before the first login",
      );
    }

    context.logger.info("Exchanging OIDC authorization code for tokens");

    const tokenResponse = await postTokenEndpoint(
      discovery.token_endpoint,
      {
        grant_type: "authorization_code",
        code: params.code,
        redirect_uri: context.tenant.config["redirectUri"] as string ?? "",
        client_id: cfg.clientId,
        client_secret: clientSecret,
      },
      fetchProxy,
      context.logger,
    );

    // Prefer ID token claims (explicitly issued to this client).
    // Fall back to access token payload for OAuth2-only providers.
    const claims =
      tokenResponse.id_token !== undefined
        ? decodeJwtPayloadUnsafe(tokenResponse.id_token)
        : decodeJwtPayloadUnsafe(tokenResponse.access_token);

    const providerUserId = typeof claims["sub"] === "string" ? claims["sub"] : "";
    if (providerUserId === "") {
      throw new PluginAuthError(
        "OIDC token response did not contain a 'sub' claim — cannot identify the user",
      );
    }

    const platformRoles = this.mapClaimsToRoles(claims);

    const expiresAt =
      tokenResponse.expires_in !== undefined
        ? new Date(Date.now() + tokenResponse.expires_in * 1000).toISOString()
        : undefined;

    context.logger.info("OIDC login successful", {
      providerUserId,
      roleCount: platformRoles.length,
    });

    // exactOptionalPropertyTypes: only spread optional fields when defined.
    return {
      accessToken: tokenResponse.access_token,
      ...(tokenResponse.refresh_token !== undefined
        ? { refreshToken: tokenResponse.refresh_token }
        : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      claims,
      platformRoles,
      providerUserId,
    };
  }

  /**
   * Validate a token's signature and claims against the provider's JWKS.
   *
   * Returns valid=false for expired or revoked tokens rather than throwing.
   * Throws PluginAuthError only for unrecoverable errors (provider unreachable
   * after retry, malformed JWKS, etc.).
   */
  async validateToken(token: string, context: AuthContext): Promise<TokenValidation> {
    const cfg = this.requireConfig();
    const fetchProxy = this.requireFetch();

    const discovery = await fetchDiscoveryDocument({
      issuerUrl: cfg.issuerUrl,
      cacheTtlSeconds: cfg.jwksCacheTtlSeconds,
      fetch: fetchProxy,
      cache: context.cache,
      logger: context.logger,
    });

    const result = await verifyJwt(token, {
      issuerUrl: cfg.issuerUrl,
      clientId: cfg.clientId,
      jwksUri: discovery.jwks_uri,
      cacheTtlSeconds: cfg.jwksCacheTtlSeconds,
      fetch: fetchProxy,
      cache: context.cache,
      logger: context.logger,
    });

    if (!result.valid) {
      context.logger.debug("OIDC token validation failed", { reason: result.error });
      // exactOptionalPropertyTypes: only include error when it has a value.
      return {
        valid: false,
        ...(result.error !== undefined ? { error: result.error } : {}),
      };
    }

    // exactOptionalPropertyTypes: only include optional fields when defined.
    return {
      valid: true,
      ...(result.claims !== undefined ? { claims: result.claims as Record<string, unknown> } : {}),
      ...(result.expiresAt !== undefined ? { expiresAt: result.expiresAt } : {}),
    };
  }

  /**
   * Exchange a refresh token for a new access token.
   *
   * Uses a distributed lock to prevent concurrent refresh races where two parallel
   * requests both detect an expired token and each attempt to refresh it. The first
   * request acquires the lock and refreshes; subsequent requests wait and then read
   * the result from cache.
   */
  async refreshToken(refreshToken: string, context: AuthContext): Promise<TokenPair> {
    const cfg = this.requireConfig();
    const fetchProxy = this.requireFetch();

    if (refreshToken.trim() === "") {
      throw new PluginAuthError("Cannot refresh: refresh token is empty");
    }

    // Lock key derived from a hash of the refresh token so each user gets their
    // own lock without embedding the token value in the key.
    const lockKey = `oidc:refresh:lock:${hashString(refreshToken)}`;

    // Lock TTL of 30s is generous for a token endpoint round-trip but short
    // enough that a crash cannot cause a permanent deadlock.
    const lock = await context.cache.lock(lockKey, 30);

    if (lock === null) {
      // Another concurrent request holds the refresh lock for this token.
      // Return the result it cached, or surface a retryable error.
      const cached = await context.cache.get<TokenPair>("oidc:refreshed:token");
      if (cached !== null) {
        context.logger.debug("Refresh lock held by another request — returning cached result");
        return cached;
      }
      throw new PluginAuthError(
        "Concurrent token refresh in progress — retry in a few seconds",
      );
    }

    try {
      const discovery = await fetchDiscoveryDocument({
        issuerUrl: cfg.issuerUrl,
        cacheTtlSeconds: cfg.jwksCacheTtlSeconds,
        fetch: fetchProxy,
        cache: context.cache,
        logger: context.logger,
      });

      const clientSecret = await context.cache.get<string>(CLIENT_SECRET_CACHE_KEY);
      if (clientSecret === null) {
        throw new PluginAuthError(
          "Client secret not available for token refresh — re-enable the OIDC plugin to re-initialize",
        );
      }

      context.logger.info("Refreshing OIDC access token");

      const tokenResponse = await postTokenEndpoint(
        discovery.token_endpoint,
        {
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: cfg.clientId,
          client_secret: clientSecret,
        },
        fetchProxy,
        context.logger,
      );

      const expiresAt =
        tokenResponse.expires_in !== undefined
          ? new Date(Date.now() + tokenResponse.expires_in * 1000).toISOString()
          : undefined;

      // exactOptionalPropertyTypes: only spread optional fields when defined.
      const result: TokenPair = {
        accessToken: tokenResponse.access_token,
        // Provider may rotate the refresh token; fall back to the original if not.
        refreshToken: tokenResponse.refresh_token ?? refreshToken,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      };

      // Cache the refreshed pair briefly so concurrent requests waiting on the
      // lock can read it immediately after the lock is released (15-second window).
      await context.cache.set("oidc:refreshed:token", result, 15);

      context.logger.info("OIDC token refresh successful", {
        hasNewRefreshToken: tokenResponse.refresh_token !== undefined,
      });

      return result;
    } finally {
      await lock.release();
    }
  }

  /**
   * Map identity provider claims to OnePlatform RBAC role names.
   *
   * Reads the configured roleClaimPath from the claims object, then applies
   * the roleMapping dictionary. IdP roles absent from roleMapping are dropped.
   * Returns an empty array when roleClaimPath is null (no role assignment configured).
   *
   * Synchronous and must not make network calls per the AuthProvider interface contract.
   */
  mapClaimsToRoles(claims: Record<string, unknown>): string[] {
    const cfg = this.config;
    if (cfg === null || cfg.roleClaimPath === null) {
      return [];
    }

    const rawRoles = extractRolesClaim(claims, cfg.roleClaimPath);
    const platformRoles: string[] = [];

    for (const idpRole of rawRoles) {
      const platformRole = cfg.roleMapping[idpRole];
      if (platformRole !== undefined) {
        platformRoles.push(platformRole);
      }
    }

    return platformRoles;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private requireConfig(): OidcConfig {
    if (this.config === null) {
      throw new PluginConfigError(
        "OIDC provider not initialized — initialize() must be called before any auth methods",
        "issuerUrl",
      );
    }
    return this.config;
  }

  private requireFetch(): FetchProxy {
    if (this.fetchProxy === null) {
      throw new PluginConfigError(
        "OIDC provider FetchProxy not set — initialize() must be called before any auth methods",
        "issuerUrl",
      );
    }
    return this.fetchProxy;
  }

  /** Merge default scopes with per-request overrides, always keeping "openid" first. */
  private mergeScopes(defaultScopes: string[], overrideScopes?: string[]): string[] {
    const merged = new Set(defaultScopes);
    if (overrideScopes !== undefined) {
      for (const s of overrideScopes) {
        merged.add(s);
      }
    }
    // Guarantee openid is present and first
    merged.delete("openid");
    return ["openid", ...merged];
  }

  /**
   * Construct a best-guess authorization endpoint URL from the issuer URL.
   * Used when the discovery document has not been fetched yet (edge case on
   * getAuthorizationUrl() calls that precede initialize()).
   */
  private buildFallbackAuthEndpoint(issuerUrl: string): string {
    const base = issuerUrl.endsWith("/") ? issuerUrl.slice(0, -1) : issuerUrl;
    return `${base}/authorize`;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Module entrypoint
//
// The manifest declares `"entrypoint": "authProvider"` so the Execution Service
// looks for a named export called `authProvider` on the bundle's module namespace.
// We extend the export type with `initialize` since it is a lifecycle method the
// platform calls but the AuthProvider interface does not formally declare (it is
// injected by the platform runtime, not called by plugin code).
// ────────────────────────────────────────────────────────────────────────────

export const authProvider: AuthProvider & {
  initialize(config: Record<string, unknown>, context: PluginContext): Promise<void>;
} = new OidcAuthProvider();
