[**@oneplatform/sdk**](../README.md)

***

[@oneplatform/sdk](../README.md) / ApiKeyAuthConfig

# Interface: ApiKeyAuthConfig

Defined in: [packages/sdk/src/types/client-options.ts:8](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/client-options.ts#L8)

Authentication and client configuration types.

Exactly one auth mode must be active per client instance. The SDK selects
the mode at construction time from the provided AuthConfig discriminated union.

## Properties

### apiKey

> `readonly` **apiKey**: `string`

Defined in: [packages/sdk/src/types/client-options.ts:10](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/client-options.ts#L10)

API key. Must start with "op_live_" or "op_test_". Server-side only.
