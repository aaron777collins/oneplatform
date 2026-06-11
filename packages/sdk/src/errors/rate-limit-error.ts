/**
 * 429 Too Many Requests.
 *
 * Separated from ClientError because it is retryable — the server is telling us
 * to wait, not that the request is wrong.
 */

import { OnePlatformError, type OnePlatformErrorOptions } from './base.js';

export interface RateLimitErrorOptions extends OnePlatformErrorOptions {
  /** Parsed from the Retry-After header. null if not provided by the server. */
  readonly retryAfterSeconds: number | null;
}

export class RateLimitError extends OnePlatformError {
  override readonly statusCode = 429 as const;
  override readonly retryable = true as const;

  /**
   * Seconds until the rate limit window resets.
   * null when the server did not include a Retry-After header.
   */
  readonly retryAfterSeconds: number | null;

  constructor(options: RateLimitErrorOptions) {
    super({ ...options, retryable: true });
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}
