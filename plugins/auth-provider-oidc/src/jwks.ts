/**
 * JWKS (JSON Web Key Set) fetching and JWT verification.
 *
 * OIDC providers publish RSA or EC public keys at the jwks_uri endpoint.
 * We fetch these on first use, cache them for the same TTL as the discovery
 * document, and use the Web Crypto API to verify JWT signatures. Web Crypto
 * is chosen over Node.js crypto because it works inside the isolated-vm sandbox
 * that the Execution Service uses for plugin code.
 *
 * Key rotation handling: if signature verification fails with the cached key set
 * we evict the cache and retry once with a freshly fetched key set. This covers
 * providers like Okta that rotate keys on a schedule without advance notice.
 */

import type { FetchProxy, CacheAccessor, PluginLogger } from "@oneplatform/plugin-sdk";
import { PluginAuthError, PluginConfigError, PluginTimeoutError } from "@oneplatform/plugin-sdk";

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

/** A single JSON Web Key as returned from the jwks_uri endpoint. */
interface JsonWebKey {
  kty: string;
  kid?: string;
  use?: string;
  alg?: string;
  /** RSA modulus (base64url). */
  n?: string;
  /** RSA public exponent (base64url). */
  e?: string;
  /** EC curve name (e.g. "P-256"). */
  crv?: string;
  /** EC x-coordinate (base64url). */
  x?: string;
  /** EC y-coordinate (base64url). */
  y?: string;
}

interface JwksResponse {
  keys: JsonWebKey[];
}

export interface JwtHeader {
  alg: string;
  kid?: string;
  typ?: string;
}

export interface JwtClaims {
  /** Subject — the stable user ID in the identity provider. */
  sub: string;
  /** Issuer — must match the issuerUrl from the discovery document. */
  iss: string;
  /** Audience — must contain our clientId. */
  aud: string | string[];
  /** Expiry (Unix timestamp seconds). */
  exp: number;
  /** Issued-at (Unix timestamp seconds). */
  iat: number;
  /** Nonce for replay prevention (present in id_token flows). */
  nonce?: string;
  /** Arbitrary claims the provider adds (groups, roles, email, etc.). */
  [key: string]: unknown;
}

export interface VerifyOptions {
  issuerUrl: string;
  clientId: string;
  jwksUri: string;
  cacheTtlSeconds: number;
  fetch: FetchProxy;
  cache: CacheAccessor;
  logger: PluginLogger;
  /** When set, the id_token's nonce claim must equal this value (replay prevention). */
  expectedNonce?: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Cache key
// ────────────────────────────────────────────────────────────────────────────

/**
 * Build a jwksUri-scoped cache key. A static key would let plugin instances for
 * different issuers collide on one JWKS entry, so one issuer's keys could be
 * used to verify another issuer's tokens — a signature-verification cross-leak.
 */
function jwksCacheKey(jwksUri: string): string {
  return `oidc:jwks:${jwksUri}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Base64url helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Decode a base64url string to a Uint8Array.
 * Web Crypto key import methods require ArrayBuffer inputs, not strings.
 *
 * We prefer Node.js Buffer when available (plugin sandbox and test environments)
 * because it handles arbitrary bytes without the latin-1 restriction of atob().
 * The atob() fallback covers browser-based environments and future WASM runtimes.
 */
function base64urlToBytes(base64url: string): Uint8Array {
  // Node.js path: Buffer supports arbitrary byte sequences natively.
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(base64url, "base64url"));
  }

  // Browser / Web-only fallback.
  const padded = base64url + "===".slice((base64url.length + 3) % 4);
  const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    // noUncheckedIndexedAccess: we know the loop bound matches
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

// ────────────────────────────────────────────────────────────────────────────
// JWT parsing (no validation — just decode the three parts)
// ────────────────────────────────────────────────────────────────────────────

interface ParsedJwt {
  header: JwtHeader;
  claims: JwtClaims;
  /** Raw bytes of "header.payload" — the signed portion. */
  signedInput: Uint8Array;
  /** Raw signature bytes. */
  signature: Uint8Array;
}

/**
 * Split and base64url-decode a JWT without validating its signature.
 * Caller is responsible for validating the signature immediately after.
 */
export function parseJwtUnsafe(token: string): ParsedJwt {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new PluginAuthError("Token is not a valid JWT — expected three dot-separated parts");
  }

  // noUncheckedIndexedAccess: we verified parts.length === 3
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  let header: JwtHeader;
  let claims: JwtClaims;
  try {
    header = JSON.parse(
      new TextDecoder().decode(base64urlToBytes(headerB64)),
    ) as JwtHeader;
    claims = JSON.parse(
      new TextDecoder().decode(base64urlToBytes(payloadB64)),
    ) as JwtClaims;
  } catch {
    throw new PluginAuthError("Token contains invalid base64url or JSON in header/payload");
  }

  const signedInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = base64urlToBytes(signatureB64);

  return { header, claims, signedInput, signature };
}

// ────────────────────────────────────────────────────────────────────────────
// Web Crypto key import
// ────────────────────────────────────────────────────────────────────────────

/**
 * Derive the Web Crypto algorithm parameters from a JWK's "alg" or "kty" field.
 *
 * We support the three algorithms that Okta, Azure AD, Auth0, Google, and Keycloak
 * actually use in practice. ES256 (P-256 ECDSA) is the modern default; RS256 is the
 * legacy RSA choice; PS256 is the FAPI-compliant variant. Anything else is rejected.
 */
function algorithmParams(alg: string): RsaHashedImportParams | EcKeyImportParams {
  switch (alg) {
    case "RS256":
    case "RS384":
    case "RS512": {
      const hash = alg.replace("RS", "SHA-") as "SHA-256" | "SHA-384" | "SHA-512";
      return { name: "RSASSA-PKCS1-v1_5", hash };
    }
    case "PS256":
    case "PS384":
    case "PS512": {
      const hash = alg.replace("PS", "SHA-") as "SHA-256" | "SHA-384" | "SHA-512";
      return { name: "RSA-PSS", hash };
    }
    case "ES256":
      return { name: "ECDSA", namedCurve: "P-256" };
    case "ES384":
      return { name: "ECDSA", namedCurve: "P-384" };
    case "ES512":
      return { name: "ECDSA", namedCurve: "P-521" };
    default:
      throw new PluginAuthError(
        `Unsupported JWT algorithm "${alg}". Supported: RS256/384/512, PS256/384/512, ES256/384/512`,
        { alg },
      );
  }
}

/**
 * Import a single JWK as a Web Crypto CryptoKey for signature verification.
 * Returns null if the key type is unsupported so callers can skip without throwing.
 */
async function importJwk(jwk: JsonWebKey): Promise<CryptoKey | null> {
  // We only need "sig" keys. Keys without a "use" field are assumed to be signing keys
  // per RFC 7517 §4.2, which is how Keycloak publishes its keys.
  if (jwk.use !== undefined && jwk.use !== "sig") {
    return null;
  }

  const alg =
    jwk.alg ??
    (jwk.kty === "EC"
      ? jwk.crv === "P-384"
        ? "ES384"
        : jwk.crv === "P-521"
          ? "ES512"
          : "ES256"
      : "RS256");

  try {
    const params = algorithmParams(alg);
    return await crypto.subtle.importKey(
      "jwk",
      jwk as globalThis.JsonWebKey,
      params,
      // extractable=false: we never need to export the public key; this is more secure
      false,
      ["verify"],
    );
  } catch {
    // Unknown key type or malformed JWK — skip rather than crash the whole key set
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// JWKS fetch and cache
// ────────────────────────────────────────────────────────────────────────────

async function fetchJwks(
  jwksUri: string,
  fetch: FetchProxy,
): Promise<JwksResponse> {
  let response: Response;
  try {
    response = await fetch.fetch(jwksUri, {
      headers: { Accept: "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new PluginTimeoutError(`Failed to fetch JWKS from ${jwksUri}: ${message}`);
  }

  if (!response.ok) {
    throw new PluginConfigError(
      `JWKS endpoint returned HTTP ${response.status} — check jwks_uri in discovery document`,
      "jwks_uri",
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new PluginConfigError(
      `JWKS endpoint at ${jwksUri} returned non-JSON content`,
      "jwks_uri",
    );
  }

  if (
    body === null ||
    typeof body !== "object" ||
    !Array.isArray((body as Record<string, unknown>)["keys"])
  ) {
    throw new PluginConfigError(
      `JWKS response from ${jwksUri} is missing the "keys" array`,
      "jwks_uri",
    );
  }

  return body as JwksResponse;
}

/** Fetch the JWKS key set, caching for cacheTtlSeconds. */
async function getJwks(
  jwksUri: string,
  cacheTtlSeconds: number,
  fetch: FetchProxy,
  cache: CacheAccessor,
  logger: PluginLogger,
): Promise<JwksResponse> {
  const cacheKey = jwksCacheKey(jwksUri);
  const cached = await cache.get<JwksResponse>(cacheKey);
  if (cached !== null) {
    logger.debug("JWKS served from cache", { jwksUri });
    return cached;
  }

  logger.debug("Fetching JWKS", { jwksUri });
  const jwks = await fetchJwks(jwksUri, fetch);
  await cache.set(cacheKey, jwks, cacheTtlSeconds);
  logger.info("JWKS fetched and cached", { keyCount: jwks.keys.length });
  return jwks;
}

// ────────────────────────────────────────────────────────────────────────────
// Signature verification
// ────────────────────────────────────────────────────────────────────────────

/**
 * Attempt to verify the JWT signature against a set of keys.
 * Returns true if any key in the set successfully verifies the signature.
 *
 * We try all keys rather than only the kid-matched key so that tests and
 * providers that omit the kid header still work. In practice, iterating
 * 2-5 keys is negligible overhead.
 */
async function verifySignatureWithKeySet(
  parsed: ParsedJwt,
  keys: JsonWebKey[],
): Promise<boolean> {
  const alg = parsed.header.alg;

  for (const jwk of keys) {
    // Prefer kid-matching when the JWT header has a kid
    if (parsed.header.kid !== undefined && jwk.kid !== undefined && jwk.kid !== parsed.header.kid) {
      continue;
    }

    const cryptoKey = await importJwk({ ...jwk, alg: jwk.alg ?? alg });
    if (cryptoKey === null) {
      continue;
    }

    try {
      // For RSA-PSS we need to specify the salt length at verify time.
      // Per RFC 7518 §3.5, salt length must equal the hash output length.
      const hashSizeBytes: Record<string, number> = { "SHA-256": 32, "SHA-384": 48, "SHA-512": 64 };

      // For ECDSA, crypto.subtle.verify() requires EcdsaParams with a 'hash'
      // property. cryptoKey.algorithm for ECDSA keys is { name: 'ECDSA',
      // namedCurve: 'P-256' } — it does NOT include 'hash', so we derive the hash
      // from the key's curve below (RFC 7518 §3.4).
      let verifyAlg: AlgorithmIdentifier | RsaPssParams | EcdsaParams;
      if (cryptoKey.algorithm.name === "RSA-PSS") {
        verifyAlg = {
          name: "RSA-PSS",
          saltLength:
            hashSizeBytes[(cryptoKey.algorithm as RsaHashedKeyAlgorithm).hash.name] ?? 32,
        };
      } else if (cryptoKey.algorithm.name === "ECDSA") {
        // Derive the hash from the IMPORTED KEY's curve, not the JWT header alg.
        // The key was imported using the JWK's own alg (jwk.alg ?? alg); selecting
        // the hash from the attacker-influenced header alg could pair, e.g., a
        // P-384 key (ES384) with SHA-256, which silently fails verification for
        // every legitimate token. Per RFC 7518 §3.4 the curve fixes the hash.
        const ecdsaHashByCurve: Record<string, string> = {
          "P-256": "SHA-256",
          "P-384": "SHA-384",
          "P-521": "SHA-512",
        };
        const namedCurve = (cryptoKey.algorithm as EcKeyAlgorithm).namedCurve;
        const ecHash = ecdsaHashByCurve[namedCurve];
        if (ecHash === undefined) {
          continue;
        }
        verifyAlg = { name: "ECDSA", hash: ecHash };
      } else {
        verifyAlg = cryptoKey.algorithm;
      }

      // Web Crypto requires Uint8Array<ArrayBuffer>, not Uint8Array<ArrayBufferLike>.
      // Node.js Buffer.from() returns a Uint8Array whose .buffer property may be a
      // SharedArrayBuffer (pooled Buffer). We transfer into a guaranteed ArrayBuffer
      // by creating a new Uint8Array from the values. This is safe and cheap for JWTs.
      const signatureArr = new Uint8Array(parsed.signature) as Uint8Array<ArrayBuffer>;
      const signedInputArr = new Uint8Array(parsed.signedInput) as Uint8Array<ArrayBuffer>;

      const valid = await crypto.subtle.verify(
        verifyAlg,
        cryptoKey,
        signatureArr,
        signedInputArr,
      );
      if (valid) {
        return true;
      }
    } catch {
      // Key mismatch or wrong algorithm — try next key
      continue;
    }
  }

  return false;
}

// ────────────────────────────────────────────────────────────────────────────
// Claims validation
// ────────────────────────────────────────────────────────────────────────────

function validateClaims(
  claims: JwtClaims,
  issuerUrl: string,
  clientId: string,
  expectedNonce?: string,
): { valid: boolean; reason?: string } {
  const nowSeconds = Math.floor(Date.now() / 1000);

  // iss must match the issuer from discovery exactly.
  // Azure AD appends a trailing slash to the issuer in tokens but not in the
  // discovery document on some tenant configs — we normalise both before comparing.
  const normalise = (u: string) => (u.endsWith("/") ? u.slice(0, -1) : u);
  if (normalise(claims.iss) !== normalise(issuerUrl)) {
    return {
      valid: false,
      reason: `issuer mismatch: token has "${claims.iss}", expected "${issuerUrl}"`,
    };
  }

  // aud must contain our clientId (aud can be a string or array per RFC 7519 §4.1.3).
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(clientId)) {
    return {
      valid: false,
      reason: `audience mismatch: token audience ${JSON.stringify(claims.aud)} does not include clientId "${clientId}"`,
    };
  }

  // exp: token must not have expired. We allow 30 seconds of clock skew.
  if (nowSeconds > claims.exp + 30) {
    return {
      valid: false,
      reason: `token expired at ${new Date(claims.exp * 1000).toISOString()}`,
    };
  }

  // iat must not be in the future (with 30-second clock skew tolerance).
  if (claims.iat > nowSeconds + 30) {
    return {
      valid: false,
      reason: `token issued in the future: iat=${claims.iat}, now=${nowSeconds}`,
    };
  }

  // Nonce check: only enforced when an expectedNonce was provided (id_token flows).
  // When undefined, nonce validation is skipped for backward-compatible access_token paths.
  if (expectedNonce !== undefined) {
    if (claims.nonce !== expectedNonce) {
      return {
        valid: false,
        reason: `nonce mismatch: token nonce "${claims.nonce ?? "(absent)"}" does not match expected value — possible replay attack`,
      };
    }
  }

  return { valid: true };
}

// ────────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────────

export interface VerifyResult {
  valid: boolean;
  claims?: JwtClaims;
  expiresAt?: string;
  error?: string;
}

/**
 * Verify a JWT's signature against the provider's published JWKS keys and
 * validate its standard claims (iss, aud, exp, iat).
 *
 * On signature failure with a cached key set, evicts the cache and retries
 * once with freshly fetched keys to handle provider key rotation.
 */
export async function verifyJwt(token: string, options: VerifyOptions): Promise<VerifyResult> {
  const { issuerUrl, clientId, jwksUri, cacheTtlSeconds, fetch, cache, logger } = options;

  let parsed: ParsedJwt;
  try {
    parsed = parseJwtUnsafe(token);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // exactOptionalPropertyTypes: spread the error field only
    return { valid: false, error };
  }

  // Claims validation first — cheap and catches obvious failures before hitting the network.
  const claimsResult = validateClaims(parsed.claims, issuerUrl, clientId, options.expectedNonce);
  if (!claimsResult.valid) {
    // exactOptionalPropertyTypes: only include error when reason is defined
    return {
      valid: false,
      ...(claimsResult.reason !== undefined ? { error: claimsResult.reason } : {}),
    };
  }

  // Try cached key set.
  const jwks = await getJwks(jwksUri, cacheTtlSeconds, fetch, cache, logger);
  let signatureValid = await verifySignatureWithKeySet(parsed, jwks.keys);

  if (!signatureValid) {
    // Key rotation: evict cache and retry with fresh keys once.
    logger.debug("JWT signature invalid with cached JWKS — evicting cache and retrying", {
      kid: parsed.header.kid,
    });
    await cache.delete(JWKS_CACHE_KEY);
    const freshJwks = await getJwks(jwksUri, cacheTtlSeconds, fetch, cache, logger);
    signatureValid = await verifySignatureWithKeySet(parsed, freshJwks.keys);
  }

  if (!signatureValid) {
    return {
      valid: false,
      error: "JWT signature verification failed — no matching key in provider's JWKS",
    };
  }

  const expiresAt = new Date(parsed.claims.exp * 1000).toISOString();
  return { valid: true, claims: parsed.claims, expiresAt };
}
