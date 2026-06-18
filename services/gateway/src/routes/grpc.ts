/**
 * gRPC-Web route registration for the Hono gateway app.
 *
 * All gRPC-Web requests arrive at /grpc/* with Content-Type
 * "application/grpc-web[+json]". This route catches all POSTs under that
 * prefix and delegates to the GrpcWebHandler dispatcher.
 *
 * WHY a single catch-all route:
 *   gRPC-Web path schema is /{package}.{Service}/{Method}. A wildcard route
 *   avoids manually registering every method. The GrpcWebHandler does the
 *   actual method dispatch via the ServiceRegistry.
 */

import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import type { GrpcWebHandler } from "../grpc/grpc-web-handler.js";

export interface GrpcRouteDeps {
  readonly grpcWebHandler: GrpcWebHandler;
}

export function createGrpcRoutes(
  deps: GrpcRouteDeps,
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();

  // gRPC-Web uses POST for all calls (unary, client-streaming, server-streaming).
  routes.post("/*", async (c) => {
    const response = await deps.grpcWebHandler.handle(c);
    if (response === null) {
      // Content-type was not gRPC-Web — return 415 Unsupported Media Type.
      return c.json(
        {
          error: {
            code: "GRPC_UNSUPPORTED_CONTENT_TYPE",
            message:
              "gRPC endpoint requires Content-Type: application/grpc-web[+json]",
          },
        },
        415,
      );
    }
    return response;
  });

  return routes;
}
