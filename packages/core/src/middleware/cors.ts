import { createMiddleware } from "hono/factory";
import type { MiddlewareHandler } from "hono";
import type { Logger } from "../logger.js";

export interface CorsConfig {
  allowedOrigins: string[];
}

const ALLOWED_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
const ALLOWED_HEADERS = "Authorization, Content-Type, X-API-Key, X-Requested-With";
// Expose rate-limit headers + request ID to browser apps (spec §6 CORS Policy)
const EXPOSE_HEADERS =
  "X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, X-RateLimit-Policy, X-OnePlatform-Request-ID";
const MAX_AGE = "86400";

/**
 * Extract the request-scoped logger from the Hono context variable bag.
 *
 * The logger is injected per-request by an upstream middleware (e.g. the
 * logging middleware) and carries the request's trace ID.  We consume it
 * optionally so the CORS middleware stays usable without a full logging stack
 * (e.g. in unit tests or lightweight service configurations).
 */
function getLogger(vars: Record<string, unknown>): Logger | undefined {
  const candidate = vars["logger"];
  if (
    candidate !== null &&
    typeof candidate === "object" &&
    typeof (candidate as Logger).warn === "function" &&
    typeof (candidate as Logger).debug === "function"
  ) {
    return candidate as Logger;
  }
  return undefined;
}

/**
 * Hono middleware that enforces the `OP_ALLOWED_ORIGINS` allowlist.
 *
 * Requests from unknown origins return `403 ORIGIN_NOT_ALLOWED` rather than
 * a browser-level CORS failure. This prevents leaking endpoint existence to
 * attackers probing from untrusted origins (spec §6 CORS Policy).
 *
 * Wired automatically by {@link createApp}; export is for services that need a
 * custom middleware stack.
 *
 * @param config - Explicit list of permitted origins.
 */
export function corsMiddleware(config: CorsConfig): MiddlewareHandler {
  const allowAll = config.allowedOrigins.includes("*");

  // Derive the origin from OP_BASE_URL so any deployment works without also
  // having to add the same host to OP_ALLOWED_ORIGINS. The two env vars
  // serve different purposes: OP_BASE_URL is the canonical public URL of the
  // platform; OP_ALLOWED_ORIGINS is an explicit override/addition list.
  const baseUrlOrigin = (() => {
    const raw = process.env["OP_BASE_URL"];
    if (!raw) return null;
    try {
      return new URL(raw).origin;
    } catch {
      return null;
    }
  })();

  const effectiveOrigins = baseUrlOrigin
    ? [...config.allowedOrigins, baseUrlOrigin]
    : config.allowedOrigins;

  const rejectAll = effectiveOrigins.length === 0;
  const originSet = new Set(effectiveOrigins);

  function setCorsHeaders(origin: string, headers: Headers): void {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Methods", ALLOWED_METHODS);
    headers.set("Access-Control-Allow-Headers", ALLOWED_HEADERS);
    headers.set("Access-Control-Expose-Headers", EXPOSE_HEADERS);
    headers.set("Access-Control-Max-Age", MAX_AGE);
    headers.set("Access-Control-Allow-Credentials", "true");
    // Vary: Origin required per RFC 7234 — without it, intermediary caches may
    // serve a response with one origin's CORS headers to a different origin.
    headers.set("Vary", "Origin");
  }

  return createMiddleware(async (c, next) => {
    const origin = c.req.header("Origin");

    // No Origin header = not a browser cross-origin request (CLI, server SDK, etc.)
    if (!origin) {
      await next();
      return;
    }

    // Same-origin auto-detection: browsers include Origin on cross-origin requests.
    // We compare the Origin's host against the public-facing host so the platform
    // works on any domain without per-deployment CORS config.
    //
    // Header priority (most-to-least authoritative for the public host):
    //   1. X-Forwarded-Host — set by the gateway when proxying to internal services;
    //      reflects the original public host the browser connected to.
    //   2. Host             — direct connections (external Caddy → gateway); when
    //      the gateway calls an upstream service via fetch(), the Fetch API
    //      overrides Host with the internal service hostname (e.g. auth-service:3000),
    //      so for proxied requests Host is NOT the public host.
    let isSameOrigin = false;
    try {
      const originHost = new URL(origin).host;
      const requestHost = c.req.header("X-Forwarded-Host") ?? c.req.header("Host") ?? "";
      isSameOrigin = originHost === requestHost;
    } catch {
      // Malformed origin URL — fall through to allowlist check
    }

    if (!isSameOrigin && (rejectAll || (!allowAll && !originSet.has(origin)))) {
      const safeOrigin = origin.length > 256 ? origin.slice(0, 256) + "..." : origin;
      const sanitized = safeOrigin.replace(/[&<>"']/g, (ch) => {
        const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" };
        return map[ch] ?? ch;
      });

      // Log at WARN so operators can detect misconfigured clients or probing
      // attempts without having to inspect raw HTTP access logs.
      const requestId: string = c.var["requestId"] ?? "";
      const logger = getLogger(c.var as Record<string, unknown>);
      logger?.warn("cors: origin rejected", {
        origin: safeOrigin,
        method: c.req.method,
        path: c.req.path,
        requestId,
      });

      return c.json(
        {
          error: {
            code: "ORIGIN_NOT_ALLOWED",
            message: `Origin '${sanitized}' is not permitted.`,
            requestId,
          },
        },
        403
      );
    }

    // Log allowed origins at DEBUG — useful when diagnosing CORS failures in
    // development or when OP_LOG_LEVEL=debug is set in a test environment.
    const logger = getLogger(c.var as Record<string, unknown>);
    logger?.debug("cors: origin allowed", {
      origin,
      method: c.req.method,
      path: c.req.path,
      requestId: c.var["requestId"] ?? "",
      isSameOrigin,
    });

    if (c.req.method === "OPTIONS") {
      // Preflight: respond with headers and terminate — no further processing
      const res = new Response(null, { status: 204 });
      setCorsHeaders(origin, res.headers);
      return res;
    }

    await next();

    try {
      setCorsHeaders(origin, c.res.headers);
    } catch {
      // Headers may be immutable (e.g. streaming). Best-effort.
    }
  });
}
