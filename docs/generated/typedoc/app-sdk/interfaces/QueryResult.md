[**@oneplatform/app-sdk**](../README.md)

***

[@oneplatform/app-sdk](../README.md) / QueryResult

# Interface: QueryResult\<T\>

Defined in: [types/entities.ts:55](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/app-sdk/src/types/entities.ts#L55)

## Type Parameters

### T

`T`

## Properties

### data

> **data**: `T`[] \| `null`

Defined in: [types/entities.ts:56](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/app-sdk/src/types/entities.ts#L56)

***

### error

> **error**: [`AppSDKError`](AppSDKError.md) \| `null`

Defined in: [types/entities.ts:60](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/app-sdk/src/types/entities.ts#L60)

***

### fetchNextPage

> **fetchNextPage**: () => `Promise`\<`void`\>

Defined in: [types/entities.ts:62](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/app-sdk/src/types/entities.ts#L62)

#### Returns

`Promise`\<`void`\>

***

### isError

> **isError**: `boolean`

Defined in: [types/entities.ts:59](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/app-sdk/src/types/entities.ts#L59)

***

### isLoading

> **isLoading**: `boolean`

Defined in: [types/entities.ts:58](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/app-sdk/src/types/entities.ts#L58)

***

### pagination

> **pagination**: [`Pagination`](Pagination.md) \| `null`

Defined in: [types/entities.ts:57](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/app-sdk/src/types/entities.ts#L57)

***

### refetch

> **refetch**: () => `Promise`\<`void`\>

Defined in: [types/entities.ts:61](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/app-sdk/src/types/entities.ts#L61)

#### Returns

`Promise`\<`void`\>
