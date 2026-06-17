[**@oneplatform/plugin-sdk**](../README.md)

***

[@oneplatform/plugin-sdk](../README.md) / OntologySchema

# Interface: OntologySchema

Defined in: [packages/plugin-sdk/src/types/context.ts:12](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/context.ts#L12)

PluginContext and all sub-interfaces.
The platform constructs a concrete implementation of PluginContext and injects it
as the second argument to every plugin method. Plugin code must never construct
PluginContext directly.

## Properties

### entityTypes

> **entityTypes**: [`EntitySchema`](EntitySchema.md)[]

Defined in: [packages/plugin-sdk/src/types/context.ts:13](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/context.ts#L13)

***

### updatedAt

> **updatedAt**: `string`

Defined in: [packages/plugin-sdk/src/types/context.ts:15](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/context.ts#L15)

***

### version

> **version**: `number`

Defined in: [packages/plugin-sdk/src/types/context.ts:14](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/context.ts#L14)
