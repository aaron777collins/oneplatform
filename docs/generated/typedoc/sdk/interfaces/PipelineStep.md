[**@oneplatform/sdk**](../README.md)

***

[@oneplatform/sdk](../README.md) / PipelineStep

# Interface: PipelineStep

Defined in: [packages/sdk/src/resources/platform-types.ts:72](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/resources/platform-types.ts#L72)

## Indexable

> \[`key`: `string`\]: `unknown`

## Properties

### condition?

> `readonly` `optional` **condition?**: `string`

Defined in: [packages/sdk/src/resources/platform-types.ts:78](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/resources/platform-types.ts#L78)

***

### id

> `readonly` **id**: `string`

Defined in: [packages/sdk/src/resources/platform-types.ts:73](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/resources/platform-types.ts#L73)

***

### inputs?

> `readonly` `optional` **inputs?**: `Record`\<`string`, [`PipelineInputSource`](../type-aliases/PipelineInputSource.md)\>

Defined in: [packages/sdk/src/resources/platform-types.ts:76](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/resources/platform-types.ts#L76)

***

### name

> `readonly` **name**: `string`

Defined in: [packages/sdk/src/resources/platform-types.ts:74](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/resources/platform-types.ts#L74)

***

### onError?

> `readonly` `optional` **onError?**: `"fail"` \| `"skip"`

Defined in: [packages/sdk/src/resources/platform-types.ts:77](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/resources/platform-types.ts#L77)

***

### timeout?

> `readonly` `optional` **timeout?**: `number`

Defined in: [packages/sdk/src/resources/platform-types.ts:79](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/resources/platform-types.ts#L79)

***

### type

> `readonly` **type**: `"code"` \| `"connector"` \| `"transformer"` \| `"conditional"` \| `"parallel"` \| `"webhook"`

Defined in: [packages/sdk/src/resources/platform-types.ts:75](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/resources/platform-types.ts#L75)
