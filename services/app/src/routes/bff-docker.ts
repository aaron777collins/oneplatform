import { Hono } from "hono";
import type { AppVariables, Logger } from "@oneplatform/core";
import { UnauthorizedError, ForbiddenError, signUserContext } from "@oneplatform/core";
import type { Redis } from "ioredis";

// ---------------------------------------------------------------------------
// BFF — Docker Fleet Manager proxy routes (design §3, §8)
//
// These routes bridge the browser (Docker Fleet Manager app) to the Docker BFF
// Sidecar. They are mounted at `/bff/docker/*` and are opt-in: the App Service
// only registers them when OP_ENABLE_DOCKER_BFF=true (see index.ts), so a
// deployment without the sidecar never exposes a Docker control plane.
//
// Middleware stack (in order):
//   1. requireSession  — the global auth middleware already populated c.var.user
//   2. requireDockerRole — user must hold the 'admin' or 'devops' platform role
//   3. rateLimit (mutations) — 20 action requests / minute / user
//   4. auditLog (mutations) — record every POST/DELETE before forwarding
//   5. proxyToSidecar — strip the prefix and forward to docker-bff:3010
// ---------------------------------------------------------------------------

export interface BffDockerRouteDeps {
  /** Docker BFF Sidecar base URL. Falls back to DOCKER_BFF_URL env var. */
  dockerBffUrl?: string;
  /** Shared secret attached as X-Service-Token on forwarded requests. */
  serviceTokenSecret: string;
  redis: Redis;
  logger: Logger;
}

const DOCKER_ROLES = new Set(["admin", "devops"]);

// Per-user action rate limit: 20 mutating requests per 60s window.
const ACTION_LIMIT = 20;
const ACTION_WINDOW_SECONDS = 60;

export function createBffDockerRoutes(
  deps: BffDockerRouteDeps,
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { serviceTokenSecret, redis, logger } = deps;
  const dockerBffUrl =
    deps.dockerBffUrl ??
    process.env["DOCKER_BFF_URL"] ??
    "http://docker-bff:3010";

  // 1 + 2: authentication + RBAC for every Docker route.
  routes.use("*", async (c, next) => {
    const user = c.var.user;
    if (user === undefined) {
      throw new UnauthorizedError("Authentication required.");
    }
    const allowed = user.roles.some((r) => DOCKER_ROLES.has(r));
    if (!allowed) {
      throw new ForbiddenError(
        "Docker Fleet Manager requires the admin or devops role.",
        { requiredRoles: ["admin", "devops"] },
      );
    }
    await next();
  });

  // 3 + 4: rate-limit and audit mutating requests (POST, DELETE).
  routes.on(["POST", "DELETE"], "*", async (c, next) => {
    const user = c.var.user;
    if (user === undefined) {
      throw new UnauthorizedError("Authentication required.");
    }

    // Per-user sliding-ish fixed-window rate limiter backed by Redis.
    const bucketKey = `bff:docker:rl:${user.userId}`;
    let count = 0;
    try {
      count = await redis.incr(bucketKey);
      if (count === 1) {
        await redis.expire(bucketKey, ACTION_WINDOW_SECONDS);
      }
    } catch {
      // If Redis is unavailable we fail open on rate limiting rather than
      // blocking legitimate operators — auth + RBAC still gate the request.
      count = 0;
    }
    if (count > ACTION_LIMIT) {
      return c.json(
        {
          error: {
            code: "RATE_LIMITED",
            message: `Too many Docker actions. Limit is ${ACTION_LIMIT} per minute.`,
          },
        },
        429,
      );
    }

    // Audit record — written before the action is forwarded so an attempted
    // action is always recorded even if the upstream call fails.
    logger.info("docker.action", {
      audit: true,
      actorId: user.userId,
      tenantId: user.tenantId,
      method: c.req.method,
      path: c.req.path,
    });

    await next();
    return;
  });

  // 5: proxy everything else to the sidecar.
  routes.all("*", async (c) => {
    const user = c.var.user;
    if (user === undefined) {
      throw new UnauthorizedError("Authentication required.");
    }

    // Strip the `/bff/docker` mount prefix; forward the remainder + query.
    const url = new URL(c.req.url);
    const suffix = url.pathname.replace(/^\/bff\/docker/, "");
    const target = `${dockerBffUrl}${suffix}${url.search}`;

    // Forward the body for mutating requests. GET/DELETE may have no body.
    const method = c.req.method;
    const hasBody = method !== "GET" && method !== "HEAD";
    const body = hasBody ? await c.req.arrayBuffer().catch(() => undefined) : undefined;

    // Base64-encode the context (matching serviceAuthMiddleware's decode) and
    // attach an HMAC signature so the downstream service can trust it. Include
    // scopes so RBAC decisions downstream see the full identity. Without the
    // signature, docker-bff could not adopt serviceAuthMiddleware (which requires
    // X-User-Context-Signature), and the unsigned context was a latent trust gap.
    const userContext = Buffer.from(
      JSON.stringify({
        userId: user.userId,
        tenantId: user.tenantId,
        roles: user.roles,
        scopes: user.scopes,
        isService: user.isService,
        isGuest: user.isGuest,
        emailVerified: user.emailVerified,
      }),
    ).toString("base64");
    const userContextSignature = signUserContext(userContext);

    let upstream: Response;
    try {
      upstream = await fetch(target, {
        method,
        headers: {
          "X-Service-Token": serviceTokenSecret,
          "X-User-Context": userContext,
          "X-User-Context-Signature": userContextSignature,
          ...(hasBody ? { "Content-Type": "application/json" } : {}),
          // Forward the Accept header so SSE endpoints negotiate correctly.
          Accept: c.req.header("accept") ?? "application/json",
        },
        ...(body !== undefined && (body as ArrayBuffer).byteLength > 0
          ? { body: body as ArrayBuffer }
          : {}),
      });
    } catch {
      return c.json(
        {
          error: {
            code: "DOCKER_BFF_UNREACHABLE",
            message: "The Docker management service is not reachable.",
          },
        },
        503,
      );
    }

    // Stream the upstream response straight back to the browser. This handles
    // both JSON envelopes and SSE streams (no buffering at the proxy layer).
    const headers = new Headers();
    const contentType = upstream.headers.get("content-type");
    if (contentType !== null) headers.set("content-type", contentType);
    const cacheControl = upstream.headers.get("cache-control");
    if (cacheControl !== null) headers.set("cache-control", cacheControl);

    return new Response(upstream.body, {
      status: upstream.status,
      headers,
    });
  });

  return routes;
}
