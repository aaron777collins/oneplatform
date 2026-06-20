/**
 * Unit tests for the SAML 2.0 Auth Provider plugin.
 *
 * Uses createMockAuthContext from @oneplatform/plugin-sdk/testing to run
 * entirely in-process without a platform instance. Tests cover the full
 * AuthProvider interface: metadata, authorization URL generation, callback
 * handling, token validation, token refresh, and role mapping.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createMockAuthContext } from "@oneplatform/plugin-sdk/testing";
import type { MockAuthContext } from "@oneplatform/plugin-sdk/testing";
import type { AuthOptions, CallbackParams } from "@oneplatform/plugin-sdk";

import { createSamlAuthProvider } from "../index.js";
import type { SamlProviderConfig } from "../types.js";

// ────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ────────────────────────────────────────────────────────────────────────────

const TEST_CONFIG: SamlProviderConfig = {
  idpEntityId: "https://idp.example.com/saml/metadata",
  idpSsoUrl: "https://idp.example.com/saml/sso",
  idpCertificate: "-----BEGIN CERTIFICATE-----\nMIICpDCCAYwCCQDU+pQ4pHgSpDANBg...\n-----END CERTIFICATE-----",
  spEntityId: "https://app.example.com/saml/metadata",
  emailAttributeName: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
  groupAttributeName: "http://schemas.xmlsoap.org/claims/Group",
  roleMapping: {
    "Platform Admins": "platform-admin",
    "Data Engineers": "data-engineer",
    "Business Analysts": "business-analyst",
    "Everyone": "viewer",
  },
  clockSkewToleranceSeconds: 120,
};

/**
 * Build a valid SAML Response XML for testing.
 * The timestamps are relative to the provided `now` value to allow deterministic testing.
 */
function buildTestSamlResponseXml(options: {
  now?: number;
  issuer?: string;
  audience?: string;
  email?: string;
  groups?: string[];
  nameId?: string;
  statusCode?: string;
} = {}): string {
  const now = options.now ?? Date.now();
  const issuer = options.issuer ?? TEST_CONFIG.idpEntityId;
  const audience = options.audience ?? TEST_CONFIG.spEntityId;
  const email = options.email ?? "jane.doe@example.com";
  const groups = options.groups ?? ["Data Engineers", "Everyone"];
  const nameId = options.nameId ?? email;
  const statusCode = options.statusCode ?? "urn:oasis:names:tc:SAML:2.0:status:Success";

  const issueInstant = new Date(now).toISOString();
  const notBefore = new Date(now - 60000).toISOString();
  const notOnOrAfter = new Date(now + 300000).toISOString();

  const groupAttributes = groups
    .map((g) => `        <saml:AttributeValue>${g}</saml:AttributeValue>`)
    .join("\n");

  return `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
    xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"
    ID="_response_001"
    InResponseTo="_request_001"
    Destination="https://app.example.com/auth/callback"
    IssueInstant="${issueInstant}"
    Version="2.0">
  <saml:Issuer>${issuer}</saml:Issuer>
  <samlp:Status>
    <samlp:StatusCode Value="${statusCode}"/>
  </samlp:Status>
  <saml:Assertion ID="_assertion_001" IssueInstant="${issueInstant}" Version="2.0">
    <saml:Issuer>${issuer}</saml:Issuer>
    <saml:Subject>
      <saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${nameId}</saml:NameID>
    </saml:Subject>
    <saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}">
      <saml:AudienceRestriction>
        <saml:Audience>${audience}</saml:Audience>
      </saml:AudienceRestriction>
    </saml:Conditions>
    <saml:AuthnStatement AuthnInstant="${issueInstant}" SessionIndex="_session_001">
      <saml:AuthnContext>
        <saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef>
      </saml:AuthnContext>
    </saml:AuthnStatement>
    <saml:AttributeStatement>
      <saml:Attribute Name="http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress" FriendlyName="email">
        <saml:AttributeValue>${email}</saml:AttributeValue>
      </saml:Attribute>
      <saml:Attribute Name="http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname" FriendlyName="firstName">
        <saml:AttributeValue>Jane</saml:AttributeValue>
      </saml:Attribute>
      <saml:Attribute Name="http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname" FriendlyName="lastName">
        <saml:AttributeValue>Doe</saml:AttributeValue>
      </saml:Attribute>
      <saml:Attribute Name="http://schemas.xmlsoap.org/claims/Group" FriendlyName="groups">
${groupAttributes}
      </saml:Attribute>
    </saml:AttributeStatement>
  </saml:Assertion>
</samlp:Response>`;
}

/**
 * Base64-encode a SAML Response XML string as the Auth Service would deliver it.
 */
function encodeSamlResponse(xml: string): string {
  return Buffer.from(xml, "utf-8").toString("base64");
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe("SamlAuthProvider", () => {
  let provider: ReturnType<typeof createSamlAuthProvider>;
  let ctx: MockAuthContext;

  beforeEach(async () => {
    provider = createSamlAuthProvider();
    ctx = createMockAuthContext({
      config: TEST_CONFIG as unknown as Record<string, unknown>,
      authCredentials: {
        privateKey: "test-private-key",
      },
    });

    // Initialize the provider with the test configuration
    await provider.initialize!(
      TEST_CONFIG as unknown as Record<string, unknown>,
      ctx
    );
  });

  // ── Metadata ────────────────────────────────────────────────────────────

  describe("metadata()", () => {
    it("should return correct plugin metadata", () => {
      const meta = provider.metadata();

      expect(meta.id).toBe("com.example.saml-auth-provider");
      expect(meta.type).toBe("auth-provider");
      expect(meta.protocol).toBe("saml");
      expect(meta.supportsTokenValidation).toBe(true);
      expect(meta.supportsTokenRefresh).toBe(true);
      expect(meta.version).toBe("1.0.0");
    });

    it("should include a valid configSchema with required fields", () => {
      const meta = provider.metadata();
      const schema = meta.configSchema as Record<string, unknown>;

      expect(schema.type).toBe("object");
      expect(schema.required).toContain("idpEntityId");
      expect(schema.required).toContain("idpSsoUrl");
      expect(schema.required).toContain("spEntityId");
      expect(schema.required).toContain("roleMapping");
    });
  });

  // ── Authorization URL ──────────────────────────────────────────────────

  describe("getAuthorizationUrl()", () => {
    it("should generate a URL pointing to the IdP SSO endpoint", () => {
      const url = provider.getAuthorizationUrl("csrf-state-token", {
        redirectUri: "https://app.example.com/auth/callback",
      });

      expect(url).toContain("https://idp.example.com/saml/sso");
    });

    it("should include a base64-encoded SAMLRequest parameter", () => {
      const url = provider.getAuthorizationUrl("csrf-state-token", {
        redirectUri: "https://app.example.com/auth/callback",
      });

      const parsed = new URL(url);
      const samlRequest = parsed.searchParams.get("SAMLRequest");
      expect(samlRequest).toBeTruthy();

      // Verify the SAMLRequest decodes to valid XML
      const decoded = Buffer.from(samlRequest!, "base64").toString("utf-8");
      expect(decoded).toContain("AuthnRequest");
      expect(decoded).toContain(TEST_CONFIG.spEntityId);
    });

    it("should include the RelayState parameter with the CSRF state", () => {
      const url = provider.getAuthorizationUrl("my-csrf-state", {
        redirectUri: "https://app.example.com/auth/callback",
      });

      const parsed = new URL(url);
      expect(parsed.searchParams.get("RelayState")).toBe("my-csrf-state");
    });

    it("should include additional parameters when provided", () => {
      const options: AuthOptions = {
        redirectUri: "https://app.example.com/auth/callback",
        additionalParams: {
          login_hint: "user@example.com",
        },
      };

      const url = provider.getAuthorizationUrl("state", options);
      const parsed = new URL(url);
      expect(parsed.searchParams.get("login_hint")).toBe("user@example.com");
    });
  });

  // ── Callback Handling ──────────────────────────────────────────────────

  describe("handleCallback()", () => {
    it("should process a valid SAML response and return an AuthResult", async () => {
      const now = Date.now();
      const xml = buildTestSamlResponseXml({ now });
      const encoded = encodeSamlResponse(xml);

      const params: CallbackParams = {
        code: encoded,
        state: "csrf-state",
      };

      const result = await provider.handleCallback(params, ctx);

      expect(result.providerUserId).toBe("jane.doe@example.com");
      expect(result.claims.email).toBe("jane.doe@example.com");
      expect(result.platformRoles).toContain("data-engineer");
      expect(result.platformRoles).toContain("viewer");
      expect(result.accessToken).toBeTruthy();
    });

    it("should extract the email from the configured attribute", async () => {
      const xml = buildTestSamlResponseXml({
        email: "alice.smith@acme-corp.com",
        nameId: "alice.smith@acme-corp.com",
      });
      const encoded = encodeSamlResponse(xml);

      const result = await provider.handleCallback(
        { code: encoded },
        ctx
      );

      expect(result.claims.email).toBe("alice.smith@acme-corp.com");
      expect(result.providerUserId).toBe("alice.smith@acme-corp.com");
    });

    it("should map IdP groups to platform roles correctly", async () => {
      const xml = buildTestSamlResponseXml({
        groups: ["Platform Admins", "Everyone"],
      });
      const encoded = encodeSamlResponse(xml);

      const result = await provider.handleCallback(
        { code: encoded },
        ctx
      );

      expect(result.platformRoles).toContain("platform-admin");
      expect(result.platformRoles).toContain("viewer");
      expect(result.platformRoles).not.toContain("data-engineer");
    });

    it("should throw when the SAML response has an error status", async () => {
      const params: CallbackParams = {
        code: "unused",
        error: "access_denied",
        errorDescription: "User denied consent",
      };

      await expect(
        provider.handleCallback(params, ctx)
      ).rejects.toThrow("SAML authentication failed: access_denied - User denied consent");
    });

    it("should throw when the assertion issuer does not match", async () => {
      const xml = buildTestSamlResponseXml({
        issuer: "https://wrong-idp.example.com/saml/metadata",
      });
      const encoded = encodeSamlResponse(xml);

      await expect(
        provider.handleCallback({ code: encoded }, ctx)
      ).rejects.toThrow("SAML validation failed");
    });

    it("should throw when the audience restriction does not match", async () => {
      const xml = buildTestSamlResponseXml({
        audience: "https://wrong-sp.example.com",
      });
      const encoded = encodeSamlResponse(xml);

      await expect(
        provider.handleCallback({ code: encoded }, ctx)
      ).rejects.toThrow("SAML validation failed");
    });

    it("should cache the session after successful authentication", async () => {
      const xml = buildTestSamlResponseXml();
      const encoded = encodeSamlResponse(xml);

      const result = await provider.handleCallback(
        { code: encoded },
        ctx
      );

      // Verify the session was cached
      const cached = await ctx.cache.get(`session:${result.accessToken}`);
      expect(cached).toBeTruthy();
    });

    it("should create a tracing span for the callback", async () => {
      const xml = buildTestSamlResponseXml();
      const encoded = encodeSamlResponse(xml);

      await provider.handleCallback({ code: encoded }, ctx);

      const span = ctx.tracing.__spans.find(
        (s) => s.name === "saml.handleCallback"
      );
      expect(span).toBeTruthy();
      expect(span!.ended).toBe(true);
    });
  });

  // ── Token Validation ──────────────────────────────────────────────────

  describe("validateToken()", () => {
    it("should return valid=true for a cached session", async () => {
      // First, create a session via handleCallback
      const xml = buildTestSamlResponseXml();
      const encoded = encodeSamlResponse(xml);
      const result = await provider.handleCallback(
        { code: encoded },
        ctx
      );

      // Validate the token
      const validation = await provider.validateToken!(
        result.accessToken,
        ctx
      );

      expect(validation.valid).toBe(true);
      expect(validation.claims).toBeTruthy();
    });

    it("should return valid=false for an unknown token", async () => {
      const validation = await provider.validateToken!(
        "nonexistent-token",
        ctx
      );

      expect(validation.valid).toBe(false);
      expect(validation.error).toContain("Session not found");
    });
  });

  // ── Token Refresh ─────────────────────────────────────────────────────

  describe("refreshToken()", () => {
    it("should generate a new session and invalidate the old one", async () => {
      // Create a session
      const xml = buildTestSamlResponseXml();
      const encoded = encodeSamlResponse(xml);
      const result = await provider.handleCallback(
        { code: encoded },
        ctx
      );

      const oldToken = result.accessToken;

      // Refresh the token
      const refreshed = await provider.refreshToken!(oldToken, ctx);

      expect(refreshed.accessToken).toBeTruthy();
      expect(refreshed.accessToken).not.toBe(oldToken);

      // Old token should be invalidated
      const oldValidation = await provider.validateToken!(oldToken, ctx);
      expect(oldValidation.valid).toBe(false);

      // New token should be valid
      const newValidation = await provider.validateToken!(
        refreshed.accessToken,
        ctx
      );
      expect(newValidation.valid).toBe(true);
    });

    it("should throw when refreshing an invalid token", async () => {
      await expect(
        provider.refreshToken!("invalid-token", ctx)
      ).rejects.toThrow("Refresh token is invalid or expired");
    });
  });

  // ── Role Mapping ──────────────────────────────────────────────────────

  describe("mapClaimsToRoles()", () => {
    it("should map known groups to platform roles", () => {
      const roles = provider.mapClaimsToRoles({
        groups: ["Data Engineers", "Everyone"],
      });

      expect(roles).toContain("data-engineer");
      expect(roles).toContain("viewer");
    });

    it("should return an empty array when no groups are present", () => {
      const roles = provider.mapClaimsToRoles({});
      expect(roles).toEqual([]);
    });

    it("should ignore unknown groups", () => {
      const roles = provider.mapClaimsToRoles({
        groups: ["Unknown Group", "Everyone"],
      });

      expect(roles).toEqual(["viewer"]);
    });

    it("should not produce duplicate roles", () => {
      const roles = provider.mapClaimsToRoles({
        groups: ["Everyone", "Everyone"],
      });

      expect(roles).toEqual(["viewer"]);
    });

    it("should handle non-array groups gracefully", () => {
      const roles = provider.mapClaimsToRoles({
        groups: "not-an-array",
      });

      expect(roles).toEqual([]);
    });
  });
});
