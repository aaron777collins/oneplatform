// OAuth 2.0 flow orchestration with PKCE.
// Implements the authorization and callback flows from L2 design §4.3, §6.2.
//
// Provider-specific API calls (GitHub/Google) are delegated to the OAuthProvider
// interface below. The actual HTTP implementations will be filled in by the
// platform team when the OAuth feature is activated. The state machine and
// security invariants (PKCE, constant-time state compare, upsert logic) are
// fully implemented here.

import { randomBytes, randomUUID, createHash, timingSafeEqual } from "crypto";
import type { Redis } from "ioredis";
import type pg from "pg";
import type { Logger, EventPublisher } from "@oneplatform/core";
import { encrypt } from "@oneplatform/core";
import type { TokenService } from "./token-service.js";
import type { AuthResult } from "./types.js";
import {
  OAuthProviderDisabledError,
  OAuthStateInvalidError,
  OAuthExchangeFailedError,
  OAuthEmailMissingError,
} from "./errors.js";

// ---------------------------------------------------------------------------
// Provider abstraction
// ---------------------------------------------------------------------------

/**
 * Profile data returned by a provider after token exchange and user fetch.
 * Concrete implementations (GitHub, Google) parse their respective API
 * responses into this canonical shape.
 */
export interface OAuthUserProfile {
  providerUserId: string;
  email: string | null;
  displayName: string | null;
}

/**
 * Tokens obtained from the provider's token endpoint.
 */
export interface OAuthProviderTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
}

/**
 * Contract that every OAuth provider implementation must satisfy.
 * Provider implementations live in src/oauth/ and are injected here.
 */
export interface OAuthProvider {
  readonly name: string;
  /**
   * Build the provider's authorization URL including PKCE challenge.
   */
  buildAuthorizationUrl(params: {
    codeChallenge: string;
    state: string;
    redirectUri: string;
    scopes: string[];
  }): string;
  /**
   * Exchange the authorization code for provider tokens using the PKCE verifier.
   * Throws OAuthExchangeFailedError on provider rejection.
   */
  exchangeCode(params: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<OAuthProviderTokens>;
  /**
   * Fetch the authenticated user's profile using the provider access token.
   * Throws OAuthEmailMissingError if the provider doesn't return an email.
   */
  fetchUserProfile(accessToken: string): Promise<OAuthUserProfile>;
}

// ---------------------------------------------------------------------------
// Redis state payload
// ---------------------------------------------------------------------------

interface OAuthStatePayload {
  provider: string;
  codeVerifier: string;
  redirectUri: string;
  tenantId: string;
}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface OAuthServiceDeps {
  redis: Redis;
  db: pg.Pool;
  tokenService: TokenService;
  logger: Logger;
  events: EventPublisher;
  masterKey: Buffer;
  /**
   * Map of provider name → implementation.
   * Providers are registered at service startup when their env vars are present.
   */
  providers: Map<string, OAuthProvider>;
}

export interface OAuthService {
  getAuthorizationUrl(
    provider: string,
    tenantId: string,
    redirectUri?: string
  ): Promise<{ url: string; state: string }>;
  handleCallback(
    provider: string,
    code: string,
    state: string
  ): Promise<AuthResult>;
}

export function createOAuthService(deps: OAuthServiceDeps): OAuthService {
  const { redis, db, tokenService, logger, events, masterKey, providers } = deps;

  function getBaseUrl(): string {
    return process.env["OP_BASE_URL"] ?? "http://localhost:3000";
  }

  function getDefaultRedirectUri(): string {
    return `${getBaseUrl()}/auth/callback`;
  }

  function getAllowedOrigins(): string[] {
    const raw = process.env["OP_ALLOWED_ORIGINS"];
    if (!raw) return [];
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
  }

  // PKCE: SHA-256 of the verifier, base64url-encoded
  function generateCodeChallenge(verifier: string): string {
    return createHash("sha256")
      .update(verifier)
      .digest()
      .toString("base64url");
  }

  // -------------------------------------------------------------------------
  // Get authorization URL (step 1 of OAuth flow)
  // -------------------------------------------------------------------------

  /**
   * V6-061: Validate that a redirect URI is safe by checking it against
   * allowed origins. Open redirects would let an attacker steal auth codes.
   */
  function validateRedirectUri(uri: string): void {
    const allowedOrigins = getAllowedOrigins();
    // Always allow the platform's own base URL origin
    const baseOrigin = new URL(getBaseUrl()).origin;
    const allAllowed = new Set([baseOrigin, ...allowedOrigins]);

    let parsedUri: URL;
    try {
      parsedUri = new URL(uri);
    } catch {
      throw new OAuthProviderDisabledError(
        `Invalid redirect URI: "${uri}" is not a valid URL.`
      );
    }

    if (!allAllowed.has(parsedUri.origin)) {
      throw new OAuthProviderDisabledError(
        `Redirect URI origin "${parsedUri.origin}" is not in the allowed origins list.`
      );
    }
  }

  async function getAuthorizationUrl(
    providerName: string,
    tenantId: string,
    redirectUri?: string
  ): Promise<{ url: string; state: string }> {
    const provider = providers.get(providerName);
    if (!provider) {
      throw new OAuthProviderDisabledError(
        `OAuth provider "${providerName}" is not configured or not enabled.`
      );
    }

    // PKCE verifier: 32 cryptographically random bytes as base64url
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = generateCodeChallenge(codeVerifier);

    // State: 16 random bytes as hex (32 hex chars)
    const state = randomBytes(16).toString("hex");

    // V6-061: Default to platform callback URL if not specified, and validate
    // any explicitly provided redirect URI against allowed origins.
    const resolvedRedirectUri = redirectUri ?? getDefaultRedirectUri();
    if (redirectUri !== undefined) {
      validateRedirectUri(resolvedRedirectUri);
    }

    const statePayload: OAuthStatePayload = {
      provider: providerName,
      codeVerifier,
      redirectUri: resolvedRedirectUri,
      tenantId,
    };

    // Store state in Redis with 10-minute TTL
    await redis.set(
      `auth:oauth:state:${state}`,
      JSON.stringify(statePayload),
      "EX",
      600
    );

    const scopes = providerName === "github"
      ? ["read:user", "user:email"]
      : ["openid", "email", "profile"];

    const url = provider.buildAuthorizationUrl({
      codeChallenge,
      state,
      redirectUri: resolvedRedirectUri,
      scopes,
    });

    return { url, state };
  }

  // -------------------------------------------------------------------------
  // Handle callback (step 2 of OAuth flow)
  // -------------------------------------------------------------------------

  async function handleCallback(
    providerName: string,
    code: string,
    state: string
  ): Promise<AuthResult> {
    const provider = providers.get(providerName);
    if (!provider) {
      throw new OAuthProviderDisabledError(
        `OAuth provider "${providerName}" is not configured or not enabled.`
      );
    }

    // Step 1: Atomically read and delete the state so it can only be used once.
    // The Lua script is guaranteed atomic by Redis's single-threaded execution
    // model — no two concurrent callbacks for the same state can both read the
    // value before the DEL lands (TOCTOU replay). A pipeline GET+DEL is NOT
    // atomic and was the previous vulnerability (P19-034).
    const getDelScript = `
      local v = redis.call('GET', KEYS[1])
      if v then redis.call('DEL', KEYS[1]) end
      return v
    `;
    const rawPayload = await redis.eval(
      getDelScript,
      1,
      `auth:oauth:state:${state}`,
    ) as string | null;

    if (rawPayload === null) {
      throw new OAuthStateInvalidError(
        "OAuth state parameter is invalid or has expired."
      );
    }

    const statePayload = JSON.parse(rawPayload) as OAuthStatePayload;

    // Step 2: Constant-time state validation (compare provider names)
    // The state value itself was already validated by Redis key lookup.
    // This comparison guards against state substitution across providers.
    const providerA = Buffer.from(providerName.padEnd(32, "\0"));
    const providerB = Buffer.from(statePayload.provider.padEnd(32, "\0"));
    if (
      providerA.length !== providerB.length ||
      !timingSafeEqual(providerA, providerB)
    ) {
      throw new OAuthStateInvalidError(
        "OAuth state provider mismatch."
      );
    }

    // Step 3: Exchange code for provider tokens (with PKCE verifier)
    let providerTokens: OAuthProviderTokens;
    try {
      providerTokens = await provider.exchangeCode({
        code,
        codeVerifier: statePayload.codeVerifier,
        redirectUri: statePayload.redirectUri,
      });
    } catch (err) {
      if (err instanceof OAuthExchangeFailedError) throw err;
      throw new OAuthExchangeFailedError(
        `Provider token exchange failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // Step 4: Fetch user profile
    let userProfile: OAuthUserProfile;
    try {
      userProfile = await provider.fetchUserProfile(
        providerTokens.accessToken
      );
    } catch (err) {
      if (err instanceof OAuthEmailMissingError) throw err;
      throw new OAuthExchangeFailedError(
        `Failed to fetch user profile from ${providerName}.`
      );
    }

    if (!userProfile.email) {
      throw new OAuthEmailMissingError(
        `${providerName} did not return an email address. ` +
          "Ensure the email scope is granted."
      );
    }

    const tenantId = statePayload.tenantId;

    // Step 5: Upsert user + oauth_providers row
    const { userId, isNewUser } = await upsertOAuthUser({
      providerName,
      providerUserId: userProfile.providerUserId,
      email: userProfile.email,
      displayName: userProfile.displayName,
      tenantId,
      providerTokens,
    });

    // Step 6: Issue platform tokens
    const userResult = await db.query<{
      id: string;
      tenant_id: string;
      roles: string[];
      email_verified: boolean;
      email: string;
      display_name: string | null;
    }>(
      "SELECT id, tenant_id, roles, email_verified, email, display_name FROM auth.users WHERE id = $1",
      [userId]
    );
    const user = userResult.rows[0];
    if (!user) {
      throw new Error(`User ${userId} not found after OAuth upsert.`);
    }

    const familyId = randomUUID();
    const sessionId = randomUUID();
    const expiresAt = new Date(
      Date.now() + getRefreshTokenTtlSeconds() * 1_000
    );

    await db.query(
      `INSERT INTO auth.sessions
         (id, user_id, tenant_id, refresh_token_jti, family_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [sessionId, userId, tenantId, randomUUID(), familyId, expiresAt]
    );

    const accessToken = await tokenService.issueAccessToken({
      id: user.id,
      tenantId: user.tenant_id,
      roles: user.roles,
      emailVerified: user.email_verified,
      email: user.email,
      displayName: user.display_name ?? undefined,
    });

    const { token: refreshToken, jti: refreshJti } =
      await tokenService.issueRefreshToken(
        userId,
        tenantId,
        sessionId,
        familyId
      );

    await db.query(
      "UPDATE auth.sessions SET refresh_token_jti = $1 WHERE id = $2",
      [refreshJti, sessionId]
    );

    await events.publish({
      eventType: "auth.session.created",
      eventVersion: "1.0",
      tenantId,
      actor: { type: "user", id: userId },
      data: { userId, sessionId, provider: providerName, isNewUser },
    });

    logger.info("OAuth login completed", {
      provider: providerName,
      userId,
      tenantId,
      isNewUser,
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: getJwtExpirySeconds(),
      userId,
      tenantId,
      isNewUser,
    };
  }

  // -------------------------------------------------------------------------
  // Upsert user + oauth_providers row (L2 design §4.3 upsert logic)
  // -------------------------------------------------------------------------

  async function upsertOAuthUser(params: {
    providerName: string;
    providerUserId: string;
    email: string;
    displayName: string | null;
    tenantId: string;
    providerTokens: OAuthProviderTokens;
  }): Promise<{ userId: string; isNewUser: boolean }> {
    const {
      providerName,
      providerUserId,
      email,
      displayName,
      tenantId,
      providerTokens,
    } = params;

    // Encrypt provider tokens before storage (AES-256-GCM, L2 design §4.3)
    const encryptedAccessToken = await encrypt(
      providerTokens.accessToken,
      masterKey
    );
    const encryptedRefreshToken = providerTokens.refreshToken
      ? await encrypt(providerTokens.refreshToken, masterKey)
      : null;

    const client = await db.connect();
    try {
      await client.query("BEGIN");

      // Case 1: Existing OAuth link
      const existingLink = await client.query<{ user_id: string }>(
        `SELECT user_id FROM auth.oauth_providers
         WHERE provider = $1 AND provider_user_id = $2 AND tenant_id = $3`,
        [providerName, providerUserId, tenantId]
      );

      if (existingLink.rows.length > 0) {
        const existingUserId = existingLink.rows[0]?.user_id;
        if (!existingUserId) throw new Error("OAuth link row missing user_id.");

        // Update tokens
        await client.query(
          `UPDATE auth.oauth_providers
           SET access_token_encrypted = $1,
               refresh_token_encrypted = $2,
               token_expires_at = $3,
               updated_at = now()
           WHERE provider = $4 AND provider_user_id = $5 AND tenant_id = $6`,
          [
            encryptedAccessToken,
            encryptedRefreshToken,
            providerTokens.expiresAt ?? null,
            providerName,
            providerUserId,
            tenantId,
          ]
        );

        await client.query("COMMIT");
        return { userId: existingUserId, isNewUser: false };
      }

      // Case 2: No OAuth link — look for user by email
      const existingUser = await client.query<{ id: string }>(
        "SELECT id FROM auth.users WHERE tenant_id = $1 AND lower(email) = lower($2)",
        [tenantId, email]
      );

      let userId: string;
      let isNewUser: boolean;

      if (existingUser.rows.length > 0) {
        // User exists but not linked — link them
        userId = existingUser.rows[0]?.id ?? "";
        if (!userId) throw new Error("Existing user row missing id.");
        isNewUser = false;
      } else {
        // Case 3: New user — create account (OAuth-verified email = true)
        const userResult = await client.query<{ id: string }>(
          `INSERT INTO auth.users
             (tenant_id, email, email_verified, display_name, roles)
           VALUES ($1, $2, true, $3, ARRAY['viewer'])
           RETURNING id`,
          [tenantId, email.toLowerCase(), displayName]
        );
        userId = userResult.rows[0]?.id ?? "";
        if (!userId) throw new Error("User INSERT returned no id.");
        isNewUser = true;
      }

      // Create OAuth provider link
      await client.query(
        `INSERT INTO auth.oauth_providers
           (user_id, tenant_id, provider, provider_user_id, provider_email,
            access_token_encrypted, refresh_token_encrypted, token_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          userId,
          tenantId,
          providerName,
          providerUserId,
          email,
          encryptedAccessToken,
          encryptedRefreshToken,
          providerTokens.expiresAt ?? null,
        ]
      );

      await client.query("COMMIT");
      return { userId, isNewUser };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  function getJwtExpirySeconds(): number {
    const raw = process.env["OP_JWT_EXPIRY_SECONDS"];
    if (raw === undefined) return 900;
    const parsed = parseInt(raw, 10);
    if (isNaN(parsed) || parsed <= 0) {
      throw new Error(
        `OP_JWT_EXPIRY_SECONDS must be a positive integer, got: "${raw}"`
      );
    }
    return parsed;
  }

  function getRefreshTokenTtlSeconds(): number {
    const raw = process.env["OP_REFRESH_TOKEN_TTL_SECONDS"];
    if (raw === undefined) return 604_800;
    const parsed = parseInt(raw, 10);
    if (isNaN(parsed) || parsed <= 0) {
      throw new Error(
        `OP_REFRESH_TOKEN_TTL_SECONDS must be a positive integer, got: "${raw}"`
      );
    }
    return parsed;
  }

  // -------------------------------------------------------------------------

  return { getAuthorizationUrl, handleCallback };
}
