[**@oneplatform/sdk**](../README.md)

***

[@oneplatform/sdk](../README.md) / AuditQueryOptions

# Interface: AuditQueryOptions

Defined in: [packages/sdk/src/types/resources.ts:59](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/resources.ts#L59)

## Extends

- `FilterOptions`.`SortOptions`

## Properties

### actorId?

> `readonly` `optional` **actorId?**: `string`

Defined in: [packages/sdk/src/types/resources.ts:62](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/resources.ts#L62)

***

### filter?

> `readonly` `optional` **filter?**: `Record`\<`string`, `string`\> \| [`FilterBuilder`](FilterBuilder.md)

Defined in: [packages/sdk/src/types/resources.ts:9](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/resources.ts#L9)

Type-safe filter DSL or raw query params.

#### Inherited from

`FilterOptions.filter`

***

### from?

> `readonly` `optional` **from?**: `string`

Defined in: [packages/sdk/src/types/resources.ts:60](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/resources.ts#L60)

***

### limit?

> `readonly` `optional` **limit?**: `number`

Defined in: [packages/sdk/src/types/resources.ts:64](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/resources.ts#L64)

***

### resourceType?

> `readonly` `optional` **resourceType?**: `string`

Defined in: [packages/sdk/src/types/resources.ts:63](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/resources.ts#L63)

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

Defined in: [packages/sdk/src/types/resources.ts:61](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/resources.ts#L61)
