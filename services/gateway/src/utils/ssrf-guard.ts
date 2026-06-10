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
// The 169.254.0.0/16 block covers AWS/GCP IMDS endpoints (169.254.169.254).
const BLOCKED_CIDR_BLOCKS: CidrBlock[] = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "127.0.0.0/8",
  "169.254.0.0/16",
].map(parseCidr);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns true when `ip` falls within any blocked IPv4 CIDR range or is
 * the IPv6 loopback address. Handles both IPv4 and IPv6 (::1) inputs.
 */
export function isBlockedIpRange(ip: string): boolean {
  // IPv6 loopback
  if (ip === "::1") return true;

  // IPv4-mapped IPv6 (::ffff:x.x.x.x) — extract the dotted-decimal portion
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  const candidate = mapped?.[1] ?? ip;

  const asInt = ipv4ToInt(candidate);
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
 * - "localhost" (exact match, case-insensitive)
 * - "*.local"   (mDNS names used on Docker/LAN networks)
 * - "*-service" (Docker Compose internal service names, e.g. auth-service)
 */
export function isBlockedHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (lower === "localhost") return true;
  if (lower.endsWith(".local")) return true;
  if (lower.endsWith("-service")) return true;
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
