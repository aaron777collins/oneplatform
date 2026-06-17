[**@oneplatform/sdk**](../README.md)

***

[@oneplatform/sdk](../README.md) / Page

# Interface: Page\<T\>

Defined in: [packages/sdk/src/types/pagination.ts:5](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/pagination.ts#L5)

Pagination types for cursor-based collection traversal (ADR-29).

## Type Parameters

### T

`T`

## Properties

### hasMore

> `readonly` **hasMore**: `boolean`

Defined in: [packages/sdk/src/types/pagination.ts:19](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/pagination.ts#L19)

Whether more pages follow (nextCursor !== null).

***

### items

> `readonly` **items**: `T`[]

Defined in: [packages/sdk/src/types/pagination.ts:7](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/pagination.ts#L7)

Items on this page.

***

### nextCursor

> `readonly` **nextCursor**: `string` \| `null`

Defined in: [packages/sdk/src/types/pagination.ts:10](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/pagination.ts#L10)

Cursor for the next page. null if this is the last page.

***

### total

> `readonly` **total**: `number` \| `null`

Defined in: [packages/sdk/src/types/pagination.ts:16](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/pagination.ts#L16)

Total matching items across all pages.
null for collections where total computation is too expensive (>100k rows).
