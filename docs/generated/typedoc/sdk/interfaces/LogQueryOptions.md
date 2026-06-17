[**@oneplatform/sdk**](../README.md)

***

[@oneplatform/sdk](../README.md) / LogQueryOptions

# Interface: LogQueryOptions

Defined in: [packages/sdk/src/types/resources.ts:46](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/resources.ts#L46)

## Extends

- `FilterOptions`.`SortOptions`

## Properties

### filter?

> `readonly` `optional` **filter?**: `Record`\<`string`, `string`\> \| [`FilterBuilder`](FilterBuilder.md)

Defined in: [packages/sdk/src/types/resources.ts:9](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/resources.ts#L9)

Type-safe filter DSL or raw query params.

#### Inherited from

`FilterOptions.filter`

***

### from?

> `readonly` `optional` **from?**: `string`

Defined in: [packages/sdk/src/types/resources.ts:47](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/resources.ts#L47)

***

### level?

> `readonly` `optional` **level?**: `"debug"` \| `"info"` \| `"warn"` \| `"error"`

Defined in: [packages/sdk/src/types/resources.ts:50](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/resources.ts#L50)

***

### limit?

> `readonly` `optional` **limit?**: `number`

Defined in: [packages/sdk/src/types/resources.ts:51](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/resources.ts#L51)

***

### service?

> `readonly` `optional` **service?**: `string`

Defined in: [packages/sdk/src/types/resources.ts:49](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/resources.ts#L49)

***

### sort?

> `readonly` `optional` **sort?**: `string` \| `string`[]

Defined in: [packages/sdk/src/types/resources.ts:17](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/resources.ts#L17)

Sort specification. Prefix with '-' for descending.
Example: '-createdAt' or ['name', '-price']

#### Inherited from

`SortOptions.sort`

***

### to?

> `readonly` `optional` **to?**: `string`

Defined in: [packages/sdk/src/types/resources.ts:48](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/resources.ts#L48)
