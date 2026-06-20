/**
 * TypeScript type definitions for SAML 2.0 entities.
 *
 * These types model the subset of SAML 2.0 structures that a Service Provider (SP)
 * needs to process during the Web Browser SSO Profile. They do not cover the full
 * SAML 2.0 specification — only the elements relevant to authentication.
 *
 * Reference: OASIS SAML 2.0 Core Specification, sections 2 and 3.
 * https://docs.oasis-open.org/security/saml/v2.0/saml-core-2.0-os.pdf
 */

// ────────────────────────────────────────────────────────────────────────────
// Name ID
// ────────────────────────────────────────────────────────────────────────────

/**
 * SAML NameID formats that identify the subject of an assertion.
 * The IdP includes one of these in the <saml:NameID> element.
 */
export type SamlNameIdFormat =
  | "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress"
  | "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent"
  | "urn:oasis:names:tc:SAML:2.0:nameid-format:transient"
  | "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified";

export interface SamlNameId {
  /** The subject identifier value (e.g., the user's email address). */
  value: string;

  /** The NameID format URI. */
  format: SamlNameIdFormat;

  /**
   * The Security or Administrative domain that qualifies the name.
   * Typically the IdP's entity ID.
   */
  nameQualifier?: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Attributes
// ────────────────────────────────────────────────────────────────────────────

/**
 * A single SAML attribute from the AttributeStatement.
 * IdPs include user profile data (email, groups, department, etc.) as attributes.
 */
export interface SamlAttribute {
  /** The attribute name (e.g., "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress"). */
  name: string;

  /**
   * Optional friendly name for display purposes (e.g., "emailaddress").
   * Not all IdPs populate this field.
   */
  friendlyName?: string;

  /**
   * Attribute values. Most attributes have a single value, but multi-valued
   * attributes (like group memberships) can have multiple entries.
   */
  values: string[];
}

// ────────────────────────────────────────────────────────────────────────────
// Conditions
// ────────────────────────────────────────────────────────────────────────────

/**
 * Time-based conditions from the SAML assertion's <saml:Conditions> element.
 * The SP must reject assertions outside this validity window.
 */
export interface SamlConditions {
  /** ISO 8601 timestamp. The assertion is not valid before this time. */
  notBefore: string;

  /** ISO 8601 timestamp. The assertion is not valid on or after this time. */
  notOnOrAfter: string;

  /**
   * The intended audience for this assertion (the SP's entity ID).
   * The SP must reject assertions that do not include its own entity ID here.
   */
  audienceRestriction: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Authentication statement
// ────────────────────────────────────────────────────────────────────────────

/**
 * Authentication context class URIs that describe how the user authenticated.
 */
export type SamlAuthnContextClass =
  | "urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport"
  | "urn:oasis:names:tc:SAML:2.0:ac:classes:X509"
  | "urn:oasis:names:tc:SAML:2.0:ac:classes:Kerberos"
  | "urn:oasis:names:tc:SAML:2.0:ac:classes:unspecified"
  | string;

export interface SamlAuthnStatement {
  /** ISO 8601 timestamp of when the user authenticated at the IdP. */
  authnInstant: string;

  /** The IdP session index. Used for Single Logout (SLO) correlation. */
  sessionIndex: string;

  /** How the user authenticated at the IdP. */
  authnContextClassRef: SamlAuthnContextClass;
}

// ────────────────────────────────────────────────────────────────────────────
// Assertion
// ────────────────────────────────────────────────────────────────────────────

/**
 * A parsed SAML 2.0 assertion containing the authenticated user's identity.
 *
 * This is the result of parsing and validating the <saml:Assertion> element
 * from the IdP's SAML Response. Signature verification is performed before
 * constructing this object — by the time plugin code sees a SamlAssertion,
 * the XML signature has already been validated.
 */
export interface SamlAssertion {
  /** Unique identifier for this assertion (the "ID" attribute). */
  id: string;

  /** The IdP's entity ID (the "Issuer" element). */
  issuer: string;

  /** ISO 8601 timestamp when the assertion was issued. */
  issueInstant: string;

  /** The authenticated subject's NameID. */
  subject: SamlNameId;

  /** Time-based validity conditions for the assertion. */
  conditions: SamlConditions;

  /** Details about the user's authentication session at the IdP. */
  authnStatement: SamlAuthnStatement;

  /**
   * User attributes from the AttributeStatement.
   * Attribute names follow the IdP's naming convention — common formats:
   *   - OID-based:  "urn:oid:0.9.2342.19200300.100.1.3" (mail)
   *   - URI-based:  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress"
   *   - Short name: "email", "groups", "department"
   */
  attributes: SamlAttribute[];
}

// ────────────────────────────────────────────────────────────────────────────
// SAML Response
// ────────────────────────────────────────────────────────────────────────────

/**
 * Status codes from the SAML Response's <samlp:Status> element.
 */
export type SamlStatusCode =
  | "urn:oasis:names:tc:SAML:2.0:status:Success"
  | "urn:oasis:names:tc:SAML:2.0:status:Requester"
  | "urn:oasis:names:tc:SAML:2.0:status:Responder"
  | "urn:oasis:names:tc:SAML:2.0:status:VersionMismatch"
  | "urn:oasis:names:tc:SAML:2.0:status:AuthnFailed"
  | string;

/**
 * A parsed SAML 2.0 Response from the Identity Provider.
 *
 * The IdP sends this as a base64-encoded XML document in the SAMLResponse
 * POST parameter. The auth provider plugin decodes and parses it to extract
 * the assertion and user attributes.
 */
export interface SamlResponse {
  /** Unique identifier for this response. */
  id: string;

  /** The InResponseTo attribute — matches the AuthnRequest ID sent by the SP. */
  inResponseTo: string;

  /** The IdP's entity ID. */
  issuer: string;

  /** ISO 8601 timestamp when the response was issued. */
  issueInstant: string;

  /** The response destination URL (the SP's Assertion Consumer Service URL). */
  destination: string;

  /** The top-level status code indicating success or failure. */
  statusCode: SamlStatusCode;

  /** Optional human-readable status message from the IdP. */
  statusMessage?: string;

  /** The assertion, present only when statusCode is Success. */
  assertion?: SamlAssertion;
}

// ────────────────────────────────────────────────────────────────────────────
// Plugin configuration
// ────────────────────────────────────────────────────────────────────────────

/**
 * Validated configuration for the SAML auth provider plugin.
 * These values are parsed from the tenant admin's configuration form
 * and validated against the manifest's configSchema.
 */
export interface SamlProviderConfig {
  /** The IdP's entity ID (used to verify the Issuer in responses). */
  idpEntityId: string;

  /** The IdP's SSO URL where authentication requests are sent. */
  idpSsoUrl: string;

  /** The IdP's signing certificate in PEM format (used to verify response signatures). */
  idpCertificate: string;

  /** The SP's entity ID (included in AuthnRequests and used to verify AudienceRestriction). */
  spEntityId: string;

  /**
   * Attribute name in the SAML assertion that contains the user's email.
   * Common values: "email", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress"
   */
  emailAttributeName: string;

  /**
   * Attribute name in the SAML assertion that contains group/role memberships.
   * Used by mapClaimsToRoles() to assign OnePlatform RBAC roles.
   */
  groupAttributeName: string;

  /** IdP group name to OnePlatform role name mapping. */
  roleMapping: Record<string, string>;

  /**
   * Clock skew tolerance in seconds for assertion time validation.
   * IdPs and SPs may have slightly different clocks. Default: 120 seconds.
   */
  clockSkewToleranceSeconds: number;
}
