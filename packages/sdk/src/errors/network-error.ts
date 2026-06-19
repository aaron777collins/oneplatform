/**
 * Network-level failure — the request never reached the server or the response
 * body could not be parsed.
 *
 * Retryable: the failure may be transient (DNS hiccup, connection reset, etc.).
 */

import { OnePlatformError } from './base.js';

export type NetworkErrorReason = 'timeout' | 'fetch-failed' | 'parse-failed';

export interface NetworkErrorOptions {
  readonly message: string;
  readonly reason: NetworkErrorReason;
  /** Timeout duration if reason === 'timeout'. */
  readonly timeoutMs?: number;
  /** The underlying exception from fetch(), if available. */
  readonly cause?: unknown;
}

export class NetworkError extends OnePlatformError {
  override readonly retryable = true as const;
  override readonly code = 'SDK_NETWORK_ERROR' as const;

  /**
   * Categorises the nature of the failure so callers can react appropriately:
   * - 'timeout': AbortController fired before response arrived
   * - 'fetch-failed': fetch() threw (DNS failure, connection refused, etc.)
   * - 'parse-failed': response arrived but body could not be parsed
   */
  readonly reason: NetworkErrorReason;

  /** Configured timeout duration in ms, present when reason === 'timeout'. */
  readonly timeoutMs: number | undefined;

  /**
   * The underlying exception that caused this network error, if available.
   * Useful for debugging DNS failures, TLS issues, or other low-level errors
   * without inspecting the stack trace.
   */
  override readonly cause: unknown;

  constructor(options: NetworkErrorOptions) {
    super({
      code: 'SDK_NETWORK_ERROR',
      message: options.message,
      retryable: true,
    });
    this.reason = options.reason;
    this.timeoutMs = options.timeoutMs;
    this.cause = options.cause;
  }
}
