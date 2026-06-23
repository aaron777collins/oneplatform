// Shared SSRF blocklist for the pipeline service.
//
// This single source of truth is used at BOTH definition-save time (pipeline-service.ts)
// and at execution time (execution-engine.ts) so that what saves also blocks at runtime.
// Previously the two lists diverged: pipeline-service lacked 0.0.0.0 and had a duplicate
// 169.254.169.254 entry; execution-engine had the correct set. Centralising here prevents
// future drift.

export const SSRF_BLOCKED_PATTERNS: readonly RegExp[] = [
  // Loopback — IPv4 and IPv6 ::1
  /^https?:\/\/localhost(:\d+)?(\/|$)/i,
  /^https?:\/\/127\.\d+\.\d+\.\d+(:\d+)?(\/|$)/,
  /^https?:\/\/\[::1\](:\d+)?(\/|$)/i,
  // Unspecified address (binds all interfaces on the host)
  /^https?:\/\/0\.0\.0\.0(:\d+)?(\/|$)/,
  // RFC-1918 private ranges
  /^https?:\/\/10\.\d+\.\d+\.\d+(:\d+)?(\/|$)/,
  /^https?:\/\/172\.(1[6-9]|2\d|3[01])\.\d+\.\d+(:\d+)?(\/|$)/,
  /^https?:\/\/192\.168\.\d+\.\d+(:\d+)?(\/|$)/,
  // Link-local — IPv4 (covers 169.254.x.x including cloud metadata IPs) and IPv6 fe80::
  /^https?:\/\/169\.254\.\d+\.\d+(:\d+)?(\/|$)/,
  /^https?:\/\/\[fe80:/i,
  // Cloud metadata endpoints not already covered by 169.254.x.x
  /^https?:\/\/metadata\.google\.internal(:\d+)?(\/|$)/i,
  /^https?:\/\/100\.100\.100\.200(:\d+)?(\/|$)/,
];

export function isUrlSsrfBlocked(url: string): boolean {
  return SSRF_BLOCKED_PATTERNS.some((pattern) => pattern.test(url));
}
