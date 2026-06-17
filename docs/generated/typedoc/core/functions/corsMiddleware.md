[**@oneplatform/core**](../README.md)

***

[@oneplatform/core](../README.md) / corsMiddleware

# Function: corsMiddleware()

> **corsMiddleware**(`config`): `MiddlewareHandler`

Defined in: [packages/core/src/middleware/cors.ts:27](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/core/src/middleware/cors.ts#L27)

Hono middleware that enforces the `OP_ALLOWED_ORIGINS` allowlist.

Requests from unknown origins return `403 ORIGIN_NOT_ALLOWED` rather than
a browser-level CORS failure. This prevents leaking endpoint existence to
attackers probing from untrusted origins (spec §6 CORS Policy).

Wired automatically by [createApp](createApp.md); export is for services that need a
custom middleware stack.

## Parameters

### config

[`CorsConfig`](../interfaces/CorsConfig.md)

Explicit list of permitted origins.

## Returns

`MiddlewareHandler`
