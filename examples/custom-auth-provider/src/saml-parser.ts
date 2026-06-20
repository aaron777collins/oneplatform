/**
 * SAML XML parsing and validation utilities.
 *
 * This module parses SAML 2.0 Response XML into typed objects defined in ./types.ts.
 * It handles base64 decoding, XML element extraction, attribute parsing, and
 * assertion condition validation.
 *
 * IMPORTANT: XML signature verification is NOT performed here. The Auth Service
 * verifies signatures before calling the plugin. This module only handles
 * structural parsing and time/audience validation.
 */

import type {
  SamlResponse,
  SamlAssertion,
  SamlAttribute,
  SamlNameId,
  SamlNameIdFormat,
  SamlConditions,
  SamlAuthnStatement,
  SamlStatusCode,
  SamlProviderConfig,
} from "./types.js";

// ────────────────────────────────────────────────────────────────────────────
// XML helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Extract the text content of the first XML element matching the given local name.
 * Handles both prefixed (saml:Issuer) and unprefixed (Issuer) elements.
 * Returns undefined if the element is not found.
 */
export function extractElement(xml: string, localName: string): string | undefined {
  // Match both prefixed and unprefixed elements, e.g. <saml:Issuer> or <Issuer>
  const pattern = new RegExp(
    `<(?:[\\w-]+:)?${localName}[^>]*>([^<]*)</(?:[\\w-]+:)?${localName}>`,
    "s"
  );
  const match = xml.match(pattern);
  return match?.[1]?.trim();
}

/**
 * Extract an attribute value from the first XML element matching the given local name.
 */
export function extractElementAttribute(
  xml: string,
  localName: string,
  attrName: string
): string | undefined {
  const pattern = new RegExp(
    `<(?:[\\w-]+:)?${localName}\\s[^>]*${attrName}="([^"]*)"`,
    "s"
  );
  const match = xml.match(pattern);
  return match?.[1];
}

/**
 * Extract all SAML Attribute elements from an AttributeStatement.
 * Each attribute has a Name, optional FriendlyName, and one or more AttributeValue elements.
 */
export function extractAttributes(xml: string): SamlAttribute[] {
  const attributes: SamlAttribute[] = [];

  // Find the AttributeStatement block
  const stmtPattern = /<(?:[\w-]+:)?AttributeStatement[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?AttributeStatement>/;
  const stmtMatch = xml.match(stmtPattern);
  if (!stmtMatch) return attributes;

  const stmtContent = stmtMatch[1];

  // Find each Attribute element
  const attrPattern = /<(?:[\w-]+:)?Attribute\s([^>]*)>([\s\S]*?)<\/(?:[\w-]+:)?Attribute>/g;
  let attrMatch: RegExpExecArray | null;

  while ((attrMatch = attrPattern.exec(stmtContent)) !== null) {
    const attrAttrs = attrMatch[1];
    const attrBody = attrMatch[2];

    // Extract the Name attribute
    const nameMatch = attrAttrs.match(/Name="([^"]*)"/);
    if (!nameMatch) continue;

    // Extract optional FriendlyName
    const friendlyMatch = attrAttrs.match(/FriendlyName="([^"]*)"/);

    // Extract all AttributeValue elements
    const values: string[] = [];
    const valuePattern = /<(?:[\w-]+:)?AttributeValue[^>]*>([^<]*)<\/(?:[\w-]+:)?AttributeValue>/g;
    let valueMatch: RegExpExecArray | null;

    while ((valueMatch = valuePattern.exec(attrBody)) !== null) {
      values.push(valueMatch[1].trim());
    }

    attributes.push({
      name: nameMatch[1],
      friendlyName: friendlyMatch?.[1],
      values,
    });
  }

  return attributes;
}

// ────────────────────────────────────────────────────────────────────────────
// Base64 decoding
// ────────────────────────────────────────────────────────────────────────────

/**
 * Decode a base64-encoded SAML Response XML string.
 * Handles both standard base64 and URL-safe base64 encoding.
 */
export function decodeSamlResponse(encoded: string): string {
  // Replace URL-safe characters if present
  const standardBase64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const buffer = Buffer.from(standardBase64, "base64");
  return buffer.toString("utf-8");
}

// ────────────────────────────────────────────────────────────────────────────
// Parsing
// ────────────────────────────────────────────────────────────────────────────

/**
 * Parse a decoded SAML Response XML string into a typed SamlResponse object.
 *
 * This function extracts the top-level response metadata, status, and (if
 * successful) the nested assertion with its subject, conditions, authentication
 * statement, and attributes.
 *
 * @throws Error if the XML is malformed or required elements are missing.
 */
export function parseSamlResponse(xml: string): SamlResponse {
  // Extract top-level Response attributes
  const responseId = extractElementAttribute(xml, "Response", "ID");
  if (!responseId) {
    throw new Error("SAML Response is missing the ID attribute");
  }

  const inResponseTo = extractElementAttribute(xml, "Response", "InResponseTo") ?? "";
  const destination = extractElementAttribute(xml, "Response", "Destination") ?? "";
  const issueInstant = extractElementAttribute(xml, "Response", "IssueInstant") ?? "";

  // Extract Issuer
  const issuer = extractElement(xml, "Issuer");
  if (!issuer) {
    throw new Error("SAML Response is missing the Issuer element");
  }

  // Extract StatusCode
  const statusCode = (extractElementAttribute(xml, "StatusCode", "Value") ??
    "urn:oasis:names:tc:SAML:2.0:status:Responder") as SamlStatusCode;

  const statusMessage = extractElement(xml, "StatusMessage");

  // Parse assertion if status is Success
  let assertion: SamlAssertion | undefined;
  if (statusCode === "urn:oasis:names:tc:SAML:2.0:status:Success") {
    assertion = parseAssertion(xml);
  }

  return {
    id: responseId,
    inResponseTo,
    issuer,
    issueInstant,
    destination,
    statusCode,
    statusMessage,
    assertion,
  };
}

/**
 * Parse the SAML Assertion embedded within a Response XML string.
 */
function parseAssertion(xml: string): SamlAssertion {
  // Extract the Assertion block
  const assertionPattern = /<(?:[\w-]+:)?Assertion\s([\s\S]*?)<\/(?:[\w-]+:)?Assertion>/;
  const assertionMatch = xml.match(assertionPattern);
  if (!assertionMatch) {
    throw new Error("SAML Response has Success status but contains no Assertion element");
  }

  const assertionXml = assertionMatch[0];

  const id = extractElementAttribute(assertionXml, "Assertion", "ID");
  if (!id) {
    throw new Error("SAML Assertion is missing the ID attribute");
  }

  const issuer = extractElement(assertionXml, "Issuer");
  if (!issuer) {
    throw new Error("SAML Assertion is missing the Issuer element");
  }

  const issueInstant = extractElementAttribute(assertionXml, "Assertion", "IssueInstant") ?? "";

  // Parse Subject / NameID
  const subject = parseNameId(assertionXml);

  // Parse Conditions
  const conditions = parseConditions(assertionXml);

  // Parse AuthnStatement
  const authnStatement = parseAuthnStatement(assertionXml);

  // Parse Attributes
  const attributes = extractAttributes(assertionXml);

  return {
    id,
    issuer,
    issueInstant,
    subject,
    conditions,
    authnStatement,
    attributes,
  };
}

/**
 * Parse the NameID element from within the Subject element.
 */
function parseNameId(xml: string): SamlNameId {
  const value = extractElement(xml, "NameID");
  if (!value) {
    throw new Error("SAML Assertion is missing the NameID element");
  }

  const format = (extractElementAttribute(xml, "NameID", "Format") ??
    "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified") as SamlNameIdFormat;

  const nameQualifier = extractElementAttribute(xml, "NameID", "NameQualifier");

  return { value, format, nameQualifier };
}

/**
 * Parse the Conditions element from a SAML Assertion.
 */
function parseConditions(xml: string): SamlConditions {
  const notBefore = extractElementAttribute(xml, "Conditions", "NotBefore") ?? "";
  const notOnOrAfter = extractElementAttribute(xml, "Conditions", "NotOnOrAfter") ?? "";
  const audienceRestriction = extractElement(xml, "Audience") ?? "";

  return { notBefore, notOnOrAfter, audienceRestriction };
}

/**
 * Parse the AuthnStatement element from a SAML Assertion.
 */
function parseAuthnStatement(xml: string): SamlAuthnStatement {
  const authnInstant = extractElementAttribute(xml, "AuthnStatement", "AuthnInstant") ?? "";
  const sessionIndex = extractElementAttribute(xml, "AuthnStatement", "SessionIndex") ?? "";
  const authnContextClassRef =
    extractElement(xml, "AuthnContextClassRef") ??
    "urn:oasis:names:tc:SAML:2.0:ac:classes:unspecified";

  return { authnInstant, sessionIndex, authnContextClassRef };
}

// ────────────────────────────────────────────────────────────────────────────
// Validation
// ────────────────────────────────────────────────────────────────────────────

/**
 * Validate the time-based conditions of a SAML assertion.
 *
 * Checks that:
 * - The current time is after NotBefore (minus clock skew tolerance)
 * - The current time is before NotOnOrAfter (plus clock skew tolerance)
 *
 * @param conditions The parsed conditions from the assertion.
 * @param clockSkewToleranceSeconds Maximum acceptable clock drift in seconds.
 * @param now Optional current time for testing. Defaults to Date.now().
 * @returns An object with `valid` and an optional `reason` string.
 */
export function validateConditionsTime(
  conditions: SamlConditions,
  clockSkewToleranceSeconds: number,
  now?: number
): { valid: boolean; reason?: string } {
  const currentTime = now ?? Date.now();
  const toleranceMs = clockSkewToleranceSeconds * 1000;

  if (conditions.notBefore) {
    const notBeforeMs = new Date(conditions.notBefore).getTime();
    if (currentTime < notBeforeMs - toleranceMs) {
      return {
        valid: false,
        reason: `Assertion is not yet valid. NotBefore: ${conditions.notBefore}, current time is too early (skew tolerance: ${clockSkewToleranceSeconds}s)`,
      };
    }
  }

  if (conditions.notOnOrAfter) {
    const notOnOrAfterMs = new Date(conditions.notOnOrAfter).getTime();
    if (currentTime >= notOnOrAfterMs + toleranceMs) {
      return {
        valid: false,
        reason: `Assertion has expired. NotOnOrAfter: ${conditions.notOnOrAfter}, current time is past expiry (skew tolerance: ${clockSkewToleranceSeconds}s)`,
      };
    }
  }

  return { valid: true };
}

/**
 * Validate the audience restriction in a SAML assertion.
 *
 * @param conditions The parsed conditions from the assertion.
 * @param expectedAudience The SP's entity ID that must appear in the audience restriction.
 * @returns An object with `valid` and an optional `reason` string.
 */
export function validateAudience(
  conditions: SamlConditions,
  expectedAudience: string
): { valid: boolean; reason?: string } {
  if (!conditions.audienceRestriction) {
    return {
      valid: false,
      reason: "Assertion is missing the AudienceRestriction element",
    };
  }

  if (conditions.audienceRestriction !== expectedAudience) {
    return {
      valid: false,
      reason: `Audience mismatch: expected "${expectedAudience}", got "${conditions.audienceRestriction}"`,
    };
  }

  return { valid: true };
}

/**
 * Validate the issuer of a SAML assertion against the expected IdP entity ID.
 */
export function validateIssuer(
  actualIssuer: string,
  expectedIssuer: string
): { valid: boolean; reason?: string } {
  if (actualIssuer !== expectedIssuer) {
    return {
      valid: false,
      reason: `Issuer mismatch: expected "${expectedIssuer}", got "${actualIssuer}"`,
    };
  }

  return { valid: true };
}

/**
 * Extract the value of a named attribute from a list of SAML attributes.
 * Returns the first value if the attribute has multiple values, or undefined
 * if the attribute is not found.
 */
export function getAttributeValue(
  attributes: SamlAttribute[],
  name: string
): string | undefined {
  const attr = attributes.find((a) => a.name === name || a.friendlyName === name);
  return attr?.values[0];
}

/**
 * Extract all values of a named attribute from a list of SAML attributes.
 * Returns an empty array if the attribute is not found.
 */
export function getAttributeValues(
  attributes: SamlAttribute[],
  name: string
): string[] {
  const attr = attributes.find((a) => a.name === name || a.friendlyName === name);
  return attr?.values ?? [];
}

/**
 * Convert SAML assertion attributes to a flat claims record for use with
 * mapClaimsToRoles() and AuthResult.claims. Multi-valued attributes are
 * stored as arrays; single-valued attributes are stored as strings.
 */
export function attributesToClaims(
  attributes: SamlAttribute[],
  nameId: SamlNameId
): Record<string, unknown> {
  const claims: Record<string, unknown> = {
    sub: nameId.value,
    nameIdFormat: nameId.format,
  };

  if (nameId.nameQualifier) {
    claims.nameQualifier = nameId.nameQualifier;
  }

  for (const attr of attributes) {
    const key = attr.friendlyName ?? attr.name;
    claims[key] = attr.values.length === 1 ? attr.values[0] : attr.values;
  }

  return claims;
}

/**
 * Perform full validation of a parsed SAML response against the provider configuration.
 * Returns a structured result with all validation errors collected.
 */
export function validateSamlResponse(
  response: SamlResponse,
  config: SamlProviderConfig,
  now?: number
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Check status
  if (response.statusCode !== "urn:oasis:names:tc:SAML:2.0:status:Success") {
    errors.push(`SAML Response status is not Success: ${response.statusCode}`);
    if (response.statusMessage) {
      errors.push(`Status message: ${response.statusMessage}`);
    }
    return { valid: false, errors };
  }

  if (!response.assertion) {
    errors.push("SAML Response has Success status but contains no assertion");
    return { valid: false, errors };
  }

  // Validate issuer
  const issuerResult = validateIssuer(response.assertion.issuer, config.idpEntityId);
  if (!issuerResult.valid) {
    errors.push(issuerResult.reason!);
  }

  // Validate time conditions
  const timeResult = validateConditionsTime(
    response.assertion.conditions,
    config.clockSkewToleranceSeconds,
    now
  );
  if (!timeResult.valid) {
    errors.push(timeResult.reason!);
  }

  // Validate audience
  const audienceResult = validateAudience(response.assertion.conditions, config.spEntityId);
  if (!audienceResult.valid) {
    errors.push(audienceResult.reason!);
  }

  return { valid: errors.length === 0, errors };
}
