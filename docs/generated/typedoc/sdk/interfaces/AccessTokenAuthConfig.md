[**@oneplatform/sdk**](../README.md)

***

[@oneplatform/sdk](../README.md) / AccessTokenAuthConfig

# Interface: AccessTokenAuthConfig

Defined in: [packages/sdk/src/types/client-options.ts:13](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/client-options.ts#L13)

## Properties

### accessToken

> `readonly` **accessToken**: `string`

Defined in: [packages/sdk/src/types/client-options.ts:19](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/client-options.ts#L19)

A JWT access token previously obtained from the Auth Service.
The SDK sends it as-is and does NOT attempt token refresh on its own.
Provide refreshToken to enable automatic refresh on 401.

***

### refreshToken?

> `readonly` `optional` **refreshToken?**: () => `Promise`\<`string` \| `null`\>

Defined in: [packages/sdk/src/types/client-options.ts:25](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/client-options.ts#L25)

Invoked when a request fails with 401 Unauthorized.
Return a fresh token or null to propagate the original AuthError.

#### Returns

`Promise`\<`string` \| `null`\>
