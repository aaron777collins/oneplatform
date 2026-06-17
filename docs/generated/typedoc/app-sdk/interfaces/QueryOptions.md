[**@oneplatform/app-sdk**](../README.md)

***

[@oneplatform/app-sdk](../README.md) / QueryOptions

# Interface: QueryOptions

Defined in: [types/entities.ts:38](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/app-sdk/src/types/entities.ts#L38)

## Properties

### cursor?

> `optional` **cursor?**: `string`

Defined in: [types/entities.ts:45](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/app-sdk/src/types/entities.ts#L45)

Pagination cursor. Omit for the first page.

***

### enabled?

> `optional` **enabled?**: `boolean`

Defined in: [types/entities.ts:49](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/app-sdk/src/types/entities.ts#L49)

When false, skip the fetch entirely. Default true.

***

### fields?

> `optional` **fields?**: `string`[]

Defined in: [types/entities.ts:43](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/app-sdk/src/types/entities.ts#L43)

Field projection. Omit for all fields.

***

### filter?

> `optional` **filter?**: [`FilterSpec`](../type-aliases/FilterSpec.md)

Defined in: [types/entities.ts:39](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/app-sdk/src/types/entities.ts#L39)

***

### limit?

> `optional` **limit?**: `number`

Defined in: [types/entities.ts:47](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/app-sdk/src/types/entities.ts#L47)

Default 50, max 100

***

### onError?

> `optional` **onError?**: (`error`) => `void`

Defined in: [types/entities.ts:52](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/app-sdk/src/types/entities.ts#L52)

#### Parameters

##### error

[`AppSDKError`](AppSDKError.md)

#### Returns

`void`

***

### sort?

> `optional` **sort?**: `string`[]

Defined in: [types/entities.ts:41](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/app-sdk/src/types/entities.ts#L41)

Prefix with "-" for descending order, e.g. ["-createdAt", "name"]

***

### staleTime?

> `optional` **staleTime?**: `number`

Defined in: [types/entities.ts:51](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/app-sdk/src/types/entities.ts#L51)

Milliseconds before a cache entry is considered stale. Default 30_000.
