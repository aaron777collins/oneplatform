[**@oneplatform/core**](../README.md)

***

[@oneplatform/core](../README.md) / createApp

# Function: createApp()

> **createApp**(`config`): `Hono`\<\{ `Variables`: [`AppVariables`](../type-aliases/AppVariables.md); \}\>

Defined in: [packages/core/src/app.ts:135](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/core/src/app.ts#L135)

Creates the standard Hono application for an OnePlatform service.

Wires the 11-layer middleware stack defined in spec §5. Middleware order
is load-bearing — do NOT reorder without updating the spec:

1. `requestId`          — must run first; propagated to every other layer
2. `securityHeaders`    — HSTS, CSP, etc. applied before any handler runs
3. `cors`               — validates Origin; preflight returns early
4. `auth`               — validates JWT/API key; sets `c.var.user`
5. `serviceAuth`        — on `/internal/*`, validates Ed25519 token + RBAC
6. `responseEnvelope`   — wraps 2xx JSON in `{ data: T }`
7. `errorHandler`       — catches thrown errors → `{ error: {...} }`
8. `rateLimitHeaders`   — appends `X-RateLimit-*` headers
9. `deprecationHeaders` — appends RFC 8594 headers for deprecated routes

## Parameters

### config

[`CreateAppConfig`](../interfaces/CreateAppConfig.md)

Service-specific configuration; see [CreateAppConfig](../interfaces/CreateAppConfig.md).

## Returns

`Hono`\<\{ `Variables`: [`AppVariables`](../type-aliases/AppVariables.md); \}\>

A Hono app instance with the full middleware stack applied. Mount routes on it.
