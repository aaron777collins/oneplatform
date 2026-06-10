import { createMiddleware } from "hono/factory";
import type { DeprecationInfo } from "../types.js";

export type { DeprecationInfo };

export function deprecationHeadersMiddleware() {
  return createMiddleware(async (c, next) => {
    await next();

    const info = c.var["deprecationInfo"] as DeprecationInfo | undefined;
    if (!info) return;

    // RFC 8594 Deprecation header — simple boolean value
    c.header("Deprecation", "true");

    // Sunset header: RFC 7231 HTTP-date format (e.g. "Sat, 01 Jan 2028 00:00:00 GMT")
    c.header("Sunset", info.sunset.toUTCString());

    // Link header with rel=successor-version pointing to the replacement docs
    c.header("Link", `<${info.successorUrl}>; rel="successor-version"`);
  });
}
