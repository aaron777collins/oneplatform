[**@oneplatform/sdk**](../README.md)

***

[@oneplatform/sdk](../README.md) / PaginatedIterable

# Interface: PaginatedIterable\<T\>

Defined in: [packages/sdk/src/pagination/paginator.ts:24](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/pagination/paginator.ts#L24)

PaginatedIterable extends AsyncIterable<Page<T>> with convenience helpers.
The interface is exported so generated typed clients can declare conformance.

## Extends

- `AsyncIterable`\<[`Page`](Page.md)\<`T`\>\>

## Type Parameters

### T

`T`

## Methods

### \[asyncIterator\]()

> **\[asyncIterator\]**(): `AsyncIterator`\<[`Page`](Page.md)\<`T`\>, `any`, `any`\>

Defined in: node\_modules/.pnpm/typescript@5.9.3/node\_modules/typescript/lib/lib.es2018.asynciterable.d.ts:38

#### Returns

`AsyncIterator`\<[`Page`](Page.md)\<`T`\>, `any`, `any`\>

#### Inherited from

`AsyncIterable.[asyncIterator]`

***

### collect()

> **collect**(`maxItems?`): `Promise`\<`T`[]\>

Defined in: [packages/sdk/src/pagination/paginator.ts:32](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/pagination/paginator.ts#L32)

Collect all items across all pages into a flat array.
Throws PaginationLimitError if more than `maxItems` items exist and there
are still pages remaining, preventing unbounded memory use.

#### Parameters

##### maxItems?

`number`

Hard cap. Default: 10000.

#### Returns

`Promise`\<`T`[]\>

***

### firstPage()

> **firstPage**(): `Promise`\<[`Page`](Page.md)\<`T`\>\>

Defined in: [packages/sdk/src/pagination/paginator.ts:41](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/pagination/paginator.ts#L41)

Return the first page without continuing iteration.

#### Returns

`Promise`\<[`Page`](Page.md)\<`T`\>\>

***

### take()

> **take**(`n`): `Promise`\<`T`[]\>

Defined in: [packages/sdk/src/pagination/paginator.ts:38](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/pagination/paginator.ts#L38)

Collect exactly `n` items, stopping pagination early once collected.
Returns fewer items when the total collection is smaller than n.

#### Parameters

##### n

`number`

#### Returns

`Promise`\<`T`[]\>
