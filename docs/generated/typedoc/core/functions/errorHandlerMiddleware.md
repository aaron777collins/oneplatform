[**@oneplatform/core**](../README.md)

***

[@oneplatform/core](../README.md) / errorHandlerMiddleware

# Function: errorHandlerMiddleware()

> **errorHandlerMiddleware**(`config?`): (`err`, `c`) => `JSONRespondReturn`\<[`ApiError`](../interfaces/ApiError.md), `400` \| `401` \| `403` \| `404` \| `409` \| `410` \| `422` \| `429` \| `500` \| `503`\>

Defined in: [packages/core/src/middleware/error-handler.ts:9](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/core/src/middleware/error-handler.ts#L9)

## Parameters

### config?

[`ErrorHandlerConfig`](../interfaces/ErrorHandlerConfig.md) = `{}`

## Returns

(`err`, `c`) => `JSONRespondReturn`\<[`ApiError`](../interfaces/ApiError.md), `400` \| `401` \| `403` \| `404` \| `409` \| `410` \| `422` \| `429` \| `500` \| `503`\>
