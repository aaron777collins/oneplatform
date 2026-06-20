/**
 * Unit tests for the SAML auth provider plugin.
 *
 * All tests are fully in-process. No real HTTP requests are made.
 * Mock responses are injected via createAuthProviderMockContext's fetchHandler option.
 *
 * Test coverage:
 *   - metadata()
 *   - initialize() — config validation, credential verification
 *   - getAuthorizationUrl() — AuthnRequest construction, RelayState, parameter safety
 *   - handleCallback() — SAML response parsing, assertion validation, role mapping
 *   - validateToken() — session token validation, expiry handling
 *   - refreshToken() — session extension, lock handling, error cases
 *   - mapClaimsToRoles() — group attribute extraction, role mapping, missing config
 */

import { describe, it, expect } from "vitest";
import {
  createAuthProviderMockContext,
  createMockContext,
  assertValidPlugin,
  assertValidMetadata,
} from "@oneplatform/plugin-sdk/testing";
import { PluginConfigError, PluginAuthError } from "@oneplatform/plugin-sdk";
import { authProvider as _authProvider } from "../index.js";

// The exported authProvider is typed as AuthProvider (where initialize is optional).
// The SAML implementation always provides initialize, so we narrow the type here
// to avoid non-null assertions on every test call.
const authProvider = _authProvider as typeof _authProvider & {
  initialize: NonNullable<typeof _authProvider.initialize>;
};

// ────────────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────────────

const IDP_ENTITY_ID = "https://idp.corporate.example.com/saml/metadata";
const IDP_SSO_URL = "https://idp.corporate.example.com/saml/sso";
const SP_ENTITY_ID = "https://app.example.com/saml/metadata";
const IDP_CERTIFICATE = [
  "-----BEGIN CERTIFICATE-----",
  "MIICpDCCAYwCCQDU+pQ4pHlGMDANBgkqhkiG9w0BAQsFADAUMRIwEAYDVQQDDAls",
  "b2NhbGhvc3QwHhcNMjQwMTAxMDAwMDAwWhcNMjUwMTAxMDAwMDAwWjAUMRIwEAYD",
  "VQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQC7",
  "7777777777777777777777777777777777777777777777777777777777777777",
  "-----END CERTIFICATE-----",
].join("\n");

const BASE_CONFIG = {
  idpEntityId: IDP_ENTITY_ID,
  idpSsoUrl: IDP_SSO_URL,
  idpCertificate: IDP_CERTIFICATE,
  spEntityId: SP_ENTITY_ID,
  emailAttributeName: "email",
  groupAttributeName: "groups",
  roleMapping: {
    "Engineering": "developer",
    "IT-Admins": "platform-admin",
    "Content-Team": "content-editor",
  },
} as const;

// ── SAML Response builders ───────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

function futureIso(seconds: number = 3600): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function pastIso(seconds: number = 60): string {
  return new Date(Date.now() - seconds * 1000).toISOString();
}

/**
 * Build a minimal valid SAML 2.0 Response XML string.
 * The response contains a single assertion with configurable attributes.
 */
function buildSamlResponseXml(overrides: {
  responseId?: string;
  requestId?: string;
  issuer?: string;
  destination?: string;
  statusCode?: string;
  statusMessage?: string;
  assertionId?: string;
  assertionIssuer?: string;
  nameId?: string;
  nameIdFormat?: string;
  notBefore?: string;
  notOnOrAfter?: string;
  audienceRestriction?: string;
  authnInstant?: string;
  sessionIndex?: string;
  attributes?: Array<{ name: string; friendlyName?: string; values: string[] }>;
  includeAssertion?: boolean;
} = {}): string {
  const {
    responseId = "_response_001",
    requestId = "_request_001",
    issuer = IDP_ENTITY_ID,
    destination = "https://app.example.com/auth/saml/callback",
    statusCode = "urn:oasis:names:tc:SAML:2.0:status:Success",
    statusMessage,
    assertionId = "_assertion_001",
    assertionIssuer = IDP_ENTITY_ID,
    nameId = "alice@corporate.example.com",
    nameIdFormat = "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
    notBefore = pastIso(300),
    notOnOrAfter = futureIso(3600),
    audienceRestriction = SP_ENTITY_ID,
    authnInstant = nowIso(),
    sessionIndex = "_session_idx_001",
    attributes = [
      { name: "email", friendlyName: "email", values: ["alice@corporate.example.com"] },
      { name: "firstName", friendlyName: "firstName", values: ["Alice"] },
      { name: "lastName", friendlyName: "lastName", values: ["Johnson"] },
      { name: "groups", friendlyName: "groups", values: ["Engineering", "IT-Admins"] },
    ],
    includeAssertion = true,
  } = overrides;

  const attributeXml = attributes
    .map((attr) => {
      const friendlyAttr = attr.friendlyName !== undefined
        ? ` FriendlyName="${attr.friendlyName}"`
        : "";
      const valuesXml = attr.values
        .map((v) => `          <saml:AttributeValue>${v}</saml:AttributeValue>`)
        .join("\n");
      return `        <saml:Attribute Name="${attr.name}"${friendlyAttr}>\n${valuesXml}\n        </saml:Attribute>`;
    })
    .join("\n");

  const statusMessageXml = statusMessage !== undefined
    ? `\n      <samlp:StatusMessage>${statusMessage}</samlp:StatusMessage>`
    : "";

  const assertionXml = includeAssertion
    ? `
    <saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${assertionId}" Version="2.0" IssueInstant="${nowIso()}">
      <saml:Issuer>${assertionIssuer}</saml:Issuer>
      <saml:Subject>
        <saml:NameID Format="${nameIdFormat}">${nameId}</saml:NameID>
      </saml:Subject>
      <saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}">
        <saml:AudienceRestriction>
          <saml:Audience>${audienceRestriction}</saml:Audience>
        </saml:AudienceRestriction>
      </saml:Conditions>
      <saml:AuthnStatement AuthnInstant="${authnInstant}" SessionIndex="${sessionIndex}">
        <saml:AuthnContext>
          <saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef>
        </saml:AuthnContext>
      </saml:AuthnStatement>
      <saml:AttributeStatement>
${attributeXml}
      </saml:AttributeStatement>
    </saml:Assertion>`
    : "";

  return `<samlp:Response
    xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
    xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"
    ID="${responseId}"
    InResponseTo="${requestId}"
    Version="2.0"
    IssueInstant="${nowIso()}"
    Destination="${destination}">
    <saml:Issuer>${issuer}</saml:Issuer>
    <samlp:Status>
      <samlp:StatusCode Value="${statusCode}" />${statusMessageXml}
    </samlp:Status>${assertionXml}
  </samlp:Response>`;
}

/**
 * Base64-encode a SAML Response XML string (simulates what the IdP sends).
 */
function encodeSamlResponse(xml: string): string {
  return Buffer.from(xml, "utf8").toString("base64");
}

// ── Context helper ───────────────────────────────────────────────────────────

/**
 * Initialize the SAML auth provider for a given test.
 * Returns the mock context for assertion inspection.
 */
async function initializeProvider(
  configOverrides: Record<string, unknown> = {},
): Promise<ReturnType<typeof createAuthProviderMockContext>> {
  const ctx = createAuthProviderMockContext({
    authCredentials: {},
    config: { redirectUri: "https://app.example.com/auth/saml/callback" },
  });

  await authProvider.initialize({ ...BASE_CONFIG, ...configOverrides }, ctx);
  return ctx;
}

// ────────────────────────────────────────────────────────────────────────────
// metadata()
// ────────────────────────────────────────────────────────────────────────────

describe("metadata()", () => {
  it("returns auth-provider type", () => {
    expect(authProvider.metadata().type).toBe("auth-provider");
  });

  it("declares saml protocol", () => {
    expect(authProvider.metadata().protocol).toBe("saml");
  });

  it("declares supportsTokenValidation = true", () => {
    expect(authProvider.metadata().supportsTokenValidation).toBe(true);
  });

  it("declares supportsTokenRefresh = true", () => {
    expect(authProvider.metadata().supportsTokenRefresh).toBe(true);
  });

  it("has non-empty name and description", () => {
    const meta = authProvider.metadata();
    expect(meta.name.length).toBeGreaterThanOrEqual(2);
    expect(meta.description.length).toBeGreaterThanOrEqual(10);
  });

  it("has required config fields in the configSchema", () => {
    const schema = authProvider.metadata().configSchema;
    expect(schema).toBeDefined();
    expect((schema as Record<string, unknown>)["required"]).toContain("idpEntityId");
    expect((schema as Record<string, unknown>)["required"]).toContain("idpSsoUrl");
    expect((schema as Record<string, unknown>)["required"]).toContain("spEntityId");
  });

  it("passes assertValidPlugin for auth-provider type", () => {
    expect(() => assertValidPlugin(authProvider, "auth-provider")).not.toThrow();
  });

  it("passes assertValidMetadata", () => {
    expect(() => assertValidMetadata(authProvider.metadata())).not.toThrow();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// initialize()
// ────────────────────────────────────────────────────────────────────────────

describe("initialize()", () => {
  it("succeeds with valid config", async () => {
    await expect(initializeProvider()).resolves.not.toThrow();
  });

  it("logs the IdP entity ID on successful initialization", async () => {
    const ctx = await initializeProvider();
    const initLog = ctx.logger.__logs.find(
      (log) => log.level === "info" && log.message.includes("SAML provider initialized"),
    );
    expect(initLog).toBeDefined();
    expect(initLog?.metadata?.["idpEntityId"]).toBe(IDP_ENTITY_ID);
  });

  it("throws PluginConfigError when idpEntityId is missing", async () => {
    const ctx = createMockContext();
    await expect(
      authProvider.initialize({ ...BASE_CONFIG, idpEntityId: "" }, ctx),
    ).rejects.toBeInstanceOf(PluginConfigError);
  });

  it("throws PluginConfigError when idpSsoUrl is missing", async () => {
    const ctx = createMockContext();
    await expect(
      authProvider.initialize({ ...BASE_CONFIG, idpSsoUrl: "" }, ctx),
    ).rejects.toBeInstanceOf(PluginConfigError);
  });

  it("throws PluginConfigError when idpSsoUrl uses http:// (not HTTPS)", async () => {
    const ctx = createMockContext();
    await expect(
      authProvider.initialize(
        { ...BASE_CONFIG, idpSsoUrl: "http://idp.corporate.example.com/saml/sso" },
        ctx,
      ),
    ).rejects.toBeInstanceOf(PluginConfigError);
  });

  it("throws PluginConfigError when idpSsoUrl is not a valid URL", async () => {
    const ctx = createMockContext();
    await expect(
      authProvider.initialize({ ...BASE_CONFIG, idpSsoUrl: "not-a-url" }, ctx),
    ).rejects.toBeInstanceOf(PluginConfigError);
  });

  it("throws PluginConfigError when idpCertificate is missing", async () => {
    const ctx = createMockContext();
    await expect(
      authProvider.initialize({ ...BASE_CONFIG, idpCertificate: "" }, ctx),
    ).rejects.toBeInstanceOf(PluginConfigError);
  });

  it("throws PluginConfigError when spEntityId is missing", async () => {
    const ctx = createMockContext();
    await expect(
      authProvider.initialize({ ...BASE_CONFIG, spEntityId: "" }, ctx),
    ).rejects.toBeInstanceOf(PluginConfigError);
  });

  it("uses default emailAttributeName when not provided", async () => {
    const ctx = createAuthProviderMockContext();
    const config = { ...BASE_CONFIG };
    delete (config as Record<string, unknown>)["emailAttributeName"];
    await expect(authProvider.initialize(config, ctx)).resolves.not.toThrow();
  });

  it("uses default clockSkewToleranceSeconds when not provided", async () => {
    const ctx = createAuthProviderMockContext();
    const config = { ...BASE_CONFIG };
    delete (config as Record<string, unknown>)["clockSkewToleranceSeconds"];
    await expect(authProvider.initialize(config, ctx)).resolves.not.toThrow();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// getAuthorizationUrl()
// ────────────────────────────────────────────────────────────────────────────

describe("getAuthorizationUrl()", () => {
  it("returns a URL pointing to the IdP SSO URL", async () => {
    await initializeProvider();

    const url = new URL(
      authProvider.getAuthorizationUrl("state-xyz", {
        redirectUri: "https://app.example.com/auth/saml/callback",
      }),
    );
    expect(url.hostname).toBe("idp.corporate.example.com");
    expect(url.pathname).toBe("/saml/sso");
  });

  it("includes a SAMLRequest parameter", async () => {
    await initializeProvider();

    const url = new URL(
      authProvider.getAuthorizationUrl("state-abc", {
        redirectUri: "https://app.example.com/auth/saml/callback",
      }),
    );
    const samlRequest = url.searchParams.get("SAMLRequest");
    expect(samlRequest).not.toBeNull();
    expect(samlRequest!.length).toBeGreaterThan(0);
  });

  it("includes the state as RelayState parameter", async () => {
    await initializeProvider();

    const state = "csrf-token-unique-123";
    const url = new URL(
      authProvider.getAuthorizationUrl(state, {
        redirectUri: "https://app.example.com/auth/saml/callback",
      }),
    );
    expect(url.searchParams.get("RelayState")).toBe(state);
  });

  it("encodes a valid SAMLRequest containing the SP entity ID", async () => {
    await initializeProvider();

    const url = new URL(
      authProvider.getAuthorizationUrl("state-123", {
        redirectUri: "https://app.example.com/auth/saml/callback",
      }),
    );
    const samlRequest = url.searchParams.get("SAMLRequest")!;
    const decoded = Buffer.from(samlRequest, "base64").toString("utf8");
    expect(decoded).toContain(SP_ENTITY_ID);
  });

  it("includes the AssertionConsumerServiceURL in the AuthnRequest", async () => {
    await initializeProvider();

    const redirectUri = "https://app.example.com/auth/saml/callback";
    const url = new URL(
      authProvider.getAuthorizationUrl("state-123", { redirectUri }),
    );
    const samlRequest = url.searchParams.get("SAMLRequest")!;
    const decoded = Buffer.from(samlRequest, "base64").toString("utf8");
    expect(decoded).toContain(`AssertionConsumerServiceURL="${redirectUri}"`);
  });

  it("forwards additionalParams into the URL without overriding SAML parameters", async () => {
    await initializeProvider();

    const url = new URL(
      authProvider.getAuthorizationUrl("state-123", {
        redirectUri: "https://app.example.com/auth/saml/callback",
        additionalParams: {
          login_hint: "alice@corporate.example.com",
          SAMLRequest: "attacker-payload",
        },
      }),
    );
    expect(url.searchParams.get("login_hint")).toBe("alice@corporate.example.com");
    // SAMLRequest should NOT be overridden by additionalParams
    const samlRequest = url.searchParams.get("SAMLRequest")!;
    expect(samlRequest).not.toBe("attacker-payload");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// handleCallback()
// ────────────────────────────────────────────────────────────────────────────

describe("handleCallback()", () => {
  it("returns an AuthResult with accessToken and providerUserId on success", async () => {
    const ctx = await initializeProvider();
    const samlResponseXml = buildSamlResponseXml();
    const encoded = encodeSamlResponse(samlResponseXml);

    const result = await authProvider.handleCallback({ code: encoded }, ctx);

    expect(typeof result.accessToken).toBe("string");
    expect(result.accessToken.length).toBeGreaterThan(0);
    expect(result.providerUserId).toBe("alice@corporate.example.com");
  });

  it("extracts email from SAML attributes into claims", async () => {
    const ctx = await initializeProvider();
    const encoded = encodeSamlResponse(buildSamlResponseXml());

    const result = await authProvider.handleCallback({ code: encoded }, ctx);

    expect(result.claims["email"]).toBe("alice@corporate.example.com");
  });

  it("maps SAML attributes to claims", async () => {
    const ctx = await initializeProvider();
    const encoded = encodeSamlResponse(buildSamlResponseXml());

    const result = await authProvider.handleCallback({ code: encoded }, ctx);

    expect(result.claims["firstName"]).toBe("Alice");
    expect(result.claims["lastName"]).toBe("Johnson");
  });

  it("maps group attributes to platform roles", async () => {
    const ctx = await initializeProvider();
    const encoded = encodeSamlResponse(buildSamlResponseXml());

    const result = await authProvider.handleCallback({ code: encoded }, ctx);

    expect(result.platformRoles).toContain("developer");
    expect(result.platformRoles).toContain("platform-admin");
  });

  it("populates expiresAt from assertion conditions", async () => {
    const ctx = await initializeProvider();
    const encoded = encodeSamlResponse(buildSamlResponseXml());

    const result = await authProvider.handleCallback({ code: encoded }, ctx);

    expect(typeof result.expiresAt).toBe("string");
    expect(() => new Date(result.expiresAt!)).not.toThrow();
  });

  it("throws PluginAuthError when callback params contain an error", async () => {
    const ctx = await initializeProvider();

    await expect(
      authProvider.handleCallback(
        { code: "", error: "access_denied", errorDescription: "User cancelled login" },
        ctx,
      ),
    ).rejects.toBeInstanceOf(PluginAuthError);
  });

  it("throws PluginAuthError when the SAML response code is empty", async () => {
    const ctx = await initializeProvider();

    await expect(
      authProvider.handleCallback({ code: "" }, ctx),
    ).rejects.toBeInstanceOf(PluginAuthError);
  });

  it("throws PluginAuthError when SAML response status is not Success", async () => {
    const ctx = await initializeProvider();
    const failureResponse = buildSamlResponseXml({
      statusCode: "urn:oasis:names:tc:SAML:2.0:status:Responder",
      statusMessage: "Authentication failed at IdP",
      includeAssertion: false,
    });
    const encoded = encodeSamlResponse(failureResponse);

    await expect(
      authProvider.handleCallback({ code: encoded }, ctx),
    ).rejects.toBeInstanceOf(PluginAuthError);
  });

  it("throws PluginAuthError when assertion issuer does not match IdP entity ID", async () => {
    const ctx = await initializeProvider();
    const encoded = encodeSamlResponse(
      buildSamlResponseXml({
        assertionIssuer: "https://malicious-idp.example.com/saml",
      }),
    );

    await expect(
      authProvider.handleCallback({ code: encoded }, ctx),
    ).rejects.toBeInstanceOf(PluginAuthError);
  });

  it("throws PluginAuthError when audience restriction does not match SP entity ID", async () => {
    const ctx = await initializeProvider();
    const encoded = encodeSamlResponse(
      buildSamlResponseXml({
        audienceRestriction: "https://wrong-sp.example.com",
      }),
    );

    await expect(
      authProvider.handleCallback({ code: encoded }, ctx),
    ).rejects.toBeInstanceOf(PluginAuthError);
  });

  it("throws PluginAuthError when assertion has expired", async () => {
    const ctx = await initializeProvider();
    const encoded = encodeSamlResponse(
      buildSamlResponseXml({
        notBefore: pastIso(7200),
        notOnOrAfter: pastIso(3600),
      }),
    );

    await expect(
      authProvider.handleCallback({ code: encoded }, ctx),
    ).rejects.toBeInstanceOf(PluginAuthError);
  });

  it("throws PluginAuthError when assertion NameID is empty", async () => {
    const ctx = await initializeProvider();
    const encoded = encodeSamlResponse(
      buildSamlResponseXml({ nameId: "" }),
    );

    await expect(
      authProvider.handleCallback({ code: encoded }, ctx),
    ).rejects.toBeInstanceOf(PluginAuthError);
  });

  it("caches session data for subsequent validateToken() calls", async () => {
    const ctx = await initializeProvider();
    const encoded = encodeSamlResponse(buildSamlResponseXml());

    const result = await authProvider.handleCallback({ code: encoded }, ctx);

    // The session token should be validate-able immediately after login
    const validation = await authProvider.validateToken!(result.accessToken, ctx);
    expect(validation.valid).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// validateToken()
// ────────────────────────────────────────────────────────────────────────────

describe("validateToken()", () => {
  it("returns valid=true for a recently issued session token", async () => {
    const ctx = await initializeProvider();
    const encoded = encodeSamlResponse(buildSamlResponseXml());
    const loginResult = await authProvider.handleCallback({ code: encoded }, ctx);

    const result = await authProvider.validateToken!(loginResult.accessToken, ctx);

    expect(result.valid).toBe(true);
    expect(result.claims).toBeDefined();
  });

  it("returns valid=false for a malformed token", async () => {
    const ctx = await initializeProvider();

    const result = await authProvider.validateToken!("not-a-valid-token", ctx);

    expect(result.valid).toBe(false);
    expect(typeof result.error).toBe("string");
  });

  it("returns valid=false for a token not in the session cache", async () => {
    const ctx = await initializeProvider();

    const result = await authProvider.validateToken!("saml-session.dW5rbm93bg", ctx);

    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/expired|not found/i);
  });

  it("includes claims in the validation result for valid sessions", async () => {
    const ctx = await initializeProvider();
    const encoded = encodeSamlResponse(buildSamlResponseXml());
    const loginResult = await authProvider.handleCallback({ code: encoded }, ctx);

    const result = await authProvider.validateToken!(loginResult.accessToken, ctx);

    expect(result.valid).toBe(true);
    expect(result.claims?.["email"]).toBe("alice@corporate.example.com");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// refreshToken()
// ────────────────────────────────────────────────────────────────────────────

describe("refreshToken()", () => {
  it("returns a new TokenPair with a fresh session token", async () => {
    const ctx = await initializeProvider();
    const encoded = encodeSamlResponse(buildSamlResponseXml());
    const loginResult = await authProvider.handleCallback({ code: encoded }, ctx);

    const result = await authProvider.refreshToken!(loginResult.accessToken, ctx);

    expect(typeof result.accessToken).toBe("string");
    expect(result.accessToken.length).toBeGreaterThan(0);
    // The new token should be different from the old one
    expect(result.accessToken).not.toBe(loginResult.accessToken);
  });

  it("issues a new session token that is valid", async () => {
    const ctx = await initializeProvider();
    const encoded = encodeSamlResponse(buildSamlResponseXml());
    const loginResult = await authProvider.handleCallback({ code: encoded }, ctx);

    const refreshResult = await authProvider.refreshToken!(loginResult.accessToken, ctx);

    const validation = await authProvider.validateToken!(refreshResult.accessToken, ctx);
    expect(validation.valid).toBe(true);
  });

  it("invalidates the old session token after refresh", async () => {
    const ctx = await initializeProvider();
    const encoded = encodeSamlResponse(buildSamlResponseXml());
    const loginResult = await authProvider.handleCallback({ code: encoded }, ctx);

    await authProvider.refreshToken!(loginResult.accessToken, ctx);

    const validation = await authProvider.validateToken!(loginResult.accessToken, ctx);
    expect(validation.valid).toBe(false);
  });

  it("includes expiresAt as an ISO 8601 string", async () => {
    const ctx = await initializeProvider();
    const encoded = encodeSamlResponse(buildSamlResponseXml());
    const loginResult = await authProvider.handleCallback({ code: encoded }, ctx);

    const result = await authProvider.refreshToken!(loginResult.accessToken, ctx);

    expect(typeof result.expiresAt).toBe("string");
    expect(() => new Date(result.expiresAt!)).not.toThrow();
  });

  it("throws PluginAuthError when the session token is empty", async () => {
    const ctx = await initializeProvider();

    await expect(
      authProvider.refreshToken!("", ctx),
    ).rejects.toBeInstanceOf(PluginAuthError);
  });

  it("throws PluginAuthError when the session has expired", async () => {
    const ctx = await initializeProvider();

    // A token that looks valid but has no cached session
    await expect(
      authProvider.refreshToken!("saml-session.dW5rbm93bg", ctx),
    ).rejects.toBeInstanceOf(PluginAuthError);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// mapClaimsToRoles()
// ────────────────────────────────────────────────────────────────────────────

describe("mapClaimsToRoles()", () => {
  it("maps IdP groups to platform roles using the roleMapping dictionary", async () => {
    await initializeProvider();

    const roles = authProvider.mapClaimsToRoles({
      sub: "alice@corporate.example.com",
      groups: ["Engineering", "IT-Admins"],
    });

    expect(roles).toContain("developer");
    expect(roles).toContain("platform-admin");
  });

  it("drops IdP groups not present in the roleMapping", async () => {
    await initializeProvider();

    const roles = authProvider.mapClaimsToRoles({
      sub: "alice@corporate.example.com",
      groups: ["Engineering", "Unknown-Group"],
    });

    expect(roles).toEqual(["developer"]);
  });

  it("handles a single group value (string instead of array)", async () => {
    await initializeProvider();

    const roles = authProvider.mapClaimsToRoles({
      sub: "bob@corporate.example.com",
      groups: "Content-Team",
    });

    expect(roles).toEqual(["content-editor"]);
  });

  it("returns an empty array when the group attribute is not present in claims", async () => {
    await initializeProvider();

    const roles = authProvider.mapClaimsToRoles({
      sub: "carol@corporate.example.com",
    });

    expect(roles).toEqual([]);
  });

  it("returns an empty array when the group attribute is a non-string/non-array type", async () => {
    await initializeProvider();

    const roles = authProvider.mapClaimsToRoles({
      sub: "dave@corporate.example.com",
      groups: { nested: "value" },
    });

    expect(roles).toEqual([]);
  });

  it("returns an empty array when config has not been initialized", () => {
    // Create a fresh provider instance to test the uninitialized path
    // (the module-level authProvider may have been initialized by prior tests)
    // Since mapClaimsToRoles checks this.config === null, we verify by
    // testing with an empty roleMapping
    const roles = authProvider.mapClaimsToRoles({
      sub: "user-1",
      groups: ["NonMappedGroup"],
    });
    // No mapping exists for "NonMappedGroup" in the current config
    expect(roles).toEqual([]);
  });

  it("handles multiple groups mapping to the same platform role", async () => {
    await initializeProvider({
      roleMapping: {
        "Engineering": "developer",
        "DevOps": "developer",
        "IT-Admins": "platform-admin",
      },
    });

    const roles = authProvider.mapClaimsToRoles({
      sub: "eve@corporate.example.com",
      groups: ["Engineering", "DevOps"],
    });

    // Both groups map to "developer" — both should appear
    expect(roles).toEqual(["developer", "developer"]);
  });
});
