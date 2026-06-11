/**
 * Browser PKCE (Proof Key for Code Exchange) OAuth 2.0 flow handler.
 *
 * State machine:
 *   1. Check sessionStorage for a valid (non-expired) access token → use it.
 *   2. Check URL for ?code= callback → exchange code, store tokens, strip URL.
 *   3. Otherwise → initiate PKCE redirect to the Auth Service.
 *
 * Security invariants (§13):
 *   - Tokens stored only in sessionStorage (not localStorage).
 *   - code_verifier used once and deleted after exchange.
 *   - state parameter validated on callback to prevent CSRF.
 *   - X-Requested-With header added to all requests (server CSRF detection).
 */

import type { BrowserPkceConfig } from '../types/client-options.js';
import type { AuthHandler } from './api-key.js';
import { AuthError, ConfigurationError } from '../errors/client-errors.js';

const DEFAULT_SCOPES = ['openid', 'profile', 'data:read', 'data:write'] as const;
const DEFAULT_STORAGE_PREFIX = 'op_sdk';
const ACCESS_TOKEN_EXPIRY_BUFFER_MS = 30_000; // 30s clock skew buffer

interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number; // Unix timestamp ms
}

export interface PkceAuthHandler extends AuthHandler {
  /**
   * Called with the redirect URL when the Auth Service redirects back.
   * Extracts the code, validates state, and exchanges for tokens.
   * Strips the code and state from the URL via history.replaceState().
   */
  handleCallback(callbackUrl: string): Promise<void>;

  /** Returns true if the current access token is valid and not expiring soon. */
  isAuthenticated(): boolean;
}

function storageKey(prefix: string, name: string): string {
  return `${prefix}_${name}`;
}

/**
 * Generate a cryptographically random code verifier for PKCE.
 * Uses 32 bytes → 43-char base64url string (PKCE min is 43 chars).
 */
function generateCodeVerifier(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return base64UrlEncode(array);
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(new Uint8Array(digest));
}

function base64UrlEncode(bytes: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function generateState(): string {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return base64UrlEncode(array);
}

export function createPkceHandler(config: BrowserPkceConfig, baseUrl: string): PkceAuthHandler {
  const prefix = config.storagePrefix ?? DEFAULT_STORAGE_PREFIX;
  const scopes = config.scopes ?? [...DEFAULT_SCOPES];
  const redirectUri =
    config.redirectUri ?? `${window.location.origin}/auth/callback`;

  function getStorage(): Storage {
    // sessionStorage is guaranteed to exist — we check for browser environment in client.ts
    return window.sessionStorage;
  }

  function loadTokens(): StoredTokens | null {
    const raw = getStorage().getItem(storageKey(prefix, 'tokens'));
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as StoredTokens;
    } catch {
      return null;
    }
  }

  function saveTokens(tokens: StoredTokens): void {
    getStorage().setItem(storageKey(prefix, 'tokens'), JSON.stringify(tokens));
  }

  function clearTokens(): void {
    const storage = getStorage();
    storage.removeItem(storageKey(prefix, 'tokens'));
    storage.removeItem(storageKey(prefix, 'code_verifier'));
    storage.removeItem(storageKey(prefix, 'state'));
  }

  function isTokenValid(tokens: StoredTokens): boolean {
    if (!tokens.expiresAt) return true; // No expiry info — assume valid
    return tokens.expiresAt - ACCESS_TOKEN_EXPIRY_BUFFER_MS > Date.now();
  }

  async function initiateFlow(): Promise<void> {
    const verifier = generateCodeVerifier();
    const challenge = await generateCodeChallenge(verifier);
    const state = generateState();

    const storage = getStorage();
    storage.setItem(storageKey(prefix, 'code_verifier'), verifier);
    storage.setItem(storageKey(prefix, 'state'), state);

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: config.clientId,
      redirect_uri: redirectUri,
      scope: scopes.join(' '),
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    });

    window.location.href = `${baseUrl}/api/v1/auth/authorize?${params.toString()}`;
  }

  async function exchangeCode(code: string): Promise<StoredTokens> {
    const storage = getStorage();
    const verifier = storage.getItem(storageKey(prefix, 'code_verifier'));
    if (verifier === null) {
      throw new AuthError({
        code: 'UNAUTHORIZED',
        message: 'PKCE code_verifier not found in sessionStorage. Cannot complete code exchange.',
        statusCode: 401,
        retryable: false,
      });
    }

    const response = await fetch(`${baseUrl}/api/v1/auth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: config.clientId,
        code_verifier: verifier,
      }),
    });

    // Verifier is single-use — delete it immediately after the request, regardless of outcome
    storage.removeItem(storageKey(prefix, 'code_verifier'));

    if (!response.ok) {
      throw new AuthError({
        code: 'UNAUTHORIZED',
        message: `Token exchange failed with status ${response.status}`,
        statusCode: response.status,
        retryable: false,
      });
    }

    const body = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    return {
      accessToken: body.access_token,
      ...(body.refresh_token !== undefined ? { refreshToken: body.refresh_token } : {}),
      ...(body.expires_in !== undefined
        ? { expiresAt: Date.now() + body.expires_in * 1000 }
        : {}),
    };
  }

  async function refreshAccessToken(refreshToken: string): Promise<StoredTokens> {
    const response = await fetch(`${baseUrl}/api/v1/auth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: config.clientId,
      }),
    });

    if (!response.ok) {
      // Refresh token expired — clear stored tokens and force re-auth
      clearTokens();
      throw new AuthError({
        code: 'UNAUTHORIZED',
        message: 'Refresh token expired. Re-authentication required.',
        statusCode: response.status,
        retryable: false,
      });
    }

    const body = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    return {
      accessToken: body.access_token,
      ...(body.refresh_token !== undefined ? { refreshToken: body.refresh_token } : {}),
      ...(body.expires_in !== undefined
        ? { expiresAt: Date.now() + body.expires_in * 1000 }
        : {}),
    };
  }

  // Check for authorization code callback on construction
  const urlParams = new URLSearchParams(window.location.search);
  const callbackCode = urlParams.get('code');
  const callbackState = urlParams.get('state');

  if (callbackCode !== null && callbackState !== null) {
    // Validate state to prevent CSRF before any async work
    const expectedState = window.sessionStorage.getItem(storageKey(prefix, 'state'));
    if (callbackState !== expectedState) {
      throw new AuthError({
        code: 'UNAUTHORIZED',
        message: 'PKCE state mismatch. Possible CSRF attack. Aborting authentication.',
        statusCode: 401,
        retryable: false,
      });
    }

    // Code exchange happens asynchronously — see handleCallback()
    // Strip the query params immediately to avoid re-processing on next render
    const cleanUrl = window.location.pathname + window.location.hash;
    window.history.replaceState(null, '', cleanUrl);
  } else {
    // Check for valid stored token; if none, initiate PKCE flow
    const stored = loadTokens();
    if (stored === null || !isTokenValid(stored)) {
      // Async side-effect: will redirect the browser
      void initiateFlow();
    }
  }

  return {
    async getHeaders(): Promise<Record<string, string>> {
      const stored = loadTokens();

      if (stored !== null && isTokenValid(stored)) {
        return {
          Authorization: `Bearer ${stored.accessToken}`,
          'X-Requested-With': 'XMLHttpRequest',
        };
      }

      // Token expired — attempt silent refresh if we have a refresh token
      if (stored?.refreshToken !== undefined) {
        const refreshed = await refreshAccessToken(stored.refreshToken);
        saveTokens(refreshed);
        return {
          Authorization: `Bearer ${refreshed.accessToken}`,
          'X-Requested-With': 'XMLHttpRequest',
        };
      }

      // No valid token and no refresh token — initiate new PKCE flow
      await initiateFlow();
      // initiateFlow() redirects, so this line is never reached in practice
      throw new AuthError({
        code: 'UNAUTHORIZED',
        message: 'Authentication required. Redirecting to login.',
        statusCode: 401,
        retryable: false,
      });
    },

    async handleCallback(callbackUrl: string): Promise<void> {
      const url = new URL(callbackUrl);
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');

      if (code === null || state === null) {
        throw new ConfigurationError(
          'handleCallback() called with a URL that does not contain "code" and "state" params.',
        );
      }

      const expectedState = getStorage().getItem(storageKey(prefix, 'state'));
      if (state !== expectedState) {
        throw new AuthError({
          code: 'UNAUTHORIZED',
          message: 'PKCE state mismatch in handleCallback(). Possible CSRF attack.',
          statusCode: 401,
          retryable: false,
        });
      }

      getStorage().removeItem(storageKey(prefix, 'state'));

      const tokens = await exchangeCode(code);
      saveTokens(tokens);
    },

    isAuthenticated(): boolean {
      const stored = loadTokens();
      return stored !== null && isTokenValid(stored);
    },
  };
}
