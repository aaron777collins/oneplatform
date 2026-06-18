/**
 * Shared types for the BrandingProvider and useBranding hook.
 *
 * Separated into their own file so both the provider and tests can import
 * the types without creating a circular import through BrandingProvider.tsx.
 */

/**
 * Resolved branding configuration for a tenant.
 * All fields are always present — the provider fills in platform defaults for
 * any values the tenant has not explicitly configured.
 */
export interface TenantBrandingConfig {
  /** URL of the tenant's custom logo image. Null if not set. */
  logoUrl: string | null;
  /** URL for a custom browser tab favicon. Null if not set. */
  faviconUrl: string | null;
  /** Primary brand colour as a CSS hex string, e.g. "#3b82f6". */
  primaryColor: string;
  /** Accent/secondary brand colour. */
  accentColor: string;
  /** Application name shown in the UI and browser tab title. */
  appName: string;
  /** Support contact email surfaced in help/error UIs. Null if not set. */
  supportEmail: string | null;
  /** Tenant-supplied custom CSS injected into a <style> tag. Null if not set. */
  customCss: string | null;
}

/**
 * Value provided by BrandingContext to all consumers.
 */
export interface BrandingContextValue {
  branding: TenantBrandingConfig;
  /**
   * True while the initial branding fetch is in-flight.
   * Components can show a skeleton state during this window, but it is
   * intentionally short (5 s timeout) — most renders will see isLoading=false.
   */
  isLoading: boolean;
}
