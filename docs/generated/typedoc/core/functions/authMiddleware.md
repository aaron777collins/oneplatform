[**@oneplatform/core**](../README.md)

***

[@oneplatform/core](../README.md) / authMiddleware

# Function: authMiddleware()

> **authMiddleware**(`config`): `MiddlewareHandler`\<`any`, `string`, \{ \}, `Response` \| `JSONRespondReturn`\<\{ `error`: \{ `code`: `string`; `message`: `string`; `requestId`: `string`; \}; \}, `401`\>\>

Defined in: [packages/core/src/middleware/auth.ts:40](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/core/src/middleware/auth.ts#L40)

Primary user-facing authentication middleware.

Accepts either a `Bearer` JWT or an `X-API-Key` header. Sets `c.var.user`
to the resolved [UserContext](../interfaces/UserContext.md) on success. Bypasses auth for routes
listed in `config.publicRoutes`.

Runs after `requestId` and `cors`, before `serviceAuth` (spec §5).
Wired automatically by [createApp](createApp.md).

## Parameters

### config

[`AuthMiddlewareConfig`](../interfaces/AuthMiddlewareConfig.md)

## Returns

`MiddlewareHandler`\<`any`, `string`, \{ \}, `Response` \| `JSONRespondReturn`\<\{ `error`: \{ `code`: `string`; `message`: `string`; `requestId`: `string`; \}; \}, `401`\>\>
