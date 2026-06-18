/**
 * Internal types for the Kafka streaming connector.
 *
 * These types are not exported from the plugin-sdk — they are implementation
 * details of the built-in connector that lives inside the ingestion service.
 *
 * Kafka connection configuration supports:
 *   - Plain (no auth) for dev/test environments
 *   - SASL/PLAIN and SASL/SCRAM for cloud-managed Kafka (MSK, Confluent)
 *   - TLS (one-way and mutual TLS) for encrypted transport
 */

// ---------------------------------------------------------------------------
// SASL mechanism discriminated union
// ---------------------------------------------------------------------------

export type SaslMechanism = "PLAIN" | "SCRAM-SHA-256" | "SCRAM-SHA-512";

export interface SaslPlainConfig {
  mechanism: "PLAIN";
  username: string;
  password: string;
}

export interface SaslScramConfig {
  mechanism: "SCRAM-SHA-256" | "SCRAM-SHA-512";
  username: string;
  password: string;
}

export type SaslConfig = SaslPlainConfig | SaslScramConfig;

// ---------------------------------------------------------------------------
// TLS configuration
// ---------------------------------------------------------------------------

export interface TlsConfig {
  /**
   * Whether to verify the broker's TLS certificate against trusted CAs.
   * Set to false ONLY for internal test brokers with self-signed certs;
   * never disable in production.
   */
  rejectUnauthorized?: boolean;

  /** PEM-encoded CA certificate, for brokers using a private CA. */
  ca?: string;

  /** PEM-encoded client certificate, for mutual TLS (mTLS). */
  cert?: string;

  /** PEM-encoded client private key, for mutual TLS (mTLS). */
  key?: string;
}

// ---------------------------------------------------------------------------
// Kafka connector configuration schema
// ---------------------------------------------------------------------------

/**
 * Validated connector configuration produced by parseKafkaConfig().
 * All required fields are present and typed; optional fields default to
 * their documented values when absent.
 */
export interface KafkaConnectorConfig {
  /**
   * Comma-separated list of broker addresses in "host:port" format.
   * At least one broker is required; the client will discover the full
   * cluster topology via the initial bootstrap connection.
   */
  brokers: string[];

  /**
   * Client identifier sent to the broker in every request.
   * Useful for tracking this consumer in broker logs and monitoring tools.
   * Defaults to "oneplatform-ingestion".
   */
  clientId: string;

  /**
   * Connection timeout in milliseconds before giving up on the initial
   * broker handshake. Defaults to 10 000 ms.
   */
  connectionTimeoutMs: number;

  /**
   * Request timeout in milliseconds for individual broker round-trips.
   * Defaults to 30 000 ms.
   */
  requestTimeoutMs: number;

  /** Optional SASL authentication. Omit for unauthenticated brokers. */
  sasl?: SaslConfig;

  /** Optional TLS configuration. Omit for plain-text brokers. */
  tls?: TlsConfig;
}
