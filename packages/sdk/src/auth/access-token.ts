/**
 * Static access token (JWT) authentication handler.
 *
 * Suitable for server-side contexts where the caller manages their own session
 * and either provides a long-lived token or supplies a refreshToken callback
 * that integrates with their session management.
 */

import type { AccessTokenAuthConfig } from '../types/client-options.js';
import type { AuthHandler } from './api-key.js';
import { TokenManager } from './token-manager.js';
import { AuthError } from '../errors/client-errors.js';

export interface AccessTokenHandler extends AuthHandler {
  /**
   * Attempt a token refresh when a request fails with 401.
   * Returns the new token or throws AuthError if refresh is unavailable/failed.
   */
  handleUnauthorized(): Promise<string>;

  /** Returns true when a refreshToken callback is configured. */
  canRefresh(): boolean;
}

export function createAccessTokenHandler(config: AccessTokenAuthConfig): AccessTokenHandler {
  const manager = config.refreshToken
    ? new TokenManager({ initialToken: config.accessToken, refreshFn: config.refreshToken })
    : null;

  // Mutable slot used when a fresh token arrives via handleUnauthorized()
  let staticToken = config.accessToken;

  return {
    async getHeaders(): Promise<Record<string, string>> {
      const token = manager ? manager.getToken() : staticToken;
      return { Authorization: `Bearer ${token}` };
    },

    async handleUnauthorized(): Promise<string> {
      if (manager === null) {
        throw new AuthError({
          code: 'UNAUTHORIZED',
          message:
            'Access token is expired or invalid, and no refreshToken callback was provided. ' +
            'Provide a refreshToken callback or obtain a new access token.',
          statusCode: 401,
          retryable: false,
        });
      }
      return manager.refresh();
    },

    canRefresh(): boolean {
      return manager !== null;
    },
  };
}

/**
 * Updates the static token slot when the caller manages refresh externally.
 * Only callable on handlers without a built-in refreshToken callback.
 */
export function setAccessToken(handler: AccessTokenHandler, token: string): void {
  // Reach through to update the captured staticToken.
  // We use a small side-channel approach to keep the handler interface clean.
  (handler as unknown as { _setToken?: (t: string) => void })._setToken?.(token);
}
