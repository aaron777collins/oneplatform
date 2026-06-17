[**@oneplatform/plugin-sdk**](../README.md)

***

[@oneplatform/plugin-sdk](../README.md) / OntologyAccessor

# Interface: OntologyAccessor

Defined in: [packages/plugin-sdk/src/types/context.ts:176](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/context.ts#L176)

## Methods

### getEntitySchema()

> **getEntitySchema**(`entityType`): `Promise`\<[`EntitySchema`](EntitySchema.md) \| `null`\>

Defined in: [packages/plugin-sdk/src/types/context.ts:191](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/context.ts#L191)

Retrieve the schema for a single entity type by name.
Returns null if the entity type does not exist in this tenant's ontology.

#### Parameters

##### entityType

`string`

#### Returns

`Promise`\<[`EntitySchema`](EntitySchema.md) \| `null`\>

***

### getSchema()

> **getSchema**(): `Promise`\<[`OntologySchema`](OntologySchema.md)\>

Defined in: [packages/plugin-sdk/src/types/context.ts:185](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/context.ts#L185)

Read-only access to the tenant's current ontology schema.
Returns all entity type definitions currently configured for this tenant.
Result is cached within a single execution — repeated calls do not make
additional network requests.

Plugins CANNOT mutate the ontology. This method is read-only.

#### Returns

`Promise`\<[`OntologySchema`](OntologySchema.md)\>
