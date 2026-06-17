[**@oneplatform/sdk**](../README.md)

***

[@oneplatform/sdk](../README.md) / FieldConditionBuilder

# Interface: FieldConditionBuilder

Defined in: [packages/sdk/src/filter-builder/filter-builder.ts:33](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/filter-builder/filter-builder.ts#L33)

Extends FilterBuilder with operator methods. Returned by filter() and and().

## Extends

- [`FilterBuilder`](FilterBuilder.md)

## Methods

### and()

> **and**(`field`): `FieldConditionBuilder`

Defined in: [packages/sdk/src/filter-builder/filter-builder.ts:26](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/filter-builder/filter-builder.ts#L26)

Add a condition on a new field. Returns a FieldConditionBuilder for operator selection.

#### Parameters

##### field

`string`

#### Returns

`FieldConditionBuilder`

#### Inherited from

[`FilterBuilder`](FilterBuilder.md).[`and`](FilterBuilder.md#and)

***

### eq()

> **eq**(`value`): [`FilterBuilder`](FilterBuilder.md)

Defined in: [packages/sdk/src/filter-builder/filter-builder.ts:34](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/filter-builder/filter-builder.ts#L34)

#### Parameters

##### value

`string` \| `number` \| `boolean`

#### Returns

[`FilterBuilder`](FilterBuilder.md)

***

### gt()

> **gt**(`value`): [`FilterBuilder`](FilterBuilder.md)

Defined in: [packages/sdk/src/filter-builder/filter-builder.ts:36](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/filter-builder/filter-builder.ts#L36)

#### Parameters

##### value

`string` \| `number`

#### Returns

[`FilterBuilder`](FilterBuilder.md)

***

### gte()

> **gte**(`value`): [`FilterBuilder`](FilterBuilder.md)

Defined in: [packages/sdk/src/filter-builder/filter-builder.ts:37](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/filter-builder/filter-builder.ts#L37)

#### Parameters

##### value

`string` \| `number`

#### Returns

[`FilterBuilder`](FilterBuilder.md)

***

### in()

> **in**(`values`): [`FilterBuilder`](FilterBuilder.md)

Defined in: [packages/sdk/src/filter-builder/filter-builder.ts:41](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/filter-builder/filter-builder.ts#L41)

#### Parameters

##### values

(`string` \| `number`)[]

#### Returns

[`FilterBuilder`](FilterBuilder.md)

***

### like()

> **like**(`pattern`): [`FilterBuilder`](FilterBuilder.md)

Defined in: [packages/sdk/src/filter-builder/filter-builder.ts:40](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/filter-builder/filter-builder.ts#L40)

#### Parameters

##### pattern

`string`

#### Returns

[`FilterBuilder`](FilterBuilder.md)

***

### lt()

> **lt**(`value`): [`FilterBuilder`](FilterBuilder.md)

Defined in: [packages/sdk/src/filter-builder/filter-builder.ts:38](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/filter-builder/filter-builder.ts#L38)

#### Parameters

##### value

`string` \| `number`

#### Returns

[`FilterBuilder`](FilterBuilder.md)

***

### lte()

> **lte**(`value`): [`FilterBuilder`](FilterBuilder.md)

Defined in: [packages/sdk/src/filter-builder/filter-builder.ts:39](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/filter-builder/filter-builder.ts#L39)

#### Parameters

##### value

`string` \| `number`

#### Returns

[`FilterBuilder`](FilterBuilder.md)

***

### neq()

> **neq**(`value`): [`FilterBuilder`](FilterBuilder.md)

Defined in: [packages/sdk/src/filter-builder/filter-builder.ts:35](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/filter-builder/filter-builder.ts#L35)

#### Parameters

##### value

`string` \| `number` \| `boolean`

#### Returns

[`FilterBuilder`](FilterBuilder.md)

***

### null()

> **null**(`isNull`): [`FilterBuilder`](FilterBuilder.md)

Defined in: [packages/sdk/src/filter-builder/filter-builder.ts:43](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/filter-builder/filter-builder.ts#L43)

true = filter to null values; false = filter to non-null values.

#### Parameters

##### isNull

`boolean`

#### Returns

[`FilterBuilder`](FilterBuilder.md)

***

### toParams()

> **toParams**(): `Record`\<`string`, `string`\>

Defined in: [packages/sdk/src/filter-builder/filter-builder.ts:29](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/filter-builder/filter-builder.ts#L29)

Serialize all accumulated conditions to query param key/value pairs.

#### Returns

`Record`\<`string`, `string`\>

#### Inherited from

[`FilterBuilder`](FilterBuilder.md).[`toParams`](FilterBuilder.md#toparams)
