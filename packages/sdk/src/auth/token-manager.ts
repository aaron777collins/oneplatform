/**
 * Token refresh lifecycle management.
 *
 * Wraps a refresh callback with coordination logic so concurrent requests
 * that all fail with 401 trigger exactly one refresh attempt rather than N
 * simultaneous refresh requests. All waiters share the single in-flight
 * refresh promise.
 */

import { AuthError } from '../errors/client-errors.js';

export interface TokenManagerOptions {
  /** Current access token. */
  initialToken: string;
  /** Called when the current token is rejected with 401. Returns a new token or null. */
  refreshFn: () => Promise<string | null>;
}

export class TokenManager {
  private currentToken: string;
  private readonly refreshFn: () => Promise<string | null>;
  private refreshInFlight: Promise<string | null> | null = null;

  constructor(options: TokenManagerOptions) {
    this.currentToken = options.initialToken;
    this.refreshFn = options.refreshFn;
  }

  getToken(): string {
    return this.currentToken;
  }

  /**
   * Refresh the access token. If a refresh is already in-flight, all callers
   * wait on the same promise rather than triggering multiple refresh requests.
   */
  async refresh(): Promise<string> {
    // Deduplicate concurrent refresh calls
    if (this.refreshInFlight === null) {
      this.refreshInFlight = this.refreshFn();
    }

    try {
      const newToken = await this.refreshInFlight;
      if (newToken === null) {
        throw new AuthError({
          code: 'UNAUTHORIZED',
          message: 'Token refresh failed: refresh callback returned null.',
          statusCode: 401,
          retryable: false,
        });
      }

      this.currentToken = newToken;
      // Clear after currentToken is updated so concurrent callers immediately
      // see the fresh token rather than a null in-flight promise.
      this.refreshInFlight = null;
      return newToken;
    } catch (err) {
      // Clear before re-throwing so a caller that enters between the rejection
      // and the finally does not see null and start a duplicate refresh on an
      // already-failed token.
      this.refreshInFlight = null;
      throw err;
    }
  }
}
