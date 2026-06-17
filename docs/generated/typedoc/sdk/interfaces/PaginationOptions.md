[**@oneplatform/sdk**](../README.md)

***

[@oneplatform/sdk](../README.md) / PaginationOptions

# Interface: PaginationOptions

Defined in: [packages/sdk/src/types/pagination.ts:22](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/pagination.ts#L22)

## Properties

### cursor?

> `readonly` `optional` **cursor?**: `string`

Defined in: [packages/sdk/src/types/pagination.ts:27](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/pagination.ts#L27)

Starting cursor for resuming a previous pagination session.

***

### limit?

> `readonly` `optional` **limit?**: `number`

Defined in: [packages/sdk/src/types/pagination.ts:24](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/pagination.ts#L24)

Page size hint sent to the server. Default: 50. Max: 100.
