[**@oneplatform/sdk**](../README.md)

***

[@oneplatform/sdk](../README.md) / PageFetcher

# Type Alias: PageFetcher\<T\>

> **PageFetcher**\<`T`\> = (`cursor`, `limit`) => `Promise`\<[`Page`](../interfaces/Page.md)\<`T`\>\>

Defined in: [packages/sdk/src/pagination/paginator.ts:18](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/pagination/paginator.ts#L18)

Fetches a single page given the cursor from the previous page (null = first page).

## Type Parameters

### T

`T`

## Parameters

### cursor

`string` \| `null`

### limit

`number`

## Returns

`Promise`\<[`Page`](../interfaces/Page.md)\<`T`\>\>
