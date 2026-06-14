---
title: "@oneplatform/core"
description: Internal shared utilities used by all OnePlatform microservices.
sidebar:
  order: 1
---

`@oneplatform/core` is the internal shared library used by all 9 OnePlatform
microservices. It provides the Hono application factory, middleware stack,
error types, and database client wrappers.

This package is not intended for use by external consumers — it is an internal
implementation detail of the platform services. Plugin authors and app developers
should use `@oneplatform/plugin-sdk` and `@oneplatform/app-sdk` respectively.

## Key exports (for service contributors)

| Export | Description |
|--------|-------------|
| `createApp(config)` | Creates and configures the Hono app with the standard 11-middleware stack |
| `AppError` | Base error class with status code and error code |
| `ValidationError` | 422 validation failure |
| `NotFoundError` | 404 not found |
| `UnauthorizedError` | 401 authentication required |
| `ForbiddenError` | 403 insufficient permissions |
| `UserContext` | Type for the authenticated user attached to request context |
| `createDbClient(config)` | Creates a Drizzle ORM client with the platform schema |
| `createRedisClient(config)` | Creates an ioredis client with retry logic |

## Middleware stack

`createApp()` applies these middleware in order:

1. Request ID generation (sets `X-Request-ID`)
2. Trace ID propagation (reads or generates `X-Trace-ID`)
3. Structured request logger
4. CORS (configurable origins)
5. Security headers (CSP, HSTS, X-Frame-Options)
6. Rate limit header passthrough
7. Body size limit enforcement
8. JWT verification (populates `c.var.user`)
9. Service token verification (for internal routes)
10. Tenant resolution
11. Request/response timing

## Resources

- [Architecture Decisions — ADR-01 through ADR-22](/architecture/decisions/001-architecture-decisions)
