/**
 * SAML 2.0 Authentication Provider Plugin for OnePlatform.
 *
 * Implements the AuthProvider interface from @oneplatform/plugin-sdk to enable
 * SAML-based Single Sign-On. This plugin acts as a SAML 2.0 Service Provider (SP)
 * and can integrate with any SAML 2.0 compliant Identity Provider (Okta, Azure AD,
 * PingFederate, Shibboleth, etc.).
 *
 * The Auth Service handles XML signature verification before calling handleCallback().
 * This plugin is responsible for:
 *   - Building SAML AuthnRequest URLs for browser redirect
 *   - Parsing and validating SAML assertions (time, audience, issuer)
 *   - Extracting user attributes and mapping them to platform roles
 */

import type {
  AuthProvider,
  AuthProviderMetadata,
  AuthOptions,
  CallbackParams,
  AuthContext,
  AuthResult,
  TokenValidation,
  TokenPair,
  PluginContext,
} from "@oneplatform/plugin-sdk";

import type { SamlProviderConfig } from "./types.js";

import {
  decodeSamlResponse,
  parseSamlResponse,
  validateSamlResponse,
  getAttributeValue,
  getAttributeValues,
  attributesToClaims,
} from "./saml-parser.js";

// ────────────────────────────────────────────────────────────────────────────
// Configuration parsing
// ────────────────────────────────────────────────────────────────────────────

/**
 * Parse and validate the raw plugin configuration into a typed SamlProviderConfig.
 * Throws if required fields are missing or malformed.
 */
function parseConfig(raw: Record<string, unknown>): SamlProviderConfig {
  const idpEntityId = raw.idpEntityId;
  if (typeof idpEntityId !== "string" || idpEntityId.length === 0) {
    throw new Error("Configuration error: idpEntityId is required and must be a non-empty string");
  }

  const idpSsoUrl = raw.idpSsoUrl;
  if (typeof idpSsoUrl !== "string" || !idpSsoUrl.startsWith("https://")) {
    throw new Error("Configuration error: idpSsoUrl must be an HTTPS URL");
  }

  const idpCertificate = raw.idpCertificate;
  if (typeof idpCertificate !== "string" || !idpCertificate.includes("BEGIN CERTIFICATE")) {
    throw new Error("Configuration error: idpCertificate must be a PEM-formatted X.509 certificate");
  }

  const spEntityId = raw.spEntityId;
  if (typeof spEntityId !== "string" || spEntityId.length === 0) {
    throw new Error("Configuration error: spEntityId is required and must be a non-empty string");
  }

  const emailAttributeName = raw.emailAttributeName;
  if (typeof emailAttributeName !== "string" || emailAttributeName.length === 0) {
    throw new Error("Configuration error: emailAttributeName is required");
  }

  const groupAttributeName = raw.groupAttributeName;
  if (typeof groupAttributeName !== "string" || groupAttributeName.length === 0) {
    throw new Error("Configuration error: groupAttributeName is required");
  }

  const roleMapping = raw.roleMapping;
  if (typeof roleMapping !== "object" || roleMapping === null || Array.isArray(roleMapping)) {
    throw new Error("Configuration error: roleMapping must be an object mapping IdP groups to platform roles");
  }

  const clockSkewToleranceSeconds =
    typeof raw.clockSkewToleranceSeconds === "number"
      ? raw.clockSkewToleranceSeconds
      : 120;

  return {
    idpEntityId: idpEntityId as string,
    idpSsoUrl: idpSsoUrl as string,
    idpCertificate: idpCertificate as string,
    spEntityId: spEntityId as string,
    emailAttributeName: emailAttributeName as string,
    groupAttributeName: groupAttributeName as string,
    roleMapping: roleMapping as Record<string, string>,
    clockSkewToleranceSeconds,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// SAML AuthnRequest builder
// ────────────────────────────────────────────────────────────────────────────

/**
 * Build a SAML 2.0 AuthnRequest XML document.
 *
 * This is a minimal AuthnRequest that includes the SP entity ID, the IdP
 * destination URL, an assertion consumer service URL, and a unique request ID.
 * The request is base64-encoded and URL-encoded for use in an HTTP-Redirect binding.
 */
function buildAuthnRequest(
  spEntityId: string,
  acsUrl: string,
  requestId: string
): string {
  const issueInstant = new Date().toISOString();

  return [
    '<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"',
    '  xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"',
    `  ID="${requestId}"`,
    '  Version="2.0"',
    `  IssueInstant="${issueInstant}"`,
    `  AssertionConsumerServiceURL="${acsUrl}"`,
    '  ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST">',
    `  <saml:Issuer>${spEntityId}</saml:Issuer>`,
    '  <samlp:NameIDPolicy Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress"',
    '    AllowCreate="true"/>',
    "</samlp:AuthnRequest>",
  ].join("\n");
}

/**
 * Generate a unique request ID for SAML AuthnRequests.
 *
 * SAML 2.0 requires IDs to be globally unique. crypto.randomUUID() provides
 * 122 bits of cryptographic randomness, making collisions computationally
 * infeasible. Math.random() is NOT suitable here — it is not cryptographically
 * secure and its output is predictable, which could allow an attacker to
 * forge or replay SAML AuthnRequests.
 *
 * The SAML spec requires IDs to start with a letter or underscore (NCName rule),
 * so we prefix the UUID with an underscore.
 */
function generateRequestId(): string {
  return `_${crypto.randomUUID()}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Plugin implementation
// ────────────────────────────────────────────────────────────────────────────

/**
 * Create the SAML Auth Provider plugin instance.
 *
 * This is the plugin's entrypoint function, called by the OnePlatform Plugin
 * Service when loading the plugin bundle. It returns an object implementing
 * the AuthProvider interface.
 */
export function createSamlAuthProvider(): AuthProvider {
  let config: SamlProviderConfig | null = null;

  return {
    metadata(): AuthProviderMetadata {
      return {
        id: "com.example.saml-auth-provider",
        name: "SAML 2.0 Auth Provider",
        description:
          "Enables Single Sign-On via SAML 2.0 with any compliant Identity Provider including Okta, Azure AD, PingFederate, and Shibboleth.",
        version: "1.0.0",
        author: "OnePlatform Examples",
        type: "auth-provider",
        protocol: "saml",
        supportsTokenValidation: true,
        supportsTokenRefresh: true,
        configSchema: {
          type: "object",
          required: [
            "idpEntityId",
            "idpSsoUrl",
            "idpCertificate",
            "spEntityId",
            "emailAttributeName",
            "groupAttributeName",
            "roleMapping",
          ],
          properties: {
            idpEntityId: {
              type: "string",
              description: "The Identity Provider's SAML entity ID",
            },
            idpSsoUrl: {
              type: "string",
              format: "uri",
              description: "The IdP's Single Sign-On URL (HTTPS required)",
            },
            idpCertificate: {
              type: "string",
              description: "The IdP's X.509 signing certificate in PEM format",
            },
            spEntityId: {
              type: "string",
              description: "This Service Provider's entity ID",
            },
            emailAttributeName: {
              type: "string",
              description: "SAML attribute name containing the user's email address",
            },
            groupAttributeName: {
              type: "string",
              description: "SAML attribute name containing group memberships",
            },
            roleMapping: {
              type: "object",
              additionalProperties: { type: "string" },
              description: "Map of IdP group names to OnePlatform role names",
            },
            clockSkewToleranceSeconds: {
              type: "number",
              minimum: 0,
              maximum: 600,
              default: 120,
              description: "Clock skew tolerance in seconds for assertion validation",
            },
          },
        },
        tags: ["saml", "sso", "enterprise", "authentication"],
      };
    },

    async initialize(
      rawConfig: Record<string, unknown>,
      context: PluginContext
    ): Promise<void> {
      context.logger.info("Initializing SAML auth provider plugin");

      config = parseConfig(rawConfig);

      context.logger.info("SAML auth provider initialized", {
        idpEntityId: config.idpEntityId,
        spEntityId: config.spEntityId,
        roleMappingCount: Object.keys(config.roleMapping).length,
      });
    },

    getAuthorizationUrl(state: string, options: AuthOptions): string {
      if (!config) {
        throw new Error("Plugin not initialized. Call initialize() before getAuthorizationUrl().");
      }

      const requestId = generateRequestId();
      const authnRequest = buildAuthnRequest(
        config.spEntityId,
        options.redirectUri,
        requestId
      );

      // Base64-encode the AuthnRequest for HTTP-Redirect binding
      const encoded = Buffer.from(authnRequest, "utf-8").toString("base64");

      // Build the IdP SSO URL with query parameters
      const url = new URL(config.idpSsoUrl);
      url.searchParams.set("SAMLRequest", encoded);
      url.searchParams.set("RelayState", state);

      // Append any additional parameters from the options
      if (options.additionalParams) {
        for (const [key, value] of Object.entries(options.additionalParams)) {
          url.searchParams.set(key, value);
        }
      }

      return url.toString();
    },

    async handleCallback(
      params: CallbackParams,
      context: AuthContext
    ): Promise<AuthResult> {
      if (!config) {
        throw new Error("Plugin not initialized. Call initialize() before handleCallback().");
      }

      const span = context.tracing.startSpan("saml.handleCallback");

      try {
        // Check for IdP-reported errors
        if (params.error) {
          context.logger.error("SAML callback received error from IdP", {
            error: params.error,
            errorDescription: params.errorDescription,
          });
          throw new Error(
            `SAML authentication failed: ${params.error}${
              params.errorDescription ? ` - ${params.errorDescription}` : ""
            }`
          );
        }

        // The Auth Service passes the base64-decoded SAML assertion via params.code
        // For SAML flows, code contains the decoded assertion value
        const samlResponseXml = decodeSamlResponse(params.code);

        context.logger.debug("Parsing SAML response");
        const samlResponse = parseSamlResponse(samlResponseXml);

        // Validate the response
        const validation = validateSamlResponse(samlResponse, config);
        if (!validation.valid) {
          context.logger.error("SAML response validation failed", {
            errors: validation.errors,
          });
          throw new Error(
            `SAML validation failed: ${validation.errors.join("; ")}`
          );
        }

        const assertion = samlResponse.assertion!;
        span.setAttribute("saml.assertionId", assertion.id);
        span.setAttribute("saml.issuer", assertion.issuer);

        // Extract user attributes
        const email = getAttributeValue(
          assertion.attributes,
          config.emailAttributeName
        );
        if (!email) {
          throw new Error(
            `SAML assertion is missing the email attribute (expected: ${config.emailAttributeName})`
          );
        }

        // Build claims from assertion attributes
        const claims = attributesToClaims(
          assertion.attributes,
          assertion.subject
        );
        claims.email = email;

        // Map IdP groups to platform roles
        const groups = getAttributeValues(
          assertion.attributes,
          config.groupAttributeName
        );
        claims.groups = groups;

        const platformRoles = this.mapClaimsToRoles(claims);

        span.setAttribute("saml.email", email);
        span.setAttribute("saml.roleCount", platformRoles.length);

        // Generate a platform session token. The Auth Service wraps this in
        // a signed JWT — the access token here is the raw SAML session reference
        // that validateToken() can check against the IdP.
        //
        // crypto.randomUUID() is required here: session IDs are security tokens.
        // A predictable ID would allow an attacker to hijack another user's
        // session by guessing or brute-forcing the token.
        const sessionId = `saml_${crypto.randomUUID()}`;

        // Cache the session for token validation
        await context.cache.set(
          `session:${sessionId}`,
          {
            email,
            issuer: assertion.issuer,
            sessionIndex: assertion.authnStatement.sessionIndex,
            authnInstant: assertion.authnStatement.authnInstant,
            claims,
          },
          3600 // 1 hour TTL
        );

        context.logger.info("SAML authentication successful", {
          email,
          roleCount: platformRoles.length,
        });

        return {
          accessToken: sessionId,
          expiresAt: assertion.conditions.notOnOrAfter || undefined,
          claims,
          platformRoles,
          providerUserId: assertion.subject.value,
        };
      } finally {
        span.end();
      }
    },

    async validateToken(
      token: string,
      context: AuthContext
    ): Promise<TokenValidation> {
      const span = context.tracing.startSpan("saml.validateToken");

      try {
        // Look up the cached session
        const session = await context.cache.get<{
          email: string;
          issuer: string;
          sessionIndex: string;
          claims: Record<string, unknown>;
        }>(`session:${token}`);

        if (!session) {
          return {
            valid: false,
            error: "Session not found or expired",
          };
        }

        span.setAttribute("saml.email", session.email);

        return {
          valid: true,
          claims: session.claims,
        };
      } finally {
        span.end();
      }
    },

    async refreshToken(
      refreshToken: string,
      context: AuthContext
    ): Promise<TokenPair> {
      const span = context.tracing.startSpan("saml.refreshToken");

      try {
        // Acquire a lock to prevent concurrent refresh operations
        const lock = await context.cache.lock(`refresh:${refreshToken}`, 30);
        if (!lock) {
          throw new Error("Token refresh is already in progress");
        }

        try {
          // Look up the existing session
          const session = await context.cache.get<{
            email: string;
            issuer: string;
            sessionIndex: string;
            authnInstant: string;
            claims: Record<string, unknown>;
          }>(`session:${refreshToken}`);

          if (!session) {
            throw new Error("Refresh token is invalid or expired");
          }

          // Generate a new session ID using a cryptographically secure source.
          // See the handleCallback comment for why Math.random() must not be used.
          const newSessionId = `saml_${crypto.randomUUID()}`;

          // Cache the new session
          await context.cache.set(`session:${newSessionId}`, session, 3600);

          // Delete the old session
          await context.cache.delete(`session:${refreshToken}`);

          context.logger.info("SAML token refreshed", {
            email: session.email,
          });

          return {
            accessToken: newSessionId,
            refreshToken: newSessionId,
            expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
          };
        } finally {
          await lock.release();
        }
      } finally {
        span.end();
      }
    },

    mapClaimsToRoles(claims: Record<string, unknown>): string[] {
      if (!config) {
        return [];
      }

      const groups = claims.groups;
      if (!Array.isArray(groups)) {
        return [];
      }

      const roles: string[] = [];
      for (const group of groups) {
        if (typeof group === "string" && config.roleMapping[group]) {
          const mappedRole = config.roleMapping[group];
          if (!roles.includes(mappedRole)) {
            roles.push(mappedRole);
          }
        }
      }

      return roles;
    },
  };
}

// Default export for plugin loading
export default createSamlAuthProvider;
