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
import { otelMiddleware } from "./middleware/otel.js";

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

/**
 * Registers global handlers for uncaught exceptions and unhandled rejections.
 *
 * Call once per process at startup. The function is idempotent — subsequent
 * calls are no-ops so services can call it unconditionally during bootstrap.
 *
 * All fatal errors are written to `process.stderr` as structured JSON before
 * the process exits, ensuring container runtimes capture them even when the
 * structured logger itself is unavailable.
 *
 * @param logger - Optional structured logger; used in addition to stderr output.
 */
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
    setTimeout(() => process.exit(1), GRACEFUL_SHUTDOWN_MS).unref();
  });

  process.on("unhandledRejection", (reason: unknown) => {
    logFatal("unhandledRejection", reason);
    setTimeout(() => process.exit(1), GRACEFUL_SHUTDOWN_MS).unref();
  });
}

/**
 * Configuration for {@link createApp}.
 *
 * Passed once at startup; all fields are immutable for the lifetime of the app.
 */
export interface CreateAppConfig {
  /** Human-readable service name used in logs and telemetry (e.g. `'ontology-service'`). */
  serviceName: string;
  /** Semver version string included in log output for traceability. */
  version: string;

  // Auth middleware dependencies
  /** HS256 secret used to verify and sign JWTs (`OP_JWT_SECRET`). */
  jwtSecret: string;
  /** Redis client used by the auth middleware for token blocklist lookups. */
  redis: Redis;
  /**
   * Callback that resolves an API key to a `UserContext`, or `null` if the key
   * is invalid. Called on every request that presents an `X-API-Key` header.
   */
  validateApiKey: (key: string) => Promise<UserContext | null>;

  /** Allowed CORS origins from `OP_ALLOWED_ORIGINS`; requests from other origins receive 403. */
  allowedOrigins: string[];

  /**
   * Routes that bypass JWT/API-key authentication.
   * Typically `['/healthz', '/readyz']` plus any public OAuth callback paths.
   */
  publicRoutes: string[];

  /** The name of *this* service used to verify incoming service-to-service tokens. */
  targetService: string;
  /** Ed25519 public keys keyed by service name, loaded from `/data/service-keys/` at startup. */
  servicePublicKeys: Record<string, string>;

  /**
   * Maximum allowed request body size in bytes. Defaults to 10 MiB.
   *
   * Requests exceeding this limit receive `413 Payload Too Large` before any
   * business logic runs, preventing memory exhaustion from oversized uploads.
   */
  maxBodySize?: number;
}

/**
 * Creates the standard Hono application for an OnePlatform service.
 *
 * Wires the 11-layer middleware stack defined in spec §5. Middleware order
 * is load-bearing — do NOT reorder without updating the spec:
 *
 * 1. `requestId`          — must run first; propagated to every other layer
 * 2. `securityHeaders`    — HSTS, CSP, etc. applied before any handler runs
 * 3. `cors`               — validates Origin; preflight returns early
 * 4. `auth`               — validates JWT/API key; sets `c.var.user`
 * 5. `serviceAuth`        — on `/internal/*`, validates Ed25519 token + RBAC
 * 6. `responseEnvelope`   — wraps 2xx JSON in `{ data: T }`
 * 7. `errorHandler`       — catches thrown errors → `{ error: {...} }`
 * 8. `rateLimitHeaders`   — appends `X-RateLimit-*` headers
 * 9. `deprecationHeaders` — appends RFC 8594 headers for deprecated routes
 *
 * @param config - Service-specific configuration; see {@link CreateAppConfig}.
 * @returns A Hono app instance with the full middleware stack applied. Mount routes on it.
 */
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

  // 3. OTEL instrumentation — placed after requestId (which sets the request
  // correlation ID) but before CORS and auth so the span covers the full
  // request lifecycle including any auth failures or preflight short-circuits.
  // Gracefully degrades when OTEL_EXPORTER_OTLP_ENDPOINT is not configured.
  app.use("*", otelMiddleware({ serviceName: config.serviceName }));

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
