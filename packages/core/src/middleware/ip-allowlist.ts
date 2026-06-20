/**
 * IP allowlist middleware for Hono.
 *
 * WHY pure implementation (no external library):
 *   - The spec requires no external IP libraries. All CIDR matching is
 *     implemented using standard bitwise arithmetic on parsed address bytes.
 *   - IPv4-mapped IPv6 addresses (::ffff:x.x.x.x) are normalised to plain
 *     IPv4 before comparison so a single IPv4 allowlist entry covers both forms.
 *
 * Design invariant: an empty allowlist means "allow all" (opt-in security).
 * Callers must explicitly populate the list to restrict access.
 */

import { createMiddleware } from "hono/factory";
import type { Context } from "hono";

// ---------------------------------------------------------------------------
// IP parsing utilities
// ---------------------------------------------------------------------------

/**
 * Strip port suffix from an IP address string.
 * Handles IPv4 with port (e.g., "192.168.1.1:12345" -> "192.168.1.1"),
 * bracketed IPv6 with port (e.g., "[::1]:8080" -> "::1"),
 * and leaves bare IPv6 addresses (e.g., "::1") unchanged.
 */
function stripPortSuffix(ip: string): string {
  // Bracketed IPv6 with port: [::1]:8080 -> ::1
  if (ip.startsWith("[")) {
    const bracketEnd = ip.indexOf("]");
    if (bracketEnd !== -1) {
      return ip.slice(1, bracketEnd);
    }
  }

  // IPv4 with port: only strip if there's exactly one colon (not IPv6)
  const colonCount = ip.split(":").length - 1;
  if (colonCount === 1) {
    return ip.slice(0, ip.indexOf(":"));
  }

  // Bare IPv6 or already clean — return as-is
  return ip;
}

/**
 * Extract the client IP from a Hono context, preferring the most authoritative
 * source available. The order is:
 *   1. X-Real-IP — set by Caddy/nginx reverse proxy (our infrastructure).
 *   2. X-Forwarded-For — may contain a chain; we take the first (leftmost) value.
 *      The leftmost IP is the original client when the proxy is trusted.
 *   3. Fall back to an empty string when neither header is present (should not
 *      occur in production because Caddy always injects X-Real-IP).
 *
 * X-Forwarded-For is intentionally not used as the sole source — it is
 * client-controlled and can be spoofed when the proxy is absent. The gateway
 * injects X-Real-IP from the TCP socket before forwarding, making it reliable.
 */
export function parseIpFromRequest(c: Context): string {
  const realIp = c.req.header("x-real-ip");
  if (realIp) {
    return realIp.trim();
  }

  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) {
    // X-Forwarded-For: <client>, <proxy1>, <proxy2>
    // Take only the leftmost value; strip any port suffix.
    const first = forwarded.split(",")[0]?.trim() ?? "";
    return stripPortSuffix(first);
  }

  return "";
}

// ---------------------------------------------------------------------------
// CIDR / IP matching utilities (exported for unit-testing)
// ---------------------------------------------------------------------------

/**
 * Normalise an IPv4-mapped IPv6 address to a plain IPv4 string.
 * "::ffff:192.168.1.1" → "192.168.1.1"
 * "::ffff:c0a8:0101"  → "192.168.1.1"
 * All other strings are returned unchanged.
 */
function normaliseIp(ip: string): string {
  // Full text form: ::ffff:d.d.d.d
  const textMapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i;
  const textMatch = textMapped.exec(ip);
  if (textMatch?.[1]) {
    return textMatch[1];
  }

  // Hex form: ::ffff:hhhh:hhhh  (e.g. ::ffff:c0a8:0101 = 192.168.1.1)
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i;
  const hexMatch = hexMapped.exec(ip);
  if (hexMatch?.[1] && hexMatch[2]) {
    const hi = parseInt(hexMatch[1], 16);
    const lo = parseInt(hexMatch[2], 16);
    return `${(hi >>> 8) & 0xff}.${hi & 0xff}.${(lo >>> 8) & 0xff}.${lo & 0xff}`;
  }

  return ip;
}

/**
 * Parse an IPv4 address into a 32-bit unsigned integer.
 * Returns null when the string is not a valid IPv4 address.
 */
function parseIpv4(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;

  let result = 0;
  for (const part of parts) {
    const n = parseInt(part, 10);
    // Reject octal notation, leading zeros, and out-of-range values
    if (String(n) !== part || n < 0 || n > 255) return null;
    result = (result * 256 + n) >>> 0;
  }
  return result;
}

/**
 * Expand a compressed IPv6 address into exactly 8 colon-separated 16-bit groups.
 * Returns null when the string cannot be parsed as a valid IPv6 address.
 */
function expandIpv6(ip: string): number[] | null {
  // Handle IPv4-mapped IPv6 addresses that were not caught by normaliseIp
  if (/::ffff:/i.test(ip)) {
    const normalised = normaliseIp(ip);
    if (normalised !== ip) {
      // Converted to IPv4 — caller should use parseIpv4 instead
      return null;
    }
  }

  // Split on "::" to find the compression point
  const halves = ip.split("::");
  if (halves.length > 2) return null; // Multiple "::" — invalid

  const parseGroups = (s: string): number[] | null => {
    if (s === "") return [];
    const parts = s.split(":");
    const groups: number[] = [];
    for (const p of parts) {
      if (!/^[0-9a-f]{1,4}$/i.test(p)) return null;
      groups.push(parseInt(p, 16));
    }
    return groups;
  };

  if (halves.length === 1) {
    // No "::" — must have exactly 8 groups
    const groups = parseGroups(halves[0] ?? "");
    if (!groups || groups.length !== 8) return null;
    return groups;
  }

  // Has "::"
  const left = parseGroups(halves[0] ?? "");
  const right = parseGroups(halves[1] ?? "");
  if (!left || !right) return null;

  const zeros = 8 - left.length - right.length;
  if (zeros < 0) return null;

  return [...left, ...Array(zeros).fill(0) as number[], ...right];
}

/**
 * Check whether `ip` falls within the `cidr` range.
 *
 * Supports:
 *   - IPv4 individual: "192.168.1.1"
 *   - IPv4 CIDR:       "192.168.1.0/24"
 *   - IPv6 individual: "2001:db8::1"
 *   - IPv6 CIDR:       "2001:db8::/32"
 *   - IPv4-mapped:     "::ffff:192.168.1.1" normalised before comparison
 */
export function isIpInCidr(ip: string, cidr: string): boolean {
  const normIp = normaliseIp(ip);

  // Split CIDR into address and prefix length
  const slashIdx = cidr.lastIndexOf("/");
  const cidrAddress = slashIdx === -1 ? cidr : cidr.slice(0, slashIdx);
  const prefixLenStr = slashIdx === -1 ? null : cidr.slice(slashIdx + 1);
  const normCidr = normaliseIp(cidrAddress);

  // Try IPv4 path first
  const ipv4 = parseIpv4(normIp);
  const cidrIpv4 = parseIpv4(normCidr);

  if (ipv4 !== null && cidrIpv4 !== null) {
    if (prefixLenStr === null) {
      return ipv4 === cidrIpv4;
    }
    const prefixLen = parseInt(prefixLenStr, 10);
    if (prefixLen < 0 || prefixLen > 32 || String(prefixLen) !== prefixLenStr) {
      return false;
    }
    if (prefixLen === 0) return true;
    const mask = (0xffffffff << (32 - prefixLen)) >>> 0;
    return (ipv4 & mask) >>> 0 === (cidrIpv4 & mask) >>> 0;
  }

  // Try IPv6 path
  const ipv6 = expandIpv6(normIp);
  const cidrIpv6 = expandIpv6(normCidr);

  if (ipv6 !== null && cidrIpv6 !== null) {
    if (prefixLenStr === null) {
      return ipv6.every((g, i) => g === cidrIpv6[i]);
    }
    const prefixLen = parseInt(prefixLenStr, 10);
    if (prefixLen < 0 || prefixLen > 128 || String(prefixLen) !== prefixLenStr) {
      return false;
    }
    // Compare bit-by-bit across the 8 groups (16 bits each)
    let bitsLeft = prefixLen;
    for (let i = 0; i < 8; i++) {
      if (bitsLeft <= 0) break;
      const bits = Math.min(bitsLeft, 16);
      const mask = (0xffff << (16 - bits)) & 0xffff;
      if ((ipv6[i]! & mask) !== (cidrIpv6[i]! & mask)) return false;
      bitsLeft -= 16;
    }
    return true;
  }

  // IP and CIDR are not the same address family — never match
  return false;
}

/**
 * Check whether `ip` matches any entry in `allowlist`.
 * Each entry may be an individual IP or a CIDR range.
 * Returns true when at least one entry matches.
 */
export function isIpInAllowlist(ip: string, allowlist: string[]): boolean {
  const normIp = normaliseIp(ip);
  for (const entry of allowlist) {
    if (isIpInCidr(normIp, entry.trim())) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

export interface IpAllowlistOptions {
  /**
   * List of allowed IPs / CIDR ranges. When empty, all requests are allowed.
   * Populated from tenant or API key configuration at request time.
   */
  allowlist: string[];

  /**
   * Human-readable context for the 403 error message (e.g. "tenant" or "API key").
   * Helps operators understand which allowlist blocked the request.
   */
  context?: string;
}

/**
 * Hono middleware that enforces an IP allowlist.
 *
 * Usage — wire after auth middleware so `c.var.user` is available, then
 * provide the relevant allowlist (tenant-level or key-level) from your data
 * source:
 *
 * ```ts
 * app.use("*", createIpAllowlistMiddleware({
 *   allowlist: tenant.ipAllowlist,
 *   context: "tenant",
 * }));
 * ```
 *
 * Empty allowlist → all IPs allowed (security is opt-in, not opt-out).
 */
export function createIpAllowlistMiddleware(options: IpAllowlistOptions) {
  return createMiddleware(async (c, next) => {
    // Empty allowlist means unrestricted — consistent with the spec
    if (options.allowlist.length === 0) {
      await next();
      return;
    }

    const clientIp = parseIpFromRequest(c);

    if (!clientIp) {
      // Cannot determine caller IP while an allowlist is configured — deny
      // to fail safe rather than accidentally granting access.
      const requestId: string = c.var["requestId"] ?? "";
      return c.json(
        {
          error: {
            code: "FORBIDDEN",
            message: "Access denied: client IP address could not be determined.",
            requestId,
          },
        },
        403
      );
    }

    if (!isIpInAllowlist(clientIp, options.allowlist)) {
      const requestId: string = c.var["requestId"] ?? "";
      const ctx = options.context ?? "IP";
      const vars = c.var as Record<string, unknown>;
      if (vars["logger"] && typeof vars["logger"] === "object") {
        const logger = vars["logger"] as { warn?: (msg: string, meta?: unknown) => void };
        logger.warn?.("IP not in allowlist", { clientIp, context: ctx, requestId });
      }
      return c.json(
        {
          error: {
            code: "FORBIDDEN",
            message: `Access denied: IP is not in the ${ctx} allowlist.`,
            requestId,
          },
        },
        403
      );
    }

    await next();
  });
}
