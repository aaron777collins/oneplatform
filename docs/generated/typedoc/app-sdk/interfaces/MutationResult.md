[**@oneplatform/app-sdk**](../README.md)

***

[@oneplatform/app-sdk](../README.md) / MutationResult

# Interface: MutationResult\<T\>

Defined in: [types/entities.ts:72](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/app-sdk/src/types/entities.ts#L72)

## Type Parameters

### T

`T`

## Properties

### bulkCreate

> **bulkCreate**: (`items`) => `Promise`\<[`BulkResult`](BulkResult.md)\<`T`\>\>

Defined in: [types/entities.ts:79](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/app-sdk/src/types/entities.ts#L79)

#### Parameters

##### items

`Partial`\<`T`\>[]

#### Returns

`Promise`\<[`BulkResult`](BulkResult.md)\<`T`\>\>

***

### create

> **create**: (`data`) => `Promise`\<`T`\>

Defined in: [types/entities.ts:73](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/app-sdk/src/types/entities.ts#L73)

#### Parameters

##### data

`Partial`\<`T`\>

#### Returns

`Promise`\<`T`\>

***

### error

> **error**: [`AppSDKError`](AppSDKError.md) \| `null`

Defined in: [types/entities.ts:82](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/app-sdk/src/types/entities.ts#L82)

***

### isError

> **isError**: `boolean`

Defined in: [types/entities.ts:81](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/app-sdk/src/types/entities.ts#L81)

***

### isLoading

> **isLoading**: `boolean`

Defined in: [types/entities.ts:80](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/app-sdk/src/types/entities.ts#L80)

***

### remove

> **remove**: (`id`) => `Promise`\<`void`\>

Defined in: [types/entities.ts:78](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/app-sdk/src/types/entities.ts#L78)

#### Parameters

##### id

`string`

#### Returns

`Promise`\<`void`\>

***

### replace

> **replace**: (`id`, `data`) => `Promise`\<`T`\>

Defined in: [types/entities.ts:77](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/app-sdk/src/types/entities.ts#L77)

PUT — full replacement

#### Parameters

##### id

`string`

##### data

`T`

#### Returns

`Promise`\<`T`\>

***

### reset

> **reset**: () => `void`

Defined in: [types/entities.ts:84](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/app-sdk/src/types/entities.ts#L84)

Clears isError and error state

#### Returns

`void`

***

### update

> **update**: (`id`, `data`) => `Promise`\<`T`\>

Defined in: [types/entities.ts:75](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/app-sdk/src/types/entities.ts#L75)

PATCH — partial update

#### Parameters

##### id

`string`

##### data

`Partial`\<`T`\>

#### Returns

`Promise`\<`T`\>
