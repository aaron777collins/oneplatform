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
  // Allow only absolute-path references: must start with exactly one "/"
  // followed by a non-"/" character (or end of string for just "/").
  if (raw.startsWith("/") && !raw.startsWith("//")) return raw;
  return "/";
}
