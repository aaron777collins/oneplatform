/**
 * Authentication and client configuration types.
 *
 * Exactly one auth mode must be active per client instance. The SDK selects
 * the mode at construction time from the provided AuthConfig discriminated union.
 */

export interface ApiKeyAuthConfig {
  /** API key. Must start with "op_live_" or "op_test_". Server-side only. */
  readonly apiKey: string;
}

export interface AccessTokenAuthConfig {
  /**
   * A JWT access token previously obtained from the Auth Service.
   * The SDK sends it as-is and does NOT attempt token refresh on its own.
   * Provide refreshToken to enable automatic refresh on 401.
   */
  readonly accessToken: string;

  /**
   * Invoked when a request fails with 401 Unauthorized.
   * Return a fresh token or null to propagate the original AuthError.
   */
  readonly refreshToken?: () => Promise<string | null>;
}

export interface BrowserPkceConfig {
  /**
   * OAuth client ID registered with the platform Auth Service.
   * Format: "app:{appId}:{tenantId}"
   */
  readonly clientId: string;

  /**
   * Redirect URI after auth code grant.
   * Defaults to window.location.origin + '/auth/callback'.
   */
  readonly redirectUri?: string;

  /** Scopes to request. Default: ['openid', 'profile', 'data:read', 'data:write'] */
  readonly scopes?: string[];

  /**
   * sessionStorage key prefix for tokens.
   * Default: 'op_sdk'
   */
  readonly storagePrefix?: string;
}

/**
 * Browser PKCE auth wrapper. The `browser` key discriminates this type from the
 * server-side auth configs and carries the PKCE configuration.
 *
 * Usage: auth: { browser: { clientId: 'app:my-app:tenant-id' } }
 */
export interface BrowserAuthConfig {
  readonly browser: BrowserPkceConfig;
}

export type AuthConfig = ApiKeyAuthConfig | AccessTokenAuthConfig | BrowserAuthConfig;

export interface RetryPolicy {
  /** Maximum retry attempts (not counting the initial attempt). Default: 3 */
  readonly maxRetries?: number;

  /** Initial backoff delay in ms. Doubles per retry. Default: 500 */
  readonly initialDelayMs?: number;

  /** Maximum backoff delay cap in ms. Default: 30000 */
  readonly maxDelayMs?: number;

  /**
   * HTTP status codes that trigger a retry.
   * Default: [429, 500, 502, 503, 504].
   */
  readonly retryableStatusCodes?: number[];

  /** Apply ±25% random jitter to backoff delays. Default: true */
  readonly jitter?: boolean;
}

export interface ClientOptions {
  /**
   * Base URL of the OnePlatform instance.
   * Must NOT have a trailing slash.
   */
  readonly baseUrl: string;

  /**
   * Authentication configuration.
   * Omit to auto-detect (browser → PKCE, Node.js → throws ConfigurationError).
   */
  readonly auth?: AuthConfig;

  /**
   * Retry policy. Set to false to disable all retry logic.
   * Defaults to sensible values when omitted.
   */
  readonly retry?: RetryPolicy | false;

  /**
   * Per-request timeout in milliseconds. Default: 30000.
   * Set to 0 to disable (not recommended).
   */
  readonly timeout?: number;

  /**
   * Custom fetch implementation. Defaults to globalThis.fetch.
   * Inject a mock here for testing.
   */
  readonly fetch?: typeof globalThis.fetch;

  /** Custom headers merged onto every request. Lower precedence than SDK-managed headers. */
  readonly headers?: Record<string, string>;

  /** SDK diagnostic log level. Default: 'warn' */
  readonly logLevel?: 'debug' | 'info' | 'warn' | 'error' | 'silent';
}

/** Resolved config returned by client.getConfig(). Auth tokens are redacted. */
export interface ResolvedClientConfig {
  readonly baseUrl: string;
  readonly timeout: number;
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error' | 'silent';
  readonly retry: RetryPolicy | false;
  readonly authMode: 'api-key' | 'access-token' | 'browser';
}
