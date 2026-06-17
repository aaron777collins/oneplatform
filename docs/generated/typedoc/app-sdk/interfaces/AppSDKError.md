[**@oneplatform/app-sdk**](../README.md)

***

[@oneplatform/app-sdk](../README.md) / AppSDKError

# Interface: AppSDKError

Defined in: [types/entities.ts:132](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/app-sdk/src/types/entities.ts#L132)

## Properties

### code

> **code**: `string`

Defined in: [types/entities.ts:134](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/app-sdk/src/types/entities.ts#L134)

e.g. "PERMISSION_DENIED", "ENTITY_NOT_FOUND", "NETWORK_ERROR"

***

### isRetryable

> **isRetryable**: `boolean`

Defined in: [types/entities.ts:139](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/app-sdk/src/types/entities.ts#L139)

true for 429, 503, and NETWORK_ERROR — signals the caller may retry

***

### message

> **message**: `string`

Defined in: [types/entities.ts:135](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/app-sdk/src/types/entities.ts#L135)

***

### requestId

> **requestId**: `string`

Defined in: [types/entities.ts:141](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/app-sdk/src/types/entities.ts#L141)

X-Request-ID from the BFF response; empty string for network errors

***

### statusCode

> **statusCode**: `number`

Defined in: [types/entities.ts:137](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/app-sdk/src/types/entities.ts#L137)

HTTP status code; 0 for network or client-side errors
