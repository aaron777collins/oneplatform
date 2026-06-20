// Embed routes — G-071
//
// Two route groups:
//   /api/v1/apps/:appId/embed*  — management (generate, list, revoke) — require user auth
//   /api/v1/embed/:token        — serve (validate token, set CSP headers) — public
//
// Security model:
//   - Management routes require a valid user session; the app must belong to
//     the authenticated user's tenant.
//   - The serve route is intentionally public — the token IS the credential.
//     We omit X-Frame-Options and set frame-ancestors in CSP dynamically based
//     on the token's allowedOrigins list.
//   - Embed tokens are signed with a dedicated secret (embedSecret), distinct
//     from the user auth JWT secret, so they cannot be confused with sessions.

import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import { ValidationError, UnauthorizedError, NotFoundError } from "@oneplatform/core";
import { CreateEmbedTokenSchema } from "../schemas/index.js";
import type { EmbedService } from "../services/embed-service.js";
import { isOriginAllowed } from "../services/embed-service.js";
import type { AppService } from "../services/app-service.js";
import {
  EmbedTokenInvalidError,
  EmbedTokenNotFoundError,
  EmbedTokenExpiredError,
  EmbedTokenRevokedError,
  EmbedOriginNotAllowedError,
} from "../services/errors.js";

// ---------------------------------------------------------------------------
// Route dependencies
// ---------------------------------------------------------------------------

export interface EmbedRouteDeps {
  embedService: EmbedService;
  appService:   AppService;
  baseUrl:      string;
}

// ---------------------------------------------------------------------------
// Rate limiting — embed token generation
//
// In-memory sliding window counter.  In a multi-replica deployment this should
// use Redis (same pattern as guest session rate limiting in index.ts).
// A Redis-backed implementation is tracked as an operational enhancement.
// ---------------------------------------------------------------------------

interface RateLimitBucket {
  count:   number;
  resetAt: number;  // epoch ms
}

const RATE_LIMIT_WINDOW_MS  = 60_000;  // 1 minute window
const RATE_LIMIT_MAX_TOKENS = 10;      // max new embed tokens per user per window

const rateLimitBuckets = new Map<string, RateLimitBucket>();

// Purge expired buckets every 5 minutes so the Map doesn't grow without bound
// as unique users accumulate. Unref lets the process exit without waiting for
// this timer when running in test environments.
const _rateLimitCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [userId, bucket] of rateLimitBuckets) {
    if (now >= bucket.resetAt) {
      rateLimitBuckets.delete(userId);
    }
  }
}, 5 * 60_000).unref();

function checkRateLimit(userId: string): boolean {
  const now    = Date.now();
  const bucket = rateLimitBuckets.get(userId);

  if (bucket === undefined || now >= bucket.resetAt) {
    rateLimitBuckets.set(userId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }

  if (bucket.count >= RATE_LIMIT_MAX_TOKENS) return false;

  bucket.count += 1;
  return true;
}

// ---------------------------------------------------------------------------
// Param helper — handles both /:appId (parent route) and /:id (sub-route)
// Same pattern used by versions.ts and deployments.ts.
// ---------------------------------------------------------------------------

function resolveAppId(c: { req: { param(name: string): string | undefined } }): string {
  const id = c.req.param("appId") ?? c.req.param("id");
  if (id === undefined || id === "") {
    throw new NotFoundError("Missing appId in route.");
  }
  return id;
}

// ---------------------------------------------------------------------------
// Management route factory — mounted at /api/v1/apps/:appId/embed
// ---------------------------------------------------------------------------

export function createEmbedManagementRoutes(
  deps: EmbedRouteDeps
): Hono<{ Variables: AppVariables }> {
  const { embedService, appService } = deps;
  const routes = new Hono<{ Variables: AppVariables }>();

  // POST /api/v1/apps/:appId/embed — generate embed config and token
  routes.post("/", async (c) => {
    const user = c.var.user;
    if (user === undefined) throw new UnauthorizedError("Authentication required.");

    // Rate-limit token generation per user to prevent bulk issuance abuse
    if (!checkRateLimit(user.userId)) {
      return c.json(
        {
          error: {
            code:    "RATE_LIMITED",
            message: `Embed token generation is limited to ${RATE_LIMIT_MAX_TOKENS} per minute.`,
          },
        },
        429
      );
    }

    const body   = await c.req.json().catch(() => null);
    const parsed = CreateEmbedTokenSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new ValidationError("Invalid request body.", parsed.error.issues);
    }

    const appId = resolveAppId(c);

    // Verify app ownership — throws AppNotFoundError for unknown or cross-tenant apps
    await appService.getApp(user.tenantId, appId);

    const result = await embedService.generateEmbedToken(
      appId,
      user.tenantId,
      user.userId,
      {
        ...(parsed.data.expiresIn !== undefined ? { expiresIn: parsed.data.expiresIn } : {}),
        allowedOrigins: parsed.data.allowedOrigins,
        permissions:    parsed.data.permissions,
      }
    );

    return c.json(
      {
        data: {
          token:   result.token,
          config:  result.config,
          snippet: result.snippet,
        },
      },
      201
    );
  });

  // GET /api/v1/apps/:appId/embed — list active embed configs for this app
  routes.get("/", async (c) => {
    const user = c.var.user;
    if (user === undefined) throw new UnauthorizedError("Authentication required.");

    const appId = resolveAppId(c);

    // Verify app belongs to this tenant
    await appService.getApp(user.tenantId, appId);

    const configs = await embedService.listEmbedTokens(appId, user.tenantId);

    return c.json({ data: configs });
  });

  // DELETE /api/v1/apps/:appId/embed/:tokenId — revoke a specific embed token
  routes.delete("/:tokenId", async (c) => {
    const user = c.var.user;
    if (user === undefined) throw new UnauthorizedError("Authentication required.");

    const appId    = resolveAppId(c);
    const tokenId  = c.req.param("tokenId");

    if (!tokenId) {
      throw new ValidationError("Missing tokenId in route.", []);
    }

    // Verify app belongs to this tenant before allowing revocation
    await appService.getApp(user.tenantId, appId);

    await embedService.revokeEmbedToken(tokenId, appId, user.tenantId);

    return new Response(null, { status: 204 });
  });

  return routes;
}

// ---------------------------------------------------------------------------
// Embed serve route factory — mounted at /api/v1/embed
//
// This endpoint is intentionally unauthenticated.  The embed token IS the
// credential.  Security is enforced by:
//   1. JWT signature + expiry verification (jose)
//   2. DB revocation check (every request)
//   3. Origin enforcement via Content-Security-Policy frame-ancestors
//
// X-Frame-Options is intentionally absent — CSP frame-ancestors is the
// authoritative framing policy for modern browsers, and X-Frame-Options
// DENY would block legitimate embeds that CSP permits.
// ---------------------------------------------------------------------------

export function createEmbedServeRoutes(
  deps: EmbedRouteDeps
): Hono<{ Variables: AppVariables }> {
  const { embedService, baseUrl } = deps;
  const routes = new Hono<{ Variables: AppVariables }>();

  // GET /api/v1/embed/:token — serve the embedded app shell
  routes.get("/:token", async (c) => {
    const rawToken = c.req.param("token");

    if (!rawToken) {
      return c.json({ error: { code: "EMBED_TOKEN_INVALID", message: "Missing embed token." } }, 401);
    }

    // Validate JWT signature, expiry, and DB revocation in one call
    let payload;
    try {
      payload = await embedService.validateEmbedToken(rawToken);
    } catch (err) {
      if (
        err instanceof EmbedTokenInvalidError ||
        err instanceof EmbedTokenExpiredError ||
        err instanceof EmbedTokenRevokedError ||
        err instanceof EmbedTokenNotFoundError
      ) {
        return c.json(
          { error: { code: err.code, message: err.message } },
          err.statusCode as 401 | 404
        );
      }
      throw err;
    }

    // Enforce origin policy from the token
    const requestOrigin = c.req.header("Origin") ?? "";

    if (payload.allowedOrigins.length === 0) {
      // Empty allowedOrigins = no cross-origin embedding permitted
      if (requestOrigin !== "") {
        const err = new EmbedOriginNotAllowedError(
          "This embed token does not permit cross-origin embedding."
        );
        return c.json({ error: { code: err.code, message: err.message } }, 403);
      }
    } else if (requestOrigin !== "" && !isOriginAllowed(requestOrigin, payload.allowedOrigins)) {
      const err = new EmbedOriginNotAllowedError(
        `Origin "${requestOrigin}" is not permitted by this embed token.`
      );
      return c.json({ error: { code: err.code, message: err.message } }, 403);
    }

    // Build frame-ancestors value from allowedOrigins
    const frameAncestors = buildFrameAncestors(payload.allowedOrigins);

    // Defend against </script> injection in the injected JSON blob
    const configJson = JSON.stringify({
      appId:       payload.appId,
      tenantId:    payload.tenantId,
      embedMode:   true,
      permissions: payload.permissions,
    }).replace(/</g, "\\u003c");

    const appUrl = `${baseUrl}/apps/${payload.appId}`;

    // Generate a per-request nonce so inline scripts can execute under a
    // strict CSP without resorting to 'unsafe-inline'.
    const nonce = randomBytes(16).toString("base64");

    const html = [
      `<!DOCTYPE html>`,
      `<html lang="en">`,
      `<head>`,
      `  <meta charset="UTF-8">`,
      `  <meta name="viewport" content="width=device-width, initial-scale=1.0">`,
      `  <title>Embedded App</title>`,
      `</head>`,
      `<body>`,
      `  <div id="app"></div>`,
      `  <script nonce="${nonce}">`,
      `    window.__OP_APP_CONFIG__ = ${configJson};`,
      `    window.__OP_EMBED_TOKEN__ = ${JSON.stringify(rawToken)};`,
      `  </script>`,
      `  <script type="module" src="${appUrl}/bundle.js"></script>`,
      `</body>`,
      `</html>`,
    ].join("\n");

    return new Response(html, {
      status: 200,
      headers: {
        "Content-Type":            "text/html; charset=utf-8",
        "Cache-Control":           "no-store",
        "Content-Security-Policy": [
          `default-src 'self'`,
          `script-src 'self' 'nonce-${nonce}'`,
          `connect-src 'self'`,
          `style-src 'self' 'unsafe-inline'`,
          `frame-ancestors ${frameAncestors}`,
        ].join("; "),
        "X-Content-Type-Options":  "nosniff",
        "Referrer-Policy":         "strict-origin-when-cross-origin",
      },
    });
  });

  return routes;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildFrameAncestors(allowedOrigins: string[]): string {
  if (allowedOrigins.length === 0) return "'self'";

  // Filter out wildcard entries — '*' in frame-ancestors is too permissive
  // and enables clickjacking. Default to 'self' when only wildcards remain.
  const safe = allowedOrigins.filter((o) => o !== "*");
  if (safe.length === 0) return "'self'";

  const origins = safe.map((o) =>
    o.startsWith("*.") ? `https://${o.slice(2)}` : `https://${o}`
  );
  return `'self' ${origins.join(" ")}`;
}
