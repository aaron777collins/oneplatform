/**
 * Plugin error taxonomy.
 *
 * These are runtime classes (not just types) because the Execution Service uses
 * instanceof checks to determine retry behavior and routing.
 *
 * Every error a plugin throws should be one of these typed errors. Untyped Error
 * instances are treated as PluginError with isRetryable=false.
 *
 * The plugin bundle must NOT bundle these classes — it uses --external:@oneplatform/plugin-sdk.
 * The Execution Service injects the SDK's runtime exports into the plugin sandbox so that
 * instanceof checks work correctly across the sandbox boundary.
 */

/**
 * Base class for all plugin errors. Do not throw PluginError directly —
 * use one of the typed subclasses below.
 */
export class PluginError extends Error {
  constructor(
    message: string,
    /** Machine-readable error code, e.g., "INVALID_CURSOR". Snake_case, uppercase. */
    public readonly code: string,
    /**
     * Whether the Execution Service should retry this execution.
     * true:  transient failure, retry with backoff (rate limits, timeouts, 5xx)
     * false: permanent failure, route to DLQ immediately (bad config, bad data)
     */
    public readonly isRetryable: boolean,
    /** Structured context for debugging. Never include credential values. */
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = this.constructor.name;
    // Maintain correct prototype chain when transpiled to ES5 or CommonJS
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * The external service returned 401 or 403.
 * isRetryable=false: credential rotation (a human action) is required before retry.
 * The platform surfaces this error in the plugin monitoring dashboard immediately.
 */
export class PluginAuthError extends PluginError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "PLUGIN_AUTH_ERROR", false, details);
  }
}

/**
 * The external service returned 429 (Too Many Requests).
 * isRetryable=true: the Execution Service respects retryAfterSeconds if present,
 * otherwise applies exponential backoff (base 2s, max 300s, jitter ±20%).
 */
export class PluginRateLimitError extends PluginError {
  constructor(
    message: string,
    /** Hint from the external service's Retry-After header, if present. */
    public readonly retryAfterSeconds?: number,
  ) {
    super(message, "PLUGIN_RATE_LIMIT", true, { retryAfterSeconds });
  }
}

/**
 * A network call timed out, or the execution sandbox timeout was reached.
 * isRetryable=true: timeouts are often transient.
 * The platform logs the timeout duration alongside this error for diagnosis.
 */
export class PluginTimeoutError extends PluginError {
  constructor(message: string) {
    super(message, "PLUGIN_TIMEOUT", true);
  }
}

/**
 * The external service returned malformed, unexpected, or unprocessable data.
 * isRetryable=false: the data shape is wrong; retrying will produce the same error.
 * The platform routes the record to the DLQ with the sample attached.
 *
 * Include a sample of the problematic data in the sample parameter for DLQ debugging.
 * Truncate large samples to 1KB.
 */
export class PluginDataError extends PluginError {
  constructor(
    message: string,
    /** A sample of the data that could not be processed. Truncate to 1KB. */
    public readonly sample?: unknown,
  ) {
    super(message, "PLUGIN_DATA_ERROR", false, { sample });
  }
}

/**
 * A required configuration field is missing or has an invalid value.
 * isRetryable=false: configuration is static; retrying without configuration
 * change will produce the same error.
 *
 * Throw this from connect() when a required config field is absent or invalid.
 * Do not throw this from fetchBatch — configuration issues should be caught at
 * connect() time.
 */
export class PluginConfigError extends PluginError {
  constructor(
    message: string,
    /** The name of the config field that is missing or invalid. */
    public readonly field?: string,
  ) {
    super(message, "PLUGIN_CONFIG_ERROR", false, { field });
  }
}
