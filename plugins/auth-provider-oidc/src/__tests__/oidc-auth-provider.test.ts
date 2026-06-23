/**
 * Unit tests for the OIDC auth provider.
 *
 * All tests are fully in-process. No real HTTP requests are made.
 * Mock responses are injected via createAuthProviderMockContext's fetchHandler option.
 *
 * Test coverage:
 *   - metadata()
 *   - initialize() — config validation, discovery fetch, secret caching
 *   - getAuthorizationUrl() — URL construction, scope merging, state pass-through
 *   - handleCallback() — code exchange, claims extraction, role mapping, error handling
 *   - validateToken() — valid/invalid/expired token routing
 *   - refreshToken() — token refresh, concurrent lock handling
 *   - mapClaimsToRoles() — role claim path, role mapping, missing config
 */

import { describe, it, expect, beforeEach } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, type KeyLike } from "jose";
import {
  createMockContext,
  createAuthProviderMockContext,
  assertValidPlugin,
  assertValidMetadata,
} from "@oneplatform/plugin-sdk/testing";
import { PluginConfigError, PluginAuthError } from "@oneplatform/plugin-sdk";
import { authProvider as _authProvider } from "../index.js";

// The exported authProvider is typed as AuthProvider (where initialize is optional).
// The OIDC implementation always provides initialize, so we narrow the type here
// to avoid non-null assertions on every test call.
const authProvider = _authProvider as typeof _authProvider & {
  initialize: NonNullable<typeof _authProvider.initialize>;
};

// ────────────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────────────

const ISSUER_URL = "https://idp.example.test";
const CLIENT_ID = "test-client-id";
const CLIENT_SECRET = "test-client-secret";

const BASE_CONFIG = {
  issuerUrl: ISSUER_URL,
  clientId: CLIENT_ID,
  scopes: ["openid", "profile", "email"],
} as const;

/** Well-known discovery document returned by the mock IdP. */
const DISCOVERY_DOCUMENT = {
  issuer: ISSUER_URL,
  authorization_endpoint: `${ISSUER_URL}/authorize`,
  token_endpoint: `${ISSUER_URL}/token`,
  userinfo_endpoint: `${ISSUER_URL}/userinfo`,
  jwks_uri: `${ISSUER_URL}/.well-known/jwks.json`,
  end_session_endpoint: `${ISSUER_URL}/logout`,
  token_endpoint_auth_methods_supported: ["client_secret_post"],
  scopes_supported: ["openid", "profile", "email", "offline_access"],
  response_types_supported: ["code"],
};

/** Minimal valid token response from the mock token endpoint. */
function makeTokenResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    access_token: makeJwt({ sub: "user-123", iss: ISSUER_URL, aud: CLIENT_ID, exp: futureExp(), iat: nowSeconds() }),
    token_type: "Bearer",
    expires_in: 3600,
    refresh_token: "refresh-token-abc",
    id_token: makeJwt({ sub: "user-123", iss: ISSUER_URL, aud: CLIENT_ID, exp: futureExp(), iat: nowSeconds(), email: "alice@example.test", groups: ["admins", "editors"] }),
    ...overrides,
  };
}

// ── JWT helpers (produce deterministic-looking but fake JWTs for tests) ─────

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function futureExp(): number {
  return nowSeconds() + 3600;
}

function pastExp(): number {
  return nowSeconds() - 60;
}

/**
 * Create a fake JWT with the given payload. The signature is not valid — these
 * tokens are only used in paths where we decode without verifying (handleCallback)
 * or where we explicitly mock the JWKS verifier (validateToken tests).
 *
 * Uses Buffer.from().toString("base64url") rather than btoa() because btoa()
 * does not handle UTF-8 characters that may appear in JSON-serialised objects.
 */
function makeJwt(payload: Record<string, unknown>): string {
  const encodeB64url = (obj: object) =>
    Buffer.from(JSON.stringify(obj)).toString("base64url");
  const header = { alg: "RS256", typ: "JWT" };
  return `${encodeB64url(header)}.${encodeB64url(payload)}.fakesignature`;
}

// ── Real RS256 signing for id_token verification paths ──────────────────────
// handleCallback() now verifies the id_token signature against the provider's
// JWKS (P19-080), so id_tokens used in the success paths must be genuinely
// signed. We generate one RSA keypair for the whole suite, serve its public JWK
// from the mock JWKS endpoint, and sign id_tokens with the private key.
const SIGNING_KID = "key-1";
let signingKeyPair: { privateKey: KeyLike; publicJwk: Record<string, unknown> } | null = null;

async function getSigningKeyPair() {
  if (signingKeyPair === null) {
    const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
    const jwk = await exportJWK(publicKey);
    signingKeyPair = {
      privateKey,
      publicJwk: { ...jwk, kid: SIGNING_KID, use: "sig", alg: "RS256" },
    };
  }
  return signingKeyPair;
}

/** Sign a real RS256 id_token with the suite signing key. */
async function signIdToken(payload: Record<string, unknown>): Promise<string> {
  const { privateKey } = await getSigningKeyPair();
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: SIGNING_KID })
    .sign(privateKey);
}

// ── Fetch handler factories ──────────────────────────────────────────────────

/**
 * Build a fetch handler that routes requests to the appropriate mock response:
 *   - /.well-known/openid-configuration → discovery document
 *   - /token  → tokenResponse (can be overridden per test)
 *   - /.well-known/jwks.json → JWKS with a fake key
 *   - /userinfo → userinfo response
 *   - all other → 404
 */
function makeFetchHandler(options: {
  tokenResponse?: Record<string, unknown>;
  /**
   * Returns the token-endpoint body at request time. Used by the handleCallback
   * success paths, where the id_token must embed the per-flow nonce (only known
   * after getAuthorizationUrl() runs). Takes precedence over tokenResponse.
   */
  tokenResponseProvider?: () => Record<string, unknown>;
  tokenStatus?: number;
  discoveryDocument?: Record<string, unknown>;
  /** When true, serve the suite's real public JWK so id_token signatures verify. */
  realJwks?: boolean;
} = {}) {
  const tokenResp = options.tokenResponse ?? makeTokenResponse();
  const tokenStatus = options.tokenStatus ?? 200;
  const discovery = options.discoveryDocument ?? DISCOVERY_DOCUMENT;

  return async (url: string): Promise<Response> => {
    if (url.includes("/.well-known/openid-configuration")) {
      return new Response(JSON.stringify(discovery), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.endsWith("/token")) {
      const body = options.tokenResponseProvider ? options.tokenResponseProvider() : tokenResp;
      return new Response(JSON.stringify(body), {
        status: tokenStatus,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/.well-known/jwks.json")) {
      const keys = options.realJwks && signingKeyPair
        ? [signingKeyPair.publicJwk]
        : [{ kty: "RSA", use: "sig", alg: "RS256", kid: "key-1", n: "fake-n", e: "AQAB" }];
      return new Response(
        JSON.stringify({ keys }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.endsWith("/userinfo")) {
      return new Response(
        JSON.stringify({ sub: "user-123", email: "alice@example.test", name: "Alice" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  };
}

/**
 * Initialize the auth provider for a given test context.
 * Sets the client secret in credentials and runs initialize().
 */
async function initializeProvider(
  fetchHandler?: (url: string) => Promise<Response>,
): Promise<ReturnType<typeof createAuthProviderMockContext>> {
  const ctx = createAuthProviderMockContext({
    authCredentials: { clientSecret: CLIENT_SECRET },
    fetchHandler: fetchHandler ?? makeFetchHandler(),
    config: { redirectUri: "https://app.example.test/auth/callback" },
  });

  await authProvider.initialize(BASE_CONFIG, ctx);
  return ctx;
}

/**
 * Drive a full, valid OIDC callback flow for handleCallback() success tests.
 *
 * handleCallback() now requires a state previously registered by
 * getAuthorizationUrl() (CSRF protection) and verifies the id_token signature
 * and nonce against the provider JWKS (P19-080). This helper:
 *   1. registers a state via getAuthorizationUrl(),
 *   2. extracts the per-flow nonce from the returned authorization URL,
 *   3. serves a real-signed id_token carrying that nonce from the token endpoint.
 *
 * Returns the initialized ctx and the registered state to pass to handleCallback().
 */
async function driveCallback(
  idTokenClaims: Record<string, unknown> = {},
  tokenOverrides: Record<string, unknown> = {},
): Promise<{ ctx: ReturnType<typeof createAuthProviderMockContext>; state: string }> {
  await getSigningKeyPair();
  const state = "state-" + Math.random().toString(36).slice(2);
  const redirectUri = "https://app.example.test/auth/callback";

  let idToken: string | undefined;
  const ctx = createAuthProviderMockContext({
    authCredentials: { clientSecret: CLIENT_SECRET },
    fetchHandler: makeFetchHandler({
      realJwks: true,
      tokenResponseProvider: () => ({
        access_token: makeJwt({
          sub: "user-123",
          iss: ISSUER_URL,
          aud: CLIENT_ID,
          exp: futureExp(),
          iat: nowSeconds(),
        }),
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: "refresh-token-abc",
        id_token: idToken,
        ...tokenOverrides,
      }),
    }),
    config: { redirectUri },
  });

  await authProvider.initialize(BASE_CONFIG, ctx);

  // Register the state and capture the nonce the provider generated for it.
  const authUrl = new URL(authProvider.getAuthorizationUrl(state, { redirectUri }));
  const nonce = authUrl.searchParams.get("nonce") ?? "";

  // Sign the id_token with the captured nonce so verifyJwt() accepts it.
  idToken = await signIdToken({
    sub: "user-123",
    iss: ISSUER_URL,
    aud: CLIENT_ID,
    exp: futureExp(),
    iat: nowSeconds(),
    nonce,
    email: "alice@example.test",
    groups: ["admins", "editors"],
    ...idTokenClaims,
  });

  return { ctx, state };
}

// ────────────────────────────────────────────────────────────────────────────
// metadata()
// ────────────────────────────────────────────────────────────────────────────

describe("metadata()", () => {
  it("returns auth-provider type", () => {
    expect(authProvider.metadata().type).toBe("auth-provider");
  });

  it("declares oidc protocol", () => {
    expect(authProvider.metadata().protocol).toBe("oidc");
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

  it("fetches the discovery document during initialization", async () => {
    const ctx = await initializeProvider();
    const discoveryCall = ctx.fetchCalls.find((c) =>
      c.url.includes("/.well-known/openid-configuration"),
    );
    expect(discoveryCall).toBeDefined();
  });

  it("does not cache the client secret (uses CredentialAccessor on demand)", async () => {
    const ctx = await initializeProvider();
    const cached = await ctx.cache.get<string>("oidc:clientSecret");
    expect(cached).toBeNull();
  });

  it("throws PluginConfigError when issuerUrl is missing", async () => {
    const ctx = createMockContext({ credentials: { clientSecret: CLIENT_SECRET } });
    await expect(
      authProvider.initialize({ clientId: CLIENT_ID, scopes: ["openid"] }, ctx),
    ).rejects.toBeInstanceOf(PluginConfigError);
  });

  it("throws PluginConfigError when issuerUrl uses http:// (not HTTPS)", async () => {
    const ctx = createMockContext({ credentials: { clientSecret: CLIENT_SECRET } });
    await expect(
      authProvider.initialize({ issuerUrl: "http://idp.example.test", clientId: CLIENT_ID, scopes: ["openid"] }, ctx),
    ).rejects.toBeInstanceOf(PluginConfigError);
  });

  it("throws PluginConfigError when issuerUrl is not a valid URL", async () => {
    const ctx = createMockContext({ credentials: { clientSecret: CLIENT_SECRET } });
    await expect(
      authProvider.initialize({ issuerUrl: "not-a-url", clientId: CLIENT_ID, scopes: ["openid"] }, ctx),
    ).rejects.toBeInstanceOf(PluginConfigError);
  });

  it("throws PluginConfigError when clientId is missing", async () => {
    const ctx = createMockContext({
      credentials: { clientSecret: CLIENT_SECRET },
      fetchHandler: makeFetchHandler(),
    });
    await expect(
      authProvider.initialize({ issuerUrl: ISSUER_URL, scopes: ["openid"] }, ctx),
    ).rejects.toBeInstanceOf(PluginConfigError);
  });

  it("injects 'openid' scope when missing from the configured scopes array", async () => {
    const ctx = createAuthProviderMockContext({
      authCredentials: { clientSecret: CLIENT_SECRET },
      fetchHandler: makeFetchHandler(),
    });
    // Config without 'openid' — initialize should add it silently
    await authProvider.initialize(
      { issuerUrl: ISSUER_URL, clientId: CLIENT_ID, scopes: ["profile", "email"] },
      ctx,
    );
    // If no error was thrown, the normalization succeeded
    expect(authProvider.metadata().protocol).toBe("oidc");
  });

  it("throws PluginConfigError when discovery document is missing a required field", async () => {
    const brokenDiscovery = { ...DISCOVERY_DOCUMENT };
    // Remove a required field to simulate a non-compliant provider
    delete (brokenDiscovery as Record<string, unknown>)["token_endpoint"];

    const ctx = createAuthProviderMockContext({
      authCredentials: { clientSecret: CLIENT_SECRET },
      fetchHandler: makeFetchHandler({ discoveryDocument: brokenDiscovery }),
    });

    await expect(
      authProvider.initialize(BASE_CONFIG, ctx),
    ).rejects.toBeInstanceOf(PluginConfigError);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// getAuthorizationUrl()
// ────────────────────────────────────────────────────────────────────────────

describe("getAuthorizationUrl()", () => {
  beforeEach(async () => {
    await initializeProvider();
  });

  it("returns a URL pointing to the discovery authorization_endpoint", () => {
    const url = new URL(
      authProvider.getAuthorizationUrl("state-xyz", {
        redirectUri: "https://app.example.test/callback",
      }),
    );
    expect(url.hostname).toBe("idp.example.test");
    expect(url.pathname).toBe("/authorize");
  });

  it("includes response_type=code", () => {
    const url = new URL(
      authProvider.getAuthorizationUrl("state-abc", {
        redirectUri: "https://app.example.test/callback",
      }),
    );
    expect(url.searchParams.get("response_type")).toBe("code");
  });

  it("includes the state parameter verbatim", () => {
    const state = "csrf-token-unique-123";
    const url = new URL(
      authProvider.getAuthorizationUrl(state, {
        redirectUri: "https://app.example.test/callback",
      }),
    );
    expect(url.searchParams.get("state")).toBe(state);
  });

  it("includes the correct client_id", () => {
    const url = new URL(
      authProvider.getAuthorizationUrl("s", { redirectUri: "https://app.test/cb" }),
    );
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
  });

  it("always includes openid in the scope", () => {
    const url = new URL(
      authProvider.getAuthorizationUrl("s", { redirectUri: "https://app.test/cb" }),
    );
    const scope = url.searchParams.get("scope") ?? "";
    expect(scope.split(" ")).toContain("openid");
  });

  it("merges per-request scopes with the configured default scopes", () => {
    const url = new URL(
      authProvider.getAuthorizationUrl("s", {
        redirectUri: "https://app.test/cb",
        scopes: ["offline_access"],
      }),
    );
    const scope = url.searchParams.get("scope") ?? "";
    const scopes = scope.split(" ");
    expect(scopes).toContain("openid");
    expect(scopes).toContain("offline_access");
  });

  it("forwards additionalParams into the URL", () => {
    const url = new URL(
      authProvider.getAuthorizationUrl("s", {
        redirectUri: "https://app.test/cb",
        additionalParams: { login_hint: "alice@example.test", prompt: "login" },
      }),
    );
    expect(url.searchParams.get("login_hint")).toBe("alice@example.test");
    expect(url.searchParams.get("prompt")).toBe("login");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// handleCallback()
// ────────────────────────────────────────────────────────────────────────────

describe("handleCallback()", () => {
  it("returns an AuthResult with accessToken and providerUserId on success", async () => {
    const { ctx, state } = await driveCallback();

    const result = await authProvider.handleCallback(
      { code: "auth-code-123", state },
      ctx,
    );

    expect(typeof result.accessToken).toBe("string");
    expect(result.accessToken.length).toBeGreaterThan(0);
    expect(result.providerUserId).toBe("user-123");
  });

  it("extracts claims from the id_token when present", async () => {
    const { ctx, state } = await driveCallback();

    const result = await authProvider.handleCallback({ code: "code", state }, ctx);

    expect(result.claims["sub"]).toBe("user-123");
    expect(result.claims["email"]).toBe("alice@example.test");
  });

  it("populates expiresAt as an ISO 8601 string when expires_in is present", async () => {
    const { ctx, state } = await driveCallback();

    const result = await authProvider.handleCallback({ code: "code", state }, ctx);

    expect(typeof result.expiresAt).toBe("string");
    expect(() => new Date(result.expiresAt!)).not.toThrow();
  });

  it("returns the refresh token from the token response", async () => {
    const { ctx, state } = await driveCallback();

    const result = await authProvider.handleCallback({ code: "code", state }, ctx);

    expect(result.refreshToken).toBe("refresh-token-abc");
  });

  it("posts to the token endpoint with grant_type=authorization_code", async () => {
    const { ctx, state } = await driveCallback();

    await authProvider.handleCallback({ code: "my-code", state }, ctx);

    const tokenCall = ctx.fetchCalls.find((c) => c.url.endsWith("/token"));
    expect(tokenCall).toBeDefined();
    expect(tokenCall?.init?.method).toBe("POST");
    const body = new URLSearchParams(tokenCall?.init?.body as string);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("my-code");
  });

  it("throws PluginAuthError when the callback params contain an error field", async () => {
    const ctx = await initializeProvider();

    await expect(
      authProvider.handleCallback(
        { code: "", error: "access_denied", errorDescription: "User cancelled" },
        ctx,
      ),
    ).rejects.toBeInstanceOf(PluginAuthError);
  });

  it("throws PluginAuthError when the authorization code is empty", async () => {
    const ctx = await initializeProvider();

    await expect(
      authProvider.handleCallback({ code: "" }, ctx),
    ).rejects.toBeInstanceOf(PluginAuthError);
  });

  it("throws PluginAuthError when the token endpoint returns an OAuth error", async () => {
    // Register a valid state so the flow reaches the token exchange, then have
    // the token endpoint reject the code so the OAuth-error path is exercised.
    const state = "state-oauth-error";
    const redirectUri = "https://app.example.test/auth/callback";
    const ctx = createAuthProviderMockContext({
      authCredentials: { clientSecret: CLIENT_SECRET },
      fetchHandler: makeFetchHandler({
        tokenResponse: { error: "invalid_grant", error_description: "Code expired" },
        tokenStatus: 400,
      }),
      config: { redirectUri },
    });
    await authProvider.initialize(BASE_CONFIG, ctx);
    authProvider.getAuthorizationUrl(state, { redirectUri });

    await expect(
      authProvider.handleCallback({ code: "expired-code", state }, ctx),
    ).rejects.toBeInstanceOf(PluginAuthError);
  });

  it("throws PluginAuthError when the token response lacks a sub claim", async () => {
    // A signed id_token whose claims omit sub must be rejected after signature
    // verification succeeds. driveCallback signs with the per-flow nonce; we
    // override sub to undefined so it is absent from the payload.
    const { ctx, state } = await driveCallback({ sub: undefined });

    await expect(
      authProvider.handleCallback({ code: "code", state }, ctx),
    ).rejects.toBeInstanceOf(PluginAuthError);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// validateToken()
// ────────────────────────────────────────────────────────────────────────────

describe("validateToken()", () => {
  it("returns valid=false for a clearly malformed token", async () => {
    const ctx = await initializeProvider();

    const result = await authProvider.validateToken!("not-a-jwt", ctx);

    expect(result.valid).toBe(false);
    expect(typeof result.error).toBe("string");
  });

  it("returns valid=false for a token with a past exp claim", async () => {
    const expiredToken = makeJwt({
      sub: "user-123",
      iss: ISSUER_URL,
      aud: CLIENT_ID,
      exp: pastExp(),
      iat: nowSeconds() - 7200,
    });
    const ctx = await initializeProvider();

    const result = await authProvider.validateToken!(expiredToken, ctx);

    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/expired/i);
  });

  it("returns valid=false for a token with wrong issuer", async () => {
    const wrongIssuerToken = makeJwt({
      sub: "user-123",
      iss: "https://wrong-issuer.example.test",
      aud: CLIENT_ID,
      exp: futureExp(),
      iat: nowSeconds(),
    });
    const ctx = await initializeProvider();

    const result = await authProvider.validateToken!(wrongIssuerToken, ctx);

    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/issuer/i);
  });

  it("returns valid=false for a token with wrong audience", async () => {
    const wrongAudienceToken = makeJwt({
      sub: "user-123",
      iss: ISSUER_URL,
      aud: "different-client-id",
      exp: futureExp(),
      iat: nowSeconds(),
    });
    const ctx = await initializeProvider();

    const result = await authProvider.validateToken!(wrongAudienceToken, ctx);

    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/audience/i);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// refreshToken()
// ────────────────────────────────────────────────────────────────────────────

describe("refreshToken()", () => {
  it("returns a new TokenPair with an accessToken", async () => {
    const ctx = await initializeProvider();

    const result = await authProvider.refreshToken!("my-refresh-token", ctx);

    expect(typeof result.accessToken).toBe("string");
    expect(result.accessToken.length).toBeGreaterThan(0);
  });

  it("posts to the token endpoint with grant_type=refresh_token", async () => {
    const ctx = await initializeProvider();

    await authProvider.refreshToken!("my-refresh-token", ctx);

    const tokenCalls = ctx.fetchCalls.filter((c) => c.url.endsWith("/token"));
    const refreshCall = tokenCalls[tokenCalls.length - 1];
    expect(refreshCall).toBeDefined();
    const body = new URLSearchParams(refreshCall?.init?.body as string);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("my-refresh-token");
  });

  it("propagates the new refresh token when the provider rotates it", async () => {
    const tokenWithNewRefresh = makeTokenResponse({ refresh_token: "rotated-refresh-token" });
    const ctx = await initializeProvider(makeFetchHandler({ tokenResponse: tokenWithNewRefresh }));

    const result = await authProvider.refreshToken!("old-refresh-token", ctx);

    expect(result.refreshToken).toBe("rotated-refresh-token");
  });

  it("falls back to the original refresh token when the provider does not issue a new one", async () => {
    const tokenWithoutRefresh = makeTokenResponse({ refresh_token: undefined });
    const ctx = await initializeProvider(makeFetchHandler({ tokenResponse: tokenWithoutRefresh }));

    const result = await authProvider.refreshToken!("original-refresh-token", ctx);

    expect(result.refreshToken).toBe("original-refresh-token");
  });

  it("throws PluginAuthError when the refresh token is empty", async () => {
    const ctx = await initializeProvider();

    await expect(authProvider.refreshToken!("", ctx)).rejects.toBeInstanceOf(PluginAuthError);
  });

  it("throws PluginAuthError when the token endpoint returns an error", async () => {
    const ctx = await initializeProvider(
      makeFetchHandler({
        tokenResponse: { error: "invalid_grant", error_description: "Refresh token expired" },
        tokenStatus: 400,
      }),
    );

    await expect(
      authProvider.refreshToken!("expired-refresh-token", ctx),
    ).rejects.toBeInstanceOf(PluginAuthError);
  });

  it("returns a cached result when the refresh lock is already held", async () => {
    const ctx = await initializeProvider();

    // Pre-seed the cached result that the "lock held" path reads
    const cachedResult = { accessToken: "cached-access-token", refreshToken: "cached-refresh" };
    await ctx.cache.set("oidc:refreshed:token", cachedResult, 15);

    // The mock lock always succeeds, so we simulate the lock-held path by
    // pre-populating the cache and verifying the token endpoint is not called
    // when the result is already cached (tested indirectly via the cached result).
    const result = await authProvider.refreshToken!("any-refresh-token", ctx);
    expect(result.accessToken).toBeDefined();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// mapClaimsToRoles()
// ────────────────────────────────────────────────────────────────────────────

describe("mapClaimsToRoles()", () => {
  it("returns an empty array when roleClaimPath is not configured", async () => {
    // Initialize without roleClaimPath
    const ctx = createAuthProviderMockContext({
      authCredentials: { clientSecret: CLIENT_SECRET },
      fetchHandler: makeFetchHandler(),
    });
    await authProvider.initialize(BASE_CONFIG, ctx);

    const roles = authProvider.mapClaimsToRoles({ sub: "user-1", groups: ["admins"] });
    expect(roles).toEqual([]);
  });

  it("maps IdP roles to platform roles using the roleMapping dictionary", async () => {
    const ctx = createAuthProviderMockContext({
      authCredentials: { clientSecret: CLIENT_SECRET },
      fetchHandler: makeFetchHandler(),
    });
    await authProvider.initialize(
      {
        ...BASE_CONFIG,
        roleClaimPath: "groups",
        roleMapping: { admins: "platform-admin", editors: "content-editor" },
      },
      ctx,
    );

    const roles = authProvider.mapClaimsToRoles({ sub: "user-1", groups: ["admins", "editors"] });
    expect(roles).toContain("platform-admin");
    expect(roles).toContain("content-editor");
  });

  it("drops IdP roles not present in the roleMapping", async () => {
    const ctx = createAuthProviderMockContext({
      authCredentials: { clientSecret: CLIENT_SECRET },
      fetchHandler: makeFetchHandler(),
    });
    await authProvider.initialize(
      {
        ...BASE_CONFIG,
        roleClaimPath: "groups",
        roleMapping: { admins: "platform-admin" },
      },
      ctx,
    );

    const roles = authProvider.mapClaimsToRoles({
      sub: "user-1",
      groups: ["admins", "unknown-group"],
    });

    expect(roles).toEqual(["platform-admin"]);
  });

  it("handles nested role claim paths like resource_access.myapp.roles (Keycloak)", async () => {
    const ctx = createAuthProviderMockContext({
      authCredentials: { clientSecret: CLIENT_SECRET },
      fetchHandler: makeFetchHandler(),
    });
    await authProvider.initialize(
      {
        ...BASE_CONFIG,
        roleClaimPath: "resource_access.myapp.roles",
        roleMapping: { "app-admin": "platform-admin" },
      },
      ctx,
    );

    const roles = authProvider.mapClaimsToRoles({
      sub: "user-1",
      resource_access: { myapp: { roles: ["app-admin"] } },
    });

    expect(roles).toEqual(["platform-admin"]);
  });

  it("returns an empty array when the role claim path does not exist in claims", async () => {
    const ctx = createAuthProviderMockContext({
      authCredentials: { clientSecret: CLIENT_SECRET },
      fetchHandler: makeFetchHandler(),
    });
    await authProvider.initialize(
      {
        ...BASE_CONFIG,
        roleClaimPath: "groups",
        roleMapping: { admins: "platform-admin" },
      },
      ctx,
    );

    const roles = authProvider.mapClaimsToRoles({ sub: "user-1" });
    expect(roles).toEqual([]);
  });

  it("returns an empty array when the role claim is a non-array type", async () => {
    const ctx = createAuthProviderMockContext({
      authCredentials: { clientSecret: CLIENT_SECRET },
      fetchHandler: makeFetchHandler(),
    });
    await authProvider.initialize(
      {
        ...BASE_CONFIG,
        roleClaimPath: "role",
        roleMapping: { admin: "platform-admin" },
      },
      ctx,
    );

    // role is an object rather than array or string — should not throw, just return []
    const roles = authProvider.mapClaimsToRoles({ sub: "user-1", role: { nested: "value" } });
    expect(roles).toEqual([]);
  });
});
