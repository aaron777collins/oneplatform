import { Hono } from "hono";
import type { Redis } from "ioredis";
import type { UserContext, AppVariables } from "./types.js";
import { requestIdMiddleware } from "./middleware/request-id.js";
import { corsMiddleware } from "./middleware/cors.js";
import { authMiddleware } from "./middleware/auth.js";
import { serviceAuthMiddleware } from "./middleware/service-auth.js";
import { responseEnvelopeMiddleware } from "./middleware/response-envelope.js";
import { errorHandlerMiddleware } from "./middleware/error-handler.js";
import { rateLimitHeadersMiddleware } from "./middleware/rate-limit-headers.js";
import { deprecationHeadersMiddleware } from "./middleware/deprecation-headers.js";

export interface CreateAppConfig {
  serviceName: string;
  version: string;

  // Auth middleware dependencies
  jwtSecret: string;
  redis: Redis;
  validateApiKey: (key: string) => Promise<UserContext | null>;

  // CORS configuration (OP_ALLOWED_ORIGINS)
  allowedOrigins: string[];

  // Routes that bypass user auth (healthz, readyz, bootstrap, public OAuth callbacks)
  publicRoutes: string[];

  // Service-to-service auth configuration
  // targetService: the name of THIS service (e.g. "ontology-service")
  targetService: string;
  // servicePublicKeys: loaded from /data/service-keys/ at startup
  servicePublicKeys: Record<string, string>;
}

// createApp() is the single entry point for every @oneplatform service.
// It wires the 10-middleware stack in the order defined in spec §5.
// Middleware order is intentional — do NOT reorder without updating the spec:
//
//  1. requestId           — must run first (requestId is needed by all others)
//  2. cors                — must run before auth (preflight returns early)
//  3. auth                — validates user credentials, sets c.var.user
//  4. serviceAuth         — on /internal/* routes, validates Ed25519 token + RBAC
//  5. responseEnvelope    — wraps 2xx JSON responses in { data: T }
//  6. errorHandler        — catches thrown errors, formats them as { error: {...} }
//  7. rateLimitHeaders    — appends X-RateLimit-* to responses (Gateway sets c.var.rateLimitInfo)
//  8. deprecationHeaders  — appends Deprecation/Sunset/Link for deprecated routes
//
// OTEL instrumentation (middleware position 2 in the spec) is left as a stub
// here. It will be wired in Task 22 (observability) once the OTEL package is added.
export function createApp(config: CreateAppConfig): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();

  // 1. Request ID — propagate or generate
  app.use("*", requestIdMiddleware());

  // 2. OTEL instrumentation (stub — wired in the observability task)
  // app.use("*", otelMiddleware({ serviceName: config.serviceName }));

  // 3. CORS — validates Origin, handles preflight
  app.use("*", corsMiddleware({ allowedOrigins: config.allowedOrigins }));

  // 4. (Rate limit enforcement belongs to Gateway; other services skip it)

  // 5. User auth — JWT / API key / public route bypass
  app.use(
    "*",
    authMiddleware({
      jwtSecret: config.jwtSecret,
      redis: config.redis,
      validateApiKey: config.validateApiKey,
      publicRoutes: config.publicRoutes,
    })
  );

  // 6. Service auth — Ed25519 + RBAC on /internal/* routes
  app.use(
    "/internal/*",
    serviceAuthMiddleware({
      targetService: config.targetService,
      servicePublicKeys: config.servicePublicKeys,
    })
  );

  // 7. Response envelope — wrap 2xx JSON in { data: T }
  app.use("*", responseEnvelopeMiddleware());

  // 8. Error handler — catch thrown errors → { error: {...} }
  // In Hono v4, route errors bypass middleware try/catch and go directly to
  // app.onError. Using app.onError is the only correct hook (spec §6).
  app.onError(errorHandlerMiddleware());

  // 9. Rate limit headers — append X-RateLimit-* (set by Gateway before forwarding)
  app.use("*", rateLimitHeadersMiddleware());

  // 10. Deprecation headers — append RFC 8594 headers for deprecated routes
  app.use("*", deprecationHeadersMiddleware());

  return app;
}
