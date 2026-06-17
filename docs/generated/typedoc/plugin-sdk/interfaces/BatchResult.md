[**@oneplatform/plugin-sdk**](../README.md)

***

[@oneplatform/plugin-sdk](../README.md) / BatchResult

# Interface: BatchResult

Defined in: [packages/plugin-sdk/src/types/connector.ts:33](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/connector.ts#L33)

## Properties

### estimatedTotal?

> `optional` **estimatedTotal?**: `number`

Defined in: [packages/plugin-sdk/src/types/connector.ts:53](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/connector.ts#L53)

Advisory hint for the platform progress UI. If unknown, omit this field.
The platform never makes correctness decisions based on this value.

***

### fetchedAt

> **fetchedAt**: `string`

Defined in: [packages/plugin-sdk/src/types/connector.ts:47](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/connector.ts#L47)

ISO 8601 timestamp of when this batch was fetched. Used for freshness tracking.

***

### hasMore

> **hasMore**: `boolean`

Defined in: [packages/plugin-sdk/src/types/connector.ts:44](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/connector.ts#L44)

Set to true if there are more records after this batch (i.e., nextCursor is non-null).

***

### nextCursor

> **nextCursor**: `string` \| `null`

Defined in: [packages/plugin-sdk/src/types/connector.ts:41](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/connector.ts#L41)

Cursor for the next fetchBatch call. Set to null to signal that all records
have been returned. The cursor value is opaque to the platform — it may be
a page token, timestamp, offset, or any string the connector uses internally.

***

### records

> **records**: [`DataRecord`](DataRecord.md)[]

Defined in: [packages/plugin-sdk/src/types/connector.ts:34](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/connector.ts#L34)
