[**@oneplatform/sdk**](../README.md)

***

[@oneplatform/sdk](../README.md) / RetryPolicy

# Interface: RetryPolicy

Defined in: [packages/sdk/src/types/client-options.ts:63](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/client-options.ts#L63)

## Properties

### initialDelayMs?

> `readonly` `optional` **initialDelayMs?**: `number`

Defined in: [packages/sdk/src/types/client-options.ts:68](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/client-options.ts#L68)

Initial backoff delay in ms. Doubles per retry. Default: 500

***

### jitter?

> `readonly` `optional` **jitter?**: `boolean`

Defined in: [packages/sdk/src/types/client-options.ts:80](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/client-options.ts#L80)

Apply ±25% random jitter to backoff delays. Default: true

***

### maxDelayMs?

> `readonly` `optional` **maxDelayMs?**: `number`

Defined in: [packages/sdk/src/types/client-options.ts:71](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/client-options.ts#L71)

Maximum backoff delay cap in ms. Default: 30000

***

### maxRetries?

> `readonly` `optional` **maxRetries?**: `number`

Defined in: [packages/sdk/src/types/client-options.ts:65](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/client-options.ts#L65)

Maximum retry attempts (not counting the initial attempt). Default: 3

***

### retryableStatusCodes?

> `readonly` `optional` **retryableStatusCodes?**: `number`[]

Defined in: [packages/sdk/src/types/client-options.ts:77](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/client-options.ts#L77)

HTTP status codes that trigger a retry.
Default: [429, 500, 502, 503, 504].
