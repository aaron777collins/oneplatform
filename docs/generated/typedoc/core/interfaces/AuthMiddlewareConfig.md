[**@oneplatform/core**](../README.md)

***

[@oneplatform/core](../README.md) / AuthMiddlewareConfig

# Interface: AuthMiddlewareConfig

Defined in: [packages/core/src/middleware/auth.ts:20](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/core/src/middleware/auth.ts#L20)

## Properties

### jwtSecret

> **jwtSecret**: `string`

Defined in: [packages/core/src/middleware/auth.ts:21](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/core/src/middleware/auth.ts#L21)

***

### publicRoutes?

> `optional` **publicRoutes?**: `string`[]

Defined in: [packages/core/src/middleware/auth.ts:27](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/core/src/middleware/auth.ts#L27)

***

### redis

> **redis**: `Redis`

Defined in: [packages/core/src/middleware/auth.ts:22](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/core/src/middleware/auth.ts#L22)

***

### validateApiKey

> **validateApiKey**: (`key`) => `Promise`\<[`UserContext`](UserContext.md) \| `null`\>

Defined in: [packages/core/src/middleware/auth.ts:25](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/core/src/middleware/auth.ts#L25)

#### Parameters

##### key

`string`

#### Returns

`Promise`\<[`UserContext`](UserContext.md) \| `null`\>
