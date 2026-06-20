import { createMiddleware } from "hono/factory";
import type { MiddlewareHandler } from "hono";

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
  const rejectAll = config.allowedOrigins.length === 0;
  const originSet = new Set(config.allowedOrigins);

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

    if (rejectAll || (!allowAll && !originSet.has(origin))) {
      const safeOrigin = origin.length > 256 ? origin.slice(0, 256) + "..." : origin;
      const sanitized = safeOrigin.replace(/[&<>"']/g, (ch) => {
        const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" };
        return map[ch] ?? ch;
      });
      return c.json(
        {
          error: {
            code: "ORIGIN_NOT_ALLOWED",
            message: `Origin '${sanitized}' is not permitted.`,
            requestId: c.var["requestId"] ?? "",
          },
        },
        403
      );
    }

    if (c.req.method === "OPTIONS") {
      // Preflight: respond with headers and terminate — no further processing
      const res = new Response(null, { status: 204 });
      setCorsHeaders(origin, res.headers);
      return res;
    }

    await next();

    // Set CORS headers on the actual response after route handler runs
    setCorsHeaders(origin, c.res.headers);
  });
}
