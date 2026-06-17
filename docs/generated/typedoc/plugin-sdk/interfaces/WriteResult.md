[**@oneplatform/plugin-sdk**](../README.md)

***

[@oneplatform/plugin-sdk](../README.md) / WriteResult

# Interface: WriteResult

Defined in: [packages/plugin-sdk/src/types/destination.ts:20](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/destination.ts#L20)

## Properties

### errors

> **errors**: `object`[]

Defined in: [packages/plugin-sdk/src/types/destination.ts:32](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/destination.ts#L32)

Per-record error details for failed records.
Include the sourceId so the platform can correlate failures to records.
Do not include credential values in the error string.

#### error

> **error**: `string`

#### sourceId

> **sourceId**: `string`

***

### failed

> **failed**: `number`

Defined in: [packages/plugin-sdk/src/types/destination.ts:25](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/destination.ts#L25)

Count of records that failed.

***

### written

> **written**: `number`

Defined in: [packages/plugin-sdk/src/types/destination.ts:22](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/destination.ts#L22)

Count of records successfully written.
