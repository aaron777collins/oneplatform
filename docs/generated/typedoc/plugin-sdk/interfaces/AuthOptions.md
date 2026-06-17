[**@oneplatform/plugin-sdk**](../README.md)

***

[@oneplatform/plugin-sdk](../README.md) / AuthOptions

# Interface: AuthOptions

Defined in: [packages/plugin-sdk/src/types/auth-provider.ts:15](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/auth-provider.ts#L15)

## Properties

### additionalParams?

> `optional` **additionalParams?**: `Record`\<`string`, `string`\>

Defined in: [packages/plugin-sdk/src/types/auth-provider.ts:23](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/auth-provider.ts#L23)

Provider-specific query parameters to append to the authorization URL.

***

### redirectUri

> **redirectUri**: `string`

Defined in: [packages/plugin-sdk/src/types/auth-provider.ts:17](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/auth-provider.ts#L17)

The platform's OAuth callback URL. Must be included verbatim in the authorization URL.

***

### scopes?

> `optional` **scopes?**: `string`[]

Defined in: [packages/plugin-sdk/src/types/auth-provider.ts:20](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/auth-provider.ts#L20)

OAuth scopes to request. If omitted, the provider's default scopes apply.
