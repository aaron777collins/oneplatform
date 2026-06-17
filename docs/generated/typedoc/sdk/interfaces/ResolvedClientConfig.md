[**@oneplatform/sdk**](../README.md)

***

[@oneplatform/sdk](../README.md) / ResolvedClientConfig

# Interface: ResolvedClientConfig

Defined in: [packages/sdk/src/types/client-options.ts:122](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/client-options.ts#L122)

Resolved config returned by client.getConfig(). Auth tokens are redacted.

## Properties

### authMode

> `readonly` **authMode**: `"api-key"` \| `"access-token"` \| `"browser"`

Defined in: [packages/sdk/src/types/client-options.ts:127](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/client-options.ts#L127)

***

### baseUrl

> `readonly` **baseUrl**: `string`

Defined in: [packages/sdk/src/types/client-options.ts:123](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/client-options.ts#L123)

***

### logLevel

> `readonly` **logLevel**: `"debug"` \| `"info"` \| `"warn"` \| `"error"` \| `"silent"`

Defined in: [packages/sdk/src/types/client-options.ts:125](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/client-options.ts#L125)

***

### retry

> `readonly` **retry**: `false` \| [`RetryPolicy`](RetryPolicy.md)

Defined in: [packages/sdk/src/types/client-options.ts:126](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/client-options.ts#L126)

***

### timeout

> `readonly` **timeout**: `number`

Defined in: [packages/sdk/src/types/client-options.ts:124](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/client-options.ts#L124)
