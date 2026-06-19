import { createMiddleware } from "hono/factory";

// responseEnvelopeMiddleware wraps every successful JSON route response in
// { data: T }. This is automatic — routes return raw objects and the envelope
// is applied here. Routes cannot accidentally bypass the envelope format because
// it is applied in middleware, not via opt-in decorators (spec §6).
//
// Special cases:
//  - 204 No Content: no body to wrap, pass through unchanged.
//  - Responses already containing an "error" key: these come from the error
//    handler and must not be double-wrapped.
export function responseEnvelopeMiddleware() {
  return createMiddleware(async (c, next) => {
    await next();

    // Health endpoints return unwrapped JSON per spec §6 — Docker Compose
    // probes and the Gateway parse these directly.
    const path = new URL(c.req.url).pathname;
    if (path === "/healthz" || path === "/readyz") return;

    // Only wrap JSON responses with a 2xx status
    const contentType = c.res.headers.get("Content-Type") ?? "";
    if (!contentType.includes("application/json")) return;
    if (c.res.status === 204) return;
    if (!String(c.res.status).startsWith("2")) return;

    const body: unknown = await c.res.clone().json();

    // Do not wrap error-shaped responses (these come from thrown AppErrors
    // serialized by the error handler, or from inline c.json({error:...}) calls)
    if (body !== null && typeof body === "object" && "error" in (body as object)) {
      return;
    }

    // Do not wrap responses that are already enveloped — i.e. the route (or an
    // upstream service proxied through the Gateway) already returned { data: T }.
    // Without this check, the middleware would produce { data: { data: T } },
    // which breaks frontend consumers that expect a single envelope layer.
    if (body !== null && typeof body === "object" && "data" in (body as object)) {
      return;
    }

    // StatusCode cast is safe: we already checked the status starts with "2"
    // and excluded 204, so it must be a valid JSON-bearing 2xx ContentfulStatusCode.
    const status = c.res.status as 200 | 201 | 202 | 203;
    c.res = c.newResponse(JSON.stringify({ data: body }), status, {
      "Content-Type": "application/json",
    });
  });
}
