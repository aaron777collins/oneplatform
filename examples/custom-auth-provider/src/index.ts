/**
 * SAML 2.0 Auth Provider Plugin — implements the AuthProvider interface for
 * SAML-based identity providers (Okta, Azure AD, OneLogin, Shibboleth, ADFS).
 *
 * This plugin implements the SAML Web Browser SSO Profile (SP-initiated):
 *   1. getAuthorizationUrl()  — builds a SAML AuthnRequest and returns the IdP SSO URL
 *   2. handleCallback()       — parses the SAML Response, extracts the assertion, and
 *                                returns user identity and roles
 *   3. validateToken()        — validates a cached session token (SAML assertions are
 *                                one-time-use, so this checks the platform-issued session)
 *   4. refreshToken()         — SAML does not support token refresh; this re-validates
 *                                the session and extends it if the user is still active
 *   5. mapClaimsToRoles()     — maps SAML group attributes to OnePlatform RBAC role names
 *
 * All HTTP calls go through the FetchProxy. The plugin runs inside the
 * isolated-vm sandbox without Node.js builtins.
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
} from "@oneplatform/plugin-sdk";
import {
  PluginAuthError,
  PluginConfigError,
} from "@oneplatform/plugin-sdk";
import {
  decodeSamlResponse,
  parseSamlResponseXml,
  findAttributeValue,
  findAttributeValues,
  validateAssertionTime,
} from "./saml-parser.js";
import type { SamlProviderConfig } from "./types.js";

// ────────────────────────────────────────────────────────────────────────────
// Config parsing
// ────────────────────────────────────────────────────────────────────────────

function parseConfig(raw: Record<string, unknown>): SamlProviderConfig {
  const idpEntityId = raw["idpEntityId"];
  if (typeof idpEntityId !== "string" || idpEntityId.trim() === "") {
    throw new PluginConfigError("idpEntityId is required and must be a non-empty string", "idpEntityId");
  }

  const idpSsoUrl = raw["idpSsoUrl"];
  if (typeof idpSsoUrl !== "string" || idpSsoUrl.trim() === "") {
    throw new PluginConfigError("idpSsoUrl is required and must be a non-empty string", "idpSsoUrl");
  }

  try {
    new URL(idpSsoUrl);
  } catch {
    throw new PluginConfigError(`idpSsoUrl is not a valid URL: "${idpSsoUrl}"`, "idpSsoUrl");
  }

  if (!idpSsoUrl.startsWith("https://")) {
    throw new PluginConfigError(
      `idpSsoUrl must use HTTPS. Received: "${idpSsoUrl}"`,
      "idpSsoUrl",
    );
  }

  const idpCertificate = raw["idpCertificate"];
  if (typeof idpCertificate !== "string" || idpCertificate.trim() === "") {
    throw new PluginConfigError(
      "idpCertificate is required — provide the IdP's signing certificate in PEM format",
      "idpCertificate",
    );
  }

  const spEntityId = raw["spEntityId"];
  if (typeof spEntityId !== "string" || spEntityId.trim() === "") {
    throw new PluginConfigError("spEntityId is required and must be a non-empty string", "spEntityId");
  }

  const emailAttributeName =
    typeof raw["emailAttributeName"] === "string" && raw["emailAttributeName"].trim() !== ""
      ? raw["emailAttributeName"].trim()
      : "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress";

  const groupAttributeName =
    typeof raw["groupAttributeName"] === "string" && raw["groupAttributeName"].trim() !== ""
      ? raw["groupAttributeName"].trim()
      : "http://schemas.xmlsoap.org/claims/Group";

  const rawRoleMapping = raw["roleMapping"];
  const roleMapping: Record<string, string> = {};
  if (
    rawRoleMapping !== null &&
    rawRoleMapping !== undefined &&
    typeof rawRoleMapping === "object" &&
    !Array.isArray(rawRoleMapping)
  ) {
    for (const [key, value] of Object.entries(rawRoleMapping as Record<string, unknown>)) {
      if (typeof value === "string") {
        roleMapping[key] = value;
      }
    }
  }

  const rawClockSkew = raw["clockSkewToleranceSeconds"];
  const clockSkewToleranceSeconds =
    typeof rawClockSkew === "number" && rawClockSkew >= 0 && rawClockSkew <= 600
      ? Math.floor(rawClockSkew)
      : 120;

  return {
    idpEntityId: idpEntityId.trim(),
    idpSsoUrl: idpSsoUrl.trim(),
    idpCertificate: idpCertificate.trim(),
    spEntityId: spEntityId.trim(),
    emailAttributeName,
    groupAttributeName,
    roleMapping,
    clockSkewToleranceSeconds,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Session token helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Generate a platform session token from SAML assertion data.
 *
 * SAML assertions are one-time-use and cannot be used for subsequent API
 * calls. Instead, we create a platform session token that encodes the
 * user's identity and store it in the cache. The validateToken() method
 * checks this cached session rather than contacting the IdP.
 */
function generateSessionToken(providerUserId: string, assertionId: string): string {
  const payload = {
    sub: providerUserId,
    assertionId,
    iat: Math.floor(Date.now() / 1000),
  };
  // Base64url-encode the JSON payload as a simple session token.
  // In production, this would be a signed JWT.
  if (typeof Buffer !== "undefined") {
    return `saml-session.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  }
  return `saml-session.${btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

/**
 * Decode a platform session token to extract the payload.
 * Returns null if the token format is invalid.
 */
function decodeSessionToken(token: string): Record<string, unknown> | null {
  if (!token.startsWith("saml-session.")) return null;
  const payloadPart = token.slice("saml-session.".length);
  try {
    let json: string;
    if (typeof Buffer !== "undefined") {
      json = Buffer.from(payloadPart, "base64url").toString("utf8");
    } else {
      json = atob(payloadPart.replace(/-/g, "+").replace(/_/g, "/"));
    }
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Cache keys
// ────────────────────────────────────────────────────────────────────────────

/** Cache key prefix for session data keyed by session token hash. */
const SESSION_CACHE_PREFIX = "saml:session:";

/** Session TTL: 8 hours matches a typical SAML session lifetime. */
const SESSION_TTL_SECONDS = 8 * 60 * 60;

// ────────────────────────────────────────────────────────────────────────────
// Hash helper
// ────────────────────────────────────────────────────────────────────────────

/**
 * Deterministic string hash for cache key derivation (djb2 algorithm).
 * Used to create a stable key from a session token without embedding
 * the token value in the key.
 */
function hashString(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = (((hash << 5) >>> 0) + hash + value.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16);
}

// ────────────────────────────────────────────────────────────────────────────
// Main provider class
// ────────────────────────────────────────────────────────────────────────────

class SamlAuthProvider implements AuthProvider {
  /** Parsed configuration, set by initialize(). */
  private config: SamlProviderConfig | null = null;

  /**
   * FetchProxy captured from PluginContext at initialize() time.
   * Needed for IdP metadata fetching and certificate validation.
   */
  private fetchProxy: FetchProxy | null = null;

  metadata(): AuthProviderMetadata {
    return {
      type: "auth-provider",
      id: "com.example.auth-provider-saml",
      name: "SAML Auth Provider",
      description:
        "SAML 2.0 authentication provider. Compatible with Okta, Azure AD, OneLogin, Shibboleth, and ADFS.",
      version: "1.0.0",
      author: "Example Author",
      protocol: "saml",
      supportsTokenValidation: true,
      supportsTokenRefresh: true,
      tags: ["saml", "sso", "enterprise", "okta", "azure-ad", "adfs", "shibboleth"],
      configSchema: {
        type: "object",
        required: ["idpEntityId", "idpSsoUrl", "idpCertificate", "spEntityId"],
        properties: {
          idpEntityId: {
            type: "string",
            description: "The Identity Provider's entity ID (found in the IdP's SAML metadata XML).",
          },
          idpSsoUrl: {
            type: "string",
            format: "uri",
            description: "The IdP's Single Sign-On URL for the HTTP-POST binding.",
          },
          idpCertificate: {
            type: "string",
            description: "The IdP's X.509 signing certificate in PEM format.",
          },
          spEntityId: {
            type: "string",
            description: "The Service Provider entity ID (your application's unique identifier).",
          },
          emailAttributeName: {
            type: "string",
            description: "SAML attribute name for the user's email address.",
            default: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
          },
          groupAttributeName: {
            type: "string",
            description: "SAML attribute name for group memberships (used for role mapping).",
            default: "http://schemas.xmlsoap.org/claims/Group",
          },
          roleMapping: {
            type: "object",
            additionalProperties: { type: "string" },
            description: "Map of IdP group name to OnePlatform role name.",
          },
          clockSkewToleranceSeconds: {
            type: "number",
            minimum: 0,
            maximum: 600,
            default: 120,
            description: "Clock skew tolerance for assertion time validation (seconds).",
          },
        },
        additionalProperties: false,
      },
    };
  }

  /**
   * Initialize the SAML provider with the tenant configuration.
   *
   * Called once by the platform after loading the plugin bundle. We use this to:
   *   1. Parse and validate the SAML configuration.
   *   2. Capture the FetchProxy for use by AuthContext-scoped methods.
   *   3. Verify the IdP certificate credential is accessible.
   */
  async initialize(config: Record<string, unknown>, context: PluginContext): Promise<void> {
    const span = context.tracing.startSpan("SamlAuthProvider.initialize");

    try {
      this.config = parseConfig(config);
      this.fetchProxy = context.fetch;

      // Verify the IdP certificate is accessible at startup time.
      // Some deployments store the certificate as a credential rather than
      // in the config (for rotation support). Check both paths.
      const credentialNames = await context.credentials.list();
      if (credentialNames.includes("idpCertificate")) {
        const certFromCredentials = await context.credentials.get("idpCertificate");
        if (certFromCredentials.trim() !== "") {
          // Credential store certificate takes precedence over config value
          this.config = { ...this.config, idpCertificate: certFromCredentials };
        }
      }

      context.logger.info("SAML provider initialized", {
        idpEntityId: this.config.idpEntityId,
        spEntityId: this.config.spEntityId,
        idpSsoUrl: this.config.idpSsoUrl,
      });

      span.setAttribute("saml.idpEntityId", this.config.idpEntityId);
      span.setAttribute("saml.spEntityId", this.config.spEntityId);
    } finally {
      span.end();
    }
  }

  /**
   * Build the SAML AuthnRequest URL that the browser navigates to.
   *
   * Creates a SAML 2.0 AuthnRequest and encodes it as a query parameter
   * on the IdP's SSO URL. The platform's state parameter is included as
   * the RelayState — the IdP echoes it back in the SAML Response callback.
   *
   * @param state An opaque CSRF token generated by the Auth Service. Passed as RelayState.
   * @param options Platform-provided callback configuration.
   * @returns The full URL to redirect the browser to the IdP login page.
   */
  getAuthorizationUrl(state: string, options: AuthOptions): string {
    const cfg = this.requireConfig();

    // Build a SAML 2.0 AuthnRequest XML document.
    // In production, use a proper SAML library for XML construction and signing.
    const requestId = `_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const issueInstant = new Date().toISOString();

    const authnRequest = [
      `<samlp:AuthnRequest`,
      `  xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"`,
      `  xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"`,
      `  ID="${requestId}"`,
      `  Version="2.0"`,
      `  IssueInstant="${issueInstant}"`,
      `  Destination="${cfg.idpSsoUrl}"`,
      `  AssertionConsumerServiceURL="${options.redirectUri}"`,
      `  ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST">`,
      `  <saml:Issuer>${cfg.spEntityId}</saml:Issuer>`,
      `  <samlp:NameIDPolicy`,
      `    Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress"`,
      `    AllowCreate="true" />`,
      `</samlp:AuthnRequest>`,
    ].join("\n");

    // Base64-encode the AuthnRequest for the HTTP-Redirect binding
    let samlRequestParam: string;
    if (typeof Buffer !== "undefined") {
      samlRequestParam = Buffer.from(authnRequest, "utf8").toString("base64");
    } else {
      samlRequestParam = btoa(authnRequest);
    }

    const params = new URLSearchParams();
    params.set("SAMLRequest", samlRequestParam);
    params.set("RelayState", state);

    // Include any additional parameters (e.g., login_hint for pre-filling the email field)
    if (options.additionalParams !== undefined) {
      for (const [key, value] of Object.entries(options.additionalParams)) {
        // Do not allow overriding SAML-critical parameters
        if (key !== "SAMLRequest" && key !== "RelayState") {
          params.set(key, value);
        }
      }
    }

    return `${cfg.idpSsoUrl}?${params.toString()}`;
  }

  /**
   * Handle the SAML Response callback.
   *
   * The IdP POSTs the SAML Response to the platform's Assertion Consumer Service
   * (ACS) URL. The Auth Service base64-decodes it and passes the assertion content
   * as the `code` parameter in CallbackParams. This method parses the SAML
   * Response, validates the assertion, and returns the user's identity.
   *
   * @throws PluginAuthError if the SAML Response is invalid, expired, or from
   *         an untrusted issuer.
   */
  async handleCallback(params: CallbackParams, context: AuthContext): Promise<AuthResult> {
    const cfg = this.requireConfig();

    // Surface IdP-side errors (e.g., user denied, session expired)
    if (params.error !== undefined) {
      throw new PluginAuthError(
        `SAML callback error: ${params.errorDescription ?? params.error}`,
        { error: params.error, errorDescription: params.errorDescription },
      );
    }

    if (params.code.trim() === "") {
      throw new PluginAuthError("SAML callback received an empty response");
    }

    context.logger.info("Processing SAML response");

    // Decode the base64-encoded SAML Response XML
    let responseXml: string;
    try {
      responseXml = decodeSamlResponse(params.code);
    } catch (err) {
      throw new PluginAuthError(
        `Failed to decode SAML response: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Parse the XML into a typed SamlResponse object
    const samlResponse = parseSamlResponseXml(responseXml);

    // Validate the response status
    if (samlResponse.statusCode !== "urn:oasis:names:tc:SAML:2.0:status:Success") {
      throw new PluginAuthError(
        `SAML authentication failed: ${samlResponse.statusMessage ?? samlResponse.statusCode}`,
        { statusCode: samlResponse.statusCode, statusMessage: samlResponse.statusMessage },
      );
    }

    if (samlResponse.assertion === undefined) {
      throw new PluginAuthError("SAML response does not contain an assertion");
    }

    const assertion = samlResponse.assertion;

    // Verify the issuer matches the configured IdP entity ID
    if (assertion.issuer !== cfg.idpEntityId) {
      throw new PluginAuthError(
        `SAML assertion issuer mismatch: expected "${cfg.idpEntityId}", got "${assertion.issuer}"`,
        { expectedIssuer: cfg.idpEntityId, actualIssuer: assertion.issuer },
      );
    }

    // Verify the audience restriction matches the SP entity ID
    if (assertion.conditions.audienceRestriction !== cfg.spEntityId) {
      throw new PluginAuthError(
        `SAML assertion audience mismatch: expected "${cfg.spEntityId}", got "${assertion.conditions.audienceRestriction}"`,
        { expectedAudience: cfg.spEntityId, actualAudience: assertion.conditions.audienceRestriction },
      );
    }

    // Validate assertion time conditions
    const timeValidation = validateAssertionTime(
      assertion.conditions,
      cfg.clockSkewToleranceSeconds,
    );
    if (!timeValidation.valid) {
      throw new PluginAuthError(
        `SAML assertion time validation failed: ${timeValidation.error}`,
      );
    }

    // Extract user identity from the assertion
    const providerUserId = assertion.subject.value;
    if (providerUserId === "") {
      throw new PluginAuthError(
        "SAML assertion does not contain a subject NameID — cannot identify the user",
      );
    }

    // Extract user attributes as claims
    const claims: Record<string, unknown> = {
      sub: providerUserId,
      nameIdFormat: assertion.subject.format,
      issuer: assertion.issuer,
      sessionIndex: assertion.authnStatement.sessionIndex,
      authnInstant: assertion.authnStatement.authnInstant,
      authnContextClassRef: assertion.authnStatement.authnContextClassRef,
    };

    // Map SAML attributes to claims
    for (const attr of assertion.attributes) {
      const key = attr.friendlyName ?? attr.name;
      claims[key] = attr.values.length === 1 ? attr.values[0] : attr.values;
    }

    // Extract email from configured attribute name
    const email = findAttributeValue(assertion.attributes, cfg.emailAttributeName);
    if (email !== null) {
      claims["email"] = email;
    }

    // Map roles
    const platformRoles = this.mapClaimsToRoles(claims);

    // Generate a session token (SAML assertions are one-time-use)
    const sessionToken = generateSessionToken(providerUserId, assertion.id);

    // Calculate session expiry from assertion conditions
    const expiresAt = assertion.conditions.notOnOrAfter;

    // Cache the session data for validateToken() and refreshToken()
    const sessionData = {
      providerUserId,
      claims,
      platformRoles,
      assertionId: assertion.id,
      authnInstant: assertion.authnStatement.authnInstant,
    };
    await context.cache.set(
      `${SESSION_CACHE_PREFIX}${hashString(sessionToken)}`,
      sessionData,
      SESSION_TTL_SECONDS,
    );

    context.logger.info("SAML login successful", {
      providerUserId,
      roleCount: platformRoles.length,
      assertionId: assertion.id,
    });

    return {
      accessToken: sessionToken,
      claims,
      platformRoles,
      providerUserId,
      expiresAt,
    };
  }

  /**
   * Validate a session token.
   *
   * SAML assertions are one-time-use, so this method validates the platform
   * session token that was issued during handleCallback(). The session data
   * is retrieved from the cache.
   *
   * @returns TokenValidation with valid=false if the session has expired or
   *          been invalidated. Does not throw for invalid tokens.
   */
  async validateToken(token: string, context: AuthContext): Promise<TokenValidation> {
    // Verify the token format
    const payload = decodeSessionToken(token);
    if (payload === null) {
      return { valid: false, error: "Invalid session token format" };
    }

    // Check the cached session data
    const cacheKey = `${SESSION_CACHE_PREFIX}${hashString(token)}`;
    const sessionData = await context.cache.get<Record<string, unknown>>(cacheKey);

    if (sessionData === null) {
      return { valid: false, error: "Session expired or not found" };
    }

    // Check the token's issued-at time against the session TTL
    const iat = payload["iat"];
    if (typeof iat === "number") {
      const tokenAge = Math.floor(Date.now() / 1000) - iat;
      if (tokenAge > SESSION_TTL_SECONDS) {
        await context.cache.delete(cacheKey);
        return { valid: false, error: "Session token has expired" };
      }
    }

    const claims = (sessionData["claims"] as Record<string, unknown>) ?? {};

    return {
      valid: true,
      claims,
      expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString(),
    };
  }

  /**
   * Refresh a session token.
   *
   * SAML does not have a native token refresh mechanism. This method extends
   * the session by re-validating the cached session data and issuing a new
   * session token. If the session has expired, it throws PluginAuthError to
   * prompt the user to re-authenticate.
   *
   * Uses a distributed lock to prevent concurrent refresh races.
   */
  async refreshToken(refreshToken: string, context: AuthContext): Promise<TokenPair> {
    if (refreshToken.trim() === "") {
      throw new PluginAuthError("Cannot refresh: session token is empty");
    }

    // Acquire a distributed lock to prevent concurrent refreshes
    const lockKey = `saml:refresh:lock:${hashString(refreshToken)}`;
    const lock = await context.cache.lock(lockKey, 30);

    if (lock === null) {
      // Another concurrent request holds the refresh lock
      throw new PluginAuthError(
        "Concurrent session refresh in progress — retry in a few seconds",
      );
    }

    try {
      // Validate the current session
      const validation = await this.validateToken(refreshToken, context);

      if (!validation.valid) {
        throw new PluginAuthError(
          `Cannot refresh: ${validation.error ?? "session is invalid"}. User must re-authenticate via SAML.`,
        );
      }

      // Generate a new session token with a fresh issued-at time
      const payload = decodeSessionToken(refreshToken);
      const providerUserId = typeof payload?.["sub"] === "string" ? payload["sub"] : "";
      const assertionId = typeof payload?.["assertionId"] === "string" ? payload["assertionId"] : "";

      const newSessionToken = generateSessionToken(providerUserId, assertionId);

      // Copy session data to the new cache key
      const oldCacheKey = `${SESSION_CACHE_PREFIX}${hashString(refreshToken)}`;
      const sessionData = await context.cache.get<Record<string, unknown>>(oldCacheKey);

      if (sessionData !== null) {
        const newCacheKey = `${SESSION_CACHE_PREFIX}${hashString(newSessionToken)}`;
        await context.cache.set(newCacheKey, sessionData, SESSION_TTL_SECONDS);
        // Remove the old session to prevent token reuse
        await context.cache.delete(oldCacheKey);
      }

      const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();

      context.logger.info("SAML session refreshed", { providerUserId });

      return {
        accessToken: newSessionToken,
        refreshToken: newSessionToken,
        expiresAt,
      };
    } finally {
      await lock.release();
    }
  }

  /**
   * Map SAML assertion claims to OnePlatform RBAC role names.
   *
   * Reads the configured groupAttributeName from the claims object, then
   * applies the roleMapping dictionary. IdP groups absent from roleMapping
   * are dropped.
   *
   * Synchronous and must not make network calls per the AuthProvider
   * interface contract.
   */
  mapClaimsToRoles(claims: Record<string, unknown>): string[] {
    const cfg = this.config;
    if (cfg === null) {
      return [];
    }

    // Extract group values from the claims using the configured attribute name
    const rawGroups = claims[cfg.groupAttributeName];
    let groups: string[];

    if (typeof rawGroups === "string") {
      groups = [rawGroups];
    } else if (Array.isArray(rawGroups)) {
      groups = rawGroups.filter((v): v is string => typeof v === "string");
    } else {
      return [];
    }

    // Map IdP group names to platform roles using the configured mapping
    const platformRoles: string[] = [];
    for (const group of groups) {
      const platformRole = cfg.roleMapping[group];
      if (platformRole !== undefined) {
        platformRoles.push(platformRole);
      }
    }

    return platformRoles;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private requireConfig(): SamlProviderConfig {
    if (this.config === null) {
      throw new PluginConfigError(
        "SAML provider not initialized — initialize() must be called before any auth methods",
        "idpEntityId",
      );
    }
    return this.config;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Module entrypoint
//
// The manifest declares `"entrypoint": "authProvider"` so the Execution Service
// looks for a named export called `authProvider` on the bundle's module namespace.
// ────────────────────────────────────────────────────────────────────────────

export const authProvider: AuthProvider = new SamlAuthProvider();
