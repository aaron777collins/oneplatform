[**@oneplatform/sdk**](../README.md)

***

[@oneplatform/sdk](../README.md) / FilterBuilder

# Interface: FilterBuilder

Defined in: [packages/sdk/src/filter-builder/filter-builder.ts:24](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/filter-builder/filter-builder.ts#L24)

Core filter builder. Accumulates conditions and serializes to query params.
Every public method returns `this` to enable chaining.

## Extended by

- [`FieldConditionBuilder`](FieldConditionBuilder.md)

## Methods

### and()

> **and**(`field`): [`FieldConditionBuilder`](FieldConditionBuilder.md)

Defined in: [packages/sdk/src/filter-builder/filter-builder.ts:26](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/filter-builder/filter-builder.ts#L26)

Add a condition on a new field. Returns a FieldConditionBuilder for operator selection.

#### Parameters

##### field

`string`

#### Returns

[`FieldConditionBuilder`](FieldConditionBuilder.md)

***

### toParams()

> **toParams**(): `Record`\<`string`, `string`\>

Defined in: [packages/sdk/src/filter-builder/filter-builder.ts:29](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/filter-builder/filter-builder.ts#L29)

Serialize all accumulated conditions to query param key/value pairs.

#### Returns

`Record`\<`string`, `string`\>
