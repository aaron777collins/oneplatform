import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
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

// How long to wait for in-flight requests to drain before forcing exit.
const GRACEFUL_SHUTDOWN_MS = 5_000;

// setupProcessErrorHandlers registers global handlers for uncaught exceptions
// and unhandled rejections. Call once per process at startup (idempotent via
// the installed flag).
//
// Why both handlers: Node exits with code 0 on unhandledRejection (pre-v15) or
// throws (v15+). Neither behaviour produces a structured log entry. We capture
// both to guarantee every fatal error is logged before the process exits.
let processErrorHandlersInstalled = false;

export function setupProcessErrorHandlers(logger?: {
  error(msg: string, meta?: Record<string, unknown>): void;
}): void {
  if (processErrorHandlersInstalled) return;
  processErrorHandlersInstalled = true;

  function logFatal(label: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    const stack   = err instanceof Error ? err.stack  : undefined;

    // Always write to stderr so the container runtime captures it even if the
    // structured logger is unavailable (e.g. Redis is down at crash time).
    const payload = JSON.stringify({ level: "error", label, message, stack, ts: new Date().toISOString() });
    process.stderr.write(payload + "\n");

    // Structured logger is best-effort — swallow any error it throws so it
    // never masks the original failure.
    try {
      logger?.error(label, { message, stack });
    } catch { /* intentionally empty */ }
  }

  process.on("uncaughtException", (err: Error) => {
    logFatal("uncaughtException", err);
    // Allow 5 s for any pending I/O (DB/Redis) to flush before hard exit.
    setTimeout(() => process.exit(1), GRACEFUL_SHUTDOWN_MS).unref();
    process.exit(1);
  });

  process.on("unhandledRejection", (reason: unknown) => {
    logFatal("unhandledRejection", reason);
    setTimeout(() => process.exit(1), GRACEFUL_SHUTDOWN_MS).unref();
    process.exit(1);
  });
}

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

  /**
   * Maximum allowed request body size in bytes. Defaults to 10 MiB.
   * Requests exceeding this limit receive 413 Payload Too Large before any
   * business logic runs, preventing memory exhaustion from large uploads.
   */
  maxBodySize?: number;
}

// createApp() is the single entry point for every @oneplatform service.
// It wires the 11-middleware stack in the order defined in spec §5.
// Middleware order is intentional — do NOT reorder without updating the spec:
//
//  1. requestId           — must run first (requestId is needed by all others)
//  2. securityHeaders     — HSTS, CSP, etc. set before anything else touches the response
//  3. cors                — must run before auth (preflight returns early)
//  4. auth                — validates user credentials, sets c.var.user
//  5. serviceAuth         — on /internal/* routes, validates Ed25519 token + RBAC
//  6. responseEnvelope    — wraps 2xx JSON responses in { data: T }
//  7. errorHandler        — catches thrown errors, formats them as { error: {...} }
//  8. rateLimitHeaders    — appends X-RateLimit-* to responses (Gateway sets c.var.rateLimitInfo)
//  9. deprecationHeaders  — appends Deprecation/Sunset/Link for deprecated routes
//
// OTEL instrumentation (middleware position 2 in the spec) is left as a stub
// here. It will be wired in Task 22 (observability) once the OTEL package is added.
export function createApp(config: CreateAppConfig): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();

  // 0. Body size limit — enforced before any auth or business logic to prevent
  // memory exhaustion from oversized request bodies. 10 MiB default covers all
  // normal API payloads; services with larger upload needs (e.g. file import)
  // should configure a higher limit or handle streaming separately.
  const maxBodySize = config.maxBodySize ?? 10 * 1024 * 1024; // 10 MiB
  app.use(
    "*",
    bodyLimit({
      maxSize: maxBodySize,
      onError: (c) =>
        c.json(
          { error: { code: "PAYLOAD_TOO_LARGE", message: "Request body exceeds the maximum allowed size." } },
          413
        ),
    })
  );

  // 1. Request ID — propagate or generate
  app.use("*", requestIdMiddleware());

  // 2. Security headers — applied to every response before any handler runs.
  // X-XSS-Protection is intentionally set to 0: the legacy browser filter is
  // deprecated and can introduce vulnerabilities. CSP is the correct mitigation.
  // Permissions-Policy denies sensor APIs that this platform never uses.
  app.use("*", async (_c, next) => {
    await next();
    _c.res.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    _c.res.headers.set("X-Content-Type-Options", "nosniff");
    _c.res.headers.set("X-Frame-Options", "DENY");
    _c.res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
    _c.res.headers.set("X-XSS-Protection", "0");
    _c.res.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  });

  // 3. OTEL instrumentation (stub — wired in the observability task)
  // app.use("*", otelMiddleware({ serviceName: config.serviceName }));

  // 4. CORS — validates Origin, handles preflight
  app.use("*", corsMiddleware({ allowedOrigins: config.allowedOrigins }));

  // 5. (Rate limit enforcement belongs to Gateway; other services skip it)

  // 6. User auth — JWT / API key / public route bypass
  app.use(
    "*",
    authMiddleware({
      jwtSecret: config.jwtSecret,
      redis: config.redis,
      validateApiKey: config.validateApiKey,
      publicRoutes: config.publicRoutes,
    })
  );

  // 7. Service auth — Ed25519 + RBAC on /internal/* routes
  app.use(
    "/internal/*",
    serviceAuthMiddleware({
      targetService: config.targetService,
      servicePublicKeys: config.servicePublicKeys,
    })
  );

  // 8. Response envelope — wrap 2xx JSON in { data: T }
  app.use("*", responseEnvelopeMiddleware());

  // 9. Error handler — catch thrown errors → { error: {...} }
  // In Hono v4, route errors bypass middleware try/catch and go directly to
  // app.onError. Using app.onError is the only correct hook (spec §6).
  app.onError(errorHandlerMiddleware());

  // 10. Rate limit headers — append X-RateLimit-* (set by Gateway before forwarding)
  app.use("*", rateLimitHeadersMiddleware());

  // 11. Deprecation headers — append RFC 8594 headers for deprecated routes
  app.use("*", deprecationHeadersMiddleware());

  return app;
}
