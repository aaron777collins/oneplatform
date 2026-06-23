import { timingSafeEqual } from "node:crypto";
import { createMiddleware } from "hono/factory";

// ---------------------------------------------------------------------------
// Service authentication.
//
// The sidecar accepts requests only from the App Service BFF Docker Proxy. The
// proxy attaches an `X-Service-Token` header carrying a shared secret sourced
// from OP_SERVICE_TOKEN_SECRET. We deliberately use a shared secret here rather
// than the full Ed25519 service-token scheme — the sidecar is a single-purpose
// internal component on the private network, and the simpler scheme keeps it
// dependency-free.
//
// If OP_SERVICE_TOKEN_SECRET is unset the middleware fails closed (rejects all
// requests) so a misconfigured deployment never exposes the Docker socket.
// ---------------------------------------------------------------------------

export const serviceAuth = createMiddleware(async (c, next) => {
  const expected = process.env["OP_SERVICE_TOKEN_SECRET"];
  if (expected === undefined || expected === "") {
    return c.json(
      {
        error: {
          code: "SERVICE_MISCONFIGURED",
          message: "Docker BFF is missing OP_SERVICE_TOKEN_SECRET.",
        },
      },
      503,
    );
  }

  const received = c.req.header("x-service-token");
  if (received === undefined || !constantTimeEqual(received, expected)) {
    return c.json(
      {
        error: {
          code: "FORBIDDEN",
          message: "Valid X-Service-Token is required.",
        },
      },
      403,
    );
  }

  await next();
  return;
});

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    // Compare against self to keep timing roughly constant, then fail.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
