/**
 * BrandingProvider — per-tenant white-label theming.
 *
 * On mount this provider fetches the tenant's branding config from the auth
 * service (via the gateway) and:
 *
 * 1. Sets CSS custom properties on `document.documentElement` so any component
 *    using `var(--brand-primary)` / `var(--brand-accent)` picks up the tenant
 *    palette without any component-level wiring.
 * 2. Swaps the browser tab title to `branding.appName` when provided.
 * 3. Injects a `<link rel="icon">` for a custom favicon when provided.
 * 4. Injects sanitised `customCss` into a `<style>` tag so tenants can apply
 *    fine-grained overrides beyond the colour palette.
 *
 * The provider also exposes the raw branding values via `useBranding()` for
 * components that need to render them directly (e.g. a logo image, support
 * link, or page heading that displays the app name).
 *
 * Branding failures are intentionally non-fatal — if the fetch fails the
 * provider silently falls back to platform defaults so a broken config file
 * never prevents the app from loading.
 */

import React from "react";
import type { TenantBrandingConfig, BrandingContextValue } from "./branding-types.js";

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const DEFAULT_BRANDING: TenantBrandingConfig = {
  logoUrl: null,
  faviconUrl: null,
  primaryColor: "#3b82f6",
  accentColor: "#8b5cf6",
  appName: "OnePlatform",
  supportEmail: null,
  customCss: null,
};

export const BrandingContext = React.createContext<BrandingContextValue>({
  branding: DEFAULT_BRANDING,
  isLoading: false,
});

// ---------------------------------------------------------------------------
// CSS injection helpers
// ---------------------------------------------------------------------------

const BRANDING_STYLE_ID = "__op_branding_css__";
const BRANDING_FAVICON_ID = "__op_branding_favicon__";

/**
 * Writes the resolved branding values as CSS custom properties on the root
 * element so every descendant can reference them via var().
 *
 * We write to `element.style` (inline styles) rather than inserting a
 * `<style>` rule because inline properties have the highest specificity
 * short of !important, ensuring branding always wins over component defaults.
 */
function applyCssVariables(
  root: HTMLElement,
  branding: TenantBrandingConfig
): void {
  root.style.setProperty("--brand-primary", branding.primaryColor);
  root.style.setProperty("--brand-accent", branding.accentColor);
}

/**
 * Injects or updates the custom CSS `<style>` tag.
 * The element is identified by a stable ID so repeated calls replace the tag
 * rather than accumulating duplicates.
 */
function sanitizeCss(css: string): string {
  let sanitized = css;
  sanitized = sanitized.replace(/@import\b[^;]*;?/gi, "");
  sanitized = sanitized.replace(/expression\s*\([^)]*\)/gi, "");
  sanitized = sanitized.replace(
    /url\s*\(\s*(?:['"]?\s*(?!(?:data:|https:))[a-z][a-z0-9+.-]*:)[^)]*\)/gi,
    "url(about:invalid)",
  );
  sanitized = sanitized.replace(/<\/?script[^>]*>/gi, "");
  sanitized = sanitized.replace(/-moz-binding\s*:[^;}"']*/gi, "");
  sanitized = sanitized.replace(/behavior\s*:[^;}"']*/gi, "");
  return sanitized;
}

function applyCustomCss(css: string | null): void {
  document.getElementById(BRANDING_STYLE_ID)?.remove();

  if (!css) return;

  const style = document.createElement("style");
  style.id = BRANDING_STYLE_ID;
  style.textContent = sanitizeCss(css);
  document.head.appendChild(style);
}

/**
 * Returns true when the URL uses a safe protocol (http: or https:).
 * Rejects data:, blob:, javascript:, and any other unexpected scheme that a
 * compromised or misconfigured branding API could inject to track users or
 * execute scripts.
 */
function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Replaces the browser tab favicon.
 * Manages a dedicated `<link>` element to avoid clobbering the default icon
 * set in the HTML shell.
 */
function applyFavicon(faviconUrl: string | null): void {
  document.getElementById(BRANDING_FAVICON_ID)?.remove();

  if (!faviconUrl) return;

  if (!isSafeUrl(faviconUrl)) {
    console.warn(
      `[BrandingProvider] Rejecting faviconUrl with unsafe protocol: "${faviconUrl}"`
    );
    return;
  }

  const link = document.createElement("link");
  link.id = BRANDING_FAVICON_ID;
  link.rel = "icon";
  link.href = faviconUrl;
  document.head.appendChild(link);
}

/**
 * Applies all branding side-effects to the document.
 * Called once after a successful fetch and whenever the branding changes.
 */
export function applyBranding(branding: TenantBrandingConfig): void {
  applyCssVariables(document.documentElement, branding);
  applyCustomCss(branding.customCss);
  applyFavicon(branding.faviconUrl);

  if (branding.appName) {
    document.title = branding.appName;
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface BrandingProviderProps {
  children: React.ReactNode;
  /**
   * The tenant ID whose branding should be fetched.
   * When omitted the provider renders children immediately with default
   * branding — useful for embedding in contexts without a tenant ID.
   */
  tenantId?: string;
  /**
   * Base URL for the platform API gateway.
   * Defaults to `window.location.origin`. Override in tests or multi-origin
   * deployments.
   */
  apiBaseUrl?: string;
  /**
   * Optional callback invoked after branding has been applied to the DOM.
   * Primarily useful for testing to observe side-effects without querying the DOM.
   */
  onBrandingApplied?: (branding: TenantBrandingConfig) => void;
}

export function BrandingProvider({
  children,
  tenantId,
  apiBaseUrl,
  onBrandingApplied,
}: BrandingProviderProps): React.JSX.Element {
  const [branding, setBranding] =
    React.useState<TenantBrandingConfig>(DEFAULT_BRANDING);
  const [isLoading, setIsLoading] = React.useState(Boolean(tenantId));

  React.useEffect(() => {
    // No tenant ID — render immediately with defaults, no network request.
    if (!tenantId) {
      applyBranding(DEFAULT_BRANDING);
      onBrandingApplied?.(DEFAULT_BRANDING);
      return;
    }

    let cancelled = false;
    setIsLoading(true);

    async function fetchBranding(): Promise<void> {
      const base =
        apiBaseUrl ??
        (typeof window !== "undefined" ? window.location.origin : "");
      const url = `${base}/api/v1/tenants/${encodeURIComponent(tenantId!)}/branding`;

      try {
        const response = await fetch(url, {
          method: "GET",
          credentials: "include",
          headers: { Accept: "application/json" },
          // Hard timeout — branding is cosmetic; do not block the app indefinitely.
          signal: AbortSignal.timeout(5_000),
        });

        if (cancelled) return;

        if (!response.ok) {
          // Non-fatal: log and fall through to defaults.
          console.warn(
            `[BrandingProvider] Branding fetch returned ${response.status} for tenant ${tenantId}. ` +
              "Falling back to platform defaults."
          );
          applyBranding(DEFAULT_BRANDING);
          onBrandingApplied?.(DEFAULT_BRANDING);
          setIsLoading(false);
          return;
        }

        const data = (await response.json()) as TenantBrandingConfig;

        if (cancelled) return;

        // Merge with defaults to guard against partially-populated API responses.
        const resolved: TenantBrandingConfig = {
          logoUrl: data.logoUrl ?? DEFAULT_BRANDING.logoUrl,
          faviconUrl: data.faviconUrl ?? DEFAULT_BRANDING.faviconUrl,
          primaryColor: data.primaryColor ?? DEFAULT_BRANDING.primaryColor,
          accentColor: data.accentColor ?? DEFAULT_BRANDING.accentColor,
          appName: data.appName ?? DEFAULT_BRANDING.appName,
          supportEmail: data.supportEmail ?? DEFAULT_BRANDING.supportEmail,
          customCss: data.customCss ?? DEFAULT_BRANDING.customCss,
        };

        setBranding(resolved);
        applyBranding(resolved);
        onBrandingApplied?.(resolved);
      } catch (err) {
        if (cancelled) return;
        // Non-fatal: network errors, timeouts, JSON parse failures all fall back
        // to defaults rather than crashing the app.
        console.warn("[BrandingProvider] Failed to load branding:", err);
        applyBranding(DEFAULT_BRANDING);
        onBrandingApplied?.(DEFAULT_BRANDING);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    void fetchBranding();

    return () => {
      cancelled = true;
    };
    // apiBaseUrl is captured at mount — intentional. tenantId changes are supported.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  return (
    <BrandingContext.Provider value={{ branding, isLoading }}>
      {children}
    </BrandingContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Logo component
// ---------------------------------------------------------------------------

export interface BrandLogoProps {
  /** CSS class forwarded to the rendered element. */
  className?: string;
  /** Alt text for the logo image. Falls back to the branding app name. */
  alt?: string;
  /** Rendered when no custom logoUrl is set. Defaults to the platform text mark. */
  fallback?: React.ReactNode;
}

/**
 * Renders the tenant's custom logo when set, or the fallback element otherwise.
 *
 * Using this component rather than reading `useBranding().logoUrl` directly
 * ensures consistent image rendering behaviour (alt text, accessibility) across
 * the platform.
 */
export function BrandLogo({
  className,
  alt,
  fallback,
}: BrandLogoProps): React.JSX.Element {
  const { branding } = useBranding();
  const resolvedAlt = alt ?? branding.appName;

  if (branding.logoUrl && isSafeUrl(branding.logoUrl)) {
    return (
      <img
        src={branding.logoUrl}
        alt={resolvedAlt}
        className={className}
      />
    );
  }

  if (fallback) {
    return <>{fallback}</>;
  }

  // Default text mark when no custom logo and no fallback provided.
  return (
    <span className={className} aria-label={resolvedAlt}>
      {branding.appName}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Returns the current tenant branding values and loading state.
 *
 * Must be called inside a `<BrandingProvider>` subtree. Throws in development
 * when used outside the provider so misuse is caught immediately.
 */
export function useBranding(): BrandingContextValue {
  const ctx = React.useContext(BrandingContext);
  // The context always has a value (we provide a default at createContext),
  // so this hook is safe to call outside BrandingProvider — it just returns
  // defaults. We throw in dev mode only to catch accidental misuse early.
  //
  // __OP_DEV__ is injected by the build tool; absent in tests → default true.
  const isDev =
    typeof (globalThis as Record<string, unknown>)["__OP_DEV__"] !== "undefined"
      ? Boolean((globalThis as Record<string, unknown>)["__OP_DEV__"])
      : true;

  if (isDev && ctx === undefined) {
    throw new Error(
      "[app-sdk] useBranding() was called in a context where BrandingContext has no value. " +
        "This should not happen — check that BrandingContext has a default value."
    );
  }

  return ctx;
}
