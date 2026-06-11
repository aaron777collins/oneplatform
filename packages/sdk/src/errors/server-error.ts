/**
 * 5xx Server Error.
 *
 * Retryable — the server is in a bad state that may resolve on retry.
 */

import { OnePlatformError, type OnePlatformErrorOptions } from './base.js';

export class ServerError extends OnePlatformError {
  override readonly retryable = true as const;

  constructor(options: OnePlatformErrorOptions) {
    super({ ...options, retryable: true });
  }
}
