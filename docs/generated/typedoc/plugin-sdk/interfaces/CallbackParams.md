[**@oneplatform/plugin-sdk**](../README.md)

***

[@oneplatform/plugin-sdk](../README.md) / CallbackParams

# Interface: CallbackParams

Defined in: [packages/plugin-sdk/src/types/auth-provider.ts:26](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/auth-provider.ts#L26)

## Properties

### code

> **code**: `string`

Defined in: [packages/plugin-sdk/src/types/auth-provider.ts:31](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/auth-provider.ts#L31)

The authorization code from the OAuth provider.
For SAML flows, this is the decoded assertion value after base64 decoding.

***

### error?

> `optional` **error?**: `string`

Defined in: [packages/plugin-sdk/src/types/auth-provider.ts:34](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/auth-provider.ts#L34)

Set if the provider returned an error in the callback.

***

### errorDescription?

> `optional` **errorDescription?**: `string`

Defined in: [packages/plugin-sdk/src/types/auth-provider.ts:37](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/auth-provider.ts#L37)

Human-readable description of the error, if present.
