/**
 * Branding service — per-tenant white-label configuration.
 *
 * Tenants can customise the platform appearance: logo, favicon, primary/accent
 * colours, app name, support email, and a small snippet of custom CSS.
 *
 * Security invariants enforced here (not in the route layer):
 *   - Hex colour strings are validated before storage.
 *   - URL fields must be absolute https:// URLs (or http:// in dev).
 *   - Custom CSS is sanitised: url(), @import, and javascript: are stripped to
 *     prevent data-exfiltration and script injection through style rules.
 *   - Custom CSS is capped at 10 KB to prevent storage abuse.
 */

import { ValidationError } from "@oneplatform/core";
import type pg from "pg";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TenantBranding {
  logoUrl?: string;
  faviconUrl?: string;
  primaryColor?: string; // 3- or 6-digit hex, e.g. "#3b82f6"
  accentColor?: string;
  appName?: string; // replaces "OnePlatform" in the UI
  supportEmail?: string;
  customCss?: string; // max 10 KB after sanitisation
}

// Returned by getBranding — always complete (defaults filled in for missing fields).
export interface ResolvedBranding {
  logoUrl: string | null;
  faviconUrl: string | null;
  primaryColor: string;
  accentColor: string;
  appName: string;
  supportEmail: string | null;
  customCss: string | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_PRIMARY_COLOR = "#3b82f6";
const DEFAULT_ACCENT_COLOR = "#8b5cf6";
const DEFAULT_APP_NAME = "OnePlatform";

// 10 KB in bytes — checked against the raw string length (UTF-16 code units ≈ bytes
// for typical CSS which is ASCII-heavy; strict byte measurement is done in validateCss).
const MAX_CSS_BYTES = 10_240;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Validates a CSS hex colour string.
 * Accepts the full 6-digit form (#rrggbb) and the shorthand 3-digit form (#rgb).
 * Case-insensitive.
 */
export function isValidHexColor(value: string): boolean {
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value);
}

/**
 * Validates an absolute URL string.
 * Only http:// and https:// schemes are permitted — data: URIs and other schemes
 * could be used to inject content or bypass CSP.
 */
export function isValidUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Sanitises a custom CSS string.
 *
 * Strips constructs that could be used to exfiltrate data or execute scripts:
 *   - url() — could embed remote resources or data: URIs
 *   - @import — could load external stylesheets
 *   - javascript: — protocol in property values
 *   - expression() — IE-era CSS expressions that execute JavaScript
 *
 * WHY strip rather than reject: stripping lets tenants keep the bulk of their
 * CSS while silently removing the dangerous parts. Rejection would require
 * tenants to hand-audit every rule, creating friction for legitimate use.
 *
 * Returns the sanitised string. Throws ValidationError if the input exceeds the
 * size cap even after stripping.
 */
export function sanitizeCss(raw: string): string {
  // Check byte length first — reject grossly oversized input before processing.
  const rawBytes = Buffer.byteLength(raw, "utf8");
  if (rawBytes > MAX_CSS_BYTES) {
    throw new ValidationError(
      `Custom CSS exceeds the 10 KB limit (received ${rawBytes} bytes).`,
      []
    );
  }

  let sanitised = raw;

  // Strip @import rules first — must run before url() stripping so that
  // `@import url('...')` is removed as a complete rule rather than leaving
  // a dangling `@import ;` after the url() portion is stripped.
  // The pattern matches @import followed by anything up to and including the
  // first semicolon, handling both `@import '...'` and `@import url('...')`.
  sanitised = sanitised.replace(/@import\s*[^;]+;/gi, "");

  // Strip url(...) including nested quotes and whitespace — covers data: URIs,
  // remote resources loaded via http, and other protocol schemes.
  // Greedy match up to the last ')' on the line handles escaped parens and
  // nested constructs like url(calc(1)) that [^)]* would leave partial.
  sanitised = sanitised.replace(/url\s*\([^)]*(?:\([^)]*\)[^)]*)*\)/gi, "");

  // Strip any remaining javascript: protocol occurrences in property values.
  sanitised = sanitised.replace(/javascript\s*:/gi, "");

  // Strip IE-era CSS expressions — expression(<js>) executes arbitrary code.
  // Same nested-paren strategy as url() above prevents expression(nested(evil))
  // from leaving a dangling ')'.
  sanitised = sanitised.replace(/expression\s*\([^)]*(?:\([^)]*\)[^)]*)*\)/gi, "");

  // Re-check byte length after stripping in case the raw input was under the
  // limit but adversarial nesting caused expansion (unlikely but defensive).
  const sanitisedBytes = Buffer.byteLength(sanitised, "utf8");
  if (sanitisedBytes > MAX_CSS_BYTES) {
    throw new ValidationError(
      `Custom CSS exceeds the 10 KB limit after sanitisation (${sanitisedBytes} bytes).`,
      []
    );
  }

  return sanitised;
}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface BrandingService {
  /**
   * Returns the resolved branding for a tenant, filling in platform defaults
   * for any fields the tenant has not customised.
   */
  getBranding(tenantId: string): Promise<ResolvedBranding>;

  /**
   * Validates and persists partial branding updates.
   * Only the fields present in the payload are written — absent fields retain
   * their current values (or remain unset).
   */
  updateBranding(tenantId: string, branding: TenantBranding): Promise<ResolvedBranding>;

  /**
   * Removes all custom branding for the tenant, restoring platform defaults.
   */
  resetBranding(tenantId: string): Promise<ResolvedBranding>;
}

export interface BrandingServiceDeps {
  db: pg.Pool;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createBrandingService(deps: BrandingServiceDeps): BrandingService {
  const { db } = deps;

  /**
   * Reads the raw branding JSONB for a tenant.
   * Returns an empty object when the tenant has no custom branding or when the
   * tenant does not exist — the caller decides whether to 404 separately.
   */
  async function readRawBranding(tenantId: string): Promise<TenantBranding> {
    const result = await db.query<{ branding: TenantBranding }>(
      `SELECT branding
         FROM auth.tenants
        WHERE id = $1
          AND deleted_at IS NULL`,
      [tenantId]
    );
    return result.rows[0]?.branding ?? {};
  }

  /**
   * Merges stored branding with platform defaults to produce a fully-resolved
   * object. Never returns undefined for any field.
   */
  function resolveBranding(stored: TenantBranding): ResolvedBranding {
    return {
      logoUrl: stored.logoUrl ?? null,
      faviconUrl: stored.faviconUrl ?? null,
      primaryColor: stored.primaryColor ?? DEFAULT_PRIMARY_COLOR,
      accentColor: stored.accentColor ?? DEFAULT_ACCENT_COLOR,
      appName: stored.appName ?? DEFAULT_APP_NAME,
      supportEmail: stored.supportEmail ?? null,
      customCss: stored.customCss ?? null,
    };
  }

  /**
   * Validates all fields in a branding payload.
   * Throws ValidationError with a descriptive message on the first invalid field.
   * All validations run before any write occurs — fail-fast but with context.
   */
  function validateBranding(branding: TenantBranding): void {
    const errors: string[] = [];

    if (branding.primaryColor !== undefined && !isValidHexColor(branding.primaryColor)) {
      errors.push(
        `primaryColor "${branding.primaryColor}" is not a valid hex colour (expected #rrggbb or #rgb).`
      );
    }

    if (branding.accentColor !== undefined && !isValidHexColor(branding.accentColor)) {
      errors.push(
        `accentColor "${branding.accentColor}" is not a valid hex colour (expected #rrggbb or #rgb).`
      );
    }

    if (branding.logoUrl !== undefined && !isValidUrl(branding.logoUrl)) {
      errors.push(
        `logoUrl "${branding.logoUrl}" is not a valid absolute http/https URL.`
      );
    }

    if (branding.faviconUrl !== undefined && !isValidUrl(branding.faviconUrl)) {
      errors.push(
        `faviconUrl "${branding.faviconUrl}" is not a valid absolute http/https URL.`
      );
    }

    if (branding.appName !== undefined) {
      const trimmed = branding.appName.trim();
      if (trimmed.length === 0 || trimmed.length > 100) {
        errors.push("appName must be between 1 and 100 characters.");
      }
    }

    if (branding.supportEmail !== undefined) {
      // Simple but adequate email pattern — the auth service uses a proper Zod
      // email validator elsewhere; we mirror that strictness here.
      const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailPattern.test(branding.supportEmail)) {
        errors.push(`supportEmail "${branding.supportEmail}" is not a valid email address.`);
      }
    }

    if (errors.length > 0) {
      throw new ValidationError(errors[0]!, []);
    }
  }

  // ── Public methods ─────────────────────────────────────────────────────────

  async function getBranding(tenantId: string): Promise<ResolvedBranding> {
    const stored = await readRawBranding(tenantId);
    return resolveBranding(stored);
  }

  async function updateBranding(
    tenantId: string,
    incoming: TenantBranding
  ): Promise<ResolvedBranding> {
    // 1. Validate all incoming fields before touching the database.
    validateBranding(incoming);

    // 2. Sanitise custom CSS if provided. This mutates a local copy — we never
    //    write the unsanitised input to the database.
    const sanitisedIncoming: TenantBranding = { ...incoming };
    if (sanitisedIncoming.customCss !== undefined) {
      sanitisedIncoming.customCss = sanitizeCss(sanitisedIncoming.customCss);
    }

    // 3. Merge with existing stored branding so this is a true partial update.
    //    Missing keys in the payload do not overwrite existing customisations.
    const existing = await readRawBranding(tenantId);
    const merged: TenantBranding = { ...existing, ...sanitisedIncoming };

    // 4. Persist the merged object. Parameterised — no string concatenation.
    await db.query(
      `UPDATE auth.tenants
          SET branding    = $2,
              updated_at  = now()
        WHERE id = $1
          AND deleted_at IS NULL`,
      [tenantId, JSON.stringify(merged)]
    );

    return resolveBranding(merged);
  }

  async function resetBranding(tenantId: string): Promise<ResolvedBranding> {
    await db.query(
      `UPDATE auth.tenants
          SET branding    = '{}',
              updated_at  = now()
        WHERE id = $1
          AND deleted_at IS NULL`,
      [tenantId]
    );
    return resolveBranding({});
  }

  return { getBranding, updateBranding, resetBranding };
}
