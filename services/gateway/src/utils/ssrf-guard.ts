// SSRF prevention for outbound webhook URLs.
//
// DNS rebinding attacks can bypass a one-time registration check: an attacker
// registers a webhook pointing to a legitimate hostname, then swaps the DNS
// record to point at an internal IP. This module is called both at registration
// time AND on every delivery attempt to close that window.

import dns from "node:dns";
import { WebhookSsrfBlockedError, WebhookInvalidUrlError } from "../services/errors.js";

// ---------------------------------------------------------------------------
// Private / blocked IP ranges
// ---------------------------------------------------------------------------

interface CidrBlock {
  base: number; // network address as 32-bit integer
  mask: number; // prefix mask as 32-bit integer
}

function ipv4ToInt(ip: string): number {
  const parts = ip.split(".");
  // Return -1 for inputs that are not valid dotted-decimal — the caller will
  // handle this via the isBlockedIpRange return value.
  if (parts.length !== 4) return -1;
  return parts.reduce((acc, octet) => {
    const n = parseInt(octet, 10);
    return (acc << 8) | n;
  }, 0) >>> 0; // unsigned 32-bit
}

function parseCidr(cidr: string): CidrBlock {
  const [addr, prefixStr] = cidr.split("/");
  const prefix = parseInt(prefixStr ?? "32", 10);
  const base = ipv4ToInt(addr ?? "");
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return { base: base & mask, mask };
}

// These ranges must never be reachable from an outbound webhook delivery.
// 169.254.0.0/16 covers AWS IMDSv1/v2 (169.254.169.254), Azure IMDS, and
// GCP metadata (also reachable via 169.254.169.254 and metadata.google.internal).
const BLOCKED_CIDR_BLOCKS: CidrBlock[] = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "127.0.0.0/8",
  "169.254.0.0/16",  // link-local: AWS/GCP/Azure instance metadata service
  "100.64.0.0/10",   // CGNAT shared address space (RFC 6598) — often used in K8s pods
].map(parseCidr);

// Cloud-metadata hostnames that must be blocked regardless of their resolved IP.
// DNS rebinding can make these point at unexpected IPs, so we block by name too.
const BLOCKED_HOSTNAME_PATTERNS: Array<string | RegExp> = [
  // AWS/Azure instance metadata endpoints
  "169.254.169.254",
  // GCP metadata endpoints
  "metadata.google.internal",
  "metadata.google.com",
  // Kubernetes in-cluster API server default service name
  "kubernetes.default",
  "kubernetes.default.svc",
  "kubernetes.default.svc.cluster.local",
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns true when `ip` falls within any blocked IPv4 CIDR range or is a
 * blocked IPv6 address. Handles IPv4, IPv4-mapped IPv6 (both dotted-decimal
 * and compact-hex forms), IPv6 loopback, link-local, and unique-local ranges.
 */
export function isBlockedIpRange(ip: string): boolean {
  const lower = ip.toLowerCase();

  // IPv6 loopback — normalised form returned by Node's dns.resolve6()
  if (lower === "::1") return true;

  // IPv6 unspecified address — equivalent to 0.0.0.0 in IPv4; should never
  // be a valid delivery target and is already blocked in the IPv4 CIDR list.
  if (lower === "::") return true;

  // Link-local IPv6: fe80::/10 — covers fe80:: through febf::
  // The first 10 bits of the address must be 1111111010 (0xfe80 with mask 0xffc0).
  // We match on the prefix characters; any address starting with fe8/fe9/fea/feb
  // that has the top 10 bits set falls in this range.
  if (/^fe[89ab][0-9a-f]/i.test(lower)) return true;

  // Unique-local IPv6: fc00::/7 — covers fc00:: through fdff::
  if (/^f[cd][0-9a-f]{2}/i.test(lower)) return true;

  // IPv4-mapped IPv6 — dotted-decimal form: ::ffff:x.x.x.x
  const mappedDotted = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedDotted) {
    const asInt = ipv4ToInt(mappedDotted[1] ?? "");
    return asInt !== -1 && BLOCKED_CIDR_BLOCKS.some((block) => (asInt & block.mask) === block.base);
  }

  // IPv4-mapped IPv6 — compact-hex form: ::ffff:aabb:ccdd
  // e.g. ::ffff:7f00:0001 represents 127.0.0.1
  const mappedHex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const high = parseInt(mappedHex[1] ?? "0", 16);
    const low = parseInt(mappedHex[2] ?? "0", 16);
    const asInt = (((high << 16) | low) >>> 0);
    return BLOCKED_CIDR_BLOCKS.some((block) => (asInt & block.mask) === block.base);
  }

  // Plain IPv4
  const asInt = ipv4ToInt(lower);
  if (asInt === -1) return false; // not a parseable IPv4 address; not blocked

  return BLOCKED_CIDR_BLOCKS.some(
    (block) => (asInt & block.mask) === block.base
  );
}

/**
 * Returns true when `hostname` is known to resolve to an internal target
 * without requiring a DNS lookup. This is a fast pre-check; full DNS
 * resolution happens in `validateWebhookUrl`.
 *
 * Blocked patterns:
 * - "localhost"                    (exact match, case-insensitive)
 * - "0.0.0.0"                     (resolves to localhost on Linux)
 * - "169.254.169.254"             (AWS/GCP/Azure instance metadata service)
 * - "metadata.google.internal"    (GCP metadata hostname)
 * - "metadata.google.com"         (GCP metadata hostname)
 * - "kubernetes.default*"         (K8s in-cluster API server)
 * - any hostname containing "metadata" as a segment
 * - "*.local"                     (mDNS names used on Docker/LAN networks)
 * - "*-service"                   (Docker Compose internal service names)
 */
export function isBlockedHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (lower === "localhost") return true;
  if (lower === "0.0.0.0") return true;
  if (lower.endsWith(".local")) return true;
  if (lower.endsWith("-service")) return true;

  // Block all cloud metadata and K8s API-server hostnames by exact or prefix match.
  for (const pattern of BLOCKED_HOSTNAME_PATTERNS) {
    if (typeof pattern === "string") {
      if (lower === pattern || lower.endsWith(`.${pattern}`)) return true;
    } else {
      if (pattern.test(lower)) return true;
    }
  }

  // Block any hostname segment that is exactly "metadata" — catches
  // customer-controlled subdomains like "my-metadata.example.com" that could
  // be DNS-rebound to a cloud IMDS address.
  if (lower.split(".").includes("metadata")) return true;

  // Block kubernetes.default and any subdomain of it (e.g. kubernetes.default.svc).
  if (lower === "kubernetes.default" || lower.startsWith("kubernetes.default.")) return true;

  return false;
}

/**
 * Validates that a webhook URL is safe to deliver to.
 *
 * Throws `WebhookInvalidUrlError` when:
 * - The URL cannot be parsed
 * - The protocol is not https (unless OP_WEBHOOK_ALLOW_HTTP=true)
 * - The hostname matches a known-blocked pattern
 *
 * Throws `WebhookSsrfBlockedError` when:
 * - Any resolved IPv4 or IPv6 address falls within a blocked range
 *
 * Call this at registration time AND before every delivery attempt to guard
 * against DNS rebinding (a legitimate hostname whose record later changes to
 * point at an internal IP).
 */
export async function validateWebhookUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new WebhookInvalidUrlError(
      `Webhook URL is malformed and cannot be parsed: "${url}".`
    );
  }

  const allowHttp = process.env["OP_WEBHOOK_ALLOW_HTTP"] === "true";
  if (parsed.protocol !== "https:" && !(allowHttp && parsed.protocol === "http:")) {
    throw new WebhookInvalidUrlError(
      `Webhook URL must use the https:// protocol. Received: "${parsed.protocol}//"`,
      { url, protocol: parsed.protocol }
    );
  }

  const { hostname } = parsed;

  if (isBlockedHostname(hostname)) {
    throw new WebhookSsrfBlockedError(
      `Webhook URL hostname "${hostname}" is blocked. ` +
        `Internal service names, "localhost", and "*.local" addresses are not permitted.`,
      { url, hostname }
    );
  }

  // Resolve both A and AAAA records. A CDN or load-balanced hostname may
  // return multiple IPs and ALL must be clean.
  let ipv4Addresses: string[] = [];
  let ipv6Addresses: string[] = [];

  try {
    ipv4Addresses = await dns.promises.resolve4(hostname);
  } catch {
    // resolve4 throws when there are no A records (AAAA-only host, or DNS
    // error). We proceed and rely on IPv6 results, or throw below if both fail.
  }

  try {
    ipv6Addresses = await dns.promises.resolve6(hostname);
  } catch {
    // Same as above — not every host has AAAA records.
  }

  const allAddresses = [...ipv4Addresses, ...ipv6Addresses];

  if (allAddresses.length === 0) {
    throw new WebhookInvalidUrlError(
      `Could not resolve hostname "${hostname}" to any IP address. ` +
        `Ensure the domain exists and is reachable.`,
      { url, hostname }
    );
  }

  for (const ip of allAddresses) {
    if (isBlockedIpRange(ip)) {
      throw new WebhookSsrfBlockedError(
        `The webhook URL resolves to a private IP address (${ip}) and cannot be registered.`,
        { url, resolvedIp: ip }
      );
    }
  }
}
