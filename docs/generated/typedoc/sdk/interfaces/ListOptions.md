[**@oneplatform/sdk**](../README.md)

***

[@oneplatform/sdk](../README.md) / ListOptions

# Interface: ListOptions

Defined in: [packages/sdk/src/types/resources.ts:28](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/resources.ts#L28)

## Extends

- `FilterOptions`.`SortOptions`.`FieldSelection`

## Properties

### cursor?

> `readonly` `optional` **cursor?**: `string`

Defined in: [packages/sdk/src/types/resources.ts:36](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/resources.ts#L36)

Explicit starting cursor. Usually managed by the Paginator automatically.
Pass only when resuming a previous pagination session.

***

### fields?

> `readonly` `optional` **fields?**: `string`[]

Defined in: [packages/sdk/src/types/resources.ts:25](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/resources.ts#L25)

Fields to include in the response. Reduces payload size.
Unknown fields are silently ignored by the server.

#### Inherited from

`FieldSelection.fields`

***

### filter?

> `readonly` `optional` **filter?**: `Record`\<`string`, `string`\> \| [`FilterBuilder`](FilterBuilder.md)

Defined in: [packages/sdk/src/types/resources.ts:9](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/resources.ts#L9)

Type-safe filter DSL or raw query params.

#### Inherited from

`FilterOptions.filter`

***

### limit?

> `readonly` `optional` **limit?**: `number`

Defined in: [packages/sdk/src/types/resources.ts:30](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/resources.ts#L30)

Page size hint. Default: 50. Max: 100.

***

### sort?

> `readonly` `optional` **sort?**: `string` \| `string`[]

Defined in: [packages/sdk/src/types/resources.ts:17](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/resources.ts#L17)

Sort specification. Prefix with '-' for descending.
Example: '-createdAt' or ['name', '-price']

#### Inherited from

`SortOptions.sort`
