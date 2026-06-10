import { createMiddleware } from "hono/factory";

export interface DeprecationInfo {
  // Date when the endpoint will be removed (RFC 8594 Sunset)
  sunset: Date;
  // URL of the replacement endpoint (links to API docs for new version)
  successorUrl: string;
}

// deprecationHeadersMiddleware appends RFC 8594 headers to responses for
// deprecated endpoints. Routes set c.var.deprecationInfo to opt in.
// Headers: Deprecation, Sunset, Link (spec §6 API Versioning and Deprecation).
export function deprecationHeadersMiddleware() {
  return createMiddleware(async (c, next) => {
    await next();

    const info = (c.var as { deprecationInfo?: DeprecationInfo }).deprecationInfo;
    if (!info) return;

    // RFC 8594 Deprecation header — simple boolean value
    c.header("Deprecation", "true");

    // Sunset header: RFC 7231 HTTP-date format (e.g. "Sat, 01 Jan 2028 00:00:00 GMT")
    c.header("Sunset", info.sunset.toUTCString());

    // Link header with rel=successor-version pointing to the replacement docs
    c.header("Link", `<${info.successorUrl}>; rel="successor-version"`);
  });
}
