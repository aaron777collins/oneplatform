[**@oneplatform/plugin-sdk**](../README.md)

***

[@oneplatform/plugin-sdk](../README.md) / AuthResult

# Interface: AuthResult

Defined in: [packages/plugin-sdk/src/types/auth-provider.ts:52](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/auth-provider.ts#L52)

## Properties

### accessToken

> **accessToken**: `string`

Defined in: [packages/plugin-sdk/src/types/auth-provider.ts:53](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/auth-provider.ts#L53)

***

### claims

> **claims**: `Record`\<`string`, `unknown`\>

Defined in: [packages/plugin-sdk/src/types/auth-provider.ts:60](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/auth-provider.ts#L60)

Raw claims from the identity provider. Used by mapClaimsToRoles().

***

### expiresAt?

> `optional` **expiresAt?**: `string`

Defined in: [packages/plugin-sdk/src/types/auth-provider.ts:57](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/auth-provider.ts#L57)

ISO 8601 expiry time for the access token.

***

### platformRoles

> **platformRoles**: `string`[]

Defined in: [packages/plugin-sdk/src/types/auth-provider.ts:63](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/auth-provider.ts#L63)

Platform RBAC role names assigned to this user, as returned by mapClaimsToRoles().

***

### providerUserId

> **providerUserId**: `string`

Defined in: [packages/plugin-sdk/src/types/auth-provider.ts:66](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/auth-provider.ts#L66)

The user's stable ID in the external identity provider.

***

### refreshToken?

> `optional` **refreshToken?**: `string`

Defined in: [packages/plugin-sdk/src/types/auth-provider.ts:54](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/auth-provider.ts#L54)
