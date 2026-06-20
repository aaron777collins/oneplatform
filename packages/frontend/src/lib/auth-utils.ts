/**
 * Sanitises a redirect target from an untrusted query parameter.
 *
 * Only allows relative paths starting with "/" (but not "//", which browsers
 * interpret as protocol-relative URLs). All other values — including absolute
 * URLs (https://), dangerous schemes (javascript:, data:), and protocol-relative
 * paths — are replaced with "/".
 */
export function safeRedirect(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0) return "/";

  // Reject anything that doesn't start with "/" at all
  if (!raw.startsWith("/")) return "/";

  // Reject protocol-relative (//) and backslash-normalised (/\) variants that
  // browsers resolve to external origins (e.g. /\evil.com → //evil.com).
  if (raw.startsWith("//") || raw.startsWith("/\\")) return "/";

  // Parse as a URL relative to a dummy origin and verify no origin escape occurred.
  // This catches any further normalisation tricks the spec allows.
  try {
    const base = "https://localhost";
    const resolved = new URL(raw, base);
    if (resolved.origin !== base) return "/";
    return raw;
  } catch {
    return "/";
  }
}
