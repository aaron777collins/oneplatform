/**
 * OIDC provider discovery.
 *
 * Fetches and caches the /.well-known/openid-configuration document published
 * by every compliant OIDC provider. All endpoint URLs used by the plugin come
 * from this document rather than being hard-coded, which is how the plugin
 * stays compatible with Okta, Azure AD, Auth0, Google Workspace, and Keycloak
 * without provider-specific branches.
 *
 * Cache strategy: discovery documents rarely change. We cache for jwksCacheTtlSeconds
 * (default 3600s). The CacheAccessor namespace keeps the cached doc scoped to this
 * plugin instance, so two instances pointing at different issuers never collide.
 */

import type { FetchProxy, CacheAccessor, PluginLogger } from "@oneplatform/plugin-sdk";
import { PluginAuthError, PluginConfigError, PluginTimeoutError } from "@oneplatform/plugin-sdk";

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

/** Subset of RFC 8414 / OIDC Core discovery fields used by this plugin. */
export interface OidcDiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  jwks_uri: string;
  /** Optional: present on Keycloak, Auth0, some Okta orgs. */
  end_session_endpoint?: string;
  /** Token endpoint auth methods the provider supports. */
  token_endpoint_auth_methods_supported?: string[];
  /** Scopes the provider supports. Informational only. */
  scopes_supported?: string[];
  /** Response types the provider supports. */
  response_types_supported?: string[];
}

// ────────────────────────────────────────────────────────────────────────────
// Cache key
// ────────────────────────────────────────────────────────────────────────────

const DISCOVERY_CACHE_KEY = "oidc:discovery";

// ────────────────────────────────────────────────────────────────────────────
// Fetch and validate
// ────────────────────────────────────────────────────────────────────────────

/**
 * Build the well-known configuration URL from the issuer URL.
 *
 * Per OIDC Discovery 1.0 §4, the path is {issuer}/.well-known/openid-configuration.
 * Azure AD uses a trailing slash on the issuer but the spec requires we strip it
 * before appending the path — we normalise here rather than in every caller.
 */
export function buildDiscoveryUrl(issuerUrl: string): string {
  const base = issuerUrl.endsWith("/") ? issuerUrl.slice(0, -1) : issuerUrl;
  return `${base}/.well-known/openid-configuration`;
}

/**
 * Assert a field is a non-empty string. Used for required discovery fields.
 * Throws PluginConfigError so the platform routes the failure to DLQ immediately
 * rather than retrying — a missing endpoint in a well-known doc is not transient.
 */
function requireStringField(doc: Record<string, unknown>, field: string, issuerUrl: string): string {
  const value = doc[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new PluginConfigError(
      `OIDC discovery document from ${issuerUrl} is missing required field "${field}"`,
      field,
    );
  }
  return value;
}

function parseDiscoveryDocument(raw: unknown, issuerUrl: string): OidcDiscoveryDocument {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PluginConfigError(
      `OIDC discovery document from ${issuerUrl} is not a JSON object`,
      "issuerUrl",
    );
  }

  const doc = raw as Record<string, unknown>;

  // These four fields are required by the OIDC Discovery spec.
  const issuer = requireStringField(doc, "issuer", issuerUrl);
  const authorization_endpoint = requireStringField(doc, "authorization_endpoint", issuerUrl);
  const token_endpoint = requireStringField(doc, "token_endpoint", issuerUrl);
  const jwks_uri = requireStringField(doc, "jwks_uri", issuerUrl);

  // userinfo_endpoint is required by OIDC Core but some OAuth2-only issuers omit it.
  // We require it since the plugin exposes getUserInfo() as a first-class method.
  const userinfo_endpoint = requireStringField(doc, "userinfo_endpoint", issuerUrl);

  // Optional fields — read with safe fallbacks.
  const end_session_endpoint =
    typeof doc["end_session_endpoint"] === "string" ? doc["end_session_endpoint"] : undefined;

  const token_endpoint_auth_methods_supported = Array.isArray(
    doc["token_endpoint_auth_methods_supported"],
  )
    ? (doc["token_endpoint_auth_methods_supported"] as string[])
    : undefined;

  const scopes_supported = Array.isArray(doc["scopes_supported"])
    ? (doc["scopes_supported"] as string[])
    : undefined;

  const response_types_supported = Array.isArray(doc["response_types_supported"])
    ? (doc["response_types_supported"] as string[])
    : undefined;

  // exactOptionalPropertyTypes: only include optional fields when they have a value.
  return {
    issuer,
    authorization_endpoint,
    token_endpoint,
    userinfo_endpoint,
    jwks_uri,
    ...(end_session_endpoint !== undefined ? { end_session_endpoint } : {}),
    ...(token_endpoint_auth_methods_supported !== undefined
      ? { token_endpoint_auth_methods_supported }
      : {}),
    ...(scopes_supported !== undefined ? { scopes_supported } : {}),
    ...(response_types_supported !== undefined ? { response_types_supported } : {}),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────────

export interface DiscoveryOptions {
  issuerUrl: string;
  cacheTtlSeconds: number;
  fetch: FetchProxy;
  cache: CacheAccessor;
  logger: PluginLogger;
}

/**
 * Fetch the OIDC discovery document, caching the result for cacheTtlSeconds.
 *
 * On a cache hit the network is not touched — all endpoint URLs are served
 * from cache. On a cache miss (first call or after TTL expiry) the document
 * is fetched, validated, and stored.
 */
export async function fetchDiscoveryDocument(
  options: DiscoveryOptions,
): Promise<OidcDiscoveryDocument> {
  const { issuerUrl, cacheTtlSeconds, fetch, cache, logger } = options;

  const cached = await cache.get<OidcDiscoveryDocument>(DISCOVERY_CACHE_KEY);
  if (cached !== null) {
    logger.debug("OIDC discovery document served from cache", { issuerUrl });
    return cached;
  }

  const discoveryUrl = buildDiscoveryUrl(issuerUrl);
  logger.debug("Fetching OIDC discovery document", { discoveryUrl });

  let response: Response;
  try {
    response = await fetch.fetch(discoveryUrl, {
      headers: { Accept: "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new PluginTimeoutError(
      `Failed to reach OIDC discovery endpoint at ${discoveryUrl}: ${message}`,
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new PluginAuthError(
      `OIDC discovery endpoint returned ${response.status} — check issuerUrl is publicly accessible`,
      { status: response.status, discoveryUrl },
    );
  }

  if (!response.ok) {
    throw new PluginConfigError(
      `OIDC discovery endpoint returned HTTP ${response.status}. Verify issuerUrl is correct: ${issuerUrl}`,
      "issuerUrl",
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new PluginConfigError(
      `OIDC discovery endpoint at ${discoveryUrl} returned non-JSON content`,
      "issuerUrl",
    );
  }

  const document = parseDiscoveryDocument(body, issuerUrl);

  const normalizedConfigured = issuerUrl.endsWith("/") ? issuerUrl.slice(0, -1) : issuerUrl;
  const normalizedDiscovered = document.issuer.endsWith("/")
    ? document.issuer.slice(0, -1)
    : document.issuer;
  if (normalizedDiscovered !== normalizedConfigured) {
    throw new PluginConfigError(
      `OIDC discovery issuer mismatch: configured "${issuerUrl}" but document reports "${document.issuer}". ` +
        `This may indicate a misconfigured issuerUrl or a man-in-the-middle attack.`,
      "issuerUrl",
    );
  }

  logger.info("OIDC discovery document fetched", { issuer: document.issuer });

  await cache.set(DISCOVERY_CACHE_KEY, document, cacheTtlSeconds);
  return document;
}
